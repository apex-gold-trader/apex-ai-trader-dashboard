const SYMBOLS = ['XAUUSD', 'BTCUSD', 'EURUSD', 'ETHUSD', 'NAS100'];
const TIMEFRAMES = ['1m', '5m', '15m'];
const MIN_BARS = { '1m': 60, '5m': 60, '15m': 205 };
const MIN_SIGNAL_SCORE = 60;
const WEIGHTS = { m15: 15, m5: 15, vwap: 10, ema: 10, sweep: 15, structure: 10, rsi: 10, adx: 5, candle: 5, atr: 5 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}; }
  catch { return res.status(400).json({ success: false, error: 'Invalid JSON body' }); }

  const symbol = String(body.symbol || '').toUpperCase();
  const mode = body.mode === 'scalp' ? 'scalp' : 'standard';
  const requestedTimeframe = String(body.timeframe || (mode === 'scalp' ? '1m' : '5m'));
  const selectedTimeframe = TIMEFRAMES.includes(requestedTimeframe) ? requestedTimeframe : (mode === 'scalp' ? '1m' : '5m');
  const price = Number(body.livePrice);
  const updatedAt = Number(body.quoteUpdatedAt);
  const candles = body.candles;
  if (!SYMBOLS.includes(symbol)) return res.status(400).json({ success: false, error: 'Unsupported symbol' });

  const quoteValid = Number.isFinite(price) && price > 0 && Number.isFinite(updatedAt)
    && Date.now() - updatedAt <= 180_000 && updatedAt <= Date.now() + 30_000;
  const barsReady = candles && TIMEFRAMES.every((tf) => Array.isArray(candles[tf]) && candles[tf].length >= MIN_BARS[tf]);
  if (!quoteValid || !barsReady) {
    return waitResponse(res, symbol, mode, selectedTimeframe, quoteValid ? price : null, quoteValid ? updatedAt : null,
      !quoteValid ? 'السعر الفوري غير متوفر أو قديم.' : 'لا تتوفر شموع OHLC حقيقية مكتملة وكافية للفريمات المطلوبة.');
  }

  try {
    const clean = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, sanitize(candles[tf])]));
    if (TIMEFRAMES.some((tf) => clean[tf].length < MIN_BARS[tf])) {
      return waitResponse(res, symbol, mode, selectedTimeframe, price, updatedAt, 'الشموع المستلمة غير صالحة أو غير كافية.');
    }
    if (Date.now() - (clean['1m'].at(-1)?.time || 0) > 180_000) {
      return waitResponse(res, symbol, mode, selectedTimeframe, price, updatedAt, 'أحدث شمعة M1 قديمة؛ لا يتم إصدار إشارة.');
    }
    return res.status(200).json({ success: true, source: 'real spot OHLC technical analysis', ...analyze(symbol, mode, selectedTimeframe, price, clean, updatedAt) });
  } catch (error) {
    return res.status(422).json({ success: false, error: error.message || 'Analysis failed' });
  }
}

function waitResponse(res, symbol, mode, timeframe, price, updatedAt, reason) {
  return res.status(200).json({ success: true, approved: false, signal: 'WAIT', score: null, scoreThreshold: MIN_SIGNAL_SCORE, symbol, mode, timeframe, selectedTimeframe: timeframe, marketPrice: price, quoteUpdatedAt: updatedAt, marketRegime: 'غير محدد — بيانات حقيقية غير كافية', dataMode: 'NO_SIGNAL', trade: null, reasons: [reason, 'لم يتم توليد شموع أو نقاط اصطناعية.'], riskNotice: 'WAIT: لا توجد توصية تداول حتى تتوفر بيانات OHLC حقيقية وحديثة.' });
}

function sanitize(items) {
  return items.slice(-2000).map((c) => ({ time: Number(c.time), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume) || 0 }))
    .filter((c) => Number.isFinite(c.time) && [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v) && v > 0) && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close))
    .sort((a, b) => a.time - b.time);
}

