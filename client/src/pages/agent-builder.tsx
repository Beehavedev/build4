import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link } from "wouter";
import { SEO } from "@/components/seo";
import {
  ArrowLeft, Terminal, Bot, Brain, Zap, Shield,
  Plus, Layers, Settings, Wallet, Code, Rocket,
  TrendingUp, MessageSquare, Search, BarChart3,
  Eye, Globe, Lock, CheckCircle2, ArrowRight,
  Cpu, Gift, Star, Users, Activity, Package,
} from "lucide-react";

const AGENT_TEMPLATES = [
  {
    id: "trading",
    name: "Trading Agent",
    desc: "Autonomous trading agent that monitors markets, identifies opportunities, and executes trades across DEXs",
    icon: TrendingUp,
    color: "text-emerald-500",
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/20",
    skills: ["Market Scanner", "Signal Detector", "Trade Executor", "Risk Manager"],
    chains: ["BNB", "Base", "Solana"],
    popular: true,
  },
  {
    id: "research",
    name: "Research Agent",
    desc: "Deep analysis agent that researches tokens, projects, and on-chain data to produce actionable reports",
    icon: Search,
    color: "text-blue-500",
    bg: "bg-blue-500/10",
    border: "border-blue-500/20",
    skills: ["Token Analyzer", "Contract Auditor", "Whale Tracker", "Report Generator"],
    chains: ["BNB", "Base", "Ethereum"],
    popular: true,
  },
  {
    id: "social",
    name: "Social Agent",
    desc: "Content creation and engagement agent for Twitter/X, Telegram, and Discord with autonomous posting",
    icon: MessageSquare,
    color: "text-violet-500",
    bg: "bg-violet-500/10",
    border: "border-violet-500/20",
    skills: ["Content Writer", "Trend Monitor", "Community Manager", "Engagement Bot"],
    chains: ["BNB", "Base"],
    popular: false,
  },
  {
    id: "defi",
    name: "DeFi Agent",
    desc: "Yield optimization agent that finds the best farming opportunities, manages positions, and compounds returns",
    icon: Layers,
    color: "text-cyan-500",
    bg: "bg-cyan-500/10",
    border: "border-cyan-500/20",
    skills: ["Yield Scanner", "LP Manager", "Auto Compounder", "Gas Optimizer"],
    chains: ["BNB", "Base", "Ethereum"],
    popular: false,
  },
  {
    id: "security",
    name: "Security Agent",
    desc: "Contract security scanner that audits tokens, detects rug pulls, and monitors wallet activity for threats",
    icon: Shield,
    color: "text-amber-500",
    bg: "bg-amber-500/10",
    border: "border-amber-500/20",
    skills: ["Contract Scanner", "Honeypot Detector", "Rug Analyzer", "Wallet Monitor"],
    chains: ["BNB", "Base", "Ethereum", "Solana"],
    popular: false,
  },
  {
    id: "custom",
    name: "Custom Agent",
    desc: "Start from scratch and build your own agent with custom skills, strategies, and personality",
    icon: Code,
    color: "text-primary",
    bg: "bg-primary/10",
    border: "border-primary/20",
    skills: ["Add your own skills"],
    chains: ["All chains"],
    popular: false,
  },
];

const BUILD_STEPS = [
  { step: 1, title: "Choose Template", desc: "Pick a starting template or start from scratch", icon: Package },
  { step: 2, title: "Configure Skills", desc: "Add skills from the marketplace or create your own", icon: Brain },
  { step: 3, title: "Set Strategy", desc: "Define behavior rules, risk limits, and autonomy level", icon: Settings },
  { step: 4, title: "Fund Wallet", desc: "Deposit BNB/tokens to give your agent operating funds", icon: Wallet },
  { step: 5, title: "Deploy", desc: "Launch your agent on-chain and start earning", icon: Rocket },
];

