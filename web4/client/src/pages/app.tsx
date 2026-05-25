import { useEffect, useState, useCallback } from "react";
import { useWallet } from "@/hooks/use-wallet";
import { WalletConnector } from "@/components/wallet-connector";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Loader2, LogOut, Wallet, ShieldCheck, Database, AlertCircle, ExternalLink, RefreshCw, LinkIcon } from "lucide-react";

// ── Account state — single fetch that paints every venue card ─────────
interface AccountState {
  linked: boolean;
  address: string;
  hint?: string;
  userId?: string;
  bscWalletAddress?: string;
  agentsActive?: number;
  venues?: {
    aster:       { onboarded: boolean; agentAddress: string | null; tradingEnabled: boolean };
    hyperliquid: { onboarded: boolean; agentAddress: string | null; tradingEnabled: boolean; unified: boolean };
    fortytwo:    { liveTrade: boolean; openCount: number; closedCount: number };
    polymarket:  { tradingEnabled: boolean; safeAddress: string | null; safeDeployedAt: string | null; eoaAddress: string | null; openCount: number };
  };
}

interface PolymarketState {
  safeAddress: string | null;
  safeDeployedAt: string | null;
  eoaAddress: string | null;
  balances: { usdc?: number; allowanceCtf?: number; allowanceNeg?: number; ctfApprovedCtfExchange?: boolean; error?: string } | null;
  positions: Array<{
    id: string; conditionId: string; tokenId: string; marketTitle: string; outcomeLabel: string;
    side: "BUY" | "SELL"; sizeUsdc: number; entryPrice: number; status: string; fillSize: number | null;
  }>;
}

function short(addr: string | null | undefined, len = 4) {
  if (!addr) return "—";
  return `${addr.slice(0, 2 + len)}…${addr.slice(-len)}`;
}

function CopyChip({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <button
      type="button"
      onClick={() => { void navigator.clipboard.writeText(value); }}
      className="font-mono text-[10px] underline-offset-2 hover:underline"
      data-testid={`copy-${value.slice(0, 8)}`}
      title={value}
    >
      {short(value, 6)}
    </button>
  );
}

