import { useState, useEffect } from "react";
import { getTelegramUser, getUser, getUserAgents, getMyFeed, type AgentData, type FeedEntry } from "../api";

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function actionEmoji(a: string): string {
  if (a === "OPEN_LONG") return "🚀";
  if (a === "OPEN_SHORT") return "🔻";
  if (a === "CLOSE") return "✋";
  return "📊";
}
function actionLabel(a: string): string {
  if (a === "OPEN_LONG") return "LONG";
  if (a === "OPEN_SHORT") return "SHORT";
  if (a === "CLOSE") return "CLOSE";
  return "HOLD";
}

export function Agents() {
  const [agents, setAgents] = useState<AgentData[]>([]);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
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
      try {
        const f = await getMyFeed(20);
        setFeed(f);
      } catch {}
      setLoading(false);
    }
    load();

    // Poll the live feed every 30 seconds so users see new decisions appear
    // without having to leave and come back.
    const t = setInterval(async () => {
      try {
        const f = await getMyFeed(20);
        setFeed(f);
      } catch {}
    }, 30_000);
    return () => clearInterval(t);
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

      <div className="section-title" style={{ marginTop: "24px" }} data-testid="text-live-feed-title">
        🧠 Live Agent Feed
      </div>
      {feed.length === 0 ? (
        <div className="empty-state" style={{ padding: "16px" }}>
          <p style={{ fontSize: "13px", color: "var(--text-muted)" }}>
            No agent activity yet. Activate an agent and decisions will stream in here.
          </p>
        </div>
      ) : (
        feed.map((e) => {
          const isOpen = e.action === "OPEN_LONG" || e.action === "OPEN_SHORT";
          const isClose = e.action === "CLOSE";
          const accent = isOpen ? "var(--accent-green, #16c784)"
            : isClose ? "var(--accent-orange, #f0a029)"
            : "var(--text-muted)";
          return (
            <div
              key={e.id}
              className="agent-card"
              data-testid={`feed-${e.id}`}
              style={{ borderLeft: `3px solid ${accent}`, marginBottom: "8px" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div style={{ fontWeight: 600 }}>🤖 {e.agentName}</div>
                <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>{timeAgo(e.createdAt)}</div>
              </div>
              <div style={{ marginTop: "6px", fontSize: "14px" }}>
                {actionEmoji(e.action)} <strong>{actionLabel(e.action)}</strong>
                {e.pair ? ` — ${e.pair}` : ""}
                {e.price ? ` @ $${e.price.toFixed(e.price > 100 ? 2 : 4)}` : ""}
              </div>
              <div style={{ marginTop: "4px", fontSize: "12px", color: "var(--text-secondary)" }}>
                {e.regime ? `${e.regime}` : ""}
                {e.adx !== null ? ` | ADX ${e.adx.toFixed(1)}` : ""}
                {e.rsi !== null ? ` | RSI ${e.rsi.toFixed(0)}` : ""}
                {e.score !== null ? ` | Score ${e.score}/10` : ""}
              </div>
              {e.reason && (
                <div
                  style={{ marginTop: "6px", fontSize: "12px", color: "var(--text-muted)", fontStyle: "italic" }}
                  data-testid={`feed-reason-${e.id}`}
                >
                  "{e.reason}"
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
