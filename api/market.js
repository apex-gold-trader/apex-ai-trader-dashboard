const SYMBOLS = {
  XAUUSD: { twelveData: 'XAU/USD' },
  BTCUSD: { twelveData: 'BTC/USD', binance: 'BTCUSDT' },
  EURUSD: { twelveData: 'EUR/USD' },
  ETHUSD: { twelveData: 'ETH/USD', binance: 'ETHUSDT' },
  NAS100: { twelveData: 'NDX' },
};
const MINUTE_MS = 60_000;
const MAX_AGE_MS = 3 * MINUTE_MS;
const TIMEFRAME_MS = { '1m': MINUTE_MS, '5m': 5 * MINUTE_MS, '15m': 15 * MINUTE_MS };

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });
  const requested = String(req.query?.symbols || 'all').toUpperCase();
  const symbols = requested === 'ALL' ? Object.keys(SYMBOLS) : requested.split(',').map((item) => item.trim());
  if (!symbols.length || symbols.some((symbol) => !SYMBOLS[symbol])) return res.status(400).json({ success: false, error: 'Unsupported symbol.' });
  try {
    const entries = await Promise.all(symbols.map(async (symbol) => [symbol, await fetchMarket(symbol)]));
    return res.status(200).json({ success: true, timestamp: Date.now(), data: Object.fromEntries(entries) });
  } catch (error) {
    return res.status(503).json({ success: false, error: error?.message || 'Live market data unavailable; no substitute price was used.', data: {} });
  }
}

async function fetchMarket(symbol) {
  const key = String(process.env.TWELVE_DATA_API_KEY || '').trim();
  if (key) return fetchTwelveData(symbol, key);
  if (symbol === 'XAUUSD') return fetchXauSpot();
  if (SYMBOLS[symbol].binance) return fetchBinance(symbol);
  throw new Error(`${symbol} requires TWELVE_DATA_API_KEY for spot quotes and real OHLC candles. No synthetic or futures data is used.`);
}

async function fetchXauSpot() {
  const response = await fetch('https://xaus.com/api/v1/spot?compact=1', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000), cache: 'no-store' });
  if (!response.ok) throw new Error(`XAUS spot provider returned HTTP ${response.status}`);
  const data = await response.json();
  const price = Number(data.spot_usd_oz ?? data.xau?.price);
  const updatedAt = Date.parse(data.data_state?.as_of || data.updated_at || '');
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(updatedAt)) throw new Error('XAUS returned an invalid spot quote.');
  assertFresh(updatedAt, 'XAUUSD');
  if (data.data_state?.status !== 'fresh') throw new Error(`XAU/USD quote is ${data.data_state?.status || 'not confirmed fresh'}.`);
  return { symbol: 'XAUUSD', price, change: null, source: 'XAUS indicative XAU/USD spot', updatedAt, freshness: 'fresh', candles: null, candleInterval: null, tradableAnalysis: false, note: 'Spot quote only. This source does not supply the real multi-timeframe candles required for technical analysis.' };
}

async function fetchBinance(symbol) {
  const pair = SYMBOLS[symbol].binance;
  const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1m&limit=1000`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000), cache: 'no-store' });
  if (!response.ok) throw new Error(`Binance ${symbol} provider returned HTTP ${response.status}`);
  const rows = await response.json();
  const candles = rows.map((r) => ({ time: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]), closeTime: Number(r[6]) }))
    .filter((c) => validCandle(c) && c.closeTime < Date.now()).sort((a, b) => a.time - b.time);
  if (candles.length < 205) throw new Error(`Insufficient real Binance OHLC candles for ${symbol}.`);
  const last = candles.at(-1);
  assertFresh(last.closeTime, symbol);
  const clean = candles.map(({ closeTime, ...c }) => c);
  return { symbol, price: last.close, change: null, source: `Binance spot (${pair})`, updatedAt: last.closeTime, freshness: 'provider timestamp checked', candles: { '1m': clean, '5m': aggregate(clean, 5), '15m': aggregate(clean, 15) }, candleInterval: '1m', tradableAnalysis: true };
}

async function fetchTwelveData(symbol, key) {
  // Fetch actual 1m and 15m bars independently: aggregating 1m history cannot
  // provide the 200+ completed M15 bars required for EMA 200.
  const [minuteBars, fifteenMinuteBars] = await Promise.all([
    requestTimeSeries(symbol, key, '1min', 1500),
    requestTimeSeries(symbol, key, '15min', 240),
  ]);
  const minute = minuteBars.filter(validCandle).sort((a, b) => a.time - b.time);
  const quarterHour = fifteenMinuteBars.filter(validCandle).sort((a, b) => a.time - b.time);
  if (minute.length < 205 || quarterHour.length < 205) throw new Error(`Twelve Data returned insufficient real 1m/15m candles for ${symbol}; check symbol access, plan, and output limits.`);
  const last = minute.at(-1);
  const updatedAt = last.time + MINUTE_MS;
  assertFresh(updatedAt, symbol);
  const candles5 = aggregate(minute, 5);
  if (candles5.length < 60) throw new Error(`Twelve Data returned insufficient real M5 candles for ${symbol}.`);
  return {
    symbol, price: last.close, change: null, source: 'Twelve Data spot OHLC (plan-dependent)', updatedAt,
    freshness: 'provider timestamp checked', candles: { '1m': minute, '5m': candles5, '15m': quarterHour },
    candleInterval: '1m + provider 15m', tradableAnalysis: true,
  };
}

async function requestTimeSeries(symbol, key, interval, outputsize) {
  const params = new URLSearchParams({ symbol: SYMBOLS[symbol].twelveData, interval, outputsize: String(outputsize), apikey: key, order: 'ASC', timezone: 'UTC' });
  const response = await fetch(`https://api.twelvedata.com/time_series?${params}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000), cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || data.status === 'error' || !Array.isArray(data.values)) throw new Error(data.message || `Twelve Data cannot provide ${symbol} ${interval} spot candles.`);
  return data.values.map((r) => ({ time: Date.parse(`${String(r.datetime).replace(' ', 'T')}Z`), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) || 0 }));
}

function assertFresh(time, symbol) {
  if (!Number.isFinite(time) || Date.now() - time > MAX_AGE_MS || time > Date.now() + 30_000) throw new Error(`${symbol} quote is older than 3 minutes or has an invalid timestamp; refusing stale data.`);
}
function validCandle(c) { return Number.isFinite(c.time) && c.time > 0 && [c.open, c.high, c.low, c.close].every((n) => Number.isFinite(n) && n > 0) && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close); }
function aggregate(candles, minutes) {
  const size = TIMEFRAME_MS[`${minutes}m`], map = new Map();
  for (const c of candles) { const t = Math.floor(c.time / size) * size, bar = map.get(t); if (!bar) map.set(t, { time: t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }); else { bar.high = Math.max(bar.high, c.high); bar.low = Math.min(bar.low, c.low); bar.close = c.close; bar.volume += c.volume; } }
  return [...map.values()].slice(-600);
}