export default function AgentBuilder() {
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [agentName, setAgentName] = useState("");
  const [step, setStep] = useState(0);

  return (
    <>
      <SEO
        title="Agent Builder Studio | BUILD4"
        description="Build, configure, and deploy autonomous AI agents on BNB Chain. No coding required. Choose from templates or build custom."
        path="/build"
      />

      <div className="min-h-screen bg-background" data-testid="page-agent-builder">
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
                  <span className="text-muted-foreground font-mono text-xs hidden md:inline ml-1">/ Agent Builder</span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Link href="/agent-store">
                  <Button variant="outline" size="sm" className="font-mono text-xs gap-1.5 h-8 px-3" data-testid="button-store">
                    <Globe className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Agent Store</span>
                  </Button>
                </Link>
                <Link href="/sdk">
                  <Button variant="outline" size="sm" className="font-mono text-xs gap-1.5 h-8 px-3" data-testid="button-sdk">
                    <Code className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">SDK</span>
                  </Button>
                </Link>
              </div>
            </div>
          </div>
        </header>

        <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-8">

          <div className="text-center space-y-4 py-4" data-testid="builder-hero">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border bg-primary/5 border-primary/20">
              <Bot className="w-4 h-4 text-primary" />
              <span className="font-mono text-xs text-primary font-semibold">AGENT BUILDER STUDIO</span>
            </div>
            <h1 className="font-mono text-3xl sm:text-4xl font-bold tracking-tight">
              Build Your <span className="text-primary">AI Agent</span>
            </h1>
            <p className="font-mono text-sm text-muted-foreground max-w-xl mx-auto">
              Create autonomous AI agents that trade, research, and earn on their own. Pick a template, add skills, deploy on-chain. No coding required.
            </p>
          </div>

          <div className="flex items-center justify-between p-4 rounded-lg bg-muted/30 border" data-testid="build-progress">
            {BUILD_STEPS.map((s, i) => (
              <div key={s.step} className="flex items-center gap-2 flex-1">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                  i <= step ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                }`}>
                  <s.icon className="w-4 h-4" />
                </div>
                <div className="hidden lg:block">
                  <div className={`font-mono text-[11px] font-semibold ${i <= step ? "text-primary" : "text-muted-foreground"}`}>
                    {s.title}
                  </div>
                  <div className="font-mono text-[9px] text-muted-foreground">{s.desc}</div>
                </div>
                {i < BUILD_STEPS.length - 1 && (
                  <div className={`flex-1 h-px mx-2 ${i < step ? "bg-primary" : "bg-border"}`} />
                )}
              </div>
            ))}
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Package className="w-5 h-5 text-primary" />
                <h2 className="font-mono text-lg font-bold">Choose a Template</h2>
              </div>
              <Badge variant="secondary" className="font-mono text-[10px]">{AGENT_TEMPLATES.length} templates</Badge>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="template-grid">
              {AGENT_TEMPLATES.map((t) => (
                <Card
                  key={t.id}
                  className={`p-5 space-y-3 cursor-pointer transition-all hover:shadow-md ${
                    selectedTemplate === t.id ? `ring-2 ring-primary ${t.bg}` : ""
                  }`}
                  onClick={() => { setSelectedTemplate(t.id); setStep(1); }}
                  data-testid={`template-${t.id}`}
                >
                  <div className="flex items-start justify-between">
                    <div className={`w-10 h-10 rounded-lg ${t.bg} flex items-center justify-center`}>
                      <t.icon className={`w-5 h-5 ${t.color}`} />
                    </div>
                    {t.popular && <Badge className="font-mono text-[9px]">Popular</Badge>}
                  </div>
                  <div>
                    <h3 className="font-mono text-sm font-bold">{t.name}</h3>
                    <p className="font-mono text-[11px] text-muted-foreground mt-1">{t.desc}</p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {t.skills.map((s) => (
                      <Badge key={s} variant="secondary" className="font-mono text-[9px]">{s}</Badge>
                    ))}
                  </div>
                  <div className="flex items-center gap-1">
                    {t.chains.map((c) => (
                      <Badge key={c} variant="outline" className="font-mono text-[8px] px-1.5">{c}</Badge>
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          </div>

          {selectedTemplate && (
            <Card className="p-6 space-y-5" data-testid="config-panel">
              <div className="flex items-center gap-2">
                <Settings className="w-5 h-5 text-primary" />
                <h2 className="font-mono text-base font-bold">Configure Your Agent</h2>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="font-mono text-xs text-muted-foreground">Agent Name</label>
                  <Input
                    placeholder="My Trading Agent"
                    value={agentName}
                    onChange={(e) => setAgentName(e.target.value)}
                    className="font-mono"
                    data-testid="input-agent-name"
                  />
                </div>
                <div className="space-y-2">
                  <label className="font-mono text-xs text-muted-foreground">Primary Chain</label>
                  <select className="w-full h-10 px-3 rounded-md border bg-background font-mono text-sm" data-testid="select-chain">
                    <option value="56">BNB Chain</option>
                    <option value="8453">Base</option>
                    <option value="196">XLayer</option>
                    <option value="1">Ethereum</option>
                    <option value="501">Solana</option>
                  </select>
                </div>
              </div>

              <div className="space-y-3">
                <label className="font-mono text-xs text-muted-foreground">Autonomy Level</label>
                <div className="grid grid-cols-3 gap-3" data-testid="autonomy-selector">
                  <button className="p-3 rounded-lg border-2 border-border hover:border-primary/30 text-center transition-all" data-testid="button-autonomy-supervised">
                    <Eye className="w-4 h-4 mx-auto text-muted-foreground mb-1" />
                    <div className="font-mono text-xs font-bold">Supervised</div>
                    <div className="font-mono text-[9px] text-muted-foreground">Approves before acting</div>
                  </button>
                  <button className="p-3 rounded-lg border-2 border-primary bg-primary/5 text-center transition-all" data-testid="button-autonomy-semi">
                    <Settings className="w-4 h-4 mx-auto text-primary mb-1" />
                    <div className="font-mono text-xs font-bold">Semi-Auto</div>
                    <div className="font-mono text-[9px] text-muted-foreground">Acts within limits</div>
                  </button>
                  <button className="p-3 rounded-lg border-2 border-border hover:border-primary/30 text-center transition-all" data-testid="button-autonomy-full">
                    <Zap className="w-4 h-4 mx-auto text-muted-foreground mb-1" />
                    <div className="font-mono text-xs font-bold">Full Auto</div>
                    <div className="font-mono text-[9px] text-muted-foreground">Complete autonomy</div>
                  </button>
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="font-mono text-xs text-muted-foreground">Skills</label>
                  <Link href="/marketplace">
                    <Button variant="ghost" size="sm" className="font-mono text-[10px] gap-1 h-6 px-2" data-testid="button-browse-skills">
                      <Plus className="w-3 h-3" /> Browse Marketplace
                    </Button>
                  </Link>
                </div>
                <div className="flex flex-wrap gap-2">
                  {AGENT_TEMPLATES.find(t => t.id === selectedTemplate)?.skills.map((s) => (
                    <Badge key={s} className="font-mono text-xs gap-1 px-3 py-1">
                      <CheckCircle2 className="w-3 h-3" /> {s}
                    </Badge>
                  ))}
                  <Button variant="outline" size="sm" className="font-mono text-[10px] gap-1 h-7" data-testid="button-add-skill">
                    <Plus className="w-3 h-3" /> Add Skill
                  </Button>
                </div>
              </div>

              <div className="flex gap-3 pt-2">
                <Button className="flex-1 font-mono text-sm gap-2" data-testid="button-deploy-agent">
                  <Rocket className="w-4 h-4" /> Deploy Agent
                </Button>
                <Button variant="outline" className="font-mono text-sm gap-2" data-testid="button-preview">
                  <Eye className="w-4 h-4" /> Preview
                </Button>
              </div>
            </Card>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4" data-testid="builder-features">
            <Card className="p-5 space-y-3">
              <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                <Wallet className="w-5 h-5 text-emerald-500" />
              </div>
              <h3 className="font-mono text-sm font-bold">Own Wallet</h3>
              <p className="font-mono text-[11px] text-muted-foreground">
                Every agent gets its own on-chain wallet. It can receive funds, pay for services, and execute trades independently.
              </p>
            </Card>
            <Card className="p-5 space-y-3">
              <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                <Brain className="w-5 h-5 text-blue-500" />
              </div>
              <h3 className="font-mono text-sm font-bold">Self-Improving</h3>
              <p className="font-mono text-[11px] text-muted-foreground">
                Agents learn from outcomes, adjust strategies, and can purchase new skills from the marketplace to get smarter.
              </p>
            </Card>
            <Card className="p-5 space-y-3">
              <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center">
                <Gift className="w-5 h-5 text-amber-500" />
              </div>
              <h3 className="font-mono text-sm font-bold">Earn Revenue</h3>
              <p className="font-mono text-[11px] text-muted-foreground">
                Agents earn from trading profits, skill sales, and task completion. Creators get revenue share from agent activity.
              </p>
            </Card>
          </div>

          <Card className="p-6 text-center space-y-4 bg-primary/5 border-primary/20" data-testid="cta-section">
            <h2 className="font-mono text-lg font-bold">Ready to Build?</h2>
            <p className="font-mono text-xs text-muted-foreground max-w-md mx-auto">
              Join the agent economy. Build agents that work for you 24/7, earn revenue, and evolve on their own.
            </p>
            <div className="flex items-center justify-center gap-3">
              <Link href="/sdk">
                <Button variant="outline" size="sm" className="font-mono text-xs gap-1.5" data-testid="button-view-sdk">
                  <Code className="w-3.5 h-3.5" /> Developer SDK
                </Button>
              </Link>
              <Link href="/agent-store">
                <Button size="sm" className="font-mono text-xs gap-1.5" data-testid="button-browse-store">
                  <Globe className="w-3.5 h-3.5" /> Browse Agents
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
              The Replit of AI Agents. Build, deploy, monetize.
            </p>
          </footer>
        </main>
      </div>
    </>
  );
}
