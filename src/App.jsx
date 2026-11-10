import { useEffect, useMemo, useState } from 'react';
import './trading.css';

const SYMBOLS = ['XAUUSD', 'BTCUSD', 'EURUSD', 'ETHUSD', 'NAS100'];
const LABELS = { XAUUSD: 'الذهب', BTCUSD: 'بيتكوين', EURUSD: 'اليورو/الدولار', ETHUSD: 'إيثيريوم', NAS100: 'ناسداك 100' };
const TV_SYMBOLS = { XAUUSD: 'OANDA:XAUUSD', BTCUSD: 'BINANCE:BTCUSDT', EURUSD: 'OANDA:EURUSD', ETHUSD: 'BINANCE:ETHUSDT', NAS100: 'NASDAQ:NDX' };
const STORAGE_KEY = 'apex-ai-trader-signals-v1';
const money = (value, symbol) => Number.isFinite(Number(value)) ? `${symbol === 'EURUSD' ? '' : '$'}${Number(value).toLocaleString('en-US', { minimumFractionDigits: symbol === 'EURUSD' ? 5 : 2, maximumFractionDigits: symbol === 'EURUSD' ? 5 : 2 })}` : '—';

function TradingViewChart({ symbol, timeframe }) {
  const interval = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240' }[timeframe] || '5';
  const query = new URLSearchParams({ symbol: TV_SYMBOLS[symbol], interval, theme: 'dark', style: '1', locale: 'en', enable_publishing: 'false', hide_top_toolbar: 'false', hide_legend: 'false', withdateranges: 'true', allow_symbol_change: 'false', studies: 'EMA@tv-basicstudies,RSI@tv-basicstudies,Volume@tv-basicstudies' });
  return <div className="tv-chart"><iframe title={`TradingView ${symbol}`} src={`https://www.tradingview.com/widgetembed/?${query}`} loading="lazy" allow="clipboard-write; fullscreen" referrerPolicy="origin" /></div>;
}

