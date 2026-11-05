import { useEffect, useMemo, useState } from 'react';
import './trading.css';

const SYMBOLS = ['XAUUSD', 'BTCUSD', 'EURUSD', 'ETHUSD', 'NAS100'];
const LABELS = { XAUUSD: 'الذهب', BTCUSD: 'بيتكوين', EURUSD: 'اليورو/الدولار', ETHUSD: 'إيثيريوم', NAS100: 'ناسداك 100' };
const STORE = 'apex-ai-trader-signals-v1';
const money = (value, symbol) => Number.isFinite(Number(value)) ? `${symbol === 'EURUSD' ? '' : '$'}${Number(value).toLocaleString('en-US', { minimumFractionDigits: symbol === 'EURUSD' ? 5 : 2, maximumFractionDigits: symbol === 'EURUSD' ? 5 : 2 })}` : '—';

export default function App() {
  const [symbol, setSymbol] = useState('XAUUSD');
  const [mode, setMode] = useState('standard');
  const [timeframe, setTimeframe] = useState('5m');
  const [market, setMarket] = useState(null);
  const [marketError, setMarketError] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [signals, setSignals] = useState(() => { try { return JSON.parse(localStorage.getItem(STORE) || '[]'); } catch { return []; } });

  useEffect(() => { let alive = true; const refresh = async () => { try { const r = await fetch(`/api/market?symbols=${symbol}`, { cache: 'no-store' }); const data = await r.json(); if (!r.ok || !data.success) throw new Error(data.error || 'تعذر تحميل بيانات السوق'); if (alive) { setMarket(data.data[symbol]); setMarketError(''); } } catch (e) { if (alive) setMarketError(e.message); } }; refresh(); const timer = setInterval(refresh, 30_000); return () => { alive = false; clearInterval(timer); }; }, [symbol]);
  useEffect(() => { localStorage.setItem(STORE, JSON.stringify(signals)); }, [signals]);
  useEffect(() => { setResult(null); }, [symbol, mode, timeframe]);

  const analyze = async () => {
    if (!market?.candles) { setMarketError('لا توجد بيانات شموع حقيقية كافية للتحليل.'); return; }
    setBusy(true); setResult(null);
    try {
      const response = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol, mode, timeframe, candles: market.candles }) });
      const payload = await response.json(); if (!response.ok || !payload.success) throw new Error(payload.error || 'تعذر التحليل');
      setResult(payload);
      if (payload.approved && payload.trade) setSignals((old) => [{ id: `${Date.now()}`, symbol, direction: payload.trade.direction, entry: payload.trade.entry, status: 'open', score: payload.score, createdAt: new Date().toLocaleString() }, ...old].slice(0, 30));
    } catch (e) { setMarketError(e.message); } finally { setBusy(false); }
  };
  const setOutcome = (id, status) => setSignals((items) => items.map((item) => item.id === id ? { ...item, status } : item));
  const wins = useMemo(() => signals.filter((s) => ['win1', 'win2', 'win3'].includes(s.status)).length, [signals]);
  const totalClosed = useMemo(() => signals.filter((s) => s.status !== 'open').length, [signals]);
  const details = result?.timeframes;

  return <div className="app-shell" dir="rtl">
    <header className="topbar"><div><p className="eyebrow">محرك إشارات قائم على OHLC</p><h1>Apex AI Trader</h1><p className="muted">تحليل متعدد الفريمات • لا ينفذ أوامر تداول</p></div><div className="status-pill"><span className="live-dot" />{market ? `بيانات ${market.source} • ${new Date(market.updatedAt).toLocaleTimeString()}` : 'بانتظار بيانات السوق'}</div></header>
    <section className="controls panel"><label>الأصل<select value={symbol} onChange={(e) => setSymbol(e.target.value)}>{SYMBOLS.map((s) => <option key={s} value={s}>{LABELS[s]} ({s})</option>)}</select></label><label>النمط<select value={mode} onChange={(e) => setMode(e.target.value)}><option value="standard">تحليل متوازن</option><option value="scalp">سكالبينغ M1</option></select></label><label>إطار الإشارة<select value={timeframe} onChange={(e) => setTimeframe(e.target.value)}><option value="1m">M1</option><option value="5m">M5</option><option value="15m">M15</option></select></label><button className="analyze-btn" disabled={busy || !market} onClick={analyze}>{busy ? 'جارٍ التحليل…' : 'حلل السوق'}</button></section>
    {marketError && <p className="notice error">{marketError}</p>}
    <section className="market-strip panel"><div><span>الأصل</span><strong>{LABELS[symbol]} ({symbol})</strong></div><div><span>السعر</span><strong>{money(market?.price, symbol)}</strong></div><div><span>التغير التقريبي</span><strong className={Number(market?.change) >= 0 ? 'up' : 'down'}>{market ? `${market.change}%` : '—'}</strong></div><div><span>مصدر/توقيت السعر</span><strong>{market?.source || '—'} • {market?.updatedAt ? new Date(market.updatedAt).toLocaleTimeString() : '—'}</strong></div></section>
    {result && <><section className="result panel"><div className="result-heading"><div><p className="eyebrow">نتيجة التحليل</p><h2 className={result.signal === 'BUY' ? 'up' : result.signal === 'SELL' ? 'down' : ''}>{result.signal === 'WAIT' ? 'انتظار — لا توجد صفقة' : `${result.signal} • ${LABELS[symbol]}`}</h2></div><strong className="score">{result.score}<small>/100</small></strong></div><div className="progress"><span style={{ width: `${result.score}%` }} /></div><p className="muted">الحد الأدنى للدخول: {result.scoreThreshold}/100 • حالة السوق: {result.marketRegime}</p>
      {result.trade && <div className="trade-grid">{[['الدخول', result.trade.entry], ['وقف الخسارة ATR/بنية', result.trade.stopLoss], ['TP1 (1R)', result.trade.tp1], ['TP2 (2R)', result.trade.tp2], ['TP3 (3R)', result.trade.tp3], ['نقطة التعادل المقترحة', result.trade.breakEven]].map(([label, value]) => <div className="metric" key={label}><span>{label}</span><strong>{money(value, symbol)}</strong></div>)}</div>}
      <h3>الفريمات والمؤشرات</h3><div className="timeframe-grid">{Object.entries(details || {}).map(([tf, info]) => <article className="metric" key={tf}><h3>{tf}</h3>{Object.entries(info).map(([key, value]) => <p key={key}><span>{key}</span><strong>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</strong></p>)}</article>)}</div>
      <h3>التفسير والقيود</h3><ul className="reasons">{result.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul><p className="notice">{result.riskNotice}</p></section></>}
    <section className="panel history"><div className="result-heading"><h2>سجل الإشارات اليدوي</h2><span>نسبة الفوز بعد الإغلاق: {totalClosed ? `${(wins / totalClosed * 100).toFixed(1)}%` : '—'}</span></div>{signals.length ? signals.map((s) => <div className="history-row" key={s.id}><strong>{LABELS[s.symbol]} • {s.direction}</strong><span>{money(s.entry, s.symbol)} • {s.score}/100</span><div>{['win1', 'win2', 'win3', 'loss'].map((state) => <button key={state} className="small-btn" onClick={() => setOutcome(s.id, state)}>{state === 'loss' ? 'خسارة' : `ربح ${state.slice(-1)}`}</button>)}</div></div>) : <p className="muted">لا توجد إشارات معتمدة بعد.</p>}</section>
    <footer className="disclaimer">المؤشرات تُحسب من الشموع التي يوفرها مزود البيانات، وقد تكون متأخرة أو غير متاحة. لا يتم كشف الأخبار، أو الاتصال بحساب وسيط، أو تنفيذ أوامر/وقف تعادل/Trailing Stop تلقائياً. لا تعتمد على الإشارة وحدها لاتخاذ قرار مالي.</footer>
  </div>;
}
