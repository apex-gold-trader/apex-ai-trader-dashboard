const WEIGHTS = { m15: 15, m5: 15, vwap: 10, ema: 10, sweep: 15, structure: 10, rsi: 10, adx: 5, candle: 5, atr: 5 };
const SYMBOLS = ['XAUUSD', 'BTCUSD', 'EURUSD', 'ETHUSD', 'NAS100'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}; } catch { return res.status(400).json({ success: false, error: 'Invalid JSON body' }); }
  const symbol = String(body.symbol || '').toUpperCase(), mode = body.mode === 'scalp' ? 'scalp' : 'standard';
  const candles = body.candles;
  const livePrice = Number(body.livePrice);
  const quoteUpdatedAt = Number(body.quoteUpdatedAt);
  if (!SYMBOLS.includes(symbol)) return res.status(400).json({ success: false, error: 'Unsupported symbol' });
  if (!Number.isFinite(livePrice) || livePrice <= 0 || !Number.isFinite(quoteUpdatedAt) || Date.now() - quoteUpdatedAt > 180_000 || quoteUpdatedAt > Date.now() + 30_000) return res.status(422).json({ success: false, error: 'A current, timestamped spot quote is required. Refresh prices; no fallback price is allowed.' });
  if (!candles || !['1m', '5m', '15m'].every((tf) => Array.isArray(candles[tf]) && candles[tf].length >= (tf === '15m' ? 205 : 60))) return res.status(422).json({ success: false, error: 'Fresh 1m/5m/15m spot candles are required. No signal generated.' });
  try {
    const clean = Object.fromEntries(['1m', '5m', '15m'].map((tf) => [tf, sanitize(candles[tf])]));
    const result = analyze(symbol, mode, livePrice, clean);
    return res.status(200).json({ success: true, source: 'spot-OHLC deterministic analysis', ...result });
  } catch (error) { return res.status(422).json({ success: false, error: error.message || 'Analysis failed' }); }
}
function sanitize(items) { return items.slice(-2000).map((c) => ({ time: Number(c.time), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume) || 0 })).filter((c) => Number.isFinite(c.time) && [c.open,c.high,c.low,c.close].every((v) => Number.isFinite(v) && v > 0) && c.high >= Math.max(c.open,c.close) && c.low <= Math.min(c.open,c.close)).sort((a,b) => a.time-b.time); }
function analyze(symbol, mode, price, candles) {
  const bars = Object.fromEntries(['1m','5m','15m'].map((tf) => [tf, candles[tf].slice(0,-1)]));
  if (bars['15m'].length < 200 || bars['5m'].length < 50 || bars['1m'].length < 50) throw new Error('Insufficient completed candles for multi-timeframe analysis.');
  const i1 = metrics(bars['1m']), i5 = metrics(bars['5m']), i15 = metrics(bars['15m']), last = bars['1m'].at(-1);
  const structure = swingState(bars['5m']);
  const up15 = i15.e50 > i15.e200 && i15.adx >= 15, down15 = i15.e50 < i15.e200 && i15.adx >= 15;
  const up5 = i5.e50 > i5.e200 && i5.e9 > i5.e21, down5 = i5.e50 < i5.e200 && i5.e9 < i5.e21;
  const pullback = Math.min(Math.abs(price-i1.e21),Math.abs(price-i5.vwap)) <= i1.atr*.8;
  const up1 = i1.e9 > i1.e21 && i1.rsi >= 50 && i1.rsi <= 75 && i1.st === 'BUY' && last.close > last.open;
  const down1 = i1.e9 < i1.e21 && i1.rsi <= 50 && i1.rsi >= 25 && i1.st === 'SELL' && last.close < last.open;
  const abnormal = i1.atr / Math.max(median(atrSeries(bars['1m']).slice(-100)),1e-12) > 2.5;
  const regime = abnormal ? 'تقلب مرتفع وغير طبيعي' : i15.adx < 15 ? 'سوق عرضي' : up15 ? 'اتجاه ص��عد قوي' : down15 ? 'اتجاه هابط قوي' : 'غير واضح';
  const scoreFor = (buy) => { const flags = { m15: buy?up15:down15, m5: buy?up5:down5, vwap: buy?price>i5.vwap:price<i5.vwap, ema: buy?i1.e9>i1.e21:i1.e9<i1.e21, sweep: buy?structure.sweep==='BUY':structure.sweep==='SELL', structure: buy?structure.direction==='BUY':structure.direction==='SELL', rsi: buy?i1.rsi>=50&&i1.rsi<=75:i1.rsi<=50&&i1.rsi>=25, adx:i15.adx>=20, candle: buy?strength(last,i1.atr,'BUY')>=.45:strength(last,i1.atr,'SELL')>=.45, atr:i1.atr>0&&!abnormal }; return Object.keys(WEIGHTS).reduce((sum,k)=>sum+(flags[k]?WEIGHTS[k]:0),0); };
  const buy=scoreFor(true), sell=scoreFor(false), direction=buy>=sell?'BUY':'SELL', score=Math.max(buy,sell);
  const aligned = direction==='BUY' ? up15&&up5&&price>i5.vwap&&pullback&&(structure.sweep==='BUY'||structure.direction==='BUY')&&up1 : down15&&down5&&price<i5.vwap&&pullback&&(structure.sweep==='SELL'||structure.direction==='SELL')&&down1;
  const approved = aligned && score>=75 && !abnormal && i15.adx>=15;
  const reasons = [];
  if (!aligned) reasons.push('��روط توافق M15/M5 والسعر الفوري والتصحيح وبنية السوق وتأكيد M1 غير مكتملة.');
  if (score<75) reasons.push(`النقاط ${score}/100 أقل من 75.`);
  if (abnormal) reasons.push('تم إيقاف الإشارة بسبب تقلب غير طبيعي.');
  if (i15.adx<15) reasons.push('السوق عرضي؛ ADX أقل من 15.');
  if (!approved) reasons.push('تحقق من الأخبار الاقتصادية يدوياً؛ بيانات الأخبار غير متاحة للمحرك.');
  const entry = price, swing = direction==='BUY' ? Math.min(...bars['1m'].slice(-20).map(c=>c.low)) : Math.max(...bars['1m'].slice(-20).map(c=>c.high));
  const distance = Math.max(i1.atr*(mode==='scalp'?1.5:2),direction==='BUY'?entry-swing:swing-entry,i1.atr*.25), stopLoss = round(direction==='BUY'?entry-distance:entry+distance,symbol), risk=Math.abs(entry-stopLoss);
  const trade = approved ? { direction, entry:round(entry,symbol), stopLoss, tp1:round(entry+(direction==='BUY'?1:-1)*risk,symbol), tp2:round(entry+(direction==='BUY'?1:-1)*risk*2,symbol), tp3:round(entry+(direction==='BUY'?1:-1)*risk*3,symbol), breakEven:round(entry,symbol), confidence:score, lotSize:null, reason:'الإشارة مبنية على السعر الفوري المرسل والتحقق من توافق بيانات OHLC متعددة الفريمات.' } : null;
  return { approved, signal:approved?direction:'WAIT', score, scoreThreshold:75, mode, symbol, marketPrice:round(price,symbol), quoteUpdatedAt, marketRegime:regime, reasons:approved?[trade.reason]:reasons, checks:{buy,sell,pullback}, timeframes:{M15:{trend:up15?'UP':down15?'DOWN':'RANGE',ema50:n(i15.e50),ema200:n(i15.e200),adx14:n(i15.adx)},M5:{trend:up5?'UP':down5?'DOWN':'MIXED',vwap:n(i5.vwap),structure:structure.direction,liquiditySweep:structure.sweep,support:n(structure.low),resistance:n(structure.high)},M1:{entryPrice:n(price),ema9:n(i1.e9),ema21:n(i1.e21),rsi7:n(i1.rsi),supertrend:i1.st,atr14:n(i1.atr),tickVolume:last.volume}},trade,riskNotice:'الإشارة تحليلية وليست تنفيذاً. المصدر قد يختلف عن وسيطك؛ لا ضمان للتطابق أو الربح. لا يوجد تنفيذ وسيط أو إدارة مخاطر الحساب.' };
}
function metrics(b){const c=b.map(x=>x.close),a=atrSeries(b),atr=a.at(-1);return{e9:ema(c,9),e21:ema(c,21),e50:ema(c,50),e200:ema(c,200),rsi:rsi(c,7),adx:adx(b,14),atr,vwap:vwap(b),st:supertrend(b,a)};}
function ema(v,p){let x=v[0],k=2/(p+1);for(let i=1;i<v.length;i++)x+=(v[i]-x)*k;return x;}
function rsi(v,p){let g=0,l=0;for(let i=v.length-p;i<v.length;i++){let d=v[i]-v[i-1];if(d>0)g+=d;else l-=d;}return l===0?100:100-100/(1+g/l);}
function atrSeries(b){let tr=b.map((x,i)=>Math.max(x.high-x.low,i?Math.abs(x.high-b[i-1].close):0,i?Math.abs(x.low-b[i-1].close):0));return tr.map((_,i)=>tr.slice(Math.max(0,i-13),i+1).reduce((a,c)=>a+c,0)/Math.min(i+1,14));}
function adx(b,p){let plus=0,minus=0,tr=0;for(let i=b.length-p;i<b.length;i++){let u=b[i].high-b[i-1].high,d=b[i-1].low-b[i].low;plus+=u>d&&u>0?u:0;minus+=d>u&&d>0?d:0;tr+=Math.max(b[i].high-b[i].low,Math.abs(b[i].high-b[i-1].close),Math.abs(b[i].low-b[i-1].close));}let pdi=tr?100*plus/tr:0,mdi=tr?100*minus/tr:0;return pdi+mdi?100*Math.abs(pdi-mdi)/(pdi+mdi):0;}
function vwap(b){let date=new Date(b.at(-1).time).toISOString().slice(0,10),s=b.filter(x=>new Date(x.time).toISOString().slice(0,10)===date),pv=0,v=0;for(const x of s){let q=x.volume>0?x.volume:1;pv+=(x.high+x.low+x.close)/3*q;v+=q;}return pv/v;}
function supertrend(b,a){let d='BUY',u=0,l=0;for(let i=10;i<b.length;i++){let m=(b[i].high+b[i].low)/2,bu=m+3*a[i],bl=m-3*a[i];u=bu<u||b[i-1].close>u?bu:u;l=bl>l||b[i-1].close<l?bl:l;if(b[i].close>u)d='BUY';else if(b[i].close<l)d='SELL';}return d;}
function swingState(b){let w=b.slice(-31,-1),last=b.at(-1),h=Math.max(...w.map(x=>x.high)),l=Math.min(...w.map(x=>x.low));return{sweep:last.low<l&&last.close>l?'BUY':last.high>h&&last.close<h?'SELL':'NONE',direction:last.close>h?'BUY':last.close<l?'SELL':'NONE',low:l,high:h};}
function strength(c,atr,d){let range=c.high-c.low;return range?(d==='BUY'?(c.close-c.low):(c.high-c.close))/Math.max(range,1e-12)*(range/Math.max(atr,1e-12)):0;}
function median(a){let s=[...a].sort((x,y)=>x-y);return s.length?s[Math.floor(s.length/2)]:0;}
function n(x){return Number.isFinite(x)?Number(x.toFixed(6)):null;}
function round(x,s){return Number(x.toFixed(s==='EURUSD'?5:2));}
