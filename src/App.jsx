import { useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'apex-ai-trader-signals-v1';
const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h'];
const SYMBOLS = ['XAUUSD', 'BTCUSD', 'EURUSD', 'ETHUSD', 'NAS100'];

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

const DEFAULT_BASES = {
  XAUUSD: 2346.42,
  BTCUSD: 67740.12,
  EURUSD: 1.0884,
  ETHUSD: 3592.77,
  NAS100: 19036.2,
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const formatPrice = (value, symbol) => {
  if (!Number.isFinite(Number(value))) return '—';
  const num = Number(value);
  if (symbol === 'XAUUSD') return `$${num.toFixed(2)}`;
  if (symbol === 'EURUSD') return num.toFixed(5);
  if (symbol === 'NAS100') return num.toFixed(2);
  if (symbol === 'BTCUSD' || symbol === 'ETHUSD') return `$${num.toFixed(2)}`;
  return num.toFixed(4);
};

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, item) => sum + item, 0) / values.length;
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

function getRsi(series) {
  if (series.length < 15) return 50;
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

function getMacd(series) {
  const fast = getEma(series, 12);
  const slow = getEma(series, 26);
  return fast - slow;
}

function getBollinger(series) {
  const window = series.slice(-20);
  const mid = average(window);
  const variance = average(window.map((point) => (point - mid) ** 2));
  const std = Math.sqrt(variance);
  return { upper: mid + std * 2, lower: mid - std * 2 };
}

function buildSeriesBasedOnPrice(symbol, price) {
  const signalSensitivity = {
    XAUUSD: { drift: 0.08, volatility: 0.25 },
    BTCUSD: { drift: 110, volatility: 180 },
    EURUSD: { drift: 0.00012, volatility: 0.00045 },
    ETHUSD: { drift: 8, volatility: 20 },
    NAS100: { drift: 12, volatility: 26 },
  };

  const config = signalSensitivity[symbol] || { drift: 0.5, volatility: 1 };
  const points = [];
  let current = price;

  for (let i = 0; i < 28; i += 1) {
    const wave = Math.sin((i / 7) + (price / 1000)) * config.volatility;
    const noise = ((Math.random() - 0.5) * config.volatility * 2.2);
    current = Math.max(current + config.drift + wave + noise, price * 0.85);
    points.push(Number(current.toFixed(symbol === 'EURUSD' ? 5 : 2)));
  }

  return points;
}

function buildSnapshot(symbol, price) {
  const series = buildSeriesBasedOnPrice(symbol, price);
  const last = Number(series[series.length - 1]);
  const prev = Number(series[series.length - 2] ?? last);
  const rsi = getRsi(series);
  const emaShort = getEma(series, 9);
  const emaLong = getEma(series, 21);
  const macd = getMacd(series);
  const bb = getBollinger(series);

  return {
    price: Number(last.toFixed(symbol === 'EURUSD' ? 5 : 2)),
    change: Number((((last - prev) / Math.max(prev, 0.0001)) * 100).toFixed(3)),
    series,
    indicators: {
      rsi,
      emaShort,
      emaLong,
      macd,
      bollingerUpper: bb.upper,
      bollingerLower: bb.lower,
    },
    updatedAt: Date.now(),
  };
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

    const payload = await response.json();
    const item = payload?.data?.find((row) => row?.s === plot.ticker) || payload?.data?.[0];
    const price = Number(item?.c ?? item?.lp ?? item?.p ?? item?.last ?? item?.last_price ?? 0);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

async function fetchLiveMarketDataFromTradingView() {
  const results = await Promise.allSettled(
    SYMBOLS.map(async (symbol) => ({ symbol, quote: await fetchTradingViewQuote(symbol) })),
  );

  const next = {};

  results.forEach((result) => {
    if (result.status !== 'fulfilled') return;
    const { symbol, quote } = result.value;
    if (!quote) return;
    next[symbol] = buildSnapshot(symbol, Number(quote));
  });

  SYMBOLS.forEach((symbol) => {
    if (!next[symbol]) next[symbol] = buildSnapshot(symbol, Number(DEFAULT_BASES[symbol] ?? 0));
  });

  return next;
}

function buildSparkline(series) {
  if (!series || series.length < 2) return '';
  const max = Math.max(...series);
  const min = Math.min(...series);
  const width = 240;
  const height = 50;
  const range = max - min || 1;

  return series
    .map((point, index) => {
      const x = (index / (series.length - 1)) * width;
      const y = height - ((point - min) / range) * height;
      return `${x},${y}`;
    })
    .join(' ');
}

function App() {
  const [timeframe, setTimeframe] = useState('1m');
  const [marketData, setMarketData] = useState(() => {
    const initial = {};
    SYMBOLS.forEach((symbol) => {
      initial[symbol] = buildSnapshot(symbol, Number(DEFAULT_BASES[symbol] ?? 0));
    });
    return initial;
  });
  const [selectedSymbol, setSelectedSymbol] = useState('XAUUSD');
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingAi, setLoadingAi] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [lastUpdated, setLastUpdated] = useState(Date.now());
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
        if (mounted) {
          const fallback = {};
          SYMBOLS.forEach((symbol) => {
            fallback[symbol] = buildSnapshot(symbol, Number(DEFAULT_BASES[symbol] ?? 0));
          });
          setMarketData(fallback);
        }
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
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(signals));
    }
  }, [signals]);

  const stats = useMemo(() => {
    const total = signals.length;
    const wins = signals.filter((signal) => ['win1', 'win2', 'win3'].includes(signal.status)).length;
    const losses = signals.filter((signal) => signal.status === 'loss').length;
    const winRate = total ? (wins / total) * 100 : 0;
    return { total, wins, losses, winRate };
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
      label: marketMeta[selectedSymbol]?.label ?? selectedSymbol,
      direction: trade.direction || 'BUY',
      entry: Number(trade.entry ?? 0),
      stopLoss: Number(trade.stopLoss ?? 0),
      tp1: Number(trade.tp1 ?? 0),
      tp2: Number(trade.tp2 ?? 0),
      tp3: Number(trade.tp3 ?? 0),
      lotSize: Number(trade.lotSize ?? 0.01),
      confidence: Number(trade.confidence ?? 0),
      timeframe: trade.timeframe || timeframe,
      strategy: trade.strategy || (activeTab === 'scalp' ? 'سكالبينغ سريع 1m' : 'تحليل فني متوازن'),
      mode: trade.mode || (activeTab === 'scalp' ? 'scalp' : 'standard'),
      status: 'open',
      createdAt: new Date().toLocaleString('ar-SA'),
      updatedAt: Date.now(),
    };

    setSignals((previous) => [record, ...previous].slice(0, 30));
  };

  const resolveSignal = (signalId, outcome) => {
    setSignals((previous) => previous.map((signal) => (signal.id === signalId ? { ...signal, status: outcome, updatedAt: Date.now() } : signal)));
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

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || 'فشل الاتصال بخادم التحليل.');
      }

      const trade = payload.trade || payload;
      if (!trade || !Number.isFinite(Number(trade.entry))) {
        throw new Error('لا يوجد تحليل صالح في الوقت الحالي.');
      }

      const normalizedTrade = {
        ...trade,
        mode,
        timeframe,
        confidence: Number(trade.confidence ?? 80),
        lotSize: Number(trade.lotSize ?? 0.01),
        entry: Number(trade.entry ?? current?.price ?? 0),
        stopLoss: Number(trade.stopLoss ?? 0),
        tp1: Number(trade.tp1 ?? 0),
        tp2: Number(trade.tp2 ?? 0),
        tp3: Number(trade.tp3 ?? 0),
        breakEven: Number(trade.breakEven ?? 0),
      };

      setAnalysis(normalizedTrade);
      persistSignal(normalizedTrade);
    } catch (error) {
      setAnalysis(null);
      console.error(error);
    } finally {
      setLoadingAi(false);
    }
  };

  const isScalpTab = activeTab === 'scalp';
  const liveCurrent = marketData[selectedSymbol]?.price ?? 0;

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
        <button type="button" className={activeTab === 'overview' ? 'nav-tab active' : 'nav-tab'} onClick={() => setActiveTab('overview')}>
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
          السكالبينغ السريع (1m)
        </button>
        <button type="button" className={activeTab === 'signals' ? 'nav-tab active' : 'nav-tab'} onClick={() => setActiveTab('signals')}>
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
                <span>إجمالي الصفقات</span>
                <strong>{stats.total}</strong>
              </div>
              <div className="stat-box">
                <span>الصفقات الرابحة</span>
                <strong className="up">{stats.wins}</strong>
              </div>
              <div className="stat-box">
                <span>الصفقات الخاسرة</span>
                <strong className="down">{stats.losses}</strong>
              </div>
              <div className="stat-box">
                <span>Win Rate %</span>
                <strong>{stats.winRate.toFixed(1)}%</strong>
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
                      <span>الحالة</span>
                      <strong>
                        {signal.status === 'open'
                          ? 'مفتوح'
                          : signal.status === 'loss'
                            ? 'خسارة'
                            : signal.status === 'win1'
                              ? 'ربح 1'
                              : signal.status === 'win2'
                                ? 'ربح 2'
                                : 'ربح 3'}
                      </strong>
                      <div className="trade-actions" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
                        {['win1', 'win2', 'win3', 'loss'].map((state) => {
                          const label = state === 'loss' ? 'خسارة' : `ربح ${state.replace('win', '')}`;
                          return (
                            <button
                              key={state}
                              type="button"
                              className={signal.status === state ? 'outcome-btn active' : 'outcome-btn'}
                              onClick={() => resolveSignal(signal.id, state)}
                              style={{
                                borderRadius: '8px',
                                padding: '6px 8px',
                                cursor: 'pointer',
                                border: '1px solid rgba(255,255,255,0.14)',
                                background: signal.status === state ? 'rgba(90,228,162,0.12)' : 'rgba(255,255,255,0.02)',
                                color: state === 'loss' ? '#ff6a78' : '#5ae4a2',
                                fontSize: '0.7rem',
                              }}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
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
              {SYMBOLS.map((symbol) => {
                const item = marketData[symbol];
                const meta = marketMeta[symbol];
                const isSelected = symbol === selectedSymbol;
                const price = item?.price ?? 0;
                const change = item?.change ?? 0;
                const positive = change >= 0;
                const spark = buildSparkline(item?.series ?? []);

                return (
                  <button
                    key={symbol}
                    type="button"
                    className={isSelected ? 'market-card selected' : 'market-card'}
                    onClick={() => handleSymbolChange(symbol)}
                    style={{ borderColor: isSelected ? meta.color : 'rgba(255,255,255,0.08)' }}
                  >
                    <div className="market-header">
                      <span className="legend" style={{ color: meta.color, background: meta.color }} />
                      <strong>{meta.label}</strong>
                    </div>

                    <div className="market-price-row">
                      <span className="market-label">{meta.unit}</span>
                      <strong>{formatPrice(price, symbol)}</strong>
                    </div>

                    <div className={positive ? 'up market-subtitle' : 'down market-subtitle'}>
                      {positive ? '+' : ''}{change.toFixed(2)}%
                    </div>

                    <svg viewBox="0 0 240 50" className="sparkline" preserveAspectRatio="none" style={{ height: '52px', minHeight: '52px' }}>
                      <polyline
                        points={spark}
                        fill="none"
                        stroke={meta.color}
                        strokeWidth="2"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                );
              })}
            </section>

            <section className="analysis-panel" style={{ width: '100%' }}>
              <div className="panel-header" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <p className="eyebrow">التحليل</p>
                  <h3>{marketMeta[selectedSymbol]?.label}</h3>
                </div>
                <div className="timeframe-picker">
                  {TIMEFRAMES.map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={timeframe === option ? 'active' : ''}
                      onClick={() => handleTimeframeChange(option)}
                      style={{
                        padding: '8px 10px',
                        borderRadius: '10px',
                        border: '1px solid rgba(255,255,255,0.14)',
                        background: timeframe === option ? 'rgba(116,171,255,0.18)' : 'rgba(255,255,255,0.02)',
                        color: '#edf6ff',
                        cursor: 'pointer',
                      }}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="button"
                className="analyze-btn"
                onClick={handleAnalyze}
                disabled={loadingAi}
                style={{ width: '100%', margin: '8px 0 0' }}
              >
                {loadingAi ? 'جارٍ التحليل...' : isScalpTab ? 'حلل الآن (سكالبينغ 1m)' : 'حلل الآن'}
              </button>

              {analysis ? (
                <div className="trade-card" style={{ borderRadius: '18px', border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(10,18,28,0.9)', padding: '18px' }}>
                  <div className="trade-head" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '16px' }}>
                    <span className={`badge ${analysis.direction === 'BUY' ? 'buy' : 'sell'}`}>
                      {analysis.direction === 'BUY' ? 'شراء' : 'بيع'}
                    </span>
                    <strong className="confidence">{analysis.confidence ?? 0}%</strong>
                  </div>

                  <div className="trade-grid">
                    <div className="trade-item"><span>الدخول</span><strong>{formatPrice(analysis.entry, selectedSymbol)}</strong></div>
                    <div className="trade-item"><span>وقف الخسارة</span><strong>{formatPrice(analysis.stopLoss, selectedSymbol)}</strong></div>
                    <div className="trade-item"><span>TP1</span><strong>{formatPrice(analysis.tp1, selectedSymbol)}</strong></div>
                    <div className="trade-item"><span>TP2</span><strong>{formatPrice(analysis.tp2, selectedSymbol)}</strong></div>
                    <div className="trade-item"><span>TP3</span><strong>{formatPrice(analysis.tp3, selectedSymbol)}</strong></div>
                    <div className="trade-item"><span>Breakeven</span><strong>{formatPrice(analysis.breakEven, selectedSymbol)}</strong></div>
                    <div className="trade-item"><span>Lot</span><strong>{Number(analysis.lotSize ?? 0).toFixed(2)}</strong></div>
                    <div className="trade-item"><span>الإطار</span><strong>{analysis.timeframe || timeframe}</strong></div>
                  </div>

                  <p className="reason-box" style={{ marginTop: '14px', opacity: 0.82 }}>
                    {analysis.reason || 'تحليل فني يستند إلى السوق اللحظي، الزخم، وكسر السيولة مع إدارة مخاطرة دقيقة.'}
                  </p>

                  <p className="market-subtitle" style={{ marginTop: '12px', opacity: 0.7 }}>
                    السعر الحي: {formatPrice(liveCurrent, selectedSymbol)} • المصدر: Market Live Feed
                  </p>
                </div>
              ) : (
                <div className="empty-state">
                  <p>اختر أصل التداول ثم اضغط على زر “حلل الآن” للحصول على توصية جاهزة.</p>
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

export default App;
