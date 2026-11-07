const SYMBOLS = ['XAUUSD', 'BTCUSD', 'EURUSD', 'ETHUSD', 'NAS100'];
const MIN_BARS = { '1m': 60, '5m': 60, '15m': 205 };
const MIN_SIGNAL_SCORE = 60;
const WEIGHTS = { m15: 15, m5: 15, vwap: 10, ema: 10, sweep: 15, structure: 10, rsi: 10, adx: 5, candle: 5, atr: 5 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}; }
  catch { return res.status(400).json({ success: false, error: 'Invalid JSON body' }); }
  const symbol = String(body.symbol || '').toUpperCase(), mode = body.mode === 'scalp' ? 'scalp' : 'standard';
  const price = Number(body.livePrice), updatedAt = Number(body.quoteUpdatedAt), candles = body.candles;
  if (!SYMBOLS.includes(symbol)) return res.status(400).json({ success: false, error: 'Unsupported symbol' });
  const quoteValid = Number.isFinite(price) && price > 0 && Number.isFinite(updatedAt) && Date.now() - updatedAt <= 180_000 && updatedAt <= Date.now() + 30_000;
  const barsReady = candles && ['1m', '5m', '15m'].every((tf) => Array.isArray(candles[tf]) && candles[tf].length >= MIN_BARS[tf]);
  if (!quoteValid || !barsReady) return waitResponse(res, symbol, mode, quoteValid ? price : null, quoteValid ? updatedAt : null, !quoteValid ? 'السعر الفوري غير متوفر أو قديم.' : 'لا تتوفر شموع OHLC حقيقية مكتملة وكافية للفريمات المطلوبة.');
  try {
    const clean = Object.fromEntries(['1m', '5m', '15m'].map((tf) => [tf, sanitize(candles[tf])]));
    if (['1m', '5m', '15m'].some((tf) => clean[tf].length < MIN_BARS[tf])) return waitResponse(res, symbol, mode, price, updatedAt, 'الشموع المستلمة غير صالحة أو غير كافية.');
    if (Date.now() - (clean['1m'].at(-1)?.time || 0) > 180_000) return waitResponse(res, symbol, mode, price, updatedAt, 'أحدث شمعة M1 قديمة؛ لا يتم إصدار إشارة.');
    return res.status(200).json({ success: true, source: 'real spot OHLC technical analysis', ...analyze(symbol, mode, price, clean, updatedAt) });
  } catch (error) { return res.status(422).json({ success: false, error: error.message || 'Analysis failed' }); }
}

