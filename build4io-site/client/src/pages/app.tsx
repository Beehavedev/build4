import { useEffect, useState, useCallback, useRef } from "react";
import { useWallet } from "@/hooks/use-wallet";
import { WalletConnector } from "@/components/wallet-connector";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  ShieldCheck,
  Wallet,
  ExternalLink,
  LogOut,
  Send,
  Bot,
  AlertCircle,
  Activity,
  TrendingUp,
  TrendingDown,
  Pause,
  Play,
  Circle,
  RefreshCw,
  Coins,
} from "lucide-react";
import { Link } from "wouter";

const SESSION_KEY = "build4_session_token";

type AgentSummary = {
  id: string;
  name: string;
  description: string | null;
  exchange: string;
  enabledVenues: string[];
  pairs: string[];
  isActive: boolean;
  isPaused: boolean;
  totalPnl: number;
  totalTrades: number;
  winRate: number;
  walletAddress: string | null;
  createdAt: string;
};

type AgentLogEntry = {
  id: string;
  agentId: string;
  agentName: string | null;
  createdAt: string;
  action: string;
  parsedAction: string | null;
  pair: string | null;
  price: number | null;
  reason: string | null;
  exchange: string | null;
  error: string | null;
};

type BotUser = {
  userId: string;
  telegramId: string;
  username: string | null;
  firstName: string | null;
  b4Balance: number;
  asterOnboarded: boolean;
  bscWalletAddress: string | null;
  agentCount: number;
  activeAgentCount: number;
};

type Session = {
  kind: "wallet" | "telegram";
  expiresAt: string;
  wallet?: string | null;
  telegramPhotoUrl?: string | null;
};

type AuthState =
  | { kind: "loading" }
  | { kind: "disconnected" }
  | { kind: "needs-signature" }
  | { kind: "signing" }
  | { kind: "authed"; session: Session; botUser: BotUser | null }
  | { kind: "no-account"; via: "wallet" | "telegram"; message: string }
  | { kind: "error"; message: string };

