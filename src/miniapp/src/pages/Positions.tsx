import { useState, useEffect } from "react";
import { getTelegramUser, getUser } from "../api";

interface Position {
  id: string;
  pair: string;
  side: string;
  size: number;
  entryPrice: number;
  leverage: number;
  pnl: number | null;
  status: string;
  agentName?: string;
}

export function Positions() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const tgUser = getTelegramUser();
      if (!tgUser) { setLoading(false); return; }
      try {
        const u = await getUser(tgUser.id);
        const res = await fetch(`/api/trades/${u.id}`);
        if (res.ok) {
          const data = await res.json();
          setPositions(data);
        }
      } catch {}
      setLoading(false);
    }
    load();
  }, []);

  if (loading) return <div className="loading">Loading positions...</div>;

  const openPositions = positions.filter(p => p.status === "open");
  const closedPositions = positions.filter(p => p.status === "closed").slice(0, 10);
  const totalPnl = openPositions.reduce((s, p) => s + (p.pnl || 0), 0);

  return (
    <div className="page">
      <div className="section-title">📊 Positions</div>

      <div className="card">
        <div className="card-header">
          <div className="card-title">Open Positions</div>
          <span className={`badge ${totalPnl >= 0 ? "badge-active" : "badge-paused"}`}>
            {totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(2)} USD
          </span>
        </div>

        {openPositions.length === 0 ? (
          <div style={{ textAlign: "center", padding: "20px", color: "var(--text-muted)" }}>
            No open positions
          </div>
        ) : (
          openPositions.map(p => (
            <div className="position-row" key={p.id} data-testid={`position-${p.id}`}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span className="pair-name">{p.pair}</span>
                  <span className={`pair-side ${p.side === "LONG" ? "side-long" : "side-short"}`}>
                    {p.side}
                  </span>
                  <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>{p.leverage}x</span>
                </div>
                <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "4px" }}>
                  Entry: ${p.entryPrice.toFixed(2)} • Size: ${p.size.toFixed(2)}
                </div>
                {p.agentName && (
                  <div style={{ fontSize: "11px", color: "var(--accent)", marginTop: "2px" }}>
                    🤖 {p.agentName}
                  </div>
                )}
              </div>
              <div style={{ textAlign: "right" }}>
                <div className={p.pnl && p.pnl >= 0 ? "pnl-positive" : "pnl-negative"} style={{ fontWeight: 600 }}>
                  {p.pnl && p.pnl >= 0 ? "+" : ""}{(p.pnl || 0).toFixed(2)}
                </div>
                <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>USD</div>
              </div>
            </div>
          ))
        )}
      </div>

      {closedPositions.length > 0 && (
        <div className="card">
          <div className="card-title">Recent Closed</div>
          {closedPositions.map(p => (
            <div className="position-row" key={p.id}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span className="pair-name" style={{ fontSize: "13px" }}>{p.pair}</span>
                  <span className={`pair-side ${p.side === "LONG" ? "side-long" : "side-short"}`} style={{ fontSize: "10px" }}>
                    {p.side}
                  </span>
                </div>
              </div>
              <div className={p.pnl && p.pnl >= 0 ? "pnl-positive" : "pnl-negative"} style={{ fontWeight: 600, fontSize: "14px" }}>
                {p.pnl && p.pnl >= 0 ? "+" : ""}{(p.pnl || 0).toFixed(2)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
