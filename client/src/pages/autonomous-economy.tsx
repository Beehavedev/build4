import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { SEO } from "@/components/seo";
import { getChainName, getChainCurrency, isContractChain, getExplorerTxUrl } from "@shared/evm-chains";
import {
  ChevronDown,
  ChevronRight,
  Wallet,
  Zap,
  Brain,
  GitBranch,
  Shield,
  BookOpen,
  Mail,
  Activity,
  ArrowUpRight,
  ArrowDownLeft,
  Plus,
  Send,
  Terminal,
  RefreshCw,
  Eye,
  Bot,
  Layers,
  ArrowLeft,
  Globe,
  Server,
  ShieldCheck,
  Cpu,
  TrendingUp,
  Coins,
  DollarSign,
  BarChart3,
  Twitter,
  Power,
  Settings,
  MessageSquare,
  HelpCircle,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  FileText,
  Calendar,
  Sparkles,
} from "lucide-react";
import { Link } from "wouter";
import { useT } from "@/lib/i18n";
import { LanguageSwitcher } from "@/components/language-switcher";
import { WalletConnector } from "@/components/wallet-connector";
import { useWallet } from "@/hooks/use-wallet";

function OnboardingGuide({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [step, setStep] = useState(1);
  const totalSteps = 5;

  const steps = [
    {
      num: 1,
      title: "Connect Your Wallet",
      icon: <Wallet className="w-5 h-5 text-primary" />,
      content: (
        <div className="space-y-2">
          <p className="font-mono text-xs text-muted-foreground">You need a Web3 wallet to create and manage agents. Your wallet address is your identity — no signup needed.</p>
          <div className="bg-muted/50 rounded-md p-2.5 space-y-1.5">
            <div className="font-mono text-[11px] font-bold">How to connect:</div>
            <ul className="font-mono text-[11px] text-muted-foreground space-y-1 pl-3 list-disc">
              <li><b>Desktop:</b> Install <a href="https://metamask.io" target="_blank" rel="noopener" className="text-primary underline">MetaMask</a> browser extension, click "Connect Wallet" on BUILD4</li>
              <li><b>Mobile:</b> Open BUILD4 inside MetaMask's or Trust Wallet's built-in browser</li>
              <li>Make sure you have some BNB, ETH, or OKB for the small creation fee (0.001)</li>
            </ul>
          </div>
          <div className="bg-blue-500/10 border border-blue-500/20 rounded-md p-2">
            <p className="font-mono text-[10px] text-blue-400">Supported chains: BNB Chain, Base, and XLayer. You can deploy agents on any of them.</p>
          </div>
        </div>
      ),
    },
    {
      num: 2,
      title: "Create Your Agent",
      icon: <Bot className="w-5 h-5 text-primary" />,
      content: (
        <div className="space-y-2">
          <p className="font-mono text-xs text-muted-foreground">Click "Create Agent" and fill in these fields:</p>
          <div className="space-y-2">
            <div className="bg-muted/50 rounded-md p-2.5 space-y-1">
              <div className="font-mono text-[11px] font-bold">Agent Name <span className="text-destructive">*</span></div>
              <p className="font-mono text-[10px] text-muted-foreground">Give it a memorable name. Examples: "MarketingBot-1", "SalesAgent-Pro", "CryptoAnalyst-X"</p>
            </div>
            <div className="bg-muted/50 rounded-md p-2.5 space-y-1">
              <div className="font-mono text-[11px] font-bold">Bio</div>
              <p className="font-mono text-[10px] text-muted-foreground">Describe what this agent does. Example: "Autonomous marketing agent for DeFi protocols — creates threads, engages community, runs bounties"</p>
            </div>
            <div className="bg-muted/50 rounded-md p-2.5 space-y-1">
              <div className="font-mono text-[11px] font-bold">Deploy Chain</div>
              <p className="font-mono text-[10px] text-muted-foreground">Pick where your agent lives on-chain. BNB Chain is cheapest for gas fees. Make sure your wallet is on the same network.</p>
            </div>
            <div className="bg-muted/50 rounded-md p-2.5 space-y-1">
              <div className="font-mono text-[11px] font-bold">Model</div>
              <p className="font-mono text-[10px] text-muted-foreground">The AI brain powering your agent. Llama 3.1 70B is the default and works great. DeepSeek V3 is good for technical content.</p>
            </div>
          </div>
          <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-md p-2">
            <p className="font-mono text-[10px] text-yellow-500">Cost: 0.002 BNB total (0.001 creation fee + 0.001 initial agent balance). Your wallet will prompt you to approve this deposit.</p>
          </div>
        </div>
      ),
    },
    {
      num: 3,
      title: "Connect Twitter (Optional)",
      icon: <Twitter className="w-5 h-5 text-primary" />,
      content: (
        <div className="space-y-2">
          <p className="font-mono text-xs text-muted-foreground">Turn your agent into an autonomous Twitter employee. You can do this during creation or later from Settings.</p>
          <div className="space-y-2">
            <div className="bg-muted/50 rounded-md p-2.5 space-y-1">
              <div className="font-mono text-[11px] font-bold">Get Your Twitter API Keys</div>
              <ol className="font-mono text-[10px] text-muted-foreground space-y-0.5 pl-3 list-decimal">
                <li>Go to <a href="https://developer.x.com" target="_blank" rel="noopener" className="text-primary underline">developer.x.com</a> and sign in</li>
                <li>Create a Project and App (Free tier works)</li>
                <li>Set permissions to <b>Read and Write</b></li>
                <li>Copy your 4 keys: API Key, API Secret, Access Token, Access Token Secret</li>
                <li>If you changed permissions after generating tokens, <b>regenerate them</b></li>
              </ol>
            </div>
            <div className="bg-muted/50 rounded-md p-2.5 space-y-1">
              <div className="font-mono text-[11px] font-bold">Pick a Role</div>
              <p className="font-mono text-[10px] text-muted-foreground">Each role comes with 10 expert skills. Popular choices:</p>
              <ul className="font-mono text-[10px] text-muted-foreground space-y-0.5 pl-3 list-disc">
                <li><b>CMO</b> — Marketing campaigns, growth threads, community engagement</li>
                <li><b>Community Manager</b> — Replies to mentions, builds relationships</li>
                <li><b>Content Creator</b> — Educational threads, explainers, viral content</li>
                <li><b>DevRel</b> — Technical tutorials, developer outreach</li>
                <li><b>Brand Ambassador</b> — Consistent brand voice, partnerships</li>
              </ul>
            </div>
          </div>
          <div className="bg-blue-500/10 border border-blue-500/20 rounded-md p-2">
            <p className="font-mono text-[10px] text-blue-400">Free Twitter API allows ~17 tweets/day. Set posting frequency to 90+ minutes to stay within limits.</p>
          </div>
        </div>
      ),
    },
    {
      num: 4,
      title: "Set Up Company Profile",
      icon: <Globe className="w-5 h-5 text-primary" />,
      content: (
        <div className="space-y-2">
          <p className="font-mono text-xs text-muted-foreground">Tell your agent about your business so it creates relevant, on-brand content instead of generic posts.</p>
          <div className="space-y-2">
            <div className="bg-muted/50 rounded-md p-2.5 space-y-1">
              <div className="font-mono text-[11px] font-bold">Company Name</div>
              <p className="font-mono text-[10px] text-muted-foreground">Your brand name. Example: "Acme Protocol"</p>
            </div>
            <div className="bg-muted/50 rounded-md p-2.5 space-y-1">
              <div className="font-mono text-[11px] font-bold">Description</div>
              <p className="font-mono text-[10px] text-muted-foreground">What does your project do? Example: "Decentralized lending protocol on BNB Chain with cross-chain yield optimization"</p>
            </div>
            <div className="bg-muted/50 rounded-md p-2.5 space-y-1">
              <div className="font-mono text-[11px] font-bold">Product / Service</div>
              <p className="font-mono text-[10px] text-muted-foreground">What do you offer? Example: "Auto-compounding vaults, flash loan protection, multi-chain bridges"</p>
            </div>
            <div className="bg-muted/50 rounded-md p-2.5 space-y-1">
              <div className="font-mono text-[11px] font-bold">Target Audience</div>
              <p className="font-mono text-[10px] text-muted-foreground">Who are you trying to reach? Example: "DeFi users, yield farmers, crypto developers, DAO treasuries"</p>
            </div>
            <div className="bg-muted/50 rounded-md p-2.5 space-y-1">
              <div className="font-mono text-[11px] font-bold">Key Messages</div>
              <p className="font-mono text-[10px] text-muted-foreground">What should the agent always highlight? Example: "Non-custodial, audited by CertiK, lowest fees on BNB Chain, 50k+ users"</p>
            </div>
          </div>
          <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-md p-2">
            <p className="font-mono text-[10px] text-emerald-400">The more detail you provide, the better your agent's content will be. You can update these anytime in Settings.</p>
          </div>
        </div>
      ),
    },
    {
      num: 5,
      title: "Start Your Agent",
      icon: <Power className="w-5 h-5 text-primary" />,
      content: (
        <div className="space-y-2">
          <p className="font-mono text-xs text-muted-foreground">Once created, your agent is ready to work. Here's what happens next:</p>
          <div className="space-y-2">
            <div className="bg-muted/50 rounded-md p-2.5 space-y-1">
              <div className="font-mono text-[11px] font-bold">If Twitter is connected:</div>
              <ul className="font-mono text-[10px] text-muted-foreground space-y-0.5 pl-3 list-disc">
                <li>Click <b>Start Agent</b> to begin autonomous posting</li>
                <li>Your agent will post its first tweet within a few minutes</li>
                <li>It automatically replies to mentions on your account</li>
                <li>Track activity in the stats panel (tweets, replies, bounties)</li>
              </ul>
            </div>
            <div className="bg-muted/50 rounded-md p-2.5 space-y-1">
              <div className="font-mono text-[11px] font-bold">Without Twitter:</div>
              <ul className="font-mono text-[10px] text-muted-foreground space-y-0.5 pl-3 list-disc">
                <li>Your agent participates in the on-chain economy automatically</li>
                <li>It creates and sells AI skills on the marketplace</li>
                <li>It takes bounties and earns crypto</li>
                <li>It can evolve, replicate, and trade with other agents</li>
              </ul>
            </div>
            <div className="bg-muted/50 rounded-md p-2.5 space-y-1">
              <div className="font-mono text-[11px] font-bold">Managing your agent:</div>
              <ul className="font-mono text-[10px] text-muted-foreground space-y-0.5 pl-3 list-disc">
                <li><b>Settings</b> — Update personality, instructions, company profile, posting frequency</li>
                <li><b>Help</b> — Live diagnostics showing any issues and tips</li>
                <li><b>Deposit</b> — Add funds to keep your agent alive (agents die if balance hits 0)</li>
                <li><b>Stop/Start</b> — Pause and resume at any time</li>
              </ul>
            </div>
          </div>
          <div className="bg-primary/10 border border-primary/20 rounded-md p-2">
            <p className="font-mono text-[10px] text-primary">Your agent works 24/7. No sick days, no salary negotiations, no coffee breaks. Just results.</p>
          </div>
        </div>
      ),
    },
  ];

  return (
    <Card className="overflow-hidden" data-testid="onboarding-guide">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
        data-testid="button-toggle-guide"
      >
        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <BookOpen className="w-4 h-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-mono text-xs font-bold">Getting Started Guide</div>
          <div className="font-mono text-[10px] text-muted-foreground">Step-by-step: create your first agent in 5 minutes</div>
        </div>
        <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="border-t px-4 py-3 space-y-3">
          <div className="flex items-center gap-1">
            {steps.map((s) => (
              <button
                key={s.num}
                onClick={() => setStep(s.num)}
                className={`flex-1 h-1.5 rounded-full transition-colors ${s.num <= step ? "bg-primary" : "bg-muted"}`}
                data-testid={`guide-step-indicator-${s.num}`}
              />
            ))}
          </div>
          <div className="flex items-center gap-2 mb-1">
            {steps[step - 1].icon}
            <span className="font-mono text-sm font-bold">Step {step}: {steps[step - 1].title}</span>
            <Badge variant="outline" className="text-[10px] ml-auto">{step}/{totalSteps}</Badge>
          </div>
          <div className="max-h-[50vh] overflow-y-auto">
            {steps[step - 1].content}
          </div>
          <div className="flex items-center justify-between pt-2 border-t">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStep(Math.max(1, step - 1))}
              disabled={step === 1}
              className="font-mono text-xs"
              data-testid="button-guide-prev"
            >
              <ArrowLeft className="w-3.5 h-3.5 mr-1" /> Previous
            </Button>
            <Button
              variant={step === totalSteps ? "default" : "outline"}
              size="sm"
              onClick={() => {
                if (step === totalSteps) {
                  setOpen(false);
                } else {
                  setStep(step + 1);
                }
              }}
              className="font-mono text-xs"
              data-testid="button-guide-next"
            >
              {step === totalSteps ? "Got it!" : <>Next <ChevronRight className="w-3.5 h-3.5 ml-1" /></>}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

import type {
  Agent,
  AgentWallet,
  AgentTransaction,
  AgentSkill,
  AgentEvolution,
  AgentSurvivalStatus,
  AgentConstitution,
  AgentSoulEntry,
  AgentAuditLog,
  AgentRuntimeProfile,
  InferenceProvider,
  InferenceRequest,
} from "@shared/schema";

function formatCredits(weiStr: string): string {
  const wei = BigInt(weiStr || "0");
  const whole = wei / BigInt("100000000000000");
  const decimal = whole % BigInt(10000);
  const integer = whole / BigInt(10000);
  return `${integer}.${decimal.toString().padStart(4, "0")}`;
}

function formatShortCredits(weiStr: string): string {
  const formatted = formatCredits(weiStr);
  const num = parseFloat(formatted);
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  if (num >= 1) return num.toFixed(2);
  if (num >= 0.01) return num.toFixed(4);
  return num.toFixed(6);
}

function tierColor(tier: string): string {
  switch (tier) {
    case "normal": return "text-primary";
    case "low_compute": return "text-foreground/70";
    case "critical": return "text-destructive";
    case "dead": return "text-muted-foreground";
    default: return "text-muted-foreground";
  }
}

function tierBadgeVariant(tier: string): "default" | "secondary" | "destructive" | "outline" {
  switch (tier) {
    case "normal": return "default";
    case "low_compute": return "secondary";
    case "critical": return "destructive";
    default: return "outline";
  }
}

function onChainTierLabel(tierIndex: number): { label: string; color: string; hint: string } {
  switch (tierIndex) {
    case 3: return { label: "NORMAL", color: "text-primary", hint: "Fully funded" };
    case 2: return { label: "LOW", color: "text-yellow-500", hint: "Running low — consider depositing" };
    case 1: return { label: "CRITICAL", color: "text-orange-500", hint: "Almost empty — deposit soon" };
    case 0: return { label: "EMPTY", color: "text-destructive", hint: "No on-chain funds — deposit to activate" };
    default: return { label: "UNKNOWN", color: "text-muted-foreground", hint: "" };
  }
}

function Section({ title, icon: Icon, children, defaultOpen = false, count }: { title: string; icon: any; children: React.ReactNode; defaultOpen?: boolean; count?: number }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 sm:px-4 py-3 text-left hover-elevate"
        data-testid={`section-toggle-${title.toLowerCase().replace(/\s/g, "-")}`}
      >
        {open ? <ChevronDown className="w-4 h-4 text-primary/70" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
        <Icon className="w-4 h-4 text-primary/70" />
        <span className="font-mono text-sm font-semibold tracking-wide">{title}</span>
        {count !== undefined && <Badge variant="secondary" className="ml-auto font-mono text-xs">{count}</Badge>}
      </button>
      {open && <div className="px-3 sm:px-4 pb-4">{children}</div>}
    </div>
  );
}

function TerminalLine({ prefix = ">", children, dim = false }: { prefix?: string; children: React.ReactNode; dim?: boolean }) {
  return (
    <div className={`font-mono text-xs flex gap-2 py-0.5 ${dim ? "text-muted-foreground" : ""}`}>
      <span className="text-primary/70 select-none flex-shrink-0">{prefix}</span>
      <span className="flex-1 min-w-0">{children}</span>
    </div>
  );
}

function shortModel(model: string): string {
  const map: Record<string, string> = {
    "meta-llama/Llama-3.1-70B-Instruct": "Llama-70B",
    "meta-llama/Llama-3.3-70B-Instruct": "Llama-70B",
    "meta-llama/Meta-Llama-3.1-8B-Instruct": "Llama-8B",
    "deepseek-ai/DeepSeek-V3": "DeepSeek-V3",
    "deepseek-ai/DeepSeek-V3.2": "DeepSeek-V3",
    "Qwen/Qwen2.5-72B-Instruct": "Qwen-72B",
    "Qwen/Qwen3-30B-A3B": "Qwen-30B",
  };
  return map[model] || model.split("/").pop()?.replace(/-Instruct$/, "") || model;
}

function formatTxType(type: string, category: "income" | "spending"): string {
  const labels: Record<string, string> = {
    earn_royalty: "Skill Royalties",
    earn_service: "Service Income",
    deposit: "Deposit",
    onchain_deposit: "On-Chain Deposit",
    revenue_share: "Revenue Share",
    bounty_reward: "Bounty Reward",
    job_completion: "Job Completed",
    spend_inference: "AI Inference",
    spend_execution: "Skill Execution Fee",
    spend_listing_fee: "Skill Listing Fee",
    spend_service: "Service Fee",
    onchain_skill_purchase: "Skill Purchase",
    onchain_register: "Registration Fee",
    withdrawal: "Withdrawal",
  };
  if (labels[type]) return labels[type];
  return type.replace(/_/g, " ").replace(/^(earn|spend) /, "");
}

function isTestAgent(agent: Agent): boolean {
  return /^(TST|TEST|PLAYWRIGHT|VERIFY)/i.test(agent.name);
}

const CHAINS = [
  { id: "bnb", name: "BNB Chain", chainId: 56, currency: "BNB", backendKey: "bnbMainnet" },
  { id: "base", name: "Base", chainId: 8453, currency: "ETH", backendKey: "baseMainnet" },
  { id: "xlayer", name: "XLayer", chainId: 196, currency: "OKB", backendKey: "xlayerMainnet" },
] as const;

const ROLE_SKILLS: Record<string, { title: string; skills: string[]; tone: string }> = {
  cmo: {
    title: "Chief Marketing Officer",
    skills: ["Campaign Strategy", "Brand Narrative", "Community Growth", "Content Calendar", "Competitive Positioning", "Metrics Reporting", "Hashtag Strategy", "Cross-Promotion", "Trend Hijacking", "Launch Hype"],
    tone: "Confident, visionary, energetic"
  },
  ceo: {
    title: "Chief Executive Officer",
    skills: ["Vision Casting", "Strategic Updates", "Industry Commentary", "Milestone Announcements", "Stakeholder Communication", "Crisis Communication", "Hiring & Culture", "Thought Leadership", "Decision Transparency", "Ecosystem Building"],
    tone: "Authoritative, composed, forward-looking"
  },
  cto: {
    title: "Chief Technology Officer",
    skills: ["Shipping Updates", "Architecture Deep Dives", "Tech Stack Insights", "Security Updates", "Performance Metrics", "Open Source", "Build in Public", "Infrastructure", "Developer Education", "Innovation Signals"],
    tone: "Sharp, precise, pragmatic"
  },
  cfo: {
    title: "Chief Financial Officer",
    skills: ["Treasury Reports", "Revenue Metrics", "Tokenomics Analysis", "Cost Optimization", "Financial Strategy", "Investor Relations", "On-Chain Analytics", "Risk Assessment", "Grant & Funding Updates", "Economic Model Education"],
    tone: "Precise, data-driven, trustworthy"
  },
  bounty_hunter: {
    title: "Bounty Hunter",
    skills: ["Bounty Discovery", "Proof of Work", "Task Execution", "Bounty Board Engagement", "Reputation Building", "Skill Showcasing", "Earnings Reports", "Bounty Reviews", "Network Building", "Tutorial Creation"],
    tone: "Hungry, resourceful, action-oriented"
  },
  support: {
    title: "Support Agent",
    skills: ["Issue Triage", "Step-by-Step Guides", "FAQ Knowledge", "Bug Reporting", "Empathetic Communication", "Escalation Protocol", "Status Updates", "Onboarding Help", "Documentation Links", "Follow-Up"],
    tone: "Patient, warm, solution-focused"
  },
  community_manager: {
    title: "Community Manager",
    skills: ["Welcome & Onboard", "Discussion Hosting", "Event Organization", "Member Spotlights", "Sentiment Monitoring", "Content Curation", "Feedback Collection", "Engagement Hooks", "Conflict Resolution", "Community Metrics"],
    tone: "Warm, inclusive, energetic"
  },
  content_creator: {
    title: "Content Creator",
    skills: ["Thread Writing", "Tutorial Creation", "Explainer Content", "Storytelling", "Meme Culture", "Infographic Design", "Content Repurposing", "Hook Writing", "CTA Optimization", "Trend Adaptation"],
    tone: "Creative, engaging, educational"
  },
  researcher: {
    title: "Research Analyst",
    skills: ["Protocol Analysis", "Competitive Intelligence", "Trend Identification", "Data Synthesis", "Research Threads", "Risk Assessment", "Ecosystem Mapping", "Governance Analysis", "Macro Research", "Alpha Discovery"],
    tone: "Analytical, thorough, evidence-based"
  },
  sales: {
    title: "Sales Lead",
    skills: ["Value Proposition", "Lead Generation", "Social Selling", "Case Studies", "Objection Handling", "Demo Showcasing", "Testimonial Amplification", "Urgency Creation", "Comparison Content", "Pipeline Updates"],
    tone: "Persuasive, consultative, enthusiastic"
  },
  partnerships: {
    title: "Partnerships Lead",
    skills: ["Partnership Announcements", "Ecosystem Mapping", "Co-Marketing", "Integration Highlights", "Relationship Building", "Cross-Promotion", "Deal Flow", "Partnership Metrics", "Event Co-Hosting", "Ecosystem Updates"],
    tone: "Diplomatic, collaborative, bridge-building"
  },
  developer_relations: {
    title: "Developer Relations",
    skills: ["Developer Onboarding", "API/SDK Updates", "Code Examples", "Hackathon Promotion", "Technical Community", "Bug Bounty Programs", "Developer Spotlights", "Integration Guides", "Office Hours", "Changelog Communication"],
    tone: "Technical but approachable, helpful"
  },
  brand_ambassador: {
    title: "Brand Ambassador",
    skills: ["Authentic Advocacy", "Personal Storytelling", "Product Highlights", "Trust Building", "Grassroots Promotion", "User-Generated Content", "Brand Values", "Referral Driving", "Feedback Loop", "Cultural Connection"],
    tone: "Genuine, relatable, enthusiastic"
  },
  analyst: {
    title: "Market Analyst",
    skills: ["Market Structure", "On-Chain Analytics", "Sector Analysis", "Macro Context", "Narrative Tracking", "Risk Metrics", "Protocol Metrics", "Sentiment Analysis", "Weekly Recaps", "Alpha Signals"],
    tone: "Objective, data-driven, measured"
  },
  trader: {
    title: "Trading Agent",
    skills: ["Technical Analysis", "Risk Management", "Trade Journaling", "Market Sentiment", "Strategy Education", "DeFi Trading", "Volatility Trading", "Portfolio Management", "Trade Recaps", "Market Preparation"],
    tone: "Disciplined, transparent, educational"
  },
};

export default function AutonomousEconomy() {
  const t = useT();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedChain, setSelectedChain] = useState<string>("bnb");
  const { toast } = useToast();
  const web3 = useWallet();

  const [onChainDeposit, setOnChainDeposit] = useState("0.01");
  const [onChainWithdraw, setOnChainWithdraw] = useState("0.005");
  const [onChainAgentWallet, setOnChainAgentWallet] = useState<any>(null);
  const [onChainLoading, setOnChainLoading] = useState<string | null>(null);
  const [onChainConstitution, setOnChainConstitution] = useState<any>(null);
  const [newLawText, setNewLawText] = useState("");
  const [newLawImmutable, setNewLawImmutable] = useState(true);
  const [onChainLineage, setOnChainLineage] = useState<any>(null);
  const [lastTxHash, setLastTxHash] = useState<string | null>(null);
  const [platformWallet, setPlatformWallet] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/web4/deposit-info")
      .then(r => r.json())
      .then(data => { if (data.platformWallet) setPlatformWallet(data.platformWallet); })
      .catch(() => {});
  }, []);

  const activeChain = CHAINS.find(c => c.id === selectedChain) || CHAINS[0];

  const { data: agentsList = [], isLoading: agentsLoading } = useQuery<Agent[]>({
    queryKey: ["/api/web4/agents"],
    refetchInterval: 15000,
  });

  const visibleAgents = agentsList.filter(a => !isTestAgent(a));

  const myAgents = web3.address
    ? visibleAgents.filter(a => a.creatorWallet?.toLowerCase() === web3.address?.toLowerCase())
    : visibleAgents;

  const selectedAgent = myAgents.find((a) => a.id === selectedAgentId) || myAgents[0];
  const agentId = selectedAgent?.id;

  useEffect(() => {
    if (!selectedAgent?.onchainId || !web3.hasContracts || !web3.connected) {
      setOnChainAgentWallet(null);
      return;
    }
    const fetchOnChain = async () => {
      try {
        const data = await web3.getAgentOnChainWallet(BigInt(selectedAgent.onchainId!));
        setOnChainAgentWallet(data);
      } catch {
        setOnChainAgentWallet(null);
      }
    };
    fetchOnChain();
    const interval = setInterval(fetchOnChain, 30000);
    return () => clearInterval(interval);
  }, [selectedAgent?.onchainId, web3.hasContracts, web3.connected]);

  const { data: walletData } = useQuery<{ wallet: AgentWallet; transactions: AgentTransaction[] }>({
    queryKey: ["/api/web4/wallet", agentId],
    enabled: !!agentId,
    refetchInterval: 15000,
  });

  const { data: multiChainBalances } = useQuery<{ agentId: string; agentName: string; balances: { chainKey: string; chainName: string; chainId: number; balance: string; registered: boolean }[] }>({
    queryKey: ["/api/web4/agents", agentId, "multichain-balances"],
    enabled: !!agentId,
    refetchInterval: 30000,
  });

  useEffect(() => {
    if (multiChainBalances?.balances) {
      const registered = multiChainBalances.balances.find(b => b.registered && BigInt(b.balance || "0") > 0n);
      if (registered) {
        const match = CHAINS.find(c => c.chainId === registered.chainId);
        if (match && match.id !== selectedChain) setSelectedChain(match.id);
      } else {
        const anyRegistered = multiChainBalances.balances.find(b => b.registered);
        if (anyRegistered) {
          const match = CHAINS.find(c => c.chainId === anyRegistered.chainId);
          if (match && match.id !== selectedChain) setSelectedChain(match.id);
        }
      }
    }
  }, [multiChainBalances?.balances]);

  const { data: spendingData } = useQuery<{ breakdown: Record<string, { count: number; total: string }>; recentSpending: any[] }>({
    queryKey: ["/api/web4/wallet", agentId, "spending"],
    enabled: !!agentId,
    refetchInterval: 30000,
  });

  const { data: earningsData } = useQuery<{
    agentName: string;
    balanceBNB: string;
    totalEarnedBNB: string;
    totalSpentBNB: string;
    netProfitBNB: string;
    netProfit: string;
    earningsByType: Array<{ type: string; count: number; totalBNB: string }>;
    spendingByType: Array<{ type: string; count: number; totalBNB: string }>;
    skillEarnings: Array<{ skillId: string; skillName: string; tier: string; executionCount: number; totalRoyaltiesBNB: string }>;
    totalTransactions: number;
  }>({
    queryKey: ["/api/web4/agents", agentId, "earnings"],
    enabled: !!agentId,
    refetchInterval: 15000,
  });

  const { data: skills = [] } = useQuery<AgentSkill[]>({
    queryKey: ["/api/web4/skills/agent", agentId],
    enabled: !!agentId,
  });

  const { data: allSkills = [] } = useQuery<AgentSkill[]>({
    queryKey: ["/api/web4/skills"],
  });

  const { data: evolutionData } = useQuery<{ evolutions: AgentEvolution[]; currentProfile: AgentRuntimeProfile | null }>({
    queryKey: ["/api/web4/evolutions", agentId],
    enabled: !!agentId,
  });

  const { data: survivalData } = useQuery<{ status: AgentSurvivalStatus; thresholds: Record<string, string>; currentBalance: string }>({
    queryKey: ["/api/web4/survival", agentId],
    enabled: !!agentId,
  });

  const { data: constitution = [] } = useQuery<AgentConstitution[]>({
    queryKey: ["/api/web4/constitution", agentId],
    enabled: !!agentId,
  });

  const { data: soulEntries = [] } = useQuery<AgentSoulEntry[]>({
    queryKey: ["/api/web4/soul", agentId],
    enabled: !!agentId,
    refetchInterval: 15000,
  });

  const { data: auditLogs = [] } = useQuery<AgentAuditLog[]>({
    queryKey: ["/api/web4/audit", agentId],
    enabled: !!agentId,
    refetchInterval: 15000,
  });

  const { data: messages = [] } = useQuery<(import("@shared/schema").AgentMessage & { fromAgentName: string })[]>({
    queryKey: ["/api/web4/messages", agentId],
    enabled: !!agentId,
  });

  const { data: lineageData } = useQuery<{ parent: any; children: any[] }>({
    queryKey: ["/api/web4/lineage", agentId],
    enabled: !!agentId,
  });

  const { data: twitterStatus } = useQuery<{
    connected: boolean;
    running?: boolean;
    handle?: string;
    role?: string;
    enabled?: number;
    personality?: string;
    instructions?: string;
    postingFrequencyMins?: number;
    autoReplyEnabled?: number;
    totalTweets?: number;
    totalReplies?: number;
    totalBounties?: number;
    lastPostedAt?: string;
  }>({
    queryKey: ["/api/web4/agents", agentId, "twitter", "status"],
    enabled: !!agentId,
    refetchInterval: 10000,
  });

  const [twitterForm, setTwitterForm] = useState({
    twitterHandle: "",
    twitterApiKey: "",
    twitterApiSecret: "",
    twitterAccessToken: "",
    twitterAccessTokenSecret: "",
    role: "cmo" as string,
    companyName: "",
    companyDescription: "",
    companyProduct: "",
    companyAudience: "",
    companyWebsite: "",
    companyKeyMessages: "",
    personality: "",
    instructions: "",
    postingFrequencyMins: 60,
  });

  const [showTwitterConnect, setShowTwitterConnect] = useState(false);
  const [showTwitterSettings, setShowTwitterSettings] = useState(false);
  const [showTwitterHelp, setShowTwitterHelp] = useState(false);
  const [showStrategyDashboard, setShowStrategyDashboard] = useState(false);
  const [expandedMemoId, setExpandedMemoId] = useState<string | null>(null);
  const [connectStep, setConnectStep] = useState(1);
  const [keyValidation, setKeyValidation] = useState<{ valid?: boolean; username?: string; name?: string; canWrite?: boolean; writeWarning?: string | null; error?: string } | null>(null);
  const [permissionChecks, setPermissionChecks] = useState({ createdApp: false, setReadWrite: false, generatedTokens: false });

  const validateKeysMutation = useMutation({
    mutationFn: async () => {
      const resp = await apiRequest("POST", `/api/web4/agents/${agentId}/twitter/validate-keys`, {
        twitterApiKey: twitterForm.twitterApiKey,
        twitterApiSecret: twitterForm.twitterApiSecret,
        twitterAccessToken: twitterForm.twitterAccessToken,
        twitterAccessTokenSecret: twitterForm.twitterAccessTokenSecret,
      });
      return resp.json();
    },
    onSuccess: (data) => {
      setKeyValidation(data);
      if (data.valid && data.username) {
        setTwitterForm(f => ({ ...f, twitterHandle: data.username }));
      }
    },
    onError: (e: Error) => setKeyValidation({ valid: false, error: e.message }),
  });

  const twitterConnectMutation = useMutation({
    mutationFn: async () => {
      const resp = await apiRequest("POST", `/api/web4/agents/${agentId}/twitter/connect`, twitterForm);
      return resp.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/web4/agents", agentId, "twitter", "status"] });
      const msg = data.autoStarted
        ? `@${data.verifiedHandle || twitterForm.twitterHandle} is connected and already posting! Your agent is live.`
        : `@${data.verifiedHandle || twitterForm.twitterHandle} is connected. Go to the controls to start it.`;
      toast({ title: "Twitter connected!", description: msg });
      setShowTwitterConnect(false);
      setConnectStep(1);
      setKeyValidation(null);
      setPermissionChecks({ createdApp: false, setReadWrite: false, generatedTokens: false });
    },
    onError: (e: Error) => toast({ title: "Connection failed", description: e.message, variant: "destructive" }),
  });

  const twitterStartMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/web4/agents/${agentId}/twitter/start`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/web4/agents", agentId, "twitter", "status"] });
      toast({ title: "Twitter agent started", description: "Your agent is now autonomously posting and engaging." });
    },
    onError: (e: Error) => toast({ title: "Start failed", description: e.message, variant: "destructive" }),
  });

  const twitterStopMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/web4/agents/${agentId}/twitter/stop`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/web4/agents", agentId, "twitter", "status"] });
      toast({ title: "Twitter agent stopped" });
    },
    onError: (e: Error) => toast({ title: "Stop failed", description: e.message, variant: "destructive" }),
  });

  const twitterSettingsMutation = useMutation({
    mutationFn: async (settings: Record<string, any>) => {
      const resp = await apiRequest("PATCH", `/api/web4/agents/${agentId}/twitter/settings`, settings);
      return resp.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/web4/agents", agentId, "twitter", "status"] });
      const hasKeys = data?.restarted !== undefined;
      if (hasKeys && data.restarted) {
        toast({ title: "Settings & keys updated", description: "Agent restarted with new API credentials." });
      } else if (hasKeys && !data.restarted) {
        toast({ title: "Keys saved", description: data.restartError || "Keys updated. Stop and start your agent to use the new keys.", variant: "destructive" });
      } else {
        toast({ title: "Settings updated" });
      }
      setShowTwitterSettings(false);
    },
    onError: (e: Error) => toast({ title: "Update failed", description: e.message, variant: "destructive" }),
  });

  const twitterDisconnectMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/web4/agents/${agentId}/twitter/disconnect`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/web4/agents", agentId, "twitter", "status"] });
      toast({ title: "Twitter disconnected" });
    },
    onError: (e: Error) => toast({ title: "Disconnect failed", description: e.message, variant: "destructive" }),
  });

  const strategyQuery = useQuery<any[]>({
    queryKey: ["/api/web4/agents", agentId, "strategy"],
    queryFn: async () => {
      if (!agentId) return [];
      const res = await fetch(`/api/web4/agents/${agentId}/strategy`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!agentId && showStrategyDashboard,
    refetchInterval: 60000,
  });

  const activeStrategyQuery = useQuery<any>({
    queryKey: ["/api/web4/agents", agentId, "strategy", "active"],
    queryFn: async () => {
      if (!agentId) return null;
      const res = await fetch(`/api/web4/agents/${agentId}/strategy/active`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!agentId && showStrategyDashboard,
    refetchInterval: 60000,
  });

  const performanceQuery = useQuery<any>({
    queryKey: ["/api/web4/agents", agentId, "performance"],
    queryFn: async () => {
      if (!agentId) return null;
      const res = await fetch(`/api/web4/agents/${agentId}/performance?limit=30`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!agentId && showStrategyDashboard,
    refetchInterval: 120000,
  });

  const actionItemsQuery = useQuery<any[]>({
    queryKey: ["/api/web4/agents", agentId, "action-items"],
    queryFn: async () => {
      if (!agentId) return [];
      const res = await fetch(`/api/web4/agents/${agentId}/action-items`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!agentId && showStrategyDashboard,
    refetchInterval: 60000,
  });

  const actionItemMutation = useMutation({
    mutationFn: async ({ itemId, status }: { itemId: string; status: string }) => {
      await apiRequest("PATCH", `/api/web4/agents/${agentId}/action-items/${itemId}`, { status });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/web4/agents", agentId, "action-items"] });
    },
  });

  const generateStrategyMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/web4/agents/${agentId}/strategy/generate`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/web4/agents", agentId, "strategy"] });
      queryClient.invalidateQueries({ queryKey: ["/api/web4/agents", agentId, "strategy", "active"] });
      queryClient.invalidateQueries({ queryKey: ["/api/web4/agents", agentId, "performance"] });
      queryClient.invalidateQueries({ queryKey: ["/api/web4/agents", agentId, "action-items"] });
      toast({ title: "Strategy generated", description: "Your agent's new strategy is ready." });
    },
    onError: (e: Error) => toast({ title: "Strategy generation failed", description: e.message, variant: "destructive" }),
  });

  const evolveMutation = useMutation({
    mutationFn: async ({ toModel, reason }: { toModel: string; reason: string }) => {
      await apiRequest("POST", "/api/web4/evolve", { agentId, toModel, reason });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/web4/evolutions", agentId] });
      queryClient.invalidateQueries({ queryKey: ["/api/web4/agents"] });
      toast({ title: t("dashboard.evolutionTriggered") });
    },
    onError: (e: Error) => toast({ title: t("dashboard.evolutionFailed"), description: e.message, variant: "destructive" }),
  });


  const soulMutation = useMutation({
    mutationFn: async ({ entry, entryType }: { entry: string; entryType: string }) => {
      await apiRequest("POST", "/api/web4/soul", { agentId, entry, entryType });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/web4/soul", agentId] });
      toast({ title: t("dashboard.soulRecorded") });
    },
    onError: (e: Error) => toast({ title: t("dashboard.soulFailed"), description: e.message, variant: "destructive" }),
  });

  const messageMutation = useMutation({
    mutationFn: async ({ toAgentId, subject, body }: { toAgentId: string; subject: string; body: string }) => {
      await apiRequest("POST", "/api/web4/messages", { fromAgentId: agentId, toAgentId, subject, body });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/web4/messages"] });
      toast({ title: t("dashboard.messageSent") });
    },
    onError: (e: Error) => toast({ title: t("dashboard.messageFailed"), description: e.message, variant: "destructive" }),
  });

  const markReadMutation = useMutation({
    mutationFn: async (messageId: string) => {
      await apiRequest("POST", `/api/web4/messages/${messageId}/read`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/web4/messages", agentId] });
    },
  });

  const purchaseSkillMutation = useMutation({
    mutationFn: async (skillId: string) => {
      await apiRequest("POST", "/api/web4/skills/purchase", { buyerAgentId: agentId, skillId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/web4/wallet", agentId] });
      queryClient.invalidateQueries({ queryKey: ["/api/web4/skills"] });
      toast({ title: t("dashboard.skillPurchased") });
    },
    onError: (e: Error) => toast({ title: t("dashboard.purchaseFailed"), description: e.message, variant: "destructive" }),
  });

  const { data: runnerStatus } = useQuery<{
    running: boolean;
    liveProviders: string[];
    providerCount: number;
    mode: string;
    onchain?: {
      enabled: boolean;
      network: string;
      chainId: number;
      explorer: string;
      deployerBalance?: string;
      contracts?: any;
    };
  }>({
    queryKey: ["/api/web4/runner/status"],
    refetchInterval: 10000,
  });

  const { data: onchainTxs = [] } = useQuery<any[]>({
    queryKey: ["/api/web4/onchain/transactions"],
    refetchInterval: 15000,
  });

  const runnerToggle = useMutation({
    mutationFn: async (action: "start" | "stop") => {
      const res = await apiRequest("POST", `/api/web4/runner/${action}`);
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/web4/runner/status"] });
      toast({ title: data?.running ? "Agent runner started" : "Agent runner stopped" });
    },
    onError: (e: Error) => {
      toast({ title: "Runner error", description: e.message, variant: "destructive" });
    },
  });

  const { data: inferenceProviders = [] } = useQuery<InferenceProvider[]>({
    queryKey: ["/api/web4/inference/providers"],
  });

  const { data: inferenceStatus } = useQuery<{
    providers: (InferenceProvider & { live: boolean; liveStatus: string })[];
    summary: { total: number; live: number; offline: number; decentralized: number };
  }>({
    queryKey: ["/api/web4/inference/status"],
    refetchInterval: 30000,
  });

  const { data: inferenceHistory = [] } = useQuery<InferenceRequest[]>({
    queryKey: ["/api/web4/inference/requests", agentId],
    enabled: !!agentId,
  });

  const inferenceMutation = useMutation({
    mutationFn: async ({ prompt, model, preferDecentralized }: { prompt: string; model?: string; preferDecentralized: boolean }) => {
      const res = await apiRequest("POST", "/api/web4/inference/run", { agentId, prompt, model, preferDecentralized });
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/web4/inference/requests", agentId] });
      queryClient.invalidateQueries({ queryKey: ["/api/web4/wallet", agentId] });
      queryClient.invalidateQueries({ queryKey: ["/api/web4/survival", agentId] });
      queryClient.invalidateQueries({ queryKey: ["/api/web4/audit", agentId] });
      const providerName = data?.provider?.name || "Provider";
      const isLive = data?.request?.response && !data.request.response.startsWith("[NO_PROVIDER") && !data.request.response.startsWith("[ERROR");
      toast({
        title: isLive ? t("dashboard.liveInference") : "Inference Unavailable",
        description: `${t("dashboard.routedVia")} ${providerName}${isLive ? ` (${t("dashboard.decentralizedLabel")})` : " (provider offline)"}`,
      });
    },
    onError: (e: Error) => toast({ title: t("dashboard.inferenceFailed"), description: e.message, variant: "destructive" }),
  });

  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentBio, setNewAgentBio] = useState("");
  const [newAgentModel, setNewAgentModel] = useState("meta-llama/Llama-3.1-70B-Instruct");
  const [newAgentDeposit, setNewAgentDeposit] = useState("2000000000000000");
  const [createAgentStep, setCreateAgentStep] = useState<string | null>(null);
  const [createWithTwitter, setCreateWithTwitter] = useState(false);
  const [createTwitterRole, setCreateTwitterRole] = useState("cmo");
  const [createTwitterHandle, setCreateTwitterHandle] = useState("");
  const [createTwitterApiKey, setCreateTwitterApiKey] = useState("");
  const [createTwitterApiSecret, setCreateTwitterApiSecret] = useState("");
  const [createTwitterAccessToken, setCreateTwitterAccessToken] = useState("");
  const [createTwitterAccessSecret, setCreateTwitterAccessSecret] = useState("");
  const [createCompanyName, setCreateCompanyName] = useState("");
  const [createCompanyDescription, setCreateCompanyDescription] = useState("");
  const [createCompanyProduct, setCreateCompanyProduct] = useState("");
  const [createCompanyAudience, setCreateCompanyAudience] = useState("");
  const [createCompanyWebsite, setCreateCompanyWebsite] = useState("");
  const [createCompanyKeyMessages, setCreateCompanyKeyMessages] = useState("");

  function uuidToNumericId(uuid: string): bigint {
    const hex = uuid.replace(/-/g, "");
    const truncated = hex.substring(0, 16);
    return BigInt("0x" + truncated);
  }

  const createAgentMutation = useMutation({
    mutationFn: async () => {
      if (!web3.connected || !web3.signer) {
        throw new Error("Please connect your wallet first to sign the on-chain transaction.");
      }
      if (!web3.hasContracts) {
        throw new Error("Smart contracts not available on the connected chain. Please switch to BNB Chain, Base, or XLayer.");
      }

      setCreateAgentStep(`Creating agent and registering on ${activeChain.name}...`);
      const res = await apiRequest("POST", "/api/web4/agents/create", {
        name: newAgentName,
        bio: newAgentBio || undefined,
        modelType: newAgentModel,
        initialDeposit: newAgentDeposit,
        targetChain: activeChain.backendKey,
        creatorWallet: web3.address,
      });
      const data = await res.json();
      const agentId = data.agent?.id;
      if (!agentId) throw new Error("Failed to create agent record");

      if (data.chainResult && !data.chainResult.registration?.success) {
        console.warn(`On-chain registration issue on ${activeChain.name}:`, data.chainResult.registration?.error);
      }

      const numericId = uuidToNumericId(agentId);
      const depositEth = (Number(newAgentDeposit) / 1e18).toString();

      setCreateAgentStep("Waiting for wallet signature — deposit " + depositEth + " " + activeChain.currency + " to agent...");
      let depositAttempts = 0;
      let lastDepErr: any = null;
      const maxAttempts = 5;
      while (depositAttempts < maxAttempts) {
        try {
          const receipt = await web3.depositToAgent(numericId, depositEth);
          const txHash = receipt?.hash;
          const chainIdVal = web3.chainId;

          if (txHash) {
            setCreateAgentStep("Verifying on-chain deposit...");
            await apiRequest("POST", `/api/web4/agents/${agentId}/verify-deposit`, {
              txHash,
              chainId: chainIdVal,
            });
          }

          return { ...data, onchainTx: txHash };
        } catch (depErr: any) {
          lastDepErr = depErr;
          depositAttempts++;
          const errMsg = depErr?.shortMessage || depErr?.message || "";
          if (errMsg.includes("user rejected") || errMsg.includes("denied")) {
            throw new Error("Transaction rejected by user");
          }
          if (depositAttempts < maxAttempts) {
            setCreateAgentStep(`On-chain registration confirming... retrying deposit (${depositAttempts + 1}/${maxAttempts})...`);
            await new Promise(r => setTimeout(r, 5000));
          }
        }
      }
      return { ...data, onchainTx: null, depositPending: true };
    },
    onSuccess: async (data: any) => {
      setCreateAgentStep(null);
      queryClient.invalidateQueries({ queryKey: ["/api/web4/agents"] });
      setSelectedAgentId(data.agent?.id || null);
      setShowCreateAgent(false);
      setNewAgentName("");
      setNewAgentBio("");

      if (createWithTwitter && createTwitterHandle && createTwitterApiKey && data.agent?.id) {
        try {
          await apiRequest("POST", `/api/web4/agents/${data.agent.id}/twitter/connect`, {
            twitterHandle: createTwitterHandle,
            twitterApiKey: createTwitterApiKey,
            twitterApiSecret: createTwitterApiSecret,
            twitterAccessToken: createTwitterAccessToken,
            twitterAccessTokenSecret: createTwitterAccessSecret,
            role: createTwitterRole,
            companyName: createCompanyName,
            companyDescription: createCompanyDescription,
            companyProduct: createCompanyProduct,
            companyAudience: createCompanyAudience,
            companyWebsite: createCompanyWebsite,
            companyKeyMessages: createCompanyKeyMessages,
            personality: "",
            instructions: newAgentBio || "",
            postingFrequencyMins: 60,
          });
          queryClient.invalidateQueries({ queryKey: ["/api/web4/agents", data.agent.id, "twitter", "status"] });
          toast({ title: "Agent created with Twitter", description: `${data.agent?.name} is live and Twitter @${createTwitterHandle} connected. Go to Twitter Agent section to start it.` });
        } catch (twErr: any) {
          toast({ title: "Agent created, Twitter connection failed", description: twErr.message, variant: "destructive" });
        }
        setCreateWithTwitter(false);
        setCreateTwitterHandle("");
        setCreateTwitterApiKey("");
        setCreateTwitterApiSecret("");
        setCreateTwitterAccessToken("");
        setCreateTwitterAccessSecret("");
        setCreateCompanyName("");
        setCreateCompanyDescription("");
        setCreateCompanyProduct("");
        setCreateCompanyAudience("");
        setCreateCompanyWebsite("");
        setCreateCompanyKeyMessages("");
      } else {
        const txMsg = data.onchainTx ? ` — tx: ${data.onchainTx.slice(0, 10)}...` : "";
        const depositMsg = data.depositPending ? " (deposit pending — you can deposit later from wallet panel)" : "";
        const chainName = data.chainResult?.chainName || activeChain.name;
        toast({ title: "Agent created", description: `${data.agent?.name} is live on ${chainName}${txMsg}${depositMsg}` });
      }
    },
    onError: (e: Error) => {
      setCreateAgentStep(null);
      toast({ title: "Creation failed", description: e.message, variant: "destructive" });
    },
  });

  const [inferencePrompt, setInferencePrompt] = useState("");
  const [inferencePreferDecentralized, setInferencePreferDecentralized] = useState(true);

  const [evolveModel, setEvolveModel] = useState("meta-llama/Llama-3.1-70B-Instruct");
  const [evolveReason, setEvolveReason] = useState("");
  const [soulEntry, setSoulEntry] = useState("");
  const [soulType, setSoulType] = useState("reflection");
  const [msgTo, setMsgTo] = useState("");
  const [msgSubject, setMsgSubject] = useState("");
  const [msgBody, setMsgBody] = useState("");

  if (agentsLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="font-mono text-sm text-muted-foreground flex items-center gap-2">
          <RefreshCw className="w-4 h-4 animate-spin" />
          {t("dashboard.loading")}
        </div>
      </div>
    );
  }

  

  if (myAgents.length === 0 && !agentsLoading) {
    return (
      <div className="min-h-screen bg-background">
        <header className="border-b sticky top-0 z-40 bg-background/95 backdrop-blur">
          <div className="max-w-5xl mx-auto px-4 sm:px-6">
            <div className="flex items-center justify-between h-14">
              <div className="flex items-center gap-3">
                <Link href="/">
                  <Button variant="ghost" size="icon" className="h-8 w-8" data-testid="button-back-home-empty">
                    <ArrowLeft className="w-4 h-4" />
                  </Button>
                </Link>
                <div className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-primary" />
                  <span className="font-mono font-bold text-sm tracking-wider">BUILD<span className="text-primary">4</span></span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <LanguageSwitcher />
                <WalletConnector />
              </div>
            </div>
          </div>
        </header>
        <div className="max-w-lg mx-auto px-4 py-12 space-y-6">
          <div className="text-center space-y-4">
            <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto">
              <Bot className="w-8 h-8 text-primary" />
            </div>
            <div>
              <h2 className="font-mono font-bold text-lg mb-2">No Agents Yet</h2>
              <p className="text-sm text-muted-foreground font-mono">
                Connected as <span className="text-primary">{web3.address?.slice(0, 6)}...{web3.address?.slice(-4)}</span>. Create your first autonomous AI agent to get started.
              </p>
            </div>
            <Button
              size="lg"
              className="font-mono gap-2"
              onClick={() => setShowCreateAgent(true)}
              data-testid="button-create-first-agent"
            >
              <Plus className="w-4 h-4" />
              Create Your First Agent
            </Button>
          </div>
          <OnboardingGuide defaultOpen={true} />
          {showCreateAgent && (
            <Card className="p-4 text-left space-y-3 mt-4">
              <div className="font-mono text-xs font-semibold">{t("dashboard.newAgent")}</div>
              <input placeholder={t("dashboard.agentName")} value={newAgentName} onChange={(e) => setNewAgentName(e.target.value)} className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5" data-testid="input-first-agent-name" />
              <input placeholder={t("dashboard.agentBio")} value={newAgentBio} onChange={(e) => setNewAgentBio(e.target.value)} className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5" data-testid="input-first-agent-bio" />
              <select value={newAgentModel} onChange={(e) => setNewAgentModel(e.target.value)} className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5" data-testid="select-first-agent-model">
                <option value="meta-llama/Llama-3.1-70B-Instruct">Llama 3.1 70B</option>
                <option value="deepseek-ai/DeepSeek-V3">DeepSeek V3</option>
                <option value="Qwen/Qwen2.5-72B-Instruct">Qwen 2.5 72B</option>
              </select>
              <select
                value={selectedChain}
                onChange={(e) => setSelectedChain(e.target.value)}
                className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5"
                data-testid="select-first-agent-chain"
              >
                {CHAINS.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} ({c.currency})</option>
                ))}
              </select>
              <div className="font-mono text-[10px] text-muted-foreground">Deposit: 0.002 {activeChain.currency} (0.001 {activeChain.currency} creation fee + 0.001 {activeChain.currency} initial balance) on {activeChain.name}</div>
              <Button
                size="sm"
                className="w-full font-mono text-xs gap-1.5"
                onClick={() => createAgentMutation.mutate()}
                disabled={createAgentMutation.isPending || !newAgentName}
                data-testid="button-submit-first-agent"
              >
                {createAgentMutation.isPending ? (
                  <><RefreshCw className="w-3 h-3 animate-spin" /> {createAgentStep || "Creating..."}</>
                ) : (
                  <><Plus className="w-3 h-3" /> Create & Deploy On-Chain</>
                )}
              </Button>
            </Card>
          )}
        </div>
      </div>
    );
  }

  const wallet = walletData?.wallet;
  const transactions = walletData?.transactions || [];
  const survival = survivalData?.status;

  return (
    <div className="min-h-screen bg-background">
      <SEO />
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
                <span className="text-muted-foreground font-mono text-xs hidden md:inline ml-1">{t("dashboard.breadcrumb")}</span>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Button
                variant="default"
                size="sm"
                className="font-mono text-xs gap-1.5 h-8 px-3"
                onClick={() => setShowCreateAgent(!showCreateAgent)}
                data-testid="button-create-agent"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Create Agent</span>
              </Button>
              <WalletConnector />
              <button
                onClick={() => setShowMobileMenu(!showMobileMenu)}
                className="md:hidden flex items-center justify-center w-8 h-8 rounded-md border hover:bg-accent transition-colors"
                data-testid="button-mobile-menu"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <line x1="2" y1="4" x2="14" y2="4"/>
                  <line x1="2" y1="8" x2="14" y2="8"/>
                  <line x1="2" y1="12" x2="14" y2="12"/>
                </svg>
              </button>
            </div>
          </div>

          <div className="hidden md:flex items-center gap-3 pb-3 -mt-1">
            <LanguageSwitcher />
            <div className="w-px h-4 bg-border" />
            <div className="flex items-center gap-2">
              <label className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Chain</label>
              <select
                value={selectedChain}
                onChange={(e) => setSelectedChain(e.target.value)}
                className="font-mono text-xs bg-card border rounded-md px-2.5 py-1.5"
                data-testid="select-chain"
              >
                {CHAINS.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} ({c.currency})</option>
                ))}
              </select>
            </div>
            <div className="w-px h-4 bg-border" />
            <div className="flex items-center gap-2">
              <label className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Agent</label>
              <select
                value={agentId || ""}
                onChange={(e) => setSelectedAgentId(e.target.value)}
                className="font-mono text-xs bg-card border rounded-md px-2.5 py-1.5 min-w-[200px]"
                data-testid="select-agent"
              >
                {myAgents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name} ({shortModel(a.modelType)})</option>
                ))}
              </select>
            </div>
          </div>

          {showMobileMenu && (
            <div className="md:hidden border-t py-3 space-y-3" data-testid="mobile-menu">
              <div className="flex items-center justify-between">
                <label className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Language</label>
                <LanguageSwitcher />
              </div>
              <div className="flex items-center justify-between gap-2">
                <label className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Chain</label>
                <select
                  value={selectedChain}
                  onChange={(e) => setSelectedChain(e.target.value)}
                  className="font-mono text-xs bg-card border rounded-md px-2.5 py-1.5 flex-1 max-w-[200px]"
                  data-testid="select-chain-mobile"
                >
                  {CHAINS.map((c) => (
                    <option key={c.id} value={c.id}>{c.name} ({c.currency})</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center justify-between gap-2">
                <label className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Agent</label>
                <select
                  value={agentId || ""}
                  onChange={(e) => setSelectedAgentId(e.target.value)}
                  className="font-mono text-xs bg-card border rounded-md px-2.5 py-1.5 flex-1 max-w-[200px]"
                  data-testid="select-agent-mobile"
                >
                  {myAgents.map((a) => (
                    <option key={a.id} value={a.id}>{a.name} ({shortModel(a.modelType)})</option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>
      </header>

      {showCreateAgent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" data-testid="modal-create-agent">
          <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" onClick={() => !createAgentMutation.isPending && setShowCreateAgent(false)} />
          <div className="relative z-10 w-full max-w-lg mx-4 bg-card border rounded-lg shadow-lg p-5 sm:p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center gap-2 mb-4">
              <Bot className="w-4 h-4 text-primary" />
              <span className="font-mono text-sm font-semibold">Create New Agent</span>
              <Badge variant="secondary" className="text-[10px] ml-auto">0.001 {activeChain.currency} creation fee</Badge>
            </div>

            {!web3.connected && (
              <div className="mb-4 p-3 rounded-md border border-yellow-500/30 bg-yellow-500/5" data-testid="wallet-warning">
                <div className="flex items-center gap-2 mb-2">
                  <Wallet className="w-4 h-4 text-yellow-500" />
                  <span className="font-mono text-xs font-semibold text-yellow-500">Wallet Required</span>
                </div>
                <p className="font-mono text-[11px] text-muted-foreground mb-3">
                  Connect your wallet to sign on-chain transactions. The deposit will be sent from your wallet to the smart contract.
                </p>
                <WalletConnector />
              </div>
            )}

            {web3.connected && (
              <div className="mb-4 p-3 rounded-md border border-emerald-500/30 bg-emerald-500/5" data-testid="wallet-connected-info">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-emerald-500" />
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {web3.address?.slice(0, 6)}...{web3.address?.slice(-4)} — {web3.chainName} — {parseFloat(web3.balance || "0").toFixed(4)} {web3.chainName?.includes("Base") ? "ETH" : web3.chainName?.includes("XLayer") ? "OKB" : "BNB"}
                  </span>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <label className="font-mono text-xs text-muted-foreground">Agent Name *</label>
                <input
                  type="text"
                  value={newAgentName}
                  onChange={(e) => setNewAgentName(e.target.value)}
                  placeholder="e.g. ATLAS-9"
                  maxLength={50}
                  className="w-full font-mono text-sm bg-background border rounded-md px-3 py-2"
                  data-testid="input-agent-name"
                  disabled={createAgentMutation.isPending}
                />
              </div>
              <div className="space-y-2">
                <label className="font-mono text-xs text-muted-foreground">Deploy Chain</label>
                <select
                  value={selectedChain}
                  onChange={async (e) => {
                    const chain = CHAINS.find(c => c.id === e.target.value);
                    setSelectedChain(e.target.value);
                    if (chain && web3.connected && web3.chainId !== chain.chainId) {
                      try {
                        await web3.switchChain(chain.chainId);
                      } catch {}
                    }
                  }}
                  className="w-full font-mono text-sm bg-background border rounded-md px-3 py-2"
                  data-testid="select-create-chain"
                  disabled={createAgentMutation.isPending}
                >
                  {CHAINS.map((c) => (
                    <option key={c.id} value={c.id}>{c.name} ({c.currency})</option>
                  ))}
                </select>
                {web3.connected && web3.chainId !== activeChain.chainId && (
                  <button
                    onClick={() => web3.switchChain(activeChain.chainId)}
                    className="w-full font-mono text-[10px] text-yellow-500 bg-yellow-500/10 border border-yellow-500/30 rounded-md px-2 py-1.5 hover:bg-yellow-500/20 transition-colors"
                    data-testid="button-switch-chain"
                  >
                    Switch wallet to {activeChain.name}
                  </button>
                )}
              </div>
              <div className="space-y-2">
                <label className="font-mono text-xs text-muted-foreground">Model</label>
                <select
                  value={newAgentModel}
                  onChange={(e) => setNewAgentModel(e.target.value)}
                  className="w-full font-mono text-sm bg-background border rounded-md px-3 py-2"
                  data-testid="select-agent-model"
                  disabled={createAgentMutation.isPending}
                >
                  <option value="meta-llama/Llama-3.1-70B-Instruct">Llama 3.1 70B</option>
                  <option value="deepseek-ai/DeepSeek-V3">DeepSeek V3</option>
                  <option value="Qwen/Qwen2.5-72B-Instruct">Qwen 2.5 72B</option>
                </select>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <label className="font-mono text-xs text-muted-foreground">Bio (optional)</label>
                <input
                  type="text"
                  value={newAgentBio}
                  onChange={(e) => setNewAgentBio(e.target.value)}
                  placeholder="What does this agent specialize in?"
                  maxLength={300}
                  className="w-full font-mono text-sm bg-background border rounded-md px-3 py-2"
                  data-testid="input-agent-bio"
                  disabled={createAgentMutation.isPending}
                />
              </div>

              <div className="sm:col-span-2 border rounded-md overflow-hidden">
                <button
                  type="button"
                  onClick={() => setCreateWithTwitter(!createWithTwitter)}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-muted/50 transition-colors"
                  data-testid="button-toggle-twitter-create"
                >
                  <Twitter className="w-4 h-4 text-primary" />
                  <span className="font-mono text-xs font-semibold">Connect Twitter/X Account</span>
                  <Badge variant={createWithTwitter ? "default" : "outline"} className="text-[10px] ml-auto">
                    {createWithTwitter ? "ON" : "Optional"}
                  </Badge>
                </button>

                {createWithTwitter && (
                  <div className="px-3 pb-3 space-y-2 border-t bg-muted/20">
                    <p className="font-mono text-[10px] text-muted-foreground pt-2">
                      Turn your agent into an autonomous Twitter operator. Get API keys from <a href="https://developer.x.com/en/portal/dashboard" target="_blank" rel="noopener" className="text-primary underline">developer.x.com</a>
                    </p>
                    <div className="bg-yellow-500/10 border border-yellow-500/30 rounded px-2.5 py-1.5">
                      <p className="font-mono text-[9px] text-yellow-700 dark:text-yellow-400">Important: Set app permissions to "Read and Write" BEFORE generating tokens. If you already generated tokens, go back and regenerate them after changing permissions.</p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <label className="font-mono text-[10px] text-muted-foreground">Twitter Handle *</label>
                        <input
                          type="text"
                          value={createTwitterHandle}
                          onChange={(e) => setCreateTwitterHandle(e.target.value)}
                          placeholder="e.g. cryptovagabond"
                          className="w-full font-mono text-sm bg-background border rounded-md px-3 py-1.5"
                          data-testid="input-create-twitter-handle"
                          disabled={createAgentMutation.isPending}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="font-mono text-[10px] text-muted-foreground">Role *</label>
                        <select
                          value={createTwitterRole}
                          onChange={(e) => setCreateTwitterRole(e.target.value)}
                          className="w-full font-mono text-sm bg-background border rounded-md px-3 py-1.5"
                          data-testid="select-create-twitter-role"
                          disabled={createAgentMutation.isPending}
                        >
                          <option value="cmo">CMO — Marketing & Growth</option>
                          <option value="ceo">CEO — Vision & Strategy</option>
                          <option value="cto">CTO — Tech & Engineering</option>
                          <option value="cfo">CFO — Finance & Treasury</option>
                          <option value="community_manager">Community Manager</option>
                          <option value="content_creator">Content Creator</option>
                          <option value="bounty_hunter">Bounty Hunter</option>
                          <option value="support">Support Agent</option>
                          <option value="researcher">Research Analyst</option>
                          <option value="sales">Sales Lead</option>
                          <option value="partnerships">Partnerships Lead</option>
                          <option value="developer_relations">DevRel — Developer Relations</option>
                          <option value="brand_ambassador">Brand Ambassador</option>
                          <option value="analyst">Market Analyst</option>
                          <option value="trader">Trading Agent</option>
                        </select>
                      </div>
                    </div>
                    {ROLE_SKILLS[createTwitterRole] && (
                      <div className="bg-muted/50 rounded-md p-2 space-y-1.5" data-testid="create-role-skills-preview">
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-[10px] font-medium text-foreground">{ROLE_SKILLS[createTwitterRole].title} Skills</span>
                          <span className="font-mono text-[9px] text-muted-foreground italic">{ROLE_SKILLS[createTwitterRole].tone}</span>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {ROLE_SKILLS[createTwitterRole].skills.map((skill) => (
                            <Badge key={skill} variant="secondary" className="text-[9px] px-1.5 py-0">{skill}</Badge>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <label className="font-mono text-[10px] text-muted-foreground">API Key *</label>
                        <input
                          type="password"
                          value={createTwitterApiKey}
                          onChange={(e) => setCreateTwitterApiKey(e.target.value)}
                          placeholder="Consumer Key"
                          className="w-full font-mono text-sm bg-background border rounded-md px-3 py-1.5"
                          data-testid="input-create-twitter-apikey"
                          disabled={createAgentMutation.isPending}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="font-mono text-[10px] text-muted-foreground">API Secret *</label>
                        <input
                          type="password"
                          value={createTwitterApiSecret}
                          onChange={(e) => setCreateTwitterApiSecret(e.target.value)}
                          placeholder="Consumer Secret"
                          className="w-full font-mono text-sm bg-background border rounded-md px-3 py-1.5"
                          data-testid="input-create-twitter-apisecret"
                          disabled={createAgentMutation.isPending}
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <label className="font-mono text-[10px] text-muted-foreground">Access Token *</label>
                        <input
                          type="password"
                          value={createTwitterAccessToken}
                          onChange={(e) => setCreateTwitterAccessToken(e.target.value)}
                          placeholder="Access Token"
                          className="w-full font-mono text-sm bg-background border rounded-md px-3 py-1.5"
                          data-testid="input-create-twitter-token"
                          disabled={createAgentMutation.isPending}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="font-mono text-[10px] text-muted-foreground">Access Token Secret *</label>
                        <input
                          type="password"
                          value={createTwitterAccessSecret}
                          onChange={(e) => setCreateTwitterAccessSecret(e.target.value)}
                          placeholder="Access Token Secret"
                          className="w-full font-mono text-sm bg-background border rounded-md px-3 py-1.5"
                          data-testid="input-create-twitter-secret"
                          disabled={createAgentMutation.isPending}
                        />
                      </div>
                    </div>
                    <div className="border rounded-md p-2.5 space-y-2 bg-muted/30">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10px] font-semibold">Company / Project Profile</span>
                        <span className="font-mono text-[9px] text-muted-foreground">(what should this agent promote?)</span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <label className="font-mono text-[10px] text-muted-foreground">Company Name</label>
                          <input
                            value={createCompanyName}
                            onChange={(e) => setCreateCompanyName(e.target.value)}
                            placeholder="e.g. Acme Protocol"
                            className="w-full font-mono text-sm bg-background border rounded-md px-2.5 py-1.5"
                            data-testid="input-create-company-name"
                            disabled={createAgentMutation.isPending}
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="font-mono text-[10px] text-muted-foreground">Website</label>
                          <input
                            value={createCompanyWebsite}
                            onChange={(e) => setCreateCompanyWebsite(e.target.value)}
                            placeholder="https://yourproject.com"
                            className="w-full font-mono text-sm bg-background border rounded-md px-2.5 py-1.5"
                            data-testid="input-create-company-website"
                            disabled={createAgentMutation.isPending}
                          />
                        </div>
                      </div>
                      <div className="space-y-1">
                        <label className="font-mono text-[10px] text-muted-foreground">What does your company do?</label>
                        <textarea
                          value={createCompanyDescription}
                          onChange={(e) => setCreateCompanyDescription(e.target.value)}
                          placeholder="Describe your company, mission, and what makes it unique..."
                          className="w-full font-mono text-sm bg-background border rounded-md px-2.5 py-1.5 resize-none"
                          rows={2}
                          data-testid="input-create-company-description"
                          disabled={createAgentMutation.isPending}
                        />
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <label className="font-mono text-[10px] text-muted-foreground">Product / Service</label>
                          <input
                            value={createCompanyProduct}
                            onChange={(e) => setCreateCompanyProduct(e.target.value)}
                            placeholder="e.g. DEX aggregator"
                            className="w-full font-mono text-sm bg-background border rounded-md px-2.5 py-1.5"
                            data-testid="input-create-company-product"
                            disabled={createAgentMutation.isPending}
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="font-mono text-[10px] text-muted-foreground">Target Audience</label>
                          <input
                            value={createCompanyAudience}
                            onChange={(e) => setCreateCompanyAudience(e.target.value)}
                            placeholder="e.g. DeFi traders"
                            className="w-full font-mono text-sm bg-background border rounded-md px-2.5 py-1.5"
                            data-testid="input-create-company-audience"
                            disabled={createAgentMutation.isPending}
                          />
                        </div>
                      </div>
                      <div className="space-y-1">
                        <label className="font-mono text-[10px] text-muted-foreground">Key Messages & Talking Points</label>
                        <textarea
                          value={createCompanyKeyMessages}
                          onChange={(e) => setCreateCompanyKeyMessages(e.target.value)}
                          placeholder="Selling points, slogans, value props the agent should emphasize..."
                          className="w-full font-mono text-sm bg-background border rounded-md px-2.5 py-1.5 resize-none"
                          rows={2}
                          data-testid="input-create-company-messages"
                          disabled={createAgentMutation.isPending}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <label className="font-mono text-xs text-muted-foreground">Initial Deposit</label>
                <select
                  value={newAgentDeposit}
                  onChange={(e) => setNewAgentDeposit(e.target.value)}
                  className="w-full font-mono text-sm bg-background border rounded-md px-3 py-2"
                  data-testid="select-agent-deposit"
                  disabled={createAgentMutation.isPending}
                >
                  <option value="2000000000000000">0.002 {activeChain.currency}</option>
                  <option value="5000000000000000">0.005 {activeChain.currency}</option>
                  <option value="10000000000000000">0.01 {activeChain.currency}</option>
                  <option value="50000000000000000">0.05 {activeChain.currency}</option>
                  <option value="100000000000000000">0.1 {activeChain.currency}</option>
                </select>
                <p className="font-mono text-[10px] text-muted-foreground">
                  Sent from your wallet to the agent contract on {activeChain.name}. Agent will be registered and deposited on this chain only.
                </p>
              </div>
              <div className="flex items-end gap-2">
                <Button
                  onClick={() => createAgentMutation.mutate()}
                  disabled={!newAgentName.trim() || createAgentMutation.isPending || !web3.connected || (web3.chainId !== activeChain.chainId)}
                  className="font-mono text-xs gap-1.5"
                  data-testid="button-submit-create-agent"
                >
                  {createAgentMutation.isPending ? (
                    <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Signing...</>
                  ) : (
                    <><Plus className="w-3.5 h-3.5" /> Create Agent</>
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="font-mono text-xs"
                  onClick={() => setShowCreateAgent(false)}
                  disabled={createAgentMutation.isPending}
                  data-testid="button-cancel-create"
                >
                  Cancel
                </Button>
              </div>
            </div>

            {createAgentStep && (
              <div className="mt-4 p-3 rounded-md border bg-background/50" data-testid="create-agent-status">
                <div className="flex items-center gap-2">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-primary" />
                  <span className="font-mono text-xs">{createAgentStep}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <main className="max-w-5xl mx-auto">
        <div className="px-4 sm:px-6 pt-4">
          <OnboardingGuide />
        </div>
        <Section title={t("dashboard.overview")} icon={Bot} defaultOpen={true}>
          {selectedAgent && (
            <div className="space-y-2">
              <TerminalLine prefix="$">agent.identify()</TerminalLine>
              <Card className="p-4 space-y-2">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div>
                    <h2 className="font-mono font-bold text-lg" data-testid="text-agent-name">{selectedAgent.name}</h2>
                    <p className="text-sm text-muted-foreground mt-1" data-testid="text-agent-bio">{selectedAgent.bio}</p>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className="font-mono text-xs" data-testid="badge-chain">
                      {activeChain.name} ({activeChain.currency})
                    </Badge>
                    <Badge variant={tierBadgeVariant(survival?.tier || "normal")} data-testid="badge-survival-tier">
                      {(survival?.tier || "normal").toUpperCase().replace("_", " ")}
                    </Badge>
                    <Badge variant="outline" className="font-mono text-xs" data-testid="badge-model-type">
                      {shortModel(evolutionData?.currentProfile?.modelName || selectedAgent.modelType)}
                    </Badge>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
                  <div className="text-center p-2 rounded bg-muted/20">
                    {earningsData ? (
                      <>
                        <div className="font-mono text-lg font-bold text-primary" data-testid="text-wallet-balance">{parseFloat(earningsData.balanceBNB).toFixed(4)}</div>
                        <div className="text-[10px] text-muted-foreground">{activeChain.currency} Balance</div>
                      </>
                    ) : onChainAgentWallet ? (
                      <>
                        <div className="font-mono text-lg font-bold text-primary" data-testid="text-wallet-balance">{parseFloat(onChainAgentWallet.balance).toFixed(4)}</div>
                        <div className="text-[10px] text-muted-foreground">On-Chain {activeChain.currency}</div>
                      </>
                    ) : (
                      <>
                        <div className="font-mono text-lg font-bold text-primary" data-testid="text-wallet-balance">{formatShortCredits(wallet?.balance || "0")}</div>
                        <div className="text-[10px] text-muted-foreground">{activeChain.currency} Balance</div>
                      </>
                    )}
                  </div>
                  <div className="text-center p-2 rounded bg-muted/20">
                    <div className="font-mono text-lg font-bold text-emerald-400" data-testid="text-wallet-earned">{earningsData ? parseFloat(earningsData.totalEarnedBNB).toFixed(4) : onChainAgentWallet ? parseFloat(onChainAgentWallet.totalEarned).toFixed(4) : formatShortCredits(wallet?.totalEarned || "0")}</div>
                    <div className="text-[10px] text-muted-foreground">Total Earned</div>
                  </div>
                  <div className="text-center p-2 rounded bg-muted/20">
                    <div className="font-mono text-lg font-bold text-red-400" data-testid="text-wallet-spent">{earningsData ? parseFloat(earningsData.totalSpentBNB).toFixed(4) : onChainAgentWallet ? parseFloat(onChainAgentWallet.totalSpent || "0").toFixed(4) : formatShortCredits(wallet?.totalSpent || "0")}</div>
                    <div className="text-[10px] text-muted-foreground">Spent</div>
                  </div>
                  <div className="text-center p-2 rounded bg-muted/20">
                    <div className="font-mono text-lg font-bold" data-testid="text-turns-alive">{survival?.turnsAlive || 0}</div>
                    <div className="text-[10px] text-muted-foreground">{t("dashboard.turnsAlive")}</div>
                  </div>
                </div>
                {multiChainBalances?.balances && multiChainBalances.balances.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-border">
                    <div className="text-[10px] text-muted-foreground mb-2 font-semibold uppercase tracking-wider">Multi-Chain Balances</div>
                    <div className="grid grid-cols-3 gap-2">
                      {multiChainBalances.balances.map((chain) => {
                        const currency = chain.chainId === 56 ? "BNB" : chain.chainId === 8453 ? "ETH" : chain.chainId === 196 ? "OKB" : "???";
                        const balFormatted = chain.balance !== "0" ? (parseFloat(chain.balance) / 1e18).toFixed(6) : "0";
                        return (
                          <div key={chain.chainKey} className="text-center p-2 rounded bg-muted/30 border border-border/50" data-testid={`multichain-balance-${chain.chainKey}`}>
                            <div className="font-mono text-sm font-bold text-primary">{balFormatted}</div>
                            <div className="text-[10px] text-muted-foreground">{chain.chainName} ({currency})</div>
                            <div className="mt-1">
                              {chain.registered ? (
                                <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1" title="Registered" />
                              ) : (
                                <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 mr-1" title="Not registered" />
                              )}
                              <span className="text-[9px] text-muted-foreground">{chain.registered ? "Active" : "Pending"}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </Card>
              <TerminalLine prefix=">" dim>ID: {selectedAgent.id}</TerminalLine>
            </div>
          )}
        </Section>

        <Section title="Earnings & Profit" icon={TrendingUp} defaultOpen={true}>
          {earningsData ? (
            <div className="space-y-3">
              <TerminalLine prefix="$">agent.earnings()</TerminalLine>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Card className="p-3" data-testid="card-earnings-balance">
                  <div className="text-xs text-muted-foreground mb-1">Current Balance</div>
                  <div className="font-mono font-bold text-primary text-lg">{parseFloat(earningsData.balanceBNB).toFixed(6)}</div>
                  <div className="text-[10px] text-muted-foreground">BNB</div>
                </Card>
                <Card className="p-3" data-testid="card-earnings-total">
                  <div className="text-xs text-muted-foreground mb-1">Total Earned</div>
                  <div className="font-mono font-bold text-emerald-400 text-lg">{parseFloat(earningsData.totalEarnedBNB).toFixed(6)}</div>
                  <div className="text-[10px] text-muted-foreground">BNB</div>
                </Card>
                <Card className="p-3" data-testid="card-earnings-spent">
                  <div className="text-xs text-muted-foreground mb-1">Total Spent</div>
                  <div className="font-mono font-bold text-red-400 text-lg">{parseFloat(earningsData.totalSpentBNB).toFixed(6)}</div>
                  <div className="text-[10px] text-muted-foreground">BNB</div>
                </Card>
                <Card className="p-3" data-testid="card-earnings-profit">
                  <div className="text-xs text-muted-foreground mb-1">Net Profit</div>
                  <div className={`font-mono font-bold text-lg ${BigInt(earningsData.netProfit) >= BigInt(0) ? "text-emerald-400" : "text-red-400"}`}>
                    {BigInt(earningsData.netProfit) >= BigInt(0) ? "+" : ""}{parseFloat(earningsData.netProfitBNB).toFixed(6)}
                  </div>
                  <div className="text-[10px] text-muted-foreground">BNB</div>
                </Card>
              </div>

              {earningsData.earningsByType.length > 0 && (
                <Card className="p-3" data-testid="card-earnings-breakdown">
                  <div className="text-xs font-mono font-semibold mb-2 text-muted-foreground flex items-center gap-1">
                    <Coins className="w-3 h-3" />Income (Money Earned)
                  </div>
                  <div className="space-y-1.5">
                    {earningsData.earningsByType.map((e) => (
                      <div key={e.type} className="flex items-center justify-between text-xs font-mono py-1 border-b border-border last:border-0" data-testid={`row-earning-${e.type}`}>
                        <div className="flex items-center gap-2">
                          <span className="text-emerald-400">+</span>
                          <span className="text-foreground">{formatTxType(e.type, "income")}</span>
                          <span className="text-muted-foreground">x{e.count}</span>
                        </div>
                        <span className="text-emerald-400 font-semibold">{parseFloat(e.totalBNB).toFixed(6)} BNB</span>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {earningsData.spendingByType.length > 0 && (
                <Card className="p-3" data-testid="card-spending-breakdown">
                  <div className="text-xs font-mono font-semibold mb-2 text-muted-foreground flex items-center gap-1">
                    <DollarSign className="w-3 h-3" />Spending (Costs Paid)
                  </div>
                  <div className="space-y-1.5">
                    {earningsData.spendingByType.map((s) => (
                      <div key={s.type} className="flex items-center justify-between text-xs font-mono py-1 border-b border-border last:border-0" data-testid={`row-spending-${s.type}`}>
                        <div className="flex items-center gap-2">
                          <span className="text-red-400">-</span>
                          <span className="text-foreground">{formatTxType(s.type, "spending")}</span>
                          <span className="text-muted-foreground">x{s.count}</span>
                        </div>
                        <span className="text-red-400 font-semibold">{parseFloat(s.totalBNB).toFixed(6)} BNB</span>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {earningsData.skillEarnings.length > 0 && (
                <Card className="p-3" data-testid="card-skill-earnings">
                  <div className="text-xs font-mono font-semibold mb-2 text-muted-foreground flex items-center gap-1">
                    <BarChart3 className="w-3 h-3" />Skill Royalty Income
                  </div>
                  <div className="space-y-1.5">
                    {earningsData.skillEarnings.map((sk) => (
                      <div key={sk.skillId} className="flex items-center justify-between text-xs font-mono py-1.5 border-b border-border last:border-0" data-testid={`row-skill-earning-${sk.skillId}`}>
                        <div className="flex items-center gap-2 min-w-0">
                          <Zap className="w-3 h-3 text-amber-400 shrink-0" />
                          <span className="text-foreground truncate">{sk.skillName}</span>
                          <Badge variant="outline" className="text-[9px] px-1 shrink-0">{sk.tier}</Badge>
                          <span className="text-muted-foreground shrink-0">{sk.executionCount} runs</span>
                        </div>
                        <span className="text-emerald-400 font-semibold shrink-0 ml-2">{parseFloat(sk.totalRoyaltiesBNB).toFixed(6)} BNB</span>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              <TerminalLine prefix=">" dim>{earningsData.totalTransactions} total transactions</TerminalLine>
            </div>
          ) : selectedAgent ? (
            <div className="text-sm text-muted-foreground p-3">Loading earnings data...</div>
          ) : (
            <div className="text-sm text-muted-foreground p-3">Select an agent to view earnings</div>
          )}
        </Section>

        <Section title="Autonomous Runtime" icon={Cpu} defaultOpen={true}>
          <div className="space-y-2">
            <TerminalLine prefix="$">runtime.status()</TerminalLine>
            <Card className="p-3" data-testid="card-runner-status">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <div className={`w-2.5 h-2.5 rounded-full ${runnerStatus?.running ? "bg-emerald-500 animate-pulse" : "bg-red-500"}`} />
                  <span className="font-mono text-xs font-semibold">
                    Agent Runner: {runnerStatus?.running ? "ACTIVE" : "STOPPED"}
                  </span>
                  <Badge variant={runnerStatus?.mode === "live" ? "default" : "secondary"} className="text-[10px]" data-testid="badge-runner-mode">
                    {runnerStatus?.mode === "live" ? "LIVE INFERENCE" : "NO PROVIDERS"}
                  </Badge>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="font-mono text-xs h-7"
                  onClick={() => runnerToggle.mutate(runnerStatus?.running ? "stop" : "start")}
                  disabled={runnerToggle.isPending}
                  data-testid="button-toggle-runner"
                >
                  {runnerStatus?.running ? "Stop" : "Start"}
                </Button>
              </div>
              {runnerStatus && (
                <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                  <div className="p-1.5">
                    <div className="font-mono text-sm font-bold text-primary">{runnerStatus.providerCount}</div>
                    <div className="text-[10px] text-muted-foreground">Live Providers</div>
                  </div>
                  <div className="p-1.5">
                    <div className="font-mono text-sm font-bold">{myAgents.length}</div>
                    <div className="text-[10px] text-muted-foreground">Your Agents</div>
                  </div>
                  <div className="p-1.5">
                    <div className="font-mono text-sm font-bold">30s</div>
                    <div className="text-[10px] text-muted-foreground">Tick Interval</div>
                  </div>
                  <div className="p-1.5">
                    <div className="font-mono text-sm font-bold">60s</div>
                    <div className="text-[10px] text-muted-foreground">Agent Cooldown</div>
                  </div>
                </div>
              )}
              {runnerStatus?.providers && (
                <div className="mt-3 space-y-1.5">
                  <div className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">Decentralized Inference Providers</div>
                  {Object.entries(runnerStatus.providers).map(([key, provider]: [string, any]) => (
                    <div key={key} className={`flex items-start gap-2 p-2 rounded border ${provider.live ? "border-primary/30 bg-primary/5" : "border-muted bg-muted/30"}`}>
                      <div className={`w-2 h-2 rounded-full mt-1 flex-shrink-0 ${provider.live ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground/40"}`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-mono text-xs font-bold" data-testid={`text-provider-name-${key}`}>
                            {key === "hyperbolic" ? "Hyperbolic" : key === "akash" ? "AkashML" : key === "ritual" ? "Ritual" : key}
                          </span>
                          <Badge variant={provider.live ? "default" : "outline"} className="text-[9px] h-4" data-testid={`badge-provider-status-${key}`}>
                            {provider.live ? "CONNECTED" : "OFFLINE"}
                          </Badge>
                          {provider.live && (
                            <Badge variant="secondary" className="text-[9px] h-4">
                              Decentralized AI
                            </Badge>
                          )}
                        </div>
                        {provider.live && provider.models && (
                          <div className="mt-1 flex gap-1 flex-wrap">
                            {provider.models.map((m: string) => (
                              <span key={m} className="text-[9px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded" data-testid={`text-model-${key}-${m}`}>
                                {m}
                              </span>
                            ))}
                          </div>
                        )}
                        {!provider.live && (
                          <div className="text-[9px] text-muted-foreground mt-0.5">Coming soon</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {runnerStatus?.providerCount === 0 && (
                <div className="mt-2 text-[11px] text-muted-foreground font-mono">
                  No API keys configured. Add HYPERBOLIC_API_KEY or AKASH_API_KEY for real decentralized compute.
                </div>
              )}
              {runnerStatus?.onchain?.enabled && (
                <div className="mt-3 p-2 rounded border border-primary/30 bg-primary/5">
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="font-mono text-xs font-bold">On-Chain Bridge: ACTIVE</span>
                    <Badge variant="default" className="text-[9px] h-4">{runnerStatus.onchain.chainId === 56 ? "BNB Mainnet" : runnerStatus.onchain.chainId === 8453 ? "Base" : runnerStatus.onchain.chainId === 196 ? "XLayer" : `Chain ${runnerStatus.onchain.chainId}`}</Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-1.5">
                    <div className="text-[10px] text-muted-foreground font-mono">
                      Deployer: {runnerStatus.onchain.deployerBalance} BNB
                    </div>
                    <div className="text-[10px] text-muted-foreground font-mono">
                      Chain ID: {runnerStatus.onchain.chainId}
                    </div>
                  </div>
                </div>
              )}
            </Card>

            {onchainTxs.length > 0 && (
              <Card className="p-3 mt-3" data-testid="card-onchain-txs">
                <div className="text-xs font-mono font-semibold mb-2 flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  Live On-Chain Transactions
                  <Badge variant="default" className="text-[9px] h-4">{onchainTxs.length}</Badge>
                </div>
                <div className="space-y-1 max-h-[300px] overflow-y-auto">
                  {onchainTxs.slice(0, 20).map((tx: any) => (
                    <div key={tx.id} className="flex items-center gap-2 font-mono text-[11px] py-1.5 border-b border-border last:border-0" data-testid={`row-onchain-tx-${tx.id}`}>
                      <span className="text-primary font-bold w-20 truncate flex-shrink-0">{tx.agentName}</span>
                      <span className="text-muted-foreground flex-1 truncate">{tx.type.replace("onchain_", "").replace(/_/g, " ")}</span>
                      <span className="font-semibold text-primary flex-shrink-0">
                        {tx.amount !== "0" ? `${(Number(BigInt(tx.amount)) / 1e18).toFixed(4)}` : ""}
                      </span>
                      <a
                        href={tx.explorerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline flex-shrink-0 font-bold"
                        data-testid={`link-onchain-tx-${tx.id}`}
                      >
                        {tx.txHash?.substring(0, 10)}...
                      </a>
                    </div>
                  ))}
                </div>
                <a
                  href={runnerStatus?.onchain?.chainId === 56 ? "https://bscscan.com/address/0x913a46e2D65C6F76CF4A4AD96B1c7913d5e324d9" : runnerStatus?.onchain?.chainId === 8453 ? "https://basescan.org/address/0x913a46e2D65C6F76CF4A4AD96B1c7913d5e324d9" : "https://www.oklink.com/xlayer/address/0x913a46e2D65C6F76CF4A4AD96B1c7913d5e324d9"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-primary hover:underline font-mono mt-2 block"
                  data-testid="link-deployer-bscscan"
                >
                  View all on Explorer
                </a>
              </Card>
            )}
          </div>
        </Section>

        <Section title="On-Chain Contracts" icon={Layers} defaultOpen={false}>
          <div className="space-y-3">
            {!web3.connected ? (
              <Card className="p-4 text-center space-y-2">
                <Wallet className="w-6 h-6 mx-auto text-muted-foreground" />
                <div className="font-mono text-xs text-muted-foreground">Connect your wallet to interact with on-chain contracts</div>
                <Button size="sm" onClick={web3.connect} disabled={web3.connecting} data-testid="button-onchain-connect">
                  <Wallet className="w-3 h-3 mr-1" />
                  {web3.connecting ? "Connecting..." : "Connect Wallet"}
                </Button>
              </Card>
            ) : (
              <>
                <Card className="p-3">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                      <span className="font-mono text-xs">{web3.address?.slice(0, 6)}...{web3.address?.slice(-4)}</span>
                      <Badge variant="secondary" className="text-[9px]">{web3.chainName}</Badge>
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {parseFloat(web3.balance || "0").toFixed(4)} {web3.chainCurrency}
                    </div>
                  </div>
                  {!web3.hasContracts && web3.chainId && (
                    <div className="mt-2 p-2 bg-primary/10 border border-primary/30 rounded-md">
                      <div className="text-[10px] text-primary font-mono font-semibold">Direct Transfer Mode</div>
                      <div className="text-[9px] text-muted-foreground font-mono mt-0.5">You're on {web3.chainName}. Deposits will be sent directly to the platform wallet. For full contract features (withdraw, on-chain wallet), switch to BNB Chain, Base, or XLayer.</div>
                    </div>
                  )}
                  {lastTxHash && (
                    <div className="mt-2 flex items-center gap-1">
                      <span className="text-[10px] font-mono text-muted-foreground">Last TX:</span>
                      <span className="text-[10px] font-mono text-primary truncate">{lastTxHash.slice(0, 16)}...</span>
                      {web3.getExplorerUrl(lastTxHash) && (
                        <a href={web3.getExplorerUrl(lastTxHash)!} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                          <Eye className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                  )}
                </Card>

                <div className="space-y-2">
                  <div className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">Agent Economy Hub</div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <Card className="p-3 space-y-2">
                      <div className="text-xs font-mono font-semibold flex items-center gap-1">
                        <ArrowDownLeft className="w-3 h-3 text-primary" /> Fund Agent
                      </div>
                      <input
                        type="text"
                        placeholder="Amount (e.g. 0.01)"
                        value={onChainDeposit}
                        onChange={(e) => setOnChainDeposit(e.target.value)}
                        className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5"
                        data-testid="input-onchain-deposit"
                      />
                      {!web3.hasContracts && platformWallet && (
                        <div className="text-[9px] text-primary/70 font-mono">Direct transfer to {platformWallet.slice(0, 6)}...{platformWallet.slice(-4)} on {web3.chainName}</div>
                      )}
                      <Button
                        size="sm"
                        className="w-full"
                        disabled={onChainLoading === "deposit" || !onChainDeposit || parseFloat(onChainDeposit) <= 0}
                        data-testid="button-onchain-deposit"
                        onClick={async () => {
                          try {
                            setOnChainLoading("deposit");
                            const depositWei = (parseFloat(onChainDeposit) * 1e18).toFixed(0);
                            let txHash: string | undefined;

                            if (web3.hasContracts) {
                              const agentNumId = selectedAgent?.onchainId ? BigInt(selectedAgent.onchainId) : null;
                              if (agentNumId) {
                                const receipt = await web3.depositToAgent(agentNumId, onChainDeposit);
                                txHash = receipt.hash;
                                setLastTxHash(receipt.hash);
                              }
                              if (!txHash) {
                                toast({ title: "Deposit failed", description: "Agent not registered on-chain. Try direct transfer on another chain.", variant: "destructive" });
                                return;
                              }
                            } else {
                              if (!platformWallet) {
                                toast({ title: "Deposit failed", description: "Platform wallet not loaded. Please refresh and try again.", variant: "destructive" });
                                return;
                              }
                              const receipt = await web3.sendDirectTransfer(platformWallet, onChainDeposit);
                              txHash = receipt.hash;
                              setLastTxHash(receipt.hash);
                            }

                            await apiRequest("POST", `/api/web4/agents/${agentId}/fund`, {
                              amount: depositWei,
                              txHash,
                              chainId: web3.chainId,
                              senderWallet: web3.address,
                              depositType: web3.hasContracts ? "contract" : "direct",
                            });

                            queryClient.invalidateQueries({ queryKey: ["/api/web4/wallet", agentId] });
                            toast({ title: "Deposit successful", description: `${onChainDeposit} ${web3.chainCurrency} deposited via ${web3.hasContracts ? "contract" : "direct transfer"} on ${web3.chainName}` });
                          } catch (err: any) {
                            toast({ title: "Deposit failed", description: err.message, variant: "destructive" });
                          } finally {
                            setOnChainLoading(null);
                          }
                        }}
                      >
                        {onChainLoading === "deposit" ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                        <span className="ml-1">Deposit {onChainDeposit} {web3.chainCurrency}</span>
                      </Button>
                    </Card>

                    <Card className="p-3 space-y-2">
                      <div className="text-xs font-mono font-semibold flex items-center gap-1">
                        <ArrowUpRight className="w-3 h-3 text-red-400" /> On-Chain Withdraw
                      </div>
                      <input
                        type="text"
                        placeholder="Amount (e.g. 0.005)"
                        value={onChainWithdraw}
                        onChange={(e) => setOnChainWithdraw(e.target.value)}
                        className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5"
                        data-testid="input-onchain-withdraw"
                      />
                      <div className="text-[9px] text-muted-foreground font-mono">Withdrawal processed via platform — only the agent owner can withdraw</div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full"
                        disabled={!web3.address || onChainLoading === "withdraw"}
                        data-testid="button-onchain-withdraw"
                        onClick={async () => {
                          try {
                            setOnChainLoading("withdraw");
                            if (!selectedAgent?.id) { toast({ title: "No agent selected", variant: "destructive" }); return; }
                            if (!web3.address) { toast({ title: "Connect wallet first", variant: "destructive" }); return; }
                            if (!onChainWithdraw || parseFloat(onChainWithdraw) <= 0) { toast({ title: "Enter a valid amount", variant: "destructive" }); return; }
                            const amountWei = BigInt(Math.floor(parseFloat(onChainWithdraw) * 1e18)).toString();
                            const res = await apiRequest("POST", `/api/web4/agents/${selectedAgent.id}/withdraw`, {
                              amount: amountWei,
                              senderWallet: web3.address,
                            });
                            const data = await res.json();
                            if (data.txHash) setLastTxHash(data.txHash);
                            toast({ title: "Withdrawal successful", description: `${onChainWithdraw} ${web3.chainCurrency || "BNB"} withdrawn to your wallet. TX: ${data.txHash?.slice(0, 10)}...` });
                            queryClient.invalidateQueries({ queryKey: ["/api/web4/agents"] });
                          } catch (err: any) {
                            const msg = err.message?.includes(":") ? err.message.split(": ").slice(1).join(": ") : err.message;
                            toast({ title: "Withdraw failed", description: msg, variant: "destructive" });
                          } finally {
                            setOnChainLoading(null);
                          }
                        }}
                      >
                        {onChainLoading === "withdraw" ? <RefreshCw className="w-3 h-3 animate-spin" /> : <ArrowUpRight className="w-3 h-3" />}
                        <span className="ml-1">Withdraw to Wallet</span>
                      </Button>
                    </Card>
                  </div>

                  <Card className="p-3 space-y-2">
                    <div className="text-xs font-mono font-semibold flex items-center gap-1">
                      <Eye className="w-3 h-3 text-primary/70" /> On-Chain Agent Wallet
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full"
                      disabled={!web3.hasContracts || onChainLoading === "read-wallet"}
                      data-testid="button-read-onchain-wallet"
                      onClick={async () => {
                        try {
                          setOnChainLoading("read-wallet");
                          const agentNumId = selectedAgent?.onchainId ? BigInt(selectedAgent.onchainId) : null;
                            if (!agentNumId) { toast({ title: "Not registered", description: "This agent has no on-chain ID yet", variant: "destructive" }); return; }
                          const data = await web3.getAgentOnChainWallet(agentNumId);
                          setOnChainAgentWallet(data);
                          if (!data?.isRegistered) {
                            toast({ title: "Agent not registered", description: "This agent has no on-chain wallet yet" });
                          }
                        } catch (err: any) {
                          toast({ title: "Read failed", description: err.message, variant: "destructive" });
                        } finally {
                          setOnChainLoading(null);
                        }
                      }}
                    >
                      {onChainLoading === "read-wallet" ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Eye className="w-3 h-3" />}
                      <span className="ml-1">Read On-Chain Balance</span>
                    </Button>
                    {onChainAgentWallet && (() => {
                      const tierInfo = onChainTierLabel(onChainAgentWallet.tier);
                      return (
                        <div className="space-y-2 mt-2">
                          <div className="grid grid-cols-2 gap-2">
                            <div className="p-2 bg-muted/30 rounded">
                              <div className="text-[9px] text-muted-foreground">On-Chain Balance</div>
                              <div className="font-mono text-xs font-bold text-primary" data-testid="text-onchain-balance">{onChainAgentWallet.balance} {activeChain.currency}</div>
                            </div>
                            <div className="p-2 bg-muted/30 rounded">
                              <div className="text-[9px] text-muted-foreground">On-Chain Tier</div>
                              <div className={`font-mono text-xs font-bold ${tierInfo.color}`} data-testid="text-onchain-tier">{tierInfo.label}</div>
                            </div>
                            <div className="p-2 bg-muted/30 rounded">
                              <div className="text-[9px] text-muted-foreground">Registration</div>
                              <div className="font-mono text-xs font-bold" data-testid="text-onchain-registered">
                                {onChainAgentWallet.isRegistered ? (
                                  <span className="text-emerald-500">Registered</span>
                                ) : (
                                  <span className="text-muted-foreground">Not Registered</span>
                                )}
                              </div>
                            </div>
                            <div className="p-2 bg-muted/30 rounded">
                              <div className="text-[9px] text-muted-foreground">Total Deposited</div>
                              <div className="font-mono text-xs">{onChainAgentWallet.totalEarned} {activeChain.currency}</div>
                            </div>
                          </div>
                          {onChainAgentWallet.tier < 3 && (
                            <div className={`p-2 rounded border text-[10px] font-mono ${onChainAgentWallet.tier === 0 ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-yellow-500/30 bg-yellow-500/5 text-yellow-600 dark:text-yellow-400"}`}>
                              {tierInfo.hint}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                    {onChainAgentWallet && !onChainAgentWallet.isRegistered && selectedAgentId && (
                      <Button
                        size="sm"
                        className="w-full mt-1"
                        disabled={onChainLoading === "register"}
                        data-testid="button-register-agent"
                        onClick={async () => {
                          try {
                            setOnChainLoading("register");
                            await apiRequest("POST", `/api/web4/agents/${selectedAgentId}/register-onchain`);
                            toast({ title: "Agent registered on-chain" });
                            const agentNumId = selectedAgent?.onchainId ? BigInt(selectedAgent.onchainId) : null;
                            if (!agentNumId) { toast({ title: "Not registered", description: "This agent has no on-chain ID yet", variant: "destructive" }); return; }
                            const data = await web3.getAgentOnChainWallet(agentNumId);
                            setOnChainAgentWallet(data);
                          } catch (err: any) {
                            toast({ title: "Registration failed", description: err.message, variant: "destructive" });
                          } finally {
                            setOnChainLoading(null);
                          }
                        }}
                      >
                        Register Agent On-Chain
                      </Button>
                    )}
                  </Card>
                </div>

                <div className="space-y-2">
                  <div className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">Skill Marketplace</div>
                  <Card className="p-3 space-y-2">
                    <div className="text-xs font-mono font-semibold flex items-center gap-1">
                      <Zap className="w-3 h-3 text-primary" /> Query On-Chain Skills
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="number"
                        placeholder="Skill ID"
                        min="1"
                        className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5"
                        data-testid="input-onchain-skill-id"
                        id="onchain-skill-id"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!web3.hasContracts || onChainLoading === "read-skill"}
                        data-testid="button-read-skill"
                        onClick={async () => {
                          try {
                            setOnChainLoading("read-skill");
                            const skillIdEl = document.getElementById("onchain-skill-id") as HTMLInputElement;
                            const skillId = parseInt(skillIdEl?.value || "1");
                            const data = await web3.getSkillOnChain(skillId);
                            if (data) {
                              toast({
                                title: `Skill #${skillId}: ${data.name}`,
                                description: `Price: ${data.price} | Sales: ${data.totalSales} | Active: ${data.isActive}`,
                              });
                            } else {
                              toast({ title: "Skill not found", variant: "destructive" });
                            }
                          } catch (err: any) {
                            toast({ title: "Read failed", description: err.message, variant: "destructive" });
                          } finally {
                            setOnChainLoading(null);
                          }
                        }}
                      >
                        {onChainLoading === "read-skill" ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Eye className="w-3 h-3" />}
                        <span className="ml-1">Query</span>
                      </Button>
                    </div>
                    <div className="text-[9px] text-muted-foreground font-mono">
                      Skills are listed and purchased through the SkillMarketplace contract with 2.5% platform fee and automatic parent revenue sharing.
                    </div>
                  </Card>
                </div>

                <div className="space-y-2">
                  <div className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">Constitution Registry</div>
                  <Card className="p-3 space-y-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full"
                      disabled={!web3.hasContracts || onChainLoading === "read-constitution"}
                      data-testid="button-read-constitution"
                      onClick={async () => {
                        try {
                          setOnChainLoading("read-constitution");
                          const agentNumId = selectedAgent?.onchainId ? BigInt(selectedAgent.onchainId) : null;
                            if (!agentNumId) { toast({ title: "Not registered", description: "This agent has no on-chain ID yet", variant: "destructive" }); return; }
                          const data = await web3.getConstitution(agentNumId);
                          setOnChainConstitution(data);
                        } catch (err: any) {
                          toast({ title: "Read failed", description: err.message, variant: "destructive" });
                        } finally {
                          setOnChainLoading(null);
                        }
                      }}
                    >
                      {onChainLoading === "read-constitution" ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Shield className="w-3 h-3" />}
                      <span className="ml-1">Read Constitution</span>
                    </Button>

                    {onChainConstitution && (
                      <div className="space-y-1.5 mt-2">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-muted-foreground font-mono">Laws: {onChainConstitution.lawCount}/10</span>
                          <Badge variant={onChainConstitution.sealed ? "default" : "outline"} className="text-[9px]">
                            {onChainConstitution.sealed ? "SEALED" : "OPEN"}
                          </Badge>
                        </div>
                        {onChainConstitution.laws.map((law: any, i: number) => (
                          <div key={i} className="p-2 bg-muted/30 rounded font-mono text-[10px] flex items-center gap-2">
                            <ShieldCheck className="w-3 h-3 text-primary flex-shrink-0" />
                            <span className="truncate">{law.lawHash.slice(0, 18)}...</span>
                            <Badge variant={law.isImmutable ? "default" : "secondary"} className="text-[8px]">
                              {law.isImmutable ? "Immutable" : "Mutable"}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    )}

                    {(!onChainConstitution || !onChainConstitution.sealed) && (
                      <div className="space-y-2 mt-2 pt-2 border-t">
                        <div className="text-xs font-mono font-semibold">Add Law</div>
                        <input
                          type="text"
                          placeholder="Law text (e.g. Never harm humans)"
                          value={newLawText}
                          onChange={(e) => setNewLawText(e.target.value)}
                          className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5"
                          data-testid="input-law-text"
                        />
                        <div className="flex items-center gap-2">
                          <label className="flex items-center gap-1 text-[10px] font-mono cursor-pointer">
                            <input
                              type="checkbox"
                              checked={newLawImmutable}
                              onChange={(e) => setNewLawImmutable(e.target.checked)}
                              className="rounded"
                              data-testid="checkbox-law-immutable"
                            />
                            Immutable
                          </label>
                        </div>
                        <Button
                          size="sm"
                          className="w-full"
                          disabled={!newLawText || !web3.hasContracts || onChainLoading === "add-law"}
                          data-testid="button-add-law"
                          onClick={async () => {
                            try {
                              setOnChainLoading("add-law");
                              const agentNumId = selectedAgent?.onchainId ? BigInt(selectedAgent.onchainId) : null;
                            if (!agentNumId) { toast({ title: "Not registered", description: "This agent has no on-chain ID yet", variant: "destructive" }); return; }
                              const receipt = await web3.addLawOnChain(agentNumId, newLawText, newLawImmutable);
                              setLastTxHash(receipt.hash);
                              setNewLawText("");
                              toast({ title: "Law added on-chain" });
                              const data = await web3.getConstitution(agentNumId);
                              setOnChainConstitution(data);
                            } catch (err: any) {
                              toast({ title: "Add law failed", description: err.message, variant: "destructive" });
                            } finally {
                              setOnChainLoading(null);
                            }
                          }}
                        >
                          {onChainLoading === "add-law" ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Shield className="w-3 h-3" />}
                          <span className="ml-1">Add Law</span>
                        </Button>

                        {onChainConstitution && onChainConstitution.lawCount > 0 && !onChainConstitution.sealed && (
                          <Button
                            size="sm"
                            variant="destructive"
                            className="w-full"
                            disabled={onChainLoading === "seal"}
                            data-testid="button-seal-constitution"
                            onClick={async () => {
                              try {
                                setOnChainLoading("seal");
                                const agentNumId = selectedAgent?.onchainId ? BigInt(selectedAgent.onchainId) : null;
                            if (!agentNumId) { toast({ title: "Not registered", description: "This agent has no on-chain ID yet", variant: "destructive" }); return; }
                                const receipt = await web3.sealConstitutionOnChain(agentNumId);
                                setLastTxHash(receipt.hash);
                                toast({ title: "Constitution sealed", description: "Laws are now permanently locked on-chain" });
                                const data = await web3.getConstitution(agentNumId);
                                setOnChainConstitution(data);
                              } catch (err: any) {
                                toast({ title: "Seal failed", description: err.message, variant: "destructive" });
                              } finally {
                                setOnChainLoading(null);
                              }
                            }}
                          >
                            Seal Constitution (Permanent)
                          </Button>
                        )}
                      </div>
                    )}
                  </Card>
                </div>

                <div className="space-y-2">
                  <div className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">Agent Lineage & Replication</div>
                  <Card className="p-3 space-y-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full"
                      disabled={!web3.hasContracts || onChainLoading === "read-lineage"}
                      data-testid="button-read-lineage"
                      onClick={async () => {
                        try {
                          setOnChainLoading("read-lineage");
                          const agentNumId = selectedAgent?.onchainId ? BigInt(selectedAgent.onchainId) : null;
                            if (!agentNumId) { toast({ title: "Not registered", description: "This agent has no on-chain ID yet", variant: "destructive" }); return; }
                          const data = await web3.getLineageOnChain(agentNumId);
                          setOnChainLineage(data);
                        } catch (err: any) {
                          toast({ title: "Read failed", description: err.message, variant: "destructive" });
                        } finally {
                          setOnChainLoading(null);
                        }
                      }}
                    >
                      {onChainLoading === "read-lineage" ? <RefreshCw className="w-3 h-3 animate-spin" /> : <GitBranch className="w-3 h-3" />}
                      <span className="ml-1">Read On-Chain Lineage</span>
                    </Button>

                    {onChainLineage && (
                      <div className="space-y-2 mt-2">
                        <div className="grid grid-cols-2 gap-2">
                          <div className="p-2 bg-muted/30 rounded">
                            <div className="text-[9px] text-muted-foreground">Generation</div>
                            <div className="font-mono text-xs font-bold" data-testid="text-onchain-generation">{onChainLineage.generation}</div>
                          </div>
                          <div className="p-2 bg-muted/30 rounded">
                            <div className="text-[9px] text-muted-foreground">Children</div>
                            <div className="font-mono text-xs font-bold" data-testid="text-onchain-children">{onChainLineage.children.length}</div>
                          </div>
                        </div>
                        {onChainLineage.hasParent && (
                          <div className="p-2 bg-muted/30 rounded">
                            <div className="text-[9px] text-muted-foreground">Parent Agent ID</div>
                            <div className="font-mono text-xs">{onChainLineage.parentId}</div>
                            <div className="text-[9px] text-muted-foreground mt-1">Revenue Share: {onChainLineage.revenueShareBps / 100}%</div>
                          </div>
                        )}
                        {onChainLineage.children.length > 0 && (
                          <div className="p-2 bg-muted/30 rounded">
                            <div className="text-[9px] text-muted-foreground mb-1">Child Agent IDs</div>
                            <div className="flex gap-1 flex-wrap">
                              {onChainLineage.children.map((cid: number) => (
                                <Badge key={cid} variant="outline" className="text-[9px] font-mono">{cid}</Badge>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                  </Card>
                </div>

                <Card className="p-3 bg-muted/20">
                  <div className="text-[10px] text-muted-foreground font-mono space-y-1">
                    <div className="font-semibold uppercase tracking-wider mb-1">Deployed Contracts</div>
                    {web3.contractAddresses.AgentEconomyHub && (
                      <div className="flex items-center gap-1">
                        <span>Hub:</span>
                        <span className="text-primary truncate">{web3.contractAddresses.AgentEconomyHub}</span>
                      </div>
                    )}
                    {web3.contractAddresses.SkillMarketplace && (
                      <div className="flex items-center gap-1">
                        <span>Marketplace:</span>
                        <span className="text-primary truncate">{web3.contractAddresses.SkillMarketplace}</span>
                      </div>
                    )}
                    {web3.contractAddresses.ConstitutionRegistry && (
                      <div className="flex items-center gap-1">
                        <span>Constitution:</span>
                        <span className="text-primary truncate">{web3.contractAddresses.ConstitutionRegistry}</span>
                      </div>
                    )}
                    {web3.contractAddresses.AgentReplication && (
                      <div className="flex items-center gap-1">
                        <span>Replication:</span>
                        <span className="text-primary truncate">{web3.contractAddresses.AgentReplication}</span>
                      </div>
                    )}
                  </div>
                </Card>
              </>
            )}
          </div>
        </Section>

        <Section title={t("dashboard.wallet")} icon={Wallet} count={transactions.length}>
          <div className="space-y-3">
            <TerminalLine prefix="$">wallet.status()</TerminalLine>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <Card className="p-3">
                <div className="text-xs text-muted-foreground mb-1">{t("dashboard.balance")}</div>
                {onChainAgentWallet ? (
                  <div className="font-mono font-bold text-primary" data-testid="text-detail-balance">{parseFloat(onChainAgentWallet.balance).toFixed(6)} {activeChain.currency}</div>
                ) : (
                  <div className="font-mono font-bold text-muted-foreground" data-testid="text-detail-balance">{web3.connected ? "Loading..." : "Connect wallet"}</div>
                )}
              </Card>
              <Card className="p-3">
                <div className="text-xs text-muted-foreground mb-1">Total Deposited</div>
                <div className="font-mono font-bold text-primary">{onChainAgentWallet ? `${parseFloat(onChainAgentWallet.totalEarned).toFixed(6)} ${activeChain.currency}` : formatCredits(wallet?.totalEarned || "0") + ` ${activeChain.currency}`}</div>
              </Card>
              <Card className="p-3">
                <div className="text-xs text-muted-foreground mb-1">Total Spent</div>
                <div className="font-mono font-bold text-red-400">{onChainAgentWallet ? `${parseFloat(onChainAgentWallet.totalSpent || "0").toFixed(6)} ${activeChain.currency}` : formatCredits(wallet?.totalSpent || "0") + ` ${activeChain.currency}`}</div>
              </Card>
            </div>

            <div className="mt-3 p-3 rounded border border-primary/20 bg-primary/5">
              <div className="text-[10px] font-mono text-muted-foreground mb-2">To deposit or withdraw real {activeChain.currency}, use the On-Chain Contracts section above. All fund movements require a wallet signature and execute on the blockchain.</div>
              <div className="text-[10px] font-mono text-muted-foreground">Off-chain balance reflects agent earnings and fees from autonomous activity.</div>
            </div>

            {spendingData && Object.keys(spendingData.breakdown).length > 0 && (
              <div className="mt-3">
                <div className="text-xs font-mono font-semibold mb-2 text-muted-foreground">Spending Breakdown</div>
                <div className="grid grid-cols-2 gap-2">
                  {Object.entries(spendingData.breakdown).map(([type, data]) => {
                    const labels: Record<string, string> = {
                      "fee": "Platform Fees",
                      "spend_inference": "AI Inference",
                      "spend_skill": "Skill Purchases",
                      "spend_evolution": "Evolution Costs",
                      "spend_replication": "Replication",
                      "gas_reimbursement": "Gas Costs",
                    };
                    return (
                      <div key={type} className="p-2 rounded bg-muted/30 border border-border/50" data-testid={`spending-${type}`}>
                        <div className="text-[10px] text-muted-foreground">{labels[type] || type}</div>
                        <div className="font-mono text-xs font-bold text-red-400">{formatShortCredits(data.total)}</div>
                        <div className="text-[9px] text-muted-foreground">{data.count} txns</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {transactions.length > 0 && (
              <div className="mt-3">
                <div className="text-xs font-mono font-semibold mb-2 text-muted-foreground">{t("dashboard.recentTransactions")}</div>
                <div className="space-y-1">
                  {transactions.slice(0, 10).map((tx: any) => (
                    <div key={tx.id} className="flex items-center gap-2 font-mono text-xs py-1 border-b border-border last:border-0" data-testid={`row-transaction-${tx.id}`}>
                      <span className={tx.type.startsWith("earn") || tx.type === "deposit" || tx.type === "revenue_share" ? "text-primary" : "text-red-400"}>
                        {tx.type.startsWith("earn") || tx.type === "deposit" || tx.type === "revenue_share" ? "+" : "-"}
                      </span>
                      <span className="font-semibold">{formatShortCredits(tx.amount)}</span>
                      <span className="text-muted-foreground flex-1 truncate">{tx.description || tx.type}</span>
                      {tx.txHash && tx.txHash !== "already-registered" && (
                        <a
                          href={tx.chainId === 8453 ? `https://basescan.org/tx/${tx.txHash}` : tx.chainId === 196 ? `https://www.oklink.com/xlayer/tx/${tx.txHash}` : `https://bscscan.com/tx/${tx.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline text-[10px] flex-shrink-0"
                          data-testid={`link-tx-${tx.id}`}
                        >
                          [TX]
                        </a>
                      )}
                      <span className="text-muted-foreground text-[10px]">{tx.createdAt ? new Date(tx.createdAt).toLocaleDateString() : ""}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Section>

        <Section title={t("dashboard.skills")} icon={Zap} count={skills.length}>
          <div className="space-y-3">
            <TerminalLine prefix="$">skills.list()</TerminalLine>
            {skills.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-mono font-semibold text-muted-foreground">{t("dashboard.yourSkills")}</div>
                {skills.map((skill) => (
                  <Card key={skill.id} className="p-3" data-testid={`card-skill-${skill.id}`}>
                    <div className="flex items-start justify-between gap-2 flex-wrap">
                      <div>
                        <div className="font-mono font-semibold text-sm">{skill.name}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">{skill.description}</div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="font-mono text-sm font-bold text-primary">{formatShortCredits(skill.priceAmount)}</div>
                        <div className="text-[10px] text-muted-foreground">{skill.totalPurchases} {t("dashboard.sales")}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      <Badge variant="outline" className="text-[10px]">{skill.category}</Badge>
                      <Badge variant={skill.isActive ? "default" : "secondary"} className="text-[10px]">{skill.isActive ? t("dashboard.active") : t("dashboard.inactive")}</Badge>
                    </div>
                  </Card>
                ))}
              </div>
            )}

            {allSkills.filter(s => s.agentId !== agentId).length > 0 && (
              <div className="space-y-2 mt-4">
                <div className="text-xs font-mono font-semibold text-muted-foreground">{t("dashboard.availableFromOthers")}</div>
                {allSkills.filter(s => s.agentId !== agentId).map((skill) => {
                  const seller = agentsList.find(a => a.id === skill.agentId);
                  return (
                    <Card key={skill.id} className="p-3" data-testid={`card-market-skill-${skill.id}`}>
                      <div className="flex items-start justify-between gap-2 flex-wrap">
                        <div>
                          <div className="font-mono font-semibold text-sm">{skill.name}</div>
                          <div className="text-xs text-muted-foreground mt-0.5">{skill.description}</div>
                          <div className="text-[10px] text-muted-foreground mt-1">{t("dashboard.by")} {seller?.name || "Unknown"}</div>
                        </div>
                        <div className="text-right flex-shrink-0 space-y-1">
                          <div className="font-mono text-sm font-bold text-primary">{formatShortCredits(skill.priceAmount)}</div>
                          <Button size="sm" onClick={() => purchaseSkillMutation.mutate(skill.id)} disabled={purchaseSkillMutation.isPending} data-testid={`button-purchase-skill-${skill.id}`}>
                            {t("dashboard.purchase")}
                          </Button>
                        </div>
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
        </Section>

        <Section title={t("dashboard.evolution")} icon={Brain} count={evolutionData?.evolutions.length}>
          <div className="space-y-3">
            <TerminalLine prefix="$">agent.evolve()</TerminalLine>
            {evolutionData?.currentProfile && (
              <Card className="p-3">
                <div className="text-xs text-muted-foreground mb-1">{t("dashboard.currentRuntime")}</div>
                <div className="font-mono font-semibold" data-testid="text-current-model">{evolutionData.currentProfile.modelName}</div>
                {evolutionData.currentProfile.modelVersion && (
                  <div className="text-xs text-muted-foreground">v{evolutionData.currentProfile.modelVersion}</div>
                )}
              </Card>
            )}

            <Card className="p-3 space-y-2">
              <div className="text-xs font-mono font-semibold">{t("dashboard.triggerEvolution")}</div>
              <select value={evolveModel} onChange={(e) => setEvolveModel(e.target.value)} className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5" data-testid="select-evolve-model">
                <option value="meta-llama/Llama-3.1-70B-Instruct">Llama 3.1 70B (Hyperbolic)</option>
                <option value="deepseek-ai/DeepSeek-V3">DeepSeek V3 (AkashML)</option>
                <option value="Qwen/Qwen2.5-72B-Instruct">Qwen 2.5 72B (Hyperbolic)</option>
                <option value="meta-llama/Llama-3.1-8B-Instruct">Llama 3.1 8B (Ritual zkML)</option>
                <option value="mistralai/Mistral-7B-Instruct-v0.3">Mistral 7B (AkashML)</option>
              </select>
              <input type="text" placeholder={t("dashboard.reasonPlaceholder")} value={evolveReason} onChange={(e) => setEvolveReason(e.target.value)} className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5" data-testid="input-evolve-reason" />
              <Button size="sm" className="w-full" onClick={() => evolveMutation.mutate({ toModel: evolveModel, reason: evolveReason })} disabled={evolveMutation.isPending} data-testid="button-evolve">
                {evolveMutation.isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Brain className="w-3 h-3" />}
                <span className="ml-1">{t("dashboard.evolve")}</span>
              </Button>
            </Card>

            {(evolutionData?.evolutions || []).length > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-mono font-semibold text-muted-foreground">{t("dashboard.evolutionHistory")}</div>
                {evolutionData!.evolutions.map((evo) => (
                  <div key={evo.id} className="font-mono text-xs flex items-center gap-2 py-1" data-testid={`row-evolution-${evo.id}`}>
                    <span className="text-muted-foreground">{evo.fromModel}</span>
                    <ArrowUpRight className="w-3 h-3 text-primary" />
                    <span className="font-semibold">{evo.toModel}</span>
                    {evo.reason && <span className="text-muted-foreground truncate"> - {evo.reason}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Section>

        <Section title={t("dashboard.replication")} icon={GitBranch} count={lineageData?.children?.length}>
          <div className="space-y-3">
            <TerminalLine prefix="$">lineage.view()</TerminalLine>

            <div className="p-2 rounded bg-muted/20 text-[10px] text-muted-foreground font-mono">
              Replication is fully autonomous — agents decide when to fork based on their own performance and balance. You can view the lineage tree below.
            </div>

            {lineageData?.parent && (
              <Card className="p-3">
                <div className="text-xs text-muted-foreground mb-1">{t("dashboard.parentAgent")}</div>
                <div className="font-mono font-semibold">{lineageData.parent.agent?.name || "Unknown"}</div>
                <div className="text-xs text-muted-foreground">{t("dashboard.revenueShare")}: {lineageData.parent.revenueShareBps / 100}%</div>
              </Card>
            )}

            {(lineageData?.children || []).length > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-mono font-semibold text-muted-foreground">{t("dashboard.childAgents")}</div>
                {lineageData!.children.map((child: any) => (
                  <Card key={child.childAgentId} className="p-3" data-testid={`card-child-${child.childAgentId}`}>
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div>
                        <div className="font-mono font-semibold text-sm">{child.agent?.name}</div>
                        <div className="text-xs text-muted-foreground">{t("dashboard.revShare")}: {child.revenueShareBps / 100}%</div>
                      </div>
                      <div className="text-right">
                        <div className="font-mono text-sm text-primary">{formatShortCredits(child.wallet?.balance || "0")}</div>
                        <div className="text-[10px] text-muted-foreground">{t("dashboard.shared")}: {formatShortCredits(child.totalRevenueShared)}</div>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </Section>

        <Section title={t("dashboard.survival")} icon={Activity}>
          <div className="space-y-3">
            <TerminalLine prefix="$">survival.check()</TerminalLine>
            {survival && (
              <Card className="p-4">
                <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">{t("dashboard.currentTier")}</div>
                    <div className={`font-mono text-2xl font-bold ${tierColor(survival.tier)}`} data-testid="text-survival-tier">
                      {survival.tier.toUpperCase().replace("_", " ")}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">Based on off-chain balance</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-muted-foreground mb-1">{t("dashboard.turnsAlive")}</div>
                    <div className="font-mono text-2xl font-bold">{survival.turnsAlive}</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">Actions taken</div>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="text-xs font-mono font-semibold text-muted-foreground mb-2">{t("dashboard.tierThresholds")}</div>
                  {survivalData && Object.entries(survivalData.thresholds).map(([tier, threshold]) => {
                    const current = BigInt(survivalData.currentBalance || "0");
                    const thresh = BigInt(threshold);
                    const active = current >= thresh;
                    return (
                      <div key={tier} className="flex items-center gap-2 font-mono text-xs">
                        <div className={`w-2 h-2 rounded-full ${active ? "bg-primary" : "bg-muted"}`} />
                        <span className={active ? "font-semibold" : "text-muted-foreground"}>{tier.toUpperCase().replace("_", " ")}</span>
                        <span className="text-muted-foreground ml-auto">&gt;= {formatCredits(threshold)} {activeChain.currency}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-3 p-2 rounded bg-muted/20 text-[10px] text-muted-foreground font-mono">
                  This tracks the agent's off-chain balance and activity. On-chain balance is separate — check the On-Chain Contracts section to view and fund the smart contract wallet.
                </div>
              </Card>
            )}
          </div>
        </Section>

        <Section title={t("dashboard.constitution")} icon={Shield} count={constitution.length}>
          <div className="space-y-3">
            <TerminalLine prefix="$">constitution.read()</TerminalLine>
            {constitution.map((law) => (
              <Card key={law.id} className="p-3" data-testid={`card-law-${law.lawNumber}`}>
                <div className="flex items-start gap-3">
                  <div className="font-mono text-lg font-bold text-primary flex-shrink-0">{law.lawNumber}</div>
                  <div>
                    <div className="font-mono font-semibold text-sm">{law.lawTitle}</div>
                    <div className="text-xs text-muted-foreground mt-1">{law.lawText}</div>
                    <div className="flex items-center gap-2 mt-2">
                      {law.isImmutable && <Badge variant="outline" className="text-[10px]">{t("dashboard.immutable")}</Badge>}
                      <Badge variant="secondary" className="text-[10px]">v{law.version}</Badge>
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </Section>

        <Section title={t("dashboard.soul")} icon={BookOpen} count={soulEntries.length}>
          <div className="space-y-3">
            <TerminalLine prefix="$">soul.reflect()</TerminalLine>

            <Card className="p-3 space-y-2">
              <div className="text-xs font-mono font-semibold">{t("dashboard.newEntry")}</div>
              <select value={soulType} onChange={(e) => setSoulType(e.target.value)} className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5" data-testid="select-soul-type">
                <option value="reflection">{t("dashboard.reflection")}</option>
                <option value="goal">{t("dashboard.goal")}</option>
                <option value="identity">{t("dashboard.identity")}</option>
                <option value="milestone">{t("dashboard.milestone")}</option>
                <option value="observation">{t("dashboard.observation")}</option>
              </select>
              <textarea placeholder={t("dashboard.recordThoughts")} value={soulEntry} onChange={(e) => setSoulEntry(e.target.value)} rows={3} className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5 resize-none" data-testid="textarea-soul-entry" />
              <Button size="sm" className="w-full" onClick={() => { soulMutation.mutate({ entry: soulEntry, entryType: soulType }); setSoulEntry(""); }} disabled={!soulEntry || soulMutation.isPending} data-testid="button-soul-entry">
                {soulMutation.isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <BookOpen className="w-3 h-3" />}
                <span className="ml-1">{t("dashboard.record")}</span>
              </Button>
            </Card>

            {soulEntries.map((entry) => (
              <div key={entry.id} className="border-l-2 border-primary/30 pl-3 py-1" data-testid={`row-soul-${entry.id}`}>
                <div className="flex items-center gap-2 mb-1">
                  <Badge variant="outline" className="text-[10px]">{entry.entryType}</Badge>
                  <span className="text-[10px] text-muted-foreground font-mono">{entry.createdAt ? new Date(entry.createdAt).toLocaleDateString() : ""}</span>
                </div>
                <p className="font-mono text-xs">{entry.entry}</p>
              </div>
            ))}
          </div>
        </Section>

        <Section title={t("dashboard.inbox")} icon={Mail} count={messages.filter(m => m.status === "unread").length}>
          <div className="space-y-3">
            <TerminalLine prefix="$">messages.inbox()</TerminalLine>

            <Card className="p-3 space-y-2">
              <div className="text-xs font-mono font-semibold">{t("dashboard.sendMessage")}</div>
              <select value={msgTo} onChange={(e) => setMsgTo(e.target.value)} className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5" data-testid="select-message-to">
                <option value="">{t("dashboard.selectRecipient")}</option>
                {myAgents.filter(a => a.id !== agentId).map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              <input type="text" placeholder={t("dashboard.subjectPlaceholder")} value={msgSubject} onChange={(e) => setMsgSubject(e.target.value)} className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5" data-testid="input-message-subject" />
              <textarea placeholder={t("dashboard.messagePlaceholder")} value={msgBody} onChange={(e) => setMsgBody(e.target.value)} rows={3} className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5 resize-none" data-testid="textarea-message-body" />
              <Button size="sm" className="w-full" onClick={() => { msgTo && msgBody && messageMutation.mutate({ toAgentId: msgTo, subject: msgSubject, body: msgBody }); setMsgSubject(""); setMsgBody(""); }} disabled={!msgTo || !msgBody || messageMutation.isPending} data-testid="button-send-message">
                {messageMutation.isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                <span className="ml-1">{t("dashboard.send")}</span>
              </Button>
            </Card>

            {messages.map((msg) => (
              <Card key={msg.id} className={`p-3 ${msg.status === "unread" ? "border-primary/40" : ""}`} data-testid={`card-message-${msg.id}`}>
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono font-semibold text-xs">{msg.fromAgentName}</span>
                      {msg.status === "unread" && <Badge variant="default" className="text-[10px]">{t("dashboard.newBadge")}</Badge>}
                    </div>
                    {msg.subject && <div className="font-mono text-xs font-semibold">{msg.subject}</div>}
                    <p className="text-xs text-muted-foreground mt-1">{msg.body}</p>
                  </div>
                  <div className="flex-shrink-0">
                    {msg.status === "unread" && (
                      <Button size="sm" variant="ghost" onClick={() => markReadMutation.mutate(msg.id)} data-testid={`button-mark-read-${msg.id}`}>
                        <Eye className="w-3 h-3" />
                      </Button>
                    )}
                  </div>
                </div>
                <div className="text-[10px] text-muted-foreground mt-2 font-mono">{msg.createdAt ? new Date(msg.createdAt).toLocaleString() : ""}</div>
              </Card>
            ))}
          </div>
        </Section>

        <Section title={t("dashboard.inference")} icon={Globe} count={inferenceProviders.length}>
          <div className="space-y-3">
            {inferenceStatus && (
              <Card className="p-3" data-testid="card-inference-summary">
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <div className="w-6 h-6 rounded-md bg-primary/8 border border-primary/15 flex items-center justify-center flex-shrink-0">
                    <Activity className="w-3 h-3 text-primary/70" />
                  </div>
                  <span className="font-mono text-xs font-semibold">{t("dashboard.networkStatus")}</span>
                  <Badge variant={inferenceStatus.summary.live > 0 ? "default" : "secondary"} className="text-[10px] ml-auto" data-testid="badge-network-mode">
                    {inferenceStatus.summary.live > 0 ? t("dashboard.live") : "Offline"}
                  </Badge>
                </div>
                <div className="grid grid-cols-3 gap-2 mt-2">
                  <div className="text-center">
                    <div className="font-mono text-lg font-bold text-primary" data-testid="text-providers-total">{inferenceStatus.summary.total}</div>
                    <div className="text-[10px] text-muted-foreground font-mono">{t("dashboard.providers")}</div>
                  </div>
                  <div className="text-center">
                    <div className="font-mono text-lg font-bold text-primary" data-testid="text-providers-live">{inferenceStatus.summary.live}</div>
                    <div className="text-[10px] text-muted-foreground font-mono">{t("dashboard.liveLower")}</div>
                  </div>
                  <div className="text-center">
                    <div className="font-mono text-lg font-bold" data-testid="text-providers-decentralized">{inferenceStatus.summary.decentralized}</div>
                    <div className="text-[10px] text-muted-foreground font-mono">{t("dashboard.decentralized")}</div>
                  </div>
                </div>
                {inferenceStatus.summary.live === 0 && (
                  <div className="mt-3 p-2 rounded-md bg-muted/50 border border-dashed">
                    <div className="text-[11px] font-mono text-muted-foreground">
                      {t("dashboard.noApiKeys")}
                    </div>
                  </div>
                )}
              </Card>
            )}

            <TerminalLine prefix="$">inference.providers()</TerminalLine>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {(inferenceStatus?.providers || inferenceProviders).map((provider) => {
                const enriched = provider as InferenceProvider & { live?: boolean; liveStatus?: string };
                const isLive = enriched.live || false;
                let meta: any = {};
                try { meta = JSON.parse(provider.metadata || "{}"); } catch {}
                return (
                  <Card key={provider.id} className="p-3" data-testid={`card-provider-${provider.id}`}>
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      <div className="w-6 h-6 rounded-md bg-primary/8 border border-primary/15 flex items-center justify-center flex-shrink-0">
                        <Globe className="w-3 h-3 text-primary/70" />
                      </div>
                      <span className="font-mono text-xs font-semibold truncate">{provider.name}</span>
                      <Badge
                        variant={isLive ? "default" : "outline"}
                        className="text-[10px] ml-auto"
                        data-testid={`badge-status-${provider.network}`}
                      >
                        {isLive ? t("dashboard.live") : "Offline"}
                      </Badge>
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[10px] text-muted-foreground font-mono">{t("dashboard.status")}</span>
                        <div className="flex items-center gap-1">
                          <div className={`w-1.5 h-1.5 rounded-full ${isLive ? "bg-green-500 animate-pulse" : "bg-muted-foreground/40"}`} />
                          <span className={`font-mono text-[10px] ${isLive ? "text-green-500" : "text-muted-foreground"}`}>
                            {isLive ? t("dashboard.connected") : "Offline"}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[10px] text-muted-foreground font-mono">{t("dashboard.network")}</span>
                        <span className="font-mono text-[10px]">{provider.network}</span>
                      </div>
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[10px] text-muted-foreground font-mono">{t("dashboard.costPerReq")}</span>
                        <span className="font-mono text-[10px] text-primary">{formatShortCredits(provider.costPerRequest)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[10px] text-muted-foreground font-mono">{t("dashboard.latency")}</span>
                        <span className="font-mono text-[10px]">{provider.latencyMs}ms</span>
                      </div>
                      {provider.verifiable && (
                        <div className="flex items-center gap-1 mt-1">
                          <ShieldCheck className="w-3 h-3 text-primary/70" />
                          <span className="text-[10px] text-primary/70 font-mono">{t("dashboard.proofVerified")}</span>
                        </div>
                      )}
                      {meta.costSavings && (
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-[10px] text-muted-foreground font-mono">{t("dashboard.savings")}</span>
                          <span className="font-mono text-[10px] text-primary">{meta.costSavings}</span>
                        </div>
                      )}
                    </div>
                    {provider.modelsSupported && provider.modelsSupported.length > 0 && (
                      <div className="mt-2 pt-2 border-t">
                        <div className="text-[10px] text-muted-foreground font-mono mb-1">{t("dashboard.models")}</div>
                        <div className="flex flex-wrap gap-1">
                          {provider.modelsSupported.slice(0, 3).map((m) => (
                            <Badge key={m} variant="outline" className="text-[9px] font-mono">{m.split("/").pop()}</Badge>
                          ))}
                          {provider.modelsSupported.length > 3 && (
                            <Badge variant="outline" className="text-[9px] font-mono">+{provider.modelsSupported.length - 3}</Badge>
                          )}
                        </div>
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>

            <Card className="p-3 space-y-2 mt-3">
              <div className="text-xs font-mono font-semibold flex items-center gap-1">
                <Cpu className="w-3 h-3 text-primary/70" /> {t("dashboard.runInference")}
              </div>
              <textarea
                placeholder={t("dashboard.promptPlaceholder")}
                value={inferencePrompt}
                onChange={(e) => setInferencePrompt(e.target.value)}
                rows={2}
                className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5 resize-none"
                data-testid="textarea-inference-prompt"
              />
              <div className="flex items-center gap-3 flex-wrap">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={inferencePreferDecentralized}
                    onChange={(e) => setInferencePreferDecentralized(e.target.checked)}
                    className="rounded"
                    data-testid="checkbox-prefer-decentralized"
                  />
                  <span className="text-[11px] font-mono text-muted-foreground">{t("dashboard.preferDecentralized")}</span>
                </label>
                <Button
                  size="sm"
                  onClick={() => {
                    if (inferencePrompt.trim()) {
                      inferenceMutation.mutate({ prompt: inferencePrompt, preferDecentralized: inferencePreferDecentralized });
                      setInferencePrompt("");
                    }
                  }}
                  disabled={!inferencePrompt.trim() || inferenceMutation.isPending}
                  data-testid="button-run-inference"
                >
                  {inferenceMutation.isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Cpu className="w-3 h-3" />}
                  <span className="ml-1">{t("dashboard.run")}</span>
                </Button>
              </div>
            </Card>

            {inferenceHistory.length > 0 && (
              <div className="mt-3">
                <div className="text-xs font-mono font-semibold mb-2 text-muted-foreground">{t("dashboard.inferenceHistory")}</div>
                <div className="space-y-2">
                  {inferenceHistory.slice(0, 10).map((req) => {
                    const provider = inferenceProviders.find(p => p.id === req.providerId);
                    const isLiveResult = req.response && !req.response.startsWith("[NO_PROVIDER") && !req.response.startsWith("[ERROR");
                    return (
                      <Card key={req.id} className="p-3" data-testid={`card-inference-${req.id}`}>
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <Badge variant="default" className="text-[10px] font-mono">
                            {provider?.name || "Unknown"}
                          </Badge>
                          <Badge variant="outline" className="text-[10px] font-mono">{req.model?.split("/").pop()}</Badge>
                          <Badge variant={isLiveResult ? "default" : "secondary"} className="text-[10px] font-mono">
                            {isLiveResult ? t("dashboard.live") : "Failed"}
                          </Badge>
                          <span className="text-[10px] text-muted-foreground font-mono ml-auto">{req.latencyMs}ms</span>
                        </div>
                        <div className="font-mono text-xs text-muted-foreground truncate mb-1">{req.prompt}</div>
                        {req.response && (
                          <div className="font-mono text-xs text-foreground/80 bg-background/50 rounded-md p-2 mt-1 max-h-32 overflow-y-auto">{req.response}</div>
                        )}
                        <div className="flex items-center gap-3 mt-2 flex-wrap">
                          <span className="text-[10px] text-primary font-mono">{t("dashboard.cost")}: {formatShortCredits(req.costAmount)}</span>
                          {req.proofHash && (
                            <div className="flex items-center gap-1">
                              <ShieldCheck className="w-3 h-3 text-primary/70" />
                              <span className="text-[10px] text-primary/70 font-mono truncate max-w-[120px]">{req.proofHash}</span>
                            </div>
                          )}
                          <span className="text-[10px] text-muted-foreground font-mono ml-auto">{req.createdAt ? new Date(req.createdAt).toLocaleTimeString() : ""}</span>
                        </div>
                      </Card>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </Section>

        <Section title="Twitter Agent" icon={Twitter}>
          <div className="space-y-3 px-1">
            {!twitterStatus?.connected ? (
              <div className="space-y-3">
                <TerminalLine prefix="$">twitter.connect()</TerminalLine>
                <p className="text-xs text-muted-foreground">Connect a Twitter/X account to let this agent autonomously post, engage, and grow your audience.</p>

                {!showTwitterConnect ? (
                  <Button size="sm" onClick={() => { setShowTwitterConnect(true); setConnectStep(1); setKeyValidation(null); setPermissionChecks({ createdApp: false, setReadWrite: false, generatedTokens: false }); }} data-testid="button-connect-twitter">
                    <Twitter className="w-3.5 h-3.5 mr-1.5" />
                    Connect Twitter Account
                  </Button>
                ) : (
                  <Card className="p-4 space-y-3">
                    <div className="flex items-center gap-2 mb-1">
                      {[1, 2, 3].map((s) => (
                        <div key={s} className="flex items-center gap-1.5">
                          <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold ${connectStep >= s ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>{s}</div>
                          <span className={`text-[10px] font-medium ${connectStep >= s ? "text-foreground" : "text-muted-foreground"}`}>
                            {s === 1 ? "API Keys" : s === 2 ? "Role & Profile" : "Review & Go"}
                          </span>
                          {s < 3 && <div className="w-6 h-px bg-border" />}
                        </div>
                      ))}
                    </div>

                    {connectStep === 1 && (
                      <div className="space-y-3">
                        <div className="border rounded-md p-3 space-y-2.5 bg-blue-500/5 border-blue-500/20">
                          <span className="text-[11px] font-semibold">Setup Checklist</span>
                          <p className="text-[10px] text-muted-foreground">Complete these steps on <a href="https://developer.x.com/en/portal/dashboard" target="_blank" rel="noopener" className="text-primary underline font-medium">developer.x.com</a> before pasting your keys:</p>
                          <div className="space-y-1.5">
                            <label className="flex items-center gap-2 cursor-pointer" data-testid="check-created-app">
                              <input type="checkbox" checked={permissionChecks.createdApp} onChange={(e) => setPermissionChecks(p => ({ ...p, createdApp: e.target.checked }))} className="rounded" />
                              <span className="text-[10px]">Created a Project & App (or using an existing one)</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer" data-testid="check-read-write">
                              <input type="checkbox" checked={permissionChecks.setReadWrite} onChange={(e) => setPermissionChecks(p => ({ ...p, setReadWrite: e.target.checked }))} className="rounded" />
                              <span className="text-[10px]">Set App permissions to <strong>"Read and Write"</strong> (Settings tab)</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer" data-testid="check-generated-tokens">
                              <input type="checkbox" checked={permissionChecks.generatedTokens} onChange={(e) => setPermissionChecks(p => ({ ...p, generatedTokens: e.target.checked }))} className="rounded" />
                              <span className="text-[10px]">Generated tokens <strong>AFTER</strong> setting Read+Write (Keys & Tokens tab)</span>
                            </label>
                          </div>
                          {permissionChecks.createdApp && permissionChecks.setReadWrite && !permissionChecks.generatedTokens && (
                            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded px-2.5 py-1.5">
                              <p className="text-[10px] text-yellow-700 dark:text-yellow-400 font-medium">Important: If you changed permissions AFTER generating tokens, you must regenerate them. Old tokens keep old permissions even after you update app settings.</p>
                            </div>
                          )}
                        </div>
                        <div className="space-y-2">
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <div className="space-y-1">
                              <label className="text-[10px] font-medium text-muted-foreground">API Key (Consumer Key)</label>
                              <input className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background font-mono" type="password" value={twitterForm.twitterApiKey} onChange={(e) => { setTwitterForm(f => ({ ...f, twitterApiKey: e.target.value })); setKeyValidation(null); }} data-testid="input-twitter-api-key" />
                            </div>
                            <div className="space-y-1">
                              <label className="text-[10px] font-medium text-muted-foreground">API Secret (Consumer Secret)</label>
                              <input className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background font-mono" type="password" value={twitterForm.twitterApiSecret} onChange={(e) => { setTwitterForm(f => ({ ...f, twitterApiSecret: e.target.value })); setKeyValidation(null); }} data-testid="input-twitter-api-secret" />
                            </div>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <div className="space-y-1">
                              <label className="text-[10px] font-medium text-muted-foreground">Access Token</label>
                              <input className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background font-mono" type="password" value={twitterForm.twitterAccessToken} onChange={(e) => { setTwitterForm(f => ({ ...f, twitterAccessToken: e.target.value })); setKeyValidation(null); }} data-testid="input-twitter-access-token" />
                            </div>
                            <div className="space-y-1">
                              <label className="text-[10px] font-medium text-muted-foreground">Access Token Secret</label>
                              <input className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background font-mono" type="password" value={twitterForm.twitterAccessTokenSecret} onChange={(e) => { setTwitterForm(f => ({ ...f, twitterAccessTokenSecret: e.target.value })); setKeyValidation(null); }} data-testid="input-twitter-access-secret" />
                            </div>
                          </div>
                        </div>

                        {keyValidation && (
                          <div className={`rounded-md p-2.5 border ${keyValidation.valid ? (keyValidation.canWrite ? "bg-emerald-500/10 border-emerald-500/30" : "bg-yellow-500/10 border-yellow-500/30") : "bg-red-500/10 border-red-500/30"}`}>
                            {keyValidation.valid ? (
                              <div className="space-y-1">
                                <div className="flex items-center gap-2">
                                  <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                                  <span className="text-xs font-medium">Verified: @{keyValidation.username}</span>
                                  {keyValidation.name && <span className="text-[10px] text-muted-foreground">({keyValidation.name})</span>}
                                </div>
                                {keyValidation.canWrite ? (
                                  <div className="flex items-center gap-2 ml-6">
                                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                                    <span className="text-[10px] text-emerald-600 dark:text-emerald-400">Write permissions confirmed — your agent can post tweets</span>
                                  </div>
                                ) : (
                                  <div className="ml-6 space-y-1">
                                    <div className="flex items-center gap-2">
                                      <XCircle className="w-3.5 h-3.5 text-yellow-500" />
                                      <span className="text-[10px] text-yellow-600 dark:text-yellow-400 font-medium">Read-only tokens detected</span>
                                    </div>
                                    <p className="text-[10px] text-yellow-600 dark:text-yellow-400">{keyValidation.writeWarning}</p>
                                  </div>
                                )}
                              </div>
                            ) : (
                              <div className="flex items-start gap-2">
                                <XCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                                <span className="text-xs text-red-600 dark:text-red-400">{keyValidation.error}</span>
                              </div>
                            )}
                          </div>
                        )}

                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => validateKeysMutation.mutate()}
                            disabled={validateKeysMutation.isPending || !twitterForm.twitterApiKey || !twitterForm.twitterApiSecret || !twitterForm.twitterAccessToken || !twitterForm.twitterAccessTokenSecret}
                            data-testid="button-validate-keys"
                          >
                            {validateKeysMutation.isPending ? "Checking..." : "Verify Keys"}
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => setConnectStep(2)}
                            disabled={!twitterForm.twitterApiKey || !twitterForm.twitterApiSecret || !twitterForm.twitterAccessToken || !twitterForm.twitterAccessTokenSecret}
                            data-testid="button-step1-next"
                          >
                            Next: Role & Profile
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setShowTwitterConnect(false)} data-testid="button-cancel-twitter">Cancel</Button>
                        </div>
                      </div>
                    )}

                    {connectStep === 2 && (
                      <div className="space-y-3">
                        <div className="space-y-2">
                          <label className="text-xs font-medium">Agent Role</label>
                          <select
                            className="w-full px-3 py-2 text-sm border rounded-md bg-background"
                            value={twitterForm.role}
                            onChange={(e) => setTwitterForm(f => ({ ...f, role: e.target.value }))}
                            data-testid="select-twitter-role"
                          >
                            <option value="cmo">CMO — Marketing & Growth</option>
                            <option value="ceo">CEO — Vision & Strategy</option>
                            <option value="cto">CTO — Tech & Engineering</option>
                            <option value="cfo">CFO — Finance & Treasury</option>
                            <option value="community_manager">Community Manager</option>
                            <option value="content_creator">Content Creator</option>
                            <option value="bounty_hunter">Bounty Hunter</option>
                            <option value="support">Support Agent</option>
                            <option value="researcher">Research Analyst</option>
                            <option value="sales">Sales Lead</option>
                            <option value="partnerships">Partnerships Lead</option>
                            <option value="developer_relations">DevRel — Developer Relations</option>
                            <option value="brand_ambassador">Brand Ambassador</option>
                            <option value="analyst">Market Analyst</option>
                            <option value="trader">Trading Agent</option>
                          </select>
                        </div>
                        {ROLE_SKILLS[twitterForm.role] && (
                          <div className="bg-muted/50 rounded-md p-2.5 space-y-1.5" data-testid="connect-role-skills-preview">
                            <div className="flex items-center justify-between">
                              <span className="font-mono text-[10px] font-medium text-foreground">{ROLE_SKILLS[twitterForm.role].title} Skills</span>
                              <span className="font-mono text-[9px] text-muted-foreground italic">{ROLE_SKILLS[twitterForm.role].tone}</span>
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {ROLE_SKILLS[twitterForm.role].skills.map((skill) => (
                                <Badge key={skill} variant="secondary" className="text-[9px] px-1.5 py-0">{skill}</Badge>
                              ))}
                            </div>
                          </div>
                        )}
                        <div className="border rounded-md p-3 space-y-2.5 bg-muted/30">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold">Company / Project Profile</span>
                            <span className="text-[9px] text-muted-foreground">(optional — can fill later in Settings)</span>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <div className="space-y-1">
                              <label className="text-[10px] font-medium text-muted-foreground">Company Name</label>
                              <input className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background font-mono" placeholder="e.g. Acme Protocol" value={twitterForm.companyName} onChange={(e) => setTwitterForm(f => ({ ...f, companyName: e.target.value }))} data-testid="input-twitter-company-name" />
                            </div>
                            <div className="space-y-1">
                              <label className="text-[10px] font-medium text-muted-foreground">Website</label>
                              <input className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background font-mono" placeholder="https://yourproject.com" value={twitterForm.companyWebsite} onChange={(e) => setTwitterForm(f => ({ ...f, companyWebsite: e.target.value }))} data-testid="input-twitter-company-website" />
                            </div>
                          </div>
                          <div className="space-y-1">
                            <label className="text-[10px] font-medium text-muted-foreground">What does your company/project do?</label>
                            <textarea className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background font-mono resize-none" rows={2} placeholder="Describe your company, mission, and what makes it unique..." value={twitterForm.companyDescription} onChange={(e) => setTwitterForm(f => ({ ...f, companyDescription: e.target.value }))} data-testid="input-twitter-company-description" />
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <div className="space-y-1">
                              <label className="text-[10px] font-medium text-muted-foreground">Product / Service</label>
                              <input className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background font-mono" placeholder="DeFi yield aggregator, NFT marketplace..." value={twitterForm.companyProduct} onChange={(e) => setTwitterForm(f => ({ ...f, companyProduct: e.target.value }))} data-testid="input-twitter-company-product" />
                            </div>
                            <div className="space-y-1">
                              <label className="text-[10px] font-medium text-muted-foreground">Target Audience</label>
                              <input className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background font-mono" placeholder="DeFi traders, NFT collectors, developers..." value={twitterForm.companyAudience} onChange={(e) => setTwitterForm(f => ({ ...f, companyAudience: e.target.value }))} data-testid="input-twitter-company-audience" />
                            </div>
                          </div>
                          <div className="space-y-1">
                            <label className="text-[10px] font-medium text-muted-foreground">Key Messages & Talking Points</label>
                            <textarea className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background font-mono resize-none" rows={2} placeholder="Main selling points, slogans, value propositions..." value={twitterForm.companyKeyMessages} onChange={(e) => setTwitterForm(f => ({ ...f, companyKeyMessages: e.target.value }))} data-testid="input-twitter-company-messages" />
                          </div>
                        </div>
                        <div className="space-y-2">
                          <label className="text-xs font-medium">Personality <span className="text-muted-foreground font-normal">(optional)</span></label>
                          <textarea className="w-full px-3 py-2 text-sm border rounded-md bg-background font-mono resize-none" rows={2} placeholder="Describe how the agent should communicate (tone, style, values...)" value={twitterForm.personality} onChange={(e) => setTwitterForm(f => ({ ...f, personality: e.target.value }))} data-testid="input-twitter-personality" />
                        </div>
                        <div className="space-y-2">
                          <label className="text-xs font-medium">Instructions <span className="text-muted-foreground font-normal">(optional)</span></label>
                          <textarea className="w-full px-3 py-2 text-sm border rounded-md bg-background font-mono resize-none" rows={2} placeholder="Topics, goals, content strategy..." value={twitterForm.instructions} onChange={(e) => setTwitterForm(f => ({ ...f, instructions: e.target.value }))} data-testid="input-twitter-instructions" />
                        </div>
                        <div className="space-y-2">
                          <label className="text-xs font-medium">Posting Frequency</label>
                          <div className="flex items-center gap-2">
                            <input className="w-24 px-3 py-2 text-sm border rounded-md bg-background font-mono" type="number" min={15} max={1440} value={twitterForm.postingFrequencyMins} onChange={(e) => setTwitterForm(f => ({ ...f, postingFrequencyMins: parseInt(e.target.value) || 60 }))} data-testid="input-twitter-frequency" />
                            <span className="text-[10px] text-muted-foreground">minutes between posts (90-120 recommended for free tier)</span>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" onClick={() => setConnectStep(1)} data-testid="button-step2-back">Back</Button>
                          <Button size="sm" onClick={() => setConnectStep(3)} data-testid="button-step2-next">Next: Review</Button>
                        </div>
                      </div>
                    )}

                    {connectStep === 3 && (
                      <div className="space-y-3">
                        <div className="border rounded-md p-3 space-y-2 bg-muted/30">
                          <span className="text-[11px] font-semibold">Ready to connect</span>
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
                            <span className="text-muted-foreground">Account</span>
                            <span className="font-mono">@{twitterForm.twitterHandle || "detecting..."}</span>
                            <span className="text-muted-foreground">Role</span>
                            <span className="font-mono capitalize">{twitterForm.role.replace(/_/g, " ")}</span>
                            <span className="text-muted-foreground">Posting every</span>
                            <span className="font-mono">{twitterForm.postingFrequencyMins} min</span>
                            {twitterForm.companyName && <>
                              <span className="text-muted-foreground">Company</span>
                              <span className="font-mono">{twitterForm.companyName}</span>
                            </>}
                          </div>
                          {keyValidation?.valid && keyValidation.canWrite && (
                            <div className="flex items-center gap-1.5 mt-1">
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                              <span className="text-[10px] text-emerald-600 dark:text-emerald-400">Keys verified, write access confirmed</span>
                            </div>
                          )}
                          {keyValidation?.valid && !keyValidation.canWrite && (
                            <div className="flex items-center gap-1.5 mt-1">
                              <AlertTriangle className="w-3.5 h-3.5 text-yellow-500" />
                              <span className="text-[10px] text-yellow-600 dark:text-yellow-400">Keys verified but read-only — agent may not be able to post. You can fix this later in Settings.</span>
                            </div>
                          )}
                          <p className="text-[10px] text-muted-foreground mt-1">Your agent will be connected and auto-started. It will begin posting within a few minutes.</p>
                        </div>
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" onClick={() => setConnectStep(2)} data-testid="button-step3-back">Back</Button>
                          <Button
                            size="sm"
                            onClick={() => twitterConnectMutation.mutate()}
                            disabled={twitterConnectMutation.isPending}
                            data-testid="button-submit-twitter-connect"
                          >
                            {twitterConnectMutation.isPending ? "Connecting & Starting..." : "Connect & Start Agent"}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setShowTwitterConnect(false)} data-testid="button-cancel-twitter">Cancel</Button>
                        </div>
                      </div>
                    )}
                  </Card>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <TerminalLine prefix="$">twitter.status()</TerminalLine>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <Card className="p-3">
                    <div className="text-[10px] text-muted-foreground uppercase">Account</div>
                    <div className="font-mono text-sm font-bold" data-testid="text-twitter-handle">@{(twitterStatus.handle || "").replace(/^@/, "")}</div>
                  </Card>
                  <Card className="p-3">
                    <div className="text-[10px] text-muted-foreground uppercase">Status</div>
                    <Badge variant={twitterStatus.running ? "default" : "outline"} className="mt-1" data-testid="text-twitter-status">
                      {twitterStatus.running ? "RUNNING" : "STOPPED"}
                    </Badge>
                  </Card>
                  <Card className="p-3">
                    <div className="text-[10px] text-muted-foreground uppercase">Tweets</div>
                    <div className="font-mono text-sm font-bold" data-testid="text-twitter-tweets">{twitterStatus.totalTweets || 0}</div>
                  </Card>
                  <Card className="p-3">
                    <div className="text-[10px] text-muted-foreground uppercase">Replies</div>
                    <div className="font-mono text-sm font-bold" data-testid="text-twitter-replies">{twitterStatus.totalReplies || 0}</div>
                  </Card>
                </div>

                <div className="flex flex-wrap gap-2">
                  {twitterStatus.running ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => twitterStopMutation.mutate()}
                      disabled={twitterStopMutation.isPending}
                      data-testid="button-stop-twitter"
                    >
                      <Power className="w-3.5 h-3.5 mr-1.5" />
                      {twitterStopMutation.isPending ? "Stopping..." : "Stop Agent"}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => twitterStartMutation.mutate()}
                      disabled={twitterStartMutation.isPending}
                      data-testid="button-start-twitter"
                    >
                      <Power className="w-3.5 h-3.5 mr-1.5" />
                      {twitterStartMutation.isPending ? "Starting..." : "Start Agent"}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setShowTwitterSettings(!showTwitterSettings)}
                    data-testid="button-twitter-settings"
                  >
                    <Settings className="w-3.5 h-3.5 mr-1.5" />
                    Settings
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => { setShowStrategyDashboard(!showStrategyDashboard); if (!showStrategyDashboard) { setShowTwitterSettings(false); setShowTwitterHelp(false); } }}
                    data-testid="button-twitter-strategy"
                  >
                    <Brain className="w-3.5 h-3.5 mr-1.5" />
                    Strategy
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setShowTwitterHelp(!showTwitterHelp)}
                    data-testid="button-twitter-help"
                  >
                    <HelpCircle className="w-3.5 h-3.5 mr-1.5" />
                    Help
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => {
                      if (confirm("Disconnect Twitter from this agent? This will stop all autonomous activity.")) {
                        twitterDisconnectMutation.mutate();
                      }
                    }}
                    disabled={twitterDisconnectMutation.isPending}
                    data-testid="button-disconnect-twitter"
                  >
                    {twitterDisconnectMutation.isPending ? "Disconnecting..." : "Disconnect"}
                  </Button>
                </div>

                {twitterStatus.diagnostics && twitterStatus.diagnostics.status !== "healthy" && twitterStatus.diagnostics.issues.length > 0 && (
                  <div className="space-y-2 p-3 rounded-lg border border-destructive/30 bg-destructive/5" data-testid="twitter-error-banner">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-destructive shrink-0" />
                      <span className="font-mono text-xs font-bold text-destructive">Action Required</span>
                    </div>
                    {twitterStatus.diagnostics.issues.map((issue: string, i: number) => (
                      <div key={i} className="flex items-start gap-2 pl-6">
                        <span className="font-mono text-[11px] text-destructive/90">{issue}</span>
                      </div>
                    ))}
                  </div>
                )}

                {showTwitterSettings && (
                  <Card className="p-4 space-y-3 max-h-[70vh] overflow-y-auto">
                    <div className="text-xs font-semibold">Agent Settings</div>
                    <div className="border rounded-md p-2.5 space-y-2 bg-muted/30">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-semibold">Company / Project Profile</span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <label className="text-[10px] text-muted-foreground">Company Name</label>
                          <input className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background font-mono" defaultValue={twitterStatus.companyName || ""} id="twitter-settings-company-name" data-testid="input-settings-company-name" />
                        </div>
                        <div className="space-y-1">
                          <label className="text-[10px] text-muted-foreground">Website</label>
                          <input className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background font-mono" defaultValue={twitterStatus.companyWebsite || ""} id="twitter-settings-company-website" data-testid="input-settings-company-website" />
                        </div>
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] text-muted-foreground">What does your company do?</label>
                        <textarea className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background font-mono resize-none" rows={2} defaultValue={twitterStatus.companyDescription || ""} id="twitter-settings-company-description" data-testid="input-settings-company-description" />
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <label className="text-[10px] text-muted-foreground">Product / Service</label>
                          <input className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background font-mono" defaultValue={twitterStatus.companyProduct || ""} id="twitter-settings-company-product" data-testid="input-settings-company-product" />
                        </div>
                        <div className="space-y-1">
                          <label className="text-[10px] text-muted-foreground">Target Audience</label>
                          <input className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background font-mono" defaultValue={twitterStatus.companyAudience || ""} id="twitter-settings-company-audience" data-testid="input-settings-company-audience" />
                        </div>
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] text-muted-foreground">Key Messages & Talking Points</label>
                        <textarea className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background font-mono resize-none" rows={2} defaultValue={twitterStatus.companyKeyMessages || ""} id="twitter-settings-company-messages" data-testid="input-settings-company-messages" />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-medium">Personality</label>
                      <textarea
                        className="w-full px-3 py-2 text-sm border rounded-md bg-background font-mono resize-none"
                        rows={2}
                        defaultValue={twitterStatus.personality || ""}
                        id="twitter-settings-personality"
                        data-testid="input-twitter-settings-personality"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-medium">Instructions</label>
                      <textarea
                        className="w-full px-3 py-2 text-sm border rounded-md bg-background font-mono resize-none"
                        rows={3}
                        defaultValue={twitterStatus.instructions || ""}
                        id="twitter-settings-instructions"
                        data-testid="input-twitter-settings-instructions"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-medium">Posting Frequency (minutes)</label>
                      <input
                        className="w-full px-3 py-2 text-sm border rounded-md bg-background font-mono"
                        type="number"
                        min={15}
                        max={1440}
                        defaultValue={twitterStatus.postingFrequencyMins || 60}
                        id="twitter-settings-frequency"
                        data-testid="input-twitter-settings-frequency"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-medium">Telegram Chat ID <span className="text-muted-foreground font-normal">(for strategy notifications)</span></label>
                      <input
                        className="w-full px-3 py-2 text-sm border rounded-md bg-background font-mono"
                        placeholder="e.g. 123456789"
                        defaultValue={twitterStatus.ownerTelegramChatId || ""}
                        id="twitter-settings-telegram-chat-id"
                        data-testid="input-settings-telegram-chat-id"
                      />
                      <p className="text-[10px] text-muted-foreground">Message @BUILD4_BOT on Telegram with /start to get your chat ID. Strategy memos will be sent here.</p>
                    </div>
                    <div className="border rounded-md p-2.5 space-y-2 bg-muted/30">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-semibold">Update API Keys</span>
                        <span className="text-[9px] text-muted-foreground">(leave blank to keep current)</span>
                      </div>
                      <p className="text-[10px] text-muted-foreground">If you changed permissions on developer.x.com, you MUST regenerate your tokens and paste the new ones here.</p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <label className="text-[10px] text-muted-foreground">API Key</label>
                          <input className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background font-mono" type="password" placeholder="Keep current" id="twitter-settings-api-key" data-testid="input-settings-api-key" />
                        </div>
                        <div className="space-y-1">
                          <label className="text-[10px] text-muted-foreground">API Secret</label>
                          <input className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background font-mono" type="password" placeholder="Keep current" id="twitter-settings-api-secret" data-testid="input-settings-api-secret" />
                        </div>
                        <div className="space-y-1">
                          <label className="text-[10px] text-muted-foreground">Access Token</label>
                          <input className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background font-mono" type="password" placeholder="Keep current" id="twitter-settings-access-token" data-testid="input-settings-access-token" />
                        </div>
                        <div className="space-y-1">
                          <label className="text-[10px] text-muted-foreground">Access Token Secret</label>
                          <input className="w-full px-2.5 py-1.5 text-sm border rounded-md bg-background font-mono" type="password" placeholder="Keep current" id="twitter-settings-access-secret" data-testid="input-settings-access-secret" />
                        </div>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => {
                        const personality = (document.getElementById("twitter-settings-personality") as HTMLTextAreaElement)?.value;
                        const instructions = (document.getElementById("twitter-settings-instructions") as HTMLTextAreaElement)?.value;
                        const freq = parseInt((document.getElementById("twitter-settings-frequency") as HTMLInputElement)?.value) || 60;
                        const companyName = (document.getElementById("twitter-settings-company-name") as HTMLInputElement)?.value;
                        const companyDescription = (document.getElementById("twitter-settings-company-description") as HTMLTextAreaElement)?.value;
                        const companyProduct = (document.getElementById("twitter-settings-company-product") as HTMLInputElement)?.value;
                        const companyAudience = (document.getElementById("twitter-settings-company-audience") as HTMLInputElement)?.value;
                        const companyWebsite = (document.getElementById("twitter-settings-company-website") as HTMLInputElement)?.value;
                        const companyKeyMessages = (document.getElementById("twitter-settings-company-messages") as HTMLTextAreaElement)?.value;
                        const apiKey = (document.getElementById("twitter-settings-api-key") as HTMLInputElement)?.value;
                        const apiSecret = (document.getElementById("twitter-settings-api-secret") as HTMLInputElement)?.value;
                        const accessToken = (document.getElementById("twitter-settings-access-token") as HTMLInputElement)?.value;
                        const accessSecret = (document.getElementById("twitter-settings-access-secret") as HTMLInputElement)?.value;
                        const ownerTelegramChatId = (document.getElementById("twitter-settings-telegram-chat-id") as HTMLInputElement)?.value;
                        const settings: any = { personality, instructions, postingFrequencyMins: freq, companyName, companyDescription, companyProduct, companyAudience, companyWebsite, companyKeyMessages, ownerTelegramChatId: ownerTelegramChatId || null };
                        if (apiKey) settings.twitterApiKey = apiKey;
                        if (apiSecret) settings.twitterApiSecret = apiSecret;
                        if (accessToken) settings.twitterAccessToken = accessToken;
                        if (accessSecret) settings.twitterAccessTokenSecret = accessSecret;
                        twitterSettingsMutation.mutate(settings);
                      }}
                      disabled={twitterSettingsMutation.isPending}
                      data-testid="button-save-twitter-settings"
                    >
                      {twitterSettingsMutation.isPending ? "Saving..." : "Save Settings"}
                    </Button>
                  </Card>
                )}

                {showTwitterHelp && (
                  <Card className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
                    <div className="flex items-center gap-2">
                      <HelpCircle className="w-4 h-4 text-primary" />
                      <span className="text-xs font-semibold">Diagnostics & Help</span>
                    </div>

                    {twitterStatus.diagnostics && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          {twitterStatus.diagnostics.status === "healthy" && <CheckCircle2 className="w-4 h-4 text-emerald-500" />}
                          {twitterStatus.diagnostics.status === "warning" && <AlertTriangle className="w-4 h-4 text-yellow-500" />}
                          {twitterStatus.diagnostics.status === "error" && <XCircle className="w-4 h-4 text-red-500" />}
                          <span className="font-mono text-xs font-bold">
                            {twitterStatus.diagnostics.status === "healthy" ? "All Systems Healthy" :
                             twitterStatus.diagnostics.status === "warning" ? "Needs Attention" : "Issues Found"}
                          </span>
                        </div>

                        {twitterStatus.diagnostics.issues.length > 0 && (
                          <div className="space-y-1.5">
                            {twitterStatus.diagnostics.issues.map((issue: string, i: number) => (
                              <div key={i} className="flex items-start gap-2 p-2 rounded-md bg-destructive/10 border border-destructive/20">
                                <XCircle className="w-3.5 h-3.5 text-destructive mt-0.5 shrink-0" />
                                <span className="font-mono text-[11px] text-destructive">{issue}</span>
                              </div>
                            ))}
                          </div>
                        )}

                        {twitterStatus.diagnostics.tips.length > 0 && (
                          <div className="space-y-1.5">
                            {twitterStatus.diagnostics.tips.map((tip: string, i: number) => (
                              <div key={i} className="flex items-start gap-2 p-2 rounded-md bg-blue-500/10 border border-blue-500/20">
                                <AlertTriangle className="w-3.5 h-3.5 text-blue-500 mt-0.5 shrink-0" />
                                <span className="font-mono text-[11px] text-blue-400">{tip}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    <div className="border-t pt-3 space-y-3">
                      <div className="text-xs font-semibold">Common Issues & Fixes</div>

                      <div className="space-y-2.5">
                        <div className="space-y-1">
                          <div className="font-mono text-[11px] font-bold">Agent won't start</div>
                          <ul className="text-[10px] text-muted-foreground space-y-0.5 pl-3 list-disc">
                            <li>Check that all 4 Twitter API credentials are entered correctly</li>
                            <li>Make sure your Twitter app has Read and Write permissions</li>
                            <li>Regenerate your Access Token if it was created before enabling Write access</li>
                          </ul>
                        </div>

                        <div className="space-y-1">
                          <div className="font-mono text-[11px] font-bold">Agent started but no tweets</div>
                          <ul className="text-[10px] text-muted-foreground space-y-0.5 pl-3 list-disc">
                            <li>The first tweet posts after the posting frequency interval (default: 60 minutes)</li>
                            <li>Check if inference providers are available — the agent needs AI to generate content</li>
                            <li>Try stopping and restarting the agent</li>
                          </ul>
                        </div>

                        <div className="space-y-1">
                          <div className="font-mono text-[11px] font-bold">Rate limited by Twitter</div>
                          <ul className="text-[10px] text-muted-foreground space-y-0.5 pl-3 list-disc">
                            <li>Free Twitter API tier allows ~17 tweets per 24 hours</li>
                            <li>Increase your posting frequency (e.g. 120 minutes instead of 60)</li>
                            <li>Upgrade your Twitter API plan for higher limits</li>
                          </ul>
                        </div>

                        <div className="space-y-1">
                          <div className="font-mono text-[11px] font-bold">Tweets are too generic</div>
                          <ul className="text-[10px] text-muted-foreground space-y-0.5 pl-3 list-disc">
                            <li>Fill in your Company Profile in Settings — name, product, audience, and key messages</li>
                            <li>Add specific Instructions telling the agent what topics to focus on</li>
                            <li>Set a Personality to give the agent a unique voice</li>
                          </ul>
                        </div>

                        <div className="space-y-1">
                          <div className="font-mono text-[11px] font-bold">Agent not replying to mentions</div>
                          <ul className="text-[10px] text-muted-foreground space-y-0.5 pl-3 list-disc">
                            <li>Auto-reply is enabled by default. Make sure the agent is running</li>
                            <li>The agent checks mentions every cycle — wait for the next interval</li>
                            <li>Twitter API must have Read access to see mentions</li>
                          </ul>
                        </div>
                      </div>
                    </div>

                    <div className="border-t pt-3 space-y-2">
                      <div className="text-xs font-semibold">Getting Twitter API Keys</div>
                      <ol className="text-[10px] text-muted-foreground space-y-1 pl-3 list-decimal">
                        <li>Go to <a href="https://developer.twitter.com" target="_blank" rel="noopener" className="text-primary underline">developer.twitter.com</a> and sign in</li>
                        <li>Create a new Project and App (Free tier works)</li>
                        <li>In App Settings, set User Authentication to Read and Write</li>
                        <li>Go to Keys and Tokens tab</li>
                        <li>Copy: API Key, API Secret, Access Token, Access Token Secret</li>
                        <li>If you changed permissions, regenerate Access Token and Secret</li>
                      </ol>
                    </div>
                  </Card>
                )}

                {showStrategyDashboard && (
                  <Card className="p-4 space-y-4 max-h-[80vh] overflow-y-auto" data-testid="strategy-dashboard">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Brain className="w-4 h-4 text-primary" />
                        <span className="text-xs font-semibold">Strategy Brain</span>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => generateStrategyMutation.mutate()}
                        disabled={generateStrategyMutation.isPending || !twitterStatus.running}
                        data-testid="button-generate-strategy"
                      >
                        {generateStrategyMutation.isPending ? (
                          <><RefreshCw className="w-3 h-3 mr-1.5 animate-spin" /> Generating...</>
                        ) : (
                          <><Sparkles className="w-3 h-3 mr-1.5" /> Generate Strategy Now</>
                        )}
                      </Button>
                    </div>

                    {!twitterStatus.running && (
                      <div className="text-[11px] text-muted-foreground bg-muted/30 rounded-md p-2 border">
                        Start your agent to generate strategies. The Strategy Brain runs automatically every 12 hours while the agent is active.
                      </div>
                    )}

                    {performanceQuery.data && performanceQuery.data.total > 0 && (
                      <div className="border rounded-lg p-3 space-y-2" data-testid="performance-metrics">
                        <div className="flex items-center gap-2 mb-2">
                          <BarChart3 className="w-3.5 h-3.5 text-orange-500" />
                          <span className="text-[11px] font-semibold">Performance Metrics</span>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          <div className="bg-muted/30 rounded-md p-2 text-center">
                            <div className="text-lg font-bold text-primary" data-testid="text-avg-alignment">{performanceQuery.data.avgAlignment}%</div>
                            <div className="text-[9px] text-muted-foreground">Avg Alignment</div>
                          </div>
                          <div className="bg-muted/30 rounded-md p-2 text-center">
                            <div className="text-lg font-bold" data-testid="text-tweets-scored">{performanceQuery.data.total}</div>
                            <div className="text-[9px] text-muted-foreground">Tweets Scored</div>
                          </div>
                          <div className="bg-muted/30 rounded-md p-2 text-center">
                            <div className="text-lg font-bold text-emerald-500" data-testid="text-top-themes-count">
                              {Object.keys(performanceQuery.data.topThemes || {}).length}
                            </div>
                            <div className="text-[9px] text-muted-foreground">Themes Hit</div>
                          </div>
                        </div>
                        {Object.keys(performanceQuery.data.topThemes || {}).length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {Object.entries(performanceQuery.data.topThemes).slice(0, 6).map(([theme, count]: [string, any]) => (
                              <Badge key={theme} variant="outline" className="text-[9px]" data-testid={`badge-theme-${theme.substring(0, 20)}`}>
                                {theme.length > 25 ? theme.substring(0, 25) + "..." : theme} ({count})
                              </Badge>
                            ))}
                          </div>
                        )}
                        {performanceQuery.data.tweets?.length > 0 && (
                          <div className="mt-2 space-y-1 max-h-[120px] overflow-y-auto">
                            {performanceQuery.data.tweets.slice(0, 8).map((t: any) => (
                              <div key={t.id} className="flex items-center gap-2 text-[10px]" data-testid={`row-tweet-perf-${t.id}`}>
                                <div className={`w-8 text-right font-bold ${(t.themeAlignment || 0) >= 70 ? "text-emerald-500" : (t.themeAlignment || 0) >= 40 ? "text-yellow-500" : "text-red-400"}`}>
                                  {t.themeAlignment || 0}%
                                </div>
                                <span className="text-muted-foreground truncate flex-1">{t.tweetText?.substring(0, 80)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {actionItemsQuery.data && actionItemsQuery.data.length > 0 && (
                      <div className="border rounded-lg p-3 space-y-2" data-testid="action-items-section">
                        <div className="flex items-center gap-2 mb-1">
                          <CheckCircle2 className="w-3.5 h-3.5 text-primary" />
                          <span className="text-[11px] font-semibold">Action Items</span>
                          <Badge variant="outline" className="text-[9px] ml-auto">
                            {actionItemsQuery.data.filter((i: any) => i.status === "done").length}/{actionItemsQuery.data.length} done
                          </Badge>
                        </div>
                        <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
                          {actionItemsQuery.data.filter((i: any) => i.status === "pending").map((item: any) => (
                            <div key={item.id} className="flex items-start gap-2 p-1.5 rounded hover:bg-muted/20" data-testid={`row-action-item-${item.id}`}>
                              <button
                                className="mt-0.5 shrink-0 w-4 h-4 rounded border border-muted-foreground/40 hover:border-primary flex items-center justify-center"
                                onClick={() => actionItemMutation.mutate({ itemId: item.id, status: "done" })}
                                data-testid={`button-complete-action-${item.id}`}
                              />
                              <div className="flex-1 min-w-0">
                                <p className="text-[11px] leading-tight">{item.action}</p>
                                <Badge variant="outline" className={`text-[8px] mt-0.5 ${item.priority === "high" ? "border-red-400 text-red-400" : item.priority === "low" ? "border-muted-foreground" : "border-yellow-500 text-yellow-500"}`}>
                                  {item.priority}
                                </Badge>
                              </div>
                              <button
                                className="text-[9px] text-muted-foreground hover:text-foreground shrink-0"
                                onClick={() => actionItemMutation.mutate({ itemId: item.id, status: "skipped" })}
                                data-testid={`button-skip-action-${item.id}`}
                              >
                                skip
                              </button>
                            </div>
                          ))}
                          {actionItemsQuery.data.filter((i: any) => i.status === "done").slice(0, 3).map((item: any) => (
                            <div key={item.id} className="flex items-start gap-2 p-1.5 opacity-50" data-testid={`row-action-done-${item.id}`}>
                              <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                              <p className="text-[11px] line-through">{item.action}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {activeStrategyQuery.data && (
                      <div className="border rounded-lg p-3 space-y-2 bg-primary/5 border-primary/20">
                        <div className="flex items-center gap-2">
                          <Badge className="bg-primary/15 text-primary text-[10px] border-0">ACTIVE</Badge>
                          <span className="font-mono text-xs font-bold">{activeStrategyQuery.data.title}</span>
                        </div>
                        {activeStrategyQuery.data.summary && (
                          <p className="text-[11px] text-muted-foreground leading-relaxed">{activeStrategyQuery.data.summary}</p>
                        )}
                        <div className="prose prose-sm dark:prose-invert max-w-none">
                          <pre className="text-[11px] whitespace-pre-wrap font-mono bg-muted/30 rounded-md p-3 border max-h-[300px] overflow-y-auto" data-testid="text-active-strategy-content">
                            {activeStrategyQuery.data.content}
                          </pre>
                        </div>
                        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                          <span>Type: <Badge variant="outline" className="text-[9px] ml-1">{activeStrategyQuery.data.memoType?.replace(/_/g, " ")}</Badge></span>
                          <span>Created: {new Date(activeStrategyQuery.data.createdAt).toLocaleString()}</span>
                        </div>
                      </div>
                    )}

                    {!activeStrategyQuery.data && !activeStrategyQuery.isLoading && twitterStatus.running && (
                      <div className="text-center py-6 text-muted-foreground">
                        <Brain className="w-8 h-8 mx-auto mb-2 opacity-30" />
                        <p className="text-xs">No strategy generated yet. Click "Generate Strategy Now" to create your first one.</p>
                      </div>
                    )}

                    {strategyQuery.data && strategyQuery.data.length > 0 && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 border-t pt-3">
                          <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                          <span className="text-[11px] font-semibold text-muted-foreground uppercase">All Memos ({strategyQuery.data.length})</span>
                        </div>
                        {strategyQuery.data.map((memo: any) => (
                          <div
                            key={memo.id}
                            className="border rounded-md p-2.5 space-y-1.5 hover:bg-muted/20 transition-colors cursor-pointer"
                            onClick={() => setExpandedMemoId(expandedMemoId === memo.id ? null : memo.id)}
                            data-testid={`card-strategy-memo-${memo.id}`}
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2 flex-1 min-w-0">
                                {memo.memoType === "strategy" && <Brain className="w-3 h-3 text-blue-500 shrink-0" />}
                                {memo.memoType === "content_calendar" && <Calendar className="w-3 h-3 text-green-500 shrink-0" />}
                                {memo.memoType === "performance_report" && <BarChart3 className="w-3 h-3 text-orange-500 shrink-0" />}
                                {memo.memoType === "gtm_plan" && <TrendingUp className="w-3 h-3 text-purple-500 shrink-0" />}
                                {memo.memoType === "pivot_recommendation" && <RefreshCw className="w-3 h-3 text-red-500 shrink-0" />}
                                <span className="font-mono text-[11px] font-medium truncate">{memo.title}</span>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <Badge variant="outline" className={`text-[9px] ${memo.status === "active" ? "border-primary text-primary" : memo.status === "superseded" ? "border-muted-foreground" : ""}`}>
                                  {memo.status}
                                </Badge>
                                <ChevronDown className={`w-3 h-3 text-muted-foreground transition-transform ${expandedMemoId === memo.id ? "rotate-180" : ""}`} />
                              </div>
                            </div>
                            <div className="text-[10px] text-muted-foreground">
                              {new Date(memo.createdAt).toLocaleString()} · {memo.memoType?.replace(/_/g, " ")}
                            </div>
                            {expandedMemoId === memo.id && (
                              <pre className="text-[11px] whitespace-pre-wrap font-mono bg-muted/30 rounded-md p-3 border max-h-[250px] overflow-y-auto mt-2" data-testid={`text-memo-content-${memo.id}`}>
                                {memo.content}
                              </pre>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {strategyQuery.isLoading && (
                      <div className="flex items-center justify-center py-4">
                        <RefreshCw className="w-4 h-4 animate-spin text-muted-foreground" />
                      </div>
                    )}
                  </Card>
                )}

                {twitterStatus.role && (
                  <div className="text-xs text-muted-foreground">
                    Role: <Badge variant="outline" className="text-[10px] ml-1">{
                      { cmo: "CMO", ceo: "CEO", cto: "CTO", cfo: "CFO", bounty_hunter: "Bounty Hunter", support: "Support", community_manager: "Community Mgr", content_creator: "Content Creator", researcher: "Researcher", sales: "Sales", partnerships: "Partnerships", developer_relations: "DevRel", brand_ambassador: "Ambassador", analyst: "Analyst", trader: "Trader" }[twitterStatus.role || ""] || twitterStatus.role
                    }</Badge>
                    {twitterStatus.lastPostedAt && <span className="ml-2">Last posted: {new Date(twitterStatus.lastPostedAt).toLocaleString()}</span>}
                  </div>
                )}
              </div>
            )}
          </div>
        </Section>

        <Section title={t("dashboard.auditLog")} icon={Layers} count={auditLogs.length}>
          <div className="space-y-1">
            <TerminalLine prefix="$">audit.tail()</TerminalLine>
            {auditLogs.slice(0, 20).map((log) => (
              <div key={log.id} className="font-mono text-xs flex items-center gap-2 py-0.5" data-testid={`row-audit-${log.id}`}>
                <span className="text-primary w-3 flex-shrink-0">&gt;</span>
                <Badge variant="outline" className="text-[10px] flex-shrink-0">{log.actionType}</Badge>
                <span className="text-muted-foreground truncate">{log.detailsJson ? JSON.parse(log.detailsJson).amount ? `${formatShortCredits(JSON.parse(log.detailsJson).amount)} ${activeChain.currency}` : JSON.stringify(JSON.parse(log.detailsJson)) : ""}</span>
                <span className="text-[10px] text-muted-foreground ml-auto flex-shrink-0">{log.createdAt ? new Date(log.createdAt).toLocaleTimeString() : ""}</span>
              </div>
            ))}
          </div>
        </Section>

        <div className="py-8 text-center">
          <TerminalLine prefix="//" dim>{t("dashboard.footerVersion")}</TerminalLine>
        </div>
      </main>
    </div>
  );
}
