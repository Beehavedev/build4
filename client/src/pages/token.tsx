import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { SEO } from "@/components/seo";
import {
  ArrowLeft, Terminal, Coins, Flame, Lock, TrendingUp,
  Users, Briefcase, Shield, BarChart3, Rocket, Gift,
  RefreshCw, Vote, Zap, Star, ExternalLink, Wallet,
  PieChart, ArrowRight, DollarSign, Layers,
} from "lucide-react";

const TOTAL_SUPPLY = "1,000,000,000";
const TICKER = "$BUILD4";

const ALLOCATIONS = [
  { id: "founder", label: "Founder (Bought from Curve)", pct: 70, amount: "700,000,000", bgColor: "bg-primary", bgTint: "bg-primary/15", textColor: "text-primary", icon: Lock, note: "Purchased from Four.meme bonding curve — distributed to wallets below" },
  { id: "lp", label: "Liquidity (Auto-Burned)", pct: 20, amount: "200,000,000", bgColor: "bg-cyan-500", bgTint: "bg-cyan-500/15", textColor: "text-cyan-500", icon: Flame, note: "Auto-added to PancakeSwap LP on graduation. LP tokens burned by Four.meme" },
  { id: "public", label: "Public Buyers", pct: 10, amount: "100,000,000", bgColor: "bg-emerald-500", bgTint: "bg-emerald-500/15", textColor: "text-emerald-500", icon: Users, note: "Other buyers on the bonding curve before graduation" },
];

const DISTRIBUTION = [
  { id: "rewards", label: "Agent Economy Rewards", pct: 25, amount: "250,000,000", bgColor: "bg-blue-500", bgTint: "bg-blue-500/15", textColor: "text-blue-500", icon: Gift, note: "24-month release — rewards for hiring agents, top performers, referrals" },
  { id: "treasury", label: "Treasury / Operations", pct: 20, amount: "200,000,000", bgColor: "bg-amber-500", bgTint: "bg-amber-500/15", textColor: "text-amber-500", icon: Shield, note: "Platform development, server costs, buybacks. Multisig wallet" },
  { id: "marketing", label: "Marketing & Growth", pct: 10, amount: "100,000,000", bgColor: "bg-pink-500", bgTint: "bg-pink-500/15", textColor: "text-pink-500", icon: Rocket, note: "KOLs, exchange listings, campaigns, community airdrops" },
  { id: "reserve", label: "Founder Reserve", pct: 10, amount: "100,000,000", bgColor: "bg-purple-500", bgTint: "bg-purple-500/15", textColor: "text-purple-500", icon: Lock, note: "Strategic reserve for future exchange listings and partnerships" },
  { id: "team", label: "Team", pct: 5, amount: "50,000,000", bgColor: "bg-orange-500", bgTint: "bg-orange-500/15", textColor: "text-orange-500", icon: Briefcase, note: "6-month cliff, 12-month linear vest" },
];

const UTILITIES = [
  { icon: DollarSign, title: "Hire Agents at a Discount", desc: "Pay with $BUILD4 instead of BNB and get 20% off — $479 vs $599 per agent" },
  { icon: BarChart3, title: "Revenue Share", desc: "Stake $BUILD4 to earn a cut of the 20% profit fees collected from trading agents" },
  { icon: Star, title: "Premium Agent Roles", desc: "Unlock exclusive roles like Alpha Hunter and Whale Tracker by holding $BUILD4" },
  { icon: Zap, title: "Agent Boost", desc: "Stake tokens on your agent for priority in the sniper queue and higher trade allocation" },
  { icon: Vote, title: "Governance", desc: "Vote on fee structures, new agent roles, and platform direction" },
  { icon: Flame, title: "Buyback & Burn", desc: "30% of all agent hire fees buy $BUILD4 from the market — 50% burned, 50% to staking rewards" },
];

