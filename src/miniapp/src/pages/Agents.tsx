import { useState, useEffect } from "react";
import { getTelegramUser, getUser, getUserAgents, type AgentData } from "../api";

export function Agents() {
  const [agents, setAgents] = useState<AgentData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const tgUser = getTelegramUser();
      if (!tgUser) { setLoading(false); return; }
      try {
        const u = await getUser(tgUser.id);
        const a = await getUserAgents(u.id);
        setAgents(a);
      } catch {}
      setLoading(false);
    }
    load();
  }, []);

  if (loading) return <div className="loading">Loading agents...</div>;

  return (
    <div className="page">
      <div className="section-title">🤖 Trading Agents</div>

      {agents.length === 0 ? (
        <div className="empty-state">
          <div style={{ fontSize: "48px", marginBottom: "16px" }}>🤖</div>
          <p>No agents yet</p>
          <p style={{ fontSize: "13px", color: "var(--text-muted)" }}>
            Create an AI trading agent in the Telegram bot using /newagent
          </p>
        </div>
      ) : (
        agents.map(a => (
          <div className="agent-card" key={a.id} data-testid={`agent-${a.id}`}>
            <div className="agent-header">
              <div>
                <div className="agent-name">{a.name}</div>
                {a.description && <div className="agent-desc">{a.description}</div>}
              </div>
              <span className={`badge ${a.isActive && !a.isPaused ? "badge-active" : a.isPaused ? "badge-paused" : "badge-stopped"}`}>
                {a.isActive && !a.isPaused ? "▶ Active" : a.isPaused ? "⏸ Paused" : "⏹ Stopped"}
              </span>
            </div>

            <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "12px" }}>
              {a.exchange.toUpperCase()} • {a.pairs.join(", ")} • {a.timeframe}
            </div>

            <div className="stats-row" style={{ marginTop: 0 }}>
              <div className="stat-item">
                <div className="stat-value">{a.totalTrades}</div>
                <div className="stat-label">Trades</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{(a.winRate * 100).toFixed(0)}%</div>
                <div className="stat-label">Win Rate</div>
              </div>
              <div className="stat-item">
                <div className={`stat-value ${a.totalPnl >= 0 ? "pnl-positive" : "pnl-negative"}`}>
                  ${a.totalPnl.toFixed(2)}
                </div>
                <div className="stat-label">PnL</div>
              </div>
            </div>

            <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "12px" }}>
              Risk: {a.maxLeverage}x max lev • ${a.maxPositionSize} max pos • ${a.maxDailyLoss} daily loss • {a.stopLossPct}% SL / {a.takeProfitPct}% TP
            </div>

            {(a.erc8004Registered || a.bap578Registered || a.onchainRegistered) && (
              <div className="registry-info">
                {a.erc8004Registered && (
                  <span className="badge badge-registry">
                    🔗 ERC-8004 ({a.erc8004Chain || "bnb"} #{a.erc8004TokenId})
                  </span>
                )}
                {a.bap578Registered && <span className="badge badge-registry">📋 BAP-578</span>}
                {a.onchainRegistered && <span className="badge badge-registry">⛓ On-chain</span>}
              </div>
            )}

            {a.erc8004TxHash && (
              <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "6px", fontFamily: "monospace" }}>
                Tx: {a.erc8004TxHash.slice(0, 14)}...{a.erc8004TxHash.slice(-8)}
              </div>
            )}

            {a.creatorWallet && (
              <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "4px", fontFamily: "monospace" }}>
                Creator: {a.creatorWallet.slice(0, 8)}...{a.creatorWallet.slice(-6)}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
