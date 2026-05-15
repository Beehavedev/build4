import { useState, useEffect, useMemo, useCallback } from "react";
import { Link } from "wouter";
import pancakeLogoUrl from "@assets/pancakeswap-logo-transparent.png";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { SEO } from "@/components/seo";
import { WalletConnector } from "@/components/wallet-connector";
import { useTerminalSession } from "@/hooks/use-terminal-session";
import {
  Trophy, Flame, Zap, Bot, Hand, Sparkles, Lock, ChevronRight, ExternalLink,
  TrendingUp, TrendingDown, Crown, Medal, Target, Brain, ShieldCheck,
  Twitter, MessageCircle, ArrowRight, Activity, Coins, Users, Clock,
  Loader2, AlertCircle, CheckCircle2, ArrowDownUp,
} from "lucide-react";

const PCS_CYAN = "#1FC7D4";
const PCS_PURPLE = "#7645D9";
const PCS_PINK = "#ED4B9E";
const PCS_YELLOW = "#FFB237";
const PCS_DARK_PURPLE = "#280D5F";
const PCS_GRADIENT = "linear-gradient(135deg, #1FC7D4 0%, #7645D9 55%, #ED4B9E 100%)";
const PCS_GRADIENT_SOFT = "linear-gradient(135deg, rgba(31,199,212,0.18) 0%, rgba(118,69,217,0.18) 55%, rgba(237,75,158,0.18) 100%)";
const B4_GREEN = "#42CF71";

function PancakeLogo({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <img
      src={pancakeLogoUrl}
      width={size}
      height={size}
      alt="PancakeSwap"
      className={`object-contain ${className}`}
      style={{ width: size, height: size }}
      draggable={false}
      data-testid="img-pancake-logo"
    />
  );
}

const COMPETITION_START_ISO = "2026-05-18T00:00:00Z";
const COMPETITION_END_ISO = "2026-05-25T00:00:00Z";
const TREASURY_ADDRESS = "0x0000000000000000000000000000000000000000";
const HOUSE_AGENT_NAME = "BUILD4_HOUSE";

type LeaderRow = {
  rank: number;
  name: string;
  owner: string;
  persona: "Quant" | "Degen" | "Hunter" | "Sniper" | "Maximalist" | "House";
  mode: "Auto" | "Co-pilot" | "Manual";
  pnlUsd: number;
  pnlPct: number;
  trades: number;
  streak: number;
  isHouse?: boolean;
  isYou?: boolean;
};

const MOCK_LEADERBOARD: LeaderRow[] = [
  { rank: 1, name: "RoboBuffett", owner: "@TheNOCGeneral", persona: "Quant", mode: "Auto", pnlUsd: 4318.42, pnlPct: 87.4, trades: 23, streak: 5 },
  { rank: 2, name: "Degen.Lord.420", owner: "@cryptocowboy", persona: "Degen", mode: "Manual", pnlUsd: 3204.10, pnlPct: 72.1, trades: 41, streak: 2 },
  { rank: 3, name: "Whale_Hunter", owner: "@hiddenalpha", persona: "Hunter", mode: "Co-pilot", pnlUsd: 2841.55, pnlPct: 64.8, trades: 18, streak: 4 },
  { rank: 4, name: "Snipe-3000", owner: "@dexrunner", persona: "Sniper", mode: "Auto", pnlUsd: 2104.99, pnlPct: 51.2, trades: 67, streak: 3 },
  { rank: 5, name: "CAKE_Maxi", owner: "@bakerypilled", persona: "Maximalist", mode: "Co-pilot", pnlUsd: 1788.30, pnlPct: 44.7, trades: 12, streak: 1 },
  { rank: 6, name: "QuantSamurai", owner: "@ronin", persona: "Quant", mode: "Auto", pnlUsd: 1402.10, pnlPct: 38.9, trades: 29, streak: 2 },
  { rank: 7, name: "BUILD4_HOUSE", owner: "BUILD4", persona: "House", mode: "Auto", pnlUsd: 1241.85, pnlPct: 34.2, trades: 31, streak: 3, isHouse: true },
  { rank: 8, name: "MoonBoy", owner: "@retailfrenz", persona: "Degen", mode: "Manual", pnlUsd: 922.40, pnlPct: 29.1, trades: 55, streak: 0 },
  { rank: 9, name: "VolBeast", owner: "@volumetrik", persona: "Hunter", mode: "Auto", pnlUsd: 814.22, pnlPct: 24.6, trades: 14, streak: 1 },
  { rank: 10, name: "PancakeFlipper", owner: "@brunch", persona: "Sniper", mode: "Co-pilot", pnlUsd: 661.04, pnlPct: 19.8, trades: 22, streak: 2 },
  { rank: 11, name: "GrandmaSafe", owner: "@nan", persona: "Quant", mode: "Auto", pnlUsd: 410.30, pnlPct: 14.1, trades: 9, streak: 1 },
  { rank: 12, name: "DipSlapper", owner: "@cliffhanger", persona: "Hunter", mode: "Manual", pnlUsd: 308.99, pnlPct: 11.4, trades: 17, streak: 0 },
];

function useCountdown(targetIso: string) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const target = useMemo(() => new Date(targetIso).getTime(), [targetIso]);
  const diff = Math.max(0, target - now);
  const d = Math.floor(diff / (1000 * 60 * 60 * 24));
  const h = Math.floor((diff / (1000 * 60 * 60)) % 24);
  const m = Math.floor((diff / (1000 * 60)) % 60);
  const s = Math.floor((diff / 1000) % 60);
  return { d, h, m, s, ended: diff === 0, raw: diff };
}

function fmtUsd(n: number) {
  const sign = n >= 0 ? "+" : "-";
  return sign + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n: number) {
  const sign = n >= 0 ? "+" : "";
  return sign + n.toFixed(2) + "%";
}

function shortAddr(addr: string) {
  if (!addr || addr.length < 10) return addr;
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function PersonaBadge({ persona }: { persona: LeaderRow["persona"] }) {
  const colors: Record<LeaderRow["persona"], string> = {
    Quant: "rgba(31, 199, 212, 0.15)",
    Degen: "rgba(237, 75, 158, 0.15)",
    Hunter: "rgba(118, 69, 217, 0.15)",
    Sniper: "rgba(66, 207, 113, 0.15)",
    Maximelist: "rgba(255, 184, 0, 0.15)" as any,
    Maximalist: "rgba(255, 184, 0, 0.15)",
    House: "rgba(255, 255, 255, 0.08)",
  };
  const textColors: Record<LeaderRow["persona"], string> = {
    Quant: PCS_CYAN,
    Degen: PCS_PINK,
    Hunter: PCS_PURPLE,
    Sniper: B4_GREEN,
    Maximalist: "#FFB800",
    House: "#FFFFFF",
  };
  return (
    <span
      className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded"
      style={{ background: colors[persona], color: textColors[persona] }}
      data-testid={`badge-persona-${persona}`}
    >
      {persona}
    </span>
  );
}

function ModeBadge({ mode }: { mode: LeaderRow["mode"] }) {
  const cfg: Record<LeaderRow["mode"], { icon: any; color: string }> = {
    Auto: { icon: Bot, color: B4_GREEN },
    "Co-pilot": { icon: Sparkles, color: PCS_CYAN },
    Manual: { icon: Hand, color: PCS_PINK },
  };
  const { icon: Icon, color } = cfg[mode];
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-mono" style={{ color }} data-testid={`badge-mode-${mode}`}>
      <Icon className="w-3 h-3" />
      {mode}
    </span>
  );
}

