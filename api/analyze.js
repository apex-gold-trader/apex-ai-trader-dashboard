export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const apiKey = "AQ.Ab8RN6KQI6lq7PrHvSx5GllrbESOGG6VqBGDTj5O6ayexGEnHw";

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
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          topP: 0.9,
          topK: 32,
          maxOutputTokens: 512,
          responseMimeType: 'application/json',
        },
      }),
    });

    const responseText = await response.text();
    let data;
    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch {
      throw new Error(`Gemini returned a non-JSON HTTP response (${response.status})`);
    }

    if (!response.ok) {
      throw new Error(data?.error?.message || `Gemini API error ${response.status}`);
    }

    const generatedText = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!generatedText) {
      const finishReason = data?.candidates?.[0]?.finishReason;
      throw new Error(finishReason ? `Gemini returned no text (finish reason: ${finishReason})` : 'Gemini returned an empty response');
    }

    const parsed = extractJsonObject(generatedText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Gemini response did not contain a valid JSON trade object');
    }

    const trade = normalizeTrade({ parsed, symbol, timeframe, mode, price });
    return res.status(200).json({ success: true, source: 'gemini', trade, ...trade });
  } catch (error) {
    return res.status(502).json({
      success: false,
      error: String(error?.message || 'Gemini API request failed'),
    });
  }
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function buildPrompt({ symbol, timeframe, mode, price, rsi, emaShort, emaLong, macd, bollingerUpper, bollingerLower }) {
  return `أنت محلل فني. حلل البيانات المقدمة فقط، ولا تدّعِ امتلاك بيانات سوق مباشرة إضافية. أعد كائن JSON صالحًا فقط دون Markdown، مع هذه الحقول الرقمية: direction (BUY أو SELL), entry, stopLoss, tp1, tp2, tp3, lotSize, breakEven, confidence, reason.

الأصل: ${symbol}
الإطار الزمني: ${timeframe}
النمط: ${mode}
السعر المرسل من التطبيق: ${price}
RSI: ${rsi}
EMA قصيرة: ${emaShort}
EMA طويلة: ${emaLong}
MACD: ${macd}
Bollinger Upper: ${bollingerUpper}
Bollinger Lower: ${bollingerLower}`;
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
  const direction = String(parsed.direction || '').toUpperCase();
  if (direction !== 'BUY' && direction !== 'SELL') {
    throw new Error('Gemini trade JSON has an invalid direction');
  }

  const fields = ['entry', 'stopLoss', 'tp1', 'tp2', 'tp3', 'lotSize', 'breakEven', 'confidence'];
  const numericValues = Object.fromEntries(fields.map((field) => [field, Number(parsed[field])]));
  const invalidField = fields.find((field) => !Number.isFinite(numericValues[field]));
  if (invalidField) {
    throw new Error(`Gemini trade JSON has an invalid ${invalidField} value`);
  }

  return {
    ...numericValues,
    direction,
    reason: String(parsed.reason || ''),
    timeframe,
    mode,
    symbol,
    strategy: mode === 'scalp' ? 'سكالبينغ فوري 1m' : 'تحليل فني متوازن',
    marketPrice: price,
  };
}
