import { useEffect, useMemo, useRef, useState } from 'react';

const STORAGE_KEY = 'apex-ai-trader-signals-v1';
const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h'];
const LIVE_REFRESH_MS = 1000;

const MARKET_DEFS = [
  { symbol: 'XAUUSD', label: 'الذهب', market: 'gold', precision: 2, color: '#f6c453' },
  { symbol: 'BTCUSD', label: 'بيتكوين', market: 'crypto', precision: 2, color: '#f7931a' },
  { symbol: 'EURUSD', label: 'اليورو / الدولار', market: 'forex', precision: 5, color: '#58d68d' },
  { symbol: 'ETHUSD', label: 'إيثيريوم', market: 'crypto', precision: 2, color: '#8a7dff' },
  { symbol: 'NAS100', label: 'ناسداك 100', market: 'index', precision: 2, color: '#7cc7ff' },
];

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const normalizePrice = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
};

const average = (values) => {
  if (!Array.isArray(values) || !values.length) return 0;
  const numeric = values.filter((value) => Number.isFinite(Number(value))).map(Number);
  if (!numeric.length) return 0;
  return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
};

const formatPrice = (value, symbol) => {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return '—';

  const def = MARKET_DEFS.find((item) => item.symbol === symbol) || MARKET_DEFS[0];
  if (def.precision === 5) return numeric.toFixed(5);
  if (symbol === 'XAUUSD' || symbol === 'BTCUSD' || symbol === 'ETHUSD') return `$${numeric.toFixed(2)}`;
  return numeric.toFixed(2);
};

const roundToPrecision = (value, precision) => {
  const base = 10 ** precision;
  return Math.round((Number(value) || 0) * base) / base;
};

const createSparklinePoints = (values) => {
  if (!Array.isArray(values) || !values.length) return '';

  const safeValues = values.filter((value) => Number.isFinite(Number(value))).map(Number);
  if (!safeValues.length) return '';

  const min = Math.min(...safeValues);
  const max = Math.max(...safeValues);
  const range = max - min || 1;

  return safeValues
    .map((point, index) => {
      const x = (index / Math.max(safeValues.length - 1, 1)) * 300;
      const y = 80 - ((point - min) / range) * 80;
      return `${x},${y}`;
    })
    .join(' ');
};

const getMarketPrecision = (symbol) => {
  const def = MARKET_DEFS.find((item) => item.symbol === symbol);
  return def?.precision ?? 2;
};

const getBaseVolatility = (symbol) => {
  const map = {
    XAUUSD: 1.8,
    BTCUSD: 160,
    EURUSD: 0.0023,
    ETHUSD: 7.8,
    NAS100: 18,
  };
  return map[symbol] ?? 2;
};

const getDirectionalScore = (values) => {
  if (!Array.isArray(values) || values.length < 2) return 0;

  const clean = values.filter((value) => Number.isFinite(Number(value))).map(Number);
  if (clean.length < 2) return 0;

  const recent = clean.slice(-12);
  const last = recent.at(-1) ?? clean.at(-1);
  const first = recent[0] ?? clean[0];
  const priceMid = average(recent);
  const momentum = last - first;
  const distanceBias = last - priceMid;
  const deltas = recent.slice(1).map((value, index) => value - recent[index]);
  const slope = average(deltas.filter((value) => Number.isFinite(value)));

  return distanceBias * 1.2 + momentum * 1.6 + slope * 3;
};

const buildFeedbackSummary = (signals = []) => {
  if (!signals.length) return 'لا يوجد سجل صفقات مسجلة حتى الآن.';

  return signals
    .slice(0, 6)
    .map((trade, index) => {
      const resultLabel = trade.result === 'profit' ? 'ربح' : trade.result === 'loss' ? 'خسارة' : 'قيد المراجعة';
      const hitLabel = trade.tpHits ? ` | الأهداف: ${trade.tpHits}` : '';
      return `${index + 1}. ${trade.direction} ${trade.symbol} | ${resultLabel}${hitLabel} | الثقة ${trade.confidence}%`;
    })
    .join('; ');
};

