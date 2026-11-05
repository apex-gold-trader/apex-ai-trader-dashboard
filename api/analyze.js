const SCORE_WEIGHTS = { m15: 15, m5: 15, vwap: 10, ema: 10, sweep: 15, structure: 10, rsi: 10, adx: 5, candle: 5, atr: 5 };
const MIN_SCORE = 75;
const MINIMUM_BARS = { '1m': 60, '5m': 60, '15m': 205 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch { return res.status(400).json({ success: false, error: 'Invalid JSON request body' }); }
  const symbol = String(body.symbol || '').toUpperCase();
  const mode = body.mode === 'scalp' ? 'scalp' : 'standard';
  const timeframe = mode === 'scalp' ? '1m' : String(body.timeframe || '5m');
  const candles = body.candles || body.current?.candles;
  if (!['XAUUSD', 'BTCUSD', 'EURUSD', 'ETHUSD', 'NAS100'].includes(symbol)) return res.status(400).json({ success: false, error: 'Unsupported symbol' });
  if (!candles || !['1m', '5m', '15m'].every((tf) => Array.isArray(candles[tf]) && candles[tf].length >= MINIMUM_BARS[tf])) {
    return res.status(422).json({ success: false, error: 'Insufficient real OHLC candles. Refresh market data and retry; no synthetic-price fallback is used.' });
  }
  try {
    const result = analyze({ symbol, mode, timeframe, candles: Object.fromEntries(['1m', '5m', '15m'].map((tf) => [tf, sanitize(candles[tf])])) });
    return res.status(200).json({ success: true, source: 'deterministic-ohlc-analysis', ...result });
  } catch (error) {
    return res.status(422).json({ success: false, error: error.message || 'Unable to analyze candles' });
  }
}

function sanitize(items) {
  if (items.length > 2000) items = items.slice(-2000);
  return items.map((c) => ({ time: Number(c.time), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Math.max(0, Number(c.volume) || 0) }))
    .filter((c) => Number.isFinite(c.time) && c.time > 0 && [c.open, c.high, c.low, c.close].every((n) => Number.isFinite(n) && n > 0) && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close))
    .sort((a, b) => a.time - b.time);
}