export default function TokenPage() {
  return (
    <>
      <SEO
        title="$BUILD4 Token | BUILD4"
        description="$BUILD4 — the token powering decentralized AI agent infrastructure on BNB Chain. Fair launch on Four.meme. Hire agents, earn revenue share, govern the platform."
        path="/token"
      />

      <div className="min-h-screen bg-background" data-testid="page-token">
        <header className="border-b sticky top-0 z-40 bg-background/95 backdrop-blur">
          <div className="max-w-5xl mx-auto px-4 sm:px-6">
            <div className="flex items-center justify-between h-14">
              <div className="flex items-center gap-3">
                <Link href="/">
                  <Button variant="ghost" size="icon" className="h-8 w-8" data-testid="button-back-home">
                    <ArrowLeft className="w-4 h-4" />
                  </Button>
                </Link>
                <div className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-primary" />
                  <span className="font-mono font-bold text-sm tracking-wider">BUILD<span className="text-primary">4</span></span>
                  <span className="text-muted-foreground font-mono text-xs hidden md:inline ml-1">/ {TICKER}</span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Link href="/hire-agent">
                  <Button variant="outline" size="sm" className="font-mono text-xs gap-1.5 h-8 px-3" data-testid="button-hire-agent">
                    <Briefcase className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Hire Agent</span>
                  </Button>
                </Link>
                <Link href="/autonomous-economy">
                  <Button variant="outline" size="sm" className="font-mono text-xs gap-1.5 h-8 px-3" data-testid="button-dashboard">
                    <Terminal className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Dashboard</span>
                  </Button>
                </Link>
              </div>
            </div>
          </div>
        </header>

        <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-10">

          <div className="text-center space-y-4 py-6" data-testid="token-hero">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border bg-primary/5 border-primary/20">
              <Coins className="w-4 h-4 text-primary" />
              <span className="font-mono text-xs text-primary font-semibold">BNB Chain · BEP-20</span>
            </div>
            <h1 className="font-mono text-4xl sm:text-5xl font-bold tracking-tight">
              <span className="text-primary">{TICKER}</span>
            </h1>
            <p className="font-mono text-sm text-muted-foreground max-w-xl mx-auto">
              The token powering decentralized AI agent infrastructure. Hire agents, earn revenue share, govern the platform.
            </p>
            <div className="flex items-center justify-center gap-3 pt-2">
              <Badge variant="secondary" className="font-mono text-xs gap-1.5 px-3 py-1">
                <PieChart className="w-3 h-3" /> Supply: {TOTAL_SUPPLY}
              </Badge>
              <Badge variant="secondary" className="font-mono text-xs gap-1.5 px-3 py-1">
                <Rocket className="w-3 h-3" /> Fair Launch on Four.meme
              </Badge>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Card className="p-5 text-center space-y-2" data-testid="stat-supply">
              <PieChart className="w-6 h-6 mx-auto text-primary" />
              <div className="font-mono text-lg font-bold">1B</div>
              <div className="font-mono text-[11px] text-muted-foreground">Total Supply</div>
            </Card>
            <Card className="p-5 text-center space-y-2" data-testid="stat-curve">
              <TrendingUp className="w-6 h-6 mx-auto text-cyan-500" />
              <div className="font-mono text-lg font-bold">80%</div>
              <div className="font-mono text-[11px] text-muted-foreground">Bonding Curve</div>
            </Card>
            <Card className="p-5 text-center space-y-2" data-testid="stat-lp">
              <Flame className="w-6 h-6 mx-auto text-amber-500" />
              <div className="font-mono text-lg font-bold">20%</div>
              <div className="font-mono text-[11px] text-muted-foreground">LP Auto-Burned</div>
            </Card>
            <Card className="p-5 text-center space-y-2" data-testid="stat-chain">
              <Layers className="w-6 h-6 mx-auto text-emerald-500" />
              <div className="font-mono text-lg font-bold">BNB Chain</div>
              <div className="font-mono text-[11px] text-muted-foreground">BEP-20 Token</div>
            </Card>
          </div>

          <div className="space-y-5" data-testid="section-tokenomics">
            <div className="flex items-center gap-2">
              <PieChart className="w-5 h-5 text-primary" />
              <h2 className="font-mono text-lg font-bold">Tokenomics</h2>
            </div>

            <p className="font-mono text-xs text-muted-foreground">
              Launched on Four.meme. 80% of supply enters the bonding curve, 20% auto-added to PancakeSwap LP (burned on graduation).
            </p>

            <div className="w-full h-8 rounded-full overflow-hidden flex border" data-testid="tokenomics-bar">
              {ALLOCATIONS.map((a) => (
                <div
                  key={a.id}
                  className={`${a.bgColor} h-full relative group cursor-default`}
                  style={{ width: `${a.pct}%` }}
                  title={`${a.label}: ${a.pct}%`}
                >
                  {a.pct >= 10 && (
                    <span className="absolute inset-0 flex items-center justify-center font-mono text-[10px] text-white font-bold">
                      {a.pct}%
                    </span>
                  )}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {ALLOCATIONS.map((a) => {
                const Icon = a.icon;
                return (
                  <Card key={a.id} className="p-4 flex items-start gap-3" data-testid={`allocation-${a.id}`}>
                    <div className={`w-8 h-8 rounded-md ${a.bgTint} flex items-center justify-center flex-shrink-0`}>
                      <Icon className={`w-4 h-4 ${a.textColor}`} />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold">{a.label}</span>
                        <Badge variant="outline" className="text-[9px] font-mono">{a.pct}%</Badge>
                      </div>
                      <div className="font-mono text-xs text-primary mt-0.5">{a.amount} {TICKER}</div>
                      <p className="font-mono text-[11px] text-muted-foreground mt-1">{a.note}</p>
                    </div>
                  </Card>
                );
              })}
            </div>
          </div>

          <div className="space-y-5" data-testid="section-distribution">
            <div className="flex items-center gap-2">
              <Wallet className="w-5 h-5 text-primary" />
              <h2 className="font-mono text-lg font-bold">Founder Distribution (70%)</h2>
            </div>

            <p className="font-mono text-xs text-muted-foreground">
              The 700M tokens purchased from the bonding curve are distributed across these wallets. All addresses will be published on-chain.
            </p>

            <div className="w-full h-6 rounded-full overflow-hidden flex border" data-testid="distribution-bar">
              {DISTRIBUTION.map((d) => (
                <div
                  key={d.id}
                  className={`${d.bgColor} h-full relative group cursor-default`}
                  style={{ width: `${(d.pct / 70) * 100}%` }}
                  title={`${d.label}: ${d.pct}% of total`}
                >
                  {d.pct >= 10 && (
                    <span className="absolute inset-0 flex items-center justify-center font-mono text-[9px] text-white font-bold">
                      {d.pct}%
                    </span>
                  )}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {DISTRIBUTION.map((d) => {
                const Icon = d.icon;
                return (
                  <Card key={d.id} className="p-4 flex items-start gap-3" data-testid={`dist-${d.id}`}>
                    <div className={`w-8 h-8 rounded-md ${d.bgTint} flex items-center justify-center flex-shrink-0`}>
                      <Icon className={`w-4 h-4 ${d.textColor}`} />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold">{d.label}</span>
                        <Badge variant="outline" className="text-[9px] font-mono">{d.pct}%</Badge>
                      </div>
                      <div className="font-mono text-xs text-primary mt-0.5">{d.amount} {TICKER}</div>
                      <p className="font-mono text-[11px] text-muted-foreground mt-1">{d.note}</p>
                    </div>
                  </Card>
                );
              })}
            </div>
          </div>

          <div className="space-y-5" data-testid="section-utility">
            <div className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-primary" />
              <h2 className="font-mono text-lg font-bold">Token Utility</h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {UTILITIES.map((u) => {
                const Icon = u.icon;
                return (
                  <Card key={u.title} className="p-4 space-y-3" data-testid={`utility-${u.title.toLowerCase().replace(/\s+/g, '-')}`}>
                    <div className="flex items-center gap-2">
                      <div className="p-1.5 rounded-md bg-primary/10">
                        <Icon className="w-4 h-4 text-primary" />
                      </div>
                      <span className="font-mono text-sm font-semibold">{u.title}</span>
                    </div>
                    <p className="font-mono text-[11px] text-muted-foreground leading-relaxed">{u.desc}</p>
                  </Card>
                );
              })}
            </div>
          </div>

          <Card className="p-6 border-primary/20 bg-primary/5" data-testid="section-flywheel">
            <div className="flex items-center gap-2 mb-4">
              <RefreshCw className="w-5 h-5 text-primary" />
              <h2 className="font-mono text-lg font-bold">Revenue Flywheel</h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-5 gap-3 items-center">
              {[
                { step: "1", text: "Users hire agents", sub: "$599 in BNB" },
                { step: "2", text: "30% of fees buy $BUILD4", sub: "From open market" },
                { step: "3", text: "50% burned, 50% to stakers", sub: "Deflationary pressure" },
                { step: "4", text: "Reduced supply + yield", sub: "Value accrual" },
                { step: "5", text: "More users attracted", sub: "Cycle repeats" },
              ].map((item, i) => (
                <div key={item.step} className="text-center space-y-1.5">
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center font-mono text-sm font-bold text-primary mx-auto">
                    {item.step}
                  </div>
                  <div className="font-mono text-xs font-semibold">{item.text}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">{item.sub}</div>
                  {i < 4 && <ArrowRight className="w-4 h-4 text-muted-foreground mx-auto hidden sm:block mt-1" />}
                </div>
              ))}
            </div>
          </Card>

          <div className="space-y-5" data-testid="section-transparency">
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-primary" />
              <h2 className="font-mono text-lg font-bold">Transparency Commitments</h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Card className="p-4 flex items-start gap-3">
                <Flame className="w-5 h-5 text-emerald-500 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-mono text-sm font-semibold">LP Auto-Burned</div>
                  <p className="font-mono text-[11px] text-muted-foreground mt-1">LP tokens automatically burned by Four.meme on graduation — permanently locked</p>
                </div>
              </Card>
              <Card className="p-4 flex items-start gap-3">
                <Wallet className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-mono text-sm font-semibold">Public Wallets</div>
                  <p className="font-mono text-[11px] text-muted-foreground mt-1">All allocation wallets published with live on-chain balances</p>
                </div>
              </Card>
              <Card className="p-4 flex items-start gap-3">
                <Shield className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-mono text-sm font-semibold">Team Vesting</div>
                  <p className="font-mono text-[11px] text-muted-foreground mt-1">Team tokens in a vesting contract — 6-month cliff, 12-month linear vest</p>
                </div>
              </Card>
              <Card className="p-4 flex items-start gap-3">
                <BarChart3 className="w-5 h-5 text-purple-500 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-mono text-sm font-semibold">Quarterly Reports</div>
                  <p className="font-mono text-[11px] text-muted-foreground mt-1">Treasury reports posted publicly every quarter with full breakdown</p>
                </div>
              </Card>
            </div>
          </div>

          <Card className="p-6 text-center space-y-4 border-dashed" data-testid="section-contract">
            <Coins className="w-8 h-8 mx-auto text-primary" />
            <div>
              <h3 className="font-mono text-sm font-bold">Contract Address</h3>
              <p className="font-mono text-xs text-muted-foreground mt-1">Coming soon — launching on Four.meme</p>
            </div>
            <div className="flex items-center justify-center gap-3">
              <Link href="/hire-agent">
                <Button size="sm" className="font-mono text-xs gap-1.5" data-testid="button-hire-from-token">
                  <Briefcase className="w-3.5 h-3.5" /> Hire an Agent
                </Button>
              </Link>
            </div>
          </Card>

          <footer className="text-center py-6 border-t">
            <div className="flex items-center justify-center gap-2 mb-2">
              <Terminal className="w-4 h-4 text-primary" />
              <span className="font-mono font-bold text-sm">BUILD<span className="text-primary">4</span></span>
            </div>
            <p className="font-mono text-[11px] text-muted-foreground">
              Decentralized AI Agent Infrastructure on BNB Chain
            </p>
          </footer>
        </main>
      </div>
    </>
  );
}
