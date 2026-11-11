const SYMBOLS = new Set(['XAUUSD', 'BTCUSD', 'EURUSD', 'ETHUSD', 'NAS100']);
const FRAMES = ['1m', '5m', '15m'];
const MIN_BARS = { '1m': 60, '5m': 60, '15m': 205 };
const MIN_SCORE = 60;
const MAX_QUOTE_AGE_MS = 180_000;
const GEMINI_MODEL = 'gemini-3.8-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

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
  if (!apiKey) return res.status(503).json({ success: false, error: 'Gemini is not configured. Set GEMINI_API_KEY as a server-side environment variable.' });
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quoteUpdatedAt) || Date.now() - quoteUpdatedAt > MAX_QUOTE_AGE_MS || quoteUpdatedAt > Date.now() + 30_000) {
    return wait(res, symbol, mode, timeframe, null, null, 'السعر غير متوفر أو قديم؛ لا يمكن إجراء تحليل موثوق.');
  }
  const supplied = body.candles;
  if (!supplied || FRAMES.some((frame) => !Array.isArray(supplied[frame]) || supplied[frame].length < MIN_BARS[frame])) {
    return wait(res, symbol, mode, timeframe, price, quoteUpdatedAt, 'شموع OHLC الحقيقية غير مكتملة أو غير كافية.');
  }

  const candles = Object.fromEntries(FRAMES.map((frame) => [frame, sanitize(supplied[frame])]));
  if (FRAMES.some((frame) => candles[frame].length < MIN_BARS[frame])) return wait(res, symbol, mode, timeframe, price, quoteUpdatedAt, 'بيانات OHLC غير صالحة أو غير كافية.');
  if (Date.now() - candles['1m'].at(-1).time > MAX_QUOTE_AGE_MS) return wait(res, symbol, mode, timeframe, price, quoteUpdatedAt, 'أحدث شمعة M1 قديمة.');

  try {
    const context = calculateContext(candles, price, timeframe);
    const ai = await requestGemini({ apiKey, symbol, mode, timeframe, price, candles, context });
    const result = finalize({ ai, context, symbol, mode, timeframe, price, quoteUpdatedAt });
    return res.status(200).json({ success: true, source: `Google Gemini ${GEMINI_MODEL} + real OHLC`, ...result });
  } catch (error) {
    console.error('Gemini analysis failed:', error?.message || error);
    return res.status(502).json({ success: false, error: error?.message || 'Gemini analysis failed.' });
  }
}

function wait(res, symbol, mode, timeframe, price, quoteUpdatedAt, reason) {
  return res.status(200).json({ success: true, approved: false, signal: 'WAIT', score: null, scoreThreshold: MIN_SCORE, symbol, mode, timeframe, selectedTimeframe: timeframe, marketPrice: price, quoteUpdatedAt, dataMode: 'REAL_OHLC_REQUIRED', trade: null, reasons: [reason], riskNotice: 'لا توجد توصية عند نقص البيانات. مخرجات الذكاء الاصطناعي تحليلية وليست ضماناً للربح أو تنفيذاً للأوامر.' });
}

function sanitize(items) {
  return items.slice(-1500).map((c) => ({ time: Number(c.time), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Math.max(0, Number(c.volume) || 0) }))
    .filter((c) => Number.isFinite(c.time) && c.time > 0 && [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v) && v > 0) && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close))
    .sort((a, b) => a.time - b.time).filter((c, i, all) => i === 0 || c.time > all[i - 1].time);
}

function calculateContext(candles, price, timeframe) {
  const completed = Object.fromEntries(FRAMES.map((frame) => [frame, candles[frame].slice(0, -1)]));
  if (FRAMES.some((frame) => !completed[frame] || completed[frame].length < (frame === '15m' ? 200 : 50))) throw new Error('Insufficient completed real OHLC candles.');
  const indicators = Object.fromEntries(FRAMES.map((frame) => [frame, calculateIndicators(completed[frame])]));
  const selected = indicators[timeframe];
  const last = completed[timeframe].at(-1);
  const score = (direction) => scoreDirection(direction, indicators, price, last);
  const buyScore = score('BUY');
  const sellScore = score('SELL');
  return { completed, indicators, selected, last, buyScore, sellScore, structure: structure(completed['5m']) };
}