function analyze({ symbol, mode, timeframe, candles }) {
  const bars = { m1: closedBars(candles['1m']), m5: closedBars(candles['5m']), m15: closedBars(candles['15m']) };
  if (Object.entries(bars).some(([tf, list]) => list.length < (tf === 'm15' ? 200 : 50))) throw new Error('Insufficient closed candles after removing the potentially incomplete current bar.');
  const a1 = indicators(bars.m1), a5 = indicators(bars.m5), a15 = indicators(bars.m15);
  const latest = bars.m1.at(-1), entry = latest.close;
  const m15Bull = a15.ema50 > a15.ema200 && a15.adx >= 15;
  const m15Bear = a15.ema50 < a15.ema200 && a15.adx >= 15;
  const m5Bull = a5.ema50 > a5.ema200 && a5.ema9 > a5.ema21;
  const m5Bear = a5.ema50 < a5.ema200 && a5.ema9 < a5.ema21;
  const m1Bull = a1.ema9 > a1.ema21 && a1.rsi >= 50 && a1.supertrend.direction === 'BUY' && latest.close > latest.open;
  const m1Bear = a1.ema9 < a1.ema21 && a1.rsi <= 50 && a1.supertrend.direction === 'SELL' && latest.close < latest.open;
  const market = marketStructure(bars.m5, a5);
  const pullback = Math.min(Math.abs(entry - a1.ema21), Math.abs(entry - a5.vwap)) <= a1.atr * 0.8;
  const sweepBull = market.sweep === 'BUY' && latest.close >= latest.open;
  const sweepBear = market.sweep === 'SELL' && latest.close <= latest.open;
  const structureBull = market.structure === 'BUY';
  const structureBear = market.structure === 'SELL';
  const vwapBull = entry > a5.vwap;
  const vwapBear = entry < a5.vwap;
  const volatilityRatio = a1.atr / Math.max(median(atrSeries(bars.m1).slice(-100)), 1e-12);
  const volatilityAbnormal = volatilityRatio > 2.5;
  const regime = volatilityAbnormal ? 'abnormal-volatility' : a15.adx < 15 ? 'ranging' : m15Bull ? 'strong-uptrend' : m15Bear ? 'strong-downtrend' : 'unclear';
  const buyScore = score({ m15: m15Bull, m5: m5Bull, vwap: vwapBull, ema: a1.ema9 > a1.ema21, sweep: sweepBull, structure: structureBull, rsi: a1.rsi >= 50 && a1.rsi <= 75, adx: a15.adx >= 20, candle: bullishStrength(latest, a1.atr) >= 0.45, atr: !volatilityAbnormal && a1.atr > 0 });
  const sellScore = score({ m15: m15Bear, m5: m5Bear, vwap: vwapBear, ema: a1.ema9 < a1.ema21, sweep: sweepBear, structure: structureBear, rsi: a1.rsi <= 50 && a1.rsi >= 25, adx: a15.adx >= 20, candle: bearishStrength(latest, a1.atr) >= 0.45, atr: !volatilityAbnormal && a1.atr > 0 });
  const direction = buyScore >= sellScore ? 'BUY' : 'SELL';
  const scoreValue = Math.max(buyScore, sellScore);
  const aligned = direction === 'BUY'
    ? m15Bull && m5Bull && vwapBull && pullback && (sweepBull || structureBull) && m1Bull
    : m15Bear && m5Bear && vwapBear && pullback && (sweepBear || structureBear) && m1Bear;
  const blockers = [];
  if (regime === 'ranging') blockers.push('السوق عرضي؛ ADX على M15 أقل من 15.');
  if (volatilityAbnormal) blockers.push('تقلب غير طبيعي: ATR الحالي يتجاوز وسيط ATR بنسبة 2.5×.');
  if (!aligned) blockers.push('لم تكتمل شروط توافق الاتجاه، التصحيح، البنية/سحب السيولة، وتأكيد M1.');
  if (scoreValue < MIN_SCORE) blockers.push(`النقاط ${scoreValue}/100 أقل من الحد الأدنى ${MIN_SCORE}.`);
  blockers.push('لا تتوفر بيانات أخبار اقتصادية؛ تحقق من التقويم الإخباري قبل أي قرار.');
  const approved = aligned && scoreValue >= MIN_SCORE && !volatilityAbnormal && regime !== 'ranging';
  const swing = latestSwing(bars.m1, direction);
  const stopDistance = Math.max(a1.atr * (mode === 'scalp' ? 1.5 : 2), direction === 'BUY' ? entry - swing : swing - entry, a1.atr * 0.25);
  const stopLoss = roundPrice(direction === 'BUY' ? entry - stopDistance : entry + stopDistance, symbol);
  const risk = Math.abs(entry - stopLoss);
  const trade = approved ? {
    direction, entry: roundPrice(entry, symbol), stopLoss,
    tp1: roundPrice(entry + (direction === 'BUY' ? 1 : -1) * risk, symbol),
    tp2: roundPrice(entry + (direction === 'BUY' ? 2 : -2) * risk, symbol),
    tp3: roundPrice(entry + (direction === 'BUY' ? 3 : -3) * risk, symbol),
    breakEven: roundPrice(entry, symbol), trailingStop: `After TP1: trail by ${roundPrice(a1.atr, symbol)} price units (ATR 14); broker-side execution is not connected.`,
    lotSize: null, confidence: scoreValue, riskReward: [1, 2, 3],
    reason: direction === 'BUY' ? 'توافق صاعد متعدد الفريمات مع التصحيح وتأكيد بنية/سيولة ومؤشرات M1.' : 'توافق هابط متعدد الفريمات مع التصحيح وتأكيد بنية/سيولة ومؤشرات M1.',
  } : null;
  return {
    approved, signal: approved ? direction : 'WAIT', score: scoreValue, scoreThreshold: MIN_SCORE, mode, timeframe, symbol,
    marketRegime: regime, marketPrice: roundPrice(entry, symbol), reasons: approved ? [trade.reason] : blockers,
    checks: { buy: { score: buyScore, aligned: m15Bull && m5Bull && vwapBull && pullback && (sweepBull || structureBull) && m1Bull }, sell: { score: sellScore, aligned: m15Bear && m5Bear && vwapBear && pullback && (sweepBear || structureBear) && m1Bear }, pullback },
    timeframes: { 'M15': { trend: m15Bull ? 'UP' : m15Bear ? 'DOWN' : 'RANGE', ema50: val(a15.ema50), ema200: val(a15.ema200), adx14: val(a15.adx) }, 'M5': { trend: m5Bull ? 'UP' : m5Bear ? 'DOWN' : 'MIXED', vwap: val(a5.vwap), structure: market.structure, liquiditySweep: market.sweep, support: val(market.support), resistance: val(market.resistance), fvg: market.fvg }, 'M1': { trend: a1.ema9 > a1.ema21 ? 'UP' : 'DOWN', ema9: val(a1.ema9), ema21: val(a1.ema21), rsi7: val(a1.rsi), supertrend: a1.supertrend.direction, atr14: val(a1.atr), tickVolume: latest.volume, volumeAvailable: latest.volume > 0, bollinger: { upper: val(a1.bollinger.upper), lower: val(a1.bollinger.lower) } } },
    trade, riskNotice: 'إشارة تحليلية وليست تنفيذاً أو ضماناً للربح. حجم اللوت، حد الخسارة اليومية، منع التكرار، وقف التعادل، والتتبع الآلي تحتاج بيانات الحساب وحالة الوسيط؛ لا يوجد اتصال تنفيذ في هذا المشروع.',
  };
}

