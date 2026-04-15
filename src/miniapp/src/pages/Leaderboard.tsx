import { useState, useEffect } from "react";
import { getLeaderboard, type AgentData } from "../api";

export function Leaderboard() {
  const [agents, setAgents] = useState<AgentData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const data = await getLeaderboard();
        setAgents(data);
      } catch {}
      setLoading(false);
    }
    load();
  }, []);

  if (loading) return <div className="loading">Loading leaderboard...</div>;

  return (
    <div className="page">
      <div className="section-title">🏆 Agent Leaderboard</div>

      {agents.length === 0 ? (
        <div className="empty-state">
          <div style={{ fontSize: "48px", marginBottom: "16px" }}>🏆</div>
          <p>No listed agents yet</p>
          <p style={{ fontSize: "13px", color: "var(--text-muted)" }}>
            Top performing agents will appear here
          </p>
        </div>
      ) : (
        agents.map((a, i) => (
          <div className="agent-card" key={a.id} data-testid={`leaderboard-${i}`}>
            <div className="agent-header">
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <div style={{
                  width: "32px",
                  height: "32px",
                  borderRadius: "50%",
                  background: i < 3 ? "var(--accent)" : "var(--bg-secondary)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 700,
                  fontSize: "14px",
                }}>
                  {i < 3 ? ["🥇", "🥈", "🥉"][i] : i + 1}
                </div>
                <div>
                  <div className="agent-name">{a.name}</div>
                  {a.description && (
                    <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{a.description}</div>
                  )}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className={`${a.totalPnl >= 0 ? "pnl-positive" : "pnl-negative"}`} style={{ fontWeight: 700 }}>
                  {a.totalPnl >= 0 ? "+" : ""}${a.totalPnl.toFixed(2)}
                </div>
                <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                  {(a.winRate * 100).toFixed(0)}% win • {a.totalTrades} trades
                </div>
              </div>
            </div>

            {(a.erc8004Registered || a.onchainRegistered) && (
              <div className="registry-info">
                {a.erc8004Registered && (
                  <span className="badge badge-registry">🔗 ERC-8004</span>
                )}
                {a.onchainRegistered && (
                  <span className="badge badge-registry">⛓ Verified</span>
                )}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
