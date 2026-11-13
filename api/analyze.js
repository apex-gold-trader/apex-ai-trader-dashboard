const SYMBOLS = new Set(['XAUUSD', 'BTCUSD', 'EURUSD', 'ETHUSD', 'NAS100']);
const FRAMES = ['1m', '5m', '15m'];
const MIN_BARS = { '1m': 60, '5m': 60, '15m': 205 };
const MIN_SCORE = 60;
const MAX_QUOTE_AGE_MS = 180_000;
const GEMINI_MODEL = 'gemini-1.5-flash';
// التعديل الجذري هنا: استخدام الإصدار v1 المستقر الذي تطلبه خوادم جوجل حصرياً
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}; }
  catch { return res.status(400).json({ success: false, error: 'Invalid JSON body' }); }

  const symbol = String(body.symbol || '').toUpperCase();
  const mode = body.mode === 'scalp' ? 'scalp' : 'standard';
  const timeframe = mode === 'scalp' ? '1m' : '15m';
  const price = Number(body.livePrice);
  const quoteUpdatedAt = Number(body.quoteUpdatedAt);
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();

  if (!SYMBOLS.has(symbol)) return res.status(400).json({ success: false, error: 'Unsupported symbol.' });
  if (!apiKey) {
    return res.status(503).json({ success: false, error: 'مفتاح GEMINI_API_KEY غير متوفر في متغيرات البيئة على Vercel.' });
  }
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quoteUpdatedAt) || Date.now() - quoteUpdatedAt > MAX_QUOTE_AGE_MS) {
    return wait(res, symbol, mode, timeframe, null, null, 'السعر الفوري غير متوفر أو قديم.');
  }

  const supplied = body.candles;
  if (!supplied || FRAMES.some((frame) => !Array.isArray(supplied[frame]) || supplied[frame].length < MIN_BARS[frame])) {
    return wait(res, symbol, mode, timeframe, price, quoteUpdatedAt, 'بيانات شموع OHLC غير مكتملة.');
  }

  const candles = Object.fromEntries(FRAMES.map((frame) => [frame, sanitize(supplied[frame])]));
  if (FRAMES.some((frame) => candles[frame].length < MIN_BARS[frame])) {
    return wait(res, symbol, mode, timeframe, price, quoteUpdatedAt, 'بيانات الشموع غير صالحة.');
  }

  try {
    const context = calculateContext(candles, price, timeframe);

    // الاتصال المباشر والأساسي حصرياً مع Google Gemini AI
    const ai = await requestGemini({ apiKey, symbol, mode, timeframe, price, candles, context });
    
    const result = finalize({ ai, context, symbol, mode, timeframe, price, quoteUpdatedAt });
    return res.status(200).json({ success: true, source: `Google Gemini AI (${GEMINI_MODEL} on v1) + real OHLC`, ...result });
  } catch (error) {
    console.error('Gemini direct analysis error:', error?.message || error);
    return res.status(502).json({ success: false, error: `خطأ من خوادم الذكاء الاصطناعي: ${error?.message || 'فشل الاتصال بـ Gemini'}` });
  }
}

function wait(res, symbol, mode, timeframe, price, quoteUpdatedAt, reason) {
  return res.status(200).json({
    success: true, approved: false, signal: 'WAIT', score: null, scoreThreshold: MIN_SCORE,
    symbol, mode, timeframe, selectedTimeframe: timeframe, marketPrice: price, quoteUpdatedAt,
    dataMode: 'REAL_OHLC_REQUIRED', trade: null, reasons: [reason],
    riskNotice: 'تحليل الذكاء الاصطناعي معلق لحين اكتمال البيانات الشروط.'
  });
}

function sanitize(items) {
  return items.slice(-1500).map((c) => ({
    time: Number(c.time), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Math.max(0, Number(c.volume) || 0)
  })).filter((c) => Number.isFinite(c.time) && c.time > 0 && [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v) && v > 0))
    .sort((a, b) => a.time - b.time).filter((c, i, all) => i === 0 || c.time > all[i - 1].time);
}

