import React, { useMemo, useState } from "react";

const formatCurrency = (value) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);

const marketData = [
  { symbol: "XAU/USD", price: 2345.12, change: 1.48, trend: "up", sentiment: "Bullish" },
  { symbol: "BTC/USD", price: 68240.31, change: -0.92, trend: "down", sentiment: "Cautious" },
  { symbol: "ETH/USD", price: 3512.08, change: 2.14, trend: "up", sentiment: "Bullish" },
  { symbol: "EUR/USD", price: 1.0842, change: 0.34, trend: "up", sentiment: "Stable" },
  { symbol: "USD/JPY", price: 149.76, change: -0.41, trend: "down", sentiment: "Neutral" },
];

const portfolio = [
  { name: "Gold", allocation: "38%", value: 24500, pnl: 1200 },
  { name: "Crypto", allocation: "32%", value: 19800, pnl: 2200 },
  { name: "FX", allocation: "20%", value: 12900, pnl: 480 },
  { name: "Indices", allocation: "10%", value: 6300, pnl: 290 },
];

const tradeInsights = [
  {
    title: "Momentum Signal",
    text: "Gold is holding above the key support band and is favoring continuation upside momentum.",
    tone: "positive",
  },
  {
    title: "Risk Watch",
    text: "BTC remains volatile near resistance; scale-in entries may reduce drawdown risk.",
    tone: "warning",
  },
  {
    title: "Macro Trigger",
    text: "FX markets show improved stability after the latest rate expectations update.",
    tone: "neutral",
  },
];

const statCards = [
  { label: "Portfolio Value", value: "$83,500", detail: "+3.4% this week" },
  { label: "Open Positions", value: "14", detail: "6 long / 8 short" },
  { label: "Win Rate", value: "68.2%", detail: "Last 30 days" },
  { label: "Sharpe Ratio", value: "1.84", detail: "Risk adjusted" },
];

export default function App() {
  const [selectedSymbol, setSelectedSymbol] = useState("XAU/USD");

  const selectedMarket = useMemo(
    () => marketData.find((item) => item.symbol === selectedSymbol) ?? marketData[0],
    [selectedSymbol]
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-wrap">
          <div className="brand-mark">A</div>
          <div>
            <p className="eyebrow">AI Trading Workspace</p>
            <h1>Apex AI Trader Dashboard</h1>
          </div>
        </div>

        <div className="top-actions">
          <button type="button" className="ghost-btn">
            Market Overview
          </button>
          <button type="button" className="primary-btn">
            Execute Strategy
          </button>
        </div>
      </header>

      <main className="dashboard">
        <section className="hero-panel">
          <div className="section-header">
            <div>
              <p className="eyebrow">Portfolio Summary</p>
              <h2>AI-driven market intelligence</h2>
            </div>
            <span className="status-pill online">System Online</span>
          </div>

          <div className="stats-grid">
            {statCards.map((item) => (
              <article key={item.label} className="stat-card">
                <p>{item.label}</p>
                <h3>{item.value}</h3>
                <small>{item.detail}</small>
              </article>
            ))}
          </div>
        </section>

        <section className="market-panel">
          <div className="section-header">
            <div>
              <p className="eyebrow">Market Watch</p>
              <h2>Live asset overview</h2>
            </div>
          </div>

          <div className="market-tabs">
            {marketData.map((item) => (
              <button
                key={item.symbol}
                type="button"
                className={`tab-btn ${selectedSymbol === item.symbol ? "active" : ""}`}
                onClick={() => setSelectedSymbol(item.symbol)}
              >
                <span>{item.symbol}</span>
                <small className={item.trend === "up" ? "positive" : "negative"}>
                  {item.change > 0 ? "+" : ""}
                  {item.change}%
                </small>
              </button>
            ))}
          </div>

          <div className="market-card">
            <div className="market-header">
              <div>
                <p className="eyebrow">Selected Instrument</p>
                <h3>{selectedMarket.symbol}</h3>
              </div>

              <span className={selectedMarket.trend === "up" ? "trend positive" : "trend negative"}>
                {selectedMarket.trend === "up" ? "Bullish" : "Bearish"}
              </span>
            </div>

            <div className="price-row">
              <div className="price-main">
                {selectedMarket.symbol.includes("/") ? (
                  <h2>{selectedMarket.price.toFixed(selectedMarket.symbol === "EUR/USD" || selectedMarket.symbol === "USD/JPY" ? 4 : 2)}</h2>
                ) : (
                  <h2>{formatCurrency(selectedMarket.price)}</h2>
                )}
              </div>

              <div className={`delta ${selectedMarket.change >= 0 ? "positive" : "negative"}`}>
                {selectedMarket.change >= 0 ? "+" : ""}
                {selectedMarket.change}%
              </div>
            </div>

            <div className="mini-metrics">
              <div>
                <label>Sentiment</label>
                <strong>{selectedMarket.sentiment}</strong>
              </div>
              <div>
                <label>Signal</label>
                <strong>{selectedMarket.change >= 0 ? "Long Bias" : "Short Bias"}</strong>
              </div>
              <div>
                <label>Volatility</label>
                <strong>Medium</strong>
              </div>
            </div>
          </div>
        </section>

        <section className="portfolio-panel">
          <div className="section-header">
            <div>
              <p className="eyebrow">Portfolio Mix</p>
              <h2>Exposure allocation</h2>
            </div>
          </div>

          <div className="portfolio-list">
            {portfolio.map((item) => (
              <div key={item.name} className="portfolio-row">
                <div className="allocation-meta">
                  <strong>{item.name}</strong>
                  <span>{item.allocation}</span>
                </div>

                <div className="allocation-value">
                  <span>{formatCurrency(item.value)}</span>
                  <small className={item.pnl >= 0 ? "positive" : "negative"}>
                    {item.pnl >= 0 ? "+" : ""}
                    {formatCurrency(item.pnl)}
                  </small>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="insights-panel">
          <div className="section-header">
            <div>
              <p className="eyebrow">AI Insights</p>
              <h2>Trade intelligence</h2>
            </div>
          </div>

          <div className="insight-list">
            {tradeInsights.map((item) => (
              <article key={item.title} className={`insight-card ${item.tone}`}>
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
            }
