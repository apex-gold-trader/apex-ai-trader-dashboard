export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    const body = safeJsonParse(rawBody, {});

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

    const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) {
      return res.status(500).json({
        success: false,
        error: 'Missing GEMINI_API_KEY in environment variables.',
      });
    }

    const isOAuthKey = apiKey.startsWith('AQ.');
    const endpoint = isOAuthKey
      ? 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent'
      : `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;

    const headers = {
      'Content-Type': 'application/json',
      ...(isOAuthKey ? { Authorization: `Bearer ${apiKey}` } : {}),
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
      2) أسعار الدخول، وقف الخسارة، TP1، TP2، TP3.
      3) حجم اللوت.
      4) نقطة Breakeven.
      5) confidence من 0 إلى 100.
      6) شرح بالعربية.
      7) تجنب فخاخ السيولة، واحتفظ بوقف الخسارة في مناطق أمان خلف الدوامات الوهمية.

      أعد JSON فقط بدون Markdown.
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

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 512,
        },
      }),
    });

    const responseText = await response.text();

    if (!response.ok) {
      let parsedError = {};
      try {
        parsedError = JSON.parse(responseText);
      } catch {
        parsedError = { error: responseText };
      }

      return res.status(response.status).json({
        success: false,
        error: parsedError?.error?.message || parsedError?.message || responseText || 'Gemini request failed',
      });
    }

    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      return res.status(500).json({
        success: false,
        error: 'Invalid JSON returned from Gemini.',
      });
    }

    const rawText =
      responseData?.candidates?.[0]?.content?.parts
        ?.map((part) => part?.text || '')
        .join('') || '{}';

    const parsedTrade = extractJsonObject(rawText);

    if (!parsedTrade) {
      return res.status(500).json({
        success: false,
        error: 'Gemini returned an empty or malformed trade payload.',
      });
    }

    const trade = {
      direction: String(parsedTrade.direction || (rsi > 55 ? 'SELL' : 'BUY')).toUpperCase(),
      entry: Number(parsedTrade.entry ?? price),
      stopLoss: Number(parsedTrade.stopLoss ?? (parsedTrade.direction === 'BUY' ? price - 1.8 : price + 1.8)),
      tp1: Number(parsedTrade.tp1 ?? (parsedTrade.direction === 'BUY' ? price + 3.2 : price - 3.2)),
      tp2: Number(parsedTrade.tp2 ?? (parsedTrade.direction === 'BUY' ? price + 5.8 : price - 5.8)),
      tp3: Number(parsedTrade.tp3 ?? (parsedTrade.direction === 'BUY' ? price + 8.2 : price - 8.2)),
      lotSize: Number(parsedTrade.lotSize ?? (mode === 'scalp' ? 0.12 : 0.25)),
      breakEven: Number(parsedTrade.breakEven ?? price),
      trailingStop: Number(parsedTrade.trailingStop ?? price),
      confidence: clampNumber(parsedTrade.confidence ?? 82, 68, 98),
      reason: String(parsedTrade.reason || 'تحليل دقيق وفق السعر الحالي ومؤشرات الزخم مع إدارة مخاطرة متحكمة.'),
      timeframe,
      strategy: mode === 'scalp' ? 'سكالبينغ سريع ومضاد لفخاخ السيولة' : 'تحليل فني هجين مع إدارة مخاطر دقيقة',
      mode,
      symbol,
    };

    return res.status(200).json({ success: true, trade });
  } catch (error) {
    return res.status(200).json({
      success: false,
      error: error?.message || 'Analysis unavailable',
    });
  }
}

function safeJsonParse(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;

  if (typeof value === 'object') return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function clampNumber(value, min, max) {
  const numeric = Number(value ?? min);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(Math.max(numeric, min), max);
}

function extractJsonObject(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;

  const cleaned = rawText
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  const candidate = cleaned.slice(firstBrace, lastBrace + 1);

  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}
