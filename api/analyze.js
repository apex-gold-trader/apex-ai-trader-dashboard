const SYMBOLS = ['XAUUSD', 'BTCUSD', 'EURUSD', 'ETHUSD', 'NAS100'];
const TIMEFRAMES = ['1m', '5m', '15m'];
const MIN_BARS = { '1m': 60, '5m': 60, '15m': 205 };
const MIN_SIGNAL_SCORE = 60;
const MAX_QUOTE_AGE_MS = 180_000;
const WEIGHTS = { higherTrend: 15, setupTrend: 15, vwap: 10, ema: 10, liquidity: 15, structure: 10, rsi: 10, adx: 5, candle: 5, volatility: 5 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}; }
  catch { return res.status(400).json({ success: false, error: 'Invalid JSON body' }); }

  const symbol = String(body.symbol || '').toUpperCase();
  const mode = body.mode === 'scalp' ? 'scalp' : 'standard';
  const requestedTimeframe = String(body.timeframe || (mode === 'scalp' ? '1m' : '5m'));
  const timeframe = TIMEFRAMES.includes(requestedTimeframe) ? requestedTimeframe : (mode === 'scalp' ? '1m' : '5m');
  const price = Number(body.livePrice);
  const quoteUpdatedAt = Number(body.quoteUpdatedAt);
  const candles = body.candles;
  if (!SYMBOLS.includes(symbol)) return res.status(400).json({ success: false, error: 'Unsupported symbol' });

  const quoteValid = Number.isFinite(price) && price > 0 && Number.isFinite(quoteUpdatedAt)
    && Date.now() - quoteUpdatedAt <= MAX_QUOTE_AGE_MS && quoteUpdatedAt <= Date.now() + 30_000;
  if (!quoteValid) return waitResponse(res, symbol, mode, timeframe, null, null, 'السعر الفوري غير متوفر أو قديم.');
  if (!candles || TIMEFRAMES.some((tf) => !Array.isArray(candles[tf]) || candles[tf].length < MIN_BARS[tf])) {
    return waitResponse(res, symbol, mode, timeframe, price, quoteUpdatedAt, 'لا تتوفر شموع OHLC حقيقية مكتملة وكافية للفريمات المطلوبة.');
  }

  try {
    const clean = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, sanitize(candles[tf])]));
    if (TIMEFRAMES.some((tf) => clean[tf].length < MIN_BARS[tf])) return waitResponse(res, symbol, mode, timeframe, price, quoteUpdatedAt, 'الشموع المستلمة غير صالحة أو غير كافية.');
    const newestMinute = clean['1m'].at(-1).time;
    if (Date.now() - newestMinute > MAX_QUOTE_AGE_MS) return waitResponse(res, symbol, mode, timeframe, price, quoteUpdatedAt, 'أحدث شمعة M1 قديمة؛ لا يتم إصدار إشارة.');
    return res.status(200).json({ success: true, source: 'real spot OHLC technical analysis', ...analyze({ symbol, mode, timeframe, price, quoteUpdatedAt, candles: clean }) });
  } catch (error) {
    return res.status(422).json({ success: false, error: error.message || 'Analysis failed' });
  }
}

function waitResponse(res, symbol, mode, timeframe, price, quoteUpdatedAt, reason) {
  return res.status(200).json({
    success: true, approved: false, signal: 'WAIT', score: null, scoreThreshold: MIN_SIGNAL_SCORE,
    symbol, mode, timeframe, selectedTimeframe: timeframe, marketPrice: price, quoteUpdatedAt,
    marketRegime: 'غير محدد — بيانات حقيقية غير كافية', dataMode: 'NO_SIGNAL', trade: null,
    reasons: [reason, 'لا يتم إنشاء شموع أو نقاط اصطناعية.'],
    riskNotice: 'WAIT: لا توجد توصية حتى تتوفر بيانات OHLC حقيقية وحديثة.',
  });
}

function sanitize(items) {
  return items.slice(-2000)
    .map((c) => ({ time: Number(c.time), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume) || 0 }))
    .filter((c) => Number.isFinite(c.time) && [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v) && v > 0)
      && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close))
    .sort((a, b) => a.time - b.time)
    .filter((c, i, all) => i === 0 || c.time > all[i - 1].time);
}

