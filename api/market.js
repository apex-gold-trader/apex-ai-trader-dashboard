const SYMBOLS = {
  XAUUSD: { yahoo: 'GC=F', label: 'Gold futures (GC=F)' },
  BTCUSD: { yahoo: 'BTC-USD', label: 'Bitcoin' },
  EURUSD: { yahoo: 'EURUSD=X', label: 'EUR/USD' },
  ETHUSD: { yahoo: 'ETH-USD', label: 'Ethereum' },
  NAS100: { yahoo: '^NDX', label: 'Nasdaq 100' },
};
const INTERVAL_MS = { 1: 60_000, 5: 300_000, 15: 900_000 };

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });
  const requested = String(req.query?.symbols || 'all').toUpperCase();
  const symbols = requested === 'ALL' ? Object.keys(SYMBOLS) : requested.split(',').map((item) => item.trim());
  if (!symbols.length || symbols.some((symbol) => !SYMBOLS[symbol])) {
    return res.status(400).json({ success: false, error: 'Unsupported symbol. Use XAUUSD, BTCUSD, EURUSD, ETHUSD, or NAS100.' });
  }
  try {
    const entries = await Promise.all(symbols.map(async (symbol) => [symbol, await fetchMarket(symbol)]));
    return res.status(200).json({ success: true, source: 'Yahoo Finance chart (availability/delay varies)', timestamp: Date.now(), data: Object.fromEntries(entries) });
  } catch (error) {
    return res.status(502).json({ success: false, error: error?.message || 'Unable to load market candles', data: {} });
  }
}

async function fetchMarket(symbol) {
  const now = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(SYMBOLS[symbol].yahoo)}?period1=${now - 5 * 86400}&period2=${now}&interval=1m&events=history`;
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${symbol} price provider returned HTTP ${response.status}`);
  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  if (!result) throw new Error(payload?.chart?.error?.description || `No recent candles for ${symbol}`);
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const candles = timestamps.map((time, index) => ({
    time: time * 1000,
    open: Number(quote.open?.[index]), high: Number(quote.high?.[index]), low: Number(quote.low?.[index]),
    close: Number(quote.close?.[index]), volume: Number(quote.volume?.[index] || 0),
  })).filter(validCandle).sort((a, b) => a.time - b.time);
  if (candles.length < 50) throw new Error(`Not enough recent 1-minute candles for ${symbol}`);
  const price = candles.at(-1).close;
  const prior = candles[Math.max(0, candles.length - 390)]?.close || candles[0].open;
  return {
    symbol, price, change: prior ? Number(((price - prior) / prior * 100).toFixed(3)) : 0,
    source: SYMBOLS[symbol].label, updatedAt: candles.at(-1).time,
    candles: { '1m': candles.slice(-1500), '5m': aggregate(candles, 5), '15m': aggregate(candles, 15) },
  };
}

function validCandle(c) {
  return Number.isFinite(c.time) && c.time > 0 && [c.open, c.high, c.low, c.close].every((n) => Number.isFinite(n) && n > 0) && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close);
}

function aggregate(candles, minutes) {
  const bucketMs = INTERVAL_MS[minutes];
  const buckets = new Map();
  for (const candle of candles) {
    const bucket = Math.floor(candle.time / bucketMs) * bucketMs;
    const bar = buckets.get(bucket);
    if (!bar) buckets.set(bucket, { time: bucket, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume });
    else { bar.high = Math.max(bar.high, candle.high); bar.low = Math.min(bar.low, candle.low); bar.close = candle.close; bar.volume += candle.volume; }
  }
  return [...buckets.values()].slice(-600);
}