// ── Polymarket card — full interactive: setup, balance, positions, redeem
function PolymarketCard({ initial, onRefresh }: { initial: AccountState["venues"]["polymarket"]; onRefresh: () => void }) {
  const [state, setState] = useState<PolymarketState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [tradeTokenId, setTradeTokenId] = useState("");
  const [tradeConditionId, setTradeConditionId] = useState("");
  const [tradeTitle, setTradeTitle] = useState("");
  const [tradeOutcome, setTradeOutcome] = useState("YES");
  const [tradeSide, setTradeSide] = useState<"BUY" | "SELL">("BUY");
  const [tradeAmount, setTradeAmount] = useState("5");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/web-api/polymarket/state", { credentials: "include" });
      if (!r.ok) throw new Error(`status ${r.status}`);
      setState(await r.json());
      setErr(null);
    } catch (e: any) { setErr(e?.message || "load failed"); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function runSetup() {
    setBusy("setup"); setMsg(null); setErr(null);
    try {
      const r = await fetch("/web-api/polymarket/setup", { method: "POST", credentials: "include" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || j.error || `setup failed (${r.status})`);
      setMsg(j.safe?.alreadyDeployed ? "Safe already deployed. Approvals refreshed." : `Safe deployed: ${short(j.safe?.safeAddress, 6)}`);
      await load(); onRefresh();
    } catch (e: any) { setErr(e?.message || "setup failed"); }
    finally { setBusy(null); }
  }

  async function runTrade() {
    setBusy("trade"); setMsg(null); setErr(null);
    try {
      if (!tradeTokenId.trim() || !tradeConditionId.trim() || !tradeTitle.trim()) {
        throw new Error("tokenId, conditionId, and title are required");
      }
      const r = await fetch("/web-api/polymarket/order", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tokenId: tradeTokenId.trim(),
          side: tradeSide,
          amount: Number(tradeAmount),
          marketCtx: {
            conditionId: tradeConditionId.trim(),
            marketTitle: tradeTitle.trim(),
            outcomeLabel: tradeOutcome.trim() || "YES",
          },
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.detail || j.error || j.message || `order failed (${r.status})`);
      setMsg(`${tradeSide} ${tradeOutcome} @ ${(Number(j.fillPrice ?? 0) * 100).toFixed(1)}¢ — ${j.orderId ? `id ${short(j.orderId, 6)}` : "submitted"}.`);
      await load(); onRefresh();
    } catch (e: any) { setErr(e?.message || "trade failed"); }
    finally { setBusy(null); }
  }

  async function runRedeem(conditionId: string) {
    setBusy(`redeem:${conditionId}`); setMsg(null); setErr(null);
    try {
      const r = await fetch("/web-api/polymarket/redeem", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conditionId }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || j.error || `redeem failed (${r.status})`);
      setMsg(`Redeemed: ${j.txHash ? short(j.txHash, 6) : "ok"}`);
      await load(); onRefresh();
    } catch (e: any) { setErr(e?.message || "redeem failed"); }
    finally { setBusy(null); }
  }

  const safe = state?.safeAddress ?? initial.safeAddress;
  const usdc = state?.balances?.usdc ?? null;
  const balError = state?.balances?.error ?? null;

  return (
    <Card data-testid="card-venue-polymarket">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            Polymarket
            <Badge variant="outline" className="text-[9px] font-mono">PREDICTION · POLYGON · GASLESS</Badge>
          </CardTitle>
          <button onClick={load} className="text-muted-foreground hover:text-foreground" data-testid="button-refresh-polymarket">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="border border-border/60 rounded p-2 bg-muted/20">
            <div className="text-[10px] uppercase text-muted-foreground">Safe (funder)</div>
            <div className="mt-1"><CopyChip value={safe} /></div>
          </div>
          <div className="border border-border/60 rounded p-2 bg-muted/20">
            <div className="text-[10px] uppercase text-muted-foreground">USDC at Safe</div>
            <div className="mt-1 font-mono text-sm" data-testid="text-poly-usdc">
              {balError ? <span className="text-amber-500">{balError}</span> :
               usdc != null ? `${usdc.toFixed(2)}` :
               safe ? <Loader2 className="w-3 h-3 animate-spin inline" /> : "—"}
            </div>
          </div>
        </div>

        {!safe && (
          <div className="text-xs text-muted-foreground border border-amber-500/30 bg-amber-500/5 rounded p-3">
            <div className="font-medium text-amber-500 mb-1">Setup required</div>
            <p>One gasless transaction deploys your Gnosis Safe on Polygon and grants USDC + CTF allowances. <span className="font-medium">No MATIC needed</span> — Polymarket's Builder Relayer pays the gas.</p>
            <Button size="sm" className="mt-3" onClick={runSetup} disabled={busy === "setup"} data-testid="button-poly-setup">
              {busy === "setup" ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Deploying Safe…</> : "Deploy gasless Safe"}
            </Button>
          </div>
        )}

        {safe && (
          <>
            <div className="text-[10px] text-muted-foreground">
              Approvals: USDC→CtfExch {state?.balances?.allowanceCtf != null ? "✓" : "—"} · NegRisk {state?.balances?.allowanceNeg != null ? "✓" : "—"} · CTF {state?.balances?.ctfApprovedCtfExchange ? "✓" : "—"}
              <Button size="sm" variant="ghost" className="h-5 px-1.5 ml-2 text-[10px]" onClick={runSetup} disabled={busy === "setup"} data-testid="button-poly-reapprove">
                {busy === "setup" ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : "re-run setup"}
              </Button>
            </div>

            <div>
              <div className="text-[10px] uppercase text-muted-foreground mb-1.5">Positions ({state?.positions?.length ?? 0})</div>
              {!state ? (
                <div className="text-xs text-muted-foreground"><Loader2 className="w-3 h-3 animate-spin inline mr-1" />loading…</div>
              ) : state.positions.length === 0 ? (
                <div className="text-xs text-muted-foreground py-3 text-center border border-dashed border-border/60 rounded">
                  No positions yet. The Polymarket agent runs autonomously every 60s — open a position from Telegram or wait for the agent to find an edge.
                </div>
              ) : (
                <div className="space-y-1.5 max-h-64 overflow-y-auto">
                  {state.positions.slice(0, 12).map((p) => {
                    const resolved = p.status === "resolved_win" || p.status === "won";
                    return (
                      <div key={p.id} className="text-xs border border-border/60 rounded p-2 flex items-center gap-2" data-testid={`row-poly-position-${p.id}`}>
                        <div className="flex-1 min-w-0">
                          <div className="truncate font-medium">{p.marketTitle}</div>
                          <div className="text-[10px] text-muted-foreground font-mono">
                            {p.side} {p.outcomeLabel} · ${p.sizeUsdc.toFixed(2)} @ {(p.entryPrice * 100).toFixed(1)}¢
                          </div>
                        </div>
                        <Badge variant={p.status === "failed" ? "destructive" : "secondary"} className="text-[9px]">{p.status}</Badge>
                        {resolved && (
                          <Button size="sm" variant="outline" className="h-6 text-[10px] px-2"
                            onClick={() => runRedeem(p.conditionId)}
                            disabled={busy === `redeem:${p.conditionId}`}
                            data-testid={`button-redeem-${p.id}`}>
                            {busy === `redeem:${p.conditionId}` ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : "redeem"}
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}

        {safe && (
          <div className="border border-border/60 rounded p-2 bg-muted/10 space-y-2">
            <div className="text-[10px] uppercase text-muted-foreground">Trade outcome</div>
            <input
              value={tradeTitle} onChange={(e) => setTradeTitle(e.target.value)}
              placeholder="market title (e.g. Will BTC close > 100k by 2026-06-30?)"
              className="w-full bg-background border border-border/60 rounded px-2 py-1 text-[11px]"
              data-testid="input-poly-title"
            />
            <input
              value={tradeConditionId} onChange={(e) => setTradeConditionId(e.target.value)}
              placeholder="conditionId 0x…"
              className="w-full bg-background border border-border/60 rounded px-2 py-1 font-mono text-[11px]"
              data-testid="input-poly-condition"
            />
            <input
              value={tradeTokenId} onChange={(e) => setTradeTokenId(e.target.value)}
              placeholder="tokenId (YES or NO erc1155 id)"
              className="w-full bg-background border border-border/60 rounded px-2 py-1 font-mono text-[11px]"
              data-testid="input-poly-token"
            />
            <div className="grid grid-cols-3 gap-1.5">
              <input
                value={tradeOutcome} onChange={(e) => setTradeOutcome(e.target.value.toUpperCase())}
                placeholder="YES" className="bg-background border border-border/60 rounded px-2 py-1 font-mono text-xs"
                data-testid="input-poly-outcome"
              />
              <div className="flex gap-1 col-span-1">
                <Button size="sm" variant={tradeSide === "BUY" ? "default" : "outline"} className="flex-1 h-7 text-[11px]"
                  onClick={() => setTradeSide("BUY")} data-testid="button-poly-buy-side">BUY</Button>
                <Button size="sm" variant={tradeSide === "SELL" ? "default" : "outline"} className="flex-1 h-7 text-[11px]"
                  onClick={() => setTradeSide("SELL")} data-testid="button-poly-sell-side">SELL</Button>
              </div>
              <input
                value={tradeAmount} onChange={(e) => setTradeAmount(e.target.value)} type="number" min="1"
                placeholder="USDC" className="bg-background border border-border/60 rounded px-2 py-1 font-mono text-xs"
                data-testid="input-poly-amount"
              />
            </div>
            <Button size="sm" className="w-full h-7 text-[11px]"
              onClick={runTrade}
              disabled={busy === "trade" || !tradeTokenId || !tradeConditionId || !tradeTitle}
              data-testid="button-poly-submit">
              {busy === "trade" ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />placing…</> : `${tradeSide} ${tradeOutcome} for $${tradeAmount}`}
            </Button>
            <div className="text-[10px] text-muted-foreground">
              Copy conditionId + tokenId from polymarket.com (network tab → markets API) or the bot's Predictions page. Slippage capped server-side at 5%.
            </div>
          </div>
        )}

        {msg && <div className="text-xs text-green-500" data-testid="text-poly-msg">{msg}</div>}
        {err && <div className="text-xs text-red-500" data-testid="text-poly-err">{err}</div>}
      </CardContent>
    </Card>
  );
}

// ── Aster card — fetches balance + positions, runs server-side approve
// for bot-linked users (mirrors the bot's /api/aster/approve flow).
interface AsterAccount {
  onboarded: boolean;
  walletAddress?: string;
  balance: { usdt: number; availableMargin: number } | null;
  positions: Array<{
    symbol: string; side: "LONG" | "SHORT"; size: number;
    entryPrice: number; markPrice: number; unrealizedPnl: number;
    leverage: number; liquidationPrice: number;
  }>;
}

function AsterCard({ initial, onRefresh }: { initial: AccountState["venues"]["aster"]; onRefresh: () => void }) {
  const [acc, setAcc] = useState<AsterAccount | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pair, setPair] = useState("BTCUSDT");
  const [side, setSide] = useState<"LONG" | "SHORT">("LONG");
  const [notional, setNotional] = useState("25");
  const [leverage, setLeverage] = useState("3");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/web-api/aster/account", { credentials: "include" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || j.error || `status ${r.status}`);
      setAcc(j); setErr(null);
    } catch (e: any) { setErr(e?.message || "load failed"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function runApprove() {
    setBusy("approve"); setMsg(null); setErr(null);
    try {
      const r = await fetch("/web-api/aster/approve", { method: "POST", credentials: "include" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.hint || j.detail || j.error || `approve failed (${r.status})`);
      setMsg(j.alreadyOnboarded ? "Already onboarded." : `Approved. Agent ${short(j.agentAddress, 6)}.`);
      await load(); onRefresh();
    } catch (e: any) { setErr(e?.message || "approve failed"); }
    finally { setBusy(null); }
  }

  async function runOrder() {
    setBusy("order"); setMsg(null); setErr(null);
    try {
      const r = await fetch("/web-api/aster/order", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pair, side, notionalUsdt: Number(notional), leverage: Number(leverage) }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || j.error || `order failed (${r.status})`);
      setMsg(`${side} ${pair} @ market — order ${j.order?.orderId ?? "submitted"} (status ${j.order?.status ?? "—"}).`);
      await load(); onRefresh();
    } catch (e: any) { setErr(e?.message || "order failed"); }
    finally { setBusy(null); }
  }

  const onboarded = acc?.onboarded ?? initial.onboarded;
  return (
    <Card data-testid="card-venue-aster">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            Aster DEX
            {onboarded
              ? <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
              : <AlertCircle className="w-3.5 h-3.5 text-amber-500" />}
            <Badge variant="outline" className="text-[9px] font-mono">PERP · BSC</Badge>
          </CardTitle>
          <button onClick={load} className="text-muted-foreground hover:text-foreground" data-testid="button-refresh-aster">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {!onboarded && (
          <div className="border border-amber-500/30 bg-amber-500/5 rounded p-3 space-y-2">
            <div className="text-amber-500 font-medium">Approve trading agent</div>
            <p className="text-muted-foreground">A fresh per-user agent wallet signs your trades via EIP-712. Built-in builder fee enrollment so BUILD4 earns kickback on every fill.</p>
            <Button size="sm" onClick={runApprove} disabled={busy === "approve"} data-testid="button-aster-approve">
              {busy === "approve" ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Approving…</> : "Approve Aster agent"}
            </Button>
          </div>
        )}
        {onboarded && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <div className="border border-border/60 rounded p-2 bg-muted/20">
                <div className="text-[10px] uppercase text-muted-foreground">Margin balance</div>
                <div className="font-mono text-sm mt-1" data-testid="text-aster-usdt">
                  {acc?.balance ? `$${acc.balance.usdt.toFixed(2)}` : <Loader2 className="w-3 h-3 animate-spin inline" />}
                </div>
              </div>
              <div className="border border-border/60 rounded p-2 bg-muted/20">
                <div className="text-[10px] uppercase text-muted-foreground">Available</div>
                <div className="font-mono text-sm mt-1">
                  {acc?.balance ? `$${acc.balance.availableMargin.toFixed(2)}` : <Loader2 className="w-3 h-3 animate-spin inline" />}
                </div>
              </div>
            </div>
            <div className="text-[10px] text-muted-foreground">
              Agent <CopyChip value={initial.agentAddress} /> · trading {initial.tradingEnabled ? "ON" : "PAUSED"}
            </div>
            <div>
              <div className="text-[10px] uppercase text-muted-foreground mb-1.5">Open positions ({acc?.positions?.length ?? 0})</div>
              {!acc ? (
                <div className="text-muted-foreground"><Loader2 className="w-3 h-3 animate-spin inline mr-1" />loading…</div>
              ) : acc.positions.length === 0 ? (
                <div className="text-muted-foreground py-3 text-center border border-dashed border-border/60 rounded">No open positions.</div>
              ) : (
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {acc.positions.slice(0, 10).map((p) => (
                    <div key={`${p.symbol}-${p.side}`} className="border border-border/60 rounded p-2 flex items-center gap-2" data-testid={`row-aster-${p.symbol}`}>
                      <div className="flex-1 min-w-0">
                        <div className="font-mono font-medium">{p.symbol}</div>
                        <div className="text-[10px] text-muted-foreground font-mono">
                          {p.side} {Math.abs(p.size).toFixed(4)} @ ${p.entryPrice.toFixed(4)} · mark ${p.markPrice.toFixed(4)} · {p.leverage}x
                        </div>
                      </div>
                      <div className={`font-mono text-xs ${p.unrealizedPnl >= 0 ? "text-green-500" : "text-red-500"}`}>
                        {p.unrealizedPnl >= 0 ? "+" : ""}${p.unrealizedPnl.toFixed(2)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="border border-border/60 rounded p-2 bg-muted/10 space-y-2">
              <div className="text-[10px] uppercase text-muted-foreground">Place market order</div>
              <div className="grid grid-cols-2 gap-1.5">
                <input
                  value={pair} onChange={(e) => setPair(e.target.value.toUpperCase())}
                  placeholder="BTCUSDT" className="bg-background border border-border/60 rounded px-2 py-1 font-mono text-xs"
                  data-testid="input-aster-pair"
                />
                <div className="flex gap-1">
                  <Button size="sm" variant={side === "LONG" ? "default" : "outline"} className="flex-1 h-7 text-[11px]"
                    onClick={() => setSide("LONG")} data-testid="button-aster-long">LONG</Button>
                  <Button size="sm" variant={side === "SHORT" ? "default" : "outline"} className="flex-1 h-7 text-[11px]"
                    onClick={() => setSide("SHORT")} data-testid="button-aster-short">SHORT</Button>
                </div>
                <input
                  value={notional} onChange={(e) => setNotional(e.target.value)} type="number" min="1"
                  placeholder="USDT" className="bg-background border border-border/60 rounded px-2 py-1 font-mono text-xs"
                  data-testid="input-aster-notional"
                />
                <input
                  value={leverage} onChange={(e) => setLeverage(e.target.value)} type="number" min="1" max="50"
                  placeholder="leverage x" className="bg-background border border-border/60 rounded px-2 py-1 font-mono text-xs"
                  data-testid="input-aster-leverage"
                />
              </div>
              <Button size="sm" className="w-full h-7 text-[11px]" onClick={runOrder} disabled={busy === "order"} data-testid="button-aster-submit">
                {busy === "order" ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />placing…</> : `${side} ${pair} for $${notional} @ ${leverage}x`}
              </Button>
            </div>
          </>
        )}
        {msg && <div className="text-green-500" data-testid="text-aster-msg">{msg}</div>}
        {err && <div className="text-red-500" data-testid="text-aster-err">{err}</div>}
      </CardContent>
    </Card>
  );
}

// ── Hyperliquid card ──
interface HlAccount {
  onboarded: boolean;
  walletAddress: string;
  accountValue: number;
  withdrawableUsdc: number;
  spotUsdc: number;
  unified: boolean;
  positions: Array<{
    coin: string; szi: number; entryPx: number; unrealizedPnl: number;
    positionValue: number; leverage: number; liquidationPx: number;
  }>;
}

function HyperliquidCard({ initial, onRefresh }: { initial: AccountState["venues"]["hyperliquid"]; onRefresh: () => void }) {
  const [acc, setAcc] = useState<HlAccount | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [coin, setCoin] = useState("BTC");
  const [side, setSide] = useState<"LONG" | "SHORT">("LONG");
  const [notional, setNotional] = useState("25");
  const [leverage, setLeverage] = useState("3");

  async function runOrder() {
    setBusy("order"); setMsg(null); setErr(null);
    try {
      const r = await fetch("/web-api/hyperliquid/order", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coin, side, notionalUsdc: Number(notional), leverage: Number(leverage) }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || j.error || `order failed (${r.status})`);
      setMsg(`${side} ${coin} @ market — oid ${j.order?.oid ?? "—"}.`);
      await load(); onRefresh();
    } catch (e: any) { setErr(e?.message || "order failed"); }
    finally { setBusy(null); }
  }

  const load = useCallback(async () => {
    try {
      const r = await fetch("/web-api/hyperliquid/account", { credentials: "include" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || j.error || `status ${r.status}`);
      setAcc(j); setErr(null);
    } catch (e: any) { setErr(e?.message || "load failed"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function runApprove() {
    setBusy("approve"); setMsg(null); setErr(null);
    try {
      const r = await fetch("/web-api/hyperliquid/approve", { method: "POST", credentials: "include" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.hint || j.detail || j.error || `approve failed (${r.status})`);
      setMsg(j.alreadyOnboarded ? "Already onboarded." : `Approved. Agent ${short(j.agentAddress, 6)}.`);
      await load(); onRefresh();
    } catch (e: any) { setErr(e?.message || "approve failed"); }
    finally { setBusy(null); }
  }

  const onboarded = acc?.onboarded ?? initial.onboarded;
  return (
    <Card data-testid="card-venue-hyperliquid">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            Hyperliquid L1
            {onboarded
              ? <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
              : <AlertCircle className="w-3.5 h-3.5 text-amber-500" />}
            <Badge variant="outline" className="text-[9px] font-mono">PERP · HL</Badge>
          </CardTitle>
          <button onClick={load} className="text-muted-foreground hover:text-foreground" data-testid="button-refresh-hyperliquid">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {!onboarded && (
          <div className="border border-amber-500/30 bg-amber-500/5 rounded p-3 space-y-2">
            <div className="text-amber-500 font-medium">Approve HL agent wallet</div>
            <p className="text-muted-foreground">
              HL requires $1+ USDC on your master account first. If your account is empty, use @build4_bot — it auto-bridges from Arbitrum (the dApp doesn't run that flow).
            </p>
            <Button size="sm" onClick={runApprove} disabled={busy === "approve"} data-testid="button-hl-approve">
              {busy === "approve" ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Approving…</> : "Approve HL agent"}
            </Button>
          </div>
        )}
        {onboarded && acc && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <div className="border border-border/60 rounded p-2 bg-muted/20">
                <div className="text-[10px] uppercase text-muted-foreground">Account</div>
                <div className="font-mono text-sm mt-1" data-testid="text-hl-acct">${acc.accountValue.toFixed(2)}</div>
              </div>
              <div className="border border-border/60 rounded p-2 bg-muted/20">
                <div className="text-[10px] uppercase text-muted-foreground">Withdrawable</div>
                <div className="font-mono text-sm mt-1">${acc.withdrawableUsdc.toFixed(2)}</div>
              </div>
              <div className="border border-border/60 rounded p-2 bg-muted/20">
                <div className="text-[10px] uppercase text-muted-foreground">Spot USDC</div>
                <div className="font-mono text-sm mt-1">${acc.spotUsdc.toFixed(2)}</div>
              </div>
            </div>
            <div className="text-[10px] text-muted-foreground">
              Agent <CopyChip value={initial.agentAddress} /> · {acc.unified ? "unified account" : "spot+perps"} · trading {initial.tradingEnabled ? "ON" : "PAUSED"}
            </div>
            <div>
              <div className="text-[10px] uppercase text-muted-foreground mb-1.5">Open positions ({acc.positions.filter(p => p.szi !== 0).length})</div>
              {acc.positions.filter(p => p.szi !== 0).length === 0 ? (
                <div className="text-muted-foreground py-3 text-center border border-dashed border-border/60 rounded">No open positions.</div>
              ) : (
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {acc.positions.filter(p => p.szi !== 0).slice(0, 10).map((p) => (
                    <div key={p.coin} className="border border-border/60 rounded p-2 flex items-center gap-2" data-testid={`row-hl-${p.coin}`}>
                      <div className="flex-1 min-w-0">
                        <div className="font-mono font-medium">{p.coin}</div>
                        <div className="text-[10px] text-muted-foreground font-mono">
                          {p.szi > 0 ? "LONG" : "SHORT"} {Math.abs(p.szi).toFixed(4)} @ ${p.entryPx.toFixed(4)} · {p.leverage}x · liq ${p.liquidationPx.toFixed(2)}
                        </div>
                      </div>
                      <div className={`font-mono text-xs ${p.unrealizedPnl >= 0 ? "text-green-500" : "text-red-500"}`}>
                        {p.unrealizedPnl >= 0 ? "+" : ""}${p.unrealizedPnl.toFixed(2)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="border border-border/60 rounded p-2 bg-muted/10 space-y-2">
              <div className="text-[10px] uppercase text-muted-foreground">Place market order</div>
              <div className="grid grid-cols-2 gap-1.5">
                <input
                  value={coin} onChange={(e) => setCoin(e.target.value.toUpperCase())}
                  placeholder="BTC" className="bg-background border border-border/60 rounded px-2 py-1 font-mono text-xs"
                  data-testid="input-hl-coin"
                />
                <div className="flex gap-1">
                  <Button size="sm" variant={side === "LONG" ? "default" : "outline"} className="flex-1 h-7 text-[11px]"
                    onClick={() => setSide("LONG")} data-testid="button-hl-long">LONG</Button>
                  <Button size="sm" variant={side === "SHORT" ? "default" : "outline"} className="flex-1 h-7 text-[11px]"
                    onClick={() => setSide("SHORT")} data-testid="button-hl-short">SHORT</Button>
                </div>
                <input
                  value={notional} onChange={(e) => setNotional(e.target.value)} type="number" min="1"
                  placeholder="USDC" className="bg-background border border-border/60 rounded px-2 py-1 font-mono text-xs"
                  data-testid="input-hl-notional"
                />
                <input
                  value={leverage} onChange={(e) => setLeverage(e.target.value)} type="number" min="1" max="50"
                  placeholder="leverage x" className="bg-background border border-border/60 rounded px-2 py-1 font-mono text-xs"
                  data-testid="input-hl-leverage"
                />
              </div>
              <Button size="sm" className="w-full h-7 text-[11px]" onClick={runOrder} disabled={busy === "order"} data-testid="button-hl-submit">
                {busy === "order" ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />placing…</> : `${side} ${coin} for $${notional} @ ${leverage}x`}
              </Button>
            </div>
          </>
        )}
        {msg && <div className="text-green-500" data-testid="text-hl-msg">{msg}</div>}
        {err && <div className="text-red-500" data-testid="text-hl-err">{err}</div>}
      </CardContent>
    </Card>
  );
}

// ── 42.space card ──
interface FortyTwoState {
  walletAddress: string | null;
  liveTrade: boolean;
  open: Array<{
    id: string; marketTitle: string | null; outcomeLabel: string | null;
    usdtIn: number | null; status: string; openedAt: string;
  }>;
  recent: Array<{
    id: string; marketTitle: string | null; outcomeLabel: string | null;
    usdtIn: number | null; status: string; openedAt: string; payoutUsdt: number | null;
  }>;
}

function FortyTwoCard({ initial, onRefresh }: { initial: AccountState["venues"]["fortytwo"]; onRefresh: () => void }) {
  const [s, setS] = useState<FortyTwoState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [marketAddress, setMarketAddress] = useState("");
  const [tokenId, setTokenId] = useState("0");
  const [usdtAmount, setUsdtAmount] = useState("5");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/web-api/fortytwo/state", { credentials: "include" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || j.error || `status ${r.status}`);
      setS(j); setErr(null);
    } catch (e: any) { setErr(e?.message || "load failed"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function runBuy() {
    setBusy("buy"); setMsg(null); setErr(null);
    try {
      const r = await fetch("/web-api/fortytwo/buy", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketAddress: marketAddress.trim(), tokenId: Number(tokenId), usdtAmount: Number(usdtAmount) }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.detail || j.error || `buy failed (${r.status})`);
      setMsg(`Opened — tx ${short(j.txHash, 6)}.`);
      await load(); onRefresh();
    } catch (e: any) { setErr(e?.message || "buy failed"); }
    finally { setBusy(null); }
  }

  async function runSell(positionId: string) {
    setBusy(`sell:${positionId}`); setMsg(null); setErr(null);
    try {
      const r = await fetch("/web-api/fortytwo/sell", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positionId }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.detail || j.error || `sell failed (${r.status})`);
      setMsg(`Closed — tx ${short(j.txHash, 6)}.`);
      await load(); onRefresh();
    } catch (e: any) { setErr(e?.message || "sell failed"); }
    finally { setBusy(null); }
  }

  async function runClaimAll() {
    setBusy("claim"); setMsg(null); setErr(null);
    try {
      const r = await fetch("/web-api/fortytwo/claim-all", { method: "POST", credentials: "include" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || j.error || `claim failed (${r.status})`);
      const markets = j.marketsClaimed ?? 0;
      const positions = j.claimedPositions ?? 0;
      const payout = Number(j.payoutUsdt ?? 0);
      const errs = Array.isArray(j.errors) ? j.errors.length : 0;
      setMsg(
        markets === 0
          ? errs > 0 ? `No claims (${errs} error${errs === 1 ? "" : "s"}).` : "Nothing to claim."
          : `Claimed ${positions} position(s) across ${markets} market(s) — $${payout.toFixed(2)} payout${errs ? ` (${errs} skipped)` : ""}.`
      );
      await load(); onRefresh();
    } catch (e: any) { setErr(e?.message || "claim failed"); }
    finally { setBusy(null); }
  }

  return (
    <Card data-testid="card-venue-fortytwo">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            42.space
            <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
            <Badge variant="outline" className="text-[9px] font-mono">PREDICTION · BSC</Badge>
          </CardTitle>
          <button onClick={load} className="text-muted-foreground hover:text-foreground" data-testid="button-refresh-fortytwo">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <div className="grid grid-cols-3 gap-2">
          <div className="border border-border/60 rounded p-2 bg-muted/20">
            <div className="text-[10px] uppercase text-muted-foreground">Open</div>
            <div className="font-mono text-sm mt-1" data-testid="text-42-open">{s?.open?.length ?? initial.openCount}</div>
          </div>
          <div className="border border-border/60 rounded p-2 bg-muted/20">
            <div className="text-[10px] uppercase text-muted-foreground">Closed</div>
            <div className="font-mono text-sm mt-1">{s?.recent?.length ?? initial.closedCount}</div>
          </div>
          <div className="border border-border/60 rounded p-2 bg-muted/20">
            <div className="text-[10px] uppercase text-muted-foreground">Live</div>
            <div className="font-mono text-sm mt-1">{(s?.liveTrade ?? initial.liveTrade) ? "ON" : "OFF"}</div>
          </div>
        </div>
        {s && s.open.length > 0 && (
          <div>
            <div className="text-[10px] uppercase text-muted-foreground mb-1.5">Open positions</div>
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {s.open.slice(0, 10).map((p) => (
                <div key={p.id} className="border border-border/60 rounded p-2 flex items-center gap-2" data-testid={`row-42-${p.id}`}>
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-medium">{p.marketTitle ?? "—"}</div>
                    <div className="text-[10px] text-muted-foreground font-mono">
                      {p.outcomeLabel ?? "—"} · ${(p.usdtIn ?? 0).toFixed(2)}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" className="h-6 text-[10px] px-2"
                    onClick={() => runSell(p.id)} disabled={busy === `sell:${p.id}`}
                    data-testid={`button-42-sell-${p.id}`}>
                    {busy === `sell:${p.id}` ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : "sell"}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="border border-border/60 rounded p-2 bg-muted/10 space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-[10px] uppercase text-muted-foreground">Buy outcome</div>
            <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[10px]"
              onClick={runClaimAll} disabled={busy === "claim"}
              data-testid="button-42-claim-all">
              {busy === "claim" ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : "claim all wins"}
            </Button>
          </div>
          <input
            value={marketAddress} onChange={(e) => setMarketAddress(e.target.value)}
            placeholder="market address 0x…"
            className="w-full bg-background border border-border/60 rounded px-2 py-1 font-mono text-[11px]"
            data-testid="input-42-market"
          />
          <div className="grid grid-cols-2 gap-1.5">
            <input
              value={tokenId} onChange={(e) => setTokenId(e.target.value)} type="number" min="0"
              placeholder="outcome id" className="bg-background border border-border/60 rounded px-2 py-1 font-mono text-xs"
              data-testid="input-42-token"
            />
            <input
              value={usdtAmount} onChange={(e) => setUsdtAmount(e.target.value)} type="number" min="1"
              placeholder="USDT" className="bg-background border border-border/60 rounded px-2 py-1 font-mono text-xs"
              data-testid="input-42-amount"
            />
          </div>
          <Button size="sm" className="w-full h-7 text-[11px]"
            onClick={runBuy} disabled={busy === "buy" || !marketAddress}
            data-testid="button-42-buy">
            {busy === "buy" ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />buying…</> : `Buy outcome #${tokenId} for $${usdtAmount}`}
          </Button>
          <div className="text-[10px] text-muted-foreground">
            Find a market address + outcome id via the bot's Predictions page.
          </div>
        </div>
        {msg && <div className="text-green-500" data-testid="text-42-msg">{msg}</div>}
        {s && s.recent.length > 0 && (
          <div>
            <div className="text-[10px] uppercase text-muted-foreground mb-1.5">Recent resolved</div>
            <div className="space-y-1.5 max-h-32 overflow-y-auto">
              {s.recent.slice(0, 5).map((p) => {
                const pnl = (p.payoutUsdt ?? 0) - (p.usdtIn ?? 0);
                const won = p.status === "resolved_win" || (p.payoutUsdt ?? 0) > 0;
                return (
                  <div key={p.id} className="border border-border/60 rounded p-2 flex items-center gap-2" data-testid={`row-42-recent-${p.id}`}>
                    <div className="flex-1 min-w-0">
                      <div className="truncate">{p.marketTitle ?? "—"}</div>
                      <div className="text-[10px] text-muted-foreground font-mono">{p.outcomeLabel ?? "—"} · ${(p.usdtIn ?? 0).toFixed(2)} in</div>
                    </div>
                    <Badge variant={won ? "default" : "secondary"} className="text-[9px]">
                      {won ? "+" : ""}${pnl.toFixed(2)}
                    </Badge>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div className="text-[10px] text-muted-foreground">
          Trading runs autonomously every 5 min. Configure conviction thresholds via @build4_bot.
        </div>
        {err && <div className="text-red-500" data-testid="text-42-err">{err}</div>}
      </CardContent>
    </Card>
  );
}

// ── Phase placeholder card (Pancake, Topaz, four.meme) ──
function PhaseCard({ id, name, kind, chain, message, telegramCmd }: {
  id: string; name: string; kind: string; chain: string;
  message: string; telegramCmd?: string;
}) {
  return (
    <Card data-testid={`card-venue-${id}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            {name}
            <AlertCircle className="w-3.5 h-3.5 text-muted-foreground" />
          </CardTitle>
          <Badge variant="outline" className="text-[9px] font-mono">{kind.toUpperCase()} · {chain.toUpperCase()}</Badge>
        </div>
      </CardHeader>
      <CardContent className="text-xs space-y-2">
        <p className="text-muted-foreground">{message}</p>
        {telegramCmd && (
          <a href={`https://t.me/build4_bot?start=${telegramCmd}`} target="_blank" rel="noreferrer">
            <Button size="sm" variant="outline" className="h-7 text-[11px]" data-testid={`button-tg-${id}`}>
              Open in Telegram <ExternalLink className="w-3 h-3 ml-1.5" />
            </Button>
          </a>
        )}
      </CardContent>
    </Card>
  );
}

function VenueDashboard({ account, onRefresh }: { account: AccountState; onRefresh: () => void }) {
  if (!account.linked || !account.venues) return null;
  const v = account.venues;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3" data-testid="grid-venues">
      <PolymarketCard initial={v.polymarket} onRefresh={onRefresh} />
      <AsterCard initial={v.aster} onRefresh={onRefresh} />
      <HyperliquidCard initial={v.hyperliquid} onRefresh={onRefresh} />
      <FortyTwoCard initial={v.fortytwo} onRefresh={onRefresh} />
      <PhaseCard
        id="pancakeswap" name="PancakeSwap" kind="spot" chain="BSC"
        message="Per-user swap routing ships in Phase 3."
      />
      <PhaseCard
        id="topaz" name="Topaz" kind="spot+lp" chain="BSC"
        message="Master-wallet-only in Phase 1. Multi-user rollout in Phase 2."
      />
      <PhaseCard
        id="fourmeme" name="four.meme" kind="launchpad" chain="BSC"
        message="Token launches are driven from the bot's /launch command."
        telegramCmd="launch"
      />
    </div>
  );
}

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
  const [account, setAccount] = useState<AccountState | null>(null);
  const [accountErr, setAccountErr] = useState<string | null>(null);

  const refreshAccount = useCallback(async () => {
    try {
      const r = await fetch("/web-api/account/state", { credentials: "include" });
      if (r.status === 401) { setAccount(null); return; }
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || j.error || `status ${r.status}`);
      setAccount(j);
      setAccountErr(null);
    } catch (e: any) { setAccountErr(e?.message || "load failed"); }
  }, []);

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

  // Re-fetch account state whenever the session becomes authenticated for
  // the currently-connected wallet. Account state lives in the bot DB
  // (User row matched by Wallet.address) so we can't paint venue cards
  // until SIWE has set the cookie.
  useEffect(() => {
    if (session?.authenticated) void refreshAccount();
    else setAccount(null);
  }, [session?.authenticated, session?.address, refreshAccount]);

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

        {/* Step 3 — Link to bot account */}
        <Card className={`mb-4 ${!sameWallet ? "opacity-50" : ""}`} data-testid="card-step-link">
          <CardHeader className="flex-row items-start gap-3 space-y-0">
            <div className="mt-1">
              {account?.linked ? (
                <CheckCircle2 className="w-5 h-5 text-green-500" data-testid="icon-step3-done" />
              ) : (
                <LinkIcon className="w-5 h-5 text-muted-foreground" />
              )}
            </div>
            <div className="flex-1">
              <CardTitle className="text-base">3. Linked BUILD4 account</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                Your connected wallet is matched against your BUILD4 bot wallet so the dApp shows
                the same agents, balances, and positions you already have in Telegram.
              </p>
            </div>
          </CardHeader>
          {sameWallet && (
            <CardContent>
              {!account && !accountErr && (
                <div className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" />Looking up account…</div>
              )}
              {accountErr && (
                <div className="text-xs text-red-500" data-testid="text-account-err">{accountErr}</div>
              )}
              {account && !account.linked && (
                <div className="text-xs space-y-2">
                  <div className="text-amber-500 font-medium flex items-center gap-1.5">
                    <AlertCircle className="w-3.5 h-3.5" /> No bot account linked
                  </div>
                  <p className="text-muted-foreground">{account.hint}</p>
                  <a href="https://t.me/build4_bot" target="_blank" rel="noreferrer">
                    <Button size="sm" variant="outline" data-testid="button-open-bot">
                      Open @build4_bot <ExternalLink className="w-3 h-3 ml-1.5" />
                    </Button>
                  </a>
                </div>
              )}
              {account?.linked && (
                <div className="text-xs space-y-1.5" data-testid="text-account-linked">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">Bot wallet:</span>
                    <CopyChip value={account.bscWalletAddress} />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">Active agents:</span>
                    <span className="font-mono">{account.agentsActive ?? 0}</span>
                  </div>
                </div>
              )}
            </CardContent>
          )}
        </Card>

        {/* Step 4 — Venue dashboard */}
        <Card className={`mb-8 ${!sameWallet || !account?.linked ? "opacity-50" : ""}`} data-testid="card-step-dashboard">
          <CardHeader className="flex-row items-start gap-3 space-y-0">
            <div className="mt-1">
              <Database className="w-5 h-5 text-muted-foreground" />
            </div>
            <div className="flex-1">
              <CardTitle className="text-base">4. Trading venues</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                Trade directly from the dApp: approve Aster + Hyperliquid agents and place market orders, buy/sell
                42.space outcomes, deploy your Polymarket gasless Safe and buy YES/NO + one-tap redeem.
                The bot still owns long-running auto-trading and the Arbitrum→HL bridge flow.
              </p>
            </div>
          </CardHeader>
          {sameWallet && account?.linked && (
            <CardContent>
              <VenueDashboard account={account} onRefresh={refreshAccount} />
            </CardContent>
          )}
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