function calculateContext(candles, price, timeframe) {
  const completed = Object.fromEntries(FRAMES.map((frame) => [frame, candles[frame].slice(0, -1)]));
  const indicators = Object.fromEntries(FRAMES.map((frame) => [frame, calculateIndicators(completed[frame])]));
  const selected = indicators[timeframe];
  const last = completed[frame].at(-1);
  const score = (direction) => scoreDirection(direction, indicators, price, last);
  return { completed, indicators, selected, last, buyScore: score('BUY'), sellScore: score('SELL') };
}

function scoreDirection(direction, indicators, price, last) {
  const buy = direction === 'BUY';
  const tests = [
    buy ? indicators['15m'].ema50 > indicators['15m'].ema200 : indicators['15m'].ema50 < indicators['15m'].ema200,
    buy ? indicators['5m'].ema9 > indicators['5m'].ema21 : indicators['5m'].ema9 < indicators['5m'].ema21,
    buy ? price > indicators['5m'].vwap : price < indicators['5m'].vwap,
    buy ? indicators['1m'].rsi >= 50 : indicators['1m'].rsi <= 50,
  ];
  return Math.round(tests.filter(Boolean).length / tests.length * 100);
}

async function requestGemini({ apiKey, symbol, mode, timeframe, price, candles, context }) {
  const candleWindow = Object.fromEntries(FRAMES.map((frame) => [frame, candles[frame].slice(-30).map(({ time, open, high, low, close }) => ({ time, open, high, low, close }))]));
  
  const prompt = [
    'You are an expert AI Scalping and Trading Assistant. Analyze the provided market data, indicators, and real OHLC candles.',
    `Target Instrument: ${symbol}, Mode: ${mode}, Timeframe: ${timeframe}, Current Live Price: ${price}.`,
    'You must return ONLY a valid JSON object with no markdown formatting, structured strictly like this:',
    '{"direction": "BUY" or "SELL" or "WAIT", "confidence": number between 0 and 100, "rationale": "short professional explanation in Arabic"}',
    `Technical Indicators Summary: ${JSON.stringify(publicContext(context))}`,
    `Recent Candles: ${JSON.stringify(candleWindow)}`
  ].join('\n');

  const response = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 300, responseMimeType: 'application/json' }
    }),
    signal: AbortSignal.timeout(25_000)
  });

  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; } catch { throw new Error(`رد غير صالح من Gemini (${response.status})`); }
  if (!response.ok) throw new Error(payload?.error?.message || `خطأ من واجهة Gemini برمز ${response.status}`);

  const text = payload?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim();
  if (!text) throw new Error('لم يرجع نموذج Gemini أي نص تحليلي.');

  let parsed;
  try {
    const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('فشل قراءة مخرجات JSON من تحليل الذكاء الاصطناعي.');
  }

  const direction = String(parsed.direction || 'WAIT').toUpperCase();
  const confidence = Number(parsed.confidence || 50);
  return {
    direction: ['BUY', 'SELL', 'WAIT'].includes(direction) ? direction : 'WAIT',
    confidence: Number.isFinite(confidence) ? Math.round(confidence) : 50,
    rationale: String(parsed.rationale || 'تحليل مباشر عبر نموذج الذكاء الاصطناعي.').slice(0, 400),
    setup: 'AI Direct Neural Setup'
  };
}

