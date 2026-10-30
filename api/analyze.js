export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const body = parseJsonBody(req.body);
    const symbol = String(body.symbol || 'XAUUSD');
    const timeframe = String(body.timeframe || '1m');
    const mode = String(body.mode || 'standard');
    const market = body.current || {};
    const price = Number(market.price ?? 0);
    const indicators = market.indicators || {};
    const rsi = Number(indicators.rsi ?? 50);
    const emaShort = Number(indicators.emaShort ?? price);
    const emaLong = Number(indicators.emaLong ?? price);
    const macd = Number(indicators.macd ?? 0);
    const bollingerUpper = Number(indicators.bollingerUpper ?? price);
    const bollingerLower = Number(indicators.bollingerLower ?? price);

    const apiKey = normalizeApiKey(process.env.GEMINI_API_KEY);
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is missing');
    }

    const useAuthHeader = /^AQ\./.test(apiKey);
    const baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';
    const requestUrl = useAuthHeader ? baseUrl : `${baseUrl}?key=${encodeURIComponent(apiKey)}`;

    const headers = {
      'Content-Type': 'application/json',
      ...(useAuthHeader ? { Authorization: `Bearer ${apiKey}` } : {}),
    };

    const systemPrompt = buildPrompt({
      symbol,
      timeframe,
      mode,
      price,
      rsi,
      emaShort,
      emaLong,
      macd,
      bollingerUpper,
      bollingerLower,
    });

    const geminiResponse = await fetch(requestUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: systemPrompt }],
          },
        ],
        generationConfig: {
          temperature: 0.15,
          topP: 0.9,
          topK: 32,
          maxOutputTokens: 512,
        },
      }),
    });

    const responseText = await geminiResponse.text();
    let parsedApiResponse = {};
    try {
      parsedApiResponse = responseText ? JSON.parse(responseText) : {};
    } catch {
      parsedApiResponse = {};
    }

    if (!geminiResponse.ok) {
      const message = parsedApiResponse?.error?.message || responseText || `Gemini API responded with status ${geminiResponse.status}`;
      throw new Error(message);
    }

    const extracted = extractGeminiText(parsedApiResponse);
    if (!extracted) {
      throw new Error('Gemini returned an empty response');
    }

    const cleanJson = extractJsonObject(extracted);
    if (!cleanJson) {
      throw new Error('Gemini response was not valid JSON');
    }

    const trade = normalizeTrade({
      parsed: cleanJson,
      symbol,
      timeframe,
      mode,
      price,
      rsi,
      emaShort,
      emaLong,
      macd,
      bollingerUpper,
      bollingerLower,
    });

    return res.status(200).json({
      success: true,
      trade,
      ...trade,
    });
  } catch (error) {
    return res.status(200).json({
      success: false,
      error: error?.message || 'Gemini analysis failed',
    });
  }
}

function parseJsonBody(rawBody) {
  if (!rawBody) return {};
  if (typeof rawBody === 'string') {
    try {
      return JSON.parse(rawBody);
    } catch {
      return {};
    }
  }
  return rawBody;
}

function normalizeApiKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('Bearer ')) return raw.replace(/^Bearer\s+/i, '').trim();
  return raw;
}

function buildPrompt({ symbol, timeframe, mode, price, rsi, emaShort, emaLong, macd, bollingerUpper, bollingerLower }) {
  return `
أنت محلل فني احترافي للأسواق المالية. مهم جداً: لا تُحِدَّ أو تُحَوّل القرار إلى BUY فقط أو SELL فقط. القرار يجب أن يكون حرّاً تماماً وفق السوق والهيكل والـ momentum وكسر السيولة، وليس وفق انحياز مسبق.

بيانات السوق:
- الأصل: ${symbol}
- الإطار الزمني: ${timeframe}
- النمط: ${mode}
- السعر الحالي: ${price}
- RSI: ${rsi}
- EMA قصيرة: ${emaShort}
- EMA طويلة: ${emaLong}
- MACD: ${macd}
- Bollinger Upper: ${bollingerUpper}
- Bollinger Lower: ${bollingerLower}

مهم:
1) اختر direction بحرية وفق تحليل السوق الحقيقي: BUY أو SELL.
2) لا توجد أي قاعدة ثابتة "BUY إجباري" أو "SELL إجباري".
3) احتسب Stop Hunt / Liquidity Sweep بشكل محترف: تجنب الدخول قرب السيولة المكسورة، وحدد SL وراء المناطق الموثوقة.
4) أضف TP1, TP2, TP3 بشكل منطقي مع توسيع الهدف تدريجياً.
5) احسب lotSize بحذر وفق حجم المخاطرة وليست قيمة ثابتة.
6) أعد JSON فقط بدون Markdown، بدون شيفرات، بدون شرح إضافي.

النسق المطلوب:
{
  "direction": "BUY|SELL",
  "entry": 1234.56,
  "stopLoss": 1233.5,
  "tp1": 1238.1,
  "tp2": 1242.4,
  "tp3": 1247.9,
  "lotSize": 0.25,
  "breakEven": 1235.2,
  "confidence": 82,
  "reason": "شرح بالعربية"
}

القاعدة الأساسية: إذا كان السوق يظهر ضعفاً أو اختراقاً أو كسر سيولة مع ضغط SELL، لا تتردد في إعطاء SELL، وإذا كان السوق يثبت قوة وكسر طلب واحتفاظاً فوق منطقة دعم، لا تتردد في إعطاء BUY.
`; 
}

