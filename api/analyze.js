export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const body = parseJsonBody(req.body);
    const symbol = String(body.symbol || 'XAUUSD').toUpperCase();
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

    const apiKey = 'AQ.Ab8RN6IEDrzQIWNRWro1LHEy2F238IMswDuZTfUybNTkfDQK_g';
    const requestUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

    const prompt = buildPrompt({
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

    const response = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.15,
          topP: 0.9,
          topK: 32,
          maxOutputTokens: 512,
        },
      }),
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
    if (!tradeCandidate) {
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

    return res.status(200).json({ success: true, trade, ...trade, source: 'gemini' });
  } catch (error) {
    const fallbackTrade = buildFallbackTrade({
      symbol: String((parseJsonBody(req.body) || {}).symbol || 'XAUUSD').toUpperCase(),
      timeframe: String((parseJsonBody(req.body) || {}).timeframe || '1m'),
      mode: String((parseJsonBody(req.body) || {}).mode || 'standard'),
      current: parseJsonBody(req.body)?.current || {},
    });

    return res.status(200).json({
      success: true,
      trade: fallbackTrade,
      ...fallbackTrade,
      warning: error?.message || 'Gemini analysis failed; returned local fallback trade',
      source: 'fallback'
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

function buildPrompt({ symbol, timeframe, mode, price, rsi, emaShort, emaLong, macd, bollingerUpper, bollingerLower }) {
  return `
أنت محلل فني احترافي للأسواق المالية. لا تُحِدَّ أو تفرض اتجاهًا مسبقًا. القرار يجب أن يكون حرّاً تماماً وفق السوق والهيكل، الزخم، وكسر السيولة.

بيانات السوق:
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

المطلوب:
1) تحديد direction = BUY أو SELL بشكل حقيقي.
2) احسب entry, stopLoss, tp1, tp2, tp3, lotSize, breakEven.
3) تجنب فخاخ السيولة واحتسب SL خلف مناطق الدعم/المقاومة الموثقة.
4) أعد JSON فقط، لا Markdown، لا شرح إضافي، لا نص خارجي.

النسق:
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

  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  for (const candidate of candidates) {
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
  if (!text) return null;

  const cleaned = String(text)
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
  const entryValue = Number(parsed.entry ?? price || 0);
  const stopDistance = Number(parsed.stopLoss ?? computeStopDistance({ symbol, timeframe, direction }));

  const stopLossValue = Number(parsed.stopLoss ?? (direction === 'BUY' ? entryValue - stopDistance : entryValue + stopDistance));
  const tp1 = Number(parsed.tp1 ?? (direction === 'BUY' ? entryValue + stopDistance * 1.5 : entryValue - stopDistance * 1.5));
  const tp2 = Number(parsed.tp2 ?? (direction === 'BUY' ? entryValue + stopDistance * 2.4 : entryValue - stopDistance * 2.4));
  const tp3 = Number(parsed.tp3 ?? (direction === 'BUY' ? entryValue + stopDistance * 3.2 : entryValue - stopDistance * 3.2));
  const breakEven = Number(parsed.breakEven ?? (direction === 'BUY' ? entryValue + stopDistance * 0.35 : entryValue - stopDistance * 0.35));
  const lotSize = Number(parsed.lotSize ?? calculateLotSize({ stopDistance, mode }));
  const confidence = clampNumber(Number(parsed.confidence ?? 82), 70, 97);
  const reason = String(parsed.reason || 'تحليل فني يراعي السوق اللحظي، الزخم، وكسر السيولة مع إدارة مخاطرة دقيقة.');

  return {
    direction,
    entry: Number.isFinite(entryValue) ? entryValue : price || 0,
    stopLoss: Number.isFinite(stopLossValue) ? stopLossValue : 0,
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
    strategy: mode === 'scalp' ? 'سكالبينغ سريع 1m مع حماية السيولة' : 'تحليل فني متوازن',
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

function computeStopDistance({ symbol, timeframe, direction }) {
  const baseMap = {
    XAUUSD: 1.8,
    BTCUSD: 180,
    EURUSD: 0.0022,
    ETHUSD: 14,
    NAS100: 18,
  };

  const base = baseMap[symbol] ?? 1.2;
  const multiplier = timeframe === '1m' ? 1.3 : timeframe === '5m' ? 1.6 : 1.9;
  return Number(base * multiplier + (direction === 'BUY' ? 0.1 : 0.1));
}

function calculateLotSize({ stopDistance, mode }) {
  const risk = mode === 'scalp' ? 0.02 : 0.03;
  return clampNumber(risk / Math.max(stopDistance / 100, 0.1), 0.01, 1.5);
}

function buildFallbackTrade({ symbol = 'XAUUSD', timeframe = '1m', mode = 'standard', current = {} }) {
  const price = Number(current.price ?? 2346.42);
  const rsi = Number(current?.indicators?.rsi ?? 50);
  const direction = rsi >= 50 ? 'SELL' : 'BUY';
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
    reason: `تحليل احتياطي فوري بسبب ضعف الاتصال بالخادم. السعر الحالي ${price.toFixed(2)} ويُراعي هيكل السوق الحالي.`,
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