function waitResponse(res, symbol, mode, price, updatedAt, reason) {
  return res.status(200).json({ success: true, approved: false, signal: 'WAIT', score: null, scoreThreshold: MIN_SIGNAL_SCORE, symbol, mode, marketPrice: price, quoteUpdatedAt: updatedAt, marketRegime: 'غير محدد — بيانات حقيقية غير كافية', dataMode: 'NO_SIGNAL', trade: null, reasons: [reason, 'لم يتم توليد شموع أو نقاط اصطناعية.'], riskNotice: 'WAIT: لا توجد توصية تداول حتى تتوفر بيانات OHLC حقيقية وحديثة.' });
}
function sanitize(items) { return items.slice(-2000).map((c) => ({ time: Number(c.time), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume) || 0 })).filter((c) => Number.isFinite(c.time) && [c.open,c.high,c.low,c.close].every((v) => Number.isFinite(v) && v > 0) && c.high >= Math.max(c.open,c.close) && c.low <= Math.min(c.open,c.close)).sort((a,b) => a.time-b.time); }
function analyze(symbol, mode, price, candles, quoteUpdatedAt) {
 const bars=Object.fromEntries(['1m','5m','15m'].map(tf=>[tf,candles[tf].slice(0,-1)])); if(bars['15m'].length<200||bars['5m'].length<50||bars['1m'].length<50)throw Error('Insufficient completed real OHLC candles.');
 const i1=indicators(bars['1m']),i5=indicators(bars['5m']),i15=indicators(bars['15m']),last=bars['1m'].at(-1),structure=swingState(bars['5m']);
 const up15=i15.e50>i15.e200&&i15.adx>=15,down15=i15.e50<i15.e200&&i15.adx>=15,up5=i5.e50>i5.e200&&i5.e9>i5.e21,down5=i5.e50<i5.e200&&i5.e9<i5.e21;
 const pullback=Math.min(Math.abs(price-i1.e21),Math.abs(price-i5.vwap))<=i1.atr*.8,up1=i1.e9>i1.e21&&i1.rsi>=50&&i1.rsi<=75&&i1.supertrend==='BUY'&&last.close>last.open,down1=i1.e9<i1.e21&&i1.rsi<=50&&i1.rsi>=25&&i1.supertrend==='SELL'&&last.close<last.open;
 const abnormal=i1.atr/Math.max(median(atrSeries(bars['1m']).slice(-100)),1e-12)>2.5,regime=abnormal?'تقلب مرتفع وغير طبيعي':i15.adx<15?'سوق عرضي':up15?'اتجاه صاعد':down15?'اتجاه هابط':'غير واضح';
 const scoreFor=buy=>{const c={m15:buy?up15:down15,m5:buy?up5:down5,vwap:buy?price>i5.vwap:price<i5.vwap,ema:buy?i1.e9>i1.e21:i1.e9<i1.e21,sweep:structure.sweep===(buy?'BUY':'SELL'),structure:structure.direction===(buy?'BUY':'SELL'),rsi:buy?i1.rsi>=50&&i1.rsi<=75:i1.rsi<=50&&i1.rsi>=25,adx:i15.adx>=20,candle:candleStrength(last,i1.atr,buy?'BUY':'SELL')>=.45,atr:i1.atr>0&&!abnormal};return Object.keys(WEIGHTS).reduce((s,k)=>s+(c[k]?WEIGHTS[k]:0),0)};
 const buyScore=scoreFor(true),sellScore=scoreFor(false),direction=buyScore>=sellScore?'BUY':'SELL',score=Math.max(buyScore,sellScore),aligned=direction==='BUY'?up15&&up5&&price>i5.vwap&&pullback&&(structure.sweep==='BUY'||structure.direction==='BUY')&&up1:down15&&down5&&price<i5.vwap&&pullback&&(structure.sweep==='SELL'||structure.direction==='SELL')&&down1,approved=aligned&&score>=MIN_SIGNAL_SCORE&&!abnormal&&i15.adx>=15;
 const reasons=[];if(!aligned)reasons.push('شروط توافق M15/M5 والسعر الفوري والتصحيح وبنية السوق وتأكيد M1 غير مكتملة.');if(score<MIN_SIGNAL_SCORE)reasons.push(`النقاط ${score}/100 أقل من ${MIN_SIGNAL_SCORE}.`);if(abnormal)reasons.push('تم إيقاف الإشارة بسبب تقلب غير طبيعي.');if(i15.adx<15)reasons.push('السوق عرضي؛ ADX أقل من 15.');
 const swing=direction==='BUY'?Math.min(...bars['1m'].slice(-20).map(c=>c.low)):Math.max(...bars['1m'].slice(-20).map(c=>c.high)),distance=Math.max(i1.atr*(mode==='scalp'?1.5:2),direction==='BUY'?price-swing:swing-price,i1.atr*.25),stop=round(direction==='BUY'?price-distance:price+distance,symbol),risk=Math.abs(price-stop);
 const trade=approved?{direction,entry:round(price,symbol),stopLoss:stop,tp1:round(price+(direction==='BUY'?1:-1)*risk,symbol),tp2:round(price+(direction==='BUY'?1:-1)*risk*2,symbol),tp3:round(price+(direction==='BUY'?1:-1)*risk*3,symbol),breakEven:round(price,symbol),confidence:score,lotSize:null}:null;
 return{approved,signal:approved?direction:'WAIT',score,scoreThreshold:MIN_SIGNAL_SCORE,mode,symbol,marketPrice:round(price,symbol),quoteUpdatedAt,marketRegime:regime,dataMode:'REAL_OHLC',reasons:approved?['توافق فني على بيانات OHLC الحقيقية والسعر الفوري.']:reasons,trade,indicators:{M15:{ema50:n(i15.e50),ema200:n(i15.e200),adx14:n(i15.adx)},M5:{ema9:n(i5.e9),ema21:n(i5.e21),ema50:n(i5.e50),vwap:n(i5.vwap),liquiditySweep:structure.sweep,structure:structure.direction},M1:{ema9:n(i1.e9),ema21:n(i1.e21),rsi7:n(i1.rsi),atr14:n(i1.atr),supertrend:i1.supertrend}},riskNotice:'تحليل فني وليس تنفيذاً أو ضماناً للربح. دقة البيانات وتوفرها يعتمدان على مزود السوق.'};
}
function indicators(b){const c=b.map(x=>x.close),a=atrSeries(b);return{e9:ema(c,9),e21:ema(c,21),e50:ema(c,50),e200:ema(c,200),rsi:rsi(c,7),adx:adx(b,14),atr:a.at(-1),vwap:vwap(b),supertrend:supertrend(b,a)}}
function ema(v,p){let x=v[0],k=2/(p+1);for(let i=1;i<v.length;i++)x+=(v[i]-x)*k;return x}
function rsi(v,p){let g=0,l=0;for(let i=v.length-p;i<v.length;i++){let d=v[i]-v[i-1];if(d>0)g+=d;else l-=d}return l===0?100:100-100/(1+g/l)}
function atrSeries(b){const tr=b.map((c,i)=>Math.max(c.high-c.low,i?Math.abs(c.high-b[i-1].close):0,i?Math.abs(c.low-b[i-1].close):0));return tr.map((_,i)=>tr.slice(Math.max(0,i-13),i+1).reduce((a,x)=>a+x,0)/Math.min(i+1,14))}
function adx(b,p){let plus=0,minus=0,total=0;for(let i=b.length-p;i<b.length;i++){let u=b[i].high-b[i-1].high,d=b[i-1].low-b[i].low;plus+=u>d&&u>0?u:0;minus+=d>u&&d>0?d:0;total+=Math.max(b[i].high-b[i].low,Math.abs(b[i].high-b[i-1].close),Math.abs(b[i].low-b[i-1].close))}let x=total?100*plus/total:0,y=total?100*minus/total:0;return x+y?100*Math.abs(x-y)/(x+y):0}
function vwap(b){const date=new Date(b.at(-1).time).toISOString().slice(0,10),s=b.filter(x=>new Date(x.time).toISOString().slice(0,10)===date);let pv=0,v=0;for(const x of s){const q=x.volume>0?x.volume:1;pv+=(x.high+x.low+x.close)/3*q;v+=q}return pv/v}
function supertrend(b,a){let d='BUY',u=0,l=0;for(let i=10;i<b.length;i++){const m=(b[i].high+b[i].low)/2,hi=m+3*a[i],lo=m-3*a[i];u=hi<u||b[i-1].close>u?hi:u;l=lo>l||b[i-1].close<l?lo:l;if(b[i].close>u)d='BUY';else if(b[i].close<l)d='SELL'}return d}
function swingState(b){const w=b.slice(-31,-1),x=b.at(-1),h=Math.max(...w.map(c=>c.high)),l=Math.min(...w.map(c=>c.low));return{sweep:x.low<l&&x.close>l?'BUY':x.high>h&&x.close<h?'SELL':'NONE',direction:x.close>h?'BUY':x.close<l?'SELL':'NONE'}}
function candleStrength(c,a,d){const r=c.high-c.low;return r?(d==='BUY'?c.close-c.low:c.high-c.close)/Math.max(r,1e-12)*r/Math.max(a,1e-12):0}
function median(a){const s=[...a].sort((x,y)=>x-y);return s.length?s[Math.floor(s.length/2)]:0}
function n(x){return Number.isFinite(x)?Number(x.toFixed(6)):null}
function round(x,s){return Number(x.toFixed(s==='EURUSD'?5:2))}
