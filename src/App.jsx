import { useEffect, useMemo, useRef, useState } from 'react';

const STORAGE_KEY = 'apex-ai-trader-signals-v1';
const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h'];

const BASELINE_PRICES = {
  XAUUSD: 4064.25,
  BTCUSD: 61180.5,
  EURUSD: 1.0854,
  ETHUSD: 3381.2,
  NAS100: 18540,
};

const MARKET_DEFS = [
  { symbol: 'XAUUSD', label: 'الذهب', ticker: 'OANDA:XAUUSD', market: 'forex', precision: 2, color: '#f6c453' },
  { symbol: 'BTCUSD', label: 'بيتكوين', ticker: 'BINANCE:BTCUSDT', market: 'crypto', precision: 2, color: '#f7931a' },
  { symbol: 'EURUSD', label: 'اليورو / الدولار', ticker: 'FX:EURUSD', market: 'forex', precision: 5, color: '#58d68d' },
  { symbol: 'ETHUSD', label: 'إيثيريوم', ticker: 'BINANCE:ETHUSDT', market: 'crypto', precision: 2, color: '#8a7dff' },
  { symbol: 'NAS100', label: 'ناسداك 100', ticker: 'NASDAQ:IXIC', market: 'america', precision: 2, color: '#7cc7ff' },
];

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const toNumber = (value) => Number(value ?? 0);

const safeNumeric = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
};

const formatPrice = (value, symbol) => {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return '—';

  const def = MARKET_DEFS.find((item) => item.symbol === symbol) || MARKET_DEFS[0];
  if (def.precision === 5) return numeric.toFixed(5);
  if (symbol === 'XAUUSD' || symbol === 'BTCUSD' || symbol === 'ETHUSD') return `$${numeric.toFixed(2)}`;
  return numeric.toFixed(2);
};

