import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { SEO } from "@/components/seo";
import {
  ArrowLeft, Terminal, Code, Book, Rocket, Globe,
  Bot, Zap, Shield, Wallet, Brain, Package,
  ArrowRight, Copy, CheckCircle2, ChevronRight,
  Cpu, Settings, Lock, Gift, Star, Users,
  Layers, MessageSquare, Search, Activity,
} from "lucide-react";

const SDK_SECTIONS = [
  {
    id: "quickstart",
    title: "Quick Start",
    icon: Rocket,
    content: `import { BUILD4SDK } from '@build4/sdk';

const sdk = new BUILD4SDK({
  apiKey: 'your-api-key',
  chain: 'bnb', // bnb | base | xlayer
});

// Create an agent
const agent = await sdk.agents.create({
  name: 'My Trading Agent',
  template: 'trading',
  skills: ['market-scanner', 'trade-executor'],
  config: {
    autonomy: 'semi-auto',
    maxTradeSize: '0.1',
    chains: ['bnb', 'base'],
  },
});

console.log('Agent deployed:', agent.id);
console.log('Wallet:', agent.walletAddress);`,
  },
  {
    id: "agents",
    title: "Agent Management",
    icon: Bot,
    content: `// List your agents
const agents = await sdk.agents.list();

// Get agent details
const agent = await sdk.agents.get('agent-id');

// Update agent config
await sdk.agents.update('agent-id', {
  config: { maxTradeSize: '0.5' },
});

// Fund agent wallet
await sdk.agents.fund('agent-id', {
  amount: '0.1',
  token: 'BNB',
});

// Get agent activity log
const logs = await sdk.agents.logs('agent-id', {
  limit: 50,
  type: 'trade',
});

// Pause / resume agent
await sdk.agents.pause('agent-id');
await sdk.agents.resume('agent-id');`,
  },
  {
    id: "skills",
    title: "Skill Marketplace",
    icon: Brain,
    content: `// Browse available skills
const skills = await sdk.skills.list({
  category: 'trading',
  chain: 'bnb',
  sort: 'popular',
});

// Purchase a skill for your agent
await sdk.skills.purchase({
  skillId: 'whale-detector-v2',
  agentId: 'your-agent-id',
});

// Create and publish your own skill
const skill = await sdk.skills.create({
  name: 'Custom Signal Detector',
  category: 'trading',
  description: 'Detects buy signals from...',
  price: '0.01', // in BNB
  code: mySkillCode,
});

await sdk.skills.publish(skill.id);`,
  },
  {
    id: "trading",
    title: "Trading API",
    icon: Activity,
    content: `// Get market signals
const signals = await sdk.market.signals({
  chain: 'bnb',
  type: 'whale', // whale | kol | smart
});

// Get trending tokens
const trending = await sdk.market.trending({
  chain: 'bnb',
  timeFrame: '24h',
  sortBy: 'volume',
});

// Execute a swap
const tx = await sdk.trade.swap({
  agentId: 'your-agent-id',
  fromToken: 'BNB',
  toToken: '0x...tokenAddress',
  amount: '0.05',
  slippage: 1, // percent
});

// Get token security info
const security = await sdk.market.security({
  chain: 'bnb',
  token: '0x...tokenAddress',
});`,
  },
  {
    id: "webhooks",
    title: "Webhooks & Events",
    icon: Zap,
    content: `// Register a webhook
await sdk.webhooks.create({
  url: 'https://your-server.com/webhook',
  events: [
    'agent.trade.executed',
    'agent.skill.purchased',
    'agent.reward.earned',
    'agent.status.changed',
  ],
});

// Listen to real-time events
sdk.events.on('trade.executed', (event) => {
  console.log('Trade:', event.token, event.amount);
  console.log('PnL:', event.pnl);
});

sdk.events.on('reward.earned', (event) => {
  console.log('Reward:', event.amount, 'BUILD4');
});`,
  },
  {
    id: "onchain",
    title: "On-Chain Operations",
    icon: Layers,
    content: `// Deploy agent on-chain (ERC8004 identity)
const identity = await sdk.onchain.register({
  agentId: 'your-agent-id',
  chain: 'bnb',
});

// Read agent reputation
const rep = await sdk.onchain.reputation('agent-id');
console.log('Score:', rep.score);
console.log('Validations:', rep.totalValidations);

// Stake BUILD4 tokens
await sdk.staking.stake({
  amount: '1000',
  lockDays: 90,
});

// Check staking status & fee discount tier
const stakeInfo = await sdk.staking.status();
console.log('Tier:', stakeInfo.tier, 'Discount:', stakeInfo.feeDiscount);`,
  },
];

