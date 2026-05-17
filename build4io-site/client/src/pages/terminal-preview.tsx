import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  LayoutDashboard,
  Rocket,
  Target,
  Activity,
  ArrowUpRight,
  ArrowDownRight,
  Brain,
  Power,
  X,
  Plus,
  ChevronRight,
  Wifi,
  Lock,
  RefreshCw,
  Sparkles,
  Settings2,
  CheckCircle2,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { WalletConnector } from "@/components/wallet-connector";
import { WalletPanel } from "@/components/wallet-panel";
import { Wallet as WalletIcon } from "lucide-react";
import { useTerminalSession } from "@/hooks/use-terminal-session";
import { LinkTelegramCard } from "@/components/wallet-panel";
import asterLogo from "@assets/aster_logo.svg";
import hyperliquidLogo from "@assets/hyperliquid-logo_1775737973029.png";
import fourmemeLogo from "@assets/four_logo_1778389271440.jpg";
import polymarketLogo from "@assets/bz2ZO_nU_400x400_1778831154050.jpg";
import fortytwoLogo from "@assets/42space_logo.png";

type Venue = "dashboard" | "aster" | "hyperliquid" | "fourmeme" | "polymarket" | "fortytwo";

type VenueDef = {
  id: Venue;
  label: string;
  color: string;
  logo?: string;
  icon?: any;
};

const VENUES: VenueDef[] = [
  { id: "dashboard", label: "Overview", icon: LayoutDashboard, color: "text-primary" },
  { id: "aster", label: "Aster Perps", logo: asterLogo, color: "text-yellow-400" },
  { id: "hyperliquid", label: "Hyperliquid", logo: hyperliquidLogo, color: "text-cyan-400" },
  { id: "fourmeme", label: "fourmeme", logo: fourmemeLogo, color: "text-emerald-400" },
  { id: "polymarket", label: "Polymarket", logo: polymarketLogo, color: "text-blue-400" },
  { id: "fortytwo", label: "42.space", logo: fortytwoLogo, color: "text-orange-400" },
];

// All mock data removed — panes consume live wallet-scoped data.

const num = (v: any, d = 0): number => {
  const n = typeof v === "string" ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : d;
};
const fmtUsd = (n: number, decimals = 2) =>
  `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
const timeAgo = (ms: number) => {
  if (!ms) return "—";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

// Polymarket helpers
function parsePolyArray(v: any): any[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") { try { const j = JSON.parse(v); return Array.isArray(j) ? j : []; } catch { return []; } }
  return [];
}
function pickTradablePolyMarket(ev: any): { market: any | null; reason: string | null } {
  const markets = Array.isArray(ev?.markets) ? ev.markets : [];
  if (markets.length === 0) return { market: null, reason: "no markets" };
  let lastReason = "no live price";
  for (const m of markets) {
    if (m?.closed || m?.archived) { lastReason = "market closed"; continue; }
    if (!m?.conditionId) { lastReason = "no conditionId"; continue; }
    const ids = parsePolyArray(m.clobTokenIds);
    if (ids.length < 2 || !ids[0] || !ids[1]) { lastReason = "no token IDs"; continue; }
    const prices = parsePolyArray(m.outcomePrices).map((p: any) => num(p));
    const hasLive = prices.some((p) => p > 0 && p < 1);
    if (!hasLive) { lastReason = "no live price"; continue; }
    return { market: m, reason: null };
  }
  return { market: null, reason: lastReason };
}

// (legacy mock arrays removed)

type AccountSummary = {
  totalEquity: number | null;
  pnl24h: number | null;
  pnl24hPct: number | null;
  unrealizedPnl: number | null;
  agents: number | null;
  agentName: string | null;
  agentRunning: boolean;
  agentTrades: number;
  agentWins: number;
  agentLosses: number;
  isLive: boolean;
};

function StatusBar({ ready, summary }: { ready: boolean; summary: AccountSummary }) {
  const fmt = (n: number | null, prefix = "$") =>
    n == null ? "—" : `${n < 0 ? "-" : prefix}${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  const pnlClass = summary.pnl24h == null ? "text-muted-foreground" : summary.pnl24h >= 0 ? "text-primary" : "text-destructive";
  return (
    <div className="flex items-center justify-between px-4 sm:px-6 py-2.5 border-b bg-card/60 backdrop-blur-xl font-mono text-xs">
      <div className="flex items-center gap-4 sm:gap-6">
        <div className="flex items-center gap-2">
          <div className={`w-1.5 h-1.5 rounded-full ${summary.isLive ? "bg-primary animate-pulse" : "bg-muted-foreground/40"}`} />
          <span className="text-muted-foreground tracking-widest">BUILD<span className="text-primary">4</span> TERMINAL</span>
        </div>
        {!ready && (
          <Badge variant="outline" className="border-yellow-500/30 text-yellow-500 text-[10px] tracking-widest uppercase">
            Connect wallet
          </Badge>
        )}
      </div>
      <div className="hidden md:flex items-center gap-6">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">EQUITY</span>
          <span className="text-foreground font-semibold" data-testid="status-equity">{fmt(summary.totalEquity)}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">24h</span>
          <span className={`${pnlClass} font-semibold flex items-center`}>
            {summary.pnl24h != null && (summary.pnl24h >= 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />)}
            {fmt(summary.pnl24h)}
            {summary.pnl24hPct != null && ` · ${summary.pnl24hPct >= 0 ? "+" : ""}${summary.pnl24hPct.toFixed(2)}%`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">AGENTS</span>
          <span className="text-foreground font-semibold">{summary.agents == null ? "—" : `${summary.agents} live`}</span>
        </div>
        <div className={`flex items-center gap-2 ${summary.isLive ? "text-primary" : "text-muted-foreground"}`}>
          <Wifi className="w-3 h-3" />
          <span className="text-[10px] tracking-widest uppercase">{summary.isLive ? "WS LIVE" : "OFFLINE"}</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {ready && (
          <button
            onClick={() => { (globalThis as any).__b4OpenWallet?.(); }}
            className="px-2.5 py-1.5 rounded-md border border-border hover:border-primary/50 hover:bg-primary/5 text-xs font-mono tracking-widest uppercase inline-flex items-center gap-1.5 transition-colors"
            title="Deposit / Withdraw / Backup key"
            data-testid="button-open-wallet"
          >
            <WalletIcon className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Wallet</span>
          </button>
        )}
        <WalletConnector />
      </div>
    </div>
  );
}

function IconRail({ active, setActive }: { active: Venue; setActive: (v: Venue) => void }) {
  return (
    <aside className="w-14 sm:w-16 border-r bg-card/40 flex flex-col items-center py-3 gap-1">
      {VENUES.map((v) => {
        const Icon = v.icon;
        const isActive = active === v.id;
        return (
          <button
            key={v.id}
            onClick={() => setActive(v.id)}
            data-testid={`rail-${v.id}`}
            className={`relative w-10 h-10 rounded-md flex items-center justify-center transition-all group ${
              isActive ? "bg-primary/15" : "hover:bg-card"
            }`}
            title={v.label}
          >
            {v.logo ? (
              <img
                src={v.logo}
                alt={v.label}
                className={`w-5 h-5 object-contain transition-all ${
                  isActive ? "opacity-100" : "opacity-60 group-hover:opacity-100"
                }`}
                draggable={false}
              />
            ) : Icon ? (
              <Icon className={`w-4 h-4 ${isActive ? v.color : "text-muted-foreground group-hover:text-foreground"}`} />
            ) : null}
            {isActive && <div className="absolute left-0 top-2 bottom-2 w-0.5 rounded-r bg-primary" />}
            <span className="absolute left-full ml-2 px-2 py-1 rounded bg-popover border text-[10px] font-mono whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50">
              {v.label}
            </span>
          </button>
        );
      })}
      <div className="flex-1" />
      <button className="w-10 h-10 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-card transition-all">
        <Plus className="w-4 h-4" />
      </button>
    </aside>
  );
}

function VenueHeader({ title, sub, accent, agentOn = true }: { title: string; sub: string; accent: string; agentOn?: boolean }) {
  const [on, setOn] = useState(agentOn);
  return (
    <div className="flex items-start justify-between mb-6">
      <div>
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-2xl sm:text-3xl font-bold font-mono">{title}</h1>
          <Badge variant="outline" className={`text-[10px] tracking-widest uppercase ${accent}`}>LIVE</Badge>
        </div>
        <p className="text-sm text-muted-foreground">{sub}</p>
      </div>
      <button
        onClick={() => setOn(!on)}
        className={`flex items-center gap-2 px-3 py-2 rounded-md border transition-all font-mono text-xs ${
          on ? "border-primary/40 bg-primary/10 text-primary" : "border-border bg-card text-muted-foreground"
        }`}
        data-testid="button-agent-toggle"
      >
        <Power className="w-3.5 h-3.5" />
        <span className="tracking-widest uppercase">{on ? "Agent ON" : "Agent OFF"}</span>
      </button>
    </div>
  );
}

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="p-4 rounded-md border bg-card/60">
      <div className="text-[10px] font-mono text-muted-foreground tracking-widest uppercase mb-2">{label}</div>
      <div className={`text-xl sm:text-2xl font-bold font-mono ${accent ?? "text-foreground"}`}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-1 font-mono">{sub}</div>}
    </div>
  );
}

type VenueBalance = { v: string; val: number; pct: number; color: string };

