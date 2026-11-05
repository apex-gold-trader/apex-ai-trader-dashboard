const SYMBOLS = ['XAUUSD', 'BTCUSD', 'EURUSD', 'ETHUSD', 'NAS100'];
const MIN_BARS = { '1m': 60, '5m': 60, '15m': 205 };
const WEIGHTS = { m15: 15, m5: 15, vwap: 10, ema: 10, sweep: 15, structure: 10, rsi: 10, adx: 5, candle: 5, atr: 5 };
const STEP_MS = { '1m': 60_000, '5m': 300_000, '15m': 900_000 };
const VOLATILITY_SCALE = { XAUUSD: 0.00010, BTCUSD: 0.00035, EURUSD: 0.000035, ETHUSD: 0.0004, NAS100: 0.00012 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}; }
  catch { return res.status(400).json({ success: false, error: 'Invalid JSON body' }); }

  const symbol = String(body.symbol || '').toUpperCase();
  const mode = body.mode === 'scalp' ? 'scalp' : 'standard';
  const price = Number(body.livePrice);
  const updatedAt = Number(body.quoteUpdatedAt);
  if (!SYMBOLS.includes(symbol)) return res.status(400).json({ success: false, error: 'Unsupported symbol' });
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(updatedAt) || Date.now() - updatedAt > 180_000 || updatedAt > Date.now() + 30_000) {
    return res.status(422).json({ success: false, error: 'A valid, recent, timestamped spot quote is required.' });
  }

  const supplied = body.candles;
  const hasRealCandles = supplied && ['1m', '5m', '15m'].every((tf) => Array.isArray(supplied[tf]) && supplied[tf].length >= MIN_BARS[tf]);
  const candles = hasRealCandles
    ? Object.fromEntries(['1m', '5m', '15m'].map((tf) => [tf, sanitize(supplied[tf])]))
    : buildSyntheticCandles(price, symbol, body.quoteHistory);

  try {
    const result = analyze(symbol, mode, price, candles, updatedAt, !hasRealCandles);
    return res.status(200).json({ success: true, source: hasRealCandles ? 'spot-OHLC deterministic analysis' : 'synthetic-indicator-preview', ...result });
  } catch (error) {
    return res.status(422).json({ success: false, error: error.message || 'Analysis failed' });
  }
}

function sanitize(items) {
  return items.slice(-2000).map((c) => ({ time: Number(c.time), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume) || 0 }))
    .filter((c) => Number.isFinite(c.time) && [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v) && v > 0) && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close))
    .sort((a, b) => a.time - b.time);
}

// Synthetic bars are strictly a UI/indicator preview. They are anchored to the fresh
// quote and observed quote history, but are not market observations and never approve trades.
function buildSyntheticCandles(price, symbol, history) {
  const observations = Array.isArray(history) ? history.map((item) => ({ price: Number(item?.price), time: Number(item?.time) })).filter((item) => item.price > 0 && Number.isFinite(item.time)).slice(-20) : [];
  const first = observations[0]?.price || price;
  const observedReturn = Math.max(-0.002, Math.min(0.002, (price - first) / first));
  const scale = price * VOLATILITY_SCALE[symbol];
  const now = Date.now();
  const bars = {};
  for (const tf of ['1m', '5m', '15m']) {
    const count = 220, step = STEP_MS[tf], trendPerBar = (price * observedReturn) / count;
    let close = price;
    const reverse = [];
    for (let i = count - 1; i >= 0; i--) {
      const phase = stableNoise(`${symbol}:${tf}:${Math.floor(now / step)}:${i}`);
      const priorClose = close - trendPerBar - phase * scale * (tf === '1m' ? 0.7 : tf === '5m' ? 1.6 : 3.2);
      const open = priorClose;
      const nextClose = i === count - 1 ? price : close;
      const wick = scale * (0.25 + Math.abs(stableNoise(`${symbol}:${tf}:wick:${i}`)) * 0.4) * Math.sqrt(tf === '15m' ? 15 : tf === '5m' ? 5 : 1);
      reverse.push({ time: now - (count - 1 - i) * step, open, high: Math.max(open, nextClose) + wick, low: Math.max(Number.EPSILON, Math.min(open, nextClose) - wick), close: nextClose, volume: 0 });
      close = priorClose;
    }
    bars[tf] = reverse.reverse();
  }
  return bars;
}

function stableNoise(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return ((hash >>> 0) / 4294967295) * 2 - 1;
}