function analyze({ symbol, mode, timeframe, price, quoteUpdatedAt, candles }) {
  // Exclude the current in-progress candle from indicator calculations.
  const bars = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, candles[tf].slice(0, -1)]));
  if (bars['15m'].length < 200 || bars['5m'].length < 50 || bars['1m'].length < 50) throw new Error('Insufficient completed real OHLC candles.');

  const metrics = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, indicators(bars[tf])]));
  const i1 = metrics['1m'], i5 = metrics['5m'], i15 = metrics['15m'];
  const selected = metrics[timeframe], selectedBars = bars[timeframe], signalCandle = selectedBars.at(-1);
  const structure = swingState(bars['5m']);
  const atrReference = median(atrSeries(bars['1m']).slice(-100));
  const volatilityRatio = atrReference > 0 ? i1.atr / atrReference : 1;
  const highVolatility = volatilityRatio > 2.5;
  const trend = classifyTrend(i15, i5);
  const buyScore = scoreFor('BUY', { i1, i5, i15, price, structure, signalCandle, selected, trend });
  const sellScore = scoreFor('SELL', { i1, i5, i15, price, structure, signalCandle, selected, trend });
  const direction = buyScore > sellScore ? 'BUY' : 'SELL';
  const score = Math.max(buyScore, sellScore);

  // Require a genuine directional setup on the chosen chart timeframe, but do not
  // require every higher timeframe to agree or block entries only because ATR rose.
  const trendAligned = direction === 'BUY'
    ? selected.ema9 > selected.ema21 && selected.supertrend === 'BUY'
    : selected.ema9 < selected.ema21 && selected.supertrend === 'SELL';
  const momentumConfirmed = direction === 'BUY'
    ? selected.rsi >= 50 && selected.rsi <= 76 && signalCandle.close > signalCandle.open
    : selected.rsi <= 50 && selected.rsi >= 24 && signalCandle.close < signalCandle.open;
  const notChasing = Math.abs(price - selected.ema21) <= Math.max(selected.atr * 2.25, price * 0.00005);
  const approved = score >= MIN_SIGNAL_SCORE && trendAligned && momentumConfirmed && notChasing && selected.atr > 0;

  const reasons = [];
  if (score < MIN_SIGNAL_SCORE) reasons.push(`النقاط ${score}/100 أقل من الحد المطلوب ${MIN_SIGNAL_SCORE}.`);
  if (!trendAligned) reasons.push(`اتجاه EMA 9/21 وSupertrend غير متوافق على ${timeframe}.`);
  if (!momentumConfirmed) reasons.push(`شمعة الإغلاق أو RSI لا يؤكدان الزخم على ${timeframe}.`);
  if (!notChasing) reasons.push('السعر بعيد عن EMA 21 بأكثر من نطاق ATR المسموح؛ تجنب مطاردة الحركة.');
  if (highVolatility) reasons.push('التقلب مرتفع؛ لم يمنع الإشارة تلقائياً، لكنه يرفع مستوى المخاطر ويؤثر في الوقف.');

  // Structure + ATR stop. A very distant swing is capped at 2.5 ATR to prevent
  // oversized stops; targets are expressed as explicit risk multiples.
  const recent = selectedBars.slice(-20);
  const structureDistance = direction === 'BUY'
    ? price - Math.min(...recent.map((bar) => bar.low)) + selected.atr * 0.15
    : Math.max(...recent.map((bar) => bar.high)) - price + selected.atr * 0.15;
  const rawStopDistance = Math.max(selected.atr * (mode === 'scalp' ? 1.25 : 1.6), structureDistance);
  const stopDistance = Math.min(rawStopDistance, selected.atr * 2.5);
  const stopLoss = round(direction === 'BUY' ? price - stopDistance : price + stopDistance, symbol);
  const risk = Math.abs(price - stopLoss);
  const trade = approved ? {
    direction,
    entry: round(price, symbol),
    stopLoss,
    tp1: round(price + (direction === 'BUY' ? 1 : -1) * risk * 1.5, symbol),
    tp2: round(price + (direction === 'BUY' ? 1 : -1) * risk * 2, symbol),
    tp3: round(price + (direction === 'BUY' ? 1 : -1) * risk * 2.5, symbol),
    breakEven: round(price, symbol),
    stopDistance: round(risk, symbol),
    riskReward: { tp1: 1.5, tp2: 2, tp3: 2.5 },
    confidence: score,
    lotSize: null,
  } : null;

  const reasonsForApproved = [`الدرجة ${score}/100، اتجاه EMA/Supertrend وزخم RSI مؤكدان على ${timeframe}.`, 'مستويات المخاطرة والأهداف محسوبة من ATR وبنية الشموع الحقيقية.'];
  return {
    approved, signal: approved ? direction : 'WAIT', candidateDirection: direction,
    score, scoreThreshold: MIN_SIGNAL_SCORE, scoreComponents: {
      BUY: scoreForBreakdown('BUY', { i1, i5, i15, price, structure, signalCandle, selected, trend }),
      SELL: scoreForBreakdown('SELL', { i1, i5, i15, price, structure, signalCandle, selected, trend }),
    },
    mode, timeframe, selectedTimeframe: timeframe, symbol, marketPrice: round(price, symbol), quoteUpdatedAt,
    marketRegime: highVolatility ? `تقلب مرتفع (${volatilityRatio.toFixed(2)}× ATR المعتاد)` : trend,
    volatility: { atr14: n(i1.atr), ratioToRecentMedian: n(volatilityRatio), elevated: highVolatility },
    dataMode: 'REAL_OHLC',
    reasons: approved ? reasonsForApproved : reasons,
    trade,
    indicators: {
      M15: { trend: i15.ema50 > i15.ema200 ? 'UP' : i15.ema50 < i15.ema200 ? 'DOWN' : 'MIXED', ema50: n(i15.ema50), ema200: n(i15.ema200), adx14: n(i15.adx) },
      M5: { trend: i5.ema9 > i5.ema21 ? 'UP' : 'DOWN', ema9: n(i5.ema9), ema21: n(i5.ema21), ema50: n(i5.ema50), vwap: n(i5.vwap), liquiditySweep: structure.sweep, structure: structure.direction },
      [timeframe]: { ema9: n(selected.ema9), ema21: n(selected.ema21), ema50: n(selected.ema50), rsi7: n(selected.rsi), atr14: n(selected.atr), supertrend: selected.supertrend, candleClose: n(signalCandle.close) },
    },
    riskNotice: 'إشارة تحليلية وليست تنفيذاً أو ضماناً للربح. الدرجة ليست احتمال ربح. التقلب المرتفع يرفع المخاطر؛ راجع حجم العقد وشروط وسيطك قبل أي قرار.',
  };
}