export default function App() {
  const [symbol, setSymbol] = useState('XAUUSD');
  const [mode, setMode] = useState('standard');
  const [timeframe, setTimeframe] = useState('15m');
  const [market, setMarket] = useState(null);
  const [marketError, setMarketError] = useState('');
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(false);
  const [signals, setSignals] = useState(() => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; } });

  const fetchMarket = async (targetSymbol = symbol) => {
    const response = await fetch(`/api/market?symbols=${encodeURIComponent(targetSymbol)}`, { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(payload.error || 'تعذر تحميل بيانات السوق');
    return payload.data[targetSymbol];
  };

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try { const quote = await fetchMarket(symbol); if (active) { setMarket(quote); setMarketError(''); } }
      catch (error) { if (active) { setMarket(null); setMarketError(error.message); } }
    };
    refresh();
    const timer = setInterval(refresh, 60_000);
    return () => { active = false; clearInterval(timer); };
  }, [symbol]);
  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(signals)); }, [signals]);
  useEffect(() => { setAnalysis(null); }, [symbol, mode, timeframe]);

  const selectMode = (nextMode) => {
    setMode(nextMode);
    setTimeframe(nextMode === 'scalp' ? '1m' : '15m');
  };

  const analyze = async () => {
    setLoading(true); setMarketError(''); setAnalysis(null);
    try {
      const fresh = await fetchMarket(symbol);
      setMarket(fresh);
      if (!Number.isFinite(Number(fresh?.price)) || !fresh?.updatedAt) throw new Error('السعر غير متوفر أو لا يحمل توق��تاً صالحاً.');
      const response = await fetch('/api/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, mode, timeframe, candles: fresh.candles, livePrice: fresh.price, quoteUpdatedAt: fresh.updatedAt }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || 'تعذر إكمال تحليل Gemini');
      setAnalysis(payload);
      if (payload.approved && payload.trade) setSignals((old) => [{ id: `${Date.now()}`, symbol, direction: payload.trade.direction, entry: payload.trade.entry, status: 'open', score: payload.score, createdAt: new Date().toLocaleString() }, ...old].slice(0, 30));
    } catch (error) { setMarketError(error.message); }
    finally { setLoading(false); }
  };

  const resolve = (id, status) => setSignals((all) => all.map((item) => item.id === id ? { ...item, status } : item));
  const closed = useMemo(() => signals.filter((item) => item.status !== 'open'), [signals]);
  const wins = useMemo(() => closed.filter((item) => ['win1', 'win2', 'win3'].includes(item.status)).length, [closed]);

  return <div className="app-shell" dir="rtl">
    <header className="topbar"><div><p className="eyebrow">Apex AI Trader</p><h1>تحليل السوق بالذكاء الاصطناعي</h1><p className="muted">Gemini + بيانات OHLC من المزود • توصيات تحليلية فقط</p></div><div className="status-pill"><span className="live-dot" />{market ? `${market.source} • ${new Date(market.updatedAt).toLocaleTimeString()}` : 'بانتظار بيانات السوق'}</div></header>
    <section className="notice prominent-warning"><strong>مخاطر السوق:</strong> لا يوجد ضمان للدقة أو الربح أو التطابق مع MT5. لا يرسل النظام أوامر للوسيط. سرّع قرارك لا يعني أن مصدر البيانات لحظي؛ حداثته تعتمد على المزود والخطة.</section>
    <section className="mode-cards"><button className={mode === 'standard' ? 'mode-card active' : 'mode-card'} onClick={() => selectMode('standard')}><strong>التحليل المتوازن</strong><span>اتجاه وإعداد على M15</span></button><button className={mode === 'scalp' ? 'mode-card active' : 'mode-card'} onClick={() => selectMode('scalp')}><strong>السكالبينغ السريع</strong><span>إعداد على M1</span></button></section>
    <section className="controls panel"><label>الأصل<select value={symbol} onChange={(e) => setSymbol(e.target.value)}>{SYMBOLS.map((item) => <option key={item} value={item}>{LABELS[item]} ({item})</option>)}</select></label><label>فريم الدخول<select value={timeframe} onChange={(e) => setTimeframe(e.target.value)}><option value="1m">M1</option><option value="5m">M5</option><option value="15m">M15</option></select></label><button className="analyze-btn" disabled={loading || !market} onClick={analyze}>{loading ? 'جارٍ تحديث السوق والتحليل…' : 'حدّث السعر وحلل بـGemini'}</button></section>
    {marketError && <p className="notice error">{marketError}</p>}{market?.note && <p className="notice">{market.note}</p>}
    <section className="market-strip panel"><div><span>الأصل</span><strong>{LABELS[symbol]} ({symbol})</strong></div><div><span>السعر من المزود</span><strong>{money(market?.price, symbol)}</strong></div><div><span>المصدر</span><strong>{market?.source || '—'}</strong></div><div><span>وقت بيانات المزود</span><strong>{market?.updatedAt ? new Date(market.updatedAt).toLocaleTimeString() : '—'}</strong></div><div><span>بيانات OHLC</span><strong>{market?.tradableAnalysis ? 'متاحة' : 'غير متاحة'}</strong></div></section>
    <section className="panel chart-panel"><div className="result-heading"><div><p className="eyebrow">TradingView Advanced Chart</p><h2>{LABELS[symbol]} • {symbol}</h2></div><span className="muted">للمشاهدة فقط؛ لا يمرر widget بياناته إلى Gemini</span></div><TradingViewChart symbol={symbol} timeframe={timeframe}/></section>
    {analysis && <section className="result panel"><div className="result-heading"><div><p className="eyebrow">تحليل Gemini المقيّد ببيانات OHLC</p><h2 className={analysis.signal === 'BUY' ? 'up' : analysis.signal === 'SELL' ? 'down' : ''}>{analysis.signal === 'WAIT' ? 'انتظار — لا توجد صفقة' : `${analysis.signal} • ${LABELS[symbol]}`}</h2></div><strong className="score">{Number.isFinite(analysis.score) ? `${analysis.score}/100` : '—'}<small> نقاط فنية</small></strong></div><p className="muted">ثقة Gemini التحليلية: {analysis.aiConfidence ?? '—'}/100 (ليست احتمال ربح) • {analysis.marketRegime} • {analysis.selectedTimeframe}</p>{analysis.trade && <div className="trade-grid">{[['دخول',analysis.trade.entry],['وقف ديناميكي ATR/بنية',analysis.trade.stopLoss],['TP1 • 1.5R',analysis.trade.tp1],['TP2 • 2R',analysis.trade.tp2],['TP3 • 2.5R',analysis.trade.tp3],['نقطة التعادل المقترحة',analysis.trade.breakEven]].map(([label,value]) => <div className="metric" key={label}><span>{label}</span><strong>{money(value,symbol)}</strong></div>)}</div>}{analysis.ai && <p className="metric"><strong>{analysis.ai.rationale}</strong><span>{analysis.ai.setup}</span></p>}{analysis.scoreComponents?.[analysis.candidateDirection] && <><h3>تفاصيل التقييم</h3><div className="timeframe-grid">{Object.entries(analysis.scoreComponents[analysis.candidateDirection]).map(([key,value]) => <div className="metric" key={key}><span>{key}</span><strong>{value.earned}/{value.max} {value.passed ? '✓' : '—'}</strong></div>)}</div></>}{analysis.indicators && <div className="timeframe-grid">{Object.entries(analysis.indicators).map(([frame,values]) => <article className="metric" key={frame}><h3>{frame}</h3>{Object.entries(values).map(([key,value]) => <p key={key}><span>{key}</span><strong>{String(value)}</strong></p>)}</article>)}</div>}<ul className="reasons">{(analysis.reasons || []).map((reason,index) => <li key={index}>{reason}</li>)}</ul><p className="notice">{analysis.riskNotice}</p></section>}
    <section className="panel history"><div className="result-heading"><h2>سجل الإشارات (إغلاق يدوي)</h2><span>نسبة الفوز المعلّمة: {closed.length ? `${(wins / closed.length * 100).toFixed(1)}%` : '—'}</span></div>{signals.length ? signals.map((item) => <div className="history-row" key={item.id}><strong>{LABELS[item.symbol]} • {item.direction}</strong><span>{money(item.entry,item.symbol)} • {item.score}/100</span><div>{['win1','win2','win3','loss'].map((status) => <button className="small-btn" key={status} onClick={() => resolve(item.id,status)}>{status === 'loss' ? 'خسارة' : `ربح ${status.slice(-1)}`}</button>)}</div></div>) : <p className="muted">لا توجد إشارات معتمدة.</p>}</section>
    <footer className="disclaimer">Gemini يحلل البيانات المرسلة فقط؛ لا يعرف بيانات سوق أو أخبار مباشرة خارجها. مستويات المخاطرة محسوبة آلياً من ATR وبنية OHLC ويتم التحقق منها خادمياً. لا يعمل Breakeven أو trailing أو Stop Hunt على حساب وسيط؛ هذه توصيات/ملاحظات فقط. لا تعتمد على النظام وحده لاتخاذ قرارات مالية.</footer>
  </div>;
}
