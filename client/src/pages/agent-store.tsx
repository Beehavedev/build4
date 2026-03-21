import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link } from "wouter";
import { SEO } from "@/components/seo";
import {
  ArrowLeft, Terminal, Bot, Star, Users, TrendingUp,
  Search, Globe, Code, Shield, MessageSquare, Layers,
  Zap, BarChart3, Rocket, Eye, ArrowRight, Activity,
  CheckCircle2, Clock, Wallet, Filter, Lock,
} from "lucide-react";

const FEATURED_AGENTS = [
  {
    id: "alpha-hunter",
    name: "Alpha Hunter v3",
    creator: "BUILD4 Labs",
    desc: "Multi-chain trading agent that identifies alpha before the crowd. Tracks whale wallets, new liquidity, and social sentiment.",
    icon: TrendingUp,
    color: "text-emerald-500",
    bg: "bg-emerald-500/10",
    rating: 4.8,
    users: 2847,
    category: "Trading",
    chains: ["BNB", "Base", "Solana"],
    verified: true,
    featured: true,
  },
  {
    id: "sentinel",
    name: "Sentinel Security",
    creator: "CryptoGuard DAO",
    desc: "Real-time contract auditing agent. Scans new deployments for honeypots, rug vectors, and suspicious patterns.",
    icon: Shield,
    color: "text-amber-500",
    bg: "bg-amber-500/10",
    rating: 4.9,
    users: 1923,
    category: "Security",
    chains: ["BNB", "Base", "Ethereum"],
    verified: true,
    featured: true,
  },
  {
    id: "yield-max",
    name: "YieldMax Pro",
    creator: "DeFi Architects",
    desc: "Automated yield farming agent that finds optimal positions, auto-compounds, and rebalances across protocols.",
    icon: Layers,
    color: "text-cyan-500",
    bg: "bg-cyan-500/10",
    rating: 4.6,
    users: 1456,
    category: "DeFi",
    chains: ["BNB", "Base"],
    verified: true,
    featured: false,
  },
  {
    id: "social-pulse",
    name: "Social Pulse",
    creator: "MediaAI Corp",
    desc: "Social media intelligence agent. Monitors Twitter, Telegram, and Discord for alpha signals and sentiment shifts.",
    icon: MessageSquare,
    color: "text-violet-500",
    bg: "bg-violet-500/10",
    rating: 4.5,
    users: 892,
    category: "Social",
    chains: ["BNB"],
    verified: true,
    featured: false,
  },
  {
    id: "mev-shield",
    name: "MEV Shield",
    creator: "AntiBot Labs",
    desc: "Transaction protection agent. Routes trades through private mempools to prevent sandwich attacks and front-running.",
    icon: Lock,
    color: "text-red-500",
    bg: "bg-red-500/10",
    rating: 4.7,
    users: 673,
    category: "Security",
    chains: ["BNB", "Ethereum"],
    verified: false,
    featured: false,
  },
  {
    id: "research-gpt",
    name: "ResearchGPT",
    creator: "TokenLab",
    desc: "Deep research agent that produces comprehensive token reports with on-chain metrics, team analysis, and risk scoring.",
    icon: Search,
    color: "text-blue-500",
    bg: "bg-blue-500/10",
    rating: 4.4,
    users: 1204,
    category: "Research",
    chains: ["BNB", "Base", "Ethereum", "Solana"],
    verified: true,
    featured: false,
  },
  {
    id: "copy-trader",
    name: "CopyTrader AI",
    creator: "MirrorFi",
    desc: "Follow the smartest wallets automatically. Copies trades from top PnL wallets with configurable position sizing.",
    icon: Eye,
    color: "text-pink-500",
    bg: "bg-pink-500/10",
    rating: 4.3,
    users: 2156,
    category: "Trading",
    chains: ["BNB", "Solana"],
    verified: true,
    featured: false,
  },
  {
    id: "gas-master",
    name: "GasMaster",
    creator: "OptimizeDAO",
    desc: "Transaction optimization agent. Batches operations, times gas prices, and routes through the cheapest paths.",
    icon: Zap,
    color: "text-orange-500",
    bg: "bg-orange-500/10",
    rating: 4.2,
    users: 534,
    category: "Utility",
    chains: ["BNB", "Base", "Ethereum"],
    verified: false,
    featured: false,
  },
];

