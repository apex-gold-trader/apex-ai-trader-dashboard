const SYMBOLS = new Set(['XAUUSD', 'BTCUSD', 'EURUSD', 'ETHUSD', 'NAS100']);
const FRAMES = ['1m', '5m', '15m'];
const MIN_BARS = { '1m': 60, '5m': 60, '15m': 205 };
const MIN_SCORE = 60;
const SCORE_WEIGHTS = { higherTrend: 15, setupTrend: 15, vwap: 10, emaMomentum: 10, liquidity: 10, structure: 10, rsi: 10, adx: 5, candle: 5, volatilityData: 10 };
const MAX_QUOTE_AGE_MS = 180_000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch { return res.status(400).json({ success: false, error: 'Invalid JSON body' }); }

  const symbol = String(body.symbol || '').toUpperCase();
  const mode = body.mode === 'scalp' ? 'scalp' : 'standard';
  const timeframe = mode === 'scalp' ? '1m' : '15m';
  const price = Number(body.livePrice);
  const quoteUpdatedAt = Number(body.quoteUpdatedAt);
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  const model = String(process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();

  if (!SYMBOLS.has(symbol)) return res.status(400).json({ success: false, error: 'Unsupported symbol.' });
  if (!apiKey) return res.status(503).json({ success: false, error: 'Gemini analysis is not configured. Set GEMINI_API_KEY as a server-side environment variable.' });
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quoteUpdatedAt) || Date.now() - quoteUpdatedAt > MAX_QUOTE_AGE_MS || quoteUpdatedAt > Date.now() + 30_000) {
    return wait(res, { symbol, mode, timeframe, reason: 'السعر الفوري غير متوفر أو قديم؛ لا يمكن بناء توصية على سعر غير موثوق.' });
  }
  const supplied = body.candles;
  if (!supplied || FRAMES.some((frame) => !Array.isArray(supplied[frame]) || supplied[frame].length < MIN_BARS[frame])) {
    return wait(res, { symbol, mode, timeframe, price, quoteUpdatedAt, reason: 'شموع OHLC الحقيقية غير مكتملة أو غير كافية للفريمات المطلوبة.' });
  }

  const candles = Object.fromEntries(FRAMES.map((frame) => [frame, sanitize(supplied[frame])]));
  if (FRAMES.some((frame) => candles[frame].length < MIN_BARS[frame])) {
    return wait(res, { symbol, mode, timeframe, price, quoteUpdatedAt, reason: 'بيانات OHLC غير صالحة أو عدد الشموع المكتملة غير كافٍ.' });
  }
  if (Date.now() - candles['1m'].at(-1).time > MAX_QUOTE_AGE_MS) {
    return wait(res, { symbol, mode, timeframe, price, quoteUpdatedAt, reason: 'شمعة M1 الأحدث قديمة؛ لا يتم إصدار توصية.' });
  }

  try {
    const technical = calculateContext(candles, price, timeframe);
    const ai = await requestGemini({ apiKey, model, symbol, mode, timeframe, price, candles, technical });
    const result = finalizeAnalysis({ ai, technical, symbol, mode, timeframe, price, quoteUpdatedAt });
    return res.status(200).json({ success: true, source: 'Gemini + verified OHLC risk calculation', ...result });
  } catch (error) {
    return res.status(502).json({ success: false, error: String(error?.message || 'Gemini analysis failed') });
  }
}

function wait(res, { symbol, mode, timeframe, price = null, quoteUpdatedAt = null, reason }) {
  return res.status(200).json({ success: true, approved: false, signal: 'WAIT', score: null, scoreThreshold: MIN_SCORE, symbol, mode, timeframe, marketPrice: price, quoteUpdatedAt, dataMode: 'REAL_OHLC_REQUIRED', trade: null, reasons: [reason], riskNotice: 'لم تُصدر توصية لغياب بيانات حقيقية كافية. تحليل الذكاء الاصطناعي لا يضمن الأرباح ولا ينفذ الأوامر.' });
}