function finalize({ ai, context, symbol, mode, timeframe, price, quoteUpdatedAt }) {
  const { selected, indicators, buyScore, sellScore } = context;
  const score = ai.direction === 'BUY' ? buyScore : ai.direction === 'SELL' ? sellScore : Math.max(buyScore, sellScore);
  const approved = ai.direction !== 'WAIT' && ai.confidence >= 55 && score >= MIN_SCORE && selected.atr > 0;

  const risk = selected.atr * (mode === 'scalp' ? 1.25 : 1.6);
  const stopLoss = round(ai.direction === 'BUY' ? price - risk : price + risk, symbol);
  const riskDist = Math.abs(price - stopLoss);

  const trade = approved ? {
    direction: ai.direction,
    entry: round(price, symbol),
    stopLoss,
    tp1: round(price + (ai.direction === 'BUY' ? 1 : -1) * riskDist * 1.5, symbol),
    tp2: round(price + (ai.direction === 'BUY' ? 1 : -1) * risk * 2, symbol),
    tp3: round(price + (ai.direction === 'BUY' ? 1 : -1) * risk * 2.5, symbol),
    breakEven: round(price, symbol),
    confidence: ai.confidence,
    stopDistance: round(riskDist, symbol),
    riskReward: { tp1: 1.5, tp2: 2, tp3: 2.5 },
    lotSize: null
  } : null;

  return {
    approved,
    signal: approved ? ai.direction : 'WAIT',
    candidateDirection: ai.direction,
    score,
    scoreThreshold: MIN_SCORE,
    aiConfidence: ai.confidence,
    buyScore,
    sellScore,
    mode,
    timeframe,
    selectedTimeframe: timeframe,
    symbol,
    marketPrice: round(price, symbol),
    quoteUpdatedAt,
    dataMode: 'REAL_OHLC + GEMINI_AI_DIRECT',
    marketRegime: indicators['15m'].ema50 > indicators['15m'].ema200 ? 'UP' : 'DOWN',
    ai: { rationale: ai.rationale, setup: ai.setup },
    trade,
    indicators: Object.fromEntries(FRAMES.map((frame) => [frame, {
      ema9: n(indicators[frame].ema9),
      ema21: n(indicators[frame].ema21),
      ema50: n(indicators[frame].ema50),
      ema200: n(indicators[frame].ema200),
      rsi: n(indicators[frame].rsi),
      atr: n(indicators[frame].atr),
      supertrend: indicators[frame].supertrend
    }])),
    reasons: [ai.rationale],
    riskNotice: 'قرار تحليلي صادر مباشرة عن نموذج Google Gemini AI.'
  };
}

function calculateIndicators(bars) {
  const closes = bars.map((b) => b.close), atr = atrSeries(bars);
  return {
    ema9: ema(closes, 9), ema21: ema(closes, 21), ema50: ema(closes, 50), ema200: ema(closes, 200),
    rsi: rsi(closes, 7), atr: atr.at(-1), vwap: vwap(bars), supertrend: supertrend(bars, atr)
  };
}

function publicContext(context) {
  return { scores: { BUY: context.buyScore, SELL: context.sellScore }, lastCandle: context.last };
}

function ema(values, period) {
  let value = values[0], k = 2 / (period + 1);
  for (let i = 1; i < values.length; i++) value += (values[i] - value) * k;
  return value;
}

function rsi(values, period) {
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  return losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
}

function atrSeries(bars) {
  const tr = bars.map((c, i) => Math.max(c.high - c.low, i ? Math.abs(c.high - bars[i - 1].close) : 0, i ? Math.abs(c.low - bars[i - 1].close) : 0));
  return tr.map((_, i) => tr.slice(Math.max(0, i - 13), i + 1).reduce((s, v) => s + v, 0) / Math.min(i + 1, 14));
}

function vwap(bars) {
  let pv = 0, volume = 0;
  for (const bar of bars) {
    const v = bar.volume > 0 ? bar.volume : 1;
    pv += ((bar.high + bar.low + bar.close) / 3) * v;
    volume += v;
  }
  return pv / volume;
}

function supertrend(bars, atr) {
  let direction = 'BUY', upper = 0, lower = 0;
  for (let i = 10; i < bars.length; i++) {
    const mid = (bars[i].high + bars[i].low) / 2;
    upper = (mid + 3 * atr[i] < upper || bars[i - 1].close > upper) ? mid + 3 * atr[i] : upper;
    lower = (mid - 3 * atr[i] > lower || bars[i - 1].close < lower) ? mid - 3 * atr[i] : lower;
    if (bars[i].close > upper) direction = 'BUY';
    else if (bars[i].close < lower) direction = 'SELL';
  }
  return direction;
}

function n(val) { return Number.isFinite(val) ? Number(val.toFixed(6)) : null; }
function round(val, sym) { return Number(val.toFixed(sym === 'EURUSD' ? 5 : 2)); }
                                                                                           
