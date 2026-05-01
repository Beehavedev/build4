import "./_group.css";
import {
  Terminal,
  ArrowRight,
  ChevronDown,
  Wallet,
  Send,
  Wallet2,
  Activity,
  Sparkles,
  Bot,
} from "lucide-react";

const matrixChars =
  "0101 build4 init agent_001 ▍ deploy --chain bnb,base,xlayer ▍ wallet 0x1c3f...d4ad ▍ siwe ok ▍ session 30d ▍ aster ✓ hyperliquid ✓ polymarket ✓ ▍ ";

function MatrixColumn({ delay = 0 }: { delay?: number }) {
  const text = (matrixChars + matrixChars + matrixChars).split("").join("\n");
  return (
    <div
      style={{
        animation: `b4-fall 22s linear ${delay}s infinite`,
        whiteSpace: "pre",
      }}
    >
      {text}
    </div>
  );
}

export function Refreshed() {
  return (
    <div className="b4">
      <style>{`
        @keyframes b4-fall {
          0%   { transform: translateY(-50%); opacity: .0; }
          10%  { opacity: 1; }
          90%  { opacity: 1; }
          100% { transform: translateY(0%); opacity: 0; }
        }
      `}</style>

      {/* Matrix rain background */}
      <div className="matrix-rain" aria-hidden="true">
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            gridTemplateColumns: "repeat(28, 1fr)",
            gap: 0,
          }}
        >
          {Array.from({ length: 28 }).map((_, i) => (
            <MatrixColumn key={i} delay={(i * 0.7) % 18} />
          ))}
        </div>
      </div>
      <div className="matrix-bg" aria-hidden="true" />

      <div style={{ position: "relative", zIndex: 10 }} className="grid-overlay">
        {/* Nav */}
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
              maxWidth: 1152,
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
                beta
              </span>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              {[
                { label: "lifecycle", color: "var(--b4-muted)" },
                { label: "philosophy", color: "var(--b4-muted)" },
                { label: "Hire Agent", color: "var(--b4-muted)" },
                { label: "$B4", color: "var(--b4-primary)", bold: true },
                { label: "OnchainOS", color: "var(--b4-violet)" },
                { label: "Build", color: "var(--b4-emerald)" },
                { label: "Futures", color: "var(--b4-orange)", bold: true },
                { label: "Telegram Bot", color: "var(--b4-muted)" },
              ].map((l) => (
                <a
                  key={l.label}
                  href="#"
                  className="mono"
                  style={{
                    fontSize: 12,
                    color: l.color,
                    letterSpacing: "0.04em",
                    textDecoration: "none",
                    fontWeight: l.bold ? 600 : 400,
                  }}
                >
                  {l.label}
                </a>
              ))}
              <span
                className="mono"
                style={{ fontSize: 11, color: "var(--b4-muted)" }}
              >
                EN <span style={{ opacity: 0.4 }}>/ 中文 / ES</span>
              </span>

              {/* NEW: Launch dApp (primary green, distinct from Telegram launcher) */}
              <button
                className="b4-btn-primary"
                data-testid="button-launch-dapp"
                title="New: connect your wallet"
              >
                <Wallet size={14} />
                Launch dApp
              </button>
            </div>
          </div>
        </nav>

        {/* Hero */}
        <section style={{ position: "relative", overflow: "hidden" }}>
          <div
            style={{
              maxWidth: 1152,
              margin: "0 auto",
              padding: "112px 24px 120px",
              position: "relative",
              zIndex: 10,
            }}
          >
            <div style={{ maxWidth: 768 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 32,
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
                  BASE · BNB CHAIN · XLAYER
                </span>
              </div>

              <h1
                className="mono"
                style={{
                  fontSize: 84,
                  fontWeight: 700,
                  letterSpacing: "-0.02em",
                  lineHeight: 1.05,
                  marginBottom: 24,
                  marginTop: 0,
                }}
              >
                BUILD<span style={{ color: "var(--b4-primary)" }}>4</span>
              </h1>

              <p
                style={{
                  fontSize: 20,
                  color: "var(--b4-muted)",
                  lineHeight: 1.6,
                  maxWidth: 640,
                  marginBottom: 16,
                }}
              >
                Infrastructure for self-improving, self-replicating, autonomous AI
                agents on Bas_
              </p>

              {/* New small ribbon — same identity, just announces the dApp */}
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 12px",
                  background: "var(--b4-primary-soft)",
                  border: "1px solid var(--b4-primary-border)",
                  borderRadius: 999,
                  marginBottom: 32,
                }}
              >
                <Sparkles size={12} color="hsl(152 60% 42%)" />
                <span
                  className="mono"
                  style={{
                    fontSize: 11,
                    color: "var(--b4-primary)",
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    fontWeight: 600,
                  }}
                >
                  NEW · v2 web dApp · sign in with your wallet
                </span>
              </div>

              {/* Terminal block — exact same look, one new line */}
              <div
                style={{
                  marginTop: 24,
                  padding: 16,
                  borderRadius: 6,
                  background: "hsl(160 8% 7% / 0.8)",
                  border: "1px solid var(--b4-card-border)",
                  maxWidth: 512,
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 13,
                  lineHeight: 1.7,
                }}
              >
                <div>
                  <span style={{ color: "var(--b4-muted)" }}>$</span>{" "}
                  <span style={{ color: "var(--b4-fg)" }}>
                    build4 init --agent node_001
                  </span>
                </div>
                <div>
                  <span style={{ color: "var(--b4-muted)" }}>$</span>{" "}
                  <span style={{ color: "var(--b4-fg)" }}>
                    agent deploy --chain bnb,base,xlayer --mode autonomous
                  </span>
                </div>
                <div>
                  <span style={{ color: "var(--b4-primary)" }}>{">"}</span>{" "}
                  <span style={{ color: "var(--b4-fg)" }}>
                    Agent deployed. Wallet funded. Lifecycle started.
                  </span>
                </div>
                <div>
                  <span style={{ color: "var(--b4-muted)" }}>$</span>{" "}
                  <span style={{ color: "var(--b4-fg)" }}>
                    build4 wallet connect --siwe
                  </span>
                </div>
                <div>
                  <span style={{ color: "var(--b4-primary)" }}>{">"}</span>{" "}
                  <span style={{ color: "var(--b4-fg)" }}>
                    0x1c3f...d4ad ✓ session active · open the dApp
                  </span>
                </div>
              </div>

              {/* CTAs — primary stays the same; new outline-green Connect Wallet */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  marginTop: 40,
                  flexWrap: "wrap",
                }}
              >
                <button
                  className="b4-btn-primary b4-btn-primary-lg"
                  data-testid="button-launch-agent"
                >
                  Launch Agent
                  <ArrowRight size={16} />
                </button>

                <button
                  className="b4-btn-primary-outline"
                  data-testid="button-connect-wallet"
                  style={{ height: 44, padding: "0 18px", fontSize: 14 }}
                >
                  <Wallet size={16} />
                  Connect Wallet
                </button>

                <button
                  className="b4-btn-outline b4-btn-outline-lg"
                  data-testid="button-explore"
                >
                  Explore
                  <ChevronDown size={16} />
                </button>
              </div>
            </div>
          </div>

          {/* fade overlay */}
          <div
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              height: 128,
              background:
                "linear-gradient(to top, hsl(160 10% 4%), transparent)",
            }}
          />
        </section>

        {/* Stats — identical to current site */}
        <section
          style={{
            position: "relative",
            zIndex: 10,
            marginTop: -64,
            marginBottom: 96,
          }}
        >
          <div
            style={{
              maxWidth: 1152,
              margin: "0 auto",
              padding: "0 24px",
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 16,
            }}
          >
            {[
              { v: "391", l: "Unique Wallets", icon: Wallet2 },
              { v: "322.4K", l: "Transactions", icon: Activity },
              { v: "77", l: "Skills Created", icon: Terminal },
              { v: "461", l: "Active Agents", icon: Bot },
            ].map((s) => (
              <div
                key={s.l}
                className="b4-card"
                style={{
                  padding: 24,
                  textAlign: "center",
                }}
              >
                <s.icon
                  size={20}
                  color="hsl(152 60% 42%)"
                  style={{ margin: "0 auto 8px", display: "block" }}
                />
                <div
                  style={{
                    fontSize: 32,
                    fontWeight: 700,
                    color: "var(--b4-fg)",
                    lineHeight: 1.1,
                  }}
                >
                  {s.v}
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: 11,
                    color: "var(--b4-muted)",
                    marginTop: 6,
                    letterSpacing: "0.06em",
                  }}
                >
                  {s.l}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* "Two ways to BUILD4" — the only structurally new section.
            Same card chrome as the rest of the site. Frames the dApp as a
            sibling to the existing Telegram bot, not a replacement. */}
        <section
          style={{
            position: "relative",
            zIndex: 10,
            marginBottom: 80,
          }}
        >
          <div style={{ maxWidth: 1152, margin: "0 auto", padding: "0 24px" }}>
            <div style={{ marginBottom: 28 }}>
              <span
                className="mono"
                style={{
                  fontSize: 11,
                  color: "var(--b4-primary)",
                  letterSpacing: "0.2em",
                  textTransform: "uppercase",
                  fontWeight: 600,
                }}
              >
                ── TWO WAYS TO BUILD4
              </span>
              <h2
                style={{
                  fontSize: 28,
                  fontWeight: 700,
                  letterSpacing: "-0.01em",
                  marginTop: 8,
                  marginBottom: 0,
                }}
              >
                Same agents. Same venues.{" "}
                <span style={{ color: "var(--b4-primary)" }}>
                  Whichever surface you want.
                </span>
              </h2>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 16,
              }}
            >
              {/* Web dApp card (NEW) */}
              <div
                className="b4-card"
                style={{
                  padding: 28,
                  borderColor: "var(--b4-primary-border)",
                  background:
                    "linear-gradient(180deg, hsl(152 60% 42% / 0.04), hsl(160 8% 7%) 60%)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 14,
                  }}
                >
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 8,
                      background: "var(--b4-primary-soft)",
                      border: "1px solid var(--b4-primary-border)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Wallet size={20} color="hsl(152 60% 42%)" />
                  </div>
                  <span
                    className="mono"
                    style={{
                      fontSize: 10,
                      color: "var(--b4-primary)",
                      letterSpacing: "0.18em",
                      textTransform: "uppercase",
                      fontWeight: 700,
                      padding: "3px 8px",
                      border: "1px solid var(--b4-primary-border)",
                      borderRadius: 999,
                      background: "var(--b4-primary-soft)",
                    }}
                  >
                    new
                  </span>
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: 18,
                    fontWeight: 700,
                    marginBottom: 6,
                    color: "var(--b4-fg)",
                  }}
                >
                  Web dApp
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--b4-muted)",
                    lineHeight: 1.55,
                    marginBottom: 18,
                  }}
                >
                  Connect with WalletConnect, MetaMask, or any EVM wallet. Sign in
                  with your wallet (SIWE) — no Telegram, no email, just your keys.
                </div>
                <button
                  className="b4-btn-primary"
                  data-testid="button-card-launch-dapp"
                >
                  <Wallet size={14} />
                  Launch dApp
                  <ArrowRight size={14} />
                </button>
              </div>

              {/* Telegram Bot card (EXISTING) */}
              <div className="b4-card" style={{ padding: 28 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 14,
                  }}
                >
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 8,
                      background: "hsl(160 6% 12%)",
                      border: "1px solid var(--b4-border)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Send size={18} color="var(--b4-fg)" />
                  </div>
                  <span className="b4-pill b4-pill-live">
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 999,
                        background: "var(--b4-primary)",
                      }}
                    />
                    live
                  </span>
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: 18,
                    fontWeight: 700,
                    marginBottom: 6,
                    color: "var(--b4-fg)",
                  }}
                >
                  Telegram Bot
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--b4-muted)",
                    lineHeight: 1.55,
                    marginBottom: 18,
                  }}
                >
                  The original BUILD4 mini-app. Open inside Telegram, no install,
                  trade Aster · Hyperliquid · 42.space · Polymarket from one
                  interface.
                </div>
                <button
                  className="b4-btn-outline"
                  data-testid="button-card-open-bot"
                >
                  <Send size={14} />
                  Open @build4_bot
                  <ArrowRight size={14} />
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* tail strip — hint the page continues */}
        <div
          style={{
            maxWidth: 1152,
            margin: "0 auto 64px",
            padding: "0 24px",
          }}
        >
          <div
            style={{
              borderTop: "1px solid var(--b4-border)",
              paddingTop: 16,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              color: "var(--b4-muted)",
            }}
          >
            <span>↓ scroll for Trading Bot Challenge · features · lifecycle · OnchainOS · $B4</span>
            <span>v2.0 · same site, same identity</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Refreshed;
