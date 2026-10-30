import { useEffect, useMemo, useState } from 'react';

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

const MARKET_RANGES = {
  XAUUSD: { base: 1.8, precision: 2 },
  BTCUSD: { base: 180, precision: 2 },
  EURUSD: { base: 0.0025, precision: 5 },
  ETHUSD: { base: 8.5, precision: 2 },
  NAS100: { base: 20, precision: 2 },
};

async function fetchGoldPrice() {
  const sources = ['https://api.gold-api.com/price/XAU', 'https://api.metals.live/v1/spot'];

  for (const url of sources) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) continue;
      const payload = await res.json();

      if (typeof payload?.price === 'number') return payload.price;
      if (Array.isArray(payload)) {
        const match = payload.find((item) => item?.metal === 'gold' || item?.symbol === 'XAUUSD' || item?.code === 'XAU');
        const value = match?.price ?? match?.value ?? match?.last_price ?? match?.p ?? null;
        if (value) return Number(value);
      }
      if (payload?.rates && payload.rates.XAU) return Number(payload.rates.XAU);
    } catch {
      // continue to next source
    }
  }
  return null;
}

async function fetchForexPrice() {
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=EUR&to=USD', { cache: 'no-store' });
    if (!res.ok) return null;
    const payload = await res.json();
    return Number(payload?.rates?.USD ?? null);
  } catch {
    return null;
  }
}

async function fetchCryptoPrice(symbol) {
  const pair = symbol === 'BTCUSD' ? 'BTCUSDT' : 'ETHUSDT';
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const payload = await res.json();
    return Number(payload?.price ?? null);
  } catch {
    return null;
  }
}

async function fetchNasdaqPrice() {
  try {
    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EIXIC?interval=1m&range=1d', {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const payload = await res.json();
    const price = payload?.chart?.result?.[0]?.meta?.regularMarketPrice
      ?? payload?.chart?.result?.[0]?.meta?.previousClose
      ?? payload?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.at(-1)
      ?? null;
    return Number(price ?? 0);
  } catch {
    return null;
  }
}

async function fetchMarketPrice(symbol) {
  if (symbol === 'XAUUSD') return fetchGoldPrice();
  if (symbol === 'EURUSD') return fetchForexPrice();
  if (symbol === 'BTCUSD' || symbol === 'ETHUSD') return fetchCryptoPrice(symbol);
  if (symbol === 'NAS100') return fetchNasdaqPrice();
  return null;
}

