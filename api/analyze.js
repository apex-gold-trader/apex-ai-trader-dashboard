export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const body = parseRequestBody(req.body);
    const symbol = normalizeSymbol(body.symbol || 'XAUUSD');
    const timeframe = String(body.timeframe || '1m');
    const mode = String(body.mode || 'standard');
    const current = body.current || {};
    const price = Number(current.price ?? 0);
    const indicators = current.indicators || {};
    const rsi = Number(indicators.rsi ?? 50);
    const emaShort = Number(indicators.emaShort ?? price || 0);
    const emaLong = Number(indicators.emaLong ?? price || 0);
    const macd = Number(indicators.macd ?? 0);
    const bollingerUpper = Number(indicators.bollingerUpper ?? price || 0);
    const bollingerLower = Number(indicators.bollingerLower ?? price || 0);

    const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is missing');
    }

    const payload = {
      contents: [{ role: 'user', parts: [{ text: buildPrompt({
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
      }) }] }],
      generationConfig: {
        temperature: 0.2,
        topP: 0.9,
        topK: 32,
        maxOutputTokens: 512,
      },
    };

    const isSessionToken = /^AIza|^AQ\./.test(apiKey) || apiKey.startsWith('eyJ');
    const requestUrl = isSessionToken
      ? 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent'
      : 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + encodeURIComponent(apiKey);

    const response = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(isSessionToken ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();
    let parsedResponse = {};
    try {
      parsedResponse = responseText ? JSON.parse(responseText) : {};
    } catch {
      parsedResponse = {};
    }

    if (!response.ok) {
      const message = parsedResponse?.error?.message || responseText || `Gemini API responded with status ${response.status}`;
      throw new Error(message);
    }

    const extracted = extractGeminiText(parsedResponse);
    if (!extracted) {
      throw new Error('Gemini returned an empty response');
    }

    const tradeCandidate = extractJsonObject(extracted);
    if (!tradeCandidate || typeof tradeCandidate !== 'object') {
      throw new Error('Gemini response was not valid JSON');
    }

    const trade = normalizeTrade({
      parsed: tradeCandidate,
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
      source: 'gemini',
      trade,
      ...trade,
    });
  } catch (error) {
    const fallback = buildFallbackTrade(parseRequestBody(req.body));
    return res.status(200).json({
      success: true,
      source: 'fallback',
      warning: String(error?.message || 'Gemini analysis failed; local fallback used'),
      trade: fallback,
      ...fallback,
    });
  }
}

function parseRequestBody(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw;
}

function normalizeSymbol(value) {
  return String(value || 'XAUUSD').toUpperCase();
}

function buildPrompt({ symbol, timeframe, mode, price, rsi, emaShort, emaLong, macd, bollingerUpper, bollingerLower }) {
  return `
أنت محلل فني احترافي للأسواق المالية. لا تكرر نصًا عامًا. أعد تحليلاً موثوقًا بناءً على السوق الحقيقي.

البيانات:
- الأصل: ${symbol}
- الإطار الزمني: ${timeframe}
- النوع: ${mode}
- السعر الحالي: ${price}
- RSI: ${rsi}
- EMA قصيرة: ${emaShort}
- EMA طويلة: ${emaLong}
- MACD: ${macd}
- Bollinger Upper: ${bollingerUpper}
- Bollinger Lower: ${bollingerLower}

مطلوب: أعد JSON فقط بدون Markdown.
{
  "direction": "BUY",
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
`;
}

function extractGeminiText(data) {
  if (!data || typeof data !== 'object') return '';

  for (const candidate of Array.isArray(data?.candidates) ? data.candidates : []) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      if (typeof part?.text === 'string' && part.text.trim()) return part.text;
    }
  }

  if (typeof data?.text === 'string' && data.text.trim()) return data.text;
  if (typeof data?.output === 'string' && data.output.trim()) return data.output;
  return '';
}