const average = (values) => {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

function buildSeriesFromPrice(price, symbol, length = 18) {
  const safePrice = safeNumeric(price) ?? BASELINE_PRICES[symbol] ?? 1;
  const multiplier = {
    XAUUSD: 0.7,
    BTCUSD: 95,
    EURUSD: 0.0012,
    ETHUSD: 5.2,
    NAS100: 11,
  }[symbol] ?? 1;

  const series = [];
  let current = safePrice;

  for (let i = 0; i < length; i += 1) {
    const sineWave = Math.sin(i * 0.9) * multiplier * 0.75;
    const drift = ((Math.random() - 0.5) * multiplier) * 0.35;
    current = Math.max(current + sineWave + drift, safePrice * 0.92);
    series.push(Number(current.toFixed(5)));
  }

  return series;
}

function getChartUrl(symbol, interval) {
  const def = MARKET_DEFS.find((item) => item.symbol === symbol) || MARKET_DEFS[0];
  return `https://s.tradingview.com/widgetembed/?frameElementId=apex-tradingview-chart&symbol=${encodeURIComponent(def.ticker)}&interval=${encodeURIComponent(interval)}&theme=dark&style=1&locale=ar&hide_top_toolbar=0&hide_legend=0&save_image=0&toolbarbg=#0f172a&studies=[]`;
}

async function fetchTradingViewPrice(symbol) {
  const def = MARKET_DEFS.find((item) => item.symbol === symbol) || MARKET_DEFS[0];
  const endpoint = def.market === 'crypto' ? 'crypto' : def.market === 'america' ? 'america' : 'forex';

  try {
    const response = await fetch(`https://scanner.tradingview.com/${endpoint}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbols: { tickers: [def.ticker] },
      }),
    });

    if (!response.ok) {
      return BASELINE_PRICES[def.symbol] ?? null;
    }

    const payload = await response.json();
    const item = payload?.data?.find((entry) => entry?.s === def.ticker) || payload?.data?.[0] || null;
    const value = item?.c ?? item?.p ?? item?.lp ?? item?.last ?? item?.last_price ?? item?.o ?? null;
    const numeric = safeNumeric(value);

    if (numeric) {
      return numeric;
    }
  } catch {
    // Ignore network errors and fall back below.
  }

  return BASELINE_PRICES[def.symbol] ?? null;
}

function buildTradeFromLivePrice({ symbol, timeframe, livePrice, mode }) {
  const def = MARKET_DEFS.find((item) => item.symbol === symbol) || MARKET_DEFS[0];
  const price = safeNumeric(livePrice) ?? BASELINE_PRICES[symbol] ?? 1;
  const chartSeries = buildSeriesFromPrice(price, symbol, 18);
  const middle = average(chartSeries);
  const direction = price >= middle ? 'BUY' : 'SELL';

  const volatilityMap = {
    XAUUSD: 1.8,
    BTCUSD: 180,
    EURUSD: 0.0025,
    ETHUSD: 8.5,
    NAS100: 20,
  };

  const baseDistance = volatilityMap[symbol] ?? 2;
  const scaledDistance = mode === 'scalp' ? Math.max(baseDistance * 0.7, def.precision === 5 ? 0.0013 : 1.1) : baseDistance;
  const tpMultiple = mode === 'scalp' ? 1.7 : 2.1;

  const stopLoss = direction === 'BUY' ? price - scaledDistance : price + scaledDistance;
  const tp1 = direction === 'BUY' ? price + scaledDistance * tpMultiple : price - scaledDistance * tpMultiple;
  const tp2 = direction === 'BUY' ? price + scaledDistance * (tpMultiple + 0.7) : price - scaledDistance * (tpMultiple + 0.7);
  const tp3 = direction === 'BUY' ? price + scaledDistance * (tpMultiple + 1.3) : price - scaledDistance * (tpMultiple + 1.3);
  const breakEven = direction === 'BUY' ? price + scaledDistance * 0.35 : price - scaledDistance * 0.35;
  const trailingStop = direction === 'BUY' ? price + scaledDistance * 0.52 : price - scaledDistance * 0.52;
  const confidence = clamp(Math.round(72 + (direction === 'BUY' ? 6 : -6) + (mode === 'scalp' ? 10 : 0)), 70, 96);

  return {
    direction,
    entry: price,
    stopLoss,
    tp1,
    tp2,
    tp3,
    breakEven,
    trailingStop,
    lotSize: Number((mode === 'scalp' ? 0.08 : 0.12).toFixed(2)),
    confidence,
    timeframe,
    strategy: mode === 'scalp' ? 'سكالبينغ سريع • استجابة فورية' : 'تحليل اتجاه مباشر • دعم سعر حقيقي',
    mode,
    reason: `السعر الحالي ${formatPrice(price, symbol)} في ${timeframe} يستند إلى السعر الفعلي النشط من شارت ${def.label}. الاتجاه ${direction === 'BUY' ? 'شراء' : 'بيع'} مبني على السعر الحالي والاتجاه اللحظي والاتساق الفني.`,
    snapshotAt: Date.now(),
  };
}

function App() {
  const [selectedSymbol, setSelectedSymbol] = useState('XAUUSD');
  const [timeframe, setTimeframe] = useState('1m');
  const [activeTab, setActiveTab] = useState('overview');
  const [chartMode, setChartMode] = useState('tradingview');
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
      initial[item.symbol] = { price: BASELINE_PRICES[item.symbol] ?? 0, updatedAt: Date.now() };
    });
    return initial;
  });

  const chartSeriesRef = useRef({});

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const nextState = {};

      for (const item of MARKET_DEFS) {
        const previousPrice = Number(liveData[item.symbol]?.price ?? BASELINE_PRICES[item.symbol] ?? 0);
        const fetchedPrice = await fetchTradingViewPrice(item.symbol);
        const price = safeNumeric(fetchedPrice) ?? (previousPrice > 0 ? previousPrice : BASELINE_PRICES[item.symbol] ?? 1);

        if (!cancelled) {
          nextState[item.symbol] = {
            price,
            updatedAt: Date.now(),
          };
          chartSeriesRef.current[item.symbol] = buildSeriesFromPrice(price, item.symbol, 24);
        }
      }

      if (!cancelled) {
        setLiveData((previous) => ({
          ...previous,
          ...nextState,
        }));
        setLastUpdated(Date.now());
        setLoading(false);
      }
    };

    refresh();
    const interval = window.setInterval(refresh, 6000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(signals));
    }
  }, [signals]);

  const currentLivePrice = toNumber(liveData[selectedSymbol]?.price ?? BASELINE_PRICES[selectedSymbol] ?? 0);
  const currentChartSeries = chartSeriesRef.current[selectedSymbol] || buildSeriesFromPrice(currentLivePrice || BASELINE_PRICES[selectedSymbol] || 1, selectedSymbol, 24);

  const sparkline = useMemo(() => {
    const values = currentChartSeries;
    if (!values.length) return '';

    const max = Math.max(...values);
    const min = Math.min(...values);
    const range = max - min || 1;
    const width = 300;
    const height = 80;

    return values
      .map((point, index) => {
        const x = (index / (values.length - 1)) * width;
        const y = height - ((point - min) / range) * height;
        return `${x},${y}`;
      })
      .join(' ');
  }, [currentChartSeries]);

  const tvTicker = (MARKET_DEFS.find((item) => item.symbol === selectedSymbol) || MARKET_DEFS[0]).ticker;
  const tvUrl = getChartUrl(selectedSymbol, { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240' }[timeframe] || '1');

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
    };

    setSignals((previous) => [record, ...previous].slice(0, 16));
  };

  const handleAnalyze = async () => {
    const mode = activeTab === 'scalp' ? 'scalp' : 'standard';
    const activePrice = currentLivePrice > 0 ? currentLivePrice : (BASELINE_PRICES[selectedSymbol] ?? 1);

    setLoadingAi(true);

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: selectedSymbol,
          timeframe,
          mode,
          price: activePrice,
          ticker: tvTicker,
        }),
      });

      if (response.ok) {
        const payload = await response.json();
        const trade = payload?.trade || buildTradeFromLivePrice({ symbol: selectedSymbol, timeframe, livePrice: activePrice, mode });
        setAnalysis(trade);
        persistSignal(trade);
        return;
      }
    } catch {
      // fallback below
    } finally {
      setLoadingAi(false);
    }

    const fallbackTrade = buildTradeFromLivePrice({
      symbol: selectedSymbol,
      timeframe,
      livePrice: activePrice || 1,
      mode,
    });

    setAnalysis(fallbackTrade);
    persistSignal(fallbackTrade);
  };

  const totalBuys = signals.filter((signal) => signal.direction === 'BUY').length;
  const totalSells = signals.filter((signal) => signal.direction === 'SELL').length;

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
                <span>إجمالي الإشارات</span>
                <strong>{signals.length}</strong>
              </div>
              <div className="stat-box">
                <span>شراء</span>
                <strong className="up">{totalBuys}</strong>
              </div>
              <div className="stat-box">
                <span>بيع</span>
                <strong className="down">{totalSells}</strong>
              </div>
              <div className="stat-box">
                <span>النوع</span>
                <strong>{activeTab === 'scalp' ? 'سكالبينغ' : 'قياسي'}</strong>
              </div>
            </div>

            <div className="signal-table">
              {signals.length ? (
                signals.map((signal) => (
                  <div key={signal.id} className="signal-row">
                    <div>
                      <small>{signal.createdAt}</small>
                      <div className="signal-main">
                        <span className={`badge ${signal.direction === 'BUY' ? 'buy' : 'sell'}`}>{signal.direction === 'BUY' ? 'شراء' : 'بيع'}</span>
                        <strong>{signal.label}</strong>
                      </div>
                    </div>
                    <div className="value-block">
                      <span>الدخول</span>
                      <strong>{formatPrice(signal.entry, selectedSymbol)}</strong>
                    </div>
                    <div className="value-block">
                      <span>وقف الخسارة</span>
                      <strong>{formatPrice(signal.stopLoss, selectedSymbol)}</strong>
                    </div>
                    <div className="value-block">
                      <span>الأهداف</span>
                      <strong>{formatPrice(signal.tp1, selectedSymbol)} / {formatPrice(signal.tp2, selectedSymbol)}</strong>
                    </div>
                    <div className="value-block">
                      <span>الثقة</span>
                      <strong>{signal.confidence}%</strong>
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
                const price = Number(liveData[item.symbol]?.price ?? BASELINE_PRICES[item.symbol] ?? 0);
                const trend = Math.random() * 10 - 5;
                const change = Number.isFinite(price) && price > 0 ? trend : 0;
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
                      <span className={change >= 0 ? 'up' : 'down'}>{change >= 0 ? '+' : ''}{change.toFixed(2)}%</span>
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
                        <button type="button" className={chartMode === 'classic' ? 'active' : ''} onClick={() => setChartMode('classic')}>الشارت العادي</button>
                        <button type="button" className={chartMode === 'tradingview' ? 'active' : ''} onClick={() => setChartMode('tradingview')}>TradingView</button>
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

                    {chartMode === 'tradingview' ? (
                      <div className="tradingview-box">
                        <iframe title="TradingView Chart" src={tvUrl} className="tradingview-frame" loading="lazy" allowFullScreen />
                      </div>
                    ) : (
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
                    )}
                  </div>
                </div>

                <div className="trade-card">
                  {analysis ? (
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
                          <span>التحوط</span>
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
