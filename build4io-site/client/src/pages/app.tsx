import { useEffect, useState, useCallback, useRef } from "react";
import { useWallet } from "@/hooks/use-wallet";
import { WalletConnector } from "@/components/wallet-connector";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, ShieldCheck, Wallet, ExternalLink, LogOut, Send } from "lucide-react";
import { Link } from "wouter";

const SESSION_KEY = "build4_session_token";

type Session =
  | { kind: "wallet"; wallet: string; expiresAt: string }
  | {
      kind: "telegram";
      telegramId: string;
      telegramUsername: string | null;
      telegramFirstName: string | null;
      telegramPhotoUrl: string | null;
      expiresAt: string;
    };

type AuthState =
  | { kind: "loading" }
  | { kind: "disconnected" }
  | { kind: "needs-signature" }
  | { kind: "signing" }
  | { kind: "authed"; session: Session }
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

  const fetchSession = useCallback(async (): Promise<Session | null> => {
    try {
      const token = localStorage.getItem(SESSION_KEY);
      if (!token) return null;
      const r = await fetch("/api/auth/session", { headers: { "x-session-token": token } });
      if (!r.ok) {
        localStorage.removeItem(SESSION_KEY);
        return null;
      }
      const j = await r.json();
      if (!j?.authenticated) return null;
      if (j.kind === "telegram") {
        return {
          kind: "telegram",
          telegramId: j.telegramId,
          telegramUsername: j.telegramUsername,
          telegramFirstName: j.telegramFirstName,
          telegramPhotoUrl: j.telegramPhotoUrl,
          expiresAt: j.expiresAt,
        };
      }
      return { kind: "wallet", wallet: j.wallet, expiresAt: j.expiresAt };
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
      const s = await fetchSession();
      if (cancelled) return;
      if (s) {
        setAuth({ kind: "authed", session: s });
        return;
      }
      setAuth(connected ? { kind: "needs-signature" } : { kind: "disconnected" });
    })();
    return () => {
      cancelled = true;
    };
  }, [connected, address, fetchSession]);

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
      if (!r.ok || !j.authenticated) {
        setAuth({ kind: "error", message: j.error || "Sign-in failed" });
        return;
      }
      localStorage.setItem(SESSION_KEY, j.sessionToken);
      setAuth({
        kind: "authed",
        session: { kind: "wallet", wallet: j.wallet, expiresAt: j.expiresAt },
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
      if (!r.ok || !j.authenticated) {
        setAuth({ kind: "error", message: j.error || "Telegram sign-in failed" });
        return;
      }
      localStorage.setItem(SESSION_KEY, j.sessionToken);
      setAuth({
        kind: "authed",
        session: {
          kind: "telegram",
          telegramId: j.telegramId,
          telegramUsername: j.telegramUsername,
          telegramFirstName: j.telegramFirstName,
          telegramPhotoUrl: j.telegramPhotoUrl,
          expiresAt: j.expiresAt,
        },
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

  const isAuthed = auth.kind === "authed";
  const session = isAuthed ? auth.session : null;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b sticky top-0 bg-background/95 backdrop-blur z-30">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2" data-testid="link-home">
            <span className="font-mono text-sm font-bold">BUILD4</span>
            <Badge variant="outline" className="text-[10px]">dApp</Badge>
          </Link>
          <div className="flex items-center gap-2">
            {(!session || session.kind === "wallet") && <WalletConnector />}
            {isAuthed && (
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
              <Wallet className="w-10 h-10 mx-auto text-primary" />
              <div>
                <h1 className="text-xl font-mono font-bold mb-1">Welcome to BUILD4</h1>
                <p className="text-sm text-muted-foreground">
                  Sign in to access your AI trading dashboard.
                </p>
              </div>
            </div>

            {tgConfig.enabled && tgConfig.botUsername && (
              <>
                <div className="space-y-3">
                  <div className="flex items-center gap-2 justify-center text-xs text-muted-foreground font-mono">
                    <Send className="w-3.5 h-3.5" /> Already use BUILD4 on Telegram?
                  </div>
                  <div className="flex justify-center" data-testid="container-telegram-login">
                    <TelegramLoginButton
                      botUsername={tgConfig.botUsername}
                      onAuth={handleTelegramAuth}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground text-center">
                    Signs you in with the same Telegram account you use in the bot.
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
                <Wallet className="w-3.5 h-3.5" /> Connect with a crypto wallet
              </div>
              <div className="flex justify-center">
                <WalletConnector />
              </div>
              <p className="text-xs text-muted-foreground text-center">
                MetaMask, WalletConnect (mobile), or OKX. New here? You'll get a fresh BUILD4 account.
              </p>
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

        {isAuthed && session && (
          <div className="space-y-4" data-testid="view-dashboard">
            <Card className="p-6 space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground font-mono">Signed in as</p>
                  {session.kind === "wallet" ? (
                    <p
                      className="font-mono text-sm break-all"
                      data-testid="text-session-wallet"
                    >
                      {session.wallet}
                    </p>
                  ) : (
                    <div className="flex items-center gap-2">
                      {session.telegramPhotoUrl && (
                        <img
                          src={session.telegramPhotoUrl}
                          alt=""
                          className="w-8 h-8 rounded-full"
                        />
                      )}
                      <div>
                        <p
                          className="font-mono text-sm"
                          data-testid="text-session-telegram-name"
                        >
                          {session.telegramFirstName ||
                            session.telegramUsername ||
                            `User ${session.telegramId}`}
                        </p>
                        {session.telegramUsername && (
                          <p
                            className="font-mono text-xs text-muted-foreground"
                            data-testid="text-session-telegram-username"
                          >
                            @{session.telegramUsername}
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                <Badge variant="default" className="font-mono text-[10px]">
                  <ShieldCheck className="w-3 h-3 mr-1" />
                  {session.kind === "wallet" ? "Wallet verified" : "Telegram verified"}
                </Badge>
              </div>
            </Card>

            <Card className="p-6 space-y-3" data-testid="card-coming-soon">
              <h2 className="font-mono text-sm font-bold">Coming next</h2>
              <p className="text-sm text-muted-foreground">
                This is your dashboard shell. We're rolling out features in phases — each one
                mirrors what the Telegram bot already does.
              </p>
              <ul className="text-sm space-y-1.5 font-mono">
                <li className="flex items-center gap-2">
                  <span className="text-muted-foreground">Phase 1 →</span> Link to your Telegram
                  account + show real balances and agents
                </li>
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
                Full feature list available today on Telegram:{" "}
                <a
                  href={
                    tgConfig.botUsername
                      ? `https://t.me/${tgConfig.botUsername}`
                      : "https://t.me/Build4bot"
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open BUILD4 bot on Telegram"
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