function scoreDirection(direction, indicators, price, last) {
  const buy = direction === 'BUY';
  const tests = [
    buy ? indicators['15m'].ema50 > indicators['15m'].ema200 : indicators['15m'].ema50 < indicators['15m'].ema200,
    buy ? indicators['5m'].ema9 > indicators['5m'].ema21 : indicators['5m'].ema9 < indicators['5m'].ema21,
    buy ? price > indicators['5m'].vwap : price < indicators['5m'].vwap,
    buy ? indicators['1m'].ema9 > indicators['1m'].ema21 : indicators['1m'].ema9 < indicators['1m'].ema21,
    buy ? indicators['1m'].rsi >= 50 : indicators['1m'].rsi <= 50,
    buy ? indicators['15m'].adx >= 18 : indicators['15m'].adx >= 18,
    buy ? last.close > last.open : last.close < last.open,
  ];
  return Math.round(tests.filter(Boolean).length / tests.length * 100);
}

async function requestGemini({ apiKey, symbol, mode, timeframe, price, candles, context }) {
  const candleWindow = Object.fromEntries(FRAMES.map((frame) => [frame, candles[frame].slice(-40).map(({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume }))]));
  const prompt = [
    'Act as a cautious market-analysis assistant. Analyze only the supplied real OHLC data and computed indicators. Do not invent prices, candles, news, or certainty.',
    `Instrument: ${symbol}; mode: ${mode}; selected entry timeframe: ${timeframe}; current provider quote: ${price}.`,
    'Return exactly one JSON object: {"direction":"BUY|SELL|WAIT","confidence":0,"rationale":"short reason","setup":"short setup description"}. Confidence is an analytical score, not a probability of profit. Use WAIT if directional evidence is mixed.',
    'Do not provide stop or target prices; the server calculates risk levels from real ATR and recent candle structure.',
    `Computed indicators and scores: ${JSON.stringify(publicContext(context))}`,
    `Recent real OHLC candles: ${JSON.stringify(candleWindow)}`,
  ].join('\n');

  const response = await fetchWithRetry(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, topP: 0.8, maxOutputTokens: 256, responseMimeType: 'application/json' } }),
  });
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; } catch { throw new Error(`Gemini returned invalid JSON (${response.status}).`); }
  if (!response.ok) throw new Error(payload?.error?.message || `Gemini API error ${response.status}.`);
  const text = payload?.candidates?.[0]?.content?.parts?.map((part) => typeof part.text === 'string' ? part.text : '').join('').trim();
  if (!text) throw new Error('Gemini returned no analysis text.');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('Gemini analysis was not valid JSON.'); }
  const direction = String(parsed.direction || '').toUpperCase();
  const confidence = Number(parsed.confidence);
  if (!['BUY', 'SELL', 'WAIT'].includes(direction) || !Number.isFinite(confidence) || confidence < 0 || confidence > 100) throw new Error('Gemini returned an invalid direction or confidence score.');
  return { direction, confidence: Math.round(confidence), rationale: String(parsed.rationale || '').slice(0, 500), setup: String(parsed.setup || '').slice(0, 200) };
}

