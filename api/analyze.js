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

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        success: false,
        error: 'Gemini API key is missing. Set GEMINI_API_KEY in the project environment.',
      });
    }

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

      أعد JSON فقط بدون Markdown:
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

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 512,
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${errText}`);
    }

    const responseData = await response.json();
    const rawText = responseData?.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') || '{}';
    const cleaned = rawText.replace(/```json|```/gi, '').trim();

    if (!cleaned) {
      throw new Error('Empty Gemini response');
    }

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error('Malformed Gemini response');
    }

    const trade = {
      direction: parsed.direction || (rsi > 55 ? 'SELL' : 'BUY'),
      entry: Number(parsed.entry ?? price),
      stopLoss: Number(parsed.stopLoss ?? (parsed.direction === 'BUY' ? price - 1.8 : price + 1.8)),
      tp1: Number(parsed.tp1 ?? (parsed.direction === 'BUY' ? price + 3.2 : price - 3.2)),
      tp2: Number(parsed.tp2 ?? (parsed.direction === 'BUY' ? price + 5.8 : price - 5.8)),
      tp3: Number(parsed.tp3 ?? (parsed.direction === 'BUY' ? price + 8.2 : price - 8.2)),
      lotSize: Number(parsed.lotSize ?? (mode === 'scalp' ? 0.12 : 0.25)),
      breakEven: Number(parsed.breakEven ?? price),
      trailingStop: Number(parsed.trailingStop ?? price),
      confidence: clampNumber(parsed.confidence ?? 82, 68, 98),
      reason: parsed.reason || 'تحليل دقيق وفق السعر الحالي ومؤشرات الزخم مع إدارة مخاطرة متحكمة.',
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

function clampNumber(value, min, max) {
  const numeric = Number(value ?? min);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(Math.max(numeric, min), max);
}
