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
import { useTerminalSession } from "@/hooks/use-terminal-session";
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

// (legacy mock arrays removed)

type AccountSummary = {
  totalEquity: number | null;
  pnl24h: number | null;
  pnl24hPct: number | null;
  agents: number | null;
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
          value={loading ? "…" : "—"}
          sub="open positions"
        />
        <StatCard
          label="Active Agents"
          value={loading ? "…" : summary.agents == null ? "—" : String(summary.agents)}
          sub={summary.agents == null ? "—" : "running"}
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
          <div className="font-mono text-xs text-muted-foreground py-12 text-center">
            {ready ? "No agents yet. Spin one up from the venue panes." : "Connect wallet to see your agents."}
          </div>
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

function ComingSoonPane({ title, sub, accent, color, icon: Icon, lines }: { title: string; sub: string; accent: string; color: string; icon: any; lines: string[] }) {
  return (
    <div>
      <VenueHeader title={title} sub={sub} accent={accent} />
      <div className="rounded-md border bg-card/60 p-10 text-center">
        <Icon className={`w-10 h-10 mx-auto ${color} mb-3 opacity-50`} />
        <div className="font-mono text-sm text-foreground mb-1">Coming soon to the web terminal.</div>
        <div className="font-mono text-[11px] text-muted-foreground mb-4">Already live in the Telegram bot — porting to the web server next.</div>
        <ul className="font-mono text-[11px] text-muted-foreground space-y-1 max-w-md mx-auto text-left">
          {lines.map((l) => <li key={l}>· {l}</li>)}
        </ul>
      </div>
    </div>
  );
}

function PolymarketPane() {
  return (
    <ComingSoonPane
      title="Polymarket"
      sub="Gasless prediction markets — Safe-routed, USDC settled on Polygon."
      accent="border-blue-400/40 text-blue-400"
      color="text-blue-400"
      icon={Target}
      lines={[
        "Per-user Gnosis Safe, deployed via Polymarket relayer (no MATIC required).",
        "Manual buy/sell + autonomous polymarketAgent already live in the bot.",
        "Web wiring pending: /api/polymarket/* endpoints need to be ported to this server.",
      ]}
    />
  );
}

function FourmemePane() {
  return (
    <ComingSoonPane
      title="fourmeme"
      sub="Autonomous token launchpad on BSC. Agents launch, buy, and rotate."
      accent="border-emerald-400/40 text-emerald-400"
      color="text-emerald-400"
      icon={Rocket}
      lines={[
        "Token launcher with parameterised name / symbol / initial buy.",
        "Live in the Telegram bot via /api/token-launcher/* and /api/four-meme/*.",
        "Holdings table + rotation queue land in the web terminal next.",
      ]}
    />
  );
}

function FortyTwoPane() {
  return (
    <ComingSoonPane
      title="42.space"
      sub="On-chain prediction markets on BSC. BTC 8h price campaigns + Campaign mode."
      accent="border-orange-400/40 text-orange-400"
      color="text-orange-400"
      icon={Target}
      lines={[
        "Live BTC bucket grid, round timer, and Agent-vs-Community recap.",
        "Campaign agent + idempotent ENTRY ticks already shipped in the bot.",
        "Web pane will read campaign state from /api/admin/campaign/state once exposed publicly.",
      ]}
    />
  );
}

type FeedEntry = {
  id: string;
  t: number;
  venue: "Aster" | "HL" | "Agent";
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
        const [hist, hlFills, agent] = await Promise.allSettled([
          session.apiFetch<any>("/api/miniapp/history"),
          session.apiFetch<any>("/api/hl/fills"),
          session.apiFetch<any>("/api/miniapp/agent"),
        ]);
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
  const [riskPercent, setRiskPercent] = useState(1.0);
  const [maxLeverage, setMaxLeverage] = useState(10);
  const [maxOpenPositions, setMaxOpenPositions] = useState(2);
  const [dailyLossLimitPct, setDailyLossLimitPct] = useState(3.0);
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
      await session.apiFetch("/api/miniapp/agent/preset", { method: "POST", body: JSON.stringify({ preset }) });
      await session.apiFetch("/api/miniapp/agent/config", {
        method: "POST",
        body: JSON.stringify({ name, riskPercent, maxLeverage, maxOpenPositions, dailyLossLimitPct }),
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
    if (p) { setRiskPercent(p.risk); setMaxLeverage(p.lev); }
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
                  <input type="number" step="0.1" min="0.1" max="10" value={riskPercent} onChange={(e) => setRiskPercent(num(e.target.value, 1))}
                    className="w-full mt-1 px-3 py-2 rounded-md border bg-background font-mono text-sm" data-testid="input-risk-pct" />
                </div>
                <div>
                  <label className="font-mono text-[10px] tracking-widest uppercase text-muted-foreground">Max leverage</label>
                  <input type="number" step="1" min="1" max="50" value={maxLeverage} onChange={(e) => setMaxLeverage(Math.floor(num(e.target.value, 10)))}
                    className="w-full mt-1 px-3 py-2 rounded-md border bg-background font-mono text-sm" data-testid="input-max-lev" />
                </div>
                <div>
                  <label className="font-mono text-[10px] tracking-widest uppercase text-muted-foreground">Max open positions</label>
                  <input type="number" step="1" min="1" max="10" value={maxOpenPositions} onChange={(e) => setMaxOpenPositions(Math.floor(num(e.target.value, 2)))}
                    className="w-full mt-1 px-3 py-2 rounded-md border bg-background font-mono text-sm" data-testid="input-max-open" />
                </div>
                <div>
                  <label className="font-mono text-[10px] tracking-widest uppercase text-muted-foreground">Daily loss limit %</label>
                  <input type="number" step="0.5" min="0.5" max="50" value={dailyLossLimitPct} onChange={(e) => setDailyLossLimitPct(num(e.target.value, 3))}
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

              <div>
                <label className="font-mono text-[10px] tracking-widest uppercase text-muted-foreground">Symbol</label>
                <input
                  value={symbolQuery}
                  onChange={(e) => setSymbolQuery(e.target.value)}
                  placeholder={venue === "aster" ? "Search BTCUSDT, PEPE…" : "Search BTC, HYPE, kPEPE…"}
                  data-testid="input-symbol-search"
                  className="mt-1 w-full bg-background border rounded-md px-3 py-2 font-mono text-sm uppercase focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <div className="mt-2 max-h-44 overflow-y-auto rounded border bg-background/40">
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
                {symbolCount > 0 && (
                  <p className="mt-1 font-mono text-[10px] text-muted-foreground" data-testid="text-symbol-count">
                    {symbolCount} symbols available on {venueLabel}
                  </p>
                )}
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
  const [venue, setVenue] = useState<Venue>("dashboard");
  const [drawer, setDrawer] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [refetchTick, setRefetchTick] = useState(0);
  const openTrade = () => setDrawer(true);
  const openWizard = () => setWizardOpen(true);

  const session = useTerminalSession();
  const [asterAcct, setAsterAcct] = useState<any>(null);
  const [hlAcct, setHlAcct] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!session.ready) {
      setAsterAcct(null);
      setHlAcct(null);
      setErr(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setErr(null);
      const results = await Promise.allSettled([
        session.apiFetch<any>("/api/miniapp/account"),
        session.apiFetch<any>("/api/hl/account"),
      ]);
      if (cancelled) return;
      const [a, h] = results;
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
    return Number(hlAcct.accountValue ?? hlAcct.equity ?? hlAcct.totalRawUsd ?? 0);
  })();
  const totalEquity = session.ready ? asterEquity + hlEquity : null;
  const pnl24h = asterAcct ? Number(asterAcct.realizedPnl ?? 0) + Number(asterAcct.unrealizedPnl ?? 0) : null;
  const pnl24hPct = totalEquity && totalEquity > 0 && pnl24h != null ? (pnl24h / totalEquity) * 100 : null;

  const summary: AccountSummary = {
    totalEquity,
    pnl24h,
    pnl24hPct,
    agents: null,
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
          {venue === "fourmeme" && <FourmemePane />}
          {venue === "polymarket" && <PolymarketPane />}
          {venue === "fortytwo" && <FortyTwoPane />}
        </main>
        <BrainFeed session={session} refetchTick={refetchTick} />
      </div>
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
