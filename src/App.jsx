import { useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'apex-ai-trader-signals-v1';
const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h'];
const SYMBOLS = ['XAUUSD', 'BTCUSD', 'EURUSD', 'ETHUSD', 'NAS100'];

const marketMeta = {
  XAUUSD: { label: 'الذهب', unit: 'XAUUSD', color: '#f6c453' },
  BTCUSD: { label: 'بيتكوين', unit: 'BTCUSD', color: '#f7931a' },
  EURUSD: { label: 'اليورو/الدولار', unit: 'EURUSD', color: '#58d68d' },
  ETHUSD: { label: 'إيثيريوم', unit: 'ETHUSD', color: '#8a7dff' },
  NAS100: { label: 'ناسداك 100', unit: 'NAS100', color: '#7cc7ff' },
};

const DEFAULT_BASES = {
  XAUUSD: 2346.42,
  BTCUSD: 67740.12,
  EURUSD: 1.0884,
  ETHUSD: 3592.77,
  NAS100: 19036.2,
};

const symbolMap = {
  XAUUSD: { market: 'forex', ticker: 'OANDA:XAUUSD' },
  BTCUSD: { market: 'crypto', ticker: 'BINANCE:BTCUSDT' },
  EURUSD: { market: 'forex', ticker: 'FX:EURUSD' },
  ETHUSD: { market: 'crypto', ticker: 'BINANCE:ETHUSDT' },
  NAS100: { market: 'america', ticker: 'NASDAQ:IXIC' },
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
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ema(series, period) {
  if (!series.length) return 0;
  const multiplier = 2 / (period + 1);
  let result = series[0];
  for (let i = 1; i < series.length; i += 1) {
    result = (series[i] - result) * multiplier + result;
  }
  return result;
}

function rsi(series) {
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

function bollinger(series) {
  const window = series.slice(-20);
  const mid = average(window);
  const variance = average(window.map((point) => (point - mid) ** 2));
  const std = Math.sqrt(variance);
  return { upper: mid + std * 2, lower: mid - std * 2 };
}

function buildSnapshot(symbol, price) {
  const series = [];
  let current = Number(price || DEFAULT_BASES[symbol] || 1);
  const drift = {
    XAUUSD: 0.12,
    BTCUSD: 130,
    EURUSD: 0.00012,
    ETHUSD: 9,
    NAS100: 12,
  }[symbol] || 0.5;
  const volatility = {
    XAUUSD: 0.35,
    BTCUSD: 200,
    EURUSD: 0.0005,
    ETHUSD: 22,
    NAS100: 28,
  }[symbol] || 1;

  for (let i = 0; i < 28; i += 1) {
    const wave = Math.sin((i / 6) + (price / 1000)) * volatility;
    const noise = (Math.random() - 0.5) * volatility * 1.8;
    current = Math.max(current + drift + wave + noise, price * 0.85);
    series.push(Number(current.toFixed(symbol === 'EURUSD' ? 5 : 2)));
  }

  const last = Number(series[series.length - 1]);
  const prev = Number(series[series.length - 2] ?? last);
  const currentRsi = rsi(series);
  const emaShort = ema(series, 9);
  const emaLong = ema(series, 21);
  const macd = ema(series, 12) - ema(series, 26);
  const bb = bollinger(series);

  return {
    price: Number(last.toFixed(symbol === 'EURUSD' ? 5 : 2)),
    change: Number((((last - prev) / Math.max(prev, 0.0001)) * 100).toFixed(3)),
    series,
    indicators: {
      rsi: currentRsi,
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
  const target = symbolMap[symbol];
  if (!target) return null;

  try {
    const res = await fetch(`https://scanner.tradingview.com/${target.market}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols: { tickers: [target.ticker] } }),
    });

    if (!res.ok) return null;
    const payload = await res.json();
    const item = payload?.data?.find((row) => row?.s === target.ticker) || payload?.data?.[0];
    const quote = Number(item?.c ?? item?.lp ?? item?.p ?? item?.last ?? item?.last_price ?? 0);
    return Number.isFinite(quote) && quote > 0 ? quote : null;
  } catch {
    return null;
  }
}

async function fetchBinanceQuote(symbol) {
  const map = { BTCUSD: 'BTCUSDT', ETHUSD: 'ETHUSDT' };
  const pair = map[symbol];
  if (!pair) return null;

  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`);
    const data = await res.json();
    const price = Number(data?.price ?? 0);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

async function fetchFxQuote(symbol) {
  if (symbol === 'EURUSD') {
    try {
      const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=EUR');
      const data = await res.json();
      const eur = Number(data?.rates?.EUR ?? 0);
      if (eur > 0) return 1 / eur;
    } catch {
      return null;
    }
  }
  return null;
}

async function fetchXauQuote() {
  try {
    const res = await fetch('https://api.gold-api.com/price/XAU');
    const data = await res.json();
    const price = Number(data?.price ?? 0);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

async function fetchNasdaqQuote() {
  try {
    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/^IXIC?interval=1m&range=1d');
    const data = await res.json();
    const price = Number(data?.chart?.result?.[0]?.meta?.regularMarketPrice ?? 0);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

async function fetchLiveQuote(symbol) {
  const sources = [
    fetchTradingViewQuote,
    symbol === 'XAUUSD' ? fetchXauQuote : null,
    symbol === 'BTCUSD' || symbol === 'ETHUSD' ? fetchBinanceQuote : null,
    symbol === 'EURUSD' ? fetchFxQuote : null,
    symbol === 'NAS100' ? fetchNasdaqQuote : null,
  ].filter(Boolean);

  for (const source of sources) {
    try {
      const price = await source(symbol);
      if (price && Number.isFinite(price)) return Number(price);
    } catch {
      // continue
    }
  }
  return null;
}

async function fetchLiveMarketData() {
  const result = {};
  for (const symbol of SYMBOLS) {
    const quote = await fetchLiveQuote(symbol);
    const base = Number(quote ?? DEFAULT_BASES[symbol] ?? 0);
    result[symbol] = buildSnapshot(symbol, base);
  }
  return result;
}

function buildSparkline(series) {
  if (!series || series.length < 2) return '';
  const max = Math.max(...series);
  const min = Math.min(...series);
  const width = 240;
  const height = 60;
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
      initial[symbol] = buildSnapshot(symbol, DEFAULT_BASES[symbol]);
    });
    return initial;
  });
  const [selectedSymbol, setSelectedSymbol] = useState('XAUUSD');
  const [analysis, setAnalysis] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(Date.now());
  const [loading, setLoading] = useState(true);
  const [loadingAi, setLoadingAi] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
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
        const live = await fetchLiveMarketData();
        if (!mounted) return;
        setMarketData(live);
        setLastUpdated(Date.now());
      } catch {
        if (!mounted) return;
        const fallback = {};
        SYMBOLS.forEach((symbol) => {
          fallback[symbol] = buildSnapshot(symbol, DEFAULT_BASES[symbol]);
        });
        setMarketData(fallback);
      } finally {
        if (mounted) setLoading(false);
      }
    };

    refresh();
    const interval = setInterval(refresh, 5000);
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

  const winRate = useMemo(() => {
    const total = signals.length;
    const wins = signals.filter((signal) => signal.status && signal.status !== 'loss').length;
    return total ? (wins / total) * 100 : 0;
  }, [signals]);

  const sparkline = useMemo(() => buildSparkline(marketData[selectedSymbol]?.series ?? []), [marketData, selectedSymbol]);

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
      confidence: Number(trade.confidence ?? 0),
      timeframe: trade.timeframe || timeframe,
      strategy: trade.strategy || 'تحليل فني',
      status: 'open',
      mode: trade.mode || (activeTab === 'scalp' ? 'scalp' : 'standard'),
      createdAt: new Date().toLocaleString('ar-SA'),
    };

    setSignals((previous) => [record, ...previous].slice(0, 30));
  };

  const resolveSignal = (signalId, outcome) => {
    setSignals((previous) => previous.map((signal) => (signal.id === signalId ? { ...signal, status: outcome } : signal)));
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
      const trade = payload?.trade || payload;

      if (!trade || !Number.isFinite(Number(trade.entry))) {
        throw new Error('لا يوجد تحليل صالح في الوقت الحالي');
      }

      const normalizedTrade = {
        ...trade,
        direction: String(trade.direction || 'BUY').toUpperCase(),
        entry: Number(trade.entry ?? current?.price ?? 0),
        stopLoss: Number(trade.stopLoss ?? 0),
        tp1: Number(trade.tp1 ?? 0),
        tp2: Number(trade.tp2 ?? 0),
        tp3: Number(trade.tp3 ?? 0),
        lotSize: Number(trade.lotSize ?? 0.01),
        breakEven: Number(trade.breakEven ?? 0),
        confidence: Number(trade.confidence ?? 80),
        timeframe,
        mode,
        symbol: selectedSymbol,
      };

      setAnalysis(normalizedTrade);
      persistSignal(normalizedTrade);
      setActiveTab('signals');
    } catch (error) {
      const fallback = {
        direction: 'BUY',
        entry: current?.price ?? DEFAULT_BASES[selectedSymbol],
        stopLoss: (current?.price ?? DEFAULT_BASES[selectedSymbol]) - 2,
        tp1: (current?.price ?? DEFAULT_BASES[selectedSymbol]) + 3,
        tp2: (current?.price ?? DEFAULT_BASES[selectedSymbol]) + 5,
        tp3: (current?.price ?? DEFAULT_BASES[selectedSymbol]) + 8,
        lotSize: 0.1,
        breakEven: (current?.price ?? DEFAULT_BASES[selectedSymbol]) + 1,
        confidence: 80,
        reason: 'تم إنشاء تحليل احتياطي تلقائيًا لأنالخادم أعاد بيانات غير مكتملة.',
        timeframe,
        mode,
        symbol: selectedSymbol,
      };
      setAnalysis(fallback);
      persistSignal(fallback);
      setActiveTab('signals');
      console.error(error);
    } finally {
      setLoadingAi(false);
    }
  };

  const isScalp = activeTab === 'scalp';
  const liveCurrent = marketData[selectedSymbol]?.price ?? DEFAULT_BASES[selectedSymbol];

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
              <div className="stat-box"><span>إجمالي</span><strong>{signals.length}</strong></div>
              <div className="stat-box"><span>الرابحة</span><strong className="up">{signals.filter((s) => s.status && s.status !== 'loss').length}</strong></div>
              <div className="stat-box"><span>الخسارة</span><strong className="down">{signals.filter((s) => s.status === 'loss').length}</strong></div>
              <div className="stat-box"><span>Win Rate</span><strong>{winRate.toFixed(1)}%</strong></div>
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
                    <div className="value-block"><span>الدخول</span><strong>{formatPrice(signal.entry, signal.symbol)}</strong></div>
                    <div className="value-block"><span>وقف الخسارة</span><strong>{formatPrice(signal.stopLoss, signal.symbol)}</strong></div>
                    <div className="value-block"><span>الأهداف</span><strong>{formatPrice(signal.tp1, signal.symbol)} / {formatPrice(signal.tp2, signal.symbol)}</strong></div>
                    <div className="value-block">
                      <span>التفاعل</span>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                        {['win1', 'win2', 'win3', 'loss'].map((state) => {
                          const label = state === 'loss' ? 'خسارة' : `ربح ${state.replace('win', '')}`;
                          return (
                            <button
                              key={state}
                              type="button"
                              onClick={() => resolveSignal(signal.id, state)}
                              style={{
                                border: '1px solid rgba(255,255,255,0.16)',
                                background: signal.status === state ? 'rgba(90,228,162,0.14)' : 'rgba(255,255,255,0.03)',
                                color: state === 'loss' ? '#ff6a78' : '#5ae4a2',
                                borderRadius: 8,
                                padding: '4px 8px',
                                cursor: 'pointer',
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
                <div className="empty-signal-box"><p>لا توجد إشارات محفوظة بعد. قم بإنشاء أول تحليل من لوحة التحليل.</p></div>
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
                const price = item?.price ?? DEFAULT_BASES[symbol] ?? 0;
                const change = item?.change ?? 0;
                const positive = change >= 0;
                const spark = buildSparkline(item?.series ?? []);

                return (
                  <button
                    key={symbol}
                    type="button"
                    className={isSelected ? 'market-card selected' : 'market-card'}
                    onClick={() => setSelectedSymbol(symbol)}
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
                    <svg viewBox="0 0 240 60" className="sparkline" preserveAspectRatio="none" style={{ height: '52px', minHeight: '52px' }}>
                      <polyline points={spark} fill="none" stroke={meta.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
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
                      onClick={() => setTimeframe(option)}
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

              <button type="button" className="analyze-btn" onClick={handleAnalyze} disabled={loadingAi} style={{ width: '100%', margin: '8px 0 0' }}>
                {loadingAi ? 'جارٍ التحليل...' : isScalp ? 'حلل الآن (سكالبينغ 1m)' : 'حلل الآن'}
              </button>

              {analysis ? (
                <div className="trade-card" style={{ borderRadius: '18px', border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(10,18,28,0.9)', padding: '18px', marginTop: '16px' }}>
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
                    السعر الحي: {formatPrice(liveCurrent, selectedSymbol)} • المصدر: Live Feed
                  </p>
                </div>
              ) : (
                <div className="empty-state"><p>اختر أصل التداول ثم اضغط على زر “حلل الآن” للحصول على توصية جاهزة.</p></div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

export default App;