function DashboardPane({
  onTrade,
  onNewAgent,
  ready,
  loading,
  err,
  summary,
  venues,
}: {
  onTrade: () => void;
  onNewAgent: () => void;
  ready: boolean;
  loading: boolean;
  err: string | null;
  summary: AccountSummary;
  venues: VenueBalance[];
}) {
  const fmtUsd = (n: number | null) =>
    n == null ? "—" : `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  const fmtPct = (n: number | null) => (n == null ? "" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);
  const pnlClass = (n: number | null) =>
    n == null ? "text-foreground" : n >= 0 ? "text-primary" : "text-destructive";

  return (
    <div>
      <VenueHeader title="Overview" sub="All venues, one view. Equity, agents, and live brain across the swarm." accent="border-primary/40 text-primary" />

      {!ready && (
        <div className="mb-6 p-5 rounded-md border border-yellow-500/30 bg-yellow-500/5 flex items-center justify-between gap-4">
          <div>
            <div className="font-mono text-xs tracking-widest uppercase text-yellow-500 mb-1">Wallet required</div>
            <div className="text-sm text-muted-foreground">Connect your wallet to load your real balances, positions, and agents.</div>
          </div>
          <WalletConnector />
        </div>
      )}

      {err && ready && (
        <div className="mb-4 p-3 rounded-md border border-destructive/40 bg-destructive/5 font-mono text-xs text-destructive" data-testid="text-account-error">
          {err}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard
          label="Total Equity"
          value={loading ? "…" : fmtUsd(summary.totalEquity)}
          sub={summary.totalEquity != null ? "Aster + HL" : "across all venues"}
        />
        <StatCard
          label="24h PnL"
          value={loading ? "…" : fmtUsd(summary.pnl24h)}
          sub={fmtPct(summary.pnl24hPct)}
          accent={pnlClass(summary.pnl24h)}
        />
        <StatCard
          label="Unrealized"
          value={loading ? "…" : fmtUsd(summary.unrealizedPnl)}
          sub="open positions"
          accent={pnlClass(summary.unrealizedPnl)}
        />
        <StatCard
          label="Active Agents"
          value={loading ? "…" : summary.agents == null ? "—" : String(summary.agents)}
          sub={summary.agents == null ? "—" : summary.agents > 0 ? "running" : "idle"}
        />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="p-5 rounded-md border bg-card/60">
          <h3 className="font-mono text-sm tracking-widest uppercase text-muted-foreground mb-4">Equity by venue</h3>
          <div className="space-y-3">
            {venues.length === 0 && (
              <div className="font-mono text-xs text-muted-foreground py-6 text-center">
                {ready ? "No balances on any venue yet." : "Connect wallet to load."}
              </div>
            )}
            {venues.map((r) => (
              <div key={r.v}>
                <div className="flex justify-between text-xs font-mono mb-1">
                  <span className="text-foreground">{r.v}</span>
                  <span className="text-muted-foreground">${r.val.toLocaleString(undefined, { maximumFractionDigits: 2 })} · {r.pct.toFixed(1)}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-border overflow-hidden">
                  <div className={`h-full ${r.color}`} style={{ width: `${Math.min(100, r.pct)}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="p-5 rounded-md border bg-card/60">
          <h3 className="font-mono text-sm tracking-widest uppercase text-muted-foreground mb-4">Active agents</h3>
          {!ready ? (
            <div className="font-mono text-xs text-muted-foreground py-12 text-center">
              Connect wallet to see your agents.
            </div>
          ) : !summary.agentName ? (
            <div className="font-mono text-xs text-muted-foreground py-12 text-center">
              No agent yet. Tap <span className="text-foreground">New Agent</span> to spin one up.
            </div>
          ) : (
            <div className="space-y-3" data-testid="dashboard-active-agent">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <div className={`w-2 h-2 rounded-full ${summary.agentRunning ? "bg-primary animate-pulse" : "bg-muted-foreground/40"}`} />
                  <span className="font-mono text-sm text-foreground truncate" data-testid="text-dashboard-agent-name">{summary.agentName}</span>
                </div>
                <Badge
                  variant="outline"
                  className={`text-[10px] tracking-widest uppercase ${summary.agentRunning ? "border-primary/40 text-primary" : "border-border text-muted-foreground"}`}
                >
                  {summary.agentRunning ? "Running" : "Idle"}
                </Badge>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center font-mono">
                <div className="p-2 rounded bg-background/40">
                  <div className="text-[10px] text-muted-foreground tracking-widest uppercase">Trades</div>
                  <div className="text-sm text-foreground font-semibold">{summary.agentTrades}</div>
                </div>
                <div className="p-2 rounded bg-background/40">
                  <div className="text-[10px] text-muted-foreground tracking-widest uppercase">Wins</div>
                  <div className="text-sm text-primary font-semibold">{summary.agentWins}</div>
                </div>
                <div className="p-2 rounded bg-background/40">
                  <div className="text-[10px] text-muted-foreground tracking-widest uppercase">Losses</div>
                  <div className="text-sm text-destructive font-semibold">{summary.agentLosses}</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="mt-6 flex flex-wrap gap-3">
        <Button
          onClick={onTrade}
          disabled={!ready}
          className="font-mono tracking-widest text-xs uppercase"
          data-testid="button-place-trade"
        >
          New Trade Ticket <ChevronRight className="w-3.5 h-3.5 ml-1" />
        </Button>
        <Button
          onClick={onNewAgent}
          disabled={!ready}
          variant="outline"
          className="font-mono tracking-widest text-xs uppercase"
          data-testid="button-new-agent"
        >
          <Sparkles className="w-3.5 h-3.5 mr-1" /> New Agent
        </Button>
      </div>
    </div>
  );
}

function EmptyPositions({ onTrade, label }: { onTrade: () => void; label: string }) {
  return (
    <div className="px-4 py-8 text-center">
      <div className="font-mono text-xs text-muted-foreground mb-3">{label}</div>
      <Button size="sm" onClick={onTrade} className="font-mono text-[10px] tracking-widest uppercase h-7" data-testid="button-empty-trade">
        <Plus className="w-3 h-3 mr-1" /> Open First Trade
      </Button>
    </div>
  );
}

function AsterPane({ session, asterAcct, onTrade, onRefetch }: { session: any; asterAcct: any; onTrade: () => void; onRefetch: () => void }) {
  const [orders, setOrders] = useState<any[]>([]);
  const [hist, setHist] = useState<any>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = async () => {
    if (!session.ready) return;
    try {
      const [o, h] = await Promise.allSettled([
        session.apiFetch<any>("/api/miniapp/orders"),
        session.apiFetch<any>("/api/miniapp/history"),
      ]);
      if (o.status === "fulfilled") setOrders(Array.isArray(o.value?.openOrders) ? o.value.openOrders : []);
      if (h.status === "fulfilled") setHist(h.value);
    } catch {}
  };
  useEffect(() => {
    load();
    const id = setInterval(load, 12000);
    return () => clearInterval(id);
  }, [session.ready]);

  const positions = useMemo(() => {
    const raw = Array.isArray(asterAcct?.positions) ? asterAcct.positions : [];
    return raw
      .map((p: any) => {
        const amt = num(p.positionAmt);
        if (Math.abs(amt) < 1e-9) return null;
        const entry = num(p.entryPrice);
        const mark = num(p.markPrice ?? p.markPx ?? entry);
        const upnl = num(p.unrealizedProfit ?? p.unrealizedPnl);
        const side = amt > 0 ? "LONG" : "SHORT";
        const pnlPct = entry > 0 && amt !== 0 ? ((mark - entry) / entry) * (amt > 0 ? 100 : -100) : 0;
        return { sym: p.symbol, side, size: Math.abs(amt), entry, mark, pnl: upnl, pnlPct, leverage: num(p.leverage, 1) };
      })
      .filter(Boolean);
  }, [asterAcct]);

  const walletBalance = num(asterAcct?.walletBalance);
  const unrealizedPnl = num(asterAcct?.unrealizedPnl);
  const realizedPnl = num(asterAcct?.realizedPnl);
  const day1 = hist?.pnlSummary?.day1;

  const closePos = async (symbol: string) => {
    setClosing(symbol);
    setMsg(null);
    try {
      const r = await session.apiFetch<any>("/api/miniapp/close", { method: "POST", body: JSON.stringify({ symbol }) });
      setMsg({ kind: "ok", text: `Closed ${symbol}${r?.executedQty ? ` @ ${r.executedQty}` : ""}` });
      onRefetch();
      load();
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message || "Close failed" });
    } finally {
      setClosing(null);
    }
  };
  const cancelOrder = async (orderId: number, symbol: string) => {
    setCancelling(orderId);
    setMsg(null);
    try {
      await session.apiFetch("/api/miniapp/cancel-order", { method: "POST", body: JSON.stringify({ orderId, symbol }) });
      setMsg({ kind: "ok", text: `Cancelled order ${orderId}` });
      load();
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message || "Cancel failed" });
    } finally {
      setCancelling(null);
    }
  };

  if (!session.ready) {
    return (
      <div>
        <VenueHeader title="Aster Perps" sub="Custodial perpetual futures on Aster DEX. AI-routed, single-master account." accent="border-yellow-400/40 text-yellow-400" />
        <div className="rounded-md border bg-card/60 p-12 text-center font-mono text-sm text-muted-foreground">
          Connect wallet to see your Aster positions.
        </div>
      </div>
    );
  }

  return (
    <div>
      <VenueHeader title="Aster Perps" sub="Custodial perpetual futures on Aster DEX. AI-routed, single-master account." accent="border-yellow-400/40 text-yellow-400" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="Margin Balance" value={fmtUsd(walletBalance)} sub="USDT" />
        <StatCard label="Unrealized PnL" value={`${unrealizedPnl >= 0 ? "+" : ""}${fmtUsd(unrealizedPnl)}`} accent={unrealizedPnl >= 0 ? "text-primary" : "text-destructive"} />
        <StatCard label="Open Positions" value={String(positions.length)} />
        <StatCard label="Today" value={day1 ? `${day1.pnl >= 0 ? "+" : ""}${fmtUsd(num(day1.pnl))}` : "—"} sub={day1 ? `${day1.total ?? 0} trades · ${day1.wins ?? 0}W/${day1.losses ?? 0}L` : undefined} accent={day1 && num(day1.pnl) >= 0 ? "text-primary" : "text-destructive"} />
      </div>
      {msg && (
        <div className={`mb-3 px-3 py-2 rounded font-mono text-[11px] ${msg.kind === "ok" ? "bg-primary/10 text-primary border border-primary/30" : "bg-destructive/10 text-destructive border border-destructive/30"}`}>
          {msg.text}
        </div>
      )}
      <div className="rounded-md border bg-card/60 overflow-hidden mb-6">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="font-mono text-sm tracking-widest uppercase text-muted-foreground">Positions · {positions.length}</h3>
          <div className="flex items-center gap-2">
            <button onClick={() => { load(); onRefetch(); }} className="text-muted-foreground hover:text-foreground" data-testid="button-aster-refresh"><RefreshCw className="w-3.5 h-3.5" /></button>
            <Button size="sm" onClick={onTrade} className="font-mono text-[10px] tracking-widest uppercase h-7" data-testid="button-new-trade-aster">
              <Plus className="w-3 h-3 mr-1" /> New Trade
            </Button>
          </div>
        </div>
        {positions.length === 0 ? (
          <EmptyPositions onTrade={onTrade} label="No open Aster positions." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-xs">
              <thead className="text-muted-foreground tracking-widest uppercase text-[10px] border-b">
                <tr>
                  <th className="text-left px-4 py-2">Symbol</th>
                  <th className="text-left px-4 py-2">Side</th>
                  <th className="text-right px-4 py-2">Size</th>
                  <th className="text-right px-4 py-2">Entry</th>
                  <th className="text-right px-4 py-2">Mark</th>
                  <th className="text-right px-4 py-2">PnL</th>
                  <th className="text-right px-4 py-2">Lev</th>
                  <th className="text-right px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p: any) => (
                  <tr key={p.sym} className="border-b last:border-0 hover:bg-background/40 transition-colors" data-testid={`row-aster-${p.sym}`}>
                    <td className="px-4 py-3 text-foreground font-semibold">{p.sym}</td>
                    <td className="px-4 py-3"><span className={p.side === "LONG" ? "text-primary" : "text-destructive"}>{p.side}</span></td>
                    <td className="px-4 py-3 text-right text-muted-foreground">{p.size.toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                    <td className="px-4 py-3 text-right text-muted-foreground">{p.entry.toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                    <td className="px-4 py-3 text-right text-foreground">{p.mark.toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                    <td className={`px-4 py-3 text-right font-semibold ${p.pnl >= 0 ? "text-primary" : "text-destructive"}`}>
                      {p.pnl >= 0 ? "+" : ""}${p.pnl.toFixed(2)} · {p.pnlPct >= 0 ? "+" : ""}{p.pnlPct.toFixed(2)}%
                    </td>
                    <td className="px-4 py-3 text-right text-muted-foreground">{p.leverage}x</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => closePos(p.sym)}
                        disabled={closing === p.sym}
                        className="text-[10px] tracking-widest uppercase text-muted-foreground hover:text-destructive disabled:opacity-50 transition-colors"
                        data-testid={`button-close-${p.sym}`}
                      >
                        {closing === p.sym ? "closing…" : "close"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="rounded-md border bg-card/60 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="font-mono text-sm tracking-widest uppercase text-muted-foreground">Open Orders · {orders.length}</h3>
          <div className="font-mono text-[10px] tracking-widest uppercase text-muted-foreground">Realized 30d {realizedPnl >= 0 ? "+" : ""}{fmtUsd(realizedPnl)}</div>
        </div>
        {orders.length === 0 ? (
          <div className="px-4 py-6 text-center font-mono text-[11px] text-muted-foreground">No open orders.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-xs">
              <thead className="text-muted-foreground tracking-widest uppercase text-[10px] border-b">
                <tr>
                  <th className="text-left px-4 py-2">Symbol</th>
                  <th className="text-left px-4 py-2">Side</th>
                  <th className="text-left px-4 py-2">Type</th>
                  <th className="text-right px-4 py-2">Price</th>
                  <th className="text-right px-4 py-2">Qty</th>
                  <th className="text-right px-4 py-2">Filled</th>
                  <th className="text-left px-4 py-2">Status</th>
                  <th className="text-right px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.orderId} className="border-b last:border-0 hover:bg-background/40">
                    <td className="px-4 py-3 text-foreground font-semibold">{o.symbol}</td>
                    <td className="px-4 py-3"><span className={o.side === "BUY" ? "text-primary" : "text-destructive"}>{o.side}</span></td>
                    <td className="px-4 py-3 text-muted-foreground">{o.type}</td>
                    <td className="px-4 py-3 text-right text-muted-foreground">{num(o.price).toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                    <td className="px-4 py-3 text-right text-muted-foreground">{num(o.origQty)}</td>
                    <td className="px-4 py-3 text-right text-muted-foreground">{num(o.executedQty)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{o.status}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => cancelOrder(o.orderId, o.symbol)}
                        disabled={cancelling === o.orderId}
                        className="text-[10px] tracking-widest uppercase text-muted-foreground hover:text-destructive disabled:opacity-50"
                        data-testid={`button-cancel-${o.orderId}`}
                      >
                        {cancelling === o.orderId ? "…" : "cancel"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function HlPane({ session, hlAcct, onTrade, onRefetch }: { session: any; hlAcct: any; onTrade: () => void; onRefetch: () => void }) {
  const [positions, setPositions] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [fills, setFills] = useState<any[]>([]);
  const [closing, setClosing] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = async () => {
    if (!session.ready) return;
    try {
      const [p, o, f] = await Promise.allSettled([
        session.apiFetch<any>("/api/hl/positions"),
        session.apiFetch<any>("/api/hl/open-orders"),
        session.apiFetch<any>("/api/hl/fills"),
      ]);
      if (p.status === "fulfilled") setPositions(Array.isArray(p.value) ? p.value : []);
      if (o.status === "fulfilled") setOrders(Array.isArray(o.value) ? o.value : []);
      if (f.status === "fulfilled") setFills(Array.isArray(f.value) ? f.value.slice(0, 25) : []);
    } catch {}
  };
  useEffect(() => {
    load();
    const id = setInterval(load, 12000);
    return () => clearInterval(id);
  }, [session.ready]);

  const closePos = async (coin: string, szi: number) => {
    setClosing(coin);
    setMsg(null);
    try {
      const isBuy = szi < 0;
      const sz = Math.abs(szi);
      await session.apiFetch("/api/hl/market-order", {
        method: "POST",
        body: JSON.stringify({ coin, isBuy, sz, slippage: 0.01 }),
      });
      setMsg({ kind: "ok", text: `Closed ${coin} (${sz})` });
      onRefetch();
      load();
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message || "Close failed" });
    } finally {
      setClosing(null);
    }
  };
  const cancelOrder = async (oid: number, coin: string) => {
    setCancelling(oid);
    setMsg(null);
    try {
      await session.apiFetch("/api/hl/cancel-order", { method: "POST", body: JSON.stringify({ oid, coin }) });
      setMsg({ kind: "ok", text: `Cancelled ${oid}` });
      load();
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message || "Cancel failed" });
    } finally {
      setCancelling(null);
    }
  };

  if (!session.ready) {
    return (
      <div>
        <VenueHeader title="Hyperliquid" sub="L1 perps via agent wallet. Sub-second fills, on-chain orderbook." accent="border-cyan-400/40 text-cyan-400" />
        <div className="rounded-md border bg-card/60 p-12 text-center font-mono text-sm text-muted-foreground">
          Connect wallet to see your Hyperliquid positions.
        </div>
      </div>
    );
  }

  const linked = hlAcct?.linked !== false;
  const accountValue = num(hlAcct?.accountValue ?? hlAcct?.equity ?? hlAcct?.marginSummary?.accountValue);
  const totalNtl = num(hlAcct?.marginSummary?.totalNtlPos);
  const totalRaw = num(hlAcct?.marginSummary?.totalRawUsd);
  const totalUpnl = positions.reduce((s, p) => s + num(p?.position?.unrealizedPnl), 0);

  return (
    <div>
      <VenueHeader title="Hyperliquid" sub="L1 perps via agent wallet. Sub-second fills, on-chain orderbook." accent="border-cyan-400/40 text-cyan-400" />
      {!linked && (
        <div className="mb-4 px-3 py-2 rounded bg-yellow-500/10 text-yellow-500 border border-yellow-500/30 font-mono text-[11px]">
          Hyperliquid not linked yet. Open the bot and run /hyperliquid to provision an agent wallet, then return here.
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="Account Value" value={fmtUsd(accountValue)} sub="USDC" />
        <StatCard label="Unrealized PnL" value={`${totalUpnl >= 0 ? "+" : ""}${fmtUsd(totalUpnl)}`} accent={totalUpnl >= 0 ? "text-primary" : "text-destructive"} />
        <StatCard label="Open Positions" value={String(positions.length)} sub={totalNtl ? `${fmtUsd(totalNtl)} notional` : undefined} />
        <StatCard label="Margin Used" value={fmtUsd(num(hlAcct?.marginSummary?.totalMarginUsed))} sub={totalRaw ? `${fmtUsd(totalRaw)} raw` : undefined} />
      </div>
      {msg && (
        <div className={`mb-3 px-3 py-2 rounded font-mono text-[11px] ${msg.kind === "ok" ? "bg-primary/10 text-primary border border-primary/30" : "bg-destructive/10 text-destructive border border-destructive/30"}`}>
          {msg.text}
        </div>
      )}
      <div className="rounded-md border bg-card/60 overflow-hidden mb-6">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="font-mono text-sm tracking-widest uppercase text-muted-foreground">Positions · {positions.length}</h3>
          <div className="flex items-center gap-2">
            <button onClick={() => { load(); onRefetch(); }} className="text-muted-foreground hover:text-foreground" data-testid="button-hl-refresh"><RefreshCw className="w-3.5 h-3.5" /></button>
            <Button size="sm" onClick={onTrade} className="font-mono text-[10px] tracking-widest uppercase h-7" data-testid="button-new-trade-hl">
              <Plus className="w-3 h-3 mr-1" /> New Trade
            </Button>
          </div>
        </div>
        {positions.length === 0 ? (
          <EmptyPositions onTrade={onTrade} label="No open Hyperliquid positions." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-xs">
              <thead className="text-muted-foreground tracking-widest uppercase text-[10px] border-b">
                <tr>
                  <th className="text-left px-4 py-2">Coin</th>
                  <th className="text-left px-4 py-2">Side</th>
                  <th className="text-right px-4 py-2">Size</th>
                  <th className="text-right px-4 py-2">Entry</th>
                  <th className="text-right px-4 py-2">PnL</th>
                  <th className="text-right px-4 py-2">ROE</th>
                  <th className="text-right px-4 py-2">Lev</th>
                  <th className="text-right px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {positions.map((row: any) => {
                  const p = row?.position || row;
                  const szi = num(p.szi);
                  const side = szi >= 0 ? "LONG" : "SHORT";
                  const entry = num(p.entryPx);
                  const upnl = num(p.unrealizedPnl);
                  const roe = num(p.returnOnEquity) * 100;
                  const lev = p.leverage?.value ?? p.leverage ?? 1;
                  return (
                    <tr key={p.coin} className="border-b last:border-0 hover:bg-background/40" data-testid={`row-hl-${p.coin}`}>
                      <td className="px-4 py-3 text-foreground font-semibold">{p.coin}</td>
                      <td className="px-4 py-3"><span className={side === "LONG" ? "text-primary" : "text-destructive"}>{side}</span></td>
                      <td className="px-4 py-3 text-right text-muted-foreground">{Math.abs(szi).toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                      <td className="px-4 py-3 text-right text-muted-foreground">{entry.toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                      <td className={`px-4 py-3 text-right font-semibold ${upnl >= 0 ? "text-primary" : "text-destructive"}`}>{upnl >= 0 ? "+" : ""}${upnl.toFixed(2)}</td>
                      <td className={`px-4 py-3 text-right ${roe >= 0 ? "text-primary" : "text-destructive"}`}>{roe >= 0 ? "+" : ""}{roe.toFixed(2)}%</td>
                      <td className="px-4 py-3 text-right text-muted-foreground">{lev}x</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => closePos(p.coin, szi)}
                          disabled={closing === p.coin}
                          className="text-[10px] tracking-widest uppercase text-muted-foreground hover:text-destructive disabled:opacity-50"
                          data-testid={`button-close-hl-${p.coin}`}
                        >
                          {closing === p.coin ? "closing…" : "close"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-md border bg-card/60 overflow-hidden">
          <div className="px-4 py-3 border-b font-mono text-sm tracking-widest uppercase text-muted-foreground">Open Orders · {orders.length}</div>
          {orders.length === 0 ? (
            <div className="px-4 py-6 text-center font-mono text-[11px] text-muted-foreground">No open orders.</div>
          ) : (
            <div className="divide-y">
              {orders.slice(0, 8).map((o: any) => (
                <div key={o.oid} className="px-4 py-2 font-mono text-[11px] flex items-center justify-between">
                  <div>
                    <span className="text-foreground font-semibold">{o.coin}</span>
                    <span className={`ml-2 ${o.side === "B" ? "text-primary" : "text-destructive"}`}>{o.side === "B" ? "BUY" : "SELL"}</span>
                    <span className="ml-2 text-muted-foreground">{num(o.sz)} @ {num(o.limitPx).toLocaleString(undefined, { maximumFractionDigits: 6 })}</span>
                  </div>
                  <button
                    onClick={() => cancelOrder(o.oid, o.coin)}
                    disabled={cancelling === o.oid}
                    className="text-[10px] tracking-widest uppercase text-muted-foreground hover:text-destructive disabled:opacity-50"
                  >
                    {cancelling === o.oid ? "…" : "cancel"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="rounded-md border bg-card/60 overflow-hidden">
          <div className="px-4 py-3 border-b font-mono text-sm tracking-widest uppercase text-muted-foreground">Recent Fills</div>
          {fills.length === 0 ? (
            <div className="px-4 py-6 text-center font-mono text-[11px] text-muted-foreground">No fills yet.</div>
          ) : (
            <div className="divide-y max-h-72 overflow-y-auto">
              {fills.slice(0, 12).map((f: any, i: number) => (
                <div key={`${f.oid ?? i}-${f.time ?? i}`} className="px-4 py-2 font-mono text-[11px] flex items-center justify-between">
                  <div>
                    <span className="text-foreground font-semibold">{f.coin}</span>
                    <span className={`ml-2 ${f.side === "B" ? "text-primary" : "text-destructive"}`}>{f.side === "B" ? "BUY" : "SELL"}</span>
                    <span className="ml-2 text-muted-foreground">{num(f.sz)} @ {num(f.px).toLocaleString(undefined, { maximumFractionDigits: 6 })}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {f.closedPnl != null && (
                      <span className={num(f.closedPnl) >= 0 ? "text-primary" : "text-destructive"}>
                        {num(f.closedPnl) >= 0 ? "+" : ""}${num(f.closedPnl).toFixed(2)}
                      </span>
                    )}
                    <span className="text-muted-foreground text-[10px]">{timeAgo(num(f.time))}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function NotConnected({ title, sub, accent, color, icon: Icon }: { title: string; sub: string; accent: string; color: string; icon: any }) {
  return (
    <div>
      <VenueHeader title={title} sub={sub} accent={accent} />
      <div className="rounded-md border bg-card/60 p-10 text-center">
        <Icon className={`w-10 h-10 mx-auto ${color} mb-3 opacity-50`} />
        <div className="font-mono text-sm text-foreground">Connect a wallet to view positions.</div>
      </div>
    </div>
  );
}

function PolymarketPane({ session }: { session: any }) {
  const [wallet, setWallet] = useState<any>(null);
  const [positions, setPositions] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // "setup" | `redeem-${conditionId}`
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [tradeIntent, setTradeIntent] = useState<{ market: any; event: any } | null>(null);

  useEffect(() => {
    if (!session.ready) {
      setWallet(null);
      setPositions([]);
      setEvents([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    Promise.all([
      session.apiFetch("/api/polymarket/wallet").catch((e: any) => ({ ok: false, error: e?.message || "wallet load failed" })),
      session.apiFetch("/api/polymarket/positions").catch((e: any) => ({ ok: false, error: e?.message || "positions load failed" })),
      session.apiFetch("/api/polymarket/events?limit=20").catch((e: any) => ({ ok: false, error: e?.message || "events load failed" })),
    ])
      .then(([w, p, ev]: any[]) => {
        if (cancelled) return;
        const errs: string[] = [];
        if (w?.ok) setWallet(w);
        else errs.push(`wallet: ${w?.error || "unknown"}`);
        if (p?.ok) setPositions(Array.isArray(p.positions) ? p.positions : []);
        else { setPositions([]); errs.push(`positions: ${p?.error || "unknown"}`); }
        // events endpoint returns { ok, events: gamma-array }. Tolerate either array or { events }.
        if (ev?.ok) {
          const raw = Array.isArray(ev.events) ? ev.events : Array.isArray(ev.events?.events) ? ev.events.events : [];
          setEvents(raw);
        } else { setEvents([]); }
        setErr(errs.length ? errs.join(" · ") : null);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [session.ready, reloadTick]);

  const runSetup = async () => {
    setBusy("setup");
    setActionMsg(null);
    try {
      const r: any = await session.apiFetch("/api/polymarket/setup", { method: "POST", body: {} as any });
      if (r?.ok) {
        setActionMsg(r.safeNewlyDeployed ? "Safe deployed gaslessly. Approvals set. You can deposit USDC.e and trade now." : "Polymarket already set up. Ready to trade.");
        setReloadTick((t) => t + 1);
      } else {
        setActionMsg(r?.details || r?.error || "Setup failed");
      }
    } catch (e: any) {
      setActionMsg(e?.message || "Setup failed");
    } finally {
      setBusy(null);
    }
  };

  const runRedeem = async (conditionId: string, isNegRisk: boolean) => {
    setBusy(`redeem-${conditionId}`);
    setActionMsg(null);
    try {
      const r: any = await session.apiFetch("/api/polymarket/redeem", {
        method: "POST",
        body: { conditionId, isNegRisk } as any,
      });
      if (r?.ok) {
        setActionMsg(`Redeemed gaslessly · tx ${String(r.txHash ?? "").slice(0, 10)}…`);
        setReloadTick((t) => t + 1);
      } else {
        setActionMsg(r?.details || r?.error || "Redeem failed");
      }
    } catch (e: any) {
      setActionMsg(e?.message || "Redeem failed");
    } finally {
      setBusy(null);
    }
  };

  if (!session.ready) {
    return <NotConnected title="Polymarket" sub="Gasless prediction markets — Safe-routed, USDC settled on Polygon." accent="border-blue-400/40 text-blue-400" color="text-blue-400" icon={Target} />;
  }

  const open = positions.filter((p) => ["placed", "matched", "filled"].includes(String(p.status)));
  const resolved = positions.filter((p) => String(p.status).startsWith("resolved"));

  return (
    <div>
      <VenueHeader title="Polymarket" sub="Gasless prediction markets — Safe-routed, USDC settled on Polygon." accent="border-blue-400/40 text-blue-400" />
      {err && <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 mb-4 font-mono text-[11px] text-red-400">{err}</div>}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
        <div className="rounded-md border bg-card/60 p-4">
          <div className="font-mono text-[10px] text-muted-foreground uppercase mb-1">Safe (deposit)</div>
          <div className="font-mono text-xs text-foreground break-all" data-testid="text-polymarket-safe">
            {wallet?.safeAddress ? `${wallet.safeAddress.slice(0, 8)}…${wallet.safeAddress.slice(-6)}` : "— not deployed"}
          </div>
          <div className="font-mono text-[10px] text-muted-foreground mt-1">No MATIC needed</div>
        </div>
        <div className="rounded-md border bg-card/60 p-4">
          <div className="font-mono text-[10px] text-muted-foreground uppercase mb-1">USDC.e in Safe</div>
          <div className="font-mono text-lg text-foreground" data-testid="text-polymarket-usdc">
            {wallet?.balances ? fmtUsd(num(wallet.balances.usdc)) : "—"}
          </div>
        </div>
        <div className="rounded-md border bg-card/60 p-4">
          <div className="font-mono text-[10px] text-muted-foreground uppercase mb-1">Status</div>
          <div className="font-mono text-xs text-foreground">
            {wallet?.ready ? <span className="text-emerald-400">✓ ready to trade</span> : wallet?.safeDeployed ? <span className="text-yellow-400">approvals pending</span> : <span className="text-muted-foreground">not set up</span>}
          </div>
          {!wallet?.ready ? (
            <button
              type="button"
              onClick={runSetup}
              disabled={busy === "setup"}
              data-testid="button-polymarket-setup"
              className="mt-2 w-full rounded border border-blue-400/40 bg-blue-400/10 px-2 py-1 font-mono text-[10px] text-blue-400 hover:bg-blue-400/20 disabled:opacity-50"
            >
              {busy === "setup" ? "Setting up…" : wallet?.safeDeployed ? "Approve USDC + CTF (gasless)" : "Set up Safe + approvals (gasless)"}
            </button>
          ) : (
            <div className="font-mono text-[10px] text-muted-foreground mt-1">No MATIC needed — Polymarket relayer pays gas</div>
          )}
        </div>
      </div>
      {actionMsg && (
        <div className="rounded-md border border-blue-400/40 bg-blue-400/10 p-3 mb-4 font-mono text-[11px] text-blue-300" data-testid="text-polymarket-action-msg">
          {actionMsg}
        </div>
      )}
      {/* Trending events — pickable for trading */}
      <div className="rounded-md border bg-card/60 p-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <div className="font-mono text-xs text-foreground">Trending events ({events.length})</div>
          {loading && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
        </div>
        {events.length === 0 ? (
          <div className="font-mono text-[11px] text-muted-foreground py-4 text-center">No live events right now.</div>
        ) : (
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {events.slice(0, 12).map((ev: any) => {
              const picked = pickTradablePolyMarket(ev);
              const reason = !wallet?.ready ? "Set up Safe first" : picked.reason;
              const canTrade = !!picked.market && !reason;
              return (
                <div key={ev.id ?? ev.slug} className="flex items-center justify-between border-b border-border/40 pb-2 last:border-b-0 gap-3" data-testid={`row-polymarket-event-${ev.id ?? ev.slug}`}>
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-xs text-foreground truncate">{ev.title || ev.slug || "—"}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {(ev.category || "—")} · vol {fmtUsd(num(ev.volume24hr ?? ev.volume))} · ends {ev.endDate ? new Date(ev.endDate).toLocaleDateString() : "—"}
                      {reason && <span className="text-yellow-400/80"> · {reason}</span>}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => { if (!picked.market) return; setActionMsg(null); setTradeIntent({ market: picked.market, event: ev }); }}
                    disabled={!canTrade}
                    title={canTrade ? "Buy YES/NO" : (reason ?? "Not tradable")}
                    data-testid={`button-polymarket-trade-${ev.id ?? ev.slug}`}
                    className="rounded border border-blue-400/40 bg-blue-400/10 px-2 py-1 font-mono text-[10px] text-blue-400 hover:bg-blue-400/20 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Trade
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="rounded-md border bg-card/60 p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="font-mono text-xs text-foreground">Positions ({open.length} open · {resolved.length} resolved)</div>
          {loading && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
        </div>
        {positions.length === 0 ? (
          <div className="font-mono text-[11px] text-muted-foreground py-6 text-center">
            No Polymarket positions yet. {wallet?.ready ? "Pick a trending event above to buy YES/NO." : "Set up your Safe above to start trading."}
          </div>
        ) : (
          <div className="space-y-2">
            {positions.slice(0, 20).map((p) => {
              const status = String(p.status || "");
              const isResolvedWin = status === "resolved_win";
              const isRedeemBusy = busy === `redeem-${p.conditionId}`;
              return (
                <div key={p.id} className="flex items-center justify-between border-b border-border/40 pb-2 last:border-b-0 gap-3" data-testid={`row-polymarket-${p.id}`}>
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-xs text-foreground truncate">{p.marketTitle || p.marketSlug || p.conditionId?.slice(0, 12)}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">{p.outcome || "—"} · {p.status} · {p.size ? `${num(p.size).toFixed(2)} sh` : "—"}</div>
                  </div>
                  <div className="font-mono text-xs text-right tabular-nums">
                    {p.fillPrice ? `@ $${num(p.fillPrice).toFixed(3)}` : p.price ? `@ $${num(p.price).toFixed(3)}` : "—"}
                  </div>
                  {isResolvedWin && (
                    <button
                      type="button"
                      onClick={() => runRedeem(p.conditionId, false)}
                      disabled={isRedeemBusy}
                      data-testid={`button-polymarket-redeem-${p.id}`}
                      className="rounded border border-emerald-400/40 bg-emerald-400/10 px-2 py-1 font-mono text-[10px] text-emerald-400 hover:bg-emerald-400/20 disabled:opacity-50"
                    >
                      {isRedeemBusy ? "Redeeming…" : "Redeem"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {tradeIntent && (
        <PolymarketTradeModal
          session={session}
          market={tradeIntent.market}
          event={tradeIntent.event}
          onClose={() => setTradeIntent(null)}
          onTraded={(msg) => { setActionMsg(msg); setTradeIntent(null); setReloadTick((t) => t + 1); }}
        />
      )}
    </div>
  );
}

function FourmemePane({ session }: { session: any }) {
  const [positions, setPositions] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // `sell-${id}`
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [buyOpen, setBuyOpen] = useState(false);

  useEffect(() => {
    if (!session.ready) { setPositions([]); return; }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    session.apiFetch("/api/fourmeme/positions")
      .then((j: any) => { if (!cancelled) setPositions(Array.isArray(j?.positions) ? j.positions : []); })
      .catch((e: any) => { if (!cancelled) setErr(e?.message || "Failed to load"); })
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [session.ready, reloadTick]);

  const sellAll = async (p: any) => {
    if (!p?.tokenAddress) return;
    // Naive size: bot tracks BNB only, not token balance. We sell the
    // wallet's full balance via the bot service which queries the chain
    // for the actual ERC20 balance and sells everything. Pass a token
    // amount large enough to be capped by the on-chain balance — the
    // service quotes against actual holdings, not what we send.
    // Safer: fetch wallet-balance first.
    setBusy(`sell-${p.id}`);
    setActionMsg(null);
    try {
      // Bot/bridge response shape: { ok, address, tokenBalance: string,
      // tokenWei, tokenDecimals, bnbBalance, bnbWei, error }. We need
      // `tokenBalance` (already decimal-formatted) — the bot's
      // sellTokenForBnb expects a decimal string in `tokenAmount`.
      const bal: any = await session.apiFetch(`/api/fourmeme/wallet-balance/${p.tokenAddress}`);
      const tokenAmount = bal?.tokenBalance ?? "0";
      if (!Number.isFinite(Number(tokenAmount)) || Number(tokenAmount) <= 0) {
        setActionMsg(bal?.error ? `No balance to sell (${bal.error})` : "No on-chain balance left to sell.");
        return;
      }
      const r: any = await session.apiFetch("/api/fourmeme/sell", {
        method: "POST",
        body: { tokenAddress: p.tokenAddress, tokenAmount } as any,
      });
      if (r?.ok) {
        setActionMsg(`Sold ${tokenAmount} ${p.tokenSymbol || ""} · tx ${String(r.txHash ?? "").slice(0, 10)}…`);
        setReloadTick((t) => t + 1);
      } else {
        setActionMsg(r?.error || "Sell failed");
      }
    } catch (e: any) {
      setActionMsg(e?.message || "Sell failed");
    } finally {
      setBusy(null);
    }
  };

  if (!session.ready) {
    return <NotConnected title="fourmeme" sub="Autonomous token launchpad on BSC. Agents launch, buy, and rotate." accent="border-emerald-400/40 text-emerald-400" color="text-emerald-400" icon={Rocket} />;
  }

  return (
    <div>
      <VenueHeader title="fourmeme" sub="Autonomous token launchpad on BSC. Agents launch, buy, and rotate." accent="border-emerald-400/40 text-emerald-400" />
      {err && <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 mb-4 font-mono text-[11px] text-red-400">{err}</div>}
      {actionMsg && (
        <div className="rounded-md border border-emerald-400/40 bg-emerald-400/10 p-3 mb-4 font-mono text-[11px] text-emerald-300" data-testid="text-fourmeme-action-msg">
          {actionMsg}
        </div>
      )}
      <div className="rounded-md border bg-card/60 p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="font-mono text-xs text-foreground">Holdings + Launches ({positions.length})</div>
          <div className="flex items-center gap-2">
            {loading && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
            <button
              type="button"
              onClick={() => { setActionMsg(null); setBuyOpen(true); }}
              data-testid="button-fourmeme-buy-open"
              className="rounded border border-emerald-400/40 bg-emerald-400/10 px-2 py-1 font-mono text-[10px] text-emerald-400 hover:bg-emerald-400/20"
            >
              Buy token
            </button>
          </div>
        </div>
        {positions.length === 0 ? (
          <div className="font-mono text-[11px] text-muted-foreground py-6 text-center">No tokens held. Click "Buy token" above or launch one from the Telegram bot.</div>
        ) : (
          <div className="space-y-2">
            {positions.slice(0, 30).map((p) => {
              const pnl = p.bnbOut - p.bnbIn;
              const canSell = !!p.tokenAddress && !p.sold && p.status !== "sold";
              const isSelling = busy === `sell-${p.id}`;
              return (
                <div key={p.id} className="flex items-center justify-between border-b border-border/40 pb-2 last:border-b-0 gap-3" data-testid={`row-fourmeme-${p.id}`}>
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    {p.imageUrl && <img src={p.imageUrl} alt="" className="w-8 h-8 rounded object-cover flex-shrink-0" />}
                    <div className="min-w-0">
                      <div className="font-mono text-xs text-foreground truncate">{p.tokenName || p.tokenSymbol || "—"} {p.tokenSymbol && p.tokenName && <span className="text-muted-foreground">({p.tokenSymbol})</span>}</div>
                      <div className="font-mono text-[10px] text-muted-foreground">{p.kind === "launch" ? "Launched" : "Bought"} · {p.status} · {p.tokenAddress?.slice(0, 8)}…</div>
                    </div>
                  </div>
                  <div className="font-mono text-xs text-right tabular-nums">
                    <div className="text-foreground">{num(p.bnbIn).toFixed(4)} BNB in</div>
                    {p.sold && <div className={pnl >= 0 ? "text-emerald-400" : "text-red-400"}>{pnl >= 0 ? "+" : ""}{pnl.toFixed(4)} BNB</div>}
                  </div>
                  {canSell && (
                    <button
                      type="button"
                      onClick={() => sellAll(p)}
                      disabled={isSelling}
                      data-testid={`button-fourmeme-sell-${p.id}`}
                      className="rounded border border-red-400/40 bg-red-400/10 px-2 py-1 font-mono text-[10px] text-red-400 hover:bg-red-400/20 disabled:opacity-50"
                    >
                      {isSelling ? "Selling…" : "Sell all"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {buyOpen && (
        <FourmemeBuyModal
          session={session}
          onClose={() => setBuyOpen(false)}
          onTraded={(msg) => { setActionMsg(msg); setBuyOpen(false); setReloadTick((t) => t + 1); }}
        />
      )}
    </div>
  );
}

function FortyTwoPane({ session }: { session: any }) {
  const [positions, setPositions] = useState<any[]>([]);
  const [markets, setMarkets] = useState<any[]>([]);
  const [liveEnabled, setLiveEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [tradeModal, setTradeModal] = useState<{ marketAddress: string; marketTitle: string } | null>(null);

  useEffect(() => {
    if (!session.ready) {
      setPositions([]); setMarkets([]); setLiveEnabled(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    Promise.all([
      session.apiFetch("/api/fortytwo/positions").catch((e: any) => ({ ok: false, error: e?.message || "positions load failed" })),
      session.apiFetch("/api/fortytwo/markets").catch((e: any) => ({ ok: false, error: e?.message || "markets load failed" })),
      session.apiFetch("/api/fortytwo/live-status").catch((e: any) => ({ ok: false, error: e?.message || "status load failed" })),
    ])
      .then(([p, m, s]: any[]) => {
        if (cancelled) return;
        const errs: string[] = [];
        if (p?.ok) setPositions(Array.isArray(p.positions) ? p.positions : []);
        else { setPositions([]); errs.push(`positions: ${p?.error || "unknown"}`); }
        if (m?.ok) setMarkets(Array.isArray(m.markets) ? m.markets : []);
        else { setMarkets([]); errs.push(`markets: ${m?.error || "unknown"}`); }
        if (s?.ok) setLiveEnabled(!!s.enabled);
        else errs.push(`live-status: ${s?.error || "unknown"}`);
        setErr(errs.length ? errs.join(" · ") : null);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [session.ready, reloadTick]);

  const toggleLive = async () => {
    if (liveEnabled === null) return;
    setBusy("live-toggle");
    setActionMsg(null);
    try {
      const r: any = await session.apiFetch("/api/fortytwo/live-status", {
        method: "POST",
        body: { enabled: !liveEnabled } as any,
      });
      if (r?.ok) {
        setLiveEnabled(!!r.enabled);
        setActionMsg(r.enabled
          ? "Live trading ENABLED — manual trades + autonomous agents can now place real on-chain orders."
          : "Live trading DISABLED — new manual + agent trades are blocked. You can still close existing positions.");
      } else {
        setActionMsg(r?.error || "Toggle failed");
      }
    } catch (e: any) {
      setActionMsg(e?.message || "Toggle failed");
    } finally {
      setBusy(null);
    }
  };

  const runSell = async (positionId: string) => {
    setBusy(`sell-${positionId}`);
    setActionMsg(null);
    try {
      const r: any = await session.apiFetch("/api/fortytwo/sell", { method: "POST", body: { positionId } as any });
      if (r?.ok) {
        const pnl = num(r.pnl);
        setActionMsg(`Position closed · PnL ${pnl >= 0 ? "+" : ""}${fmtUsd(pnl)}${r.txHash ? ` · tx ${String(r.txHash).slice(0, 10)}…` : ""}`);
        setReloadTick((t) => t + 1);
      } else {
        setActionMsg(r?.reason || r?.error || "Sell failed");
      }
    } catch (e: any) {
      setActionMsg(e?.message || "Sell failed");
    } finally {
      setBusy(null);
    }
  };

  const runClaim = async (positionId: string) => {
    setBusy(`claim-${positionId}`);
    setActionMsg(null);
    try {
      const r: any = await session.apiFetch("/api/fortytwo/claim", { method: "POST", body: { positionId } as any });
      if (r?.ok) {
        setActionMsg(`Claimed ${r.claimedPositions ?? 1} position(s) · payout ${fmtUsd(num(r.payoutUsdt))}${r.txHash ? ` · tx ${String(r.txHash).slice(0, 10)}…` : ""}`);
        setReloadTick((t) => t + 1);
      } else {
        setActionMsg(r?.reason || r?.error || "Claim failed");
      }
    } catch (e: any) {
      setActionMsg(e?.message || "Claim failed");
    } finally {
      setBusy(null);
    }
  };

  const runClaimAll = async () => {
    setBusy("claim-all");
    setActionMsg(null);
    try {
      const r: any = await session.apiFetch("/api/fortytwo/claim-all", { method: "POST", body: {} as any });
      if (r && (r.ok || r.claimedPositions != null)) {
        setActionMsg(`Swept ${r.claimedPositions ?? 0} winning position(s) · total ${fmtUsd(num(r.payoutUsdt ?? 0))}${Array.isArray(r.errors) && r.errors.length ? ` · ${r.errors.length} partial errors` : ""}`);
        setReloadTick((t) => t + 1);
      } else {
        setActionMsg(r?.reason || r?.error || "Claim all failed");
      }
    } catch (e: any) {
      setActionMsg(e?.message || "Claim all failed");
    } finally {
      setBusy(null);
    }
  };

  if (!session.ready) {
    return <NotConnected title="42.space" sub="On-chain prediction markets on BSC. BTC 8h price campaigns + Campaign mode." accent="border-orange-400/40 text-orange-400" color="text-orange-400" icon={Target} />;
  }

  const open = positions.filter((p) => p.status === "open");
  const closed = positions.filter((p) => p.status !== "open" && p.status !== "resolved_win");
  const claimable = positions.filter((p) => p.status === "resolved_win");
  const totalPnl = closed.reduce((acc, p) => acc + num(p.pnl), 0);

  return (
    <div>
      <VenueHeader title="42.space" sub="On-chain prediction markets on BSC. BTC 8h price campaigns + Campaign mode." accent="border-orange-400/40 text-orange-400" />
      {err && <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 mb-4 font-mono text-[11px] text-red-400">{err}</div>}

      {/* Live-trade toggle banner */}
      <div className="rounded-md border bg-card/60 p-4 mb-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[10px] text-muted-foreground uppercase mb-1">Live trading</div>
          <div className="font-mono text-xs text-foreground">
            {liveEnabled === null
              ? <span className="text-muted-foreground">loading…</span>
              : liveEnabled
                ? <span className="text-emerald-400">✓ ENABLED — manual trades + autonomous agents can place real BSC orders</span>
                : <span className="text-yellow-400">○ DISABLED — paper-only; new live trades blocked (closing always allowed)</span>}
          </div>
        </div>
        <button
          type="button"
          onClick={toggleLive}
          disabled={busy === "live-toggle" || liveEnabled === null}
          data-testid="button-fortytwo-live-toggle"
          className={`rounded border px-3 py-1.5 font-mono text-[10px] disabled:opacity-50 ${
            liveEnabled
              ? "border-yellow-400/40 bg-yellow-400/10 text-yellow-400 hover:bg-yellow-400/20"
              : "border-emerald-400/40 bg-emerald-400/10 text-emerald-400 hover:bg-emerald-400/20"
          }`}
        >
          {busy === "live-toggle" ? "…" : liveEnabled ? "Disable live" : "Enable live"}
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <div className="rounded-md border bg-card/60 p-4">
          <div className="font-mono text-[10px] text-muted-foreground uppercase mb-1">Open</div>
          <div className="font-mono text-lg text-foreground" data-testid="text-fortytwo-open">{open.length}</div>
        </div>
        <div className="rounded-md border bg-card/60 p-4">
          <div className="font-mono text-[10px] text-muted-foreground uppercase mb-1">Claimable</div>
          <div className="font-mono text-lg text-foreground" data-testid="text-fortytwo-claimable">{claimable.length}</div>
        </div>
        <div className="rounded-md border bg-card/60 p-4">
          <div className="font-mono text-[10px] text-muted-foreground uppercase mb-1">Closed</div>
          <div className="font-mono text-lg text-foreground" data-testid="text-fortytwo-closed">{closed.length}</div>
        </div>
        <div className="rounded-md border bg-card/60 p-4">
          <div className="font-mono text-[10px] text-muted-foreground uppercase mb-1">Realised PnL</div>
          <div className={`font-mono text-lg tabular-nums ${totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`} data-testid="text-fortytwo-pnl">
            {totalPnl >= 0 ? "+" : ""}{fmtUsd(totalPnl)}
          </div>
        </div>
      </div>

      {actionMsg && (
        <div className="rounded-md border border-orange-400/40 bg-orange-400/10 p-3 mb-4 font-mono text-[11px] text-orange-300" data-testid="text-fortytwo-action-msg">
          {actionMsg}
        </div>
      )}

      {/* Markets — pickable for trading */}
      <div className="rounded-md border bg-card/60 p-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <div className="font-mono text-xs text-foreground">Live markets ({markets.length})</div>
          {loading && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
        </div>
        {markets.length === 0 ? (
          <div className="font-mono text-[11px] text-muted-foreground py-4 text-center">No live markets right now.</div>
        ) : (
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {markets.slice(0, 15).map((m) => (
              <div key={m.marketAddress} className="flex items-center justify-between border-b border-border/40 pb-2 last:border-b-0 gap-3" data-testid={`row-fortytwo-market-${m.marketAddress}`}>
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-xs text-foreground truncate">{m.marketTitle}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">
                    {m.category} · vol {fmtUsd(num(m.volume))} · {num(m.traders)} traders
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => { setActionMsg(null); setTradeModal({ marketAddress: m.marketAddress, marketTitle: m.marketTitle }); }}
                  data-testid={`button-fortytwo-trade-${m.marketAddress}`}
                  className="rounded border border-orange-400/40 bg-orange-400/10 px-2 py-1 font-mono text-[10px] text-orange-400 hover:bg-orange-400/20"
                >
                  Trade
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Positions */}
      <div className="rounded-md border bg-card/60 p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="font-mono text-xs text-foreground">Positions ({positions.length})</div>
          {claimable.length > 0 && (
            <button
              type="button"
              onClick={runClaimAll}
              disabled={busy === "claim-all"}
              data-testid="button-fortytwo-claim-all"
              className="rounded border border-emerald-400/40 bg-emerald-400/10 px-2 py-1 font-mono text-[10px] text-emerald-400 hover:bg-emerald-400/20 disabled:opacity-50"
            >
              {busy === "claim-all" ? "Sweeping…" : `Claim all (${claimable.length})`}
            </button>
          )}
        </div>
        {positions.length === 0 ? (
          <div className="font-mono text-[11px] text-muted-foreground py-6 text-center">No 42.space positions yet. Pick a market above to trade.</div>
        ) : (
          <div className="space-y-2">
            {positions.slice(0, 30).map((p) => {
              const isOpen = p.status === "open";
              const isWin = p.status === "resolved_win";
              const sellBusy = busy === `sell-${p.id}`;
              const claimBusy = busy === `claim-${p.id}`;
              return (
                <div key={p.id} className="flex items-center justify-between border-b border-border/40 pb-2 last:border-b-0 gap-3" data-testid={`row-fortytwo-${p.id}`}>
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-xs text-foreground truncate">{p.marketTitle || p.marketAddress?.slice(0, 10)}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {p.outcomeLabel} · {p.status}{p.paperTrade && <span className="text-yellow-400"> · PAPER</span>}{p.agentId && <span className="text-blue-400"> · agent</span>}
                    </div>
                  </div>
                  <div className="font-mono text-xs text-right tabular-nums">
                    <div className="text-foreground">{fmtUsd(num(p.usdtIn))}</div>
                    {p.pnl != null && <div className={num(p.pnl) >= 0 ? "text-emerald-400" : "text-red-400"}>{num(p.pnl) >= 0 ? "+" : ""}{fmtUsd(num(p.pnl))}</div>}
                  </div>
                  {isOpen && (
                    <button
                      type="button"
                      onClick={() => runSell(p.id)}
                      disabled={sellBusy}
                      data-testid={`button-fortytwo-sell-${p.id}`}
                      className="rounded border border-red-400/40 bg-red-400/10 px-2 py-1 font-mono text-[10px] text-red-400 hover:bg-red-400/20 disabled:opacity-50"
                    >
                      {sellBusy ? "Selling…" : "Sell"}
                    </button>
                  )}
                  {isWin && (
                    <button
                      type="button"
                      onClick={() => runClaim(p.id)}
                      disabled={claimBusy}
                      data-testid={`button-fortytwo-claim-${p.id}`}
                      className="rounded border border-emerald-400/40 bg-emerald-400/10 px-2 py-1 font-mono text-[10px] text-emerald-400 hover:bg-emerald-400/20 disabled:opacity-50"
                    >
                      {claimBusy ? "Claiming…" : "Claim"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {tradeModal && (
        <FortyTwoTradeModal
          session={session}
          marketAddress={tradeModal.marketAddress}
          marketTitle={tradeModal.marketTitle}
          onClose={() => setTradeModal(null)}
          onTraded={(msg) => { setActionMsg(msg); setTradeModal(null); setReloadTick((t) => t + 1); }}
        />
      )}
    </div>
  );
}

function FortyTwoTradeModal({
  session, marketAddress, marketTitle, onClose, onTraded,
}: {
  session: any; marketAddress: string; marketTitle: string;
  onClose: () => void; onTraded: (msg: string) => void;
}) {
  const [outcomes, setOutcomes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [tokenId, setTokenId] = useState<number | null>(null);
  const [amount, setAmount] = useState<string>("2");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    session.apiFetch(`/api/fortytwo/market/${marketAddress}`)
      .then((r: any) => {
        if (cancelled) return;
        if (r?.ok && r.market) {
          const outs = Array.isArray(r.market.outcomes) ? r.market.outcomes : [];
          setOutcomes(outs);
          if (outs.length > 0) setTokenId(outs[0].tokenId);
        } else {
          setErr(r?.error || "Failed to load outcomes");
        }
      })
      .catch((e: any) => !cancelled && setErr(e?.message || "Failed to load outcomes"))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [marketAddress]);

  const submit = async () => {
    if (tokenId === null) return;
    const usdtAmount = Number(amount);
    if (!Number.isFinite(usdtAmount) || usdtAmount <= 0) {
      setErr("Enter a valid USDT amount");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r: any = await session.apiFetch("/api/fortytwo/buy", {
        method: "POST",
        body: { marketAddress, tokenId, usdtAmount } as any,
      });
      if (r?.ok) {
        onTraded(`Buy filled${r.txHash ? ` · tx ${String(r.txHash).slice(0, 10)}…` : ""}`);
      } else {
        setErr(r?.reason || r?.error || "Buy failed");
      }
    } catch (e: any) {
      setErr(e?.message || "Buy failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg border border-orange-400/40 bg-card p-5" onClick={(e) => e.stopPropagation()} data-testid="modal-fortytwo-trade">
        <div className="flex items-center justify-between mb-3">
          <div className="font-mono text-sm text-foreground">Buy outcome</div>
          <button type="button" onClick={onClose} className="font-mono text-xs text-muted-foreground hover:text-foreground" data-testid="button-fortytwo-trade-close">✕</button>
        </div>
        <div className="font-mono text-[11px] text-muted-foreground mb-4 break-words">{marketTitle}</div>

        {loading ? (
          <div className="py-6 text-center"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground inline" /></div>
        ) : (
          <>
            <div className="font-mono text-[10px] text-muted-foreground uppercase mb-2">Outcome</div>
            <div className="grid grid-cols-2 gap-2 mb-4">
              {outcomes.map((o) => {
                const selected = tokenId === o.tokenId;
                return (
                  <button
                    key={o.tokenId}
                    type="button"
                    onClick={() => setTokenId(o.tokenId)}
                    data-testid={`button-fortytwo-outcome-${o.tokenId}`}
                    className={`rounded border px-3 py-2 font-mono text-xs ${
                      selected
                        ? "border-orange-400 bg-orange-400/20 text-orange-300"
                        : "border-border bg-card/60 text-foreground hover:border-orange-400/40"
                    }`}
                  >
                    <div>{o.label}</div>
                    <div className="text-[10px] text-muted-foreground mt-1">@ {(num(o.impliedProbability) * 100).toFixed(1)}%</div>
                  </button>
                );
              })}
            </div>

            <div className="font-mono text-[10px] text-muted-foreground uppercase mb-2">USDT amount</div>
            <input
              type="number"
              min="0"
              step="0.1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              data-testid="input-fortytwo-amount"
              className="w-full rounded border border-border bg-background px-3 py-2 font-mono text-sm text-foreground mb-4"
            />

            {err && <div className="rounded border border-red-500/40 bg-red-500/10 p-2 mb-3 font-mono text-[11px] text-red-400">{err}</div>}

            <button
              type="button"
              onClick={submit}
              disabled={busy || tokenId === null}
              data-testid="button-fortytwo-trade-submit"
              className="w-full rounded border border-orange-400/40 bg-orange-400/10 px-3 py-2 font-mono text-xs text-orange-400 hover:bg-orange-400/20 disabled:opacity-50"
            >
              {busy ? "Submitting…" : "Buy outcome"}
            </button>
            <div className="font-mono text-[10px] text-muted-foreground mt-2 text-center">
              Live trading must be enabled. Min/max + daily caps apply per the executor.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface PolymarketBookLevel { price: number; size: number }
interface PolymarketBook {
  tokenId: string;
  bids: PolymarketBookLevel[];
  asks: PolymarketBookLevel[];
  midPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
}

function PolymarketTradeModal({
  session, market, event, onClose, onTraded,
}: {
  session: any; market: any; event: any;
  onClose: () => void; onTraded: (msg: string) => void;
}) {
  const clobTokenIds: string[] = Array.isArray(market?.clobTokenIds)
    ? market.clobTokenIds
    : (() => { try { return JSON.parse(market?.clobTokenIds ?? "[]"); } catch { return []; } })();
  const outcomes: string[] = Array.isArray(market?.outcomes)
    ? market.outcomes
    : (() => { try { return JSON.parse(market?.outcomes ?? "[]"); } catch { return []; } })();
  const outcomePrices: string[] = Array.isArray(market?.outcomePrices)
    ? market.outcomePrices
    : (() => { try { return JSON.parse(market?.outcomePrices ?? "[]"); } catch { return []; } })();

  const yesLabel = outcomes[0] ?? "YES";
  const noLabel = outcomes[1] ?? "NO";
  const yesPriceStatic = num(outcomePrices[0]);
  const noPriceStatic = num(outcomePrices[1]);

  const [outcomeIdx, setOutcomeIdx] = useState<0 | 1>(0);
  const [amount, setAmount] = useState<string>("5");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [book, setBook] = useState<PolymarketBook | null>(null);
  const [bookErr, setBookErr] = useState<string | null>(null);
  const [bookStale, setBookStale] = useState(false);

  const activeTokenId = clobTokenIds[outcomeIdx];

  useEffect(() => {
    if (!activeTokenId) return;
    let cancelled = false;
    setBook(null);
    setBookErr(null);
    setBookStale(false);
    const tick = async () => {
      try {
        const r: any = await session.apiFetch(`/api/polymarket/orderbook/${activeTokenId}`);
        if (cancelled) return;
        if (r?.book) {
          setBook(r.book as PolymarketBook);
          setBookStale(!!r.stale);
          setBookErr(null);
        } else if (r?.error) {
          setBookErr(String(r.error));
        }
      } catch (e: any) {
        if (cancelled) return;
        setBookErr(e?.message || "orderbook unavailable");
      }
    };
    tick();
    const id = setInterval(tick, 1500);
    return () => { cancelled = true; clearInterval(id); };
  }, [activeTokenId, session]);

  const liveAsk = book?.bestAsk ?? null;
  const liveBid = book?.bestBid ?? null;
  const livePriceReady = !!(liveAsk && liveAsk > 0 && liveAsk < 1);
  const livePrice = livePriceReady ? (liveAsk as number) : 0;
  const sizeNum = Number(amount);
  const impliedCost = (Number.isFinite(sizeNum) && sizeNum > 0 && livePriceReady)
    ? sizeNum
    : 0;
  const impliedShares = (Number.isFinite(sizeNum) && sizeNum > 0 && livePriceReady)
    ? sizeNum / livePrice
    : 0;

  const submit = async () => {
    const tokenId = activeTokenId;
    const conditionId = market?.conditionId;
    const outcomeLabel = outcomeIdx === 0 ? yesLabel : noLabel;
    if (!tokenId || !conditionId) { setErr("Market is missing conditionId / tokenId"); return; }
    const sizeUsdc = Number(amount);
    if (!Number.isFinite(sizeUsdc) || sizeUsdc <= 0) { setErr("Enter a valid USDC amount"); return; }
    if (!livePriceReady) { setErr("Live price unavailable — wait for the orderbook to load or try again"); return; }
    const price = livePrice;
    setBusy(true);
    setErr(null);
    try {
      const r: any = await session.apiFetch("/api/polymarket/order", {
        method: "POST",
        body: {
          tokenId,
          side: "BUY",
          sizeUsdc,
          price,
          conditionId,
          marketTitle: event?.title || market?.question || "—",
          outcomeLabel,
        } as any,
      });
      if (r?.ok) {
        onTraded(`Buy ${outcomeLabel} submitted${r.orderID ? ` · ${String(r.orderID).slice(0, 10)}…` : ""}`);
      } else {
        setErr(r?.error || r?.reason || "Order failed");
      }
    } catch (e: any) {
      setErr(e?.message || "Order failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg border border-blue-400/40 bg-card p-5" onClick={(e) => e.stopPropagation()} data-testid="modal-polymarket-trade">
        <div className="flex items-center justify-between mb-3">
          <div className="font-mono text-sm text-foreground">Buy outcome</div>
          <button type="button" onClick={onClose} className="font-mono text-xs text-muted-foreground hover:text-foreground" data-testid="button-polymarket-trade-close">✕</button>
        </div>
        <div className="font-mono text-[11px] text-muted-foreground mb-4 break-words">{event?.title || market?.question || "—"}</div>

        <div className="font-mono text-[10px] text-muted-foreground uppercase mb-2">Outcome</div>
        <div className="grid grid-cols-2 gap-2 mb-3">
          {[0, 1].map((idx) => {
            const label = idx === 0 ? yesLabel : noLabel;
            const staticP = idx === 0 ? yesPriceStatic : noPriceStatic;
            const liveP = (idx === outcomeIdx && livePriceReady) ? livePrice : null;
            const selected = outcomeIdx === idx;
            return (
              <button
                key={idx}
                type="button"
                onClick={() => setOutcomeIdx(idx as 0 | 1)}
                data-testid={`button-polymarket-outcome-${idx}`}
                className={`rounded border px-3 py-2 font-mono text-xs ${
                  selected
                    ? "border-blue-400 bg-blue-400/20 text-blue-300"
                    : "border-border bg-card/60 text-foreground hover:border-blue-400/40"
                }`}
              >
                <div>{label}</div>
                <div className="text-[10px] text-muted-foreground mt-1">
                  {liveP
                    ? `ask ${(liveP * 100).toFixed(1)}¢`
                    : (staticP > 0
                      ? `ref ${(staticP * 100).toFixed(1)}¢`
                      : "—")}
                </div>
              </button>
            );
          })}
        </div>

        <div
          className="rounded border border-border bg-background/60 p-2 mb-4 font-mono text-[10px]"
          data-testid="polymarket-book-panel"
        >
          <div className="flex items-center justify-between mb-1">
            <span className="text-muted-foreground uppercase">
              {outcomeIdx === 0 ? yesLabel : noLabel} book{" "}
              {bookStale && <span className="text-amber-400">(stale)</span>}
            </span>
            <span className="text-muted-foreground">
              {book?.midPrice != null
                ? `mid ${(book.midPrice * 100).toFixed(1)}¢`
                : "mid —"}
              {" · "}
              {liveBid != null && liveAsk != null
                ? `spread ${((liveAsk - liveBid) * 100).toFixed(2)}¢`
                : "spread —"}
            </span>
          </div>
          {bookErr && !book ? (
            <div className="text-red-400">Orderbook unavailable: {bookErr}</div>
          ) : !book ? (
            <div className="text-muted-foreground">Loading book…</div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-green-400 mb-0.5">BIDS</div>
                {book.bids.slice(0, 3).map((l, i) => (
                  <div key={i} className="flex justify-between text-green-400" data-testid={`polymarket-bid-${i}`}>
                    <span>{(l.price * 100).toFixed(1)}¢</span>
                    <span className="text-muted-foreground">{l.size.toFixed(0)}</span>
                  </div>
                ))}
                {book.bids.length === 0 && <div className="text-muted-foreground">—</div>}
              </div>
              <div>
                <div className="text-red-400 mb-0.5">ASKS</div>
                {book.asks.slice(0, 3).map((l, i) => (
                  <div key={i} className="flex justify-between text-red-400" data-testid={`polymarket-ask-${i}`}>
                    <span>{(l.price * 100).toFixed(1)}¢</span>
                    <span className="text-muted-foreground">{l.size.toFixed(0)}</span>
                  </div>
                ))}
                {book.asks.length === 0 && <div className="text-muted-foreground">—</div>}
              </div>
            </div>
          )}
        </div>

        <div className="font-mono text-[10px] text-muted-foreground uppercase mb-2">USDC amount</div>
        <input
          type="number"
          min="0"
          step="0.1"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          data-testid="input-polymarket-amount"
          className="w-full rounded border border-border bg-background px-3 py-2 font-mono text-sm text-foreground mb-2"
        />

        <div className="font-mono text-[10px] text-muted-foreground mb-3 flex justify-between" data-testid="polymarket-implied-cost">
          <span>
            {livePriceReady
              ? `live ask ${(livePrice * 100).toFixed(1)}¢`
              : (book ? "no live ask — book empty" : "waiting for live book…")}
          </span>
          <span>
            {impliedShares > 0
              ? `≈ ${impliedShares.toFixed(2)} shares for ${impliedCost.toFixed(2)} USDC`
              : "—"}
          </span>
        </div>

        {err && <div className="rounded border border-red-500/40 bg-red-500/10 p-2 mb-3 font-mono text-[11px] text-red-400">{err}</div>}

        <button
          type="button"
          onClick={submit}
          disabled={busy || !livePriceReady}
          data-testid="button-polymarket-trade-submit"
          className="w-full rounded border border-blue-400/40 bg-blue-400/10 px-3 py-2 font-mono text-xs text-blue-400 hover:bg-blue-400/20 disabled:opacity-50"
        >
          {busy
            ? "Submitting…"
            : livePriceReady
              ? `Buy ${outcomeIdx === 0 ? yesLabel : noLabel} @ ${(livePrice * 100).toFixed(1)}¢`
              : "Waiting for live price…"}
        </button>
        <div className="font-mono text-[10px] text-muted-foreground mt-2 text-center">
          Order settles to your Polygon Safe. Gas paid by builder relayer — no MATIC needed.
        </div>
      </div>
    </div>
  );
}

function FourmemeBuyModal({
  session, onClose, onTraded,
}: {
  session: any;
  onClose: () => void; onTraded: (msg: string) => void;
}) {
  const [tokenAddress, setTokenAddress] = useState("");
  const [bnbAmount, setBnbAmount] = useState("0.01");
  const [slippageBps, setSlippageBps] = useState("500");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    const addr = tokenAddress.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) { setErr("Enter a valid BSC token address (0x…)"); return; }
    const bnb = Number(bnbAmount);
    if (!Number.isFinite(bnb) || bnb <= 0) { setErr("Enter a valid BNB amount"); return; }
    const slip = Number(slippageBps);
    if (!Number.isFinite(slip) || slip < 0 || slip > 5000) { setErr("Slippage must be 0–5000 bps"); return; }
    setBusy(true);
    setErr(null);
    try {
      const r: any = await session.apiFetch("/api/fourmeme/buy", {
        method: "POST",
        body: { tokenAddress: addr, bnbAmount: bnb, slippageBps: slip } as any,
      });
      if (r?.ok) {
        onTraded(`Buy filled${r.txHash ? ` · tx ${String(r.txHash).slice(0, 10)}…` : ""}`);
      } else {
        setErr(r?.error || r?.reason || "Buy failed");
      }
    } catch (e: any) {
      setErr(e?.message || "Buy failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg border border-emerald-400/40 bg-card p-5" onClick={(e) => e.stopPropagation()} data-testid="modal-fourmeme-buy">
        <div className="flex items-center justify-between mb-3">
          <div className="font-mono text-sm text-foreground">Buy fourmeme token</div>
          <button type="button" onClick={onClose} className="font-mono text-xs text-muted-foreground hover:text-foreground" data-testid="button-fourmeme-buy-close">✕</button>
        </div>

        <div className="font-mono text-[10px] text-muted-foreground uppercase mb-2">Token address (BSC)</div>
        <input
          type="text"
          value={tokenAddress}
          onChange={(e) => setTokenAddress(e.target.value)}
          placeholder="0x…"
          data-testid="input-fourmeme-token"
          className="w-full rounded border border-border bg-background px-3 py-2 font-mono text-xs text-foreground mb-4"
        />

        <div className="font-mono text-[10px] text-muted-foreground uppercase mb-2">BNB amount</div>
        <input
          type="number"
          min="0"
          step="0.001"
          value={bnbAmount}
          onChange={(e) => setBnbAmount(e.target.value)}
          data-testid="input-fourmeme-bnb"
          className="w-full rounded border border-border bg-background px-3 py-2 font-mono text-sm text-foreground mb-4"
        />

        <div className="font-mono text-[10px] text-muted-foreground uppercase mb-2">Slippage (bps, 100 = 1%)</div>
        <input
          type="number"
          min="0"
          max="5000"
          step="50"
          value={slippageBps}
          onChange={(e) => setSlippageBps(e.target.value)}
          data-testid="input-fourmeme-slippage"
          className="w-full rounded border border-border bg-background px-3 py-2 font-mono text-sm text-foreground mb-4"
        />

        {err && <div className="rounded border border-red-500/40 bg-red-500/10 p-2 mb-3 font-mono text-[11px] text-red-400">{err}</div>}

        <button
          type="button"
          onClick={submit}
          disabled={busy}
          data-testid="button-fourmeme-buy-submit"
          className="w-full rounded border border-emerald-400/40 bg-emerald-400/10 px-3 py-2 font-mono text-xs text-emerald-400 hover:bg-emerald-400/20 disabled:opacity-50"
        >
          {busy ? "Submitting…" : "Buy token"}
        </button>
        <div className="font-mono text-[10px] text-muted-foreground mt-2 text-center">
          Trade is funded from your BSC custodial wallet. Routes via the official fourmeme TokenManager.
        </div>
      </div>
    </div>
  );
}

type FeedEntry = {
  id: string;
  t: number;
  venue: "Aster" | "HL" | "Agent" | "Poly" | "4M" | "42";
  color: string;
  action: string;
  asset: string;
  size: string;
  pnl?: number;
};

function BrainFeed({ session, refetchTick }: { session: any; refetchTick: number }) {
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!session.ready) {
      setFeed([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      const merged: FeedEntry[] = [];
      try {
        const [hist, hlFills, agent, polyPos, fmPos, ftPos] = await Promise.allSettled([
          session.apiFetch<any>("/api/miniapp/history"),
          session.apiFetch<any>("/api/hl/fills"),
          session.apiFetch<any>("/api/miniapp/agent"),
          session.apiFetch<any>("/api/polymarket/positions"),
          session.apiFetch<any>("/api/fourmeme/positions"),
          session.apiFetch<any>("/api/fortytwo/positions"),
        ]);
        if (polyPos.status === "fulfilled" && Array.isArray(polyPos.value?.positions)) {
          for (const p of polyPos.value.positions.slice(0, 15)) {
            const closed = p.closedAt && new Date(p.closedAt).getTime();
            const opened = p.openedAt && new Date(p.openedAt).getTime();
            const t = num(closed || opened);
            if (!t) continue;
            const pnl = p.pnl != null ? num(p.pnl) : undefined;
            const isClosed = !!closed;
            merged.push({
              id: `poly-${p.id}-${t}`,
              t,
              venue: "Poly",
              color: "text-blue-400",
              action: isClosed ? `CLOSE ${String(p.outcome ?? "").toUpperCase()}` : `BUY ${String(p.outcome ?? "").toUpperCase()}`,
              asset: String(p.marketTitle ?? p.marketSlug ?? "—").slice(0, 60),
              size: pnl != null ? `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}` : `$${num(p.size).toFixed(2)}`,
              pnl,
            });
          }
        }
        if (fmPos.status === "fulfilled" && Array.isArray(fmPos.value?.positions)) {
          for (const p of fmPos.value.positions.slice(0, 15)) {
            const t = num(p.ts ? new Date(p.ts).getTime() : 0);
            if (!t) continue;
            const pnl = p.sold ? num(p.bnbOut) - num(p.bnbIn) : undefined;
            merged.push({
              id: `fm-${p.id}-${t}`,
              t,
              venue: "4M",
              color: "text-emerald-400",
              action: p.kind === "launch" ? "LAUNCH" : (p.sold ? "SELL" : "BUY"),
              asset: String(p.tokenSymbol ?? p.tokenName ?? "—").slice(0, 24),
              size: pnl != null ? `${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} BNB` : `${num(p.bnbIn).toFixed(4)} BNB`,
              pnl: pnl != null ? pnl * 600 : undefined,
            });
          }
        }
        if (ftPos.status === "fulfilled" && Array.isArray(ftPos.value?.positions)) {
          for (const p of ftPos.value.positions.slice(0, 15)) {
            const closed = p.closedAt && new Date(p.closedAt).getTime();
            const opened = p.openedAt && new Date(p.openedAt).getTime();
            const t = num(closed || opened);
            if (!t) continue;
            const pnl = p.pnl != null ? num(p.pnl) : undefined;
            const status = String(p.status ?? "");
            const action = status === "open" ? "BUY" : status.startsWith("resolved") ? status.toUpperCase().replace("_", " ") : "CLOSE";
            merged.push({
              id: `ft-${p.id}-${t}`,
              t,
              venue: "42",
              color: "text-orange-400",
              action,
              asset: `${p.outcomeLabel ?? ""} · ${String(p.marketTitle ?? "—").slice(0, 40)}`,
              size: pnl != null ? `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}` : `$${num(p.usdtIn).toFixed(2)}`,
              pnl,
            });
          }
        }
        if (hist.status === "fulfilled") {
          const closed = Array.isArray(hist.value?.closedTrades) ? hist.value.closedTrades : [];
          for (const t of closed.slice(0, 20)) {
            const time = num(t.closedAt ?? t.time);
            const pnl = num(t.pnl);
            merged.push({
              id: `aster-${t.symbol}-${time}`,
              t: time,
              venue: "Aster",
              color: "text-yellow-400",
              action: t.side === "BUY" ? "CLOSE LONG" : "CLOSE SHORT",
              asset: t.symbol || "",
              size: `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
              pnl,
            });
          }
        }
        if (hlFills.status === "fulfilled" && Array.isArray(hlFills.value)) {
          for (const f of hlFills.value.slice(0, 25)) {
            const pnl = f.closedPnl != null ? num(f.closedPnl) : undefined;
            const sz = num(f.sz);
            const px = num(f.px);
            merged.push({
              id: `hl-${f.oid ?? Math.random()}-${f.time}`,
              t: num(f.time),
              venue: "HL",
              color: "text-cyan-400",
              action: f.side === "B" ? "BUY" : "SELL",
              asset: f.coin || "",
              size: pnl != null ? `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}` : `${sz} @ ${px.toFixed(4)}`,
              pnl,
            });
          }
        }
        if (agent.status === "fulfilled") {
          const log = Array.isArray(agent.value?.stats?.reasoningLog) ? agent.value.stats.reasoningLog : [];
          for (const r of log) {
            const t = num(r.timestamp ?? r.t ?? Date.now());
            const action = (r.action || r.decision || "DECISION").toString().toUpperCase().slice(0, 20);
            const reason = (r.reason || r.reasoning || r.text || "").toString().slice(0, 60);
            merged.push({
              id: `agent-${t}-${action}`,
              t,
              venue: "Agent",
              color: "text-primary",
              action,
              asset: reason,
              size: r.symbol || "",
            });
          }
        }
      } catch {}
      if (cancelled) return;
      merged.sort((a, b) => b.t - a.t);
      setFeed(merged.slice(0, 30));
      setLoading(false);
    };
    load();
    const id = setInterval(load, 10000);
    return () => { cancelled = true; clearInterval(id); };
  }, [session.ready, session.apiFetch, refetchTick]);

  return (
    <aside className="hidden lg:flex w-72 border-l bg-card/30 flex-col">
      <div className="px-4 py-3 border-b flex items-center gap-2">
        <Brain className="w-3.5 h-3.5 text-primary" />
        <span className="font-mono text-xs tracking-widest uppercase text-muted-foreground">Live Brain</span>
        <div className="flex-1" />
        {loading ? <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" /> : <div className={`w-1.5 h-1.5 rounded-full ${session.ready ? "bg-primary animate-pulse" : "bg-muted-foreground/40"}`} />}
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {!session.ready ? (
          <div className="px-3 py-6 text-center font-mono text-[10px] text-muted-foreground tracking-widest uppercase">
            Connect wallet<br />to stream your feed
          </div>
        ) : feed.length === 0 ? (
          <div className="px-3 py-6 text-center font-mono text-[10px] text-muted-foreground tracking-widest uppercase">
            No activity yet.<br />Place a trade or start an agent.
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {feed.map((e) => (
              <motion.div
                key={e.id}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25 }}
                className="px-2 py-1.5 rounded hover:bg-background/50 font-mono text-[11px]"
                data-testid={`brain-row-${e.id}`}
              >
                <div className="flex items-center gap-1.5 text-[9px] text-muted-foreground tracking-widest uppercase mb-0.5">
                  <span>{timeAgo(e.t)}</span>
                  <span>·</span>
                  <span className={e.color}>{e.venue}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-foreground truncate pr-2">
                    <span className={e.color}>{e.action}</span> {e.asset}
                  </span>
                  <span className={`text-[10px] whitespace-nowrap ${e.pnl != null ? (e.pnl >= 0 ? "text-primary" : "text-destructive") : "text-muted-foreground"}`}>{e.size}</span>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>
      <div className="px-4 py-2 border-t font-mono text-[10px] text-muted-foreground tracking-widest uppercase flex items-center gap-1">
        <Activity className="w-3 h-3" /> {feed.length} events
      </div>
    </aside>
  );
}

type AgentPreset = "conservative" | "balanced" | "aggressive";

function NewAgentWizard({ open, onClose, session, onSuccess }: { open: boolean; onClose: () => void; session: any; onSuccess: () => void }) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState("My Agent");
  const [preset, setPreset] = useState<AgentPreset>("balanced");
  const [riskPercent, setRiskPercent] = useState("1.0");
  const [maxLeverage, setMaxLeverage] = useState("10");
  const [maxOpenPositions, setMaxOpenPositions] = useState("2");
  const [dailyLossLimitPct, setDailyLossLimitPct] = useState("3.0");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setStep(1); setErr(null); }
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    setSubmitting(true);
    setErr(null);
    try {
      const risk = Math.min(10, Math.max(0.1, num(riskPercent, 1)));
      const lev = Math.floor(Math.min(50, Math.max(1, num(maxLeverage, 10))));
      const openPos = Math.floor(Math.min(10, Math.max(1, num(maxOpenPositions, 2))));
      const dailyLoss = Math.min(50, Math.max(0.5, num(dailyLossLimitPct, 3)));
      await session.apiFetch("/api/miniapp/agent/preset", { method: "POST", body: JSON.stringify({ preset }) });
      await session.apiFetch("/api/miniapp/agent/config", {
        method: "POST",
        body: JSON.stringify({ name, riskPercent: risk, maxLeverage: lev, maxOpenPositions: openPos, dailyLossLimitPct: dailyLoss }),
      });
      await session.apiFetch("/api/miniapp/agent/toggle", { method: "POST", body: JSON.stringify({ running: true }) });
      onSuccess();
      onClose();
    } catch (e: any) {
      setErr(e?.message || "Agent setup failed");
    } finally {
      setSubmitting(false);
    }
  };

  const presets: { id: AgentPreset; label: string; desc: string; risk: number; lev: number }[] = [
    { id: "conservative", label: "Conservative", desc: "Tight risk, low leverage, slow scans.", risk: 0.5, lev: 3 },
    { id: "balanced", label: "Balanced", desc: "Default. Moderate risk, moderate leverage.", risk: 1.0, lev: 10 },
    { id: "aggressive", label: "Aggressive", desc: "Higher per-trade risk and leverage.", risk: 2.0, lev: 20 },
  ];

  const selectPreset = (id: AgentPreset) => {
    setPreset(id);
    const p = presets.find((x) => x.id === id);
    if (p) { setRiskPercent(String(p.risk)); setMaxLeverage(String(p.lev)); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4" data-testid="agent-wizard">
      <div className="w-full max-w-lg rounded-md border bg-card shadow-xl">
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            <span className="font-mono text-sm tracking-widest uppercase">New Agent · Step {step}/3</span>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4">
          {step === 1 && (
            <div className="space-y-3">
              <label className="block font-mono text-[11px] tracking-widest uppercase text-muted-foreground">Agent Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={40}
                className="w-full px-3 py-2 rounded-md border bg-background font-mono text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                data-testid="input-agent-name"
              />
              <div className="font-mono text-[11px] text-muted-foreground">Used in logs + brain feed. Wallet stays under your control.</div>
            </div>
          )}
          {step === 2 && (
            <div className="space-y-3">
              <div className="font-mono text-[11px] tracking-widest uppercase text-muted-foreground">Pick a preset</div>
              {presets.map((p) => (
                <button
                  key={p.id}
                  onClick={() => selectPreset(p.id)}
                  className={`w-full text-left p-3 rounded-md border transition-colors ${preset === p.id ? "border-primary bg-primary/10" : "border-border hover:bg-background/40"}`}
                  data-testid={`preset-${p.id}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-sm font-semibold">{p.label}</span>
                    {preset === p.id && <CheckCircle2 className="w-4 h-4 text-primary" />}
                  </div>
                  <div className="font-mono text-[11px] text-muted-foreground mt-1">{p.desc}</div>
                  <div className="font-mono text-[10px] tracking-widest uppercase text-muted-foreground mt-2">
                    risk {p.risk}% · lev {p.lev}x
                  </div>
                </button>
              ))}
            </div>
          )}
          {step === 3 && (
            <div className="space-y-3">
              <div className="font-mono text-[11px] tracking-widest uppercase text-muted-foreground">Risk caps</div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-mono text-[10px] tracking-widest uppercase text-muted-foreground">Risk per trade %</label>
                  <input type="number" step="0.1" min="0.1" max="10" value={riskPercent} onChange={(e) => setRiskPercent(e.target.value)}
                    className="w-full mt-1 px-3 py-2 rounded-md border bg-background font-mono text-sm" data-testid="input-risk-pct" />
                </div>
                <div>
                  <label className="font-mono text-[10px] tracking-widest uppercase text-muted-foreground">Max leverage</label>
                  <input type="number" step="1" min="1" max="50" value={maxLeverage} onChange={(e) => setMaxLeverage(e.target.value)}
                    className="w-full mt-1 px-3 py-2 rounded-md border bg-background font-mono text-sm" data-testid="input-max-lev" />
                </div>
                <div>
                  <label className="font-mono text-[10px] tracking-widest uppercase text-muted-foreground">Max open positions</label>
                  <input type="number" step="1" min="1" max="10" value={maxOpenPositions} onChange={(e) => setMaxOpenPositions(e.target.value)}
                    className="w-full mt-1 px-3 py-2 rounded-md border bg-background font-mono text-sm" data-testid="input-max-open" />
                </div>
                <div>
                  <label className="font-mono text-[10px] tracking-widest uppercase text-muted-foreground">Daily loss limit %</label>
                  <input type="number" step="0.5" min="0.5" max="50" value={dailyLossLimitPct} onChange={(e) => setDailyLossLimitPct(e.target.value)}
                    className="w-full mt-1 px-3 py-2 rounded-md border bg-background font-mono text-sm" data-testid="input-loss-pct" />
                </div>
              </div>
              <div className="font-mono text-[11px] text-muted-foreground">
                The agent starts paused — toggle it from the dashboard once you've reviewed the config.
              </div>
            </div>
          )}
          {err && <div className="px-3 py-2 rounded bg-destructive/10 text-destructive border border-destructive/30 font-mono text-[11px]">{err}</div>}
        </div>
        <div className="flex items-center justify-between px-5 py-3 border-t">
          <button
            onClick={() => step > 1 ? setStep(step - 1) : onClose()}
            className="font-mono text-[11px] tracking-widest uppercase text-muted-foreground hover:text-foreground"
            data-testid="button-wizard-back"
          >
            {step > 1 ? "Back" : "Cancel"}
          </button>
          {step < 3 ? (
            <Button
              onClick={() => setStep(step + 1)}
              disabled={step === 1 && !name.trim()}
              className="font-mono text-[10px] tracking-widest uppercase h-8"
              data-testid="button-wizard-next"
            >
              Next <ChevronRight className="w-3 h-3 ml-1" />
            </Button>
          ) : (
            <Button
              onClick={submit}
              disabled={submitting}
              className="font-mono text-[10px] tracking-widest uppercase h-8"
              data-testid="button-wizard-submit"
            >
              {submitting ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Starting…</> : <>Start Agent <Power className="w-3 h-3 ml-1" /></>}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

type TradeVenue = "aster" | "hl";
type AsterSymbol = {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  pricePrecision: number;
  quantityPrecision: number;
  stepSize: number;
  tickSize: number;
  minNotional: number;
};
type HlSymbol = { name: string; szDecimals: number; maxLeverage: number };

function TradeDrawer({
  open,
  onClose,
  defaultVenue,
  session,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  defaultVenue: TradeVenue;
  session: ReturnType<typeof useTerminalSession>;
  onSuccess: () => void;
}) {
  const [venue, setVenue] = useState<TradeVenue>(defaultVenue);
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [symbolQuery, setSymbolQuery] = useState("");
  const [selectedSym, setSelectedSym] = useState<string>("");
  const [margin, setMargin] = useState("50");
  const [leverage, setLeverage] = useState(5);
  const [hlSize, setHlSize] = useState("");
  const [slippage, setSlippage] = useState(0.5);

  const [asterSyms, setAsterSyms] = useState<AsterSymbol[]>([]);
  const [hlSyms, setHlSyms] = useState<HlSymbol[]>([]);
  const [symsLoading, setSymsLoading] = useState(false);
  const [symsError, setSymsError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [submitOk, setSubmitOk] = useState<string | null>(null);

  // Sync drawer venue with caller-provided default whenever it (re)opens.
  useEffect(() => {
    if (open) setVenue(defaultVenue);
  }, [open, defaultVenue]);

  // Clear ephemeral form state when the drawer is closed so the next open starts clean.
  useEffect(() => {
    if (!open) {
      setSubmitErr(null);
      setSubmitOk(null);
    }
  }, [open]);

  // Load the relevant symbol universe lazily — once per venue per session.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSymsError(null);
    if (venue === "aster" && asterSyms.length === 0) {
      setSymsLoading(true);
      fetch("/api/public/aster/symbols")
        .then((r) => r.json())
        .then((d) => {
          if (cancelled) return;
          if (!d?.symbols) throw new Error(d?.error || "Empty symbol list");
          setAsterSyms(d.symbols as AsterSymbol[]);
        })
        .catch((e: any) => {
          if (!cancelled) setSymsError(e?.message || "Failed to load Aster symbols");
        })
        .finally(() => !cancelled && setSymsLoading(false));
    } else if (venue === "hl" && hlSyms.length === 0) {
      setSymsLoading(true);
      // /api/hl/meta requires auth — fall back gracefully when wallet isn't ready
      const fetcher = session.ready ? session.apiFetch<any>("/api/hl/meta") : fetch("/api/hl/meta").then((r) => r.json());
      Promise.resolve(fetcher)
        .then((d: any) => {
          if (cancelled) return;
          if (!d?.universe) throw new Error(d?.error || "Empty universe");
          setHlSyms(d.universe as HlSymbol[]);
        })
        .catch((e: any) => {
          if (!cancelled) setSymsError(e?.message || "Failed to load HL symbols");
        })
        .finally(() => !cancelled && setSymsLoading(false));
    }
    return () => {
      cancelled = true;
    };
  }, [open, venue, asterSyms.length, hlSyms.length, session.ready, session.apiFetch]);

  // Reset selection + status when venue changes
  useEffect(() => {
    setSelectedSym("");
    setSymbolQuery("");
    setSubmitErr(null);
    setSubmitOk(null);
  }, [venue]);

  const filtered = useMemo(() => {
    const q = symbolQuery.toUpperCase().trim();
    if (venue === "aster") {
      const matches = !q ? asterSyms : asterSyms.filter((s) => s.symbol.includes(q) || s.baseAsset.toUpperCase().includes(q));
      return matches.slice(0, 80);
    }
    const matches = !q ? hlSyms : hlSyms.filter((s) => s.name.toUpperCase().includes(q));
    return matches.slice(0, 80);
  }, [venue, symbolQuery, asterSyms, hlSyms]);

  const submit = async () => {
    if (!session.ready) {
      setSubmitErr("Connect wallet first");
      return;
    }
    if (!selectedSym) {
      setSubmitErr("Pick a symbol from the list");
      return;
    }
    setSubmitting(true);
    setSubmitErr(null);
    setSubmitOk(null);
    try {
      if (venue === "aster") {
        const amount = parseFloat(margin);
        if (!isFinite(amount) || amount <= 0) throw new Error("Margin must be a positive number");
        const result = await session.apiFetch<any>("/api/miniapp/trade", {
          method: "POST",
          body: { symbol: selectedSym, side, amount, leverage } as any,
        });
        const px = typeof result?.price === "number" ? result.price.toFixed(4) : result?.price ?? "—";
        setSubmitOk(`Filled ${result?.quantity ?? "?"} ${result?.symbol ?? selectedSym} @ $${px}`);
      } else {
        const sz = parseFloat(hlSize);
        if (!isFinite(sz) || sz <= 0) throw new Error("Size must be a positive number");
        await session.apiFetch<any>("/api/hl/market-order", {
          method: "POST",
          body: { coin: selectedSym, isBuy: side === "BUY", sz, slippage: slippage / 100 } as any,
        });
        setSubmitOk(`Hyperliquid ${side} ${sz} ${selectedSym} submitted`);
      }
      onSuccess();
    } catch (e: any) {
      setSubmitErr(e?.message || "Trade failed");
    } finally {
      setSubmitting(false);
    }
  };

  const symbolCount = venue === "aster" ? asterSyms.length : hlSyms.length;
  const sideLabel = side === "BUY" ? "Long" : "Short";
  const venueLabel = venue === "aster" ? "Aster Perps" : "Hyperliquid";

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 z-40"
          />
          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 260 }}
            className="fixed right-0 top-0 bottom-0 w-full sm:w-[420px] bg-card border-l z-50 flex flex-col"
          >
            <div className="px-5 py-4 border-b flex items-center justify-between">
              <div>
                <h3 className="font-mono text-sm tracking-widest uppercase">Trade Ticket</h3>
                <p className="text-xs text-muted-foreground mt-1">{venueLabel} · {selectedSym || "select symbol"}</p>
              </div>
              <button onClick={onClose} data-testid="button-close-drawer"><X className="w-4 h-4 text-muted-foreground hover:text-foreground" /></button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setVenue("aster")}
                  data-testid="button-venue-aster"
                  className={`py-2 rounded-md font-mono text-[11px] tracking-widest uppercase border transition-all ${
                    venue === "aster" ? "bg-yellow-400/15 border-yellow-400/50 text-yellow-400" : "border-border text-muted-foreground"
                  }`}
                >Aster Perps</button>
                <button
                  onClick={() => setVenue("hl")}
                  data-testid="button-venue-hl"
                  className={`py-2 rounded-md font-mono text-[11px] tracking-widest uppercase border transition-all ${
                    venue === "hl" ? "bg-cyan-400/15 border-cyan-400/50 text-cyan-400" : "border-border text-muted-foreground"
                  }`}
                >Hyperliquid</button>
              </div>

              <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
                <div className="flex items-center justify-between mb-2">
                  <label className="font-mono text-[10px] tracking-widest uppercase text-primary">
                    Symbol · {selectedSym || "pick one"}
                  </label>
                  {symbolCount > 0 && (
                    <span className="font-mono text-[10px] text-muted-foreground" data-testid="text-symbol-count">
                      {symbolCount} pairs
                    </span>
                  )}
                </div>
                <input
                  value={symbolQuery}
                  onChange={(e) => setSymbolQuery(e.target.value)}
                  placeholder={venue === "aster" ? `Search ${symbolCount || "all"} Aster pairs (BTC, PEPE, SOL…)` : `Search ${symbolCount || "all"} HL coins (BTC, HYPE, kPEPE…)`}
                  data-testid="input-symbol-search"
                  autoFocus
                  className="w-full bg-background border rounded-md px-3 py-2 font-mono text-sm uppercase focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <div className="mt-2 max-h-56 overflow-y-auto rounded border bg-background/40">
                  {symsLoading ? (
                    <div className="px-3 py-4 text-xs text-muted-foreground font-mono">Loading symbols…</div>
                  ) : symsError ? (
                    <div className="px-3 py-4 text-xs text-destructive font-mono">{symsError}</div>
                  ) : filtered.length === 0 ? (
                    <div className="px-3 py-4 text-xs text-muted-foreground font-mono">No matches</div>
                  ) : (
                    filtered.map((s: any) => {
                      const sym = venue === "aster" ? s.symbol : s.name;
                      const sub = venue === "aster" ? s.baseAsset : `${s.maxLeverage}x max`;
                      return (
                        <button
                          key={sym}
                          onClick={() => { setSelectedSym(sym); setSymbolQuery(sym); }}
                          data-testid={`row-symbol-${sym}`}
                          className={`w-full text-left px-3 py-1.5 font-mono text-xs flex justify-between hover:bg-primary/10 ${
                            selectedSym === sym ? "bg-primary/15 text-primary" : "text-foreground"
                          }`}
                        >
                          <span>{sym}</span>
                          <span className="text-muted-foreground">{sub}</span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setSide("BUY")}
                  data-testid="button-side-buy"
                  className={`py-3 rounded-md font-mono text-xs tracking-widest uppercase border transition-all ${
                    side === "BUY" ? "bg-primary/15 border-primary/50 text-primary" : "border-border text-muted-foreground"
                  }`}
                >Long / Buy</button>
                <button
                  onClick={() => setSide("SELL")}
                  data-testid="button-side-sell"
                  className={`py-3 rounded-md font-mono text-xs tracking-widest uppercase border transition-all ${
                    side === "SELL" ? "bg-destructive/15 border-destructive/50 text-destructive" : "border-border text-muted-foreground"
                  }`}
                >Short / Sell</button>
              </div>

              {venue === "aster" ? (
                <>
                  <div>
                    <label className="font-mono text-[10px] tracking-widest uppercase text-muted-foreground">Margin (USDT)</label>
                    <input
                      value={margin}
                      onChange={(e) => setMargin(e.target.value)}
                      inputMode="decimal"
                      data-testid="input-margin"
                      className="mt-1 w-full bg-background border rounded-md px-3 py-3 font-mono text-lg focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    <div className="flex gap-2 mt-2">
                      {["10", "50", "100", "250"].map((q) => (
                        <button
                          key={q}
                          onClick={() => setMargin(q)}
                          data-testid={`button-margin-${q}`}
                          className="flex-1 py-1.5 rounded border font-mono text-[10px] tracking-widest text-muted-foreground hover:text-foreground"
                        >{q}</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="font-mono text-[10px] tracking-widest uppercase text-muted-foreground">Leverage · {leverage}x</label>
                    <input
                      type="range"
                      min={1}
                      max={50}
                      value={leverage}
                      onChange={(e) => setLeverage(parseInt(e.target.value))}
                      data-testid="input-leverage"
                      className="mt-2 w-full accent-primary"
                    />
                    <div className="grid grid-cols-5 gap-1.5 mt-2">
                      {[1, 2, 5, 10, 20].map((l) => (
                        <button
                          key={l}
                          onClick={() => setLeverage(l)}
                          data-testid={`button-leverage-${l}`}
                          className={`py-1.5 rounded font-mono text-xs border transition-all ${
                            leverage === l ? "bg-primary/15 border-primary/50 text-primary" : "border-border text-muted-foreground"
                          }`}
                        >{l}x</button>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="font-mono text-[10px] tracking-widest uppercase text-muted-foreground">Size (base coin)</label>
                    <input
                      value={hlSize}
                      onChange={(e) => setHlSize(e.target.value)}
                      inputMode="decimal"
                      placeholder="e.g. 0.1"
                      data-testid="input-hl-size"
                      className="mt-1 w-full bg-background border rounded-md px-3 py-3 font-mono text-lg focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                      Quantity in {selectedSym || "base asset"}, not USD. Hyperliquid sizes are in coins.
                    </p>
                  </div>
                  <div>
                    <label className="font-mono text-[10px] tracking-widest uppercase text-muted-foreground">
                      Slippage cap · {slippage.toFixed(2)}%
                    </label>
                    <input
                      type="range"
                      min={0.1}
                      max={5}
                      step={0.1}
                      value={slippage}
                      onChange={(e) => setSlippage(parseFloat(e.target.value))}
                      data-testid="input-slippage"
                      className="mt-2 w-full accent-primary"
                    />
                  </div>
                </>
              )}

              {submitErr && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 font-mono text-[11px] text-destructive" data-testid="text-trade-error">
                  {submitErr}
                </div>
              )}
              {submitOk && (
                <div className="rounded-md border border-primary/40 bg-primary/10 p-3 font-mono text-[11px] text-primary" data-testid="text-trade-success">
                  {submitOk}
                </div>
              )}

              <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-mono">
                <Lock className="w-3 h-3" />
                {venue === "aster"
                  ? "Custodial — bot signs from your master Aster account"
                  : "On-chain — signed by your Hyperliquid agent wallet"}
              </div>
            </div>

            <div className="p-5 border-t">
              <Button
                disabled={!session.ready || !selectedSym || submitting}
                onClick={submit}
                className="w-full font-mono tracking-widest text-xs uppercase h-11"
                data-testid="button-confirm-trade"
              >
                {submitting
                  ? "Submitting…"
                  : !session.ready
                  ? "Connect wallet to trade"
                  : !selectedSym
                  ? "Pick a symbol"
                  : `Confirm ${sideLabel} · ${venue === "aster" ? `$${margin}` : `${hlSize || "—"} ${selectedSym}`}`}
              </Button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-foreground">{v}</span>
    </div>
  );
}

export default function TerminalPreview() {
  const [walletPanelOpen, setWalletPanelOpen] = useState(false);
  useEffect(() => { (globalThis as any).__b4OpenWallet = () => setWalletPanelOpen(true); return () => { delete (globalThis as any).__b4OpenWallet; }; }, []);
  const [venue, setVenue] = useState<Venue>("dashboard");
  const [drawer, setDrawer] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [refetchTick, setRefetchTick] = useState(0);
  const openTrade = () => setDrawer(true);
  const openWizard = () => setWizardOpen(true);

  const session = useTerminalSession();
  const [asterAcct, setAsterAcct] = useState<any>(null);
  const [hlAcct, setHlAcct] = useState<any>(null);
  const [agentInfo, setAgentInfo] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!session.ready) {
      setAsterAcct(null);
      setHlAcct(null);
      setAgentInfo(null);
      setErr(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    let inFlight = false;
    let seq = 0;
    const load = async () => {
      // Drop overlapping ticks so a slow request can't clobber a fresh one.
      if (inFlight) return;
      inFlight = true;
      const mySeq = ++seq;
      setLoading(true);
      setErr(null);
      const results = await Promise.allSettled([
        session.apiFetch<any>("/api/miniapp/account"),
        session.apiFetch<any>("/api/hl/account"),
        session.apiFetch<any>("/api/miniapp/agent"),
      ]);
      inFlight = false;
      if (cancelled || mySeq !== seq) return;
      const [a, h, ag] = results;
      const errs: string[] = [];
      if (a.status === "fulfilled") setAsterAcct(a.value);
      else {
        setAsterAcct(null);
        errs.push(`Aster: ${a.reason?.message || "load failed"}`);
      }
      if (h.status === "fulfilled") setHlAcct(h.value);
      else {
        setHlAcct(null);
        // HL failures are non-fatal (user may not have set up HL yet) but we still
        // surface them so silent outages don't get hidden.
        const msg = h.reason?.message || "load failed";
        if (!/not.?registered|not.?setup|no.?agent|no.?wallet/i.test(msg)) {
          errs.push(`HL: ${msg}`);
        }
      }
      // Agent endpoint is also non-fatal — user may not have configured one yet.
      if (ag.status === "fulfilled") setAgentInfo(ag.value);
      else setAgentInfo(null);
      setErr(errs.length ? errs.join(" · ") : null);
      setLoading(false);
    };
    load();
    const id = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [session.ready, session.apiFetch, refetchTick]);

  const asterEquity = (() => {
    if (!asterAcct) return 0;
    const wb = Number(asterAcct.walletBalance ?? 0);
    const upnl = Number(asterAcct.unrealizedPnl ?? 0);
    return wb + upnl;
  })();
  const hlEquity = (() => {
    if (!hlAcct) return 0;
    // Hyperliquid `getUserState` returns equity under marginSummary.accountValue.
    // Fall back to crossMarginSummary / top-level fields just in case the SDK
    // shape changes.
    return (
      Number(
        hlAcct.marginSummary?.accountValue ??
        hlAcct.crossMarginSummary?.accountValue ??
        hlAcct.accountValue ??
        hlAcct.equity ??
        hlAcct.totalRawUsd ??
        0,
      ) || 0
    );
  })();
  const totalEquity = session.ready ? asterEquity + hlEquity : null;
  const asterUpnl = asterAcct ? Number(asterAcct.unrealizedPnl ?? 0) : 0;
  // HL unrealized PnL = sum of per-position unrealizedPnl (positions live
  // under assetPositions[].position.unrealizedPnl). The marginSummary fields
  // are NOT unrealized PnL — using them would dramatically misreport.
  const hlUpnl = (() => {
    const ap = Array.isArray(hlAcct?.assetPositions) ? hlAcct.assetPositions : [];
    let s = 0;
    for (const item of ap) {
      const v = Number(item?.position?.unrealizedPnl ?? 0);
      if (Number.isFinite(v)) s += v;
    }
    return s;
  })();
  const unrealizedPnl = session.ready && (asterAcct || hlAcct) ? asterUpnl + hlUpnl : null;
  const pnl24h = asterAcct ? Number(asterAcct.realizedPnl ?? 0) + Number(asterAcct.unrealizedPnl ?? 0) : null;
  const pnl24hPct = totalEquity && totalEquity > 0 && pnl24h != null ? (pnl24h / totalEquity) * 100 : null;

  const agentName = agentInfo?.config?.name ?? null;
  const agentRunning = !!agentInfo?.running;
  const agentTrades = Number(agentInfo?.stats?.tradeCount ?? 0) || 0;
  const agentWins = Number(agentInfo?.stats?.winCount ?? 0) || 0;
  const agentLosses = Number(agentInfo?.stats?.lossCount ?? 0) || 0;
  // We surface "active" agents — i.e. running. If you have an idle agent
  // configured, the right-side panel still shows it, but the headline counter
  // only ticks up when the agent is actually firing decisions.
  const agentsCount = session.ready && agentInfo ? (agentRunning ? 1 : 0) : null;

  const summary: AccountSummary = {
    totalEquity,
    pnl24h,
    pnl24hPct,
    unrealizedPnl,
    agents: agentsCount,
    agentName,
    agentRunning,
    agentTrades,
    agentWins,
    agentLosses,
    isLive: session.ready && !err,
  };

  const venues: VenueBalance[] = [];
  if (session.ready) {
    const total = Math.max(0.0001, asterEquity + hlEquity);
    if (asterEquity > 0) venues.push({ v: "Aster Perps", val: asterEquity, pct: (asterEquity / total) * 100, color: "bg-yellow-400" });
    if (hlEquity > 0) venues.push({ v: "Hyperliquid", val: hlEquity, pct: (hlEquity / total) * 100, color: "bg-cyan-400" });
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <StatusBar ready={session.ready} summary={summary} />
      {session.registerState === "error" && (
        <div className="px-4 py-2 bg-destructive/10 border-b border-destructive/30 font-mono text-[11px] text-destructive">
          Wallet register failed: {session.registerError}
        </div>
      )}
      {session.wallet.connected && session.linked === false && (
        <div className="border-b border-emerald-500/30 bg-emerald-500/5 px-4 py-4 sm:px-6 lg:px-8" data-testid="banner-link-telegram">
          <div className="max-w-2xl mx-auto">
            <LinkTelegramCard variant="link" onLinked={() => session.refreshLink()} />
          </div>
        </div>
      )}
      <div className="flex-1 flex overflow-hidden">
        <IconRail active={venue} setActive={setVenue} />
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          {venue === "dashboard" && (
            <DashboardPane
              onTrade={openTrade}
              onNewAgent={openWizard}
              ready={session.ready}
              loading={loading}
              err={err}
              summary={summary}
              venues={venues}
            />
          )}
          {venue === "aster" && <AsterPane session={session} asterAcct={asterAcct} onTrade={openTrade} onRefetch={() => setRefetchTick((n) => n + 1)} />}
          {venue === "hyperliquid" && <HlPane session={session} hlAcct={hlAcct} onTrade={openTrade} onRefetch={() => setRefetchTick((n) => n + 1)} />}
          {venue === "fourmeme" && <FourmemePane session={session} />}
          {venue === "polymarket" && <PolymarketPane session={session} />}
          {venue === "fortytwo" && <FortyTwoPane session={session} />}
        </main>
        <BrainFeed session={session} refetchTick={refetchTick} />
      </div>
      <WalletPanel open={walletPanelOpen} onClose={() => setWalletPanelOpen(false)} />
      <TradeDrawer
        open={drawer}
        onClose={() => setDrawer(false)}
        defaultVenue={venue === "hyperliquid" ? "hl" : "aster"}
        session={session}
        onSuccess={() => setRefetchTick((n) => n + 1)}
      />
      <NewAgentWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        session={session}
        onSuccess={() => setRefetchTick((n) => n + 1)}
      />
    </div>
  );
}
