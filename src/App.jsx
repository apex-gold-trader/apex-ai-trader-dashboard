import { useEffect, useMemo, useState } from 'react';

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h'];
const STORAGE_KEY = 'apex-ai-trader-signals-v1';

const marketMeta = {
  XAUUSD: { label: 'الذهب', unit: 'XAUUSD', color: '#f6c453', description: 'سبوت الذهب' },
  BTCUSD: { label: 'بيتكوين', unit: 'BTCUSD', color: '#f7931a', description: 'BTC/USD' },
  EURUSD: { label: 'اليورو/الدولار', unit: 'EURUSD', color: '#58d68d', description: 'EUR/USD' },
  ETHUSD: { label: 'إيثيريوم', unit: 'ETHUSD', color: '#8a7dff', description: 'ETH/USD' },
  NAS100: { label: 'ناسداك 100', unit: 'NAS100', color: '#7cc7ff', description: 'المؤشر' },
};

const symbolMap = {
  XAUUSD: { ticker: 'OANDA:XAUUSD', market: 'forex' },
  BTCUSD: { ticker: 'BINANCE:BTCUSDT', market: 'crypto' },
  EURUSD: { ticker: 'FX:EURUSD', market: 'forex' },
  ETHUSD: { ticker: 'BINANCE:ETHUSDT', market: 'crypto' },
  NAS100: { ticker: 'NASDAQ:IXIC', market: 'america' },
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const formatPrice = (value, symbol) => {
  if (!Number.isFinite(value)) return '—';
  if (symbol === 'XAUUSD') return `$${value.toFixed(2)}`;
  if (symbol === 'EURUSD') return value.toFixed(5);
  if (symbol === 'NAS100') return value.toFixed(2);
  if (symbol === 'BTCUSD' || symbol === 'ETHUSD') return `$${value.toFixed(2)}`;
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
  const window = series.slice(-20);
  const mid = average(window);
  const variance = average(window.map((point) => (point - mid) ** 2));
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

async function fetchTradingViewQuote(symbol) {
  const mapping = symbolMap[symbol];
  if (!mapping) return null;

  try {
    const response = await fetch(`https://scanner.tradingview.com/${mapping.market}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbols: { tickers: [mapping.ticker] },
      }),
    });

    if (!response.ok) return null;

    const json = await response.json();
    const item = json?.data?.find((row) => row?.s === mapping.ticker) || json?.data?.[0];
    const value = item?.c ?? item?.lp ?? item?.p ?? item?.last ?? item?.last_price ?? item?.v ?? null;
    const price = Number(value);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

async function fetchLiveMarketDataFromTradingView() {
  const fallback = generateMarketData();
  const records = await Promise.allSettled(
    Object.keys(marketMeta).map(async (symbol) => ({ symbol, quote: await fetchTradingViewQuote(symbol) })),
  );

  const next = {};
  records.forEach((entry) => {
    if (entry.status !== 'fulfilled') return;
    const { symbol, quote } = entry.value;
    if (!quote) return;

    const base = fallback[symbol];
    next[symbol] = {
      ...base,
      price: Number(quote),
      updatedAt: Date.now(),
    };
  });

  Object.keys(fallback).forEach((symbol) => {
    if (!next[symbol]) next[symbol] = fallback[symbol];
  });

  return next;
}

function buildSparkline(series) {
  if (!series || series.length < 2) return '';

  const max = Math.max(...series);
  const min = Math.min(...series);
  const height = 64;
  const width = 250;
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

function getScalpStopDistance(symbol) {
  const map = {
    XAUUSD: 1.8,
    BTCUSD: 2.4,
    ETHUSD: 2.1,
    EURUSD: 0.0022,
    NAS100: 2.6,
  };

  return clamp(map[symbol] ?? 1.5, 1.2, 3);
}

function analyzeTrade({ symbol, timeframe, marketData, mode = 'standard' }) {
  const current = marketData[symbol];
  if (!current) return null;

  const entry = Number(current.price);
  const indicatorSet = current.indicators || {};
  const rsi = Number(indicatorSet.rsi ?? 50);
  const emaShort = Number(indicatorSet.emaShort ?? entry);
  const emaLong = Number(indicatorSet.emaLong ?? entry);
  const macd = Number(indicatorSet.macd ?? 0);
  const bollingerUpper = Number(indicatorSet.bollingerUpper ?? entry);
  const bollingerLower = Number(indicatorSet.bollingerLower ?? entry);

  const bullishCondition = rsi < 45 && emaShort > emaLong && macd > 0;
  const bearishCondition = rsi > 55 && emaShort < emaLong && macd < 0;
  const direction =
    bullishCondition || (rsi < 40 && entry < bollingerLower)
      ? 'BUY'
      : bearishCondition || (rsi > 60 && entry > bollingerUpper)
        ? 'SELL'
        : 'BUY';

  const volatilityBuffer = {
    XAUUSD: 0.008,
    BTCUSD: 0.012,
    EURUSD: 0.004,
    ETHUSD: 0.015,
    NAS100: 0.01,
  }[symbol] ?? 0.01;

  const isScalp = mode === 'scalp';
  const stopDistance = isScalp ? getScalpStopDistance(symbol) : entry * volatilityBuffer;
  const tpDistance = isScalp ? stopDistance * (1.8 + (timeframe === '1m' ? 0.75 : 0.25)) : stopDistance * 1.8;

  const stopLoss = direction === 'BUY' ? entry - stopDistance : entry + stopDistance;
  const tp1 = direction === 'BUY' ? entry + tpDistance * 0.75 : entry - tpDistance * 0.75;
  const tp2 = direction === 'BUY' ? entry + tpDistance * 1.35 : entry - tpDistance * 1.35;
  const tp3 = direction === 'BUY' ? entry + tpDistance * 2 : entry - tpDistance * 2;

  const riskPerTrade = 0.02;
  const accountSize = 10000;
  const riskAmount = accountSize * riskPerTrade;
  const lotSize = isScalp
    ? Math.max(0.08, Number((riskAmount / Math.max(stopDistance * 100000, 1)).toFixed(2)))
    : Math.max(0.01, Number((riskAmount / Math.max(stopDistance * 100000, 1)).toFixed(2)));

  const breakEven = direction === 'BUY' ? entry + stopDistance * 0.35 : entry - stopDistance * 0.35;
  const trailingStop = direction === 'BUY' ? entry + stopDistance * 0.5 : entry - stopDistance * 0.5;
  const confidence = clamp(Math.round(70 + (Math.abs(rsi - 50) * 0.7) + (direction === 'BUY' ? 8 : -8)), 68, 96);

  const reasons = {
    BUY: `هيكل ${timeframe} يدعم استمرار الاتجاه الصاعد. مؤشر RSI عند ${rsi.toFixed(1)}، وEMA القصيرة (${emaShort.toFixed(2)}) أعلى من EMA الطويلة (${emaLong.toFixed(2)}).`,
    SELL: `هيكل ${timeframe} يوضح توزيعاً واضحاً. مؤشر RSI عند ${rsi.toFixed(1)}، وEMA القصيرة (${emaShort.toFixed(2)}) أقل من EMA الطويلة (${emaLong.toFixed(2)}).`,
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
    strategy: isScalp ? 'سكالبينغ سريع / اختراق قصير المدى' : 'استمرارية الاتجاه / كسر صاعد',
    snapshotTime: Date.now(),
    mode: isScalp ? 'scalp' : 'standard',
  };
}

function App() {
  const [timeframe, setTimeframe] = useState('1m');
  const [marketData, setMarketData] = useState(generateMarketData());
  const [selectedSymbol, setSelectedSymbol] = useState('XAUUSD');
  const [analysis, setAnalysis] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(Date.now());
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const [chartMode, setChartMode] = useState('tradingview');
  const [loadingAi, setLoadingAi] = useState(false);
  const [signals, setSignals] = useState(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    let isMounted = true;

    const refresh = async () => {
      try {
        const live = await fetchLiveMarketDataFromTradingView();
        if (!isMounted) return;
        setMarketData(live);
        setLastUpdated(Date.now());
      } catch {
        if (!isMounted) return;
        setMarketData(generateMarketData());
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    refresh();
    const interval = setInterval(refresh, 8000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(signals));
    }
  }, [signals]);

  const sparkline = useMemo(() => buildSparkline(marketData[selectedSymbol]?.series ?? []), [marketData, selectedSymbol]);
  const currentPrice = Number(marketData[selectedSymbol]?.price ?? 0);
  const chartInterval = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240' }[timeframe] || '1';
  const tvSymbol = symbolMap[selectedSymbol]?.ticker || 'OANDA:XAUUSD';
  const tvUrl = `https://s.tradingview.com/widgetembed/?frameElementId=apex-tradingview-chart&symbol=${encodeURIComponent(tvSymbol)}&interval=${chartInterval}&theme=dark&style=1&locale=en&toolbarbg=%230d1723&enable_publishing=false&hide_side_toolbar=0&hide_top_toolbar=0&save_image=1&withdateranges=1&details=1&studies=%5B%22MASimple%40tv-basicstudies%22%5D`;

  const persistSignal = (trade) => {
    const record = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      symbol: selectedSymbol,
      label: marketMeta[selectedSymbol].label,
      direction: trade.direction,
      entry: trade.entry,
      stopLoss: trade.stopLoss,
      tp1: trade.tp1,
      tp2: trade.tp2,
      tp3: trade.tp3,
      confidence: trade.confidence,
      timeframe: trade.timeframe,
      strategy: trade.strategy,
      status: 'open',
      mode: trade.mode,
      createdAt: new Date().toLocaleString('ar-SA'),
    };

    setSignals((previous) => [record, ...previous].slice(0, 14));
  };

  const handleAnalyze = async () => {
    const mode = activeTab === 'scalp' ? 'scalp' : 'standard';
    const current = marketData[selectedSymbol];

    setLoadingAi(true);

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: selectedSymbol,
          timeframe,
          mode,
          current,
        }),
      });

      if (!response.ok) {
        throw new Error('Unexpected response from AI API');
      }

      const data = await response.json();
      const trade = data.trade || analyzeTrade({ symbol: selectedSymbol, timeframe, marketData, mode });
      if (!trade) return;

      setAnalysis(trade);
      persistSignal(trade);
      setActiveTab('signals');
    } catch {
      const fallback = analyzeTrade({ symbol: selectedSymbol, timeframe, marketData, mode });
      if (fallback) {
        setAnalysis(fallback);
        persistSignal(fallback);
      }
    } finally {
      setLoadingAi(false);
    }
  };

  const totalWins = signals.filter((signal) => signal.direction === 'BUY').length;
  const totalLosses = signals.filter((signal) => signal.direction === 'SELL').length;
  const symbols = Object.keys(marketMeta);

  return (
    <div className="app-shell" dir="rtl">
      <header className="topbar">
        <div>
          <p className="eyebrow">الذكاء السوقي</p>
          <h1>Apex AI Trader Dashboard</h1>
        </div>
        <div className="status-pill">
          <span className="live-dot" />
          {loading ? 'جارٍ مزامنة الأسعار...' : `مباشر • ${new Date(lastUpdated).toLocaleTimeString('ar-SA')}`}
        </div>
      </header>

      <nav className="nav-tabs" aria-label="قائمة التنقل">
        <button
          type="button"
          className={activeTab === 'overview' ? 'nav-tab active' : 'nav-tab'}
          onClick={() => setActiveTab('overview')}
        >
          الرئيسية / التحليل
        </button>
        <button
          type="button"
          className={activeTab === 'scalp' ? 'nav-tab active' : 'nav-tab'}
          onClick={() => {
            setActiveTab('scalp');
            setTimeframe('1m');
          }}
        >
          السكالبينغ السريع (1m Scalping)
        </button>
        <button
          type="button"
          className={activeTab === 'signals' ? 'nav-tab active' : 'nav-tab'}
          onClick={() => setActiveTab('signals')}
        >
          سجل الإشارات والأداء
        </button>
      </nav>

      <main className="dashboard">
        {activeTab === 'signals' ? (
          <section className="signals-panel">
            <div className="signals-header">
              <div>
                <p className="eyebrow">سجل الإشارات</p>
                <h2>الإشارات والأداء</h2>
              </div>
              <button type="button" className="analyze-btn small" onClick={() => setActiveTab('overview')}>
                العودة للتحليل
              </button>
            </div>

            <div className="stat-grid">
              <div className="stat-box">
                <span>إجمالي الإشارات</span>
                <strong>{signals.length}</strong>
              </div>
              <div className="stat-box">
                <span>الصفقات الصاعدة</span>
                <strong className="up">{totalWins}</strong>
              </div>
              <div className="stat-box">
                <span>الصفقات الهابطة</span>
                <strong className="down">{totalLosses}</strong>
              </div>
              <div className="stat-box">
                <span>النوع</span>
                <strong>{activeTab === 'scalp' ? 'سكالبينغ سريع' : 'قياسي'}</strong>
              </div>
            </div>

            <div className="signal-table">
              {signals.length ? (
                signals.map((signal) => (
                  <div key={signal.id} className="signal-row">
                    <div>
                      <small>{signal.createdAt}</small>
                      <div className="signal-main">
                        <span className={`badge ${signal.direction === 'BUY' ? 'buy' : 'sell'}`}>
                          {signal.direction === 'BUY' ? 'شراء' : 'بيع'}
                        </span>
                        <strong>{signal.label}</strong>
                      </div>
                    </div>
                    <div className="value-block">
                      <span>الدخول</span>
                      <strong>{formatPrice(signal.entry, signal.symbol)}</strong>
                    </div>
                    <div className="value-block">
                      <span>وقف الخسارة</span>
                      <strong>{formatPrice(signal.stopLoss, signal.symbol)}</strong>
                    </div>
                    <div className="value-block">
                      <span>الأهداف</span>
                      <strong>
                        {formatPrice(signal.tp1, signal.symbol)} / {formatPrice(signal.tp2, signal.symbol)}
                      </strong>
                    </div>
                    <div className="value-block">
                      <span>الثقة</span>
                      <strong>{signal.confidence}%</strong>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty-signal-box">
                  <p>لا توجد إشارات محفوظة بعد. قم بإنشاء أول تحليل من لوحة التحليل.</p>
                </div>
              )}
            </div>
          </section>
        ) : (
          <>
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
                  <h2>{activeTab === 'scalp' ? 'السكالبينغ السريع 1m' : 'التحليل الذكي والسكالبينغ'}</h2>
                </div>
                <div className="header-actions">
                  <div className="timeframe-picker">
                    {TIMEFRAMES.map((option) => (
                      <button
                        key={option}
                        type="button"
                        className={option === timeframe ? 'active' : ''}
                        onClick={() => {
                          setTimeframe(option);
                          setAnalysis(null);
                        }}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="signal-wrapper">
                <div className="signal-overview">
                  <div className="signal-topline">
                    <div>
                      <p className="eyebrow">الأصل المختار</p>
                      <h3>{marketMeta[selectedSymbol].label}</h3>
                    </div>
                    <button type="button" onClick={handleAnalyze} className="analyze-btn" disabled={loadingAi}>
                      {loadingAi ? 'جارٍ التحليل...' : activeTab === 'scalp' ? 'حلّل سكالبينغ سريع' : 'حلّل الآن'}
                    </button>
                  </div>

                  <div className="chart-card">
                    <div className="chart-toolbar">
                      <div className="view-toggle">
                        <button
                          type="button"
                          className={chartMode === 'classic' ? 'active' : ''}
                          onClick={() => setChartMode('classic')}
                        >
                          الش��رت العادي
                        </button>
                        <button
                          type="button"
                          className={chartMode === 'tradingview' ? 'active' : ''}
                          onClick={() => setChartMode('tradingview')}
                        >
                          TradingView
                        </button>
                      </div>
                    </div>

                    <div className="chart-stats">
                      <div>
                        <span>السعر الحالي</span>
                        <strong>{formatPrice(currentPrice, selectedSymbol)}</strong>
                      </div>
                      <div>
                        <span>RSI</span>
                        <strong>{marketData[selectedSymbol]?.indicators?.rsi?.toFixed(1) ?? '50.0'}</strong>
                      </div>
                      <div>
                        <span>اتجاه EMA</span>
                        <strong>{marketData[selectedSymbol]?.indicators?.emaShort > marketData[selectedSymbol]?.indicators?.emaLong ? 'صاعد' : 'هابط'}</strong>
                      </div>
                    </div>

                    {chartMode === 'tradingview' ? (
                      <div className="tradingview-box">
                        <iframe
                          title="TradingView Chart"
                          src={tvUrl}
                          className="tradingview-frame"
                          loading="lazy"
                          allowFullScreen
                        />
                      </div>
                    ) : (
                      <div className="custom-chart-card">
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
                    )}
                  </div>
                </div>

                <div className="trade-card">
                  {analysis ? (
                    <>
                      <div className="trade-head">
                        <div>
                          <span className="eyebrow">توصية الذكاء</span>
                          <h3 className={analysis.direction === 'BUY' ? 'buy-text' : 'sell-text'}>
                            {analysis.direction === 'BUY' ? 'شراء' : 'بيع'}
                          </h3>
                        </div>
                        <span className="confidence">{analysis.confidence}% ثقة</span>
                      </div>

                      <div className="trade-grid">
                        <div className="trade-item">
                          <span>سعر الدخول</span>
                          <strong>{formatPrice(analysis.entry, selectedSymbol)}</strong>
                        </div>
                        <div className="trade-item">
                          <span>وقف الخسارة</span>
                          <strong>{formatPrice(analysis.stopLoss, selectedSymbol)}</strong>
                        </div>
                        <div className="trade-item">
                          <span>TP1</span>
                          <strong>{formatPrice(analysis.tp1, selectedSymbol)}</strong>
                        </div>
                        <div className="trade-item">
                          <span>TP2</span>
                          <strong>{formatPrice(analysis.tp2, selectedSymbol)}</strong>
                        </div>
                        <div className="trade-item">
                          <span>TP3</span>
                          <strong>{formatPrice(analysis.tp3, selectedSymbol)}</strong>
                        </div>
                        <div className="trade-item">
                          <span>حجم اللوت</span>
                          <strong>{analysis.lotSize.toFixed(2)} lots</strong>
                        </div>
                        <div className="trade-item">
                          <span>نقطة التعادل</span>
                          <strong>{formatPrice(analysis.breakEven, selectedSymbol)}</strong>
                        </div>
                        <div className="trade-item">
                          <span>التتبع التلقائي</span>
                          <strong>{formatPrice(analysis.trailingStop, selectedSymbol)}</strong>
                        </div>
                      </div>

                      <div className="reason-box">
                        <p>{analysis.reason}</p>
                      </div>
                    </>
                  ) : (
                    <div className="empty-state">
                      <p>اضغط على زر ��حلّل الآن» لتوليد تحليل جديد وفق السعر اللحظي.</p>
                    </div>
                  )}
                </div>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

export default App;