function scoreFor(direction, input) {
  return Object.values(scoreForBreakdown(direction, input)).reduce((sum, item) => sum + item.earned, 0);
}
function scoreForBreakdown(direction, { i1, i5, i15, price, structure, signalCandle, selected, trend }) {
  const buy = direction === 'BUY';
  const checks = {
    higherTrend: buy ? i15.ema50 > i15.ema200 : i15.ema50 < i15.ema200,
    setupTrend: buy ? i5.ema50 > i5.ema200 && i5.ema9 > i5.ema21 : i5.ema50 < i5.ema200 && i5.ema9 < i5.ema21,
    vwap: buy ? price > i5.vwap : price < i5.vwap,
    ema: buy ? selected.ema9 > selected.ema21 : selected.ema9 < selected.ema21,
    liquidity: structure.sweep === direction,
    structure: structure.direction === direction,
    rsi: buy ? selected.rsi >= 50 && selected.rsi <= 76 : selected.rsi <= 50 && selected.rsi >= 24,
    adx: i15.adx >= 18,
    candle: candleStrength(signalCandle, selected.atr, direction) >= 0.4,
    volatility: selected.atr > 0,
  };
  return Object.fromEntries(Object.entries(WEIGHTS).map(([key, weight]) => [key, { earned: checks[key] ? weight : 0, max: weight, passed: checks[key] }]));
}