function sanitize(items) {
  return items.slice(-1500).map((c) => ({ time: Number(c.time), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Math.max(0, Number(c.volume) || 0) }))
    .filter((c) => Number.isFinite(c.time) && c.time > 0 && [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v) && v > 0) && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close))
    .sort((a, b) => a.time - b.time).filter((c, i, all) => i === 0 || c.time > all[i - 1].time);
}

function calculateContext(candles, livePrice, selectedFrame) {
  const bars = Object.fromEntries(FRAMES.map((frame) => [frame, candles[frame].slice(0, -1)]));
  if (bars['15m'].length < 200 || bars['5m'].length < 50 || bars['1m'].length < 50) throw new Error('Insufficient completed candles for EMA and multi-timeframe checks.');
  const metrics = Object.fromEntries(FRAMES.map((frame) => [frame, indicators(bars[frame])]));
  const chosen = metrics[selectedFrame];
  const chosenBar = bars[selectedFrame].at(-1);
  const structure = marketStructure(bars['5m']);
  const referenceAtr = median(atrSeries(bars['1m']).slice(-100));
  const volatilityRatio = referenceAtr > 0 ? metrics['1m'].atr / referenceAtr : 1;
  const components = {};

  // scoreDirection expects the individual timeframe metric objects. Pass the correct
  // names here; the previous code supplied {metrics}, leaving i15 undefined and causing
  // the runtime error while accessing i15.ema50.
  const scoreInput = {
    i5: metrics['5m'],
    i15: metrics['15m'],
    price: livePrice,
    structure,
    signalCandle: chosenBar,
    selected: chosen,
  };
  for (const direction of ['BUY', 'SELL']) components[direction] = scoreDirection(direction, scoreInput);
  const scoreTotal = (parts) => Object.values(parts || {}).reduce((sum, item) => sum + (Number(item?.earned) || 0), 0);
  const buyScore = scoreTotal(components.BUY);
  const sellScore = scoreTotal(components.SELL);
  const trend = metrics['15m'].ema50 > metrics['15m'].ema200 ? 'UP' : metrics['15m'].ema50 < metrics['15m'].ema200 ? 'DOWN' : 'MIXED';
  return { bars, metrics, selectedFrame, chosen, chosenBar, structure, volatilityRatio, components, buyScore, sellScore, trend };
}

async function requestGemini({ apiKey, model, symbol, mode, timeframe, price, candles, technical }) {
  const frameData = Object.fromEntries(FRAMES.map((frame) => [frame, candles[frame].slice(-30).map(({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume }))]));
  const prompt = [
    'You are a cautious market-analysis assistant. Use only supplied real OHLC candles and computed indicators; never claim certainty or invent market/news data.',
    `Instrument: ${symbol}; mode: ${mode}; entry timeframe: ${timeframe}; current provider price: ${price}.`,
    'Return exactly one JSON object with fields: direction (BUY, SELL, or WAIT), confidence (integer 0..100; analytical confidence, NOT win probability), rationale (short string), setup (short string).',
    'Choose BUY or SELL only when the selected timeframe has a clear trend/momentum setup. Otherwise choose WAIT. Do not output price levels; the server computes ATR/structure risk levels.',
    `Computed context: ${JSON.stringify(publicContext(technical))}`,
    `Recent actual OHLC candles: ${JSON.stringify(frameData)}`,
  ].join('\n');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, topP: 0.8, maxOutputTokens: 256, responseMimeType: 'application/json' } }),
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error(`Gemini returned a non-JSON response (${response.status}).`); }
  if (!response.ok) throw new Error(data?.error?.message || `Gemini API error ${response.status}`);
  const text = data?.candidates?.[0]?.content?.parts?.map((part) => typeof part.text === 'string' ? part.text : '').join('').trim();
  if (!text) throw new Error('Gemini returned no analysis text.');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('Gemini response was not valid JSON.'); }
  const direction = String(parsed.direction || '').toUpperCase(), confidence = Number(parsed.confidence);
  if (!['BUY', 'SELL', 'WAIT'].includes(direction) || !Number.isFinite(confidence) || confidence < 0 || confidence > 100) throw new Error('Gemini returned invalid direction or confidence.');
  return { direction, confidence: Math.round(confidence), rationale: String(parsed.rationale || '').slice(0, 500), setup: String(parsed.setup || '').slice(0, 200) };
}

