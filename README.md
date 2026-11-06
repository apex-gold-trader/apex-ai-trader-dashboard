# Apex AI Trader Dashboard

## Market data configuration

The server-side market endpoint (`api/market.js`) reads `TWELVE_DATA_API_KEY` from the process environment. When configured, it requests real 1-minute and 15-minute OHLC series from Twelve Data and derives 5-minute bars from the real 1-minute bars. `api/analyze.js` only scores real, recent OHLC candles and returns `WAIT` when data is missing, stale, or incomplete. A TradingView embed is a visual chart only; it does not feed its candles to the analysis API.

### Vercel

1. Open the Vercel project for this repository.
2. Go to **Settings → Environment Variables**.
3. Add `TWELVE_DATA_API_KEY` with the API key as its value. Select the environments where the app should use it (Production, Preview, and/or Development).
4. Save the variable and redeploy the project. Environment variable changes do not update deployments that have already been built.
5. Check the deployment logs and `/api/market?symbols=XAUUSD` response. The response should show a Twelve Data source and real candle arrays. Do not share responses or logs containing credentials.

### Local development

Copy `.env.example` to `.env.local`, replace the placeholder with your key, and run the dev server. Keep `.env.local` out of Git.

The key is server-only: do not rename it to a `VITE_` variable or include it in frontend code. Twelve Data access, available symbols, real-time status, history depth, and request quotas depend on the account plan. The dashboard refreshes periodically and does not guarantee tick-level delivery or an exact match to a broker feed.

## Security notice

If an API key has been pasted into a chat, issue, commit, or other shared location, revoke/rotate it with the provider and update the Vercel environment variable. Treat exposed keys as compromised.