function extractJsonObject(text) {
  const cleaned = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
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
  const entry = Number(parsed.entry ?? price || 0);
  const stopDistance = Number(parsed.stopLoss ?? computeStopDistance({ symbol, timeframe }));
  const stopLoss = Number(parsed.stopLoss ?? (direction === 'BUY' ? entry - stopDistance : entry + stopDistance));
  const tp1 = Number(parsed.tp1 ?? (direction === 'BUY' ? entry + stopDistance * 1.5 : entry - stopDistance * 1.5));
  const tp2 = Number(parsed.tp2 ?? (direction === 'BUY' ? entry + stopDistance * 2.4 : entry - stopDistance * 2.4));
  const tp3 = Number(parsed.tp3 ?? (direction === 'BUY' ? entry + stopDistance * 3.2 : entry - stopDistance * 3.2));
  const lotSize = Number(parsed.lotSize ?? calculateLotSize({ stopDistance, mode }));
  const breakEven = Number(parsed.breakEven ?? (direction === 'BUY' ? entry + stopDistance * 0.35 : entry - stopDistance * 0.35));
  const confidence = clampNumber(Number(parsed.confidence ?? 82), 70, 97);

  return {
    direction,
    entry: Number.isFinite(entry) ? entry : price || 0,
    stopLoss: Number.isFinite(stopLoss) ? stopLoss : 0,
    tp1: Number.isFinite(tp1) ? tp1 : 0,
    tp2: Number.isFinite(tp2) ? tp2 : 0,
    tp3: Number.isFinite(tp3) ? tp3 : 0,
    lotSize: Number.isFinite(lotSize) ? lotSize : 0,
    breakEven: Number.isFinite(breakEven) ? breakEven : 0,
    confidence,
    reason: String(parsed.reason || 'تحليل فني يحلل السعر الحالي على أسس الزخم، الاستقرار، ومناطق السيولة مع إدارة مخاطرة دقيقة.'),
    timeframe,
    mode,
    symbol,
    strategy: mode === 'scalp' ? 'سكالبينغ فوري 1m' : 'تحليل فني متوازن',
  };
}

function normalizeDirection(value, { price, rsi, emaShort, emaLong, macd, bollingerUpper, bollingerLower }) {
  const raw = String(value || '').toUpperCase();
  if (raw === 'BUY' || raw === 'SELL') return raw;

  const bullish = rsi <= 55 && emaShort >= emaLong && macd >= 0 && price < bollingerUpper;
  const bearish = rsi >= 45 && emaShort <= emaLong && macd <= 0 && price > bollingerLower;

  if (bullish && !bearish) return 'BUY';
  if (bearish && !bullish) return 'SELL';
  return rsi >= 50 ? 'SELL' : 'BUY';
}

function computeStopDistance({ symbol, timeframe }) {
  const base = {
    XAUUSD: 1.8,
    BTCUSD: 180,
    EURUSD: 0.0022,
    ETHUSD: 14,
    NAS100: 18,
  }[symbol] || 1.5;
  const multiplier = timeframe === '1m' ? 1.2 : timeframe === '5m' ? 1.5 : 1.9;
  return base * multiplier;
}

function calculateLotSize({ stopDistance, mode }) {
  const risk = mode === 'scalp' ? 0.018 : 0.03;
  return clampNumber(risk / Math.max(stopDistance / 100, 0.1), 0.01, 1.5);
}

function buildFallbackTrade(payload = {}) {
  const body = parseRequestBody(payload);
  const symbol = normalizeSymbol(body.symbol || 'XAUUSD');
  const timeframe = String(body.timeframe || '1m');
  const mode = String(body.mode || 'standard');
  const current = body.current || {};
  const price = Number(current.price ?? {
    XAUUSD: 2346.42,
    BTCUSD: 67740.12,
    EURUSD: 1.0884,
    ETHUSD: 3592.77,
    NAS100: 19036.2,
  }[symbol] ?? 1);
  const direction = Number(current?.indicators?.rsi ?? 50) >= 50 ? 'SELL' : 'BUY';
  const stopDistance = mode === 'scalp' ? 1.8 : 4.5;

  const entry = price;
  return {
    direction,
    entry,
    stopLoss: direction === 'BUY' ? entry - stopDistance : entry + stopDistance,
    tp1: direction === 'BUY' ? entry + 3.2 : entry - 3.2,
    tp2: direction === 'BUY' ? entry + 5.9 : entry - 5.9,
    tp3: direction === 'BUY' ? entry + 8.6 : entry - 8.6,
    lotSize: mode === 'scalp' ? 0.12 : 0.25,
    breakEven: direction === 'BUY' ? entry + 0.9 : entry - 0.9,
    confidence: 81,
    reason: 'تحليل احتياطي محلي غير مفضل؛ يجب أن ينجح Gemini في كل طلب قبل إظهار النتيجة النهائية.',
    timeframe,
    mode,
    symbol,
    strategy: mode === 'scalp' ? 'سكالبينغ سريع 1m' : 'تحليل فني متوازن',
  };
}

function clampNumber(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.min(Math.max(num, min), max);
}
