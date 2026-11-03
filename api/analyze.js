export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const apiKey = "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";

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch {
    return res.status(400).json({ success: false, error: 'Invalid JSON request body' });
  }

  const symbol = String(body.symbol || 'XAUUSD').toUpperCase();
  const timeframe = String(body.timeframe || '1m');
  const mode = String(body.mode || 'standard');
  const current = body.current || {};
  const price = finiteNumber(current.price, 0);
  const indicators = current.indicators || {};
  const rsi = finiteNumber(indicators.rsi, 50);
  const emaShort = finiteNumber(indicators.emaShort, price);
  const emaLong = finiteNumber(indicators.emaLong, price);
  const macd = finiteNumber(indicators.macd, 0);
  const bollingerUpper = finiteNumber(indicators.bollingerUpper, price);
  const bollingerLower = finiteNumber(indicators.bollingerLower, price);
  const prompt = buildPrompt({ symbol, timeframe, mode, price, rsi, emaShort, emaLong, macd, bollingerUpper, bollingerLower });

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://apex-ai-trader-dashboard-delta.vercel.app',
        'X-Title': 'Apex AI Trader'
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-3.3-70b-instruct:free',
        messages: [{ role: 'user', content: prompt }]
      }),
    });

    const responseText = await response.text();
    let data;
    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch {
      throw new Error(`OpenRouter returned HTTP ${response.status}: ${responseText.slice(0, 200)}`);
    }

    if (!response.ok) {
      throw new Error(data?.error?.message || `OpenRouter API error ${response.status}`);
    }

    const recommendation = data?.choices?.[0]?.message?.content;
    if (typeof recommendation !== 'string' || !recommendation.trim()) {
      throw new Error('OpenRouter response did not contain message content');
    }

    const parsed = extractJsonObject(recommendation);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('OpenRouter response was not a valid JSON trade object');
    }

    const trade = normalizeTrade({ parsed, symbol, timeframe, mode, price });
    return res.status(200).json({ success: true, source: 'openrouter', trade, ...trade });
  } catch (error) {
    return res.status(502).json({
      success: false,
      error: String(error?.message || error || 'OpenRouter request failed'),
    });
  }
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function buildPrompt({ symbol, timeframe, mode, price, rsi, emaShort, emaLong, macd, bollingerUpper, bollingerLower }) {
  return `أنت محلل فني. حلل البيانات المقدمة وأعد كائن JSON صالح فقط دون أي نص آخر أو markdown، بالصيغة التالية تماماً:
{"direction": "BUY", "entry": ${price}, "stopLoss": ${price * 0.99}, "tp1": ${price * 1.01}, "tp2": ${price * 1.02}, "tp3": ${price * 1.03}, "lotSize": 0.1, "breakEven": ${price}, "confidence": 85, "reason": "سبب التحليل"}

بيانات السوق:
الأصل: ${symbol}
الإطار: ${timeframe}
السعر: ${price}
RSI: ${rsi}
EMA قصير: ${emaShort}
EMA طويل: ${emaLong}
MACD: ${macd}`;
}

function extractJsonObject(text) {
  const cleaned = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function normalizeTrade({ parsed, symbol, timeframe, mode, price }) {
  const direction = String(parsed.direction || parsed.Direction || '').toUpperCase();
  if (direction !== 'BUY' && direction !== 'SELL') {
    throw new Error('Invalid direction in trade response');
  }

  const stopLoss = finiteNumber(parsed.stopLoss || parsed.stoploss, price * 0.99);
  const tp1 = finiteNumber(parsed.tp1, price * 1.01);
  const tp2 = finiteNumber(parsed.tp2, price * 1.02);
  const tp3 = finiteNumber(parsed.tp3, price * 1.03);
  const entry = finiteNumber(parsed.entry, price);
  const lotSize = finiteNumber(parsed.lotSize || parsed.lotsize, 0.1);
  const breakEven = finiteNumber(parsed.breakEven || parsed.breakeven, price);
  const confidence = finiteNumber(parsed.confidence, 80);

  return {
    entry,
    stopLoss,
    tp1,
    tp2,
    tp3,
    lotSize,
    breakEven,
    confidence,
    direction,
    reason: String(parsed.reason || 'تحليل بناءً على المؤشرات الحالية'),
    timeframe,
    mode,
    symbol,
    strategy: mode === 'scalp' ? 'سكالبينغ فوري 1m' : 'تحليل فني متوازن',
    marketPrice: price,
  };
}