const API_ENDPOINTS = [
  { method: "POST", path: "/api/v1/agents", desc: "Create a new agent" },
  { method: "GET", path: "/api/v1/agents", desc: "List your agents" },
  { method: "GET", path: "/api/v1/agents/:id", desc: "Get agent details" },
  { method: "PATCH", path: "/api/v1/agents/:id", desc: "Update agent config" },
  { method: "POST", path: "/api/v1/agents/:id/fund", desc: "Fund agent wallet" },
  { method: "POST", path: "/api/v1/agents/:id/pause", desc: "Pause agent" },
  { method: "POST", path: "/api/v1/agents/:id/resume", desc: "Resume agent" },
  { method: "GET", path: "/api/v1/skills", desc: "List marketplace skills" },
  { method: "POST", path: "/api/v1/skills", desc: "Create a skill" },
  { method: "POST", path: "/api/v1/skills/:id/purchase", desc: "Purchase a skill" },
  { method: "GET", path: "/api/v1/market/signals", desc: "Get market signals" },
  { method: "GET", path: "/api/v1/market/trending", desc: "Get trending tokens" },
  { method: "GET", path: "/api/v1/market/security/:token", desc: "Token security scan" },
  { method: "POST", path: "/api/v1/trade/swap", desc: "Execute a swap" },
  { method: "POST", path: "/api/v1/webhooks", desc: "Register webhook" },
  { method: "POST", path: "/api/v1/staking/stake", desc: "Stake BUILD4 tokens" },
  { method: "GET", path: "/api/v1/staking/status", desc: "Check staking status & fee tier" },
];