function finalizeAnalysis({ ai, technical, symbol, mode, timeframe, price, quoteUpdatedAt }) {
  const { chosen, chosenBar, components, buyScore, sellScore, structure, volatilityRatio, trend, metrics, bars } = technical;
  if (!chosen || !chosenBar || !metrics?.['5m'] || !metrics?.['15m'] || !bars?.[timeframe]) throw new Error('Analysis context is incomplete; no trade was generated.');
  const direction = ai.direction;
  const score = direction === 'BUY' ? buyScore : direction === 'SELL' ? sellScore : Math.max(buyScore, sellScore);
  const trendConfirmed = direction === 'BUY'
    ? chosen.ema9 > chosen.ema21 && chosen.supertrend === 'BUY' && chosen.rsi >= 50
    : direction === 'SELL' && chosen.ema9 < chosen.ema21 && chosen.supertrend === 'SELL' && chosen.rsi <= 50;
  const candleConfirmed = direction === 'BUY' ? chosenBar.close > chosenBar.open : direction === 'SELL' && chosenBar.close < chosenBar.open;
  const notChasing = Math.abs(price - chosen.ema21) <= Math.max(chosen.atr * 2.5, price * 0.00005);
  const approved = direction !== 'WAIT' && score >= MIN_SCORE && ai.confidence >= 55 && trendConfirmed && candleConfirmed && notChasing && chosen.atr > 0;
  const reasons = [];
  if (ai.direction === 'WAIT') reasons.push('Gemini لم يرَ إعداداً واضحاً؛ النتيجة WAIT.');
  if (score < MIN_SCORE) reasons.push(`توافق المؤشرات ${score}/100 أقل من الحد ${MIN_SCORE}.`);
  if (ai.confidence < 55) reasons.push('ثقة التحليل منخفضة؛ لا يتم اعتماد الصفقة.');
  if (!trendConfirmed) reasons.push(`الاتجاه والزخم على ${timeframe} لا يؤكدان اتجاه Gemini معاً.`);
  if (!candleConfirmed) reasons.push('آخر شمعة مكتملة لا تؤكد اتجاه الصفقة.');
  if (!notChasing) reasons.push('السعر ممتد بعيداً عن EMA21؛ تجنب مطاردة الحركة.');
  if (volatilityRatio > 2.5) reasons.push('تقلب مرتفع؛ لم يمنع الإشارة تلقائياً لكنه يزيد المخاطر.');

  const recent = bars[timeframe].slice(-20);
  const structureDistance = direction === 'BUY' ? price - Math.min(...recent.map((bar) => bar.low)) + chosen.atr * 0.15 : direction === 'SELL' ? Math.max(...recent.map((bar) => bar.high)) - price + chosen.atr * 0.15 : chosen.atr;
  const stopDistance = Math.min(Math.max(chosen.atr * (mode === 'scalp' ? 1.25 : 1.6), structureDistance), chosen.atr * 2.5);
  const stopLoss = round(direction === 'BUY' ? price - stopDistance : price + stopDistance, symbol);
  const risk = Math.abs(price - stopLoss);
  const trade = approved ? {
    direction, entry: round(price, symbol), stopLoss,
    tp1: round(price + (direction === 'BUY' ? 1 : -1) * risk * 1.5, symbol),
    tp2: round(price + (direction === 'BUY' ? 1 : -1) * risk * 2, symbol),
    tp3: round(price + (direction === 'BUY' ? 1 : -1) * risk * 2.5, symbol),
    breakEven: round(price, symbol), stopDistance: round(risk, symbol),
    riskReward: { tp1: 1.5, tp2: 2, tp3: 2.5 }, confidence: ai.confidence, lotSize: null,
  } : null;

  return {
    approved, signal: approved ? direction : 'WAIT', candidateDirection: direction,
    score, scoreThreshold: MIN_SCORE, scoreComponents: components, aiConfidence: ai.confidence, buyScore, sellScore,
    mode, timeframe, selectedTimeframe: timeframe, symbol, marketPrice: round(price, symbol), quoteUpdatedAt,
    marketRegime: volatilityRatio > 2.5 ? `تقلب مرتفع (${volatilityRatio.toFixed(2)}×)` : trend,
    volatility: { selectedAtr14: n(chosen.atr), oneMinuteAtrRatio: n(volatilityRatio), elevated: volatilityRatio > 2.5 },
    dataMode: 'REAL_OHLC + GEMINI', ai: { rationale: ai.rationale, setup: ai.setup },
    reasons: approved ? [ai.rationale || 'Gemini والمؤشرات يؤكدان الإعداد.', `المجموع الفني ${score}/100؛ مستويات SL/TP محسوبة محلياً من ATR وبنية الشموع.`] : reasons,
    indicators: {
      M15: { ema50: n(metrics['15m'].ema50), ema200: n(metrics['15m'].ema200), adx14: n(metrics['15m'].adx) },
      M5: { ema9: n(metrics['5m'].ema9), ema21: n(metrics['5m'].ema21), ema50: n(metrics['5m'].ema50), vwap: n(metrics['5m'].vwap), liquiditySweep: structure.sweep, structure: structure.direction },
      [timeframe]: { ema9: n(chosen.ema9), ema21: n(chosen.ema21), rsi7: n(chosen.rsi), atr14: n(chosen.atr), supertrend: chosen.supertrend },
    },
    trade,
    riskNotice: 'تحليل Gemini والمؤشرات لا يضمنان الربح ولا ينفذان الأوامر. تفعيل BE/Trailing يحتاج اتصالاً بالوسيط. درجة التحليل ليست احتمال نجاح.',
  };
}