const CATEGORIES = ["All", "Trading", "Security", "DeFi", "Social", "Research", "Utility"];

export default function AgentStore() {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("All");

  const filtered = FEATURED_AGENTS.filter((a) => {
    const matchesSearch = !searchQuery || a.name.toLowerCase().includes(searchQuery.toLowerCase()) || a.desc.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = selectedCategory === "All" || a.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  return (
    <>
      <SEO
        title="Agent Store | BUILD4"
        description="Browse, deploy, and fork autonomous AI agents built by the community. Trading bots, security scanners, DeFi agents, and more."
        path="/agent-store"
      />

      <div className="min-h-screen bg-background" data-testid="page-agent-store">
        <header className="border-b sticky top-0 z-40 bg-background/95 backdrop-blur">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <div className="flex items-center justify-between h-14">
              <div className="flex items-center gap-3">
                <Link href="/">
                  <Button variant="ghost" size="icon" className="h-8 w-8" data-testid="button-back">
                    <ArrowLeft className="w-4 h-4" />
                  </Button>
                </Link>
                <div className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-primary" />
                  <span className="font-mono font-bold text-sm tracking-wider">BUILD<span className="text-primary">4</span></span>
                  <span className="text-muted-foreground font-mono text-xs hidden md:inline ml-1">/ Agent Store</span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Link href="/build">
                  <Button size="sm" className="font-mono text-xs gap-1.5 h-8 px-3" data-testid="button-build">
                    <Rocket className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Build Agent</span>
                  </Button>
                </Link>
              </div>
            </div>
          </div>
        </header>

        <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-8">

          <div className="text-center space-y-4 py-4" data-testid="store-hero">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border bg-primary/5 border-primary/20">
              <Globe className="w-4 h-4 text-primary" />
              <span className="font-mono text-xs text-primary font-semibold">AGENT STORE</span>
            </div>
            <h1 className="font-mono text-3xl sm:text-4xl font-bold tracking-tight">
              Discover <span className="text-primary">AI Agents</span>
            </h1>
            <p className="font-mono text-sm text-muted-foreground max-w-xl mx-auto">
              Browse autonomous agents built by the community. Deploy instantly, fork and customize, or build your own.
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4" data-testid="store-stats">
            <Card className="p-4 text-center space-y-1">
              <Bot className="w-5 h-5 mx-auto text-primary" />
              <div className="font-mono text-xl font-bold">{FEATURED_AGENTS.length}</div>
              <div className="font-mono text-[10px] text-muted-foreground">Agents Listed</div>
            </Card>
            <Card className="p-4 text-center space-y-1">
              <Users className="w-5 h-5 mx-auto text-cyan-500" />
              <div className="font-mono text-xl font-bold">{FEATURED_AGENTS.reduce((sum, a) => sum + a.users, 0).toLocaleString()}</div>
              <div className="font-mono text-[10px] text-muted-foreground">Total Deployments</div>
            </Card>
            <Card className="p-4 text-center space-y-1">
              <Star className="w-5 h-5 mx-auto text-amber-500" />
              <div className="font-mono text-xl font-bold">{(FEATURED_AGENTS.reduce((sum, a) => sum + a.rating, 0) / FEATURED_AGENTS.length).toFixed(1)}</div>
              <div className="font-mono text-[10px] text-muted-foreground">Avg Rating</div>
            </Card>
            <Card className="p-4 text-center space-y-1">
              <Activity className="w-5 h-5 mx-auto text-emerald-500" />
              <div className="font-mono text-xl font-bold">{CATEGORIES.length - 1}</div>
              <div className="font-mono text-[10px] text-muted-foreground">Categories</div>
            </Card>
          </div>

          <div className="flex flex-col sm:flex-row gap-3" data-testid="store-filters">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search agents..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 font-mono"
                data-testid="input-search-agents"
              />
            </div>
            <div className="flex gap-2 flex-wrap">
              {CATEGORIES.map((c) => (
                <Button
                  key={c}
                  variant={selectedCategory === c ? "default" : "outline"}
                  size="sm"
                  className="font-mono text-xs h-8"
                  onClick={() => setSelectedCategory(c)}
                  data-testid={`button-category-${c.toLowerCase()}`}
                >
                  {c}
                </Button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="agent-grid">
            {filtered.map((agent) => (
              <Card key={agent.id} className="p-5 space-y-4 hover:shadow-md transition-shadow" data-testid={`agent-card-${agent.id}`}>
                <div className="flex items-start justify-between">
                  <div className={`w-12 h-12 rounded-xl ${agent.bg} flex items-center justify-center`}>
                    <agent.icon className={`w-6 h-6 ${agent.color}`} />
                  </div>
                  <div className="flex items-center gap-1">
                    {agent.verified && (
                      <Badge className="font-mono text-[8px] gap-0.5 px-1.5">
                        <CheckCircle2 className="w-2.5 h-2.5" /> Verified
                      </Badge>
                    )}
                    {agent.featured && (
                      <Badge variant="secondary" className="font-mono text-[8px] gap-0.5 px-1.5">
                        <Star className="w-2.5 h-2.5" /> Featured
                      </Badge>
                    )}
                  </div>
                </div>

                <div>
                  <h3 className="font-mono text-sm font-bold">{agent.name}</h3>
                  <p className="font-mono text-[10px] text-muted-foreground mt-0.5">by {agent.creator}</p>
                  <p className="font-mono text-[11px] text-muted-foreground mt-2">{agent.desc}</p>
                </div>

                <div className="flex items-center gap-3 font-mono text-[10px] text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Star className="w-3 h-3 text-amber-500" /> {agent.rating}
                  </span>
                  <span className="flex items-center gap-1">
                    <Users className="w-3 h-3" /> {agent.users.toLocaleString()}
                  </span>
                  <Badge variant="outline" className="font-mono text-[8px]">{agent.category}</Badge>
                </div>

                <div className="flex items-center gap-1">
                  {agent.chains.map((c) => (
                    <Badge key={c} variant="outline" className="font-mono text-[8px] px-1.5">{c}</Badge>
                  ))}
                </div>

                <div className="flex gap-2">
                  <Button size="sm" className="flex-1 font-mono text-xs gap-1" data-testid={`button-deploy-${agent.id}`}>
                    <Rocket className="w-3 h-3" /> Deploy
                  </Button>
                  <Button variant="outline" size="sm" className="font-mono text-xs gap-1" data-testid={`button-fork-${agent.id}`}>
                    <Code className="w-3 h-3" /> Fork
                  </Button>
                </div>
              </Card>
            ))}
          </div>

          {filtered.length === 0 && (
            <div className="text-center py-12">
              <Bot className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
              <p className="font-mono text-sm text-muted-foreground">No agents found matching your search.</p>
              <Button variant="outline" size="sm" className="mt-4 font-mono text-xs" onClick={() => { setSearchQuery(""); setSelectedCategory("All"); }}>
                Clear Filters
              </Button>
            </div>
          )}

          <Card className="p-6 text-center space-y-4 bg-primary/5 border-primary/20" data-testid="cta-publish">
            <h2 className="font-mono text-lg font-bold">Publish Your Agent</h2>
            <p className="font-mono text-xs text-muted-foreground max-w-md mx-auto">
              Built something great? List it in the Agent Store and earn revenue every time someone deploys or forks your agent.
            </p>
            <div className="flex items-center justify-center gap-3">
              <Link href="/build">
                <Button size="sm" className="font-mono text-xs gap-1.5" data-testid="button-build-publish">
                  <Rocket className="w-3.5 h-3.5" /> Build and Publish
                </Button>
              </Link>
              <Link href="/sdk">
                <Button variant="outline" size="sm" className="font-mono text-xs gap-1.5" data-testid="button-sdk-link">
                  <Code className="w-3.5 h-3.5" /> SDK Docs
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
              The Agent Store. Build, deploy, earn.
            </p>
          </footer>
        </main>
      </div>
    </>
  );
}