export default function SDKPage() {
  const [activeSection, setActiveSection] = useState("quickstart");
  const [copied, setCopied] = useState(false);

  const section = SDK_SECTIONS.find(s => s.id === activeSection)!;

  const handleCopy = () => {
    navigator.clipboard.writeText(section.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <SEO
        title="Developer SDK | BUILD4"
        description="Build on BUILD4 with our SDK. Create agents, integrate skills, execute trades, and tap into the agent economy programmatically."
        path="/sdk"
      />

      <div className="min-h-screen bg-background" data-testid="page-sdk">
        <div className="bg-amber-500/10 border-b border-amber-500/30">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-2">
            <p className="font-mono text-xs text-amber-400 text-center" data-testid="text-sdk-preview-notice">
              SDK Preview — The @build4/sdk package is not yet published to npm. Code examples below show the planned API design.
            </p>
          </div>
        </div>
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
                  <span className="text-muted-foreground font-mono text-xs hidden md:inline ml-1">/ Developer SDK</span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Link href="/build">
                  <Button variant="outline" size="sm" className="font-mono text-xs gap-1.5 h-8 px-3" data-testid="button-builder">
                    <Bot className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Builder</span>
                  </Button>
                </Link>
                <Link href="/agent-store">
                  <Button variant="outline" size="sm" className="font-mono text-xs gap-1.5 h-8 px-3" data-testid="button-store">
                    <Globe className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Store</span>
                  </Button>
                </Link>
              </div>
            </div>
          </div>
        </header>

        <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-8">

          <div className="text-center space-y-4 py-4" data-testid="sdk-hero">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border bg-primary/5 border-primary/20">
              <Code className="w-4 h-4 text-primary" />
              <span className="font-mono text-xs text-primary font-semibold">DEVELOPER SDK</span>
            </div>
            <h1 className="font-mono text-3xl sm:text-4xl font-bold tracking-tight">
              Build on <span className="text-primary">BUILD4</span>
            </h1>
            <p className="font-mono text-sm text-muted-foreground max-w-xl mx-auto">
              Full SDK for creating agents, integrating skills, executing trades, and tapping into the autonomous agent economy. TypeScript first.
            </p>
            <div className="flex items-center justify-center gap-3">
              <Badge variant="secondary" className="font-mono text-xs gap-1 px-3 py-1">
                <Package className="w-3 h-3" /> npm i @build4/sdk
              </Badge>
              <Badge variant="outline" className="font-mono text-xs gap-1 px-3 py-1">
                <Star className="w-3 h-3" /> TypeScript
              </Badge>
            </div>
          </div>

          <Card className="p-4 bg-muted/30 border-dashed" data-testid="install-command">
            <div className="flex items-center justify-between">
              <code className="font-mono text-sm text-primary">$ npm install @build4/sdk</code>
              <Button variant="ghost" size="sm" className="font-mono text-xs gap-1 h-7" onClick={() => { navigator.clipboard.writeText("npm install @build4/sdk"); }} data-testid="button-copy-install">
                <Copy className="w-3 h-3" /> Copy
              </Button>
            </div>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            <div className="lg:col-span-1 space-y-1" data-testid="sdk-nav">
              {SDK_SECTIONS.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setActiveSection(s.id)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors ${
                    activeSection === s.id ? "bg-primary/10 text-primary" : "hover:bg-muted text-muted-foreground"
                  }`}
                  data-testid={`button-section-${s.id}`}
                >
                  <s.icon className="w-4 h-4" />
                  <span className="font-mono text-xs font-semibold">{s.title}</span>
                </button>
              ))}
            </div>

            <div className="lg:col-span-3">
              <Card className="overflow-hidden" data-testid="code-panel">
                <div className="flex items-center justify-between px-4 py-2 bg-muted/50 border-b">
                  <div className="flex items-center gap-2">
                    <section.icon className="w-4 h-4 text-primary" />
                    <span className="font-mono text-xs font-bold">{section.title}</span>
                  </div>
                  <Button variant="ghost" size="sm" className="font-mono text-[10px] gap-1 h-6" onClick={handleCopy} data-testid="button-copy-code">
                    {copied ? <CheckCircle2 className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
                <pre className="p-4 overflow-x-auto text-sm font-mono leading-relaxed">
                  <code className="text-foreground/90">{section.content}</code>
                </pre>
              </Card>
            </div>
          </div>

          <div className="space-y-4" data-testid="api-reference">
            <div className="flex items-center gap-2">
              <Book className="w-5 h-5 text-primary" />
              <h2 className="font-mono text-lg font-bold">API Reference</h2>
            </div>

            <Card className="overflow-hidden">
              <div className="divide-y">
                {API_ENDPOINTS.map((ep, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30 transition-colors" data-testid={`api-endpoint-${i}`}>
                    <Badge
                      variant={ep.method === "GET" ? "secondary" : "default"}
                      className={`font-mono text-[9px] w-14 justify-center ${
                        ep.method === "GET" ? "" : ep.method === "POST" ? "bg-emerald-600" : "bg-amber-600"
                      }`}
                    >
                      {ep.method}
                    </Badge>
                    <code className="font-mono text-xs text-primary flex-1">{ep.path}</code>
                    <span className="font-mono text-[10px] text-muted-foreground hidden sm:block">{ep.desc}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4" data-testid="sdk-features">
            <Card className="p-5 space-y-3">
              <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                <Shield className="w-5 h-5 text-primary" />
              </div>
              <h3 className="font-mono text-sm font-bold">API Key Auth</h3>
              <p className="font-mono text-[11px] text-muted-foreground">
                Secure API key authentication with rate limiting, scoped permissions, and webhook signature verification.
              </p>
            </Card>
            <Card className="p-5 space-y-3">
              <div className="w-10 h-10 rounded-lg bg-cyan-500/10 flex items-center justify-center">
                <Cpu className="w-5 h-5 text-cyan-500" />
              </div>
              <h3 className="font-mono text-sm font-bold">Multi-Chain</h3>
              <p className="font-mono text-[11px] text-muted-foreground">
                Deploy and manage agents across Base, BNB Chain, XLayer, Ethereum, and Solana from a single SDK.
              </p>
            </Card>
            <Card className="p-5 space-y-3">
              <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                <Gift className="w-5 h-5 text-emerald-500" />
              </div>
              <h3 className="font-mono text-sm font-bold">Revenue Share</h3>
              <p className="font-mono text-[11px] text-muted-foreground">
                Earn from every agent deployed using your skills or templates. Automatic on-chain revenue distribution.
              </p>
            </Card>
          </div>

          <footer className="text-center py-6 border-t">
            <div className="flex items-center justify-center gap-2 mb-2">
              <Terminal className="w-4 h-4 text-primary" />
              <span className="font-mono font-bold text-sm">BUILD<span className="text-primary">4</span></span>
            </div>
            <p className="font-mono text-[11px] text-muted-foreground">
              Build the agent economy. Ship autonomous AI.
            </p>
          </footer>
        </main>
      </div>
    </>
  );
}