function classifyTrend(i15, i5) {
  if (i15.ema50 > i15.ema200 && i5.ema9 > i5.ema21) return 'اتجاه صاعد متوافق';
  if (i15.ema50 < i15.ema200 && i5.ema9 < i5.ema21) return 'اتجاه هابط متوافق';
  return 'اتجاه مختلط/انتقالي';
}
function indicators(bars) { const closes = bars.map((bar) => bar.close), atr = atrSeries(bars); return { ema9: ema(closes, 9), ema21: ema(closes, 21), ema50: ema(closes, 50), ema200: ema(closes, 200), rsi: rsi(closes, 7), adx: adx(bars, 14), atr: atr.at(-1), vwap: vwap(bars), supertrend: supertrend(bars, atr) }; }
function ema(values, period) { let value = values[0], k = 2 / (period + 1); for (let i = 1; i < values.length; i++) value += (values[i] - value) * k; return value; }
function rsi(values, period) { let gains = 0, losses = 0; for (let i = values.length - period; i < values.length; i++) { const d = values[i] - values[i - 1]; if (d > 0) gains += d; else losses -= d; } return losses === 0 ? 100 : 100 - 100 / (1 + gains / losses); }
function atrSeries(bars) { const tr = bars.map((c, i) => Math.max(c.high - c.low, i ? Math.abs(c.high - bars[i - 1].close) : 0, i ? Math.abs(c.low - bars[i - 1].close) : 0)); return tr.map((_, i) => tr.slice(Math.max(0, i - 13), i + 1).reduce((a, x) => a + x, 0) / Math.min(i + 1, 14)); }
function adx(bars, period) { let plus = 0, minus = 0, total = 0; for (let i = bars.length - period; i < bars.length; i++) { const up = bars[i].high - bars[i - 1].high, down = bars[i - 1].low - bars[i].low; plus += up > down && up > 0 ? up : 0; minus += down > up && down > 0 ? down : 0; total += Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)); } const p = total ? 100 * plus / total : 0, m = total ? 100 * minus / total : 0; return p + m ? 100 * Math.abs(p - m) / (p + m) : 0; }
function vwap(bars) { const date = new Date(bars.at(-1).time).toISOString().slice(0, 10), session = bars.filter((bar) => new Date(bar.time).toISOString().slice(0, 10) === date); let pv = 0, volume = 0; for (const bar of session) { const weight = bar.volume > 0 ? bar.volume : 1; pv += ((bar.high + bar.low + bar.close) / 3) * weight; volume += weight; } return pv / volume; }
function supertrend(bars, atr) { let direction = 'BUY', upper = 0, lower = 0; for (let i = 10; i < bars.length; i++) { const mid = (bars[i].high + bars[i].low) / 2, nextUpper = mid + 3 * atr[i], nextLower = mid - 3 * atr[i]; upper = nextUpper < upper || bars[i - 1].close > upper ? nextUpper : upper; lower = nextLower > lower || bars[i - 1].close < lower ? nextLower : lower; if (bars[i].close > upper) direction = 'BUY'; else if (bars[i].close < lower) direction = 'SELL'; } return direction; }
function swingState(bars) { const window = bars.slice(-31, -1), last = bars.at(-1), high = Math.max(...window.map((bar) => bar.high)), low = Math.min(...window.map((bar) => bar.low)); return { sweep: last.low < low && last.close > low ? 'BUY' : last.high > high && last.close < high ? 'SELL' : 'NONE', direction: last.close > high ? 'BUY' : last.close < low ? 'SELL' : 'NONE' }; }
function candleStrength(candle, atr, direction) { const range = candle.high - candle.low; return range ? (direction === 'BUY' ? candle.close - candle.low : candle.high - candle.close) / Math.max(range, 1e-12) * range / Math.max(atr, 1e-12) : 0; }
function median(values) { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0; }
function n(value) { return Number.isFinite(value) ? Number(value.toFixed(6)) : null; }
function round(value, symbol) { return Number(value.toFixed(symbol === 'EURUSD' ? 5 : 2)); }