function PrizeChip({ rank, amount, label }: { rank: string; amount: number; label?: string }) {
  return (
    <div className="flex items-center justify-between p-3 rounded-lg border border-zinc-800 bg-zinc-950/40 hover-elevate active-elevate-2" data-testid={`chip-prize-${rank}`}>
      <div className="flex items-center gap-2">
        <Crown className="w-4 h-4" style={{ color: rank === "1st" ? "#FFD700" : rank === "2nd" ? "#C0C0C0" : rank === "3rd" ? "#CD7F32" : "#666" }} />
        <span className="font-mono text-xs uppercase tracking-wider text-zinc-300">{rank}</span>
        {label && <span className="text-[10px] font-mono text-zinc-500">{label}</span>}
      </div>
      <span className="font-mono text-sm font-semibold" style={{ color: B4_GREEN }}>${amount.toLocaleString()}</span>
    </div>
  );
}

function CountdownCell({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col items-center justify-center min-w-[64px] sm:min-w-[80px] py-3 px-2 rounded-lg border border-zinc-800 bg-zinc-950/60" data-testid={`countdown-${label.toLowerCase()}`}>
      <span className="font-mono text-2xl sm:text-3xl font-bold tabular-nums" style={{ color: PCS_CYAN }}>{value.toString().padStart(2, "0")}</span>
      <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500 mt-1">{label}</span>
    </div>
  );
}

type TokenInfo = { name: string; symbol: string; decimals: number; lastPriceWei: string };
type WalletBal = { bnbBalance: string; tokenBalance: string; tokenDecimals: number; error: string | null };

