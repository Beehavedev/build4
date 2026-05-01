import { useEffect, useState } from "react";
import { useWallet } from "@/hooks/use-wallet";
import { WalletConnector } from "@/components/wallet-connector";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Loader2, LogOut, Wallet, ShieldCheck, Zap, Database, AlertCircle } from "lucide-react";

interface MeResponse {
  authenticated: boolean;
  address?: string;
}

function buildSiweMessage(address: string, nonce: string, chainId: number) {
  const domain = window.location.host;
  const uri = window.location.origin;
  const issuedAtMs = Date.now();
  const issuedAt = new Date(issuedAtMs).toISOString();
  const expirationTime = new Date(issuedAtMs + 5 * 60 * 1000).toISOString();
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    "",
    "Sign in to BUILD4 dApp — same trading engine as the Telegram bot, web edition.",
    "",
    `URI: ${uri}`,
    `Version: 1`,
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expirationTime}`,
  ].join("\n");
}

export default function AppPage() {
  const { connected, address, chainId, signer, disconnect, walletType } = useWallet();
  const [session, setSession] = useState<MeResponse | null>(null);
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);

  async function refreshSession() {
    try {
      const r = await fetch("/api/web4/me", { credentials: "include" });
      if (r.ok) setSession(await r.json());
      else setSession({ authenticated: false });
    } catch {
      setSession({ authenticated: false });
    } finally {
      setLoadingSession(false);
    }
  }

  useEffect(() => {
    void refreshSession();
  }, []);

  async function handleSiwe() {
    if (!signer || !address) return;
    setError(null);
    setSigning(true);
    try {
      const nonceRes = await fetch(`/api/web4/nonce?address=${address}`);
      if (!nonceRes.ok) throw new Error(`Could not get nonce: ${nonceRes.status}`);
      const { nonce } = await nonceRes.json();

      const message = buildSiweMessage(address, nonce, chainId || 1);
      const signature = await signer.signMessage(message);

      const verify = await fetch("/api/web4/siwe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ message, signature, address }),
      });
      if (!verify.ok) {
        const body = await verify.json().catch(() => ({}));
        throw new Error(body.error || `SIWE verify failed: ${verify.status}`);
      }
      await refreshSession();
    } catch (err: any) {
      setError(err?.message || "Sign-in failed");
    } finally {
      setSigning(false);
    }
  }

  async function handleLogout() {
    try {
      await fetch("/api/web4/logout", { method: "POST", credentials: "include" });
    } catch {}
    setSession({ authenticated: false });
    disconnect();
  }

  const isAuthed = session?.authenticated && session.address;
  const sameWallet = isAuthed && address && session.address!.toLowerCase() === address.toLowerCase();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border/40 backdrop-blur-sm sticky top-0 z-10 bg-background/80">
        <div className="container mx-auto px-4 h-14 flex items-center justify-between">
          <a href="/" className="flex items-center gap-2 font-mono font-bold text-sm" data-testid="link-home">
            <span className="text-primary">BUILD4</span>
            <span className="opacity-50">/</span>
            <span className="opacity-80">dApp</span>
          </a>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px] font-mono">BETA</Badge>
            <WalletConnector />
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-12 max-w-3xl">
        <div className="text-center mb-10">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-3" data-testid="text-page-title">
            BUILD4 Web dApp
          </h1>
          <p className="text-muted-foreground max-w-xl mx-auto">
            Same AI trading engine as the Telegram bot — connect Trust Wallet (or any WalletConnect-compatible wallet)
            instead of using a custodial wallet. Your keys stay yours.
          </p>
        </div>

        {/* Step 1 — Connect */}
        <Card className="mb-4" data-testid="card-step-connect">
          <CardHeader className="flex-row items-start gap-3 space-y-0">
            <div className="mt-1">
              {connected ? (
                <CheckCircle2 className="w-5 h-5 text-green-500" data-testid="icon-step1-done" />
              ) : (
                <Wallet className="w-5 h-5 text-muted-foreground" />
              )}
            </div>
            <div className="flex-1">
              <CardTitle className="text-base">1. Connect your wallet</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                Trust Wallet, MetaMask, Rainbow, OKX — any WalletConnect-compatible wallet works.
              </p>
            </div>
          </CardHeader>
          {connected && (
            <CardContent>
              <div className="text-xs font-mono bg-muted/50 rounded px-3 py-2 break-all" data-testid="text-connected-address">
                {address}
                {walletType && <Badge className="ml-2 text-[10px]" variant="secondary">{walletType}</Badge>}
              </div>
            </CardContent>
          )}
        </Card>

        {/* Step 2 — Sign-in */}
        <Card className={`mb-4 ${!connected ? "opacity-50" : ""}`} data-testid="card-step-siwe">
          <CardHeader className="flex-row items-start gap-3 space-y-0">
            <div className="mt-1">
              {sameWallet ? (
                <CheckCircle2 className="w-5 h-5 text-green-500" data-testid="icon-step2-done" />
              ) : (
                <ShieldCheck className="w-5 h-5 text-muted-foreground" />
              )}
            </div>
            <div className="flex-1">
              <CardTitle className="text-base">2. Sign in with Ethereum</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                One-time signature proves you own the wallet. Free, no transaction, never broadcast on-chain.
              </p>
            </div>
          </CardHeader>
          {connected && !sameWallet && (
            <CardContent>
              <Button
                onClick={handleSiwe}
                disabled={signing || !signer}
                size="sm"
                data-testid="button-siwe"
              >
                {signing ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                    Waiting for wallet…
                  </>
                ) : (
                  "Sign in with Ethereum"
                )}
              </Button>
              {error && (
                <div className="mt-3 text-xs text-red-500 flex items-start gap-1.5" data-testid="text-siwe-error">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
            </CardContent>
          )}
          {sameWallet && (
            <CardContent>
              <div className="text-xs font-mono bg-muted/50 rounded px-3 py-2" data-testid="text-session-info">
                Signed in as <span className="text-primary">{session.address}</span>
              </div>
            </CardContent>
          )}
        </Card>

        {/* Step 3 — Trading session keys (placeholder for next milestone) */}
        <Card className={`mb-4 ${!sameWallet ? "opacity-50" : ""}`} data-testid="card-step-keys">
          <CardHeader className="flex-row items-start gap-3 space-y-0">
            <div className="mt-1">
              <Zap className="w-5 h-5 text-muted-foreground" />
            </div>
            <div className="flex-1">
              <CardTitle className="text-base">3. Trading session keys</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                Generate a Hyperliquid agent wallet, an Aster API key, and deploy your Polymarket Safe — all signed in one flow.
                Your main wallet keeps custody; session keys can trade but cannot withdraw.
              </p>
            </div>
          </CardHeader>
          {sameWallet && (
            <CardContent>
              <Button size="sm" disabled data-testid="button-onboard-keys">
                Coming next — see status below
              </Button>
              <div className="mt-3 text-xs text-muted-foreground space-y-1">
                <div>• Hyperliquid agent wallet (uses HL's official agent-wallet flow)</div>
                <div>• Aster API key (signed via EIP-712, scoped to trading)</div>
                <div>• Polymarket Gnosis Safe (gasless deploy via Builder Relayer)</div>
              </div>
            </CardContent>
          )}
        </Card>

        {/* Step 4 — Trading dashboard (placeholder) */}
        <Card className={`mb-8 ${!sameWallet ? "opacity-50" : ""}`} data-testid="card-step-dashboard">
          <CardHeader className="flex-row items-start gap-3 space-y-0">
            <div className="mt-1">
              <Database className="w-5 h-5 text-muted-foreground" />
            </div>
            <div className="flex-1">
              <CardTitle className="text-base">4. Open trading dashboard</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                Same UI as the Telegram mini-app — positions, trades, agents, Polymarket. Reads from the same Postgres.
              </p>
            </div>
          </CardHeader>
        </Card>

        {sameWallet && (
          <div className="text-center">
            <Button variant="ghost" size="sm" onClick={handleLogout} data-testid="button-logout">
              <LogOut className="w-3.5 h-3.5 mr-2" />
              Sign out
            </Button>
          </div>
        )}

        {loadingSession && (
          <div className="fixed bottom-4 right-4 text-xs text-muted-foreground flex items-center gap-2">
            <Loader2 className="w-3 h-3 animate-spin" />
            Loading session…
          </div>
        )}
      </main>
    </div>
  );
}