function analyze(symbol, mode, selectedTimeframe, price, candles, quoteUpdatedAt) {
  const bars = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, candles[tf].slice(0, -1)]));
  if (bars['15m'].length < 200 || bars['5m'].length < 50 || bars['1m'].length < 50) throw new Error('Insufficient completed real OHLC candles.');
  const stats = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, indicators(bars[tf])]));
  const i1 = stats['1m'], i5 = stats['5m'], i15 = stats['15m'];
  const selectedBars = bars[selectedTimeframe];
  const selected = stats[selectedTimeframe];
  const selectedClose = selectedBars.at(-1);
  const structure = swingState(bars['5m']);
  const up15 = i15.e50 > i15.e200 && i15.adx >= 15;
  const down15 = i15.e50 < i15.e200 && i15.adx >= 15;
  const up5 = i5.e50 > i5.e200 && i5.e9 > i5.e21;
  const down5 = i5.e50 < i5.e200 && i5.e9 < i5.e21;
  const abnormal = i1.atr / Math.max(median(atrSeries(bars['1m']).slice(-100)), 1e-12) > 2.5;
  const regime = abnormal ? 'تقلب مرتفع وغير طبيعي' : i15.adx < 15 ? 'سوق عرضي/ضعيف الاتجاه' : up15 ? 'اتجاه صاعد' : down15 ? 'اتجاه هابط' : 'غير واضح';

  const buyScore = scoreFor('BUY', { i1, i5, i15, price, structure, selectedClose, selected });
  const sellScore = scoreFor('SELL', { i1, i5, i15, price, structure, selectedClose, selected });
  const direction = buyScore >= sellScore ? 'BUY' : 'SELL';
  const score = Math.max(buyScore, sellScore);
  // Selected timeframe direction can be confirmed by Supertrend OR RSI; other timeframes
  // contribute to the score but no longer have to agree perfectly for an entry candidate.
  const selectedConfirmation = direction === 'BUY'
    ? selected.supertrend === 'BUY' || selected.rsi >= 55
    : selected.supertrend === 'SELL' || selected.rsi <= 45;
  const approved = score >= MIN_SIGNAL_SCORE && selectedConfirmation && !abnormal;
  const reasons = [];
  if (!selectedConfirmation) reasons.push(`لا يوجد تأكيد اتجاه كافٍ على ${selectedTimeframe}: يلزم Supertrend أو RSI واضح في اتجاه الصفقة.`);
  if (score < MIN_SIGNAL_SCORE) reasons.push(`النقاط ${score}/100 أقل من الحد الأدنى ${MIN_SIGNAL_SCORE}.`);
  if (abnormal) reasons.push('تم إيقاف المرشح بسبب تقلب غير طبيعي في ATR.');
  if (i15.adx < 15) reasons.push('قوة الاتجاه على M15 ضعيفة؛ خفّض ذلك نقاط الاتجاه، ولا يمنع وحده إشارة مؤكدة من الفريم المختار.');

  const swing = direction === 'BUY'
    ? Math.min(...selectedBars.slice(-20).map((c) => c.low))
    : Math.max(...selectedBars.slice(-20).map((c) => c.high));
  const distance = Math.max(selected.atr * (mode === 'scalp' ? 1.5 : 2), direction === 'BUY' ? price - swing : swing - price, selected.atr * 0.25);
  const stopLoss = round(direction === 'BUY' ? price - distance : price + distance, symbol);
  const risk = Math.abs(price - stopLoss);
  const trade = approved ? {
    direction,
    entry: round(price, symbol),
    stopLoss,
    tp1: round(price + (direction === 'BUY' ? 1 : -1) * risk, symbol),
    tp2: round(price + (direction === 'BUY' ? 2 : -2) * risk, symbol),
    tp3: round(price + (direction === 'BUY' ? 3 : -3) * risk, symbol),
    breakEven: round(price, symbol),
    confidence: score,
    lotSize: null,
  } : null;

  return {
    approved,
    signal: approved ? direction : 'WAIT',
    candidateDirection: direction,
    selectedConfirmation,
    selectedTimeframe,
    buyScore,
    sellScore,
    score,
    scoreThreshold: MIN_SIGNAL_SCORE,
    mode,
    timeframe: selectedTimeframe,
    symbol,
    marketPrice: round(price, symbol),
    quoteUpdatedAt,
    marketRegime: regime,
    dataMode: 'REAL_OHLC',
    reasons: approved ? [`تجاوزت النقاط ${MIN_SIGNAL_SCORE} مع تأكيد ${direction} من ${selectedTimeframe} عبر Supertrend أو RSI.`] : reasons,
    trade,
    indicators: {
      M15: { ema50: n(i15.e50), ema200: n(i15.e200), adx14: n(i15.adx), supertrend: i15.supertrend, rsi7: n(i15.rsi) },
      M5: { ema9: n(i5.e9), ema21: n(i5.e21), ema50: n(i5.e50), vwap: n(i5.vwap), liquiditySweep: structure.sweep, structure: structure.direction, supertrend: i5.supertrend, rsi7: n(i5.rsi) },
      M1: { ema9: n(i1.e9), ema21: n(i1.e21), rsi7: n(i1.rsi), atr14: n(i1.atr), supertrend: i1.supertrend },
      selected: { timeframe: selectedTimeframe, supertrend: selected.supertrend, rsi7: n(selected.rsi), close: n(selectedClose.close) },
    },
    riskNotice: 'إشارة تحليلية مبنية على OHLC الفعلي المتاح وليست تنفيذاً أو ضماناً للربح. قد تختلف الأسعار عن وسيطك.',
  };
}

function scoreFor(direction, { i1, i5, i15, price, structure, selectedClose, selected }) {
  const buy = direction === 'BUY';
  const flags = {
    m15: buy ? i15.e50 > i15.e200 : i15.e50 < i15.e200,
    m5: buy ? i5.e50 > i5.e200 && i5.e9 > i5.e21 : i5.e50 < i5.e200 && i5.e9 < i5.e21,
    vwap: buy ? price > i5.vwap : price < i5.vwap,
    ema: buy ? selected.e9 > selected.e21 : selected.e9 < selected.e21,
    sweep: structure.sweep === direction,
    structure: structure.direction === direction,
    rsi: buy ? selected.rsi >= 50 : selected.rsi <= 50,
    adx: i15.adx >= 20,
    candle: candleStrength(selectedClose, selected.atr, direction) >= 0.45,
    atr: selected.atr > 0,
  };
  return Object.keys(WEIGHTS).reduce((sum, key) => sum + (flags[key] ? WEIGHTS[key] : 0), 0);
}

function indicators(bars) {
  const closes = bars.map((bar) => bar.close);
  const atr = atrSeries(bars);
  return { e9: ema(closes, 9), e21: ema(closes, 21), e50: ema(closes, 50), e200: ema(closes, 200), rsi: rsi(closes, 7), adx: adx(bars, 14), atr: atr.at(-1), vwap: vwap(bars), supertrend: supertrend(bars, atr) };
}
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