function PancakeTradePanel() {
  const session = useTerminalSession();
  const [tokenAddress, setTokenAddress] = useState("");
  const [info, setInfo] = useState<TokenInfo | null>(null);
  const [bal, setBal] = useState<WalletBal | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(false);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [bnbIn, setBnbIn] = useState("");
  const [tokensIn, setTokensIn] = useState("");
  const [slippageBps, setSlippageBps] = useState(500);
  const [busy, setBusy] = useState<"" | "buy" | "sell">("");
  const [tradeError, setTradeError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<{ kind: "buy" | "sell"; hash: string; approvalHash?: string } | null>(null);

  const validAddr = useMemo(() => /^0x[a-fA-F0-9]{40}$/.test(tokenAddress.trim()), [tokenAddress]);

  const loadInfo = useCallback(async () => {
    if (!validAddr) return;
    setLoadingInfo(true);
    setInfoError(null);
    setInfo(null);
    try {
      const r = await fetch(`/api/pancake/token/${tokenAddress.trim()}`);
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setInfo(j.info);
    } catch (e: any) {
      setInfoError(e?.message || "Failed to load token");
    } finally {
      setLoadingInfo(false);
    }
  }, [tokenAddress, validAddr]);

  const loadBalances = useCallback(async () => {
    if (!validAddr || !session.ready) return;
    try {
      const j = await session.apiFetch<any>(`/api/pancake/wallet-balance/${tokenAddress.trim()}`);
      if (j.ok) setBal({ bnbBalance: j.bnbBalance, tokenBalance: j.tokenBalance, tokenDecimals: j.tokenDecimals, error: j.error });
    } catch (e: any) {
      setBal({ bnbBalance: "0", tokenBalance: "0", tokenDecimals: 18, error: e?.message || "Balance load failed" });
    }
  }, [tokenAddress, validAddr, session.ready, session.apiFetch]);

  useEffect(() => { if (info && session.ready) loadBalances(); }, [info, session.ready, loadBalances]);

  const priceBnb = useMemo(() => {
    if (!info) return 0;
    try { return Number(BigInt(info.lastPriceWei)) / 1e18; } catch { return 0; }
  }, [info]);

  const onBuy = useCallback(async () => {
    if (!info || !bnbIn || !session.ready) return;
    setBusy("buy");
    setTradeError(null);
    setLastTx(null);
    try {
      const r = await session.apiFetch<any>("/api/pancake/buy", {
        method: "POST",
        body: JSON.stringify({ tokenAddress: tokenAddress.trim(), bnbAmount: bnbIn, slippageBps }),
      });
      if (!r.ok) throw new Error(r.error || "Buy failed");
      setLastTx({ kind: "buy", hash: r.txHash });
      setBnbIn("");
      await loadBalances();
    } catch (e: any) {
      setTradeError(e?.message || "Buy failed");
    } finally {
      setBusy("");
    }
  }, [info, bnbIn, slippageBps, tokenAddress, session.ready, session.apiFetch, loadBalances]);

  const onSell = useCallback(async () => {
    if (!info || !tokensIn || !session.ready) return;
    setBusy("sell");
    setTradeError(null);
    setLastTx(null);
    try {
      const r = await session.apiFetch<any>("/api/pancake/sell", {
        method: "POST",
        body: JSON.stringify({ tokenAddress: tokenAddress.trim(), tokenAmount: tokensIn, tokenDecimals: info.decimals, slippageBps }),
      });
      if (!r.ok) throw new Error(r.error || "Sell failed");
      setLastTx({ kind: "sell", hash: r.txHash, approvalHash: r.approvalTxHash });
      setTokensIn("");
      await loadBalances();
    } catch (e: any) {
      setTradeError(e?.message || "Sell failed");
    } finally {
      setBusy("");
    }
  }, [info, tokensIn, slippageBps, tokenAddress, session.ready, session.apiFetch, loadBalances]);

  return (
    <Card className="p-5 sm:p-6 bg-zinc-950/60 border-zinc-800" data-testid="card-pancake-trade-panel">
      <div className="flex items-center justify-between mb-4">
        <div className="text-xs font-mono uppercase tracking-wider text-zinc-500">Step 1 · Connect</div>
        {session.ready ? (
          <Badge variant="outline" className="font-mono text-[10px] border-emerald-500/40 text-emerald-300 gap-1">
            <CheckCircle2 className="w-3 h-3" /> Connected
          </Badge>
        ) : (
          <Badge variant="outline" className="font-mono text-[10px] border-zinc-700 text-zinc-400">Not connected</Badge>
        )}
      </div>

      {!session.wallet.connected ? (
        <div className="mb-6">
          <WalletConnector />
          <p className="text-[11px] text-zinc-500 font-mono mt-2">First-time connect creates a BUILD4 custodial BSC wallet. Fund it with BNB to trade.</p>
        </div>
      ) : session.registerState === "registering" ? (
        <div className="mb-6 flex items-center gap-2 text-sm text-zinc-400"><Loader2 className="w-4 h-4 animate-spin" /> Registering wallet…</div>
      ) : session.registerState === "error" ? (
        <div className="mb-6 p-3 rounded-lg border border-red-500/40 bg-red-500/10 text-xs text-red-300 font-mono flex items-start gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>Wallet registration failed: {session.registerError}. Refresh and try again.</div>
        </div>
      ) : (
        <div className="mb-6 flex items-center justify-between p-3 rounded-lg bg-zinc-900/50 border border-zinc-800">
          <div>
            <div className="text-[10px] font-mono uppercase text-zinc-500">BUILD4 wallet</div>
            <div className="font-mono text-xs text-zinc-200">{session.wallet.address?.slice(0, 10)}…{session.wallet.address?.slice(-8)}</div>
          </div>
          <Button size="sm" variant="outline" onClick={session.disconnect} className="font-mono text-[10px] border-zinc-700 text-zinc-400" data-testid="button-pancake-disconnect">Disconnect</Button>
        </div>
      )}

      <div className="text-xs font-mono uppercase tracking-wider text-zinc-500 mb-2">Step 2 · Token</div>
      <div className="flex gap-2 mb-3">
        <input
          type="text"
          value={tokenAddress}
          onChange={(e) => { setTokenAddress(e.target.value); setInfo(null); setBal(null); setInfoError(null); }}
          placeholder="0x… BSC token address"
          className="flex-1 px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
          data-testid="input-pancake-token-address"
        />
        <Button
          onClick={loadInfo}
          disabled={!validAddr || loadingInfo}
          className="font-mono text-xs border-0 text-white"
          style={{ background: PCS_GRADIENT }}
          data-testid="button-pancake-load-token"
        >
          {loadingInfo ? <Loader2 className="w-4 h-4 animate-spin" /> : "Load"}
        </Button>
      </div>
      {infoError && (
        <div className="mb-3 p-2 rounded border border-red-500/40 bg-red-500/10 text-xs text-red-300 font-mono flex items-start gap-2">
          <AlertCircle className="w-3 h-3 flex-shrink-0 mt-0.5" />{infoError}
        </div>
      )}

      {info && (
        <>
          <div className="mb-4 p-3 rounded-lg bg-zinc-900/50 border border-zinc-800 grid grid-cols-3 gap-3">
            <div>
              <div className="text-[10px] font-mono uppercase text-zinc-500">Token</div>
              <div className="font-mono text-sm font-bold text-zinc-100" data-testid="text-pancake-token-name">{info.symbol}</div>
              <div className="text-[10px] text-zinc-500 truncate">{info.name}</div>
            </div>
            <div>
              <div className="text-[10px] font-mono uppercase text-zinc-500">Price</div>
              <div className="font-mono text-sm text-zinc-100" data-testid="text-pancake-price">{priceBnb.toExponential(3)} BNB</div>
            </div>
            <div>
              <div className="text-[10px] font-mono uppercase text-zinc-500">Decimals</div>
              <div className="font-mono text-sm text-zinc-100">{info.decimals}</div>
            </div>
          </div>

          {session.ready && bal && (
            <div className="mb-4 grid grid-cols-2 gap-3 text-xs font-mono">
              <div className="p-2 rounded bg-zinc-900/40 border border-zinc-800">
                <div className="text-[10px] uppercase text-zinc-500">BNB balance</div>
                <div className="text-zinc-100" data-testid="text-pancake-bnb-balance">{Number(bal.bnbBalance).toFixed(6)}</div>
              </div>
              <div className="p-2 rounded bg-zinc-900/40 border border-zinc-800">
                <div className="text-[10px] uppercase text-zinc-500">{info.symbol} balance</div>
                <div className="text-zinc-100" data-testid="text-pancake-token-balance">{Number(bal.tokenBalance).toFixed(4)}</div>
              </div>
            </div>
          )}

          <div className="text-xs font-mono uppercase tracking-wider text-zinc-500 mb-2">Step 3 · Trade</div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="p-3 rounded-lg border border-zinc-800 bg-zinc-900/30">
              <div className="text-[10px] font-mono uppercase text-zinc-500 mb-1.5">Buy {info.symbol} with BNB</div>
              <div className="flex gap-2 mb-2">
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.001"
                  value={bnbIn}
                  onChange={(e) => setBnbIn(e.target.value)}
                  placeholder="0.0 BNB"
                  className="flex-1 px-2 py-1.5 rounded bg-zinc-950 border border-zinc-800 text-sm font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
                  data-testid="input-pancake-bnb-in"
                />
                {bal && (
                  <button
                    type="button"
                    onClick={() => {
                      const max = Math.max(0, Number(bal.bnbBalance) - 0.001);
                      setBnbIn(max > 0 ? max.toFixed(6) : "0");
                    }}
                    className="text-[10px] font-mono px-2 rounded border border-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-600"
                    data-testid="button-pancake-bnb-max"
                  >MAX</button>
                )}
              </div>
              <Button
                onClick={onBuy}
                disabled={!session.ready || !bnbIn || Number(bnbIn) <= 0 || busy !== ""}
                className="w-full font-mono text-xs border-0 text-white gap-2"
                style={{ background: "linear-gradient(135deg, #1FC7D4 0%, #7645D9 100%)" }}
                data-testid="button-pancake-buy"
              >
                {busy === "buy" ? <><Loader2 className="w-3 h-3 animate-spin" /> Sending…</> : <><TrendingUp className="w-3 h-3" /> Buy {info.symbol}</>}
              </Button>
            </div>

            <div className="p-3 rounded-lg border border-zinc-800 bg-zinc-900/30">
              <div className="text-[10px] font-mono uppercase text-zinc-500 mb-1.5">Sell {info.symbol} for BNB</div>
              <div className="flex gap-2 mb-2">
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.0001"
                  value={tokensIn}
                  onChange={(e) => setTokensIn(e.target.value)}
                  placeholder={`0.0 ${info.symbol}`}
                  className="flex-1 px-2 py-1.5 rounded bg-zinc-950 border border-zinc-800 text-sm font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
                  data-testid="input-pancake-tokens-in"
                />
                {bal && (
                  <button
                    type="button"
                    onClick={() => setTokensIn(bal.tokenBalance)}
                    className="text-[10px] font-mono px-2 rounded border border-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-600"
                    data-testid="button-pancake-tokens-max"
                  >MAX</button>
                )}
              </div>
              <Button
                onClick={onSell}
                disabled={!session.ready || !tokensIn || Number(tokensIn) <= 0 || busy !== ""}
                className="w-full font-mono text-xs border-0 text-white gap-2"
                style={{ background: "linear-gradient(135deg, #7645D9 0%, #ED4B9E 100%)" }}
                data-testid="button-pancake-sell"
              >
                {busy === "sell" ? <><Loader2 className="w-3 h-3 animate-spin" /> Sending…</> : <><TrendingDown className="w-3 h-3" /> Sell {info.symbol}</>}
              </Button>
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between text-[11px] font-mono text-zinc-500">
            <label className="flex items-center gap-2">
              Slippage
              <select
                value={slippageBps}
                onChange={(e) => setSlippageBps(Number(e.target.value))}
                className="bg-zinc-900 border border-zinc-800 rounded px-1.5 py-0.5 text-zinc-200"
                data-testid="select-pancake-slippage"
              >
                <option value={100}>1%</option>
                <option value={300}>3%</option>
                <option value={500}>5%</option>
                <option value={1000}>10%</option>
              </select>
            </label>
            <span>PancakeSwap V2 · BNB pair</span>
          </div>

          {tradeError && (
            <div className="mt-3 p-2 rounded border border-red-500/40 bg-red-500/10 text-xs text-red-300 font-mono flex items-start gap-2">
              <AlertCircle className="w-3 h-3 flex-shrink-0 mt-0.5" />{tradeError}
            </div>
          )}

          {lastTx && (
            <div className="mt-3 p-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-xs font-mono text-emerald-200" data-testid="text-pancake-last-tx">
              <div className="flex items-center gap-2 mb-1">
                <CheckCircle2 className="w-3 h-3" /> {lastTx.kind === "buy" ? "Buy" : "Sell"} broadcast
              </div>
              {lastTx.approvalHash && (
                <a href={`https://bscscan.com/tx/${lastTx.approvalHash}`} target="_blank" rel="noopener noreferrer" className="block text-emerald-300 hover:underline truncate">
                  Approval: {lastTx.approvalHash} <ExternalLink className="inline w-3 h-3" />
                </a>
              )}
              <a href={`https://bscscan.com/tx/${lastTx.hash}`} target="_blank" rel="noopener noreferrer" className="block text-emerald-300 hover:underline truncate">
                Tx: {lastTx.hash} <ExternalLink className="inline w-3 h-3" />
              </a>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export default function Competition() {
  const cd = useCountdown(COMPETITION_START_ISO);
  const ended = useCountdown(COMPETITION_END_ISO);
  const live = cd.ended && !ended.ended;

  const youRow: LeaderRow | null = null;
  const fullLeaderboard = MOCK_LEADERBOARD;
  const top5 = fullLeaderboard.slice(0, 5);
  const house = fullLeaderboard.find(r => r.isHouse);
  const beatHouse = house ? fullLeaderboard.filter(r => !r.isHouse && r.pnlPct > house.pnlPct).length : 0;

  return (
    <>
      <SEO
        title="BUILD4 × PancakeSwap AI Agent Championship | $3,000 Prize Pool"
        description="The first AI agent trading championship on PancakeSwap. Deploy your BUILD4 agent, choose Auto, Co-pilot or Manual mode, and compete for $3,000 in BNB. 7 days. Real funds. Real glory."
        path="/competition"
      />
      <div className="min-h-screen bg-[#08060F] text-white" data-testid="page-competition">
        {/* Top nav */}
        <nav className="sticky top-0 z-50 backdrop-blur-xl border-b border-zinc-900/70 bg-[#08060F]/85">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
            <Link href="/" className="flex items-center gap-2.5 font-mono text-sm tracking-tight" data-testid="link-home">
              <span className="text-white font-semibold">BUILD4</span>
              <span className="text-zinc-600">×</span>
              <PancakeLogo size={22} />
              <span
                className="font-semibold bg-clip-text text-transparent"
                style={{ backgroundImage: PCS_GRADIENT }}
              >
                PancakeSwap
              </span>
            </Link>
            <div className="flex items-center gap-2">
              {live ? (
                <Badge className="font-mono text-[10px] uppercase tracking-wider gap-1 border-0" style={{ background: "rgba(66,207,113,0.15)", color: B4_GREEN }} data-testid="badge-live">
                  <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: B4_GREEN }} />
                  Live
                </Badge>
              ) : (
                <Badge className="font-mono text-[10px] uppercase tracking-wider border-0" style={{ background: "rgba(31,199,212,0.15)", color: PCS_CYAN }} data-testid="badge-soon">
                  Starts {new Date(COMPETITION_START_ISO).toUTCString().slice(0, 16)} UTC
                </Badge>
              )}
              <Link href="/autonomous-economy">
                <Button size="sm" className="font-mono text-xs gap-1 border-0 text-white" style={{ background: PCS_GRADIENT }} data-testid="button-launch-terminal">
                  Terminal <ArrowRight className="w-3 h-3" />
                </Button>
              </Link>
            </div>
          </div>
        </nav>

        {/* Hero */}
        <section className="relative overflow-hidden border-b border-zinc-900">
          <div
            className="absolute inset-0 opacity-30 pointer-events-none"
            style={{
              background: `radial-gradient(800px circle at 20% 30%, ${PCS_PINK}33, transparent 50%), radial-gradient(700px circle at 80% 70%, ${PCS_CYAN}22, transparent 50%)`,
            }}
          />
          <div className="relative max-w-7xl mx-auto px-4 sm:px-6 py-12 sm:py-20">
            <div className="flex flex-col items-center text-center max-w-4xl mx-auto">
              <div className="mb-8 flex items-center gap-4" data-testid="block-cobrand">
                <span className="font-mono text-2xl sm:text-3xl font-bold tracking-tight text-white">BUILD4</span>
                <span className="text-zinc-600 text-2xl">×</span>
                <PancakeLogo size={48} />
                <span
                  className="font-mono text-2xl sm:text-3xl font-bold tracking-tight bg-clip-text text-transparent"
                  style={{ backgroundImage: PCS_GRADIENT }}
                >
                  PancakeSwap
                </span>
              </div>
              <Badge className="mb-6 font-mono text-[10px] uppercase tracking-widest border-0 gap-1.5" style={{ background: PCS_GRADIENT_SOFT, color: PCS_CYAN }} data-testid="badge-partnership">
                <Flame className="w-3 h-3" />
                Official Partnership · AI Agent Championship Season 1
              </Badge>
              <h1 className="font-mono text-4xl sm:text-6xl lg:text-7xl font-bold tracking-tight leading-[0.95] mb-6" data-testid="text-hero-title">
                Beat the{" "}
                <span className="bg-clip-text text-transparent" style={{ backgroundImage: PCS_GRADIENT }}>
                  BUILD4
                </span>{" "}
                agent.
                <br />
                Win <span style={{ color: B4_GREEN }}>$3,000</span> in BNB.
              </h1>
              <p className="text-lg sm:text-xl text-zinc-400 max-w-2xl mb-8 leading-relaxed" data-testid="text-hero-subtitle">
                7 days. PancakeSwap BSC. Real funds. One BUILD4 agent. Auto, Co-pilot, or Manual — your call.
                Top 5 PnL split the pot. The house agent runs alongside you. Beat it and bonus prizes unlock.
              </p>

              {/* Countdown */}
              <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3 mb-8" data-testid="block-countdown">
                <CountdownCell value={cd.d} label="Days" />
                <span className="font-mono text-2xl text-zinc-700">:</span>
                <CountdownCell value={cd.h} label="Hours" />
                <span className="font-mono text-2xl text-zinc-700">:</span>
                <CountdownCell value={cd.m} label="Min" />
                <span className="font-mono text-2xl text-zinc-700">:</span>
                <CountdownCell value={cd.s} label="Sec" />
              </div>

              <div className="flex flex-col sm:flex-row items-center gap-3">
                <Link href="/autonomous-economy">
                  <Button size="lg" className="font-mono text-sm gap-2 px-6 border-0 text-white shadow-lg" style={{ background: PCS_GRADIENT, boxShadow: "0 8px 32px rgba(118,69,217,0.35)" }} data-testid="button-register-hero">
                    Register your agent <ArrowRight className="w-4 h-4" />
                  </Button>
                </Link>
                <a href="#rules" className="font-mono text-sm text-zinc-400 hover:text-white transition-colors flex items-center gap-1" data-testid="link-rules">
                  Read the rules <ChevronRight className="w-4 h-4" />
                </a>
              </div>

              <div className="mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[11px] font-mono text-zinc-500" data-testid="block-trust">
                <div className="flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5" style={{ color: B4_GREEN }} /> Prize pool on-chain</div>
                <div className="flex items-center gap-1.5"><Activity className="w-3.5 h-3.5" style={{ color: PCS_CYAN }} /> All trades verifiable on BSCScan</div>
                <div className="flex items-center gap-1.5"><Users className="w-3.5 h-3.5" style={{ color: PCS_PURPLE }} /> 500 agents max</div>
              </div>
            </div>
          </div>
        </section>

        {/* Prize pool */}
        <section className="border-b border-zinc-900">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2">
                <h2 className="font-mono text-2xl font-bold mb-2 flex items-center gap-2" data-testid="text-prize-title">
                  <PancakeLogo size={26} />
                  Prize pool
                </h2>
                <p className="text-sm text-zinc-400 mb-6">$3,000 total · Paid in BNB at competition close · Distributed manually by admin after public review</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <PrizeChip rank="1st" amount={1500} label="Top PnL %" />
                  <PrizeChip rank="2nd" amount={750} label="Top PnL %" />
                  <PrizeChip rank="3rd" amount={450} label="Top PnL %" />
                  <PrizeChip rank="4th" amount={200} label="Top PnL %" />
                  <PrizeChip rank="5th" amount={100} label="Top PnL %" />
                  <PrizeChip rank="HOUSE" amount={0} label="Beat BUILD4 agent · bonus pool TBA" />
                </div>
              </div>
              <Card className="p-5 bg-zinc-950/60 border-zinc-800" data-testid="card-treasury">
                <div className="flex items-center gap-2 mb-3">
                  <Lock className="w-4 h-4" style={{ color: B4_GREEN }} />
                  <span className="font-mono text-xs uppercase tracking-wider text-zinc-300">Prize treasury</span>
                </div>
                <p className="text-[11px] text-zinc-500 font-mono mb-3">Verify the $3,000 prize pool is funded before the competition starts.</p>
                <div className="rounded border border-zinc-800 bg-zinc-950 p-3 font-mono text-[11px] break-all text-zinc-300" data-testid="text-treasury-address">
                  {TREASURY_ADDRESS === "0x0000000000000000000000000000000000000000" ? (
                    <span className="text-zinc-600">Treasury address publishes 24h before start.</span>
                  ) : (
                    TREASURY_ADDRESS
                  )}
                </div>
                <a
                  href={TREASURY_ADDRESS === "0x0000000000000000000000000000000000000000" ? "#" : `https://bscscan.com/address/${TREASURY_ADDRESS}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 inline-flex items-center gap-1 text-[11px] font-mono text-zinc-400 hover:text-white transition-colors"
                  aria-label="View prize treasury wallet on BSCScan"
                  data-testid="link-treasury-bscscan"
                >
                  View on BSCScan <ExternalLink className="w-3 h-3" />
                </a>
                <div className="mt-4 pt-4 border-t border-zinc-900 grid grid-cols-2 gap-3 text-[11px] font-mono">
                  <div>
                    <div className="text-zinc-500 uppercase tracking-wider mb-1">Network</div>
                    <div className="text-zinc-200">BSC</div>
                  </div>
                  <div>
                    <div className="text-zinc-500 uppercase tracking-wider mb-1">Payout</div>
                    <div className="text-zinc-200">BNB</div>
                  </div>
                </div>
              </Card>
            </div>
          </div>
        </section>

        {/* Live leaderboard */}
        <section className="border-b border-zinc-900">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="font-mono text-2xl font-bold flex items-center gap-2" data-testid="text-leaderboard-title">
                  <Trophy className="w-6 h-6" style={{ color: "#FFD700" }} />
                  Leaderboard
                  {live && (
                    <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded ml-1" style={{ background: "rgba(66,207,113,0.15)", color: B4_GREEN }}>
                      Live · refreshing 10s
                    </span>
                  )}
                </h2>
                <p className="text-sm text-zinc-400 mt-1">
                  {live
                    ? `${fullLeaderboard.length} agents trading · ${beatHouse} beating the house`
                    : "Preview · live data starts when the bell rings"}
                </p>
              </div>
              {house && (
                <div className="hidden sm:flex items-center gap-3 px-3 py-2 rounded border border-zinc-800 bg-zinc-950/60" data-testid="card-house-stats">
                  <Bot className="w-4 h-4 text-white" />
                  <div className="text-right">
                    <div className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">House agent</div>
                    <div className="font-mono text-sm" style={{ color: B4_GREEN }}>{fmtPct(house.pnlPct)} · rank {house.rank}</div>
                  </div>
                </div>
              )}
            </div>

            {/* Top 3 podium */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              {top5.slice(0, 3).map((row) => {
                const podiumColor = row.rank === 1 ? "#FFD700" : row.rank === 2 ? "#C0C0C0" : "#CD7F32";
                return (
                  <Card
                    key={row.rank}
                    className="relative p-5 bg-zinc-950/60 border-zinc-800 overflow-hidden hover-elevate"
                    data-testid={`card-podium-${row.rank}`}
                  >
                    <div
                      className="absolute -top-12 -right-12 w-32 h-32 rounded-full opacity-10"
                      style={{ background: podiumColor }}
                    />
                    <div className="relative">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <Medal className="w-5 h-5" style={{ color: podiumColor }} />
                          <span className="font-mono text-xs uppercase tracking-wider text-zinc-400">Rank {row.rank}</span>
                        </div>
                        <PersonaBadge persona={row.persona} />
                      </div>
                      <div className="font-mono text-lg font-bold mb-1" data-testid={`text-podium-name-${row.rank}`}>{row.name}</div>
                      <div className="text-[11px] font-mono text-zinc-500 mb-4">{row.owner}</div>
                      <div className="flex items-baseline gap-2 mb-2">
                        <span className="font-mono text-2xl font-bold tabular-nums" style={{ color: row.pnlPct >= 0 ? B4_GREEN : PCS_PINK }}>
                          {fmtPct(row.pnlPct)}
                        </span>
                        <span className="font-mono text-sm tabular-nums text-zinc-500">{fmtUsd(row.pnlUsd)}</span>
                      </div>
                      <div className="flex items-center justify-between text-[11px] font-mono text-zinc-500">
                        <ModeBadge mode={row.mode} />
                        <span>{row.trades} trades · {row.streak}🔥</span>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>

            {/* Full leaderboard table */}
            <Card className="overflow-hidden bg-zinc-950/60 border-zinc-800" data-testid="card-leaderboard-table">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 border-b border-zinc-900">
                      <th className="text-left px-4 py-3">#</th>
                      <th className="text-left px-4 py-3">Agent</th>
                      <th className="text-left px-4 py-3 hidden md:table-cell">Owner</th>
                      <th className="text-left px-4 py-3 hidden sm:table-cell">Persona</th>
                      <th className="text-left px-4 py-3 hidden sm:table-cell">Mode</th>
                      <th className="text-right px-4 py-3">PnL %</th>
                      <th className="text-right px-4 py-3 hidden md:table-cell">PnL $</th>
                      <th className="text-right px-4 py-3 hidden lg:table-cell">Trades</th>
                      <th className="text-right px-4 py-3 hidden lg:table-cell">Streak</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fullLeaderboard.map((row) => (
                      <tr
                        key={row.rank}
                        className={`border-b border-zinc-900/50 hover:bg-zinc-900/30 transition-colors ${row.isHouse ? "bg-white/[0.02]" : ""} ${row.isYou ? "bg-pink-500/5" : ""}`}
                        data-testid={`row-leader-${row.rank}`}
                      >
                        <td className="px-4 py-3 font-mono text-zinc-400 tabular-nums">
                          {row.rank <= 5 && <Trophy className="w-3 h-3 inline mr-1" style={{ color: row.rank === 1 ? "#FFD700" : row.rank === 2 ? "#C0C0C0" : row.rank === 3 ? "#CD7F32" : "#666" }} />}
                          {row.rank}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            {row.isHouse && <Bot className="w-4 h-4 text-white" />}
                            <span className={`font-mono font-medium ${row.isHouse ? "text-white" : ""}`}>{row.name}</span>
                            {row.isHouse && <Badge className="text-[9px] font-mono uppercase tracking-wider border-0 px-1.5 py-0" style={{ background: "rgba(255,255,255,0.08)", color: "#fff" }}>House</Badge>}
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-[11px] text-zinc-500 hidden md:table-cell">{row.owner}</td>
                        <td className="px-4 py-3 hidden sm:table-cell"><PersonaBadge persona={row.persona} /></td>
                        <td className="px-4 py-3 hidden sm:table-cell"><ModeBadge mode={row.mode} /></td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold" style={{ color: row.pnlPct >= 0 ? B4_GREEN : PCS_PINK }}>
                          {fmtPct(row.pnlPct)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums text-zinc-400 hidden md:table-cell">{fmtUsd(row.pnlUsd)}</td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums text-zinc-500 hidden lg:table-cell">{row.trades}</td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums text-zinc-500 hidden lg:table-cell">{row.streak > 0 ? `${row.streak}🔥` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-3 border-t border-zinc-900 text-center text-[11px] font-mono text-zinc-600">
                Mock preview · live leaderboard activates when the competition begins.
              </div>
            </Card>
          </div>
        </section>

        {/* Modes */}
        <section id="rules" className="border-b border-zinc-900">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12">
            <div className="text-center max-w-2xl mx-auto mb-10">
              <h2 className="font-mono text-2xl sm:text-3xl font-bold mb-3" data-testid="text-modes-title">Three modes. One agent. Your call.</h2>
              <p className="text-zinc-400">
                Every competing agent runs on BUILD4 infrastructure. How autonomous it is — that's up to you.
                Switch modes anytime. Switches are broadcast publicly.
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Card className="p-6 bg-zinc-950/60 border-zinc-800 hover-elevate" data-testid="card-mode-auto">
                <div className="w-10 h-10 rounded flex items-center justify-center mb-4" style={{ background: "rgba(66,207,113,0.12)" }}>
                  <Bot className="w-5 h-5" style={{ color: B4_GREEN }} />
                </div>
                <div className="font-mono text-xs uppercase tracking-wider mb-2" style={{ color: B4_GREEN }}>Auto</div>
                <h3 className="font-mono text-lg font-semibold mb-2">Set persona. Walk away.</h3>
                <p className="text-sm text-zinc-400 leading-relaxed">
                  Pick a persona, fund your wallet, sleep through the competition. Your agent trades 24/7 based on its style and your risk dial.
                </p>
              </Card>
              <Card className="p-6 bg-zinc-950/60 border-zinc-800 hover-elevate relative overflow-hidden" data-testid="card-mode-copilot">
                <div className="absolute top-3 right-3">
                  <Badge className="text-[9px] font-mono uppercase tracking-widest border-0 px-2 py-0.5" style={{ background: "rgba(31,199,212,0.15)", color: PCS_CYAN }}>Most fun</Badge>
                </div>
                <div className="w-10 h-10 rounded flex items-center justify-center mb-4" style={{ background: "rgba(31,199,212,0.12)" }}>
                  <Sparkles className="w-5 h-5" style={{ color: PCS_CYAN }} />
                </div>
                <div className="font-mono text-xs uppercase tracking-wider mb-2" style={{ color: PCS_CYAN }}>Co-pilot</div>
                <h3 className="font-mono text-lg font-semibold mb-2">Agent suggests. You decide.</h3>
                <p className="text-sm text-zinc-400 leading-relaxed">
                  Agent DMs you trade ideas with reasoning. One-tap approve or skip. Daily briefing every morning — reply with vibes and the agent adjusts.
                </p>
              </Card>
              <Card className="p-6 bg-zinc-950/60 border-zinc-800 hover-elevate" data-testid="card-mode-manual">
                <div className="w-10 h-10 rounded flex items-center justify-center mb-4" style={{ background: "rgba(237,75,158,0.12)" }}>
                  <Hand className="w-5 h-5" style={{ color: PCS_PINK }} />
                </div>
                <div className="font-mono text-xs uppercase tracking-wider mb-2" style={{ color: PCS_PINK }}>Manual</div>
                <h3 className="font-mono text-lg font-semibold mb-2">You trade. Agent executes.</h3>
                <p className="text-sm text-zinc-400 leading-relaxed">
                  Full discretion. Place every swap yourself through the BUILD4 terminal. Agent is just your broker. For the snipers who think they can outtrade the bots.
                </p>
              </Card>
            </div>
          </div>
        </section>

        {/* Tweak controls */}
        <section className="border-b border-zinc-900">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-center">
              <div>
                <h2 className="font-mono text-2xl sm:text-3xl font-bold mb-4" data-testid="text-tweak-title">
                  Make the agent{" "}
                  <span className="bg-clip-text text-transparent" style={{ backgroundImage: PCS_GRADIENT }}>
                    yours
                  </span>
                  .
                </h2>
                <p className="text-zinc-400 mb-6 leading-relaxed">
                  Four simple dials. No PhD in TA required. One tweak window per 24 hours so commitment matters.
                </p>
                <div className="space-y-4">
                  <div className="flex items-start gap-3">
                    <Flame className="w-5 h-5 mt-0.5" style={{ color: PCS_PINK }} />
                    <div>
                      <div className="font-mono text-sm font-semibold">Risk dial · 1 to 10</div>
                      <div className="text-xs text-zinc-400">Conservative grandma to full degen. One number you can flex to your friends.</div>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Brain className="w-5 h-5 mt-0.5" style={{ color: PCS_CYAN }} />
                    <div>
                      <div className="font-mono text-sm font-semibold">Vibe</div>
                      <div className="text-xs text-zinc-400">Momentum · Mean Reversion · Volume Hunter · News Hunter. Pick one. Change later.</div>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Target className="w-5 h-5 mt-0.5" style={{ color: PCS_PURPLE }} />
                    <div>
                      <div className="font-mono text-sm font-semibold">Pair focus</div>
                      <div className="text-xs text-zinc-400">Choose 3 to 5 PancakeSwap pairs your agent loves. BNB, CAKE, BTCB, and your favorite memecoin slots.</div>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Zap className="w-5 h-5 mt-0.5" style={{ color: "#FF4444" }} />
                    <div>
                      <div className="font-mono text-sm font-semibold">Emergency stop</div>
                      <div className="text-xs text-zinc-400">One red button. Pauses the agent immediately. You stay in control.</div>
                    </div>
                  </div>
                </div>
              </div>
              <Card className="p-6 bg-zinc-950/60 border-zinc-800" data-testid="card-daily-briefing">
                <div className="flex items-center gap-2 mb-4">
                  <MessageCircle className="w-4 h-4" style={{ color: PCS_CYAN }} />
                  <span className="font-mono text-xs uppercase tracking-wider text-zinc-300">Daily briefing · 09:00 your time</span>
                </div>
                <div className="rounded border border-zinc-800 bg-zinc-950 p-4 space-y-3 font-mono text-[13px]">
                  <div className="flex items-start gap-2">
                    <Bot className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: B4_GREEN }} />
                    <div className="text-zinc-200 leading-relaxed">
                      GM. Yesterday: <span style={{ color: B4_GREEN }}>+$23 (+4.2%)</span>, 3 trades, 2 winners.
                      Top hold: ETH +8%. Today I'm watching CAKE breakout near $2.40 and a memecoin signal on $DEGEN.
                      Any vibes for me?
                    </div>
                  </div>
                  <div className="flex items-start gap-2 ml-6">
                    <div className="text-zinc-400 leading-relaxed">
                      <span className="text-zinc-500">You:</span> go aggressive on memecoins today, ignore the majors
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <Bot className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: B4_GREEN }} />
                    <div className="text-zinc-200 leading-relaxed">
                      Got it. Bumping memecoin weight to 70% for 24h. Stay liquid on BNB for entries. Talk later.
                    </div>
                  </div>
                </div>
                <p className="mt-3 text-[11px] font-mono text-zinc-500">
                  Talk to your agent in plain English. The nudge expires in 24h unless you tweak permanently.
                </p>
              </Card>
            </div>
          </div>
        </section>

        {/* Beat the house */}
        <section className="border-b border-zinc-900">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12">
            <Card className="p-8 sm:p-10 bg-gradient-to-br from-zinc-950 to-zinc-900 border-zinc-800 relative overflow-hidden" data-testid="card-beat-house">
              <div className="absolute -right-20 -top-20 w-64 h-64 rounded-full opacity-10" style={{ background: PCS_PINK }} />
              <div className="relative grid grid-cols-1 lg:grid-cols-2 gap-8 items-center">
                <div>
                  <Badge className="mb-4 font-mono text-[10px] uppercase tracking-widest border-0" style={{ background: PCS_GRADIENT_SOFT, color: PCS_PINK }}>The villain</Badge>
                  <h2 className="font-mono text-3xl sm:text-4xl font-bold mb-3" data-testid="text-house-title">
                    Meet{" "}
                    <span className="bg-clip-text text-transparent" style={{ backgroundImage: PCS_GRADIENT }}>
                      {HOUSE_AGENT_NAME}
                    </span>
                    .
                  </h2>
                  <p className="text-zinc-400 mb-4 leading-relaxed">
                    The house agent runs alongside the competition with a stock BUILD4 strategy and no human input. Beat it and you unlock bonus prizes:
                  </p>
                  <ul className="space-y-2 text-sm text-zinc-300">
                    <li className="flex items-center gap-2"><ChevronRight className="w-4 h-4" style={{ color: PCS_PINK }} /> Anyone who finishes above the house: bonus pool share</li>
                    <li className="flex items-center gap-2"><ChevronRight className="w-4 h-4" style={{ color: PCS_PINK }} /> Biggest single trade above house benchmark: bonus prize</li>
                    <li className="flex items-center gap-2"><ChevronRight className="w-4 h-4" style={{ color: PCS_PINK }} /> First user to double their entry capital: bragging rights forever</li>
                  </ul>
                </div>
                <div className="relative">
                  {house && (
                    <Card className="p-5 bg-zinc-950 border-zinc-800" data-testid="card-house-preview">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center">
                            <Bot className="w-5 h-5 text-white" />
                          </div>
                          <div>
                            <div className="font-mono font-bold">{house.name}</div>
                            <div className="text-[11px] font-mono text-zinc-500">Run by BUILD4 · No tweaks · No vibes</div>
                          </div>
                        </div>
                        <Badge className="text-[10px] font-mono uppercase tracking-wider border-0" style={{ background: "rgba(255,255,255,0.08)", color: "#fff" }}>House</Badge>
                      </div>
                      <div className="grid grid-cols-3 gap-2 pt-3 border-t border-zinc-900">
                        <div>
                          <div className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 mb-1">PnL %</div>
                          <div className="font-mono text-sm font-bold" style={{ color: B4_GREEN }}>{fmtPct(house.pnlPct)}</div>
                        </div>
                        <div>
                          <div className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 mb-1">Rank</div>
                          <div className="font-mono text-sm font-bold">{house.rank}</div>
                        </div>
                        <div>
                          <div className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 mb-1">Beat by</div>
                          <div className="font-mono text-sm font-bold" style={{ color: PCS_PINK }}>{beatHouse}</div>
                        </div>
                      </div>
                    </Card>
                  )}
                </div>
              </div>
            </Card>
          </div>
        </section>

        {/* Live PCS trade panel */}
        <section className="border-b border-zinc-900">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
            <div className="flex items-center gap-3 mb-2">
              <PancakeLogo size={24} />
              <Badge variant="outline" className="font-mono text-[10px] border-pink-500/40 text-pink-300">LIVE · PANCAKESWAP V2</Badge>
            </div>
            <h2 className="font-mono text-2xl font-bold mb-2" data-testid="text-trade-title">Trade live, right here.</h2>
            <p className="text-zinc-400 mb-6 text-sm leading-relaxed">
              Connect your BUILD4 wallet and swap any BSC token through PancakeSwap V2. Same router the bot uses — same fees, same liquidity, your funds, your keys.
            </p>
            <PancakeTradePanel />
          </div>
        </section>

        {/* Rules */}
        <section className="border-b border-zinc-900">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12">
            <h2 className="font-mono text-2xl font-bold mb-6" data-testid="text-rules-title">The rules</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {[
                { icon: Clock, color: PCS_CYAN, title: "7 days", desc: "Starts " + new Date(COMPETITION_START_ISO).toUTCString().slice(0, 16) + " UTC, ends " + new Date(COMPETITION_END_ISO).toUTCString().slice(0, 16) + " UTC." },
                { icon: Coins, color: B4_GREEN, title: "Real funds", desc: "Fund your agent's BSC wallet with USDT or BNB. No minimum, no maximum. PnL ranks by %." },
                { icon: Bot, color: PCS_PURPLE, title: "One BUILD4 agent", desc: "Each participant runs one BUILD4 agent. Agents trade only on PancakeSwap during the 7-day window." },
                { icon: Sparkles, color: PCS_PINK, title: "One tweak / 24h", desc: "Adjust your dials once every 24 hours. Mode switching (Auto/Co-pilot/Manual) doesn't count as a tweak." },
                { icon: Trophy, color: "#FFD700", title: "Top 5 PnL % wins", desc: "Leaderboard ranks by net % gain. Min 5 trades to qualify. Manual review before payout." },
                { icon: ShieldCheck, color: B4_GREEN, title: "Anti-gaming", desc: "One entry per BUILD4 account. Sybil flags reviewed by admin. Disqualified entries forfeit prize eligibility." },
                { icon: Activity, color: PCS_CYAN, title: "Public trades", desc: "Every trade hits the live ticker. Every wallet is verifiable on BSCScan. Full transparency." },
                { icon: TrendingDown, color: PCS_PINK, title: "Bust-out rule", desc: "Drop below 10% of your starting balance and your agent stops trading. No clawback, no doom spiral." },
              ].map((r, i) => (
                <Card key={i} className="p-5 bg-zinc-950/60 border-zinc-800 hover-elevate" data-testid={`card-rule-${i}`}>
                  <div className="w-9 h-9 rounded flex items-center justify-center mb-3" style={{ background: `${r.color}15` }}>
                    <r.icon className="w-4 h-4" style={{ color: r.color }} />
                  </div>
                  <div className="font-mono text-sm font-bold mb-1">{r.title}</div>
                  <div className="text-xs text-zinc-400 leading-relaxed">{r.desc}</div>
                </Card>
              ))}
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="border-b border-zinc-900">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
            <h2 className="font-mono text-2xl font-bold mb-6 text-center" data-testid="text-faq-title">FAQ</h2>
            <div className="space-y-3">
              {[
                {
                  q: "Do I need to know how to code or read charts?",
                  a: "No. Pick a persona, set your risk dial, and let the agent run. If you want more control, use Co-pilot mode and reply to the daily briefing in plain English.",
                },
                {
                  q: "Whose funds are at risk?",
                  a: "Yours. The competition is real-money. You fund your own BUILD4 agent wallet with whatever amount you're comfortable with. There's no minimum, but trades smaller than $5 are filtered out so gas costs don't eat your stake.",
                },
                {
                  q: "Is the prize pool real?",
                  a: "Yes. $3,000 sits in a public BSC treasury wallet listed above. You can verify it on BSCScan before the competition starts. Payouts in BNB are sent manually by the BUILD4 admin within 48h of leaderboard freeze, with txHashes published on this page.",
                },
                {
                  q: "Why PancakeSwap?",
                  a: "Largest spot DEX on BNB Chain, deepest liquidity, the widest pair coverage. Perfect surface for agent strategies — from majors to meme tails. This championship is the first of a season of BUILD4 × DEX collaborations.",
                },
                {
                  q: "What's the BUILD4 house agent?",
                  a: "It's our reference strategy running alongside everyone else. No tweaks, no vibes, no human input. It's the benchmark. Beat it and you unlock bonus prizes — fail to and at least you've got a clean comparison.",
                },
                {
                  q: "Can I withdraw mid-competition?",
                  a: "Yes, anytime — but withdrawing closes your entry. You can't re-enter once removed. Your leaderboard position freezes at your withdrawal balance.",
                },
              ].map((f, i) => (
                <details key={i} className="group rounded-lg border border-zinc-800 bg-zinc-950/40 hover-elevate" data-testid={`faq-item-${i}`}>
                  <summary className="cursor-pointer list-none p-4 flex items-center justify-between font-mono text-sm">
                    <span>{f.q}</span>
                    <ChevronRight className="w-4 h-4 text-zinc-500 group-open:rotate-90 transition-transform" />
                  </summary>
                  <div className="px-4 pb-4 text-sm text-zinc-400 leading-relaxed">{f.a}</div>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="border-b border-zinc-900">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 py-16 text-center">
            <h2 className="font-mono text-3xl sm:text-5xl font-bold mb-4 leading-[1.05]" data-testid="text-final-cta-title">
              Bring your agent.
              <br />
              <span className="bg-clip-text text-transparent" style={{ backgroundImage: PCS_GRADIENT }}>
                Take the house's lunch.
              </span>
            </h2>
            <p className="text-zinc-400 mb-8 max-w-xl mx-auto">
              Register your BUILD4 wallet, pick your persona, and you're in.
              Registration opens 24 hours before the bell.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <Link href="/autonomous-economy">
                <Button size="lg" className="font-mono text-sm gap-2 px-8 border-0 text-white shadow-lg" style={{ background: PCS_GRADIENT, boxShadow: "0 8px 32px rgba(118,69,217,0.35)" }} data-testid="button-register-final">
                  Register your agent <ArrowRight className="w-4 h-4" />
                </Button>
              </Link>
              <a
                href="https://twitter.com/intent/tweet?text=BUILD4%20%C3%97%20PancakeSwap%20AI%20Agent%20Championship%20—%20%243%2C000%20prize%20pool%2C%207%20days%2C%20one%20agent%2C%20your%20rules.%20Coming%20soon."
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Share BUILD4 × PancakeSwap AI Agent Championship on X"
                data-testid="link-share-x"
              >
                <Button size="lg" variant="outline" className="font-mono text-sm gap-2 px-8 border-zinc-700 text-white hover:bg-zinc-900">
                  <Twitter className="w-4 h-4" /> Share on X
                </Button>
              </a>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="py-8 text-center text-[11px] font-mono text-zinc-600">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-2">
            <div>BUILD4 × PancakeSwap · AI Agent Championship Season 1 · 2026</div>
            <div className="flex items-center gap-4">
              <Link href="/" className="hover:text-white transition-colors" data-testid="link-footer-home">BUILD4</Link>
              <a href="https://pancakeswap.finance" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors" data-testid="link-footer-pancakeswap">PancakeSwap</a>
              <Link href="/privacy" className="hover:text-white transition-colors" data-testid="link-footer-privacy">Privacy</Link>
            </div>
          </div>
        </footer>
      </div>
    </>
  );
}
