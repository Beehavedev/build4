import "./_group.css";
import {
  Terminal,
  Wallet,
  LogOut,
  ArrowRight,
  TrendingUp,
  TrendingDown,
  Plus,
  Activity,
  Bot,
  CircleCheck,
  CircleX,
  Clock,
  Copy as CopyIcon,
} from "lucide-react";

type VenueStatus = "live" | "fund-to-start" | "not-activated";

interface Venue {
  key: string;
  name: string;
  sub: string;
  value: string;
  mode: string;
  status: VenueStatus;
}

const venues: Venue[] = [
  {
    key: "aster",
    name: "ASTER",
    sub: "Futures · BSC",
    value: "$1,284.50",
    mode: "manual & AI",
    status: "live",
  },
  {
    key: "hyperliquid",
    name: "HYPERLIQUID",
    sub: "Perps · USDC",
    value: "$842.18",
    mode: "manual & AI",
    status: "live",
  },
  {
    key: "42space",
    name: "42.SPACE",
    sub: "Predict · BSC",
    value: "$245.00",
    mode: "manual & AI",
    status: "fund-to-start",
  },
  {
    key: "polymarket",
    name: "POLYMARKET",
    sub: "Predict · Polygon",
    value: "$0.00",
    mode: "not activated",
    status: "not-activated",
  },
];

const trades = [
  {
    id: 1,
    icon: "win" as const,
    pair: "BTCUSDT",
    side: "LONG",
    venue: "Aster",
    pnl: +84.22,
    when: "12m",
  },
  {
    id: 2,
    icon: "win" as const,
    pair: "ETHUSDC",
    side: "LONG",
    venue: "Hyperliquid",
    pnl: +31.05,
    when: "1h",
  },
  {
    id: 3,
    icon: "open" as const,
    pair: "SOLUSDT",
    side: "SHORT",
    venue: "Aster",
    pnl: 0,
    when: "2h",
  },
  {
    id: 4,
    icon: "loss" as const,
    pair: "Trump 2028",
    side: "YES",
    venue: "Polymarket",
    pnl: -12.4,
    when: "5h",
  },
  {
    id: 5,
    icon: "win" as const,
    pair: "BNB-USDT",
    side: "LONG",
    venue: "42.space",
    pnl: +6.18,
    when: "1d",
  },
];

function StatusPill({ status }: { status: VenueStatus }) {
  if (status === "live") {
    return (
      <span className="b4-pill b4-pill-live" data-testid="pill-live">
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: "var(--b4-primary)",
            boxShadow: "0 0 6px hsl(152 60% 42%)",
          }}
        />
        LIVE
      </span>
    );
  }
  if (status === "fund-to-start") {
    return (
      <span className="b4-pill b4-pill-amber" data-testid="pill-fund">
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: "var(--b4-amber)",
          }}
        />
        FUND TO START
      </span>
    );
  }
  return (
    <span className="b4-pill" data-testid="pill-not-activated">
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: "var(--b4-muted)",
        }}
      />
      NOT ACTIVATED
    </span>
  );
}

function TradeIcon({ kind }: { kind: "win" | "loss" | "open" }) {
  if (kind === "win")
    return <CircleCheck size={16} color="hsl(152 60% 50%)" />;
  if (kind === "loss") return <CircleX size={16} color="#ef4444" />;
  return <Clock size={16} color="var(--b4-muted)" />;
}

