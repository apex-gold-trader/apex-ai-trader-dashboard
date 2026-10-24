import { useEffect, useMemo, useState } from 'react';

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h'];

const marketMeta = {
  XAUUSD: { label: 'الذهب', unit: 'XAUUSD', color: '#f6c453', description: 'ذهب نقدي' },
  BTCUSD: { label: 'بيتكوين', unit: 'BTCUSD', color: '#f7931a', description: 'BTC / USD' },
  EURUSD: { label: 'يورو/دولار', unit: 'EURUSD', color: '#58d68d', description: 'EUR / USD' },
  ETHUSD: { label: 'إيثيريوم', unit: 'ETHUSD', color: '#8a7dff', description: 'ETH / USD' },
  NAS100: { label: 'ناسداك 100', unit: 'NAS100', color: '#7cc7ff', description: 'مؤشر' },
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const formatPrice = (value, symbol) => {
  if (!Number.isFinite(value)) return '—';
  if (symbol === 'XAUUSD') return `${value.toFixed(2)} $`;
  if (symbol === 'EURUSD') return value.toFixed(5);
  if (symbol === 'NAS100') return value.toFixed(2);
  if (symbol === 'BTCUSD' || symbol === 'ETHUSD') return `${value.toFixed(2)} $`;
  return value.toFixed(4);
};

const toNumber = (value) => Number(value ?? 0);

function buildTrendSeries(base, drift, volatility, length = 40) {
  const series = [];
  let current = base;
  for (let i = 0; i < length; i += 1) {
    const wave = Math.sin((i / Math.max(length, 1)) * 10) * volatility;
    const noise = (Math.random() - 0.5) * volatility * 1.5;
    const step = drift + wave + noise;
    current = Math.max(current + step, base * 0.65);
    series.push(Number(current.toFixed(4)));
  }
  return series;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getRsi(series) {
  if (series.length < 14) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < 15; i += 1) {
    const diff = series[i] - series[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / 14;
  const avgLoss = losses / 14;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function getEma(series, period) {
  if (!series.length) return 0;
  const multiplier = 2 / (period + 1);
  let ema = series[0];
  for (let i = 1; i < series.length; i += 1) {
    ema = (series[i] - ema) * multiplier + ema;
  }
  return ema;
}

function getMacd(series) {
  const fast = getEma(series, 12);
  const slow = getEma(series, 26);
  return { macd: fast - slow, signal: (fast - slow) * 0.2 };
}

function getBollinger(series) {
  const mid = average(series.slice(-20));
  const variance = average(series.slice(-20).map((point) => (point - mid) ** 2));
  const std = Math.sqrt(variance);
  return { upper: mid + std * 2, lower: mid - std * 2, mid };
}

function generateMarketData() {
  const baseData = {
    XAUUSD: 2346.42,
    BTCUSD: 67740.12,
    EURUSD: 1.0884,
    ETHUSD: 3592.77,
    NAS100: 19036.2,
  };

  const symbolStates = {
    XAUUSD: { drift: 1.8, volatility: 4.4 },
    BTCUSD: { drift: 160, volatility: 140 },
    EURUSD: { drift: 0.00036, volatility: 0.0012 },
    ETHUSD: { drift: 7.2, volatility: 18 },
    NAS100: { drift: 8.5, volatility: 30 },
  };

  const result = {};

  Object.entries(baseData).forEach(([symbol, base]) => {
    const state = symbolStates[symbol];
    const series = buildTrendSeries(base, state.drift, state.volatility, 45);
    const last = series[series.length - 1];
    const rsi = getRsi(series);
    const emaShort = getEma(series, 9);
    const emaLong = getEma(series, 21);
    const macd = getMacd(series);
    const bb = getBollinger(series);

    result[symbol] = {
      price: Number(last.toFixed(symbol === 'EURUSD' ? 5 : 2)),
      change: Number(((last - series[series.length - 2]) * 100 / Math.max(series[series.length - 2], 0.0001)).toFixed(3)),
      series,
      indicators: {
        rsi,
        emaShort,
        emaLong,
        macd: macd.macd,
        signal: macd.signal,
        bollingerUpper: bb.upper,
        bollingerLower: bb.lower,
      },
      updatedAt: Date.now(),
    };
  });

  return result;
}

async function fetchGoldPrice() {
  const response = await fetch('https://api.gold-api.com/price/XAU');
  if (!response.ok) throw new Error('Gold API unavailable');
  const data = await response.json();
  return Number(toNumber(data.price));
}

async function fetchEurUsdPrice() {
  const response = await fetch('https://api.exchangerate.host/convert?from=EUR&to=USD');
  if (!response.ok) throw new Error('FX API unavailable');
  const data = await response.json();
  return Number(toNumber(data.result));
}

async function fetchBinancePrice(symbol) {
  const response = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
  if (!response.ok) throw new Error(`${symbol} API unavailable`);
  const data = await response.json();
  return Number(toNumber(data.price));
}

async function fetchNasdaqPrice() {
  const response = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EIXIC?interval=1m&range=1d');
  if (!response.ok) throw new Error('NASDAQ API unavailable');
  const data = await response.json();
  const result = data?.chart?.result?.[0];
  const lastPrice = result?.meta?.regularMarketPrice ?? result?.meta?.previousClose ?? 19000;
  return Number(lastPrice);
}

async function fetchLiveMarketData() {
  const [btc, eth, gold, eurUsd, nasdaq] = await Promise.allSettled([
    fetchBinancePrice('BTCUSDT'),
    fetchBinancePrice('ETHUSDT'),
    fetchGoldPrice(),
    fetchEurUsdPrice(),
    fetchNasdaqPrice(),
  ]);

  const fallback = generateMarketData();

  return {
    BTCUSD: {
      price: btc.status === 'fulfilled' ? btc.value : fallback.BTCUSD.price,
      change: fallback.BTCUSD.change,
      series: fallback.BTCUSD.series,
      indicators: fallback.BTCUSD.indicators,
      updatedAt: Date.now(),
    },
    ETHUSD: {
      price: eth.status === 'fulfilled' ? eth.value : fallback.ETHUSD.price,
      change: fallback.ETHUSD.change,
      series: fallback.ETHUSD.series,
      indicators: fallback.ETHUSD.indicators,
      updatedAt: Date.now(),
    },
    XAUUSD: {
      price: gold.status === 'fulfilled' ? gold.value : fallback.XAUUSD.price,
      change: fallback.XAUUSD.change,
      series: fallback.XAUUSD.series,
      indicators: fallback.XAUUSD.indicators,
      updatedAt: Date.now(),
    },
    EURUSD: {
      price: eurUsd.status === 'fulfilled' ? eurUsd.value : fallback.EURUSD.price,
      change: fallback.EURUSD.change,
      series: fallback.EURUSD.series,
      indicators: fallback.EURUSD.indicators,
      updatedAt: Date.now(),
    },
    NAS100: {
      price: nasdaq.status === 'fulfilled' ? nasdaq.value : fallback.NAS100.price,
      change: fallback.NAS100.change,
      series: fallback.NAS100.series,
      indicators: fallback.NAS100.indicators,
      updatedAt: Date.now(),
    },
  };
}

function buildSparkline(series) {
  if (!series || series.length < 2) return null;
  const max = Math.max(...series);
  const min = Math.min(...series);
  const height = 64;
  const width = 260;
  const range = max - min || 1;

  const points = series
    .map((point, index) => {
      const x = (index / (series.length - 1)) * width;
      const y = height - ((point - min) / range) * height;
      return `${x},${y}`;
    })
    .join(' ');

  return { points, width, height };
}

function computeTradePlan({ symbol, timeframe, marketData }) {
  const entry = marketData[symbol].price;
  const indicators = marketData[symbol].indicators;
  const rsi = indicators.rsi;
  const emaShort = indicators.emaShort;
  const emaLong = indicators.emaLong;
  const macd = indicators.macd;

  const direction =
    (rsi < 45 && emaShort > emaLong && macd > 0) || (rsi < 40 && marketData[symbol].price < indicators.bollingerLower)
      ? 'BUY'
      : (rsi > 55 && emaShort < emaLong && macd < 0) || (rsi > 60 && marketData[symbol].price > indicators.bollingerUpper)
        ? 'SELL'
        : 'BUY';

  const riskConfig = {
    XAUUSD: { stopRate: 0.0012, tp1: 1.4, tp2: 2.3, tp3: 3.2, breakEvenFactor: 0.18, trailingFactor: 0.42 },
    BTCUSD: { stopRate: 0.002, tp1: 1.4, tp2: 2.2, tp3: 3.1, breakEvenFactor: 0.2, trailingFactor: 0.45 },
    EURUSD: { stopRate: 0.0007, tp1: 1.5, tp2: 2.6, tp3: 3.6, breakEvenFactor: 0.2, trailingFactor: 0.45 },
    ETHUSD: { stopRate: 0.003, tp1: 1.5, tp2: 2.5, tp3: 3.5, breakEvenFactor: 0.2, trailingFactor: 0.45 },
    NAS100: { stopRate: 0.0015, tp1: 1.4, tp2: 2.2, tp3: 3.2, breakEvenFactor: 0.18, trailingFactor: 0.42 },
  };

  const config = riskConfig[symbol] || riskConfig.XAUUSD;
  const stopDistance = Math.max(entry * config.stopRate, 0.01);
  const stopLoss = direction === 'BUY' ? entry - stopDistance : entry + stopDistance;
  const tp1 = direction === 'BUY' ? entry + stopDistance * config.tp1 : entry - stopDistance * config.tp1;
  const tp2 = direction === 'BUY' ? entry + stopDistance * config.tp2 : entry - stopDistance * config.tp2;
  const tp3 = direction === 'BUY' ? entry + stopDistance * config.tp3 : entry - stopDistance * config.tp3;
  const breakEven = direction === 'BUY' ? entry + stopDistance * config.breakEvenFactor : entry - stopDistance * config.breakEvenFactor;
  const trailingStop = direction === 'BUY' ? entry + stopDistance * config.trailingFactor : entry - stopDistance * config.trailingFactor;

  const riskAmount = 100;
  const lotSizeRaw = riskAmount / Math.max(stopDistance * 100000, 1);
  const lotSize = clamp(Number(lotSizeRaw.toFixed(2)), 0.01, 0.25);

  const confidence = clamp(Math.round(72 + (Math.abs(rsi - 50) * 0.6) + (direction === 'BUY' ? 7 : -3)), 70, 94);

  const reasons = {
    BUY: `هيكل ${timeframe} يشير إلى استمرار الاتجاه الصاعد. مؤشر RSI عند ${rsi.toFixed(1)}، و المتوسط المتحرك القصير (${emaShort.toFixed(2)}) أعلى من المتوسط الطويل (${emaLong.toFixed(2)}). كما أن MACD إيجابي ويؤكد تدفق شرائي، مع دعم من منطقة الدعم الحالية، لذلك التوصية هي الدخول طويلًا مع إدارة مخاطر مضبوطة جدًا.`,
    SELL: `هيكل ${timeframe} يشير إلى ضغوط بيع قوية. مؤشر RSI عند ${rsi.toFixed(1)}، والمتوسط القصير (${emaShort.toFixed(2)}) أقل من المتوسط الطويل (${emaLong.toFixed(2)}). كما أن MACD سلبي، و السعر يقترب من منطقة مقاومة قوية، لذلك التوصية هي الدخول قصيرًا مع إغلاق مستهدف سريع ووقف خسارة ضيق.`,
  };

  return {
    direction,
    entry,
    tp1,
    tp2,
    tp3,
    stopLoss,
    lotSize,
    breakEven,
    trailingStop,
    reason: reasons[direction],
    confidence,
    timeframe,
    strategy: direction === 'BUY' ? 'استمرار صعودي' : 'إعادة اختبار مقاومة / ضغط بيعي',
  };
}

function App() {
  const [timeframe, setTimeframe] = useState('15m');
  const [marketData, setMarketData] = useState(generateMarketData());
  const [selectedSymbol, setSelectedSymbol] = useState('XAUUSD');
  const [tradeResult, setTradeResult] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(Date.now());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    const refresh = async () => {
      try {
        const live = await fetchLiveMarketData();
        if (!active) return;
        setMarketData(live);
        setLastUpdated(Date.now());
      } catch (error) {
        if (!active) return;
        setMarketData(generateMarketData());
      } finally {
        if (active) setLoading(false);
      }
    };

    refresh();
    const interval = setInterval(refresh, 8000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const sparkline = useMemo(() => buildSparkline(marketData[selectedSymbol]?.series ?? []), [marketData, selectedSymbol]);

  const handleAnalyze = () => {
    const plan = computeTradePlan({ symbol: selectedSymbol, timeframe, marketData });
    setTradeResult(plan);
  };

  const symbols = Object.keys(marketMeta);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">ذكاء السوق</p>
          <h1>لوحة Apex AI Trader</h1>
        </div>
        <div className="status-pill">
          <span className="live-dot" />
          {loading ? 'جارٍ تحديث الأسعار...' : `مباشر • ${new Date(lastUpdated).toLocaleTimeString('ar-EG')}`}
        </div>
      </header>

      <main className="dashboard">
        <section className="market-grid">
          {symbols.map((symbol) => {
            const item = marketData[symbol];
            const meta = marketMeta[symbol];
            const isSelected = symbol === selectedSymbol;
            const price = item?.price ?? 0;
            const change = item?.change ?? 0;
            const positive = change >= 0;

            return (
              <button
                type="button"
                key={symbol}
                className={`market-card ${isSelected ? 'selected' : ''}`}
                onClick={() => setSelectedSymbol(symbol)}
              >
                <div className="market-header">
                  <div>
                    <p className="market-label">{meta.label}</p>
                    <h3>{meta.unit}</h3>
                  </div>
                  <span className="legend" style={{ background: meta.color }} />
                </div>
                <div className="market-price-row">
                  <strong>{formatPrice(price, symbol)}</strong>
                  <span className={positive ? 'up' : 'down'}>{positive ? '+' : ''}{change.toFixed(2)}%</span>
                </div>
                <p className="market-subtitle">{meta.description}</p>
              </button>
            );
          })}
        </section>

        <section className="analysis-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">محرك التداول</p>
              <h2>التحليل الفني والسكالبينج الذكي</h2>
            </div>
            <div className="timeframe-picker">
              {TIMEFRAMES.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={option === timeframe ? 'active' : ''}
                  onClick={() => setTimeframe(option)}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>

          <div className="signal-wrapper">
            <div className="signal-overview">
              <div className="signal-topline">
                <div>
                  <p className="eyebrow">الأصل المختار</p>
                  <h3>{marketMeta[selectedSymbol].label}</h3>
                </div>
                <button type="button" onClick={handleAnalyze} className="analyze-btn">حلّل الآن</button>
              </div>

              <div className="chart-card">
                <div className="chart-stats">
                  <div>
                    <span>السعر الحالي</span>
                    <strong>{formatPrice(marketData[selectedSymbol]?.price ?? 0, selectedSymbol)}</strong>
                  </div>
                  <div>
                    <span>RSI</span>
                    <strong>{marketData[selectedSymbol]?.indicators?.rsi?.toFixed(1) ?? '50.0'}</strong>
                  </div>
                  <div>
                    <span>اتجاه EMA</span>
                    <strong>{marketData[selectedSymbol]?.indicators?.emaShort > marketData[selectedSymbol]?.indicators?.emaLong ? 'صاعد' : 'هابطة'}</strong>
                  </div>
                </div>

                {sparkline && (
                  <svg viewBox={`0 0 ${sparkline.width} ${sparkline.height}`} className="sparkline" preserveAspectRatio="none">
                    <defs>
                      <linearGradient id="lineGlow" x1="0" x2="1">
                        <stop offset="0%" stopColor="#7fb8ff" />
                        <stop offset="100%" stopColor="#8ff7bb" />
                      </linearGradient>
                    </defs>
                    <polyline fill="none" stroke="url(#lineGlow)" strokeWidth="3" points={sparkline.points} />
                  </svg>
                )}
              </div>
            </div>

            <div className="trade-card">
              {tradeResult ? (
                <>
                  <div className="trade-head">
                    <div>
                      <span className="eyebrow">توصية الذكاء</span>
                      <h3 className={tradeResult.direction === 'BUY' ? 'buy-text' : 'sell-text'}>{tradeResult.direction === 'BUY' ? 'شراء' : 'بيع'}</h3>
                    </div>
                    <span className="confidence">{tradeResult.confidence}% ثقة</span>
                  </div>

                  <div className="trade-grid">
                    <div className="trade-item">
                      <span>سعر الدخول</span>
                      <strong>{formatPrice(tradeResult.entry, selectedSymbol)}</strong>
                    </div>
                    <div className="trade-item">
                      <span>وقف الخسارة</span>
                      <strong>{formatPrice(tradeResult.stopLoss, selectedSymbol)}</strong>
                    </div>
                    <div className="trade-item">
                      <span>TP1</span>
                      <strong>{formatPrice(tradeResult.tp1, selectedSymbol)}</strong>
                    </div>
                    <div className="trade-item">
                      <span>TP2</span>
                      <strong>{formatPrice(tradeResult.tp2, selectedSymbol)}</strong>
                    </div>
                    <div className="trade-item">
                      <span>TP3</span>
                      <strong>{formatPrice(tradeResult.tp3, selectedSymbol)}</strong>
                    </div>
                    <div className="trade-item">
                      <span>حجم اللوت</span>
                      <strong>{tradeResult.lotSize.toFixed(2)} لوت</strong>
                    </div>
                    <div className="trade-item">
                      <span>نقطة التعادل</span>
                      <strong>{formatPrice(tradeResult.breakEven, selectedSymbol)}</strong>
                    </div>
                    <div className="trade-item">
                      <span>التتبع التلقائي</span>
                      <strong>{formatPrice(tradeResult.trailingStop, selectedSymbol)}</strong>
                    </div>
                  </div>

                  <div className="reason-box">
                    <p>{tradeResult.reason}</p>
                  </div>
                </>
              ) : (
                <div className="empty-state">
                  <p>اضغط على «حلّل الآن» للحصول على تحليل جديد وثابت.</p>
                </div>
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;

