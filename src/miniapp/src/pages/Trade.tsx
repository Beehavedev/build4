import { useState } from "react";

const PAIRS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "DOGEUSDT", "XRPUSDT"];

export function Trade() {
  const [side, setSide] = useState<"LONG" | "SHORT">("LONG");
  const [pair, setPair] = useState("BTCUSDT");
  const [size, setSize] = useState("");
  const [leverage, setLeverage] = useState(5);
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT">("MARKET");
  const [limitPrice, setLimitPrice] = useState("");

  const handleTrade = () => {
    const tg = window.Telegram?.WebApp;
    if (tg) {
      tg.MainButton.text = `${side} ${pair} $${size} @ ${leverage}x`;
      tg.MainButton.show();
    }
    alert(`Order: ${side} ${pair}\nSize: $${size}\nLeverage: ${leverage}x\nType: ${orderType}${orderType === "LIMIT" ? `\nPrice: $${limitPrice}` : ""}`);
  };

  return (
    <div className="page">
      <div className="section-title">⚡ Trade on Aster DEX</div>

      <div className="card">
        <div className="toggle-row" data-testid="side-toggle">
          <button
            className={`toggle-btn ${side === "LONG" ? "active-long" : ""}`}
            onClick={() => setSide("LONG")}
            data-testid="btn-long"
          >
            Long
          </button>
          <button
            className={`toggle-btn ${side === "SHORT" ? "active-short" : ""}`}
            onClick={() => setSide("SHORT")}
            data-testid="btn-short"
          >
            Short
          </button>
        </div>
      </div>

      <div className="card">
        <div className="trade-form">
          <div className="input-group">
            <label className="input-label">Pair</label>
            <select
              className="input-field"
              value={pair}
              onChange={e => setPair(e.target.value)}
              data-testid="select-pair"
            >
              {PAIRS.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          <div className="toggle-row">
            <button
              className={`toggle-btn ${orderType === "MARKET" ? "active-long" : ""}`}
              onClick={() => setOrderType("MARKET")}
              style={orderType === "MARKET" ? { background: "var(--accent)" } : {}}
              data-testid="btn-market"
            >
              Market
            </button>
            <button
              className={`toggle-btn ${orderType === "LIMIT" ? "active-long" : ""}`}
              onClick={() => setOrderType("LIMIT")}
              style={orderType === "LIMIT" ? { background: "var(--accent)" } : {}}
              data-testid="btn-limit"
            >
              Limit
            </button>
          </div>

          <div className="input-group">
            <label className="input-label">Size (USDT)</label>
            <input
              className="input-field"
              type="number"
              placeholder="100"
              value={size}
              onChange={e => setSize(e.target.value)}
              data-testid="input-size"
            />
          </div>

          {orderType === "LIMIT" && (
            <div className="input-group">
              <label className="input-label">Limit Price</label>
              <input
                className="input-field"
                type="number"
                placeholder="0.00"
                value={limitPrice}
                onChange={e => setLimitPrice(e.target.value)}
                data-testid="input-limit-price"
              />
            </div>
          )}

          <div className="input-group">
            <label className="input-label">Leverage: {leverage}x</label>
            <input
              className="leverage-slider"
              type="range"
              min="1"
              max="50"
              value={leverage}
              onChange={e => setLeverage(Number(e.target.value))}
              data-testid="slider-leverage"
            />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "var(--text-muted)" }}>
              <span>1x</span>
              <span>10x</span>
              <span>25x</span>
              <span>50x</span>
            </div>
          </div>

          <button
            className={`btn ${side === "LONG" ? "btn-green" : "btn-red"}`}
            onClick={handleTrade}
            disabled={!size}
            data-testid="btn-place-order"
          >
            {side === "LONG" ? "🟢" : "🔴"} {side} {pair} — {leverage}x
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Trading Info</div>
        <div style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: "1.6", marginTop: "8px" }}>
          <div>• Trading fee: 0.1% + Build4 broker fee</div>
          <div>• Max leverage: 50x</div>
          <div>• Supported collateral: USDT (BEP-20)</div>
          <div>• Liquidation threshold: 80%</div>
          <div>• Settlement: On-chain (BSC)</div>
        </div>
      </div>
    </div>
  );
}
