import { useEffect, useMemo, useState } from 'react';
import './trading.css';

const SYMBOLS = ['XAUUSD', 'BTCUSD', 'EURUSD', 'ETHUSD', 'NAS100'];
const LABELS = { XAUUSD: 'الذهب', BTCUSD: 'بيتكوين', EURUSD: 'اليورو/الدولار', ETHUSD: 'إيثيريوم', NAS100: 'ناسداك 100' };
const TV_SYMBOLS = { XAUUSD: 'OANDA:XAUUSD', BTCUSD: 'BINANCE:BTCUSDT', EURUSD: 'OANDA:EURUSD', ETHUSD: 'BINANCE:ETHUSDT', NAS100: 'NASDAQ:NDX' };
const STORE = 'apex-ai-trader-signals-v1';
const MARKET_REFRESH_MS = 60_000;
const money = (value, symbol) => Number.isFinite(Number(value)) ? `${symbol === 'EURUSD' ? '' : '$'}${Number(value).toLocaleString('en-US', { minimumFractionDigits: symbol === 'EURUSD' ? 5 : 2, maximumFractionDigits: symbol === 'EURUSD' ? 5 : 2 })}` : '—';

function TradingViewChart({ symbol, timeframe }) {
  const interval = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240' }[timeframe] || '5';
  const params = new URLSearchParams({ symbol: TV_SYMBOLS[symbol], interval, theme: 'dark', style: '1', locale: 'en', toolbarbg: '#0d1926', enable_publishing: 'false', hide_top_toolbar: 'false', hide_legend: 'false', save_image: 'false', withdateranges: 'true', allow_symbol_change: 'false', details: 'false', hotlist: 'false', calendar: 'false', studies: 'EMA@tv-basicstudies,RSI@tv-basicstudies,Volume@tv-basicstudies' });
  return <div className="tv-chart"><iframe title={`TradingView live chart ${symbol}`} src={`https://www.tradingview.com/widgetembed/?${params}`} loading="lazy" allow="clipboard-write; fullscreen" referrerPolicy="origin" /></div>;
}

