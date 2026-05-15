import { useState, useEffect } from "react";
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import asterLogo from "@assets/aster_logo.svg";
import hyperliquidLogo from "@assets/hyperliquid-logo_1775737973029.png";
import fourmemeLogo from "@assets/four_logo_1778389271440.jpg";
import polymarketLogo from "@assets/polymarket_logo.png";
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

const BRAIN_FEED = [
  { ago: "2s", agent: "node_001", venue: "Aster", action: "OPEN LONG", asset: "BTC", size: "$420", conf: 87, color: "text-yellow-400" },
  { ago: "14s", agent: "node_007", venue: "Polymarket", action: "BUY YES", asset: "Trump 2028", size: "$120", conf: 73, color: "text-blue-400" },
  { ago: "31s", agent: "node_003", venue: "HL", action: "CLOSE", asset: "ETH", size: "+$18.40", conf: 91, color: "text-cyan-400" },
  { ago: "47s", agent: "node_012", venue: "42.space", action: "ENTRY", asset: "BTC 8h $63k-65k", size: "$50", conf: 82, color: "text-orange-400" },
  { ago: "1m", agent: "node_005", venue: "fourmeme", action: "LAUNCH", asset: "$PEPE2", size: "0.05 BNB", conf: 64, color: "text-emerald-400" },
  { ago: "1m", agent: "node_001", venue: "Aster", action: "HOLD", asset: "SOL", size: "—", conf: 55, color: "text-muted-foreground" },
  { ago: "2m", agent: "node_009", venue: "HL", action: "OPEN SHORT", asset: "DOGE", size: "$210", conf: 78, color: "text-cyan-400" },
  { ago: "2m", agent: "node_002", venue: "Polymarket", action: "REDEEM", asset: "Fed Rate Mar", size: "+$84.20", conf: 100, color: "text-blue-400" },
  { ago: "3m", agent: "node_007", venue: "Aster", action: "TP HIT", asset: "BTC", size: "+$42.10", conf: 88, color: "text-yellow-400" },
  { ago: "4m", agent: "node_011", venue: "42.space", action: "REASSESS", asset: "BTC 8h", size: "DOUBLE", conf: 85, color: "text-orange-400" },
];

const ASTER_POSITIONS = [
  { sym: "BTCUSDT", side: "LONG", size: "0.012", entry: "63,420", mark: "63,890", pnl: 5.64, pnlPct: 0.74, agent: "node_001" },
  { sym: "SOLUSDT", side: "LONG", size: "1.84", entry: "143.20", mark: "146.10", pnl: 5.34, pnlPct: 2.03, agent: "node_001" },
  { sym: "DOGEUSDT", side: "SHORT", size: "1240", entry: "0.1342", mark: "0.1318", pnl: 2.98, pnlPct: 1.79, agent: "node_009" },
];

const POLY_POSITIONS = [
  { market: "Will Bitcoin reach $80k by July?", side: "YES", shares: "142", avg: "0.62", mark: "0.71", pnl: 12.78, pnlPct: 14.5, status: "OPEN" },
  { market: "Fed cuts rates in March", side: "NO", shares: "85", avg: "0.34", mark: "0.41", pnl: 5.95, pnlPct: 20.6, status: "OPEN" },
  { market: "ETH ETF approved Q2", side: "YES", shares: "210", avg: "0.55", mark: "1.00", pnl: 94.50, pnlPct: 81.8, status: "RESOLVED — REDEEM" },
];

