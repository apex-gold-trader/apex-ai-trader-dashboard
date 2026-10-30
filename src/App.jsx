import { useEffect, useMemo, useRef, useState } from 'react';

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
  const plot = symbolMap[symbol];
  if (!plot) return null;

  try {
    const response = await fetch(`https://scanner.tradingview.com/${plot.market}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols: { tickers: [plot.ticker] } }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const item = data?.data?.find((row) => row?.s === plot.ticker) || data?.data?.[0];
    const price = Number(item?.c ?? item?.lp ?? item?.p ?? item?.last ?? item?.last_price ?? 0);

    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

async function fetchLiveMarketDataFromTradingView() {
  const fallback = generateMarketData();

  const results = await Promise.allSettled(
    Object.keys(marketMeta).map(async (symbol) => {
      const quote = await fetchTradingViewQuote(symbol);
      return { symbol, quote };
    }),
  );

  const next = {};
  results.forEach((result) => {
    if (result.status !== 'fulfilled') return;
    const { symbol, quote } = result.value;
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
  const stopMap = {
    XAUUSD: 1.8,
    BTCUSD: 2.4,
    ETHUSD: 2.1,
    EURUSD: 0.0022,
    NAS100: 2.6,
  };

  return clamp(stopMap[symbol] ?? 1.5, 1.2, 3);
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
  const tvRef = useRef(null);
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
      const stored = window.localStorage.getItem(STORAGE_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    let mounted = true;

    const refresh = async () => {
      try {
        const live = await fetchLiveMarketDataFromTradingView();
        if (!mounted) return;
        setMarketData(live);
        setLastUpdated(Date.now());
      } catch {
        if (!mounted) return;
        setMarketData(generateMarketData());
      } finally {
        if (mounted) setLoading(false);
      }
    };

    refresh();
    const interval = setInterval(refresh, 6000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const scriptId = 'tv-widget-script';

    const loadScript = () => {
      const script = document.createElement('script');
      script.id = scriptId;
      script.src = 'https://s.tradingview.com/tv.js';
      script.async = true;
      script.onload = () => {
        if (!window.TradingView || !tvRef.current) return;

        if (tvRef.current._widget) {
          try {
            tvRef.current._widget.remove();
          } catch {
            // no-op
          }
        }

        const widget = new window.TradingView.widget({
          autosize: true,
          symbol: symbolMap[selectedSymbol]?.ticker || 'OANDA:XAUUSD',
          interval: timeframe,
          timezone: 'Etc/UTC',
          theme: 'dark',
          style: '1',
          locale: 'en',
          container_id: tvRef.current.id,
          hide_side_toolbar: false,
          withdateranges: true,
          save_image: true,
          allow_symbol_change: true,
          studies: ['MASimple@tv-basicstudies'],
          enabled_features: ['study_templates'],
          disabled_features: ['header_symbol_search', 'header_compare', 'use_localstorage_for_settings'],
        });

        tvRef.current._widget = widget;
      };
      document.body.appendChild(script);
    };

    if (document.getElementById(scriptId)) {
      if (window.TradingView) {
        loadScript();
      } else {
        const existing = document.getElementById(scriptId);
        existing.addEventListener('load', loadScript, { once: true });
      }
    } else {
      loadScript();
    }

    return () => {
      if (tvRef.current?._widget) {
        try {
          tvRef.current._widget.remove();
        } catch {
          // no-op
        }
      }
    };
  }, [selectedSymbol, timeframe]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(signals));
    }
  }, [signals]);

  const sparkline = useMemo(() => buildSparkline(marketData[selectedSymbol]?.series ?? []), [marketData, selectedSymbol]);

  const handleSymbolChange = (symbol) => {
    setSelectedSymbol(symbol);
    setAnalysis(null);
  };

  const handleTimeframeChange = (option) => {
    setTimeframe(option);
    setAnalysis(null);
  };

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
          سجل الإشارات والأداء (Signals & Analytics)
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
                    type=