async function fetchWithRetry(url, options, maxAttempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(8_000) });
      if (response.ok || !isTransientStatus(response.status) || attempt === maxAttempts - 1) return response;
      const retryAfter = Number(response.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 3_000)
        : Math.min(350 * (2 ** attempt) + Math.random() * 200, 2_500);
      await response.body?.cancel().catch(() => {});
      await sleep(delay);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts - 1 || error?.name === 'AbortError') throw error;
      await sleep(Math.min(350 * (2 ** attempt) + Math.random() * 200, 2_500));
    }
  }
  throw lastError || new Error('Gemini request failed after retries.');
}
function isTransientStatus(status) { return status === 429 || status === 500 || status === 502 || status === 503 || status === 504; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function finalize({ ai, context, symbol, mode, timeframe, price, quoteUpdatedAt }) {
  const { selected, last, completed, indicators, buyScore, sellScore } = context;
  if (!selected || !last || !indicators?.['5m'] || !indicators?.['15m']) throw new Error('Analysis context is incomplete.');
  const score = ai.direction === 'BUY' ? buyScore : ai.direction === 'SELL' ? sellScore : Math.max(buyScore, sellScore);
  const directionConfirmed = ai.direction === 'BUY'
    ? selected.ema9 > selected.ema21 && selected.supertrend === 'BUY' && selected.rsi >= 50 && last.close > last.open
    : ai.direction === 'SELL' && selected.ema9 < selected.ema21 && selected.supertrend === 'SELL' && selected.rsi <= 50 && last.close < last.open;
  const notChasing = Math.abs(price - selected.ema21) <= Math.max(selected.atr * 2.5, price * 0.00005);
  const approved = ai.direction !== 'WAIT' && score >= MIN_SCORE && ai.confidence >= 55 && directionConfirmed && notChasing && selected.atr > 0;
  const recent = completed[timeframe].slice(-20);
  const structureDistance = ai.direction === 'BUY'
    ? price - Math.min(...recent.map((bar) => bar.low)) + selected.atr * 0.15
    : ai.direction === 'SELL' ? Math.max(...recent.map((bar) => bar.high)) - price + selected.atr * 0.15 : selected.atr;
  const stopDistance = Math.min(Math.max(selected.atr * (mode === 'scalp' ? 1.25 : 1.6), structureDistance), selected.atr * 2.5);
  const stopLoss = round(ai.direction === 'BUY' ? price - stopDistance : price + stopDistance, symbol);
  const risk = Math.abs(price - stopLoss);
  const trade = approved ? {
    direction: ai.direction, entry: round(price, symbol), stopLoss,
    tp1: round(price + (ai.direction === 'BUY' ? 1 : -1) * risk * 1.5, symbol),
    tp2: round(price + (ai.direction === 'BUY' ? 1 : -1) * risk * 2, symbol),
    tp3: round(price + (ai.direction === 'BUY' ? 1 : -1) * risk * 2.5, symbol),
    breakEven: round(price, symbol), confidence: ai.confidence, stopDistance: round(risk, symbol),
    riskReward: { tp1: 1.5, tp2: 2, tp3: 2.5 }, lotSize: null,
  } : null;
  const reasons = [];
  if (ai.direction === 'WAIT') reasons.push('Gemini لم يرَ إعداداً اتجاهياً واضحاً.');
  if (score < MIN_SCORE) reasons.push(`الدرجة الفنية ${score}/100 أقل من الحد ${MIN_SCORE}.`);
  if (ai.confidence < 55) reasons.push('ثقة التحليل منخفضة؛ لم يتم اعتماد الصفقة.');
  if (!directionConfirmed) reasons.push(`المؤشرات والشمعة المكتملة لا تؤكد اتجاه ${ai.direction} على ${timeframe}.`);
  if (!notChasing) reasons.push('السعر بعيد عن EMA21؛ تم تجنب مطاردة الحركة.');
  return {
    approved, signal: approved ? ai.direction : 'WAIT', candidateDirection: ai.direction,
    score, scoreThreshold: MIN_SCORE, aiConfidence: ai.confidence, buyScore, sellScore,
    mode, timeframe, selectedTimeframe: timeframe, symbol, marketPrice: round(price, symbol), quoteUpdatedAt,
    dataMode: 'REAL_OHLC + GEMINI', marketRegime: indicators['15m'].ema50 > indicators['15m'].ema200 ? 'UP' : indicators['15m'].ema50 < indicators['15m'].ema200 ? 'DOWN' : 'MIXED',
    ai: { rationale: ai.rationale, setup: ai.setup }, trade,
    indicators: Object.fromEntries(FRAMES.map((frame) => [frame, { ema9: n(indicators[frame].ema9), ema21: n(indicators[frame].ema21), ema50: n(indicators[frame].ema50), ema200: n(indicators[frame].ema200), rsi7: n(indicators[frame].rsi), atr14: n(indicators[frame].atr), adx14: n(indicators[frame].adx), supertrend: indicators[frame].supertrend }])),
    reasons: approved ? [ai.rationale || 'إعداد Gemini مدعوم بتأكيد المؤشرات والشمعة.'] : reasons,
    riskNotice: 'تحليل آلي وليس ضماناً للربح أو تنفيذاً للصفقات. الثقة ليست احتمالاً للربح؛ تحقق من الأسعار والمخاطر لدى وسيطك.',
  };
}

function calculateIndicators(bars) {
  const closes = bars.map((bar) => bar.close), atr = atrSeries(bars);
  return { ema9: ema(closes, 9), ema21: ema(closes, 21), ema50: ema(closes, 50), ema200: ema(closes, 200), rsi: rsi(closes, 7), atr: atr.at(-1), adx: adx(bars, 14), vwap: vwap(bars), supertrend: supertrend(bars, atr) };
}
function publicContext(context) { return { scores: { BUY: context.buyScore, SELL: context.sellScore }, structure: context.structure, indicators: Object.fromEntries(FRAMES.map((frame) => [frame, Object.fromEntries(Object.entries(context.indicators[frame]).map(([key, value]) => [key, typeof value === 'number' ? n(value) : value]))])) }; }
function ema(values, period) { let value = values[0], k = 2 / (period + 1); for (let i = 1; i < values.length; i++) value += (values[i] - value) * k; return value; }
function rsi(values, period) { let gains = 0, losses = 0; for (let i = values.length - period; i < values.length; i++) { const d = values[i] - values[i - 1]; if (d > 0) gains += d; else losses -= d; } return losses === 0 ? 100 : 100 - 100 / (1 + gains / losses); }
function atrSeries(bars) { const tr = bars.map((c, i) => Math.max(c.high - c.low, i ? Math.abs(c.high - bars[i - 1].close) : 0, i ? Math.abs(c.low - bars[i - 1].close) : 0)); return tr.map((_, i) => tr.slice(Math.max(0, i - 13), i + 1).reduce((sum, value) => sum + value, 0) / Math.min(i + 1, 14)); }
function adx(bars, period) { let plus = 0, minus = 0, total = 0; for (let i = bars.length - period; i < bars.length; i++) { const up = bars[i].high - bars[i - 1].high, down = bars[i - 1].low - bars[i].low; plus += up > down && up > 0 ? up : 0; minus += down > up && down > 0 ? down : 0; total += Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)); } const p = total ? 100 * plus / total : 0, m = total ? 100 * minus / total : 0; return p + m ? 100 * Math.abs(p - m) / (p + m) : 0; }
function vwap(bars) { const date = new Date(bars.at(-1).time).toISOString().slice(0, 10), session = bars.filter((bar) => new Date(bar.time).toISOString().slice(0, 10) === date); let pv = 0, volume = 0; for (const bar of session) { const v = bar.volume > 0 ? bar.volume : 1; pv += ((bar.high + bar.low + bar.close) / 3) * v; volume += v; } return pv / volume; }
function supertrend(bars, atr) { let direction = 'BUY', upper = 0, lower = 0; for (let i = 10; i < bars.length; i++) { const mid = (bars[i].high + bars[i].low) / 2, nextUpper = mid + 3 * atr[i], nextLower = mid - 3 * atr[i]; upper = nextUpper < upper || bars[i - 1].close > upper ? nextUpper : upper; lower = nextLower > lower || bars[i - 1].close < lower ? nextLower : lower; if (bars[i].close > upper) direction = 'BUY'; else if (bars[i].close < lower) direction = 'SELL'; } return direction; }
function structure(bars) { const window = bars.slice(-31, -1), last = bars.at(-1), high = Math.max(...window.map((bar) => bar.high)), low = Math.min(...window.map((bar) => bar.low)); return { sweep: last.low < low && last.close > low ? 'BUY' : last.high > high && last.close < high ? 'SELL' : 'NONE', direction: last.close > high ? 'BUY' : last.close < low ? 'SELL' : 'NONE' }; }
function median(values) { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0; }
function n(value) { return Number.isFinite(value) ? Number(value.toFixed(6)) : null; }
function round(value, symbol) { return Number(value.toFixed(symbol === 'EURUSD' ? 5 : 2)); }
                                                                                         
