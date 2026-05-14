import { useEffect, useState, useCallback } from "react";
import { useWallet } from "@/hooks/use-wallet";
import { WalletConnector } from "@/components/wallet-connector";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, ShieldCheck, Wallet, ExternalLink, LogOut } from "lucide-react";
import { Link } from "wouter";

const SESSION_KEY = "build4_session_token";

type AuthState =
  | { kind: "loading" }
  | { kind: "disconnected" }
  | { kind: "needs-signature" }
  | { kind: "signing" }
  | { kind: "authed"; wallet: string; expiresAt: string }
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

export default function AppDashboard() {
  const { connected, address, signer, disconnect, chainName, balance, chainCurrency, chainId } = useWallet();
  const [auth, setAuth] = useState<AuthState>({ kind: "loading" });

  const fetchSession = useCallback(async () => {
    try {
      const token = localStorage.getItem(SESSION_KEY);
      if (!token) return null;
      const r = await fetch("/api/auth/session", {
        headers: { "x-session-token": token },
      });
      if (!r.ok) {
        localStorage.removeItem(SESSION_KEY);
        return null;
      }
      const j = await r.json();
      return j as { authenticated: boolean; wallet: string; expiresAt: string };
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await fetchSession();
      if (cancelled) return;
      if (s?.authenticated) {
        setAuth({ kind: "authed", wallet: s.wallet, expiresAt: s.expiresAt });
        return;
      }
      if (!connected) {
        setAuth({ kind: "disconnected" });
      } else {
        setAuth({ kind: "needs-signature" });
      }
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
      setAuth({ kind: "authed", wallet: j.wallet, expiresAt: j.expiresAt });
    } catch (e: any) {
      const raw = e?.message || "";
      let friendly = "Signature failed. Please try again.";
      if (raw.includes("user rejected") || raw.includes("User denied") || raw.includes("ACTION_REJECTED")) {
        friendly = "Sign-in cancelled. Tap Sign In to try again.";
      }
      setAuth({ kind: "error", message: friendly });
    }
  }, [signer, address]);

  const signOut = useCallback(async () => {
    localStorage.removeItem(SESSION_KEY);
    await disconnect();
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
            <WalletConnector />
            {auth.kind === "authed" && (
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
          <Card className="p-8 text-center space-y-4" data-testid="card-connect">
            <Wallet className="w-10 h-10 mx-auto text-primary" />
            <div>
              <h1 className="text-xl font-mono font-bold mb-1">Welcome to BUILD4</h1>
              <p className="text-sm text-muted-foreground">
                Connect your wallet to access your AI trading dashboard.
              </p>
            </div>
            <div className="flex justify-center pt-2">
              <WalletConnector />
            </div>
            <p className="text-xs text-muted-foreground pt-2">
              Already use BUILD4 on Telegram?{" "}
              <a
                href="https://t.me/Build4bot"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open BUILD4 bot on Telegram"
                className="underline"
              >
                Open the bot
              </a>{" "}
              — connect the same wallet here to see your account.
            </p>
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

        {auth.kind === "authed" && (
          <div className="space-y-4" data-testid="view-dashboard">
            <Card className="p-6 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground font-mono">Signed in as</p>
                  <p className="font-mono text-sm break-all" data-testid="text-session-wallet">
                    {auth.wallet}
                  </p>
                </div>
                <Badge variant="default" className="font-mono text-[10px]">
                  <ShieldCheck className="w-3 h-3 mr-1" /> Verified
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-3 pt-2 border-t">
                <div>
                  <p className="text-xs text-muted-foreground font-mono">Network</p>
                  <p className="font-mono text-sm" data-testid="text-network">
                    {chainName || "—"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground font-mono">Wallet balance</p>
                  <p className="font-mono text-sm" data-testid="text-balance">
                    {parseFloat(balance || "0").toFixed(4)} {chainCurrency}
                  </p>
                </div>
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
                  <span className="text-muted-foreground">Phase 1 →</span> Auto-provision trading
                  wallets (BSC, Hyperliquid, Aster, Polymarket Safe)
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-muted-foreground">Phase 2 →</span> Balances + deposit page
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
                  href="https://t.me/Build4bot"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open BUILD4 bot on Telegram"
                  className="underline inline-flex items-center gap-1"
                  data-testid="link-telegram-bot"
                >
                  @Build4bot <ExternalLink className="w-3 h-3" />
                </a>
              </p>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}