export function Dashboard() {
  const totalValue = 2371.68;
  const todayPnl = +108.85;
  const todayPct = (todayPnl / totalValue) * 100;

  return (
    <div className="b4">
      <div style={{ position: "relative", zIndex: 10 }} className="grid-overlay">
        {/* Nav — same identity as Refreshed homepage */}
        <nav
          style={{
            position: "sticky",
            top: 0,
            zIndex: 50,
            background: "hsl(160 10% 4% / 0.9)",
            backdropFilter: "blur(20px)",
            borderBottom: "1px solid var(--b4-border)",
          }}
        >
          <div
            style={{
              maxWidth: 1280,
              margin: "0 auto",
              padding: "0 24px",
              height: 56,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  background: "var(--b4-primary-soft)",
                  border: "1px solid var(--b4-primary-border)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Terminal size={14} color="hsl(152 60% 42%)" />
              </div>
              <span
                className="mono"
                style={{ fontWeight: 700, fontSize: 14, letterSpacing: "0.02em" }}
              >
                BUILD<span style={{ color: "var(--b4-primary)" }}>4</span>
              </span>
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  padding: "2px 6px",
                  borderRadius: 4,
                  border: "1px solid var(--b4-primary-border)",
                  background: "var(--b4-primary-soft)",
                  color: "var(--b4-primary)",
                }}
              >
                dApp
              </span>
            </div>

            {/* dApp-mode nav: trimmed to in-app sections */}
            <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
              {[
                { label: "Dashboard", active: true },
                { label: "Agents", active: false },
                { label: "Trade", active: false },
                { label: "Predict", active: false },
                { label: "Portfolio", active: false },
                { label: "$B4", active: false, color: "var(--b4-primary)" },
              ].map((l) => (
                <a
                  key={l.label}
                  href="#"
                  className="mono"
                  style={{
                    fontSize: 12,
                    color: l.active
                      ? "var(--b4-fg)"
                      : l.color || "var(--b4-muted)",
                    letterSpacing: "0.04em",
                    textDecoration: "none",
                    fontWeight: l.active ? 600 : 400,
                    paddingBottom: 2,
                    borderBottom: l.active
                      ? "1px solid var(--b4-primary)"
                      : "1px solid transparent",
                  }}
                >
                  {l.label}
                </a>
              ))}
            </div>

            {/* Wallet pill — replaces Telegram session header */}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 10px 6px 8px",
                  borderRadius: 999,
                  background: "var(--b4-primary-soft)",
                  border: "1px solid var(--b4-primary-border)",
                }}
                data-testid="wallet-pill"
              >
                <span
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 999,
                    background:
                      "conic-gradient(from 90deg, #2bab6a, #9d8eff, #fb923c, #2bab6a)",
                  }}
                />
                <span
                  className="mono"
                  style={{
                    fontSize: 12,
                    color: "var(--b4-fg)",
                    fontWeight: 600,
                  }}
                >
                  0x1c3f...d4ad
                </span>
                <CopyIcon
                  size={11}
                  color="var(--b4-muted)"
                  style={{ cursor: "pointer" }}
                />
              </div>
              <button
                className="b4-btn-outline"
                style={{ height: 32, padding: "0 10px", fontSize: 12 }}
                data-testid="button-disconnect"
                title="Disconnect wallet"
              >
                <LogOut size={12} />
                Disconnect
              </button>
            </div>
          </div>
        </nav>

        {/* Page body */}
        <div
          style={{
            maxWidth: 1280,
            margin: "0 auto",
            padding: "32px 24px 56px",
          }}
        >
          {/* Title row */}
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "space-between",
              marginBottom: 24,
            }}
          >
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 6,
                }}
              >
                <span className="pulse-dot" />
                <span
                  className="mono"
                  style={{
                    fontSize: 11,
                    color: "var(--b4-muted)",
                    letterSpacing: "0.2em",
                    textTransform: "uppercase",
                  }}
                >
                  WALLET CONNECTED · BSC · POLYGON · BASE
                </span>
              </div>
              <h1
                style={{
                  fontSize: 28,
                  fontWeight: 700,
                  margin: 0,
                  letterSpacing: "-0.01em",
                }}
              >
                <span className="mono">⚡ BUILD4 </span>
                <span style={{ color: "var(--b4-muted)", fontWeight: 400 }}>
                  · AI Trading & Predictions
                </span>
              </h1>
            </div>
            <button
              className="b4-btn-primary b4-btn-primary-lg"
              data-testid="button-deploy-agent"
            >
              <Plus size={16} />
              Deploy Agent
            </button>
          </div>

          {/* Hero — Total Portfolio Value */}
          <div
            className="b4-card"
            style={{
              padding: 28,
              marginBottom: 20,
              background:
                "linear-gradient(180deg, hsl(152 60% 42% / 0.04), hsl(160 8% 7%) 70%)",
              borderColor: "var(--b4-primary-border)",
            }}
            data-testid="card-total-portfolio"
          >
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 24,
              }}
            >
              <div>
                <div
                  className="mono"
                  style={{
                    fontSize: 11,
                    color: "var(--b4-muted)",
                    letterSpacing: "0.2em",
                    textTransform: "uppercase",
                    fontWeight: 600,
                    marginBottom: 10,
                  }}
                >
                  TOTAL PORTFOLIO VALUE
                </div>
                <div
                  style={{
                    fontSize: 56,
                    fontWeight: 800,
                    letterSpacing: "-0.02em",
                    lineHeight: 1.05,
                    color: "var(--b4-fg)",
                  }}
                  data-testid="text-total-value"
                >
                  ${totalValue.toLocaleString("en-US", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </div>
                <div
                  style={{
                    marginTop: 8,
                    fontSize: 14,
                    color:
                      todayPnl > 0
                        ? "hsl(152 60% 50%)"
                        : todayPnl < 0
                        ? "#ef4444"
                        : "var(--b4-muted)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                  data-testid="text-today-pnl"
                >
                  {todayPnl >= 0 ? (
                    <TrendingUp size={14} />
                  ) : (
                    <TrendingDown size={14} />
                  )}
                  {todayPnl >= 0 ? "+" : "-"}$
                  {Math.abs(todayPnl).toFixed(2)} today (
                  {todayPct >= 0 ? "+" : ""}
                  {todayPct.toFixed(2)}%)
                </div>
              </div>

              {/* Sparkline-style mini chart */}
              <div style={{ flexShrink: 0 }}>
                <svg
                  width="280"
                  height="84"
                  viewBox="0 0 280 84"
                  style={{ display: "block" }}
                >
                  <defs>
                    <linearGradient id="b4spark" x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" stopColor="hsl(152 60% 42%)" stopOpacity="0.45" />
                      <stop offset="100%" stopColor="hsl(152 60% 42%)" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  <path
                    d="M0,60 L20,55 L40,58 L60,48 L80,52 L100,40 L120,44 L140,32 L160,36 L180,28 L200,22 L220,30 L240,18 L260,22 L280,12 L280,84 L0,84 Z"
                    fill="url(#b4spark)"
                  />
                  <path
                    d="M0,60 L20,55 L40,58 L60,48 L80,52 L100,40 L120,44 L140,32 L160,36 L180,28 L200,22 L220,30 L240,18 L260,22 L280,12"
                    fill="none"
                    stroke="hsl(152 60% 50%)"
                    strokeWidth="1.5"
                  />
                </svg>
                <div
                  className="mono"
                  style={{
                    fontSize: 10,
                    color: "var(--b4-muted)",
                    letterSpacing: "0.12em",
                    textAlign: "right",
                    marginTop: 2,
                    textTransform: "uppercase",
                  }}
                >
                  7D · all venues
                </div>
              </div>
            </div>
          </div>

          {/* Venue grid — 2×2 of cards, mirroring the bot's Dashboard */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
              marginBottom: 24,
            }}
          >
            {venues.map((v) => (
              <div
                key={v.key}
                className="b4-card"
                style={{ padding: 18 }}
                data-testid={`card-venue-${v.key}`}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: 12,
                  }}
                >
                  <div>
                    <div
                      className="mono"
                      style={{
                        fontSize: 12,
                        color: "var(--b4-fg)",
                        fontWeight: 700,
                        letterSpacing: "0.06em",
                      }}
                    >
                      {v.name}
                    </div>
                    <div
                      className="mono"
                      style={{
                        fontSize: 10,
                        color: "var(--b4-muted)",
                        marginTop: 2,
                        letterSpacing: "0.04em",
                      }}
                    >
                      {v.sub}
                    </div>
                  </div>
                  <StatusPill status={v.status} />
                </div>

                <div
                  style={{
                    fontSize: 24,
                    fontWeight: 700,
                    marginTop: 14,
                    color: "var(--b4-fg)",
                  }}
                >
                  {v.value}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--b4-muted)",
                    marginTop: 4,
                  }}
                >
                  {v.mode}
                </div>

                <div
                  style={{
                    marginTop: 14,
                    display: "flex",
                    gap: 8,
                  }}
                >
                  <button
                    className="b4-btn-outline"
                    style={{ height: 30, padding: "0 10px", fontSize: 11, flex: 1 }}
                    data-testid={`button-trade-${v.key}`}
                  >
                    Open {v.sub.includes("Predict") ? "predictions" : "trade"}
                    <ArrowRight size={12} />
                  </button>
                  {v.status !== "live" && (
                    <button
                      className="b4-btn-primary-outline"
                      style={{ height: 30, padding: "0 10px", fontSize: 11 }}
                      data-testid={`button-fund-${v.key}`}
                    >
                      <Plus size={12} />
                      Fund
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Quick actions + Recent trades — two columns */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 16,
            }}
          >
            {/* Quick actions */}
            <div className="b4-card" style={{ padding: 20 }}>
              <div
                className="mono"
                style={{
                  fontSize: 11,
                  color: "var(--b4-muted)",
                  letterSpacing: "0.18em",
                  textTransform: "uppercase",
                  fontWeight: 600,
                  marginBottom: 14,
                }}
              >
                ── QUICK ACTIONS
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 8,
                }}
              >
                {[
                  { label: "Aster", sub: "Perps", icon: TrendingUp },
                  { label: "Hyperliquid", sub: "Perps", icon: Activity },
                  { label: "42.space", sub: "Predict", icon: Bot },
                  { label: "Polymarket", sub: "Predict", icon: Bot },
                ].map((a) => (
                  <button
                    key={a.label}
                    className="b4-btn-outline"
                    style={{
                      height: "auto",
                      padding: "14px 8px",
                      flexDirection: "column",
                      gap: 4,
                    }}
                    data-testid={`quick-${a.label.toLowerCase()}`}
                  >
                    <a.icon size={16} color="hsl(152 60% 42%)" />
                    <span
                      className="mono"
                      style={{ fontSize: 13, fontWeight: 600 }}
                    >
                      {a.label}
                    </span>
                    <span
                      className="mono"
                      style={{ fontSize: 10, color: "var(--b4-muted)" }}
                    >
                      {a.sub}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Recent trades */}
            <div className="b4-card" style={{ padding: 20 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 14,
                }}
              >
                <div
                  className="mono"
                  style={{
                    fontSize: 11,
                    color: "var(--b4-muted)",
                    letterSpacing: "0.18em",
                    textTransform: "uppercase",
                    fontWeight: 600,
                  }}
                >
                  ── RECENT TRADES
                </div>
                <a
                  href="#"
                  className="mono"
                  style={{
                    fontSize: 11,
                    color: "var(--b4-primary)",
                    textDecoration: "none",
                  }}
                >
                  View all →
                </a>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {trades.map((t) => (
                  <div
                    key={t.id}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "20px 1fr auto auto",
                      alignItems: "center",
                      gap: 10,
                      padding: "10px 6px",
                      borderTop: "1px solid var(--b4-border)",
                    }}
                    data-testid={`trade-row-${t.id}`}
                  >
                    <TradeIcon kind={t.icon} />
                    <div>
                      <div
                        className="mono"
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: "var(--b4-fg)",
                        }}
                      >
                        {t.pair}{" "}
                        <span
                          style={{
                            color:
                              t.side === "LONG" || t.side === "YES"
                                ? "hsl(152 60% 50%)"
                                : "#ef4444",
                            fontWeight: 600,
                          }}
                        >
                          {t.side}
                        </span>
                      </div>
                      <div
                        className="mono"
                        style={{
                          fontSize: 10,
                          color: "var(--b4-muted)",
                          marginTop: 1,
                        }}
                      >
                        {t.venue}
                      </div>
                    </div>
                    <div
                      className="mono"
                      style={{
                        fontSize: 13,
                        fontWeight: 700,
                        color:
                          t.icon === "open"
                            ? "var(--b4-muted)"
                            : t.pnl > 0
                            ? "hsl(152 60% 50%)"
                            : "#ef4444",
                      }}
                    >
                      {t.icon === "open"
                        ? "—"
                        : `${t.pnl > 0 ? "+" : "-"}$${Math.abs(t.pnl).toFixed(2)}`}
                    </div>
                    <div
                      className="mono"
                      style={{
                        fontSize: 10,
                        color: "var(--b4-muted)",
                        minWidth: 24,
                        textAlign: "right",
                      }}
                    >
                      {t.when}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Footer hint */}
          <div
            style={{
              marginTop: 24,
              borderTop: "1px solid var(--b4-border)",
              paddingTop: 14,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              color: "var(--b4-muted)",
            }}
          >
            <span>
              <Wallet
                size={11}
                color="hsl(152 60% 42%)"
                style={{ verticalAlign: "middle", marginRight: 6 }}
              />
              Signed in with wallet · session expires in 29d
            </span>
            <span>↓ scroll for $B4 buybacks · agent leaderboard · positions</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Dashboard;