function scoreDirection(direction, input) { return scoreBreakdown(direction, input); }
function scoreBreakdown(direction, input = {}) {
  const { i5, i15, price, structure, signalCandle, selected } = input;
  // Fail closed on incomplete indicator context instead of throwing an undefined-property error.
  if (!i5 || !i15 || !structure || !signalCandle || !selected || !Number.isFinite(Number(price))) {
    return Object.fromEntries(Object.entries(SCORE_WEIGHTS).map(([key, weight]) => [key, { earned: 0, max: weight, passed: false }]));
  }
  const buy = direction === 'BUY';
  const checks = {
    higherTrend: buy ? i15.ema50 > i15.ema200 : i15.ema50 < i15.ema200,
    setupTrend: buy ? i5.ema50 > i5.ema200 && i5.ema9 > i5.ema21 : i5.ema50 < i5.ema200 && i5.ema9 < i5.ema21,
    vwap: buy ? price > i5.vwap : price < i5.vwap,
    emaMomentum: buy ? selected.ema9 > selected.ema21 : selected.ema9 < selected.ema21,
    liquidity: structure.sweep === direction,
    structure: structure.direction === direction,
    rsi: buy ? selected.rsi >= 50 && selected.rsi <= 76 : selected.rsi <= 50 && selected.rsi >= 24,
    adx: i15.adx >= 18,
    candle: candleStrength(signalCandle, selected.atr, direction) >= 0.4,
    volatilityData: selected.atr > 0,
  };
  return Object.fromEntries(Object.entries(SCORE_WEIGHTS).map(([key, weight]) => [key, { earned: checks[key] ? weight : 0, max: weight, passed: Boolean(checks[key]) }]));
}

