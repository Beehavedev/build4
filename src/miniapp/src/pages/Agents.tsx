import { useState, useEffect } from "react";
import {
  getTelegramUser, getUser, getUserAgents, getMyFeed,
  updateAgentSettings,
  type AgentData, type FeedEntry
} from "../api";

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
  if (a === "SKIP_OPEN") return "🛑";
  return "📊";
}
function actionLabel(a: string): string {
  if (a === "OPEN_LONG") return "OPENED LONG";
  if (a === "OPEN_SHORT") return "OPENED SHORT";
  if (a === "CLOSE") return "CLOSED";
  if (a === "SKIP_OPEN") return "SKIPPED";
  return "HOLD";
}

// Plain-language label for the SKIP_OPEN gate identifier so the user sees
// WHICH check killed the trade rather than the internal codename.
function gateLabel(g: string | null | undefined): string {
  switch (g) {
    case "rr_floor":          return "risk/reward too low";
    case "confidence_floor":  return "AI confidence too low";
    case "setup_score_floor": return "setup score too low";
    case "risk_guard":        return "risk guard blocked";
    case "twak_risk":         return "flagged by Trust Wallet risk gate";
    case "no_balance":        return "insufficient balance";
    case "venue_rejected":    return "exchange rejected order";
    case "no_creds":          return "agent credentials missing";
    default:                  return g ?? "skipped";
  }
}

export function Agents() {
  const [agents, setAgents] = useState<AgentData[]>([]);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // Which agent's risk-limit editor is currently open (null = none).
  // Inline rather than a modal because the agent card already has its
  // own visual frame and modals on Telegram mini app feel disconnected
  // from the row they were launched from.
  const [editingId, setEditingId] = useState<string | null>(null);

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

  // Local optimistic update after a successful PATCH so the card reflects
  // the new values immediately without waiting for a refetch.
  function applyAgentUpdate(updated: AgentData) {
    setAgents(prev => prev.map(a => a.id === updated.id ? { ...a, ...updated } : a));
  }

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
              {a.exchange.toUpperCase()} • {a.pairs.includes("AUTO")
                ? (a.currentPair
                    ? `🎯 ${a.currentPair} (${a.lastScanScore ?? 0}/8)`
                    : `AUTO • scanning…`)
                : a.pairs.join(", ")} • {a.timeframe}
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

            <div style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              fontSize: "12px", color: "var(--text-muted)", marginTop: "12px", gap: 8
            }}>
              <span>
                Risk: {a.maxLeverage}x max lev • ${a.maxPositionSize} max pos • ${a.maxDailyLoss} daily loss
                {' • '}{a.stopLossPct}% SL / {a.takeProfitPct}% TP
              </span>
              <button
                onClick={() => setEditingId(editingId === a.id ? null : a.id)}
                data-testid={`button-edit-limits-${a.id}`}
                style={{
                  background: "transparent", color: "var(--text-secondary)",
                  border: "1px solid var(--border, #1e1e2e)",
                  borderRadius: 6, padding: "3px 8px", fontSize: 11,
                  cursor: "pointer", flexShrink: 0,
                }}
              >
                {editingId === a.id ? "Close" : "Edit limits"}
              </button>
            </div>

            {editingId === a.id && (
              <RiskEditor
                agent={a}
                onSaved={(u) => { applyAgentUpdate(u); setEditingId(null); }}
                onCancel={() => setEditingId(null)}
              />
            )}

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
          const isSkip = e.action === "SKIP_OPEN";
          const accent = isOpen   ? "var(--accent-green, #16c784)"
                       : isClose  ? "var(--accent-orange, #f0a029)"
                       : isSkip   ? "var(--accent-red, #ef4444)"
                       :            "var(--text-muted)";
          // For skipped trades, build an extra "intent" line so the user
          // sees what the agent WANTED to do (LONG/SHORT) and the gate
          // reason side by side. Without this the row would just say
          // "🛑 SKIPPED — XCNUSDT" with the cause buried in the reason
          // string only, which is exactly the visibility gap reported.
          let skipIntent = "";
          if (isSkip) {
            // Backend stored OPEN_LONG/OPEN_SHORT in `parsedAction` on
            // the underlying AgentLog row, but the feed doesn't carry
            // it. Infer side from the reason text as a best-effort
            // fallback so we don't have to change the wire format again.
            const r = (e.reason ?? "").toLowerCase();
            const inferredSide =
              r.includes(" long ")  || r.includes("long ")  ? "LONG"  :
              r.includes(" short ") || r.includes("short ") ? "SHORT" : null;
            skipIntent = inferredSide
              ? `Wanted to open ${inferredSide} — ${gateLabel(e.gate)}`
              : `Trade skipped — ${gateLabel(e.gate)}`;
          }
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
              {isSkip && (
                <div
                  style={{ marginTop: "4px", fontSize: "12px", color: "var(--accent-red, #ef4444)", fontWeight: 500 }}
                  data-testid={`feed-skip-intent-${e.id}`}
                >
                  {skipIntent}
                </div>
              )}
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