function analyze(symbol, mode, price, candles, quoteUpdatedAt, synthetic) {
  const bars = Object.fromEntries(['1m', '5m', '15m'].map((tf) => [tf, candles[tf].slice(0, -1)]));
  if (bars['15m'].length < 200 || bars['5m'].length < 50 || bars['1m'].length < 50) throw new Error('Insufficient completed candles for analysis.');
  const i1 = indicators(bars['1m']), i5 = indicators(bars['5m']), i15 = indicators(bars['15m']), last = bars['1m'].at(-1);
  const structure = swingState(bars['5m']);
  const up15 = i15.e50 > i15.e200 && i15.adx >= 15, down15 = i15.e50 < i15.e200 && i15.adx >= 15;
  const up5 = i5.e50 > i5.e200 && i5.e9 > i5.e21, down5 = i5.e50 < i5.e200 && i5.e9 < i5.e21;
  const pullback = Math.min(Math.abs(price - i1.e21), Math.abs(price - i5.vwap)) <= i1.atr * 0.8;
  const up1 = i1.e9 > i1.e21 && i1.rsi >= 50 && i1.rsi <= 75 && i1.supertrend === 'BUY' && last.close > last.open;
  const down1 = i1.e9 < i1.e21 && i1.rsi <= 50 && i1.rsi >= 25 && i1.supertrend === 'SELL' && last.close < last.open;
  const abnormal = i1.atr / Math.max(median(atrSeries(bars['1m']).slice(-100)), 1e-12) > 2.5;
  const regime = abnormal ? 'تقلب مرتفع وغير طبيعي' : i15.adx < 15 ? 'سوق عرضي' : up15 ? 'اتجاه صاعد' : down15 ? 'اتجاه هابط' : 'غير واضح';
  const scoreFor = (buy) => {
    const checks = { m15: buy ? up15 : down15, m5: buy ? up5 : down5, vwap: buy ? price > i5.vwap : price < i5.vwap, ema: buy ? i1.e9 > i1.e21 : i1.e9 < i1.e21, sweep: structure.sweep === (buy ? 'BUY' : 'SELL'), structure: structure.direction === (buy ? 'BUY' : 'SELL'), rsi: buy ? i1.rsi >= 50 && i1.rsi <= 75 : i1.rsi <= 50 && i1.rsi >= 25, adx: i15.adx >= 20, candle: candleStrength(last, i1.atr, buy ? 'BUY' : 'SELL') >= 0.45, atr: i1.atr > 0 && !abnormal };
    return Object.keys(WEIGHTS).reduce((sum, key) => sum + (checks[key] ? WEIGHTS[key] : 0), 0);
  };
  const buyScore = scoreFor(true), sellScore = scoreFor(false), direction = buyScore >= sellScore ? 'BUY' : 'SELL', score = Math.max(buyScore, sellScore);
  const aligned = direction === 'BUY' ? up15 && up5 && price > i5.vwap && pullback && (structure.sweep === 'BUY' || structure.direction === 'BUY') && up1 : down15 && down5 && price < i5.vwap && pullback && (structure.sweep === 'SELL' || structure.direction === 'SELL') && down1;
  const approved = !synthetic && aligned && score >= 75 && !abnormal && i15.adx >= 15;
  const reasons = [];
  if (synthetic) reasons.push('المؤشرات والنقاط المعروضة تقريبية ومبنية على شموع مولدة اصطناعياً، وليست قياسات لحركة السوق الفعلية.');
  if (!aligned) reasons.push('شروط توافق M15/M5 والسعر الفوري والتصحيح وبنية السوق وتأكيد M1 غير مكتملة.');
  if (score < 75) reasons.push(`النقاط ${score}/100 أقل من 75.`);
  if (abnormal) reasons.push('تم إيقاف الإشارة بسبب تقلب غير طبيعي.');
  if (i15.adx < 15) reasons.push('السوق عرضي؛ ADX أقل من 15.');
  if (!approved) reasons.push('تحقق من الأخبار الاقتصادية يدوياً؛ بيانات الأخبار غير متاحة للمحرك.');
  const swing = direction === 'BUY' ? Math.min(...bars['1m'].slice(-20).map((c) => c.low)) : Math.max(...bars['1m'].slice(-20).map((c) => c.high));
  const distance = Math.max(i1.atr * (mode === 'scalp' ? 1.5 : 2), direction === 'BUY' ? price - swing : swing - price, i1.atr * 0.25);
  const stop = round(direction === 'BUY' ? price - distance : price + distance, symbol), risk = Math.abs(price - stop);
  const proposedTrade = { direction, entry: round(price, symbol), stopLoss: stop, tp1: round(price + (direction === 'BUY' ? 1 : -1) * risk, symbol), tp2: round(price + (direction === 'BUY' ? 1 : -1) * risk * 2, symbol), tp3: round(price + (direction === 'BUY' ? 1 : -1) * risk * 3, symbol), breakEven: round(price, symbol), confidence: score, lotSize: null };
  const output = {
    approved, signal: approved ? direction : 'WAIT', candidateDirection: direction, score, scoreThreshold: 75,
    mode, symbol, marketPrice: round(price, symbol), quoteUpdatedAt, marketRegime: regime,
    dataMode: synthetic ? 'SYNTHETIC_PREVIEW_NOT_MARKET_DATA' : 'REAL_OHLC',
    reasons: approved ? ['توافق فني على بيانات OHLC المتاحة والسعر الفوري الحالي.'] : reasons,
    indicators: { M15: { ema50: n(i15.e50), ema200: n(i15.e200), adx14: n(i15.adx) }, M5: { ema9: n(i5.e9), ema21: n(i5.e21), ema50: n(i5.e50), vwap: n(i5.vwap), sweep: structure.sweep }, M1: { ema9: n(i1.e9), ema21: n(i1.e21), rsi7: n(i1.rsi), atr14: n(i1.atr), supertrend: i1.supertrend } },
    trade: approved ? proposedTrade : null,
    simulatedLevels: synthetic ? proposedTrade : null,
    riskNotice: synthetic ? 'SIMULATION ONLY: candles, indicators, score and candidate direction are synthetic previews, not live technical analysis. No BUY/SELL trade recommendation is approved; do not use simulated levels for trading.' : 'الإشارة تحليلية وليست تنفيذاً أو ضماناً للربح. لا يوجد اتصال تنفيذ وسيط.',
  };
  return output;
}