function buildSiweMessage(address: string, nonce: string, chainId: number): string {
  const domain = typeof window !== "undefined" ? window.location.host : "build4.io";
  const origin = typeof window !== "undefined" ? window.location.origin : "https://build4.io";
  const issuedAt = new Date().toISOString();
  const expiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    "",
    "Sign in to BUILD4 to access your AI trading dashboard.",
    "",
    `URI: ${origin}`,
    "Version: 1",
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expiry}`,
  ].join("\n");
}

function TelegramLoginButton({
  botUsername,
  onAuth,
}: {
  botUsername: string;
  onAuth: (data: any) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const callbackName = useRef(`onTgAuth_${Math.floor(Math.random() * 1e9)}`);

  useEffect(() => {
    (window as any)[callbackName.current] = onAuth;
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.setAttribute("data-telegram-login", botUsername);
    script.setAttribute("data-size", "large");
    script.setAttribute("data-userpic", "false");
    script.setAttribute("data-request-access", "write");
    script.setAttribute("data-onauth", `${callbackName.current}(user)`);
    containerRef.current?.appendChild(script);
    return () => {
      try { delete (window as any)[callbackName.current]; } catch {}
      if (containerRef.current) containerRef.current.innerHTML = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botUsername]);

  return <div ref={containerRef} data-testid="telegram-login-widget" />;
}

function fmtRelative(iso: string): string {
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const dd = Math.floor(h / 24);
  if (dd < 30) return `${dd}d ago`;
  return d.toISOString().slice(0, 10);
}

type BalancesPayload = {
  bsc: { address: string | null; usdt: { ok: boolean; amount: number; error?: string } };
  polymarket: { safeAddress: string | null; usdce: { ok: boolean; amount: number; error?: string } };
  fetchedAt: string;
};

function BalancesCard() {
  const [data, setData] = useState<BalancesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    const token = localStorage.getItem(SESSION_KEY);
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/web/balances", { headers: { "x-session-token": token } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as BalancesPayload;
      setData(j);
    } catch (e: any) {
      setError(e?.message || "Failed to load balances");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const total = data
    ? (data.bsc.usdt.ok ? data.bsc.usdt.amount : 0) +
      (data.polymarket.usdce.ok ? data.polymarket.usdce.amount : 0)
    : 0;

  return (
    <Card className="p-6 space-y-4" data-testid="card-balances">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-mono text-sm font-bold flex items-center gap-2">
          <Coins className="w-4 h-4" /> Live on-chain balances
        </h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={refresh}
          disabled={loading}
          className="h-7 gap-1 font-mono text-xs"
          data-testid="button-refresh-balances"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {!data && !error && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Reading from BSC + Polygon…
        </div>
      )}
      {error && (
        <p className="text-xs text-destructive font-mono" data-testid="text-balances-error">
          {error}
        </p>
      )}

      {data && (
        <>
          <div
            className="text-center py-3 border rounded-md bg-muted/30"
            data-testid="stat-balance-total"
          >
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-mono">
              Total deposited (live)
            </p>
            <p className="font-mono text-2xl font-bold mt-1">${total.toFixed(2)}</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="border rounded-md p-3 space-y-1.5" data-testid="row-balance-bsc">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-mono">
                  BSC · USDT
                </p>
                <Badge variant="outline" className="font-mono text-[9px]">BNB Chain</Badge>
              </div>
              {data.bsc.address ? (
                <>
                  <p
                    className={`font-mono text-lg font-bold ${
                      data.bsc.usdt.ok ? "" : "text-muted-foreground"
                    }`}
                  >
                    {data.bsc.usdt.ok ? `$${data.bsc.usdt.amount.toFixed(2)}` : "—"}
                  </p>
                  <a
                    href={`https://bscscan.com/address/${data.bsc.address}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`View Build4 BSC deposit wallet ${data.bsc.address} on BscScan`}
                    title="View on BscScan"
                    className="text-[10px] font-mono text-muted-foreground underline break-all inline-flex items-center gap-1"
                    data-testid="link-bsc-address"
                  >
                    {data.bsc.address.slice(0, 8)}…{data.bsc.address.slice(-6)}
                    <ExternalLink className="w-2.5 h-2.5" />
                  </a>
                  {!data.bsc.usdt.ok && data.bsc.usdt.error && (
                    <p className="text-[10px] text-destructive font-mono">{data.bsc.usdt.error}</p>
                  )}
                </>
              ) : (
                <p className="text-xs text-muted-foreground">No BSC wallet linked yet.</p>
              )}
            </div>

            <div className="border rounded-md p-3 space-y-1.5" data-testid="row-balance-polymarket">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-mono">
                  Polymarket · USDC.e
                </p>
                <Badge variant="outline" className="font-mono text-[9px]">Polygon Safe</Badge>
              </div>
              {data.polymarket.safeAddress ? (
                <>
                  <p
                    className={`font-mono text-lg font-bold ${
                      data.polymarket.usdce.ok ? "" : "text-muted-foreground"
                    }`}
                  >
                    {data.polymarket.usdce.ok ? `$${data.polymarket.usdce.amount.toFixed(2)}` : "—"}
                  </p>
                  <a
                    href={`https://polygonscan.com/address/${data.polymarket.safeAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`View Polymarket Safe wallet ${data.polymarket.safeAddress} on Polygonscan`}
                    title="View Polymarket Safe on Polygonscan"
                    className="text-[10px] font-mono text-muted-foreground underline break-all inline-flex items-center gap-1"
                    data-testid="link-polymarket-safe"
                  >
                    {data.polymarket.safeAddress.slice(0, 8)}…{data.polymarket.safeAddress.slice(-6)}
                    <ExternalLink className="w-2.5 h-2.5" />
                  </a>
                  {!data.polymarket.usdce.ok && data.polymarket.usdce.error && (
                    <p className="text-[10px] text-destructive font-mono">
                      {data.polymarket.usdce.error}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Safe not deployed. Run <span className="font-mono">/setup</span> in the bot to enable
                  Polymarket trading.
                </p>
              )}
            </div>
          </div>

          <p className="text-[10px] text-muted-foreground font-mono text-right">
            Cached up to 15s · last fetched {fmtRelative(data.fetchedAt)}
          </p>
        </>
      )}
    </Card>
  );
}

function AgentsCard() {
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const token = localStorage.getItem(SESSION_KEY);
    if (!token) return;
    let cancelled = false;
    fetch("/api/web/agents", { headers: { "x-session-token": token } })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => {
        if (cancelled) return;
        setAgents(j.agents || []);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message || "Failed to load agents");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card className="p-6 space-y-4" data-testid="card-agents">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-mono text-sm font-bold">Your AI agents</h2>
        {agents && (
          <Badge variant="outline" className="font-mono text-[10px]" data-testid="badge-agents-count">
            {agents.length} total
          </Badge>
        )}
      </div>
      {!agents && !error && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading agents…
        </div>
      )}
      {error && (
        <p className="text-xs text-destructive font-mono" data-testid="text-agents-error">
          {error}
        </p>
      )}
      {agents && agents.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="text-no-agents">
          You don't have any AI agents yet. Create one in the Telegram bot via <span className="font-mono">/agent</span>.
        </p>
      )}
      {agents && agents.length > 0 && (
        <div className="space-y-2" data-testid="list-agents">
          {agents.map((a) => {
            const status = a.isPaused ? "paused" : a.isActive ? "active" : "stopped";
            const StatusIcon = a.isPaused ? Pause : a.isActive ? Play : Circle;
            const statusColor = a.isPaused
              ? "text-yellow-500"
              : a.isActive
              ? "text-green-500"
              : "text-muted-foreground";
            return (
              <div
                key={a.id}
                className="border rounded-md p-3 flex items-start justify-between gap-3 flex-wrap hover-elevate"
                data-testid={`row-agent-${a.id}`}
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-mono text-sm font-bold truncate">{a.name}</p>
                    <Badge variant="outline" className={`font-mono text-[10px] gap-1 ${statusColor}`}>
                      <StatusIcon className="w-3 h-3" />
                      {status}
                    </Badge>
                    <Badge variant="outline" className="font-mono text-[10px] uppercase">
                      {a.exchange}
                    </Badge>
                    {a.pairs.slice(0, 3).map((p) => (
                      <Badge key={p} variant="secondary" className="font-mono text-[10px]">
                        {p}
                      </Badge>
                    ))}
                  </div>
                  {a.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2">{a.description}</p>
                  )}
                </div>
                <div className="text-right">
                  <p
                    className={`font-mono text-sm font-bold ${
                      a.totalPnl > 0 ? "text-green-500" : a.totalPnl < 0 ? "text-destructive" : ""
                    }`}
                    data-testid={`stat-agent-pnl-${a.id}`}
                  >
                    {a.totalPnl >= 0 ? "+" : ""}${a.totalPnl.toFixed(2)}
                  </p>
                  <p className="text-[10px] text-muted-foreground font-mono">
                    {a.totalTrades} trades · {(a.winRate * 100).toFixed(0)}% win
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function ActivityCard() {
  const [logs, setLogs] = useState<AgentLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const token = localStorage.getItem(SESSION_KEY);
    if (!token) return;
    let cancelled = false;
    fetch("/api/web/activity?limit=20", { headers: { "x-session-token": token } })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => {
        if (cancelled) return;
        setLogs(j.logs || []);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message || "Failed to load activity");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card className="p-6 space-y-4" data-testid="card-activity">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-mono text-sm font-bold flex items-center gap-2">
          <Activity className="w-4 h-4" /> Recent agent activity
        </h2>
      </div>
      {!logs && !error && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading activity…
        </div>
      )}
      {error && (
        <p className="text-xs text-destructive font-mono" data-testid="text-activity-error">
          {error}
        </p>
      )}
      {logs && logs.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="text-no-activity">
          No agent activity yet. Once your agents start running, their decisions show up here.
        </p>
      )}
      {logs && logs.length > 0 && (
        <div className="space-y-2" data-testid="list-activity">
          {logs.map((l) => {
            const action = (l.parsedAction || l.action || "").toLowerCase();
            const isBuy = action.includes("buy") || action.includes("long");
            const isSell = action.includes("sell") || action.includes("short") || action.includes("close");
            const Icon = isBuy ? TrendingUp : isSell ? TrendingDown : Circle;
            const color = l.error
              ? "text-destructive"
              : isBuy
              ? "text-green-500"
              : isSell
              ? "text-yellow-500"
              : "text-muted-foreground";
            return (
              <div
                key={l.id}
                className="border rounded-md p-2.5 flex items-start gap-2.5 text-xs"
                data-testid={`row-activity-${l.id}`}
              >
                <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${color}`} />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono font-bold uppercase">
                      {l.parsedAction || l.action}
                    </span>
                    {l.pair && (
                      <Badge variant="secondary" className="font-mono text-[9px]">
                        {l.pair}
                      </Badge>
                    )}
                    {l.exchange && (
                      <Badge variant="outline" className="font-mono text-[9px] uppercase">
                        {l.exchange}
                      </Badge>
                    )}
                    {l.price != null && (
                      <span className="font-mono text-muted-foreground">
                        @ ${l.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </span>
                    )}
                  </div>
                  {l.reason && (
                    <p className="text-muted-foreground line-clamp-2">{l.reason}</p>
                  )}
                  {l.error && (
                    <p className="text-destructive font-mono line-clamp-1">{l.error}</p>
                  )}
                  <p className="text-muted-foreground font-mono">
                    {l.agentName || `Agent ${l.agentId.slice(0, 6)}`} · {fmtRelative(l.createdAt)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export default function AppDashboard() {
  const { connected, address, signer, disconnect, chainId } = useWallet();

  // Per-route SEO: explicit indexing intent + descriptive title for /app.
  // The dashboard itself shows account-specific data once authed, but the
  // public landing card is a real entry point and should be crawlable.
  useEffect(() => {
    document.title = "Sign in to BUILD4 — AI Trading Dashboard";
    const setMeta = (name: string, content: string) => {
      let el = document.querySelector(`meta[name="${name}"]`);
      if (!el) {
        el = document.createElement("meta");
        el.setAttribute("name", name);
        document.head.appendChild(el);
      }
      el.setAttribute("content", content);
    };
    setMeta(
      "description",
      "Sign in to BUILD4 with Telegram or your wallet to access your AI trading dashboard, on-chain balances, AI agents, and recent activity.",
    );
    setMeta("robots", "index, follow, max-image-preview:large, max-snippet:-1");
    setMeta("googlebot", "index, follow, max-image-preview:large, max-snippet:-1");
    let canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.setAttribute("rel", "canonical");
      document.head.appendChild(canonical);
    }
    canonical.setAttribute("href", "https://build4.io/app");
  }, []);

  const [auth, setAuth] = useState<AuthState>({ kind: "loading" });
  const [tgConfig, setTgConfig] = useState<{ enabled: boolean; botUsername: string | null }>({
    enabled: false,
    botUsername: null,
  });

  const fetchMe = useCallback(async (): Promise<{
    session: Session;
    botUser: BotUser;
  } | null> => {
    const token = localStorage.getItem(SESSION_KEY);
    if (!token) return null;
    try {
      const r = await fetch("/api/web/me", { headers: { "x-session-token": token } });
      if (!r.ok) {
        if (r.status === 401 || r.status === 404) localStorage.removeItem(SESSION_KEY);
        return null;
      }
      const j = await r.json();
      if (!j?.botUser) return null;
      return {
        session: {
          kind: j.kind,
          wallet: j.wallet,
          telegramPhotoUrl: j.telegramPhotoUrl,
          expiresAt: "",
        },
        botUser: j.botUser as BotUser,
      };
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    fetch("/api/auth/telegram-config")
      .then((r) => r.json())
      .then((j) => setTgConfig({ enabled: !!j.enabled, botUsername: j.botUsername }))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const me = await fetchMe();
      if (cancelled) return;
      if (me) {
        setAuth({ kind: "authed", session: me.session, botUser: me.botUser });
        return;
      }
      setAuth(connected ? { kind: "needs-signature" } : { kind: "disconnected" });
    })();
    return () => {
      cancelled = true;
    };
  }, [connected, address, fetchMe]);

  const signIn = useCallback(async () => {
    if (!signer || !address) return;
    setAuth({ kind: "signing" });
    try {
      const nonce = crypto.getRandomValues(new Uint32Array(2)).join("");
      const message = buildSiweMessage(address, nonce, chainId || 56);
      const signature = await signer.signMessage(message);
      const r = await fetch("/api/auth/verify-signature", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, signature, walletAddress: address }),
      });
      const j = await r.json();
      if (r.status === 404 && j?.error === "no_account") {
        setAuth({ kind: "no-account", via: "wallet", message: j.message });
        return;
      }
      if (!r.ok || !j.authenticated) {
        setAuth({ kind: "error", message: j.message || j.error || "Sign-in failed" });
        return;
      }
      localStorage.setItem(SESSION_KEY, j.sessionToken);
      setAuth({
        kind: "authed",
        session: { kind: "wallet", wallet: j.wallet, expiresAt: j.expiresAt },
        botUser: j.botUser as BotUser,
      });
    } catch (e: any) {
      const raw = e?.message || "";
      let friendly = "Signature failed. Please try again.";
      if (raw.includes("user rejected") || raw.includes("User denied") || raw.includes("ACTION_REJECTED")) {
        friendly = "Sign-in cancelled. Tap Sign In to try again.";
      }
      setAuth({ kind: "error", message: friendly });
    }
  }, [signer, address, chainId]);

  const handleTelegramAuth = useCallback(async (data: any) => {
    setAuth({ kind: "loading" });
    try {
      const r = await fetch("/api/auth/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      });
      const j = await r.json();
      if (r.status === 404 && j?.error === "no_account") {
        setAuth({ kind: "no-account", via: "telegram", message: j.message });
        return;
      }
      if (!r.ok || !j.authenticated) {
        setAuth({ kind: "error", message: j.message || j.error || "Telegram sign-in failed" });
        return;
      }
      localStorage.setItem(SESSION_KEY, j.sessionToken);
      setAuth({
        kind: "authed",
        session: {
          kind: "telegram",
          telegramPhotoUrl: j.telegramPhotoUrl,
          expiresAt: j.expiresAt,
        },
        botUser: j.botUser as BotUser,
      });
    } catch (e: any) {
      setAuth({ kind: "error", message: e?.message || "Telegram sign-in failed" });
    }
  }, []);

  const signOut = useCallback(async () => {
    localStorage.removeItem(SESSION_KEY);
    try { await disconnect(); } catch {}
    setAuth({ kind: "disconnected" });
  }, [disconnect]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b sticky top-0 bg-background/95 backdrop-blur z-30">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between">
          <Link
            href="/"
            className="flex items-center gap-2"
            aria-label="BUILD4 home"
            title="BUILD4 home"
            data-testid="link-home"
          >
            <span className="font-mono text-sm font-bold">BUILD4</span>
            <Badge variant="outline" className="text-[10px]">dApp</Badge>
          </Link>
          <div className="flex items-center gap-2">
            {(auth.kind === "disconnected" ||
              auth.kind === "needs-signature" ||
              auth.kind === "signing" ||
              (auth.kind === "authed" && auth.session.kind === "wallet")) && (
              <WalletConnector />
            )}
            {(auth.kind === "authed" || auth.kind === "no-account") && (
              <Button
                variant="ghost"
                size="sm"
                onClick={signOut}
                className="font-mono text-xs gap-1"
                data-testid="button-sign-out"
              >
                <LogOut className="w-3.5 h-3.5" />
                Sign out
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 max-w-3xl">
        {auth.kind === "loading" && (
          <div className="flex items-center justify-center py-20" data-testid="state-loading">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {auth.kind === "disconnected" && (
          <Card className="p-8 space-y-6" data-testid="card-connect">
            <div className="text-center space-y-3">
              <Bot className="w-10 h-10 mx-auto text-primary" />
              <div>
                <h1 className="text-xl font-mono font-bold mb-1">Welcome to BUILD4</h1>
                <p className="text-sm text-muted-foreground">
                  Sign in with your Telegram account or your Build4 wallet to access your AI
                  trading dashboard.
                </p>
              </div>
            </div>

            {tgConfig.enabled && tgConfig.botUsername && (
              <>
                <div className="space-y-3">
                  <div className="flex items-center gap-2 justify-center text-xs text-muted-foreground font-mono">
                    <Send className="w-3.5 h-3.5" /> Sign in with Telegram
                  </div>
                  <div className="flex justify-center" data-testid="container-telegram-login">
                    <TelegramLoginButton
                      botUsername={tgConfig.botUsername}
                      onAuth={handleTelegramAuth}
                    />
                  </div>
                  <p
                    className="text-[10px] text-muted-foreground text-center font-mono leading-relaxed max-w-md mx-auto"
                    data-testid="text-telegram-help"
                  >
                    Button greyed out? Telegram only enables its login widget on
                    the bot's registered domain (build4.io). On other origins
                    (e.g. preview links) the button stays disabled — use
                    Connect Wallet below with the same wallet that's already
                    linked to your @{tgConfig.botUsername} account.
                  </p>
                </div>
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground font-mono">or</span>
                  </div>
                </div>
              </>
            )}

            <div className="space-y-3">
              <div className="flex items-center gap-2 justify-center text-xs text-muted-foreground font-mono">
                <Wallet className="w-3.5 h-3.5" /> Connect your Build4 wallet
              </div>
              <div className="flex justify-center">
                <WalletConnector />
              </div>
              <p className="text-xs text-muted-foreground text-center">
                Use the same wallet that's already linked to your Build4 account on Telegram.
              </p>
            </div>

            <div className="border-t pt-4 text-xs text-muted-foreground text-center font-mono">
              No Build4 account yet?{" "}
              <a
                href={
                  tgConfig.botUsername
                    ? `https://t.me/${tgConfig.botUsername}`
                    : "https://t.me/Build4bot"
                }
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Start a new Build4 account on the @${tgConfig.botUsername || "Build4bot"} Telegram bot`}
                title="Open the Build4 Telegram bot"
                className="underline inline-flex items-center gap-1"
                data-testid="link-start-on-telegram"
              >
                Start on Telegram <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </Card>
        )}

        {(auth.kind === "needs-signature" || auth.kind === "signing" || auth.kind === "error") &&
          connected && (
            <Card className="p-8 text-center space-y-4" data-testid="card-sign-in">
              <ShieldCheck className="w-10 h-10 mx-auto text-primary" />
              <div>
                <h1 className="text-xl font-mono font-bold mb-1">Verify ownership</h1>
                <p className="text-sm text-muted-foreground">
                  Sign a message to prove you own{" "}
                  <span className="font-mono">
                    {address?.slice(0, 6)}…{address?.slice(-4)}
                  </span>
                  . No gas, no transaction.
                </p>
              </div>
              <Button
                onClick={signIn}
                disabled={auth.kind === "signing"}
                className="font-mono"
                data-testid="button-sign-in"
              >
                {auth.kind === "signing" ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Waiting for signature…
                  </>
                ) : (
                  "Sign in"
                )}
              </Button>
              {auth.kind === "error" && (
                <p
                  className="text-xs text-destructive font-mono pt-1"
                  data-testid="text-auth-error"
                >
                  {auth.message}
                </p>
              )}
            </Card>
          )}

        {auth.kind === "no-account" && (
          <Card className="p-8 text-center space-y-4 border-destructive/40" data-testid="card-no-account">
            <AlertCircle className="w-10 h-10 mx-auto text-destructive" />
            <div>
              <h1 className="text-xl font-mono font-bold mb-1">No Build4 account found</h1>
              <p className="text-sm text-muted-foreground">{auth.message}</p>
            </div>
            <div className="flex gap-2 justify-center flex-wrap">
              <a
                href={
                  tgConfig.botUsername
                    ? `https://t.me/${tgConfig.botUsername}`
                    : "https://t.me/Build4bot"
                }
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open the Build4 Telegram bot (@${tgConfig.botUsername || "Build4bot"})`}
                title="Open the Build4 Telegram bot"
                data-testid="link-open-telegram-bot"
              >
                <Button className="font-mono gap-2">
                  <Send className="w-4 h-4" />
                  Open the Telegram bot
                </Button>
              </a>
              <Button
                variant="ghost"
                onClick={signOut}
                className="font-mono"
                data-testid="button-no-account-back"
              >
                Try a different account
              </Button>
            </div>
          </Card>
        )}

        {auth.kind === "authed" && auth.botUser && (
          <div className="space-y-4" data-testid="view-dashboard">
            <Card className="p-6 space-y-4" data-testid="card-account-header">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-3 min-w-0">
                  {auth.session.kind === "telegram" && auth.session.telegramPhotoUrl ? (
                    <img
                      src={auth.session.telegramPhotoUrl}
                      alt=""
                      className="w-10 h-10 rounded-full"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                      <Bot className="w-5 h-5 text-primary" />
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-bold truncate" data-testid="text-account-name">
                      {auth.botUser.username
                        ? `@${auth.botUser.username}`
                        : auth.botUser.firstName || `User ${auth.botUser.telegramId}`}
                    </p>
                    <p className="text-xs text-muted-foreground font-mono">
                      Signed in via {auth.session.kind === "telegram" ? "Telegram" : "wallet"}
                      {auth.session.kind === "wallet" && auth.session.wallet && (
                        <>
                          {" · "}
                          <span className="font-mono">
                            {auth.session.wallet.slice(0, 6)}…{auth.session.wallet.slice(-4)}
                          </span>
                        </>
                      )}
                    </p>
                  </div>
                </div>
                <Badge variant="default" className="font-mono text-[10px]">
                  <ShieldCheck className="w-3 h-3 mr-1" />
                  Verified
                </Badge>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t">
                <div className="space-y-1" data-testid="stat-b4-balance">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-mono">
                    B4 balance
                  </p>
                  <p className="font-mono text-lg font-bold">
                    ${auth.botUser.b4Balance.toFixed(2)}
                  </p>
                </div>
                <div className="space-y-1" data-testid="stat-agents">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-mono">
                    AI agents
                  </p>
                  <p className="font-mono text-lg font-bold">
                    {auth.botUser.activeAgentCount}
                    <span className="text-sm text-muted-foreground">
                      {" "}/ {auth.botUser.agentCount}
                    </span>
                  </p>
                </div>
                <div className="space-y-1" data-testid="stat-aster">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-mono">
                    Aster
                  </p>
                  <p className="font-mono text-sm font-bold">
                    {auth.botUser.asterOnboarded ? "Onboarded" : "Not set up"}
                  </p>
                </div>
                <div className="space-y-1" data-testid="stat-telegram-id">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-mono">
                    Telegram ID
                  </p>
                  <p className="font-mono text-sm font-bold truncate">
                    {auth.botUser.telegramId}
                  </p>
                </div>
              </div>

              {auth.botUser.bscWalletAddress && (
                <div
                  className="pt-3 border-t flex items-center justify-between gap-2 flex-wrap"
                  data-testid="row-bsc-wallet"
                >
                  <div className="min-w-0">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-mono">
                      Your Build4 BSC deposit wallet
                    </p>
                    <p className="font-mono text-xs break-all">
                      {auth.botUser.bscWalletAddress}
                    </p>
                  </div>
                  <a
                    href={`https://bscscan.com/address/${auth.botUser.bscWalletAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`View BSC deposit wallet ${auth.botUser.bscWalletAddress} on BscScan`}
                    title="View deposit wallet on BscScan"
                    className="text-xs underline inline-flex items-center gap-1 font-mono"
                    data-testid="link-bscscan"
                  >
                    View on BscScan <ExternalLink className="w-3 h-3" aria-hidden="true" />
                  </a>
                </div>
              )}
            </Card>

            <BalancesCard />
            <AgentsCard />
            <ActivityCard />

            <Card className="p-6 space-y-3" data-testid="card-coming-soon">
              <h2 className="font-mono text-sm font-bold">Coming next</h2>
              <p className="text-sm text-muted-foreground">
                Read-only mirror of your bot is live. Trading from the web is rolling out next.
              </p>
              <ul className="text-sm space-y-1.5 font-mono">
                <li className="flex items-center gap-2">
                  <span className="text-muted-foreground">Phase 3 →</span> Aster perps trading
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-muted-foreground">Phase 4+ →</span> Hyperliquid, predictions, agent management, copy trading
                </li>
              </ul>
              <p className="text-xs text-muted-foreground pt-2">
                Use any feature today on Telegram:{" "}
                <a
                  href={
                    tgConfig.botUsername
                      ? `https://t.me/${tgConfig.botUsername}`
                      : "https://t.me/Build4bot"
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open @${tgConfig.botUsername || "Build4bot"} on Telegram to use Build4 features`}
                  title="Open the Build4 Telegram bot"
                  className="underline inline-flex items-center gap-1"
                  data-testid="link-telegram-bot"
                >
                  @{tgConfig.botUsername || "Build4bot"} <ExternalLink className="w-3 h-3" />
                </a>
              </p>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}