function publicContext(technical) {
  const { metrics, buyScore, sellScore, trend, structure, selectedFrame } = technical;
  return { selectedFrame, trend, buyScore, sellScore, structure, frames: Object.fromEntries(FRAMES.map((frame) => [frame, { ema9: n(metrics[frame].ema9), ema21: n(metrics[frame].ema21), ema50: n(metrics[frame].ema50), ema200: n(metrics[frame].ema200), rsi7: n(metrics[frame].rsi), adx14: n(metrics[frame].adx), atr14: n(metrics[frame].atr), supertrend: metrics[frame].supertrend }])) };
}
function indicators(bars) { const closes = bars.map((bar) => bar.close), atr = atrSeries(bars); return { ema9: ema(closes, 9), ema21: ema(closes, 21), ema50: ema(closes, 50), ema200: ema(closes, 200), rsi: rsi(closes, 7), adx: adx(bars, 14), atr: atr.at(-1), vwap: vwap(bars), supertrend: supertrend(bars, atr) }; }
function ema(values, period) { let value = values[0], k = 2 / (period + 1); for (let i = 1; i < values.length; i++) value += (values[i] - value) * k; return value; }
function rsi(values, period) { let gains = 0, losses = 0; for (let i = values.length - period; i < values.length; i++) { const d = values[i] - values[i - 1]; if (d > 0) gains += d; else losses -= d; } return losses === 0 ? 100 : 100 - 100 / (1 + gains / losses); }
function atrSeries(bars) { const tr = bars.map((c, i) => Math.max(c.high - c.low, i ? Math.abs(c.high - bars[i - 1].close) : 0, i ? Math.abs(c.low - bars[i - 1].close) : 0)); return tr.map((_, i) => tr.slice(Math.max(0, i - 13), i + 1).reduce((a, x) => a + x, 0) / Math.min(i + 1, 14)); }
function adx(bars, period) { let plus = 0, minus = 0, total = 0; for (let i = bars.length - period; i < bars.length; i++) { const up = bars[i].high - bars[i - 1].high, down = bars[i - 1].low - bars[i].low; plus += up > down && up > 0 ? up : 0; minus += down > up && down > 0 ? down : 0; total += Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)); } const p = total ? 100 * plus / total : 0, m = total ? 100 * minus / total : 0; return p + m ? 100 * Math.abs(p - m) / (p + m) : 0; }
function vwap(bars) { const date = new Date(bars.at(-1).time).toISOString().slice(0, 10), session = bars.filter((bar) => new Date(bar.time).toISOString().slice(0, 10) === date); let pv = 0, volume = 0; for (const bar of session) { const weight = bar.volume > 0 ? bar.volume : 1; pv += ((bar.high + bar.low + bar.close) / 3) * weight; volume += weight; } return pv / volume; }
function supertrend(bars, atr) { let direction = 'BUY', upper = 0, lower = 0; for (let i = 10; i < bars.length; i++) { const mid = (bars[i].high + bars[i].low) / 2, nextUpper = mid + 3 * atr[i], nextLower = mid - 3 * atr[i]; upper = nextUpper < upper || bars[i - 1].close > upper ? nextUpper : upper; lower = nextLower > lower || bars[i - 1].close < lower ? nextLower : lower; if (bars[i].close > upper) direction = 'BUY'; else if (bars[i].close < lower) direction = 'SELL'; } return direction; }
function marketStructure(bars) { const window = bars.slice(-31, -1), last = bars.at(-1), high = Math.max(...window.map((bar) => bar.high)), low = Math.min(...window.map((bar) => bar.low)); return { sweep: last.low < low && last.close > low ? 'BUY' : last.high > high && last.close < high ? 'SELL' : 'NONE', direction: last.close > high ? 'BUY' : last.close < low ? 'SELL' : 'NONE' }; }
function candleStrength(candle, atr, direction) { const range = candle.high - candle.low; return range ? (direction === 'BUY' ? candle.close - candle.low : candle.high - candle.close) / Math.max(range, 1e-12) * range / Math.max(atr, 1e-12) : 0; }
function median(values) { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0; }
function n(value) { return Number.isFinite(value) ? Number(value.toFixed(6)) : null; }
function round(value, symbol) { return Number(value.toFixed(symbol === 'EURUSD' ? 5 : 2)); }