function indicators(bars) { const closes = bars.map((b) => b.close), atr = atrSeries(bars); return { e9: ema(closes, 9), e21: ema(closes, 21), e50: ema(closes, 50), e200: ema(closes, 200), rsi: rsi(closes, 7), adx: adx(bars, 14), atr: atr.at(-1), vwap: vwap(bars), supertrend: supertrend(bars, atr) }; }
function ema(values, period) { let value = values[0], k = 2 / (period + 1); for (let i = 1; i < values.length; i++) value += (values[i] - value) * k; return value; }
function rsi(values, period) { let gains = 0, losses = 0; for (let i = values.length - period; i < values.length; i++) { const d = values[i] - values[i - 1]; if (d > 0) gains += d; else losses -= d; } return losses === 0 ? 100 : 100 - 100 / (1 + gains / losses); }
function atrSeries(bars) { const tr = bars.map((c, i) => Math.max(c.high - c.low, i ? Math.abs(c.high - bars[i - 1].close) : 0, i ? Math.abs(c.low - bars[i - 1].close) : 0)); return tr.map((_, i) => tr.slice(Math.max(0, i - 13), i + 1).reduce((a, b) => a + b, 0) / Math.min(i + 1, 14)); }
function adx(bars, period) { let plus = 0, minus = 0, total = 0; for (let i = bars.length - period; i < bars.length; i++) { const up = bars[i].high - bars[i - 1].high, down = bars[i - 1].low - bars[i].low; plus += up > down && up > 0 ? up : 0; minus += down > up && down > 0 ? down : 0; total += Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)); } const p = total ? 100 * plus / total : 0, m = total ? 100 * minus / total : 0; return p + m ? 100 * Math.abs(p - m) / (p + m) : 0; }
function vwap(bars) { const date = new Date(bars.at(-1).time).toISOString().slice(0, 10), session = bars.filter((b) => new Date(b.time).toISOString().slice(0, 10) === date); let pv = 0, volume = 0; for (const b of session) { const v = b.volume > 0 ? b.volume : 1; pv += ((b.high + b.low + b.close) / 3) * v; volume += v; } return pv / volume; }
function supertrend(bars, atr) { let direction = 'BUY', upper = 0, lower = 0; for (let i = 10; i < bars.length; i++) { const mid = (bars[i].high + bars[i].low) / 2, hi = mid + 3 * atr[i], lo = mid - 3 * atr[i]; upper = hi < upper || bars[i - 1].close > upper ? hi : upper; lower = lo > lower || bars[i - 1].close < lower ? lo : lower; if (bars[i].close > upper) direction = 'BUY'; else if (bars[i].close < lower) direction = 'SELL'; } return direction; }
function swingState(bars) { const window = bars.slice(-31, -1), last = bars.at(-1), high = Math.max(...window.map((b) => b.high)), low = Math.min(...window.map((b) => b.low)); return { sweep: last.low < low && last.close > low ? 'BUY' : last.high > high && last.close < high ? 'SELL' : 'NONE', direction: last.close > high ? 'BUY' : last.close < low ? 'SELL' : 'NONE' }; }
function candleStrength(c, atr, direction) { const range = c.high - c.low; return range ? (direction === 'BUY' ? c.close - c.low : c.high - c.close) / Math.max(range, 1e-12) * range / Math.max(atr, 1e-12) : 0; }
function median(values) { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0; }
function n(value) { return Number.isFinite(value) ? Number(value.toFixed(6)) : null; }
function round(value, symbol) { return Number(value.toFixed(symbol === 'EURUSD' ? 5 : 2)); }
