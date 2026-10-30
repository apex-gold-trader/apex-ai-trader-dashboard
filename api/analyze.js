export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};
    const symbol = body.symbol || 'XAUUSD';
    const timeframe = body.timeframe || '1m';
    const mode = body.mode || 'standard';
    const market = body.current || {};
    const price = Number(market.price ?? 0);
    const indicators = market.indicators || {};
    const rsi = Number(indicators.rsi ?? 50);
    const emaShort = Number(indicators.emaShort ?? price);
    const emaLong = Number(indicators.emaLong ?? price);
    const macd = Number(indicators.macd ?? 0);

    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is missing');
    }

    const isSessionToken = /^AQ\./.test(apiKey);
    const baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';
    const requestUrl = isSessionToken ? baseUrl : `${baseUrl}?key=${encodeURIComponent(apiKey)}`;

    const headers = {
      'Content-Type': 'application/json',
      ...(isSessionToken ? { Authorization: `Bearer ${apiKey}` } : {}),
    };

    const prompt = `
      أنت محلل فني احترافي للأسواق المالية.
      الأصل: ${symbol}
      الإطار الزمني: ${timeframe}
      السعر الحالي: ${price}
      RSI: ${rsi}
      EMA قصيرة: ${emaShort}
      EMA طويلة: ${emaLong}
      MACD: ${macd}
      نوع التحليل: ${mode}

      المطلوب:
      1) تحديد الاتجاه BUY أو SELL.
      2) سعر الدخول، وقف الخسارة، TP1، TP2، TP3.
      3) حجم اللوت.
      4) نقطة Breakeven.
      5) confidence من 0 إلى 100.
      6) شرح بالعربية.
      7) تجنب فخاخ السيولة، واحتفظ بوقف الخسارة في مناطق أمان خلف الدوامات الوهمية.

      أعد JSON فقط:
      {
        "direction": "BUY|SELL",
        "entry": 1234.56,
        "stopLoss": 1233.5,
        "tp1": 1238.1,
        "tp2": 1242.4,
        "tp3": 1247.9,
        "lotSize": 0.25,
        "breakEven": 1235.2,
        "trailingStop": 1236.1,
        "confidence": 82,
        "reason": "شرح بالعربية"
      }
    `;

    const response = await fetch(requestUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 512,
        },
      }),
    });

    const responseText = await response.text();
    let data = {};

    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch {
      data = {};
    }

    if (!response.ok) {
      const message = data?.error?.message || responseText || `Gemini API responded with status ${response.status}`;
      throw new Error(message);
    }

    const rawText = extractGeminiText(data) || '{}';
    const cleaned = rawText
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();

    let parsed = {};
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          parsed = {};
        }
      }
    }

    const trade = normalizeTrade({
      parsed,
      symbol,
      timeframe,
      mode,
      price,
      rsi,
    });

    return res.status(200).json({
      success: true,
      ...trade,
      trade,
    });
  } catch (error) {
    const fallback = buildFallbackTrade(req.body || {});
    return res.status(200).json({
      success: false,
      error: error?.message || 'Gemini analysis failed',
      ...fallback,
      trade: fallback,
    });
  }
}

function extractGeminiText(data) {
  if (!data || typeof data !== 'object') return '';

  const candidates = data?.candidates || [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts || [];
    for (const part of parts) {
      if (typeof part?.text === 'string' && part.text.trim()) {
        return part.text;
      }
    }
  }

  return data?.text || '';
}

function normalizeTrade({ parsed = {}, symbol, timeframe, mode, price, rsi }) {
  const direction = String(parsed.direction || (rsi > 55 ? 'SELL' : 'BUY')).toUpperCase();
  const entry = Number(parsed.entry ?? price);
  const stopLoss = Number(parsed.stopLoss ?? (direction === 'BUY' ? entry - 1.8 : entry + 1.8));
  const tp1 = Number(parsed.tp1 ?? (direction === 'BUY' ? entry + 3.2 : entry - 3.2));
  const tp2 = Number(parsed.tp2 ?? (direction === 'BUY' ? entry + 5.8 : entry - 5.8));
  const tp3 = Number(parsed.tp3 ?? (direction === 'BUY' ? entry + 8.2 : entry - 8.2));
  const lotSize = Number(parsed.lotSize ?? (mode === 'scalp' ? 0.12 : 0.25));
  const breakEven = Number(parsed.breakEven ?? (direction === 'BUY' ? entry + 0.9 : entry - 0.9));
  const trailingStop = Number(parsed.trailingStop ?? (direction === 'BUY' ? entry + 1.2 : entry - 1.2));

  return {
    direction,
    entry: Number.isFinite(entry) ? entry : price || 0,
    stopLoss: Number.isFinite(stopLoss) ? stopLoss : 0,
    tp1: Number.isFinite(tp1) ? tp1 : 0,
    tp2: Number.isFinite(tp2) ? tp2 : 0,
    tp3: Number.isFinite(tp3) ? tp3 : 0,
    lotSize: Number.isFinite(lotSize) ? lotSize : 0,
    breakEven: Number.isFinite(breakEven) ? breakEven : 0,
    trailingStop: Number.isFinite(trailingStop) ? trailingStop : 0,
    confidence: clampNumber(parsed.confidence ?? 80, 68, 98),
    reason: String(parsed.reason || 'تحليل ذكي وفق السعر الحالي ومؤشرات الزخم مع إدارة مخاطرة متحكمة.'),
    timeframe,
    strategy: mode === 'scalp' ? 'سكالبينغ سريع ومضاد لفخاخ السيولة' : 'تحليل فني هجين مع إدارة مخاطر دقيقة',
    mode,
    symbol,
  };
}

function clampNumber(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.min(Math.max(num, min), max);
}

function buildFallbackTrade(payload = {}) {
  const symbol = payload.symbol || 'XAUUSD';
  const timeframe = payload.timeframe || '1m';
  const mode = payload.mode || 'standard';
  const current = payload.current || {};
  const price = Number(current.price ?? 2346.42);
  const direction = Number(current?.indicators?.rsi ?? 50) > 55 ? 'SELL' : 'BUY';
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
    trailingStop: direction === 'BUY' ? entry + 1.2 : entry - 1.2,
    confidence: 81,
    reason: 'تحليل احتياطي محلي عند عدم توفر البيانات الفورية من الخادم.',
    timeframe,
    strategy: mode === 'scalp' ? 'سكالبينغ سريع ومضاد لفخاخ السيولة' : 'تحليل فني هجين مع إدارة مخاطر دقيقة',
    mode,
    symbol,
  };
}
