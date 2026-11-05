const SYMBOLS = {
  XAUUSD: { twelveData: 'XAU/USD' },
  BTCUSD: { twelveData: 'BTC/USD', binance: 'BTCUSDT' },
  EURUSD: { twelveData: 'EUR/USD' },
  ETHUSD: { twelveData: 'ETH/USD', binance: 'ETHUSDT' },
  NAS100: { twelveData: 'NDX' },
};
const INTERVAL = { '1m': 60_000, '5m': 300_000, '15m': 900_000 };
const MAX_AGE_MS = 3 * 60_000;

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
  // Twelve Data supports synchronized spot OHLC for all configured assets, but requires
  // the operator's key and the relevant market-data entitlement. Never claim zero delay.
  const key = String(process.env.TWELVE_DATA_API_KEY || '').trim();
  if (key) return fetchTwelveData(symbol, key);
  if (symbol === 'XAUUSD') return fetchXauSpot();
  if (SYMBOLS[symbol].binance) return fetchBinance(symbol);
  throw new Error(`${symbol} requires TWELVE_DATA_API_KEY for supported spot data. No delayed or futures proxy is substituted.`);
}

async function fetchXauSpot() {
  const response = await fetch('https://xaus.com/api/v1/spot?compact=1', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000), cache: 'no-store' });
  if (!response.ok) throw new Error(`XAUS spot provider returned HTTP ${response.status}`);
  const data = await response.json();
  const price = Number(data.spot_usd_oz ?? data.xau?.price);
  const updatedAt = Date.parse(data.data_state?.as_of || data.updated_at || '');
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(updatedAt)) throw new Error('XAUS returned an invalid spot quote; refusing fallback prices.');
  if (data.data_state?.status !== 'fresh' || Date.now() - updatedAt > MAX_AGE_MS) throw new Error(`XAU/USD spot quote is stale or unavailable (${data.data_state?.status || 'unknown'}); no trade data served.`);
  return { symbol: 'XAUUSD', price, change: null, source: 'XAUS indicative XAU/USD spot', updatedAt, freshness: 'fresh', candles: null, candleInterval: null, tradableAnalysis: false, note: 'Spot quote only. This free source does not provide 1-minute candles; configure Twelve Data for candle-based analysis.' };
}

async function fetchBinance(symbol) {
  const pair = SYMBOLS[symbol].binance;
  const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1m&limit=1000`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000), cache: 'no-store' });
  if (!response.ok) throw new Error(`Binance ${symbol} provider returned HTTP ${response.status}`);
  const rows = await response.json();
  const candles = rows.map((r) => ({ time: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]), closeTime: Number(r[6]) })).filter((c) => validCandle(c) && c.closeTime < Date.now());
  if (candles.length < 205) throw new Error(`Insufficient fresh Binance candles for ${symbol}.`);
  const last = candles.at(-1), updatedAt = last.closeTime;
  assertFresh(updatedAt, symbol);
  return { symbol, price: last.close, change: null, source: `Binance spot (${pair})`, updatedAt, freshness: 'fresh', candles: { '1m': candles.map(({ closeTime, ...c }) => c), '5m': aggregate(candles, 5), '15m': aggregate(candles, 15) }, candleInterval: '1m', tradableAnalysis: true };
}

async function fetchTwelveData(symbol, key) {
  const params = new URLSearchParams({ symbol: SYMBOLS[symbol].twelveData, interval: '1min', outputsize: '1500', apikey: key, order: 'ASC' });
  const response = await fetch(`https://api.twelvedata.com/time_series?${params}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000), cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || data.status === 'error' || !Array.isArray(data.values)) throw new Error(data.message || `Twelve Data cannot provide ${symbol} 1-minute spot candles.`);
  const candles = data.values.map((r) => ({ time: Date.parse(`${r.datetime.replace(' ', 'T')}Z`), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) || 0 })).filter(validCandle).sort((a, b) => a.time - b.time);
  if (candles.length < 205) throw new Error(`Insufficient Twelve Data 1-minute candles for ${symbol}.`);
  const last = candles.at(-1), updatedAt = last.time + INTERVAL['1m'];
  assertFresh(updatedAt, symbol);
  return { symbol, price: last.close, change: null, source: 'Twelve Data spot OHLC (plan-dependent freshness)', updatedAt, freshness: 'provider timestamp checked', candles: { '1m': candles, '5m': aggregate(candles, 5), '15m': aggregate(candles, 15) }, candleInterval: '1m', tradableAnalysis: true };
}

function assertFresh(time, symbol) { if (!Number.isFinite(time) || Date.now() - time > MAX_AGE_MS || time > Date.now() + 30_000) throw new Error(`${symbol} quote is older than 3 minutes or has an invalid timestamp; refusing stale data.`); }
function validCandle(c) { return Number.isFinite(c.time) && c.time > 0 && [c.open, c.high, c.low, c.close].every((n) => Number.isFinite(n) && n > 0) && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close); }
function aggregate(candles, minutes) {
  const size = INTERVAL[`${minutes}m`], map = new Map();
  for (const c of candles) { const t = Math.floor(c.time / size) * size, bar = map.get(t); if (!bar) map.set(t, { time: t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }); else { bar.high = Math.max(bar.high, c.high); bar.low = Math.min(bar.low, c.low); bar.close = c.close; bar.volume += c.volume; } }
  return [...map.values()].slice(-600);
}