function extractGeminiText(data) {
  if (!data || typeof data !== 'object') return '';

  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      if (typeof part?.text === 'string' && part.text.trim()) {
        return part.text;
      }
    }
  }

  if (typeof data?.text === 'string' && data.text.trim()) return data.text;
  if (typeof data?.output === 'string' && data.output.trim()) return data.output;
  if (Array.isArray(data?.outputs)) {
    for (const output of data.outputs) {
      if (typeof output === 'string' && output.trim()) return output;
      if (output && typeof output?.text === 'string' && output.text.trim()) return output.text;
    }
  }

  return '';
}

function extractJsonObject(text) {
  if (!text) return null;

  const cleaned = text
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeTrade({ parsed = {}, symbol, timeframe, mode, price, rsi, emaShort, emaLong, macd, bollingerUpper, bollingerLower }) {
  const direction = normalizeDirection(parsed.direction, { price, rsi, emaShort, emaLong, macd, bollingerUpper, bollingerLower });

  const baseEntry = Number(parsed.entry ?? price);
  const stopDistance = Math.max(Number(parsed.stopLoss ?? 0), computeStopDistance({ symbol, price, timeframe, direction }));
  const tp1 = Number(parsed.tp1 ?? (direction === 'BUY' ? baseEntry + stopDistance * 1.5 : baseEntry - stopDistance * 1.5));
  const tp2 = Number(parsed.tp2 ?? (direction === 'BUY' ? baseEntry + stopDistance * 2.4 : baseEntry - stopDistance * 2.4));
  const tp3 = Number(parsed.tp3 ?? (direction === 'BUY' ? baseEntry + stopDistance * 3.2 : baseEntry - stopDistance * 3.2));
  const lotSize = Number(parsed.lotSize ?? calculateLotSize({ stopDistance, mode }));
  const breakEven = Number(parsed.breakEven ?? (direction === 'BUY' ? baseEntry + stopDistance * 0.35 : baseEntry - stopDistance * 0.35));
  const stopLoss = Number(parsed.stopLoss ?? (direction === 'BUY' ? baseEntry - stopDistance : baseEntry + stopDistance));
  const confidence = clampNumber(Number(parsed.confidence ?? 80), 70, 97);
  const reason = String(parsed.reason || 'تحليل سوقي وفق الهيكل الحالي، الزخم، وكسر السيولة مع إدارة مخاطرة دقيقة.');

  return {
    direction,
    entry: Number.isFinite(baseEntry) ? baseEntry : price,
    stopLoss: Number.isFinite(stopLoss) ? stopLoss : 0,
    tp1: Number.isFinite(tp1) ? tp1 : 0,
    tp2: Number.isFinite(tp2) ? tp2 : 0,
    tp3: Number.isFinite(tp3) ? tp3 : 0,
    lotSize: Number.isFinite(lotSize) ? lotSize : 0,
    breakEven: Number.isFinite(breakEven) ? breakEven : 0,
    confidence,
    reason,
    timeframe,
    mode,
    symbol,
    strategy: mode === 'scalp' ? 'سكالبينغ سريع 1m مع حماية السيولة' : 'تحليل فني متوازن مع إدارة مخاطر محكمة',
    source: 'gemini',
  };
}

function normalizeDirection(value, { price, rsi, emaShort, emaLong, macd, bollingerUpper, bollingerLower }) {
  const raw = String(value || '').toUpperCase();
  if (raw === 'BUY' || raw === 'SELL') return raw;

  const bullish = rsi < 55 && emaShort > emaLong && macd > 0 && price < bollingerUpper;
  const bearish = rsi > 45 && emaShort < emaLong && macd < 0 && price > bollingerLower;

  if (bullish && !bearish) return 'BUY';
  if (bearish && !bullish) return 'SELL';
  return rsi >= 50 ? 'SELL' : 'BUY';
}

function computeStopDistance({ symbol, price, timeframe, direction }) {
  const baseMap = {
    XAUUSD: 1.8,
    BTCUSD: 180,
    EURUSD: 0.0022,
    ETHUSD: 14,
    NAS100: 18,
  };

  const base = baseMap[symbol] ?? 1.2;
  const multiplier = timeframe === '1m' ? 1.3 : timeframe === '5m' ? 1.6 : 1.9;
  const value = Number(base * multiplier);
  return direction === 'BUY' ? value : value;
}

function calculateLotSize({ stopDistance, mode }) {
  const risk = mode === 'scalp' ? 0.02 : 0.03;
  const lot = risk / Math.max(stopDistance / 100, 0.1);
  return clampNumber(lot, 0.01, 1.5);
}

function clampNumber(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.min(Math.max(num, min), max);
}