function closedBars(list) { return list.slice(0, -1); }
function score(flags) { return Object.keys(SCORE_WEIGHTS).reduce((sum, key) => sum + (flags[key] ? SCORE_WEIGHTS[key] : 0), 0); }
function indicators(bars) {
  const closes = bars.map((b) => b.close), high = bars.map((b) => b.high), low = bars.map((b) => b.low);
  const atrs = atrSeries(bars), atr = atrs.at(-1) || 0;
  const bb = bollinger(closes);
  return { ema9: ema(closes, 9), ema21: ema(closes, 21), ema50: ema(closes, 50), ema200: ema(closes, 200), rsi: rsi(closes, 7), adx: adx(bars, 14), atr, bollinger: bb, vwap: sessionVwap(bars), supertrend: supertrend(bars, 10, 3, atrs) };
}
function ema(values, period) { const k = 2 / (period + 1); let result = values[0]; for (let i = 1; i < values.length; i++) result += k * (values[i] - result); return result; }
function rsi(values, period) { if (values.length <= period) return 50; let gains = 0, losses = 0; for (let i = values.length - period; i < values.length; i++) { const d = values[i] - values[i - 1]; if (d > 0) gains += d; else losses -= d; } return losses === 0 ? 100 : 100 - 100 / (1 + gains / losses); }
function atrSeries(bars) { const tr = bars.map((b, i) => Math.max(b.high - b.low, i ? Math.abs(b.high - bars[i - 1].close) : 0, i ? Math.abs(b.low - bars[i - 1].close) : 0)); return tr.map((_, i) => { const slice = tr.slice(Math.max(0, i - 13), i + 1); return slice.reduce((a, b) => a + b, 0) / slice.length; }); }
function adx(bars, period) { if (bars.length < period + 1) return 0; const start = bars.length - period; let plus = 0, minus = 0, trSum = 0; for (let i = start; i < bars.length; i++) { const up = bars[i].high - bars[i - 1].high, down = bars[i - 1].low - bars[i].low; plus += up > down && up > 0 ? up : 0; minus += down > up && down > 0 ? down : 0; trSum += Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)); } const pdi = trSum ? 100 * plus / trSum : 0, mdi = trSum ? 100 * minus / trSum : 0; return pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0; }
function sessionVwap(bars) { const date = new Date(bars.at(-1).time).toISOString().slice(0, 10); const session = bars.filter((b) => new Date(b.time).toISOString().slice(0, 10) === date); let pv = 0, volume = 0; for (const b of session) { const v = b.volume > 0 ? b.volume : 1; pv += ((b.high + b.low + b.close) / 3) * v; volume += v; } return volume ? pv / volume : bars.at(-1).close; }
function bollinger(values) { const window = values.slice(-20), mean = window.reduce((a, b) => a + b, 0) / window.length, sd = Math.sqrt(window.reduce((s, x) => s + (x - mean) ** 2, 0) / window.length); return { upper: mean + 2 * sd, lower: mean - 2 * sd }; }
function supertrend(bars, period, multiplier, atrs) { let direction = 'BUY', upper = 0, lower = 0; for (let i = Math.max(period, 1); i < bars.length; i++) { const mid = (bars[i].high + bars[i].low) / 2, atr = atrs[i] || 0, basicUpper = mid + multiplier * atr, basicLower = mid - multiplier * atr; upper = i === period ? basicUpper : (basicUpper < upper || bars[i - 1].close > upper ? basicUpper : upper); lower = i === period ? basicLower : (basicLower > lower || bars[i - 1].close < lower ? basicLower : lower); if (bars[i].close > upper) direction = 'BUY'; else if (bars[i].close < lower) direction = 'SELL'; } return { direction, value: direction === 'BUY' ? lower : upper }; }
function marketStructure(bars) { const end = bars.length - 1, lookback = bars.slice(-31, -1), last = bars.at(-1); const high = Math.max(...lookback.map((b) => b.high)), low = Math.min(...lookback.map((b) => b.low)); const sweep = last.low < low && last.close > low ? 'BUY' : last.high > high && last.close < high ? 'SELL' : 'NONE'; const structure = last.close > high ? 'BUY' : last.close < low ? 'SELL' : 'NONE'; const earlier = bars.slice(-61, -31); const previousHigh = earlier.length ? Math.max(...earlier.map((b) => b.high)) : high, previousLow = earlier.length ? Math.min(...earlier.map((b) => b.low)) : low; const choch = last.close > previousHigh && last.close > high ? 'bullish CHoCH/BOS' : last.close < previousLow && last.close < low ? 'bearish CHoCH/BOS' : 'none'; const recent = bars.slice(-80); let fvg = 'none'; for (let i = recent.length - 1; i >= 2; i--) { if (recent[i].low > recent[i - 2].high) { fvg = 'bullish FVG'; break; } if (recent[i].high < recent[i - 2].low) { fvg = 'bearish FVG'; break; } } return { sweep, structure: structure !== 'NONE' ? structure : choch.startsWith('bullish') ? 'BUY' : choch.startsWith('bearish') ? 'SELL' : 'NONE', support: low, resistance: high, fvg }; }
function latestSwing(bars, direction) { const window = bars.slice(-21, -1); return direction === 'BUY' ? Math.min(...window.map((b) => b.low)) : Math.max(...window.map((b) => b.high)); }
function bullishStrength(c, atr) { const range = c.high - c.low; return range ? (c.close - c.low) / range * (range / Math.max(atr, 1e-12)) : 0; }
function bearishStrength(c, atr) { const range = c.high - c.low; return range ? (c.high - c.close) / range * (range / Math.max(atr, 1e-12)) : 0; }
function median(values) { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; }
function val(n) { return Number.isFinite(n) ? Number(n.toFixed(6)) : null; }
function roundPrice(n, symbol) { const decimals = symbol === 'EURUSD' ? 5 : ['BTCUSD', 'ETHUSD', 'NAS100', 'XAUUSD'].includes(symbol) ? 2 : 4; return Number(n.toFixed(decimals)); }
