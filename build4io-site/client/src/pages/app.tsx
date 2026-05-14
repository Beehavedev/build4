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
} from "lucide-react";
import { Link } from "wouter";

const SESSION_KEY = "build4_session_token";

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

export default function AppDashboard() {
  const { connected, address, signer, disconnect, chainId } = useWallet();
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
          <Link href="/" className="flex items-center gap-2" data-testid="link-home">
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
                    className="text-xs underline inline-flex items-center gap-1 font-mono"
                    data-testid="link-bscscan"
                  >
                    BscScan <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              )}
            </Card>

            <Card className="p-6 space-y-3" data-testid="card-coming-soon">
              <h2 className="font-mono text-sm font-bold">Coming next</h2>
              <p className="text-sm text-muted-foreground">
                This is your dashboard shell. We're rolling out features in phases — each one
                mirrors what the Telegram bot already does.
              </p>
              <ul className="text-sm space-y-1.5 font-mono">
                <li className="flex items-center gap-2">
                  <span className="text-muted-foreground">Phase 2 →</span> Wallets + deposits page
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-muted-foreground">Phase 3 →</span> Aster perps trading
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-muted-foreground">Phase 4+ →</span> Hyperliquid, predictions,
                  AI agents, copy trading
                </li>
              </ul>
              <p className="text-xs text-muted-foreground pt-2">
                Or use any feature today on Telegram:{" "}
                <a
                  href={
                    tgConfig.botUsername
                      ? `https://t.me/${tgConfig.botUsername}`
                      : "https://t.me/Build4bot"
                  }
                  target="_blank"
                  rel="noopener noreferrer"
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
