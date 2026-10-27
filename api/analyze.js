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
      return res.status(200).json({ success: false, trade: buildFallbackTrade(body), error: 'Missing GEMINI_API_KEY in Vercel environment variables.' });
    }

    const prompt = `
      أنت محلل فني احترافي للأسواق المالية. تحليل الأصل ${symbol} على الإطار ${timeframe}.
      السعر الحالي: ${price}
      RSI: ${rsi}
      EMA قصيرة: ${emaShort}
      EMA طويلة: ${emaLong}
      MACD: ${macd}
      نوع التحليل: ${mode}

      المطلوب:
      1) تحديد الاتجاه: BUY أو SELL.
      2) سعر الدخول، وقف الخسارة، TP1، TP2، TP3.
      3) حجم اللوت.
      4) نقطة التعادل Breakeven.
      5) trust/confidence من 0 إلى 100.
      6) شرح موجز بالعربية.
      7) تجنب فخاخ السيولة (Stop Hunt) ووضع الوقف خلف مناطق الدعم/المقاومة الحقيقية.

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
        "reason": "نص بالعربية"
      }
    `;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`, {
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
      throw new Error(`Gemini API responded with status ${response.status}`);
    }

    const responseData = await response.json();
    const rawText = responseData?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

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
      confidence: clampNumber(parsed.confidence ?? 80, 68, 98),
      reason: parsed.reason || 'تحليل ذكي وفق السعر الحالي ومؤشرات الزخم مع إدارة مخاطرة متحكمة.',
      timeframe,
      strategy: mode === 'scalp' ? 'سكالبينغ سريع ومضاد لفخاخ السيولة' : 'تحليل فني هجين مع إدارة مخاطر دقيقة',
      mode,
      symbol,
    };

    return res.status(200).json({ success: true, trade });
  } catch (error) {
    const fallback = buildFallbackTrade(req.body || {});
    return res.status(200).json({ success: false, error: error.message, trade: fallback });
  }
}

function clampNumber(value, min, max) {
  return Math.min(Math.max(Number(value || min), min), max);
}

function buildFallbackTrade(payload = {}) {
  const symbol = payload.symbol || 'XAUUSD';
  const timeframe = payload.timeframe || '1m';
  const mode = payload.mode || 'standard';
  const current = payload.current || {};
  const price = Number(current.price ?? 2346.42);
  const direction = current?.indicators?.rsi > 55 ? 'SELL' : 'BUY';
  const stopDistance = mode === 'scalp' ? 1.8 : 4.5;
  const entry = price;
  const stopLoss = direction === 'BUY' ? entry - stopDistance : entry + stopDistance;

  return {
    direction,
    entry,
    stopLoss,
    tp1: direction === 'BUY' ? entry + 3.2 : entry - 3.2,
    tp2: direction === 'BUY' ? entry + 5.9 : entry - 5.9,
    tp3: direction === 'BUY' ? entry + 8.6 : entry - 8.6,
    lotSize: mode === 'scalp' ? 0.12 : 0.25,
    breakEven: direction === 'BUY' ? entry + 0.9 : entry - 0.9,
    trailingStop: direction === 'BUY' ? entry + 1.2 : entry - 1.2,
    confidence: 81,
    reason: 'تحليل احتياطي محلي أثناء تفعيل الذكاء الاصطناعي الحقيقي في بيئة Vercel.',
    timeframe,
    strategy: mode === 'scalp' ? 'سكالبينغ سريع ومضاد لفخاخ السيولة' : 'تحليل فني هجين مع إدارة مخاطر دقيقة',
    mode,
    symbol,
  };
}