// Inline risk-limit editor. Validates locally first (so the user gets
// instant feedback on invalid input) then PATCHes the backend, which
// re-validates and clamps. On success, the parent card swaps in the
// returned agent and the editor closes.
function RiskEditor({
  agent, onSaved, onCancel,
}: {
  agent: AgentData;
  onSaved: (a: AgentData) => void;
  onCancel: () => void;
}) {
  const [pos, setPos] = useState(String(agent.maxPositionSize));
  const [loss, setLoss] = useState(String(agent.maxDailyLoss));
  const [lev, setLev] = useState(String(agent.maxLeverage));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function validate(): { ok: true; patch: { maxPositionSize: number; maxDailyLoss: number; maxLeverage: number } } | { ok: false; msg: string } {
    const p = Number(pos), l = Number(loss), v = Number(lev);
    if (!Number.isFinite(p) || p <= 0 || p > 100_000) return { ok: false, msg: "Max position must be > 0 and ≤ 100000" };
    if (!Number.isFinite(l) || l <= 0 || l > 100_000) return { ok: false, msg: "Max loss/day must be > 0 and ≤ 100000" };
    if (!Number.isFinite(v) || v < 1 || v > 50)       return { ok: false, msg: "Max leverage must be between 1 and 50" };
    return { ok: true, patch: { maxPositionSize: p, maxDailyLoss: l, maxLeverage: Math.round(v) } };
  }

  async function save() {
    const v = validate();
    if (!v.ok) { setErr(v.msg); return; }
    setSaving(true); setErr(null);
    try {
      const updated = await updateAgentSettings(agent.id, v.patch);
      onSaved(updated);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    background: "#0a0a0f", color: "#e2e8f0",
    border: "1px solid #1e1e2e", borderRadius: 6,
    padding: "6px 8px", fontSize: 13, width: "100%",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 11, color: "var(--text-muted)", marginBottom: 4,
  };

  return (
    <div
      data-testid={`risk-editor-${agent.id}`}
      style={{
        marginTop: 10, padding: 12,
        background: "rgba(255,255,255,0.02)",
        border: "1px solid var(--border, #1e1e2e)",
        borderRadius: 8,
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        <div>
          <div style={labelStyle}>Max position ($)</div>
          <input
            type="number" min={1} step={1} value={pos}
            onChange={(e) => setPos(e.target.value)}
            data-testid={`input-max-position-${agent.id}`}
            style={inputStyle}
          />
        </div>
        <div>
          <div style={labelStyle}>Max loss/day ($)</div>
          <input
            type="number" min={1} step={1} value={loss}
            onChange={(e) => setLoss(e.target.value)}
            data-testid={`input-max-daily-loss-${agent.id}`}
            style={inputStyle}
          />
        </div>
        <div>
          <div style={labelStyle}>Max leverage (x)</div>
          <input
            type="number" min={1} max={50} step={1} value={lev}
            onChange={(e) => setLev(e.target.value)}
            data-testid={`input-max-leverage-${agent.id}`}
            style={inputStyle}
          />
        </div>
      </div>
      {err && (
        <div
          data-testid={`risk-editor-error-${agent.id}`}
          style={{ marginTop: 8, fontSize: 12, color: "var(--accent-red, #ef4444)" }}
        >
          {err}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 10, justifyContent: "flex-end" }}>
        <button
          onClick={onCancel}
          disabled={saving}
          data-testid={`button-cancel-edit-${agent.id}`}
          style={{
            background: "transparent", color: "var(--text-secondary)",
            border: "1px solid var(--border, #1e1e2e)",
            borderRadius: 6, padding: "6px 12px", fontSize: 12, cursor: "pointer",
          }}
        >
          Cancel
        </button>
        <button
          onClick={save}
          disabled={saving}
          data-testid={`button-save-edit-${agent.id}`}
          style={{
            background: "#7c3aed", color: "white",
            border: "none", borderRadius: 6, padding: "6px 12px",
            fontSize: 12, fontWeight: 600, cursor: saving ? "wait" : "pointer",
            opacity: saving ? 0.7 : 1,
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