async function fetchGoldPrice() {
  const candidates = ['https://api.gold-api.com/price/XAU', 'https://api.metals.live/v1/spot'];

  for (const url of candidates) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) continue;

      const payload = await response.json();

      if (typeof payload?.price === 'number') return payload.price;

      if (Array.isArray(payload)) {
        const gold = payload.find((item) => item?.metal === 'gold' || item?.symbol === 'XAUUSD' || item?.code === 'XAU');
        const value = gold?.price ?? gold?.value ?? gold?.last_price ?? gold?.p ?? null;
        if (value) return Number(value);
      }

      if (payload?.rates && payload.rates.XAU) return Number(payload.rates.XAU);
    } catch {
      // continue to next source if a provider fails
    }
  }

  return null;
}

async function fetchForexPrice(symbol) {
  const pairs = { EURUSD: { from: 'EUR', to: 'USD' } };
  const pair = pairs[symbol];
  if (!pair) return null;

  try {
    const response = await fetch(`https://api.frankfurter.app/latest?from=${pair.from}&to=${pair.to}`, { cache: 'no-store' });
    if (!response.ok) return null;

    const payload = await response.json();
    return Number(payload?.rates?.[pair.to]);
  } catch {
    return null;
  }
}

async function fetchCryptoPrice(symbol) {
  const pair = symbol === 'BTCUSD' ? 'BTCUSDT' : 'ETHUSDT';

  try {
    const response = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`, { cache: 'no-store' });
    if (!response.ok) return null;

    const payload = await response.json();
    return Number(payload?.price);
  } catch {
    return null;
  }
}

async function fetchNasdaqPrice() {
  try {
    const response = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EIXIC?interval=1m&range=1d', {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) return null;

    const payload = await response.json();
    const price = payload?.chart?.result?.[0]?.meta?.regularMarketPrice
      ?? payload?.chart?.result?.[0]?.meta?.previousClose
      ?? payload?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.at(-1)
      ?? null;

    return normalizePrice(price);
  } catch {
    return null;
  }
}

async function fetchMarketPrice(symbol) {
  if (symbol === 'XAUUSD') return fetchGoldPrice();
  if (symbol === 'EURUSD') return fetchForexPrice(symbol);
  if (symbol === 'BTCUSD' || symbol === 'ETHUSD') return fetchCryptoPrice(symbol);
  if (symbol === 'NAS100') return fetchNasdaqPrice();
  return null;
}

function buildDynamicTrade({ symbol, timeframe, series, mode }) {
  const values = Array.isArray(series) && series.length
    ? series.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : [Number(series) || 0];

  const price = normalizePrice(values.at(-1)) ?? 0;
  const score = getDirectionalScore(values);
  const direction = score >= 0 ? 'BUY' : 'SELL';

  const precision = getMarketPrecision(symbol);
  const baseVol = getBaseVolatility(symbol);
  const recentDelta = average(
    values.slice(1).map((value, index) => Math.abs(value - values[index] || 0))
  ) || baseVol;

  const stopDistance = clamp(
    (recentDelta * (mode === 'scalp' ? 0.9 : 1.3)) + (Math.abs(score) / 9000 || 0),
    baseVol * 0.55,
    baseVol * 4.8
  );

  const tpBase = stopDistance * (mode === 'scalp' ? 1.8 : 2.4);
  const tp1Distance = tpBase * (1 + clamp(Math.abs(score) / 8000, 0, 0.75));
  const tp2Distance = tpBase * (1.7 + clamp(Math.abs(score) / 10000, 0, 1.1));
  const tp3Distance = tpBase * (2.5 + clamp(Math.abs(score) / 12000, 0, 1.4));

  const stopLoss = direction === 'BUY' ? price - stopDistance : price + stopDistance;
  const tp1 = direction === 'BUY' ? price + tp1Distance : price - tp1Distance;
  const tp2 = direction === 'BUY' ? price + tp2Distance : price - tp2Distance;
  const tp3 = direction === 'BUY' ? price + tp3Distance : price - tp3Distance;
  const breakEven = direction === 'BUY' ? price + stopDistance * 0.35 : price - stopDistance * 0.35;
  const trailingStop = direction === 'BUY' ? price + stopDistance * 0.6 : price - stopDistance * 0.6;

  const confidence = clamp(
    Math.round(70 + Math.min(Math.abs(score) / 180, 18) + (mode === 'scalp' ? 4 : 0)),
    68,
    96
  );

  const lotSize = Number((mode === 'scalp' ? 0.08 : 0.12).toFixed(2));

  return {
    direction,
    entry: roundToPrecision(price, precision),
    stopLoss: roundToPrecision(stopLoss, precision),
    tp1: roundToPrecision(tp1, precision),
    tp2: roundToPrecision(tp2, precision),
    tp3: roundToPrecision(tp3, precision),
    breakEven: roundToPrecision(breakEven, precision),
    trailingStop: roundToPrecision(trailingStop, precision),
    lotSize,
    confidence,
    timeframe,
    strategy: mode === 'scalp' ? 'سكالبينغ سريع • توازن اتجاهي ديناميكي' : 'تحليل اتجاه سوقي • أهداف متحركة وفق السيولة',
    mode,
    symbol,
    reason: `${direction === 'BUY' ? 'الزخم الصاعد' : 'الزخم الهابط'} يهيمن على السوق في ${timeframe} مع موازنة بين الاتجاه والسعر الحالي، مع ضبط وقف الخسارة والأهداف ديناميكيًا حسب التقلب الفعلي وخصائص الأداة.`,
    snapshotAt: Date.now(),
  };
}

function App() {
  const [selectedSymbol, setSelectedSymbol] = useState('XAUUSD');
  const [timeframe, setTimeframe] = useState('1m');
  const [activeTab, setActiveTab] = useState('overview');
  const [loading, setLoading] = useState(true);
  const [loadingAi, setLoadingAi] = useState(false);
  const [analysis, setAnalysis] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(Date.now());
  const [signals, setSignals] = useState(() => {
    if (typeof window === 'undefined') return [];

    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  const [liveData, setLiveData] = useState(() => {
    const initial = {};
    MARKET_DEFS.forEach((item) => {
      initial[item.symbol] = { price: null, updatedAt: Date.now() };
    });
    return initial;
  });

  const [history, setHistory] = useState(() => {
    const initial = {};
    MARKET_DEFS.forEach((item) => {
      initial[item.symbol] = [];
    });
    return initial;
  });

  const liveDataRef = useRef(liveData);

  useEffect(() => {
    liveDataRef.current = liveData;
  }, [liveData]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(signals));
    }
  }, [signals]);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const nextState = {};
      const nextHistory = {};

      for (const item of MARKET_DEFS) {
        try {
          const price = await fetchMarketPrice(item.symbol);
          const normalized = normalizePrice(price);

          if (!cancelled && normalized) {
            nextState[item.symbol] = { price: normalized, updatedAt: Date.now() };
            nextHistory[item.symbol] = [...(history[item.symbol] || []), normalized].slice(-60);
          }
        } catch {
          // ignore failed source fetches
        }
      }

      if (!cancelled && Object.keys(nextState).length) {
        setLiveData((previous) => ({ ...previous, ...nextState }));
        setHistory((previous) => ({ ...previous, ...nextHistory }));
        setLastUpdated(Date.now());
      }

      setLoading(false);
    };

    refresh();
    const interval = window.setInterval(refresh, LIVE_REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const currentLivePrice = normalizePrice(liveData[selectedSymbol]?.price) ?? 0;
  const currentSeries = history[selectedSymbol]?.length ? history[selectedSymbol] : [currentLivePrice].filter(Boolean);
  const sparkline = useMemo(() => createSparklinePoints(currentSeries), [currentSeries]);

  const persistSignal = (trade) => {
    const record = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      symbol: selectedSymbol,
      label: (MARKET_DEFS.find((item) => item.symbol === selectedSymbol) || MARKET_DEFS[0]).label,
      direction: trade.direction,
      entry: trade.entry,
      stopLoss: trade.stopLoss,
      tp1: trade.tp1,
      tp2: trade.tp2,
      tp3: trade.tp3,
      confidence: trade.confidence,
      strategy: trade.strategy,
      timeframe: trade.timeframe,
      createdAt: new Date().toLocaleString('ar-SA'),
      result: null,
      tpHits: null,
      closedAt: null,
    };

    setSignals((previous) => [record, ...previous].slice(0, 18));
  };

  const markTradeResult = (id, result, tpHits = null) => {
    setSignals((previous) =>
      previous.map((signal) =>
        signal.id === id
          ? {
              ...signal,
              result,
              tpHits,
              closedAt: new Date().toLocaleString('ar-SA'),
            }
          : signal
      )
    );
  };

  const handleAnalyze = async () => {
    const mode = activeTab === 'scalp' ? 'scalp' : 'standard';
    const series = history[selectedSymbol]?.length ? history[selectedSymbol] : [currentLivePrice].filter(Boolean);
    const activePrice = normalizePrice(series.at(-1)) ?? currentLivePrice;
    const rsiValue = clamp(50 + ((series.at(-1) - average(series)) / Math.max(average(series) || 1, 0.0001)) * 100, 20, 80);

    setLoadingAi(true);

    try {
      const trade = buildDynamicTrade({
        symbol: selectedSymbol,
        timeframe,
        series,
        mode,
      });

      const payload = {
        symbol: selectedSymbol,
        timeframe,
        mode,
        current: {
          price: activePrice,
          indicators: {
            rsi: rsiValue,
            emaShort: average(series.slice(-7)),
            emaLong: average(series.slice(-20)),
            macd: (series.at(-1) ?? 0) - average(series.slice(-3)),
          },
        },
        feedbackSummary: buildFeedbackSummary(signals.slice(0, 6)),
        tradeHistory: signals.slice(0, 6),
      };

      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await response.json().catch(() => ({}));
      const nextTrade = data?.trade && data.trade?.entry ? data.trade : trade;

      setAnalysis(nextTrade);
      persistSignal(nextTrade);
    } catch {
      const fallbackTrade = buildDynamicTrade({
        symbol: selectedSymbol,
        timeframe,
        series,
        mode,
      });
      setAnalysis(fallbackTrade);
      persistSignal(fallbackTrade);
    } finally {
      setLoadingAi(false);
    }
  };

  const totalTrades = signals.length;
  const winningTrades = signals.filter((signal) => signal.result === 'profit').length;
  const losingTrades = signals.filter((signal) => signal.result === 'loss').length;
  const winRate = totalTrades ? Math.round((winningTrades / totalTrades) * 100) : 0;

  return (
    <div className="app-shell" dir="rtl">
      <header className="topbar">
        <div>
          <p className="eyebrow">الذكاء السوقي</p>
          <h1>Apex AI Trader Dashboard</h1>
        </div>
        <div className="status-pill">
          <span className="live-dot" />
          {loading ? 'جارٍ تحديث الأسعار...' : `مباشر • ${new Date(lastUpdated).toLocaleTimeString('ar-SA')}`}
        </div>
      </header>

      <nav className="nav-tabs" aria-label="التنقل بين الأقسام">
        <button type="button" className={activeTab === 'overview' ? 'nav-tab active' : 'nav-tab'} onClick={() => setActiveTab('overview')}>
          الرئيسية
        </button>
        <button type="button" className={activeTab === 'scalp' ? 'nav-tab active' : 'nav-tab'} onClick={() => { setActiveTab('scalp'); setTimeframe('1m'); }}>
          السكالبينغ السريع
        </button>
        <button type="button" className={activeTab === 'signals' ? 'nav-tab active' : 'nav-tab'} onClick={() => setActiveTab('signals')}>
          سجل الإشارات
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
                <span>إجمالي الصفقات</span>
                <strong>{totalTrades}</strong>
              </div>
              <div className="stat-box">
                <span>الرابحة</span>
                <strong className="up">{winningTrades}</strong>
              </div>
              <div className="stat-box">
                <span>الخاسرة</span>
                <strong className="down">{losingTrades}</strong>
              </div>
              <div className="stat-box">
                <span>Win Rate</span>
                <strong>{winRate}%</strong>
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

                    <div className="signal-side-actions">
                      <div className="result-pill">
                        {signal.result === 'profit'
                          ? 'ربح'
                          : signal.result === 'loss'
                            ? 'خسارة'
                            : 'قيد المراجعة'}
                      </div>
                      <div className="trade-actions">
                        <button type="button" onClick={() => markTradeResult(signal.id, 'profit', 1)}>
                          ربح 1
                        </button>
                        <button type="button" onClick={() => markTradeResult(signal.id, 'profit', 2)}>
                          ربح 2
                        </button>
                        <button type="button" onClick={() => markTradeResult(signal.id, 'profit', 3)}>
                          ربح 3
                        </button>
                        <button type="button" className="loss" onClick={() => markTradeResult(signal.id, 'loss')}>
                          خسارة
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty-signal-box">
                  <p>لا توجد إشارات محفوظة بعد. قم بإنشاء تحليل من لوحة الربط مباشرة.</p>
                </div>
              )}
            </div>
          </section>
        ) : (
          <>
            <section className="market-grid">
              {MARKET_DEFS.map((item) => {
                const price = normalizePrice(liveData[item.symbol]?.price) ?? 0;
                const previous = history[item.symbol]?.at(-2) ?? price;
                const trend = previous && previous > 0 ? ((price - previous) / previous) * 100 : 0;
                const selected = selectedSymbol === item.symbol;

                return (
                  <button key={item.symbol} type="button" className={`market-card ${selected ? 'selected' : ''}`} onClick={() => setSelectedSymbol(item.symbol)}>
                    <div className="market-header">
                      <div>
                        <p className="market-label">{item.label}</p>
                        <h3>{item.symbol}</h3>
                      </div>
                      <span className="legend" style={{ background: item.color }} />
                    </div>
                    <div className="market-price-row">
                      <strong>{formatPrice(price, item.symbol)}</strong>
                      <span className={trend >= 0 ? 'up' : 'down'}>
                        {trend >= 0 ? '+' : ''}
                        {trend.toFixed(2)}%
                      </span>
                    </div>
                  </button>
                );
              })}
            </section>

            <section className="analysis-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">تحرك التداول</p>
                  <h2>{activeTab === 'scalp' ? 'السكالبينغ السريع' : 'التحليل الذكي'}</h2>
                </div>
                <div className="timeframe-picker">
                  {TIMEFRAMES.map((option) => (
                    <button type="button" key={option} className={option === timeframe ? 'active' : ''} onClick={() => setTimeframe(option)}>
                      {option}
                    </button>
                  ))}
                </div>
              </div>

              <div className="signal-wrapper">
                <div className="signal-overview">
                  <div className="signal-topline">
                    <div>
                      <p className="eyebrow">السوق المختار</p>
                      <h3>{(MARKET_DEFS.find((item) => item.symbol === selectedSymbol) || MARKET_DEFS[0]).label}</h3>
                    </div>
                    <button type="button" className="analyze-btn" onClick={handleAnalyze} disabled={loadingAi}>
                      {loadingAi ? 'جارٍ التحليل...' : activeTab === 'scalp' ? 'حلّل الآن (سكالبينغ)' : 'حلّل الآن'}
                    </button>
                  </div>

                  <div className="chart-card">
                    <div className="chart-toolbar">
                      <div className="view-toggle">
                        <button type="button" className="active">السعر الحي</button>
                      </div>
                    </div>

                    <div className="chart-stats">
                      <div>
                        <span>السعر الحالي</span>
                        <strong>{formatPrice(currentLivePrice, selectedSymbol)}</strong>
                      </div>
                      <div>
                        <span>النطاق</span>
                        <strong>{timeframe}</strong>
                      </div>
                      <div>
                        <span>الحالة</span>
                        <strong>{loading ? 'جارٍ التحديث' : 'مباشر'}</strong>
                      </div>
                    </div>

                    <div className="custom-chart-card">
                      <svg viewBox="0 0 300 80" className="sparkline" preserveAspectRatio="none">
                        <defs>
                          <linearGradient id="spark-gradient" x1="0" x2="1">
                            <stop offset="0%" stopColor="#7bb4ff" />
                            <stop offset="100%" stopColor="#70f0b7" />
                          </linearGradient>
                        </defs>
                        <polyline fill="none" stroke="url(#spark-gradient)" strokeWidth="3" points={sparkline} />
                      </svg>
                    </div>
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
                          <span>الدخول</span>
                          <strong>{formatPrice(analysis.entry, selectedSymbol)}</strong>
                        </div>
                        <div className="trade-item">
                          <span>إيقاف الخسارة</span>
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
                          <span>التعادل</span>
                          <strong>{formatPrice(analysis.breakEven, selectedSymbol)}</strong>
                        </div>
                        <div className="trade-item">
                          <span>التتبع</span>
                          <strong>{formatPrice(analysis.trailingStop, selectedSymbol)}</strong>
                        </div>
                        <div className="trade-item">
                          <span>حجم اللوت</span>
                          <strong>{analysis.lotSize}</strong>
                        </div>
                      </div>

                      <div className="reason-box">
                        <p>{analysis.reason}</p>
                      </div>
                    </>
                  ) : (
                    <div className="empty-state">
                      <p>اضغط على زر «حلّل الآن» لقراءة السعر المباشر الحالي والذهاب إلى توصية دقيقة بناءً عليه.</p>
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