export default function App() {
  const [symbol, setSymbol] = useState('XAUUSD');
  const [mode, setMode] = useState('standard');
  const [timeframe, setTimeframe] = useState('5m');
  const [market, setMarket] = useState(null);
  const [marketError, setMarketError] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [signals, setSignals] = useState(() => { try { return JSON.parse(localStorage.getItem(STORE) || '[]'); } catch { return []; } });

  const refreshMarket = async (targetSymbol = symbol) => {
    const response = await fetch(`/api/market?symbols=${targetSymbol}`, { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(payload.error || 'تعذر تحميل بيانات السوق');
    return payload.data[targetSymbol];
  };

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const quote = await refreshMarket(symbol);
        if (active) { setMarket(quote); setMarketError(''); }
      } catch (error) { if (active) { setMarket(null); setMarketError(error.message); } }
    };
    refresh(); const timer = setInterval(refresh, MARKET_REFRESH_MS);
    return () => { active = false; clearInterval(timer); };
  }, [symbol]);
  useEffect(() => { localStorage.setItem(STORE, JSON.stringify(signals)); }, [signals]);
  useEffect(() => { setResult(null); }, [symbol, mode, timeframe]);

  const analyze = async () => {
    setBusy(true); setMarketError(''); setResult(null);
    try {
      // Refresh immediately on click; scheduled polling alone could leave the displayed quote stale.
      const freshMarket = await refreshMarket(symbol);
      setMarket(freshMarket);
      if (!Number.isFinite(Number(freshMarket?.price)) || !freshMarket?.updatedAt) throw new Error('لا يوجد سعر سوق حديث.');
      const response = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol, mode, timeframe, candles: freshMarket.candles, livePrice: freshMarket.price, quoteUpdatedAt: freshMarket.updatedAt }) });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || 'تعذر التحليل');
      setResult(payload);
      if (payload.approved && payload.trade) setSignals((old) => [{ id: `${Date.now()}`, symbol, direction: payload.trade.direction, entry: payload.trade.entry, status: 'open', score: payload.score, createdAt: new Date().toLocaleString() }, ...old].slice(0, 30));
    } catch (error) { setMarketError(error.message); }
    finally { setBusy(false); }
  };
  const outcome = (id, status) => setSignals((items) => items.map((item) => item.id === id ? { ...item, status } : item));
  const wins = useMemo(() => signals.filter((item) => ['win1', 'win2', 'win3'].includes(item.status)).length, [signals]);
  const closed = useMemo(() => signals.filter((item) => item.status !== 'open').length, [signals]);

  return <div className="app-shell" dir="rtl">
    <header className="topbar"><div><p className="eyebrow">Apex AI Trader</p><h1>لوحة السوق والتحليل</h1><p className="muted">تحديث عند الطلب • الإشارة تعتمد على شموع OHLC حقيقية</p></div><div className="status-pill"><span className="live-dot" />{market ? `${market.source} • ${new Date(market.updatedAt).toLocaleTimeString()}` : 'بانتظار بيانات السوق'}</div></header>
    <section className="notice error prominent-warning"><strong>تنبيه بيانات:</strong> لا يمكن ضمان تحديث لحظي أو تطابق تام مع MT5؛ يعتمد السعر على خطة مزود البيانات وتوقيت شموعه. التقلب المرتفع يزيد المخاطر، لكنه لا يحظر الإشارة تلقائياً.</section>
    <section className="controls panel"><label>الأصل<select value={symbol} onChange={(event) => setSymbol(event.target.value)}>{SYMBOLS.map((item) => <option key={item} value={item}>{LABELS[item]} ({item})</option>)}</select></label><label>النمط<select value={mode} onChange={(event) => setMode(event.target.value)}><option value="standard">تحليل متوازن</option><option value="scalp">سكالبينغ M1</option></select></label><label>فريم التحليل<select value={timeframe} onChange={(event) => setTimeframe(event.target.value)}>{[['1m','M1'],['5m','M5'],['15m','M15']].map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label><button className="analyze-btn" disabled={busy || !market} onClick={analyze}>{busy ? 'جارٍ تحديث السوق والتحليل…' : 'حدّث السعر وحلل الآن'}</button></section>
    {marketError && <p className="notice error">{marketError}</p>}{market?.note && <p className="notice">{market.note}</p>}
    <section className="market-strip panel"><div><span>الأصل</span><strong>{LABELS[symbol]} ({symbol})</strong></div><div><span>السعر</span><strong>{money(market?.price, symbol)}</strong></div><div><span>المصدر</span><strong>{market?.source || '—'}</strong></div><div><span>آخر تحديث</span><strong>{market?.updatedAt ? new Date(market.updatedAt).toLocaleTimeString() : '—'}</strong></div><div><span>OHLC حقيقي</span><strong>{market?.tradableAnalysis ? 'متاح' : 'غير متاح — WAIT'}</strong></div></section>
    <section className="panel chart-panel"><div className="result-heading"><div><p className="eyebrow">TradingView Advanced Chart</p><h2>{LABELS[symbol]} • {symbol}</h2></div><span className="muted">عرض بصري فقط، لا يغذي التحليل تلقائياً</span></div><TradingViewChart symbol={symbol} timeframe={timeframe} /><p className="muted">قد تختلف بيانات الشارت المرئي عن مصدر OHLC أو الوسيط.</p></section>
    {result && <section className="result panel"><div className="result-heading"><div><p className="eyebrow">نتيجة التحليل</p><h2 className={result.signal === 'BUY' ? 'up' : result.signal === 'SELL' ? 'down' : ''}>{result.signal === 'WAIT' ? 'انتظار — لا توجد صفقة' : `${result.signal} • ${LABELS[symbol]}`}</h2></div><strong className="score">{Number.isFinite(result.score) ? `${result.score}/100` : '—'}</strong></div><p className="muted">السعر المستخدم: {money(result.marketPrice, symbol)} • الفريم: {result.selectedTimeframe} • الحالة: {result.marketRegime}</p>{result.trade && <div className="trade-grid">{[['دخول',result.trade.entry],['وقف الخسارة',result.trade.stopLoss],['TP1',result.trade.tp1],['TP2',result.trade.tp2],['TP3',result.trade.tp3]].map(([label,value]) => <div className="metric" key={label}><span>{label}</span><strong>{money(value,symbol)}</strong></div>)}</div>}{result.indicators && <div className="timeframe-grid">{Object.entries(result.indicators).map(([tf,values]) => <article className="metric" key={tf}><h3>{tf}</h3>{Object.entries(values).map(([key,value]) => <p key={key}><span>{key}</span><strong>{String(value)}</strong></p>)}</article>)}</div>}<ul className="reasons">{(result.reasons || []).map((reason,index) => <li key={index}>{reason}</li>)}</ul><p className="notice">{result.riskNotice}</p></section>}
    <section className="panel history"><div className="result-heading"><h2>سجل الإشارات</h2><span>نسبة الفوز بعد الإغلاق: {closed ? `${(wins / closed * 100).toFixed(1)}%` : '—'}</span></div>{signals.length ? signals.map((item) => <div className="history-row" key={item.id}><strong>{LABELS[item.symbol]} • {item.direction}</strong><span>{money(item.entry,item.symbol)} • {item.score}/100</span><div>{['win1','win2','win3','loss'].map((state) => <button className="small-btn" key={state} onClick={() => outcome(item.id,state)}>{state === 'loss' ? 'خسارة' : `ربح ${state.slice(-1)}`}</button>)}</div></div>) : <p className="muted">لا توجد إشارات معتمدة.</p>}</section>
    <footer className="disclaimer">التحليل لا ينفذ أوامر ولا يضمن الربح. لا يتم حظر الإشارة بسبب ATR، لكنه يُستخدم في حساب الوقف والأهداف وتوضيح المخاطر. مزود البيانات وخطته يحددان حداثة الأسعار والشموع؛ لا توجد خدمة تضمن تطابق MT5 أو زمن استجابة صفرياً.</footer>
  </div>;
}