function buildStrongScalpTrade({ symbol, timeframe, series = [], mode = 'scalp' }) {
  const values = Array.isArray(series) ? series.filter((value) => Number.isFinite(Number(value))).map(Number) : [];
  const last = Number(values.at(-1) ?? 0);
  const previous = Number(values.at(-2) ?? last);
  const avgFast = average(values.slice(-8));
  const avgSlow = average(values.slice(-20));
  const bias = last - avgSlow;
  const velocity = last - previous;
  const direction = bias >= 0 || velocity >= 0 ? 'BUY' : 'SELL';

  const config = MARKET_RANGES[symbol] ?? { base: 2, precision: 2 };
  const baseDistance = config.base;
  const stopDistance = clamp(
    Math.abs(last - avgFast) * 0.9 + baseDistance * (mode === 'scalp' ? 0.7 : 1.2),
    baseDistance * 0.65,
    baseDistance * 3.6
  );

  const tp1Distance = stopDistance * (mode === 'scalp' ? 1.7 : 2.2);
  const tp2Distance = stopDistance * (mode === 'scalp' ? 2.8 : 3.8);
  const tp3Distance = stopDistance * (mode === 'scalp' ? 4.2 : 5.6);

  const entry = last;
  const stopLoss = direction === 'BUY' ? entry - stopDistance : entry + stopDistance;
  const tp1 = direction === 'BUY' ? entry + tp1Distance : entry - tp1Distance;
  const tp2 = direction === 'BUY' ? entry + tp2Distance : entry - tp2Distance;
  const tp3 = direction === 'BUY' ? entry + tp3Distance : entry - tp3Distance;
  const breakEven = direction === 'BUY' ? entry + stopDistance * 0.3 : entry - stopDistance * 0.3;
  const trailingStop = direction === 'BUY' ? entry + stopDistance * 0.5 : entry - stopDistance * 0.5;
  const confidence = clamp(Math.round(78 + Math.abs(bias) / Math.max(baseDistance * 8, 1) + (mode === 'scalp' ? 10 : 4)), 72, 96);

  return {
    direction,
    entry,
    stopLoss,
    tp1,
    tp2,
    tp3,
    breakEven,
    trailingStop,
    lotSize: Number((mode === 'scalp' ? 0.12 : 0.25).toFixed(2)),
    confidence,
    timeframe,
    strategy: mode === 'scalp' ? 'سكالبينغ فائق السرعة • زخم حقيقي + إيقاف ديناميكي' : 'تحليل مباشر مع أهداف متحركة',
    mode,
    symbol,
    reason: `السعر الحالي ${formatPrice(entry, symbol)} يحافظ على ${direction === 'BUY' ? 'زخم صاعد' : 'زخم هابط'} واضح في ${timeframe}, مع تركيز على مناطق السيولة والتقلب الحقيقي لاختراق أهداف الربح وتنبيه وقف الخسارة على مبدأ السلامة الديناميكية.`,
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
  const [analysisError, setAnalysisError] = useState('');
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

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(signals));
    }
  }, [signals]);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const entries = await Promise.all(
        MARKET_DEFS.map(async (item) => {
          try {
            const price = await fetchMarketPrice(item.symbol);
            return { symbol: item.symbol, price: normalizePrice(price) };
          } catch {
            return { symbol: item.symbol, price: null };
          }
        })
      );

      if (cancelled) return;

      const nextState = {};
      const nextHistory = {};
      entries.forEach((entry) => {
        if (!entry.price) return;
        nextState[entry.symbol] = { price: entry.price, updatedAt: Date.now() };
        nextHistory[entry.symbol] = [...(history[entry.symbol] || []), entry.price].slice(-60);
      });

      if (Object.keys(nextState).length) {
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
    const payload = {
      symbol: selectedSymbol,
      timeframe,
      mode,
      current: {
        price: normalizePrice(series.at(-1)) ?? currentLivePrice,
        indicators: {
          rsi: clamp(50 + ((series.at(-1) ?? currentLivePrice) - average(series || [currentLivePrice])) / Math.max(average(series || [currentLivePrice]) || 1, 0.0001) * 100, 20, 80),
          emaShort: average(series.slice(-7) || [currentLivePrice]),
          emaLong: average(series.slice(-20) || [currentLivePrice]),
          macd: (series.at(-1) ?? currentLivePrice) - average(series.slice(-3) || [currentLivePrice]),
        },
      },
    };

    setLoadingAi(true);
    setAnalysisError('');

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data?.success || !data?.trade) {
        throw new Error(data?.error || 'Gemini analysis is unavailable right now.');
      }

      const nextTrade = data.trade;
      setAnalysis(nextTrade);
      persistSignal(nextTrade);
    } catch (error) {
      setAnalysis(null);
      setAnalysisError(error.message || 'Failed to generate Gemini trade signal.');
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
              <button type="button" className="analyze-btn small" onClick={() => setActiveTab('overview')}>العودة للتحليل</button>
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
                      <strong>{formatPrice(signal.tp1, signal.symbol)} / {formatPrice(signal.tp2, signal.symbol)}</strong>
                    </div>

                    <div className="signal-side-actions">
                      <div className="result-pill">
                        {signal.result === 'profit' ? 'ربح' : signal.result === 'loss' ? 'خسارة' : 'قيد المراجعة'}
                      </div>
                      <div className="trade-actions">
                        <button type="button" onClick={() => markTradeResult(signal.id, 'profit', 1)}>ربح 1</button>
                        <button type="button" onClick={() => markTradeResult(signal.id, 'profit', 2)}>ربح 2</button>
                        <button type="button" onClick={() => markTradeResult(signal.id, 'profit', 3)}>ربح 3</button>
                        <button type="button" className="loss" onClick={() => markTradeResult(signal.id, 'loss')}>خسارة</button>
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
                      <span className={trend >= 0 ? 'up' : 'down'}>{trend >= 0 ? '+' : ''}{trend.toFixed(2)}%</span>
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
                  {analysisError ? (
                    <div className="alert-error">{analysisError}</div>
                  ) : analysis ? (
                    <>
                      <div className="trade-head">
                        <div>
                          <span className="eyebrow">توصية الذكاء</span>
                          <h3 className={analysis.direction === 'BUY' ? 'buy-text' : 'sell-text'}>{analysis.direction === 'BUY' ? 'شراء' : 'بيع'}</h3>
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