function StatusBar() {
  return (
    <div className="flex items-center justify-between px-4 sm:px-6 py-2.5 border-b bg-card/60 backdrop-blur-xl font-mono text-xs">
      <div className="flex items-center gap-4 sm:gap-6">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
          <span className="text-muted-foreground tracking-widest">BUILD<span className="text-primary">4</span> TERMINAL</span>
        </div>
        <Badge variant="outline" className="border-yellow-500/30 text-yellow-500 text-[10px] tracking-widest uppercase">PREVIEW</Badge>
      </div>
      <div className="hidden md:flex items-center gap-6">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">EQUITY</span>
          <span className="text-foreground font-semibold">$12,418.34</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">24h</span>
          <span className="text-primary font-semibold flex items-center"><ArrowUpRight className="w-3 h-3" />+$284.12 · +2.34%</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">AGENTS</span>
          <span className="text-foreground font-semibold">6 live</span>
        </div>
        <div className="flex items-center gap-2 text-primary">
          <Wifi className="w-3 h-3" />
          <span className="text-[10px] tracking-widest uppercase">WS LIVE</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="w-6 h-6 rounded-full bg-primary/20 border border-primary/40 flex items-center justify-center text-[10px] font-bold text-primary">B4</div>
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

function DashboardPane({ onTrade }: { onTrade: () => void }) {
  return (
    <div>
      <VenueHeader title="Overview" sub="All venues, one view. Equity, agents, and live brain across the swarm." accent="border-primary/40 text-primary" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="Total Equity" value="$12,418.34" sub="across 5 venues" />
        <StatCard label="24h PnL" value="+$284.12" sub="+2.34%" accent="text-primary" />
        <StatCard label="7d PnL" value="+$1,842.07" sub="+17.4%" accent="text-primary" />
        <StatCard label="Win Rate" value="68%" sub="last 50 trades" />
      </div>
      <div className="grid lg:grid-cols-2 gap-4">
        <div className="p-5 rounded-md border bg-card/60">
          <h3 className="font-mono text-sm tracking-widest uppercase text-muted-foreground mb-4">Equity by venue</h3>
          <div className="space-y-3">
            {[
              { v: "Aster Perps", val: 4820.18, pct: 38.8, color: "bg-yellow-400" },
              { v: "Hyperliquid", val: 3142.50, pct: 25.3, color: "bg-cyan-400" },
              { v: "Polymarket", val: 2104.32, pct: 16.9, color: "bg-blue-400" },
              { v: "fourmeme", val: 1518.90, pct: 12.2, color: "bg-emerald-400" },
              { v: "42.space", val: 832.44, pct: 6.7, color: "bg-orange-400" },
            ].map((r) => (
              <div key={r.v}>
                <div className="flex justify-between text-xs font-mono mb-1">
                  <span className="text-foreground">{r.v}</span>
                  <span className="text-muted-foreground">${r.val.toLocaleString()} · {r.pct}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-border overflow-hidden">
                  <div className={`h-full ${r.color}`} style={{ width: `${r.pct}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="p-5 rounded-md border bg-card/60">
          <h3 className="font-mono text-sm tracking-widest uppercase text-muted-foreground mb-4">Active agents</h3>
          <div className="space-y-2">
            {[
              { id: "node_001", focus: "Aster · BTC/SOL", pnl: "+$142.10", up: true },
              { id: "node_007", focus: "Polymarket · macro", pnl: "+$84.20", up: true },
              { id: "node_003", focus: "HL · ETH momentum", pnl: "+$32.40", up: true },
              { id: "node_009", focus: "HL · DOGE short", pnl: "+$18.40", up: true },
              { id: "node_011", focus: "42.space · BTC 8h", pnl: "−$4.10", up: false },
              { id: "node_005", focus: "fourmeme · launchpad", pnl: "+$11.10", up: true },
            ].map((a) => (
              <div key={a.id} className="flex items-center justify-between px-3 py-2 rounded border-l-2 border-primary/40 bg-background/50 hover:bg-background transition-colors">
                <div>
                  <div className="font-mono text-xs text-foreground">{a.id}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">{a.focus}</div>
                </div>
                <div className={`font-mono text-sm font-semibold ${a.up ? "text-primary" : "text-destructive"}`}>{a.pnl}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-6">
        <Button onClick={onTrade} className="font-mono tracking-widest text-xs uppercase" data-testid="button-place-trade">
          New Trade Ticket <ChevronRight className="w-3.5 h-3.5 ml-1" />
        </Button>
      </div>
    </div>
  );
}

function PerpPane({ name, sub, accent, positions, onTrade }: any) {
  return (
    <div>
      <VenueHeader title={name} sub={sub} accent={accent} />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="Margin Balance" value="$4,820.18" sub="USDT" />
        <StatCard label="Unrealized PnL" value="+$13.96" sub="+0.29%" accent="text-primary" />
        <StatCard label="Open Positions" value="3" />
        <StatCard label="Today" value="+$58.10" sub="7 trades · 5W/2L" accent="text-primary" />
      </div>
      <div className="rounded-md border bg-card/60 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="font-mono text-sm tracking-widest uppercase text-muted-foreground">Positions</h3>
          <Button size="sm" onClick={onTrade} className="font-mono text-[10px] tracking-widest uppercase h-7" data-testid="button-new-trade">
            <Plus className="w-3 h-3 mr-1" /> New Trade
          </Button>
        </div>
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
                <th className="text-left px-4 py-2">Agent</th>
                <th className="text-right px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p: any) => (
                <tr key={p.sym} className="border-b last:border-0 hover:bg-background/40 transition-colors">
                  <td className="px-4 py-3 text-foreground font-semibold">{p.sym}</td>
                  <td className="px-4 py-3"><span className={p.side === "LONG" ? "text-primary" : "text-destructive"}>{p.side}</span></td>
                  <td className="px-4 py-3 text-right text-muted-foreground">{p.size}</td>
                  <td className="px-4 py-3 text-right text-muted-foreground">{p.entry}</td>
                  <td className="px-4 py-3 text-right text-foreground">{p.mark}</td>
                  <td className={`px-4 py-3 text-right font-semibold ${p.pnl >= 0 ? "text-primary" : "text-destructive"}`}>
                    {p.pnl >= 0 ? "+" : ""}${p.pnl.toFixed(2)} · {p.pnlPct >= 0 ? "+" : ""}{p.pnlPct.toFixed(2)}%
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{p.agent}</td>
                  <td className="px-4 py-3 text-right">
                    <button className="text-[10px] tracking-widest uppercase text-muted-foreground hover:text-destructive transition-colors">close</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function PolymarketPane({ onTrade }: { onTrade: () => void }) {
  return (
    <div>
      <VenueHeader title="Polymarket" sub="Gasless prediction markets — Safe-routed, USDC settled on Polygon." accent="border-blue-400/40 text-blue-400" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="Safe Balance" value="$2,104.32" sub="USDC.e (no MATIC needed)" />
        <StatCard label="Open Positions" value="2" />
        <StatCard label="Resolved · Claimable" value="$94.50" accent="text-primary" />
        <StatCard label="30d ROI" value="+18.4%" accent="text-primary" />
      </div>
      <div className="rounded-md border bg-card/60 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="font-mono text-sm tracking-widest uppercase text-muted-foreground">Positions</h3>
          <Button size="sm" onClick={onTrade} className="font-mono text-[10px] tracking-widest uppercase h-7">
            <Plus className="w-3 h-3 mr-1" /> Browse Markets
          </Button>
        </div>
        <div className="divide-y">
          {POLY_POSITIONS.map((p) => (
            <div key={p.market} className="px-4 py-3 hover:bg-background/40 transition-colors">
              <div className="flex items-start justify-between gap-4 mb-2">
                <div className="font-mono text-xs text-foreground flex-1">{p.market}</div>
                <div className={`font-mono text-sm font-semibold ${p.pnl >= 0 ? "text-primary" : "text-destructive"}`}>
                  +${p.pnl.toFixed(2)} · +{p.pnlPct.toFixed(1)}%
                </div>
              </div>
              <div className="flex items-center gap-3 font-mono text-[10px] text-muted-foreground tracking-widest uppercase">
                <span className={p.side === "YES" ? "text-primary" : "text-destructive"}>{p.side}</span>
                <span>{p.shares} shares</span>
                <span>avg {p.avg}</span>
                <span>mark {p.mark}</span>
                <div className="flex-1" />
                {p.status === "OPEN" ? (
                  <button className="text-destructive hover:underline">sell</button>
                ) : (
                  <button className="text-primary font-bold hover:underline">redeem →</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function FourmemePane() {
  return (
    <div>
      <VenueHeader title="fourmeme" sub="Autonomous token launchpad on BSC. Agents launch, buy, and rotate." accent="border-emerald-400/40 text-emerald-400" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="BNB Balance" value="0.842" sub="≈ $510.20" />
        <StatCard label="Tokens Held" value="4" />
        <StatCard label="Launches (7d)" value="11" sub="3 graduated to v2" accent="text-primary" />
        <StatCard label="7d PnL" value="+$214.80" accent="text-primary" />
      </div>
      <div className="rounded-md border bg-card/60 p-8 text-center">
        <Rocket className="w-10 h-10 mx-auto text-emerald-400/40 mb-3" />
        <div className="font-mono text-sm text-muted-foreground">Token launcher, holdings table and rotation queue render here.</div>
      </div>
    </div>
  );
}

function FortyTwoPane() {
  return (
    <div>
      <VenueHeader title="42.space" sub="On-chain prediction markets on BSC. BTC 8h price campaigns + Campaign mode." accent="border-orange-400/40 text-orange-400" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="Position Value" value="$832.44" />
        <StatCard label="Campaign Round" value="7 / 12" sub="next: 16:05 UTC" accent="text-orange-400" />
        <StatCard label="Wins" value="4 / 6" sub="round-by-round" accent="text-primary" />
        <StatCard label="Campaign PnL" value="+$118.60" accent="text-primary" />
      </div>
      <div className="rounded-md border bg-card/60 p-8 text-center">
        <Target className="w-10 h-10 mx-auto text-orange-400/40 mb-3" />
        <div className="font-mono text-sm text-muted-foreground">Live BTC bucket grid, round timer, and Agent-vs-Community recap render here.</div>
      </div>
    </div>
  );
}

function BrainFeed() {
  const [feed, setFeed] = useState(BRAIN_FEED);
  useEffect(() => {
    const id = setInterval(() => {
      const pick = BRAIN_FEED[Math.floor(Math.random() * BRAIN_FEED.length)];
      setFeed((f) => [{ ...pick, ago: "now" }, ...f.slice(0, 11)]);
    }, 3500);
    return () => clearInterval(id);
  }, []);
  return (
    <aside className="hidden lg:flex w-72 border-l bg-card/30 flex-col">
      <div className="px-4 py-3 border-b flex items-center gap-2">
        <Brain className="w-3.5 h-3.5 text-primary" />
        <span className="font-mono text-xs tracking-widest uppercase text-muted-foreground">Live Brain</span>
        <div className="flex-1" />
        <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        <AnimatePresence initial={false}>
          {feed.map((e, i) => (
            <motion.div
              key={`${e.agent}-${e.ago}-${i}`}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="px-2 py-1.5 rounded hover:bg-background/50 font-mono text-[11px]"
            >
              <div className="flex items-center gap-1.5 text-[9px] text-muted-foreground tracking-widest uppercase mb-0.5">
                <span>{e.ago}</span>
                <span>·</span>
                <span className={e.color}>{e.venue}</span>
                <span>·</span>
                <span>{e.agent}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-foreground">
                  <span className={e.color}>{e.action}</span> {e.asset}
                </span>
                <span className="text-muted-foreground text-[10px]">{e.size}</span>
              </div>
              <div className="mt-1 h-0.5 rounded-full bg-border overflow-hidden">
                <div className={`h-full ${e.conf >= 75 ? "bg-primary" : e.conf >= 60 ? "bg-yellow-500" : "bg-muted-foreground"}`} style={{ width: `${e.conf}%` }} />
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      <div className="px-4 py-2 border-t font-mono text-[10px] text-muted-foreground tracking-widest uppercase flex items-center gap-1">
        <Activity className="w-3 h-3" /> {feed.length} decisions · last 5m
      </div>
    </aside>
  );
}

function TradeDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [side, setSide] = useState<"long" | "short">("long");
  const [size, setSize] = useState("100");
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
            className="fixed right-0 top-0 bottom-0 w-full sm:w-96 bg-card border-l z-50 flex flex-col"
          >
            <div className="px-5 py-4 border-b flex items-center justify-between">
              <div>
                <h3 className="font-mono text-sm tracking-widest uppercase">Trade Ticket</h3>
                <p className="text-xs text-muted-foreground mt-1">Aster Perps · BTCUSDT</p>
              </div>
              <button onClick={onClose}><X className="w-4 h-4 text-muted-foreground hover:text-foreground" /></button>
            </div>
            <div className="flex-1 p-5 space-y-5">
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setSide("long")}
                  className={`py-3 rounded-md font-mono text-xs tracking-widest uppercase border transition-all ${
                    side === "long" ? "bg-primary/15 border-primary/50 text-primary" : "border-border text-muted-foreground"
                  }`}
                >Long</button>
                <button
                  onClick={() => setSide("short")}
                  className={`py-3 rounded-md font-mono text-xs tracking-widest uppercase border transition-all ${
                    side === "short" ? "bg-destructive/15 border-destructive/50 text-destructive" : "border-border text-muted-foreground"
                  }`}
                >Short</button>
              </div>
              <div>
                <label className="font-mono text-[10px] tracking-widest uppercase text-muted-foreground">Size (USDT)</label>
                <input
                  value={size}
                  onChange={(e) => setSize(e.target.value)}
                  className="mt-1 w-full bg-background border rounded-md px-3 py-3 font-mono text-lg focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <div className="flex gap-2 mt-2">
                  {["50", "100", "250", "MAX"].map((q) => (
                    <button key={q} onClick={() => setSize(q === "MAX" ? "4820" : q)}
                      className="flex-1 py-1.5 rounded border font-mono text-[10px] tracking-widest text-muted-foreground hover:text-foreground hover:bg-background transition-all">
                      {q}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="font-mono text-[10px] tracking-widest uppercase text-muted-foreground">Leverage</label>
                <div className="grid grid-cols-5 gap-1.5 mt-1">
                  {["1x", "2x", "5x", "10x", "20x"].map((l) => (
                    <button key={l} className={`py-2 rounded font-mono text-xs border transition-all ${
                      l === "5x" ? "bg-primary/15 border-primary/50 text-primary" : "border-border text-muted-foreground hover:text-foreground"
                    }`}>{l}</button>
                  ))}
                </div>
              </div>
              <div className="rounded-md border bg-background/60 p-3 space-y-1.5 font-mono text-[11px]">
                <Row k="Entry (est)" v="$63,890" />
                <Row k="Liquidation (est)" v="$58,420" />
                <Row k="Fee" v="$0.20" />
                <Row k="Slippage cap" v="0.5%" />
              </div>
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-mono">
                <Lock className="w-3 h-3" /> Custodial — bot signs from your master account
              </div>
            </div>
            <div className="p-5 border-t">
              <Button className="w-full font-mono tracking-widest text-xs uppercase h-11" data-testid="button-confirm-trade">
                Confirm {side === "long" ? "Long" : "Short"} · ${size}
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
  const openTrade = () => setDrawer(true);
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <StatusBar />
      <div className="flex-1 flex overflow-hidden">
        <IconRail active={venue} setActive={setVenue} />
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          {venue === "dashboard" && <DashboardPane onTrade={openTrade} />}
          {venue === "aster" && <PerpPane name="Aster Perps" sub="Custodial perpetual futures on Aster DEX. AI-routed, single-master account." accent="border-yellow-400/40 text-yellow-400" positions={ASTER_POSITIONS} onTrade={openTrade} />}
          {venue === "hyperliquid" && <PerpPane name="Hyperliquid" sub="L1 perps via agent wallet. Sub-second fills, on-chain orderbook." accent="border-cyan-400/40 text-cyan-400" positions={ASTER_POSITIONS.slice(0, 2)} onTrade={openTrade} />}
          {venue === "fourmeme" && <FourmemePane />}
          {venue === "polymarket" && <PolymarketPane onTrade={openTrade} />}
          {venue === "fortytwo" && <FortyTwoPane />}
        </main>
        <BrainFeed />
      </div>
      <TradeDrawer open={drawer} onClose={() => setDrawer(false)} />
    </div>
  );
}
