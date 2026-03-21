import { useState, useRef, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link } from "wouter";
import { SEO } from "@/components/seo";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  ArrowLeft, Terminal, Bot, Brain, Zap, Shield,
  Plus, Layers, Settings, Wallet, Code, Rocket,
  TrendingUp, MessageSquare, Search, BarChart3,
  Eye, Globe, Lock, CheckCircle2, ArrowRight,
  Send, Cpu, Gift, Star, Users, Activity, Package,
  Loader2, Play, Square, ChevronRight, Sparkles,
  AlertCircle, Copy, RefreshCw,
} from "lucide-react";

interface BuildMessage {
  role: "user" | "system" | "build";
  content: string;
  timestamp: Date;
  type?: "info" | "success" | "error" | "progress" | "code";
}

interface AgentConfig {
  name: string;
  bio: string;
  type: string;
  chain: string;
  model: string;
  skills: string[];
  autonomy: string;
  status: "idle" | "configuring" | "building" | "deploying" | "live" | "error";
}

const TEMPLATES: Record<string, { name: string; bio: string; skills: string[]; icon: string }> = {
  trading: {
    name: "Trading Agent",
    bio: "Autonomous trading agent that monitors markets, identifies opportunities, and executes trades across DEXs",
    skills: ["Market Scanner", "Signal Detector", "Trade Executor", "Risk Manager"],
    icon: "📈",
  },
  research: {
    name: "Research Agent",
    bio: "Deep analysis agent that researches tokens, projects, and on-chain data to produce actionable reports",
    skills: ["Token Analyzer", "Contract Auditor", "Whale Tracker", "Report Generator"],
    icon: "🔍",
  },
  social: {
    name: "Social Agent",
    bio: "Content creation and engagement agent for Twitter/X, Telegram, and Discord",
    skills: ["Content Writer", "Trend Monitor", "Community Manager", "Engagement Bot"],
    icon: "💬",
  },
  defi: {
    name: "DeFi Agent",
    bio: "Yield optimization agent that finds the best farming opportunities and compounds returns",
    skills: ["Yield Scanner", "LP Manager", "Auto Compounder", "Gas Optimizer"],
    icon: "🏦",
  },
  security: {
    name: "Security Agent",
    bio: "Contract security scanner that audits tokens, detects rug pulls, and monitors wallets",
    skills: ["Contract Scanner", "Honeypot Detector", "Rug Analyzer", "Wallet Monitor"],
    icon: "🛡️",
  },
  sniper: {
    name: "Sniper Agent",
    bio: "Ultra-fast token sniper that detects new launches and executes buys within seconds",
    skills: ["Launch Detector", "Fast Executor", "Liquidity Checker", "Exit Planner"],
    icon: "🎯",
  },
};

const CHAIN_MAP: Record<string, string> = {
  bnb: "bnbMainnet",
  base: "baseMainnet",
  xlayer: "xlayerMainnet",
};

const MODEL_MAP: Record<string, string> = {
  llama: "meta-llama/Llama-3.1-70B-Instruct",
  deepseek: "deepseek-ai/DeepSeek-V3",
  qwen: "Qwen/Qwen2.5-72B-Instruct",
};

function parseUserIntent(input: string, currentConfig: AgentConfig): { config: Partial<AgentConfig>; response: string; buildSteps?: string[] } {
  const lower = input.toLowerCase().trim();

  for (const [key, tmpl] of Object.entries(TEMPLATES)) {
    if (lower.includes(key) || lower.includes(tmpl.name.toLowerCase())) {
      return {
        config: {
          type: key,
          name: tmpl.name,
          bio: tmpl.bio,
          skills: [...tmpl.skills],
          status: "configuring",
        },
        response: `Got it. I'll build a ${tmpl.name} for you.\n\n${tmpl.icon} Template: ${tmpl.name}\n📝 ${tmpl.bio}\n🔧 Skills: ${tmpl.skills.join(", ")}\n\nYou can customize it — tell me to change the name, chain, model, or skills. Or say "deploy" when you're ready.`,
      };
    }
  }

  if (lower.includes("name") && lower.includes(" ")) {
    const nameMatch = input.match(/(?:name(?:\s+it)?(?:\s+to)?|call(?:\s+it)?)\s+["']?([^"']+?)["']?\s*$/i);
    if (nameMatch) {
      const name = nameMatch[1].trim().slice(0, 50);
      return {
        config: { name },
        response: `Agent renamed to "${name}".`,
      };
    }
  }

  if (lower.includes("bnb") || lower.includes("bsc")) {
    return { config: { chain: "bnb" }, response: "Chain set to BNB Chain." };
  }
  if (lower.includes("base")) {
    return { config: { chain: "base" }, response: "Chain set to Base." };
  }
  if (lower.includes("xlayer")) {
    return { config: { chain: "xlayer" }, response: "Chain set to XLayer." };
  }

  if (lower.includes("deepseek")) {
    return { config: { model: "deepseek" }, response: "Model set to DeepSeek V3." };
  }
  if (lower.includes("qwen")) {
    return { config: { model: "qwen" }, response: "Model set to Qwen 2.5 72B." };
  }
  if (lower.includes("llama")) {
    return { config: { model: "llama" }, response: "Model set to Llama 3.1 70B." };
  }

  if (lower.includes("supervised")) {
    return { config: { autonomy: "supervised" }, response: "Autonomy set to Supervised — agent will ask for approval before acting." };
  }
  if (lower.includes("full auto") || lower.includes("autonomous")) {
    return { config: { autonomy: "full" }, response: "Autonomy set to Full Auto — agent will act completely independently." };
  }
  if (lower.includes("semi")) {
    return { config: { autonomy: "semi" }, response: "Autonomy set to Semi-Auto — agent acts within predefined limits." };
  }

  if (lower.includes("add skill") || lower.includes("add ")) {
    const skillMatch = input.match(/add\s+(?:skill\s+)?["']?(.+?)["']?\s*$/i);
    if (skillMatch) {
      const skill = skillMatch[1].trim();
      return {
        config: { skills: [...currentConfig.skills, skill] },
        response: `Added skill: "${skill}".`,
      };
    }
  }

  if (lower.includes("deploy") || lower.includes("launch") || lower.includes("build it") || lower.includes("create it") || lower.includes("ship it") || lower.includes("go") && lower.length < 10) {
    if (!currentConfig.type) {
      return {
        config: {},
        response: "You haven't configured an agent yet. Tell me what kind of agent you want — trading, research, social, defi, security, or sniper. Or just describe what you need and I'll figure it out.",
      };
    }
    return {
      config: { status: "building" },
      response: "Starting build...",
      buildSteps: [
        "Initializing agent runtime environment...",
        `Configuring ${currentConfig.model === "deepseek" ? "DeepSeek V3" : currentConfig.model === "qwen" ? "Qwen 2.5" : "Llama 3.1"} model...`,
        `Installing skills: ${currentConfig.skills.join(", ")}...`,
        `Connecting to ${currentConfig.chain === "base" ? "Base" : currentConfig.chain === "xlayer" ? "XLayer" : "BNB Chain"}...`,
        "Generating agent wallet...",
        "Registering on-chain identity (ERC-8004)...",
        "Deploying agent...",
      ],
    };
  }

  if (lower.includes("help") || lower === "?" || lower.includes("what can")) {
    return {
      config: {},
      response: `Here's what you can do:\n\n• Tell me what agent to build: "build a trading agent", "I need a security scanner"\n• Change the name: "name it AlphaBot"\n• Pick a chain: "use Base" or "deploy on BNB"\n• Pick a model: "use DeepSeek" or "use Llama"\n• Add skills: "add whale tracker"\n• Set autonomy: "make it fully autonomous"\n• Deploy: "deploy" or "ship it"\n\nOr just describe what you want in plain English and I'll configure it.`,
    };
  }

  if (lower.includes("trade") || lower.includes("trading") || lower.includes("buy") || lower.includes("sell") || lower.includes("swap")) {
    return {
      config: {
        type: "trading",
        name: "Trading Agent",
        bio: "Autonomous trading agent that monitors markets and executes trades",
        skills: ["Market Scanner", "Signal Detector", "Trade Executor", "Risk Manager"],
        status: "configuring",
      },
      response: `Sounds like you need a Trading Agent. I've configured one for you.\n\n📈 Template: Trading Agent\n🔧 Skills: Market Scanner, Signal Detector, Trade Executor, Risk Manager\n\nCustomize it or say "deploy" when ready.`,
    };
  }

  if (lower.includes("research") || lower.includes("analyze") || lower.includes("scan token")) {
    return {
      config: {
        type: "research",
        name: "Research Agent",
        bio: "Deep analysis agent for token and project research",
        skills: ["Token Analyzer", "Contract Auditor", "Whale Tracker", "Report Generator"],
        status: "configuring",
      },
      response: `I'll set up a Research Agent for you.\n\n🔍 Template: Research Agent\n🔧 Skills: Token Analyzer, Contract Auditor, Whale Tracker, Report Generator\n\nCustomize or say "deploy".`,
    };
  }

  if (lower.includes("security") || lower.includes("audit") || lower.includes("rug") || lower.includes("honeypot")) {
    return {
      config: {
        type: "security",
        name: "Security Agent",
        bio: "Contract security scanner and rug pull detector",
        skills: ["Contract Scanner", "Honeypot Detector", "Rug Analyzer", "Wallet Monitor"],
        status: "configuring",
      },
      response: `Security Agent configured.\n\n🛡️ Template: Security Agent\n🔧 Skills: Contract Scanner, Honeypot Detector, Rug Analyzer, Wallet Monitor\n\nCustomize or say "deploy".`,
    };
  }

  if (lower.includes("snip") || lower.includes("fast") || lower.includes("new launch") || lower.includes("early")) {
    return {
      config: {
        type: "sniper",
        name: "Sniper Agent",
        bio: "Ultra-fast token sniper for new launches",
        skills: ["Launch Detector", "Fast Executor", "Liquidity Checker", "Exit Planner"],
        status: "configuring",
      },
      response: `Sniper Agent configured.\n\n🎯 Template: Sniper Agent\n🔧 Skills: Launch Detector, Fast Executor, Liquidity Checker, Exit Planner\n\nCustomize or say "deploy".`,
    };
  }

  return {
    config: {},
    response: `I'm not sure what you mean. Try telling me what kind of agent to build:\n\n• "build a trading agent"\n• "I need a security scanner"\n• "create a DeFi yield optimizer"\n\nOr type "help" to see all commands.`,
  };
}

export default function AgentBuilder() {
  const [messages, setMessages] = useState<BuildMessage[]>([
    {
      role: "system",
      content: "Welcome to BUILD4 Agent Builder. Tell me what you want to build and I'll create it for you.\n\nExamples:\n• \"Build me a trading agent\"\n• \"I need an agent that scans for rug pulls\"\n• \"Create a DeFi yield optimizer on Base\"\n\nJust describe it. I'll handle the rest.",
      timestamp: new Date(),
      type: "info",
    },
  ]);
  const [inputValue, setInputValue] = useState("");
  const [config, setConfig] = useState<AgentConfig>({
    name: "",
    bio: "",
    type: "",
    chain: "bnb",
    model: "llama",
    skills: [],
    autonomy: "semi",
    status: "idle",
  });
  const [isProcessing, setIsProcessing] = useState(false);
  const [deployedAgentId, setDeployedAgentId] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const addMessage = (msg: Omit<BuildMessage, "timestamp">) => {
    setMessages(prev => [...prev, { ...msg, timestamp: new Date() }]);
  };

  const simulateBuildSteps = async (steps: string[]) => {
    for (let i = 0; i < steps.length; i++) {
      await new Promise(r => setTimeout(r, 600 + Math.random() * 800));
      addMessage({ role: "build", content: steps[i], type: "progress" });
    }
  };

  const deployAgent = async () => {
    try {
      addMessage({ role: "build", content: "Sending to BUILD4 deployment pipeline...", type: "progress" });

      const response = await apiRequest("POST", "/api/web4/agents/create", {
        name: config.name || "Unnamed Agent",
        bio: config.bio || "Agent built with BUILD4 Agent Builder",
        modelType: MODEL_MAP[config.model] || MODEL_MAP.llama,
        initialDeposit: "100000000000000",
        targetChain: CHAIN_MAP[config.chain] || CHAIN_MAP.bnb,
      });

      const agent = await response.json();

      setDeployedAgentId(agent.id);
      setConfig(prev => ({ ...prev, status: "live" }));

      await new Promise(r => setTimeout(r, 500));
      addMessage({
        role: "build",
        content: `Agent deployed successfully!\n\n✅ ID: ${agent.id}\n💰 Wallet: ${agent.wallet?.walletAddress || "Generated"}\n🔗 Chain: ${config.chain === "base" ? "Base" : config.chain === "xlayer" ? "XLayer" : "BNB Chain"}\n🤖 Model: ${config.model === "deepseek" ? "DeepSeek V3" : config.model === "qwen" ? "Qwen 2.5" : "Llama 3.1"}\n\nYour agent is live. You can manage it from the dashboard.`,
        type: "success",
      });

      toast({ title: "Agent Deployed", description: `${config.name} is now live on ${config.chain === "base" ? "Base" : "BNB Chain"}` });
    } catch (error: any) {
      setConfig(prev => ({ ...prev, status: "error" }));
      addMessage({
        role: "build",
        content: `Deployment needs a connected wallet with funds. Connect your wallet first, then try again.\n\nError: ${error.message || "Wallet connection required"}`,
        type: "error",
      });
    }
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputValue.trim() || isProcessing) return;

    const userInput = inputValue.trim();
    setInputValue("");
    addMessage({ role: "user", content: userInput });
    setIsProcessing(true);

    await new Promise(r => setTimeout(r, 300 + Math.random() * 400));

    const { config: updates, response, buildSteps } = parseUserIntent(userInput, config);

    setConfig(prev => ({ ...prev, ...updates }));

    if (buildSteps) {
      addMessage({ role: "build", content: response, type: "progress" });
      await simulateBuildSteps(buildSteps);
      await deployAgent();
    } else {
      addMessage({ role: "system", content: response, type: "info" });
    }

    setIsProcessing(false);
    inputRef.current?.focus();
  };

  const handleQuickAction = (action: string) => {
    setInputValue(action);
    setTimeout(() => {
      const form = document.getElementById("build-form") as HTMLFormElement;
      form?.requestSubmit();
    }, 50);
  };

  return (
    <>
      <SEO
        title="Agent Builder | BUILD4"
        description="Build autonomous AI agents with natural language. Describe what you want and BUILD4 creates it for you."
        path="/build"
      />

      <div className="min-h-screen bg-background flex flex-col" data-testid="page-agent-builder">
        <header className="border-b sticky top-0 z-40 bg-background/95 backdrop-blur">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <div className="flex items-center justify-between h-12">
              <div className="flex items-center gap-3">
                <Link href="/">
                  <Button variant="ghost" size="icon" className="h-7 w-7" data-testid="button-back">
                    <ArrowLeft className="w-3.5 h-3.5" />
                  </Button>
                </Link>
                <div className="flex items-center gap-2">
                  <Terminal className="w-3.5 h-3.5 text-primary" />
                  <span className="font-mono font-bold text-xs tracking-wider">BUILD<span className="text-primary">4</span></span>
                  <ChevronRight className="w-3 h-3 text-muted-foreground" />
                  <span className="font-mono text-xs text-muted-foreground">Agent Builder</span>
                </div>
                {config.status !== "idle" && (
                  <Badge
                    variant={config.status === "live" ? "default" : "secondary"}
                    className={`font-mono text-[9px] ${config.status === "live" ? "bg-emerald-600" : config.status === "building" || config.status === "deploying" ? "bg-amber-600" : ""}`}
                  >
                    {config.status === "live" ? "LIVE" : config.status === "building" ? "BUILDING" : config.status === "configuring" ? "CONFIGURING" : config.status.toUpperCase()}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Link href="/agent-store">
                  <Button variant="ghost" size="sm" className="font-mono text-[10px] gap-1 h-7 px-2" data-testid="button-store">
                    <Globe className="w-3 h-3" /> Store
                  </Button>
                </Link>
                <Link href="/sdk">
                  <Button variant="ghost" size="sm" className="font-mono text-[10px] gap-1 h-7 px-2" data-testid="button-sdk">
                    <Code className="w-3 h-3" /> SDK
                  </Button>
                </Link>
              </div>
            </div>
          </div>
        </header>

        <div className="flex-1 flex">
          <div className="flex-1 flex flex-col max-w-6xl mx-auto w-full">
            <div className="flex-1 flex gap-0 border-x">

              <div className="flex-1 flex flex-col min-w-0">
                <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3" data-testid="chat-messages">
                  {messages.map((msg, i) => (
                    <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[85%] rounded-lg px-3.5 py-2.5 ${
                        msg.role === "user"
                          ? "bg-primary text-primary-foreground"
                          : msg.type === "success"
                          ? "bg-emerald-500/10 border border-emerald-500/20"
                          : msg.type === "error"
                          ? "bg-red-500/10 border border-red-500/20"
                          : msg.type === "progress"
                          ? "bg-amber-500/5 border border-amber-500/10"
                          : "bg-muted/50 border"
                      }`} data-testid={`message-${i}`}>
                        {msg.role !== "user" && (
                          <div className="flex items-center gap-1.5 mb-1.5">
                            {msg.type === "progress" ? (
                              <Loader2 className="w-3 h-3 text-amber-500 animate-spin" />
                            ) : msg.type === "success" ? (
                              <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                            ) : msg.type === "error" ? (
                              <AlertCircle className="w-3 h-3 text-red-500" />
                            ) : (
                              <Sparkles className="w-3 h-3 text-primary" />
                            )}
                            <span className="font-mono text-[9px] text-muted-foreground uppercase tracking-wider">
                              {msg.role === "build" ? "build engine" : "build4"}
                            </span>
                          </div>
                        )}
                        <pre className="font-mono text-xs whitespace-pre-wrap leading-relaxed">
                          {msg.content}
                        </pre>
                      </div>
                    </div>
                  ))}
                  {isProcessing && (
                    <div className="flex justify-start">
                      <div className="bg-muted/50 border rounded-lg px-3.5 py-2.5">
                        <div className="flex items-center gap-2">
                          <Loader2 className="w-3 h-3 animate-spin text-primary" />
                          <span className="font-mono text-xs text-muted-foreground">Processing...</span>
                        </div>
                      </div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>

                {config.status === "idle" && messages.length <= 1 && (
                  <div className="px-4 pb-3 grid grid-cols-2 sm:grid-cols-3 gap-2" data-testid="quick-templates">
                    {Object.entries(TEMPLATES).slice(0, 6).map(([key, tmpl]) => (
                      <button
                        key={key}
                        onClick={() => handleQuickAction(`build a ${key} agent`)}
                        className="p-3 rounded-lg border bg-muted/30 hover:bg-muted/60 text-left transition-all"
                        data-testid={`quick-${key}`}
                      >
                        <span className="text-lg">{tmpl.icon}</span>
                        <div className="font-mono text-[11px] font-bold mt-1">{tmpl.name}</div>
                        <div className="font-mono text-[9px] text-muted-foreground mt-0.5 line-clamp-2">{tmpl.bio}</div>
                      </button>
                    ))}
                  </div>
                )}

                <div className="border-t p-3" data-testid="chat-input-area">
                  <form id="build-form" onSubmit={handleSubmit} className="flex gap-2">
                    <Input
                      ref={inputRef}
                      value={inputValue}
                      onChange={(e) => setInputValue(e.target.value)}
                      placeholder={config.status === "idle" ? "Describe the agent you want to build..." : config.status === "live" ? "Agent deployed! Describe another or type 'help'" : "Customize your agent or say 'deploy'..."}
                      className="font-mono text-sm flex-1"
                      disabled={isProcessing}
                      data-testid="input-command"
                    />
                    <Button type="submit" disabled={isProcessing || !inputValue.trim()} size="sm" className="gap-1.5 px-4" data-testid="button-send">
                      {isProcessing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                    </Button>
                  </form>
                  <div className="flex items-center gap-3 mt-2 overflow-x-auto pb-1">
                    {config.status === "configuring" && (
                      <>
                        <button onClick={() => handleQuickAction("deploy")} className="flex items-center gap-1 px-2 py-1 rounded bg-emerald-500/10 text-emerald-500 font-mono text-[10px] hover:bg-emerald-500/20 transition-colors whitespace-nowrap" data-testid="quick-deploy">
                          <Rocket className="w-3 h-3" /> Deploy
                        </button>
                        <button onClick={() => handleQuickAction("use DeepSeek")} className="flex items-center gap-1 px-2 py-1 rounded bg-muted font-mono text-[10px] hover:bg-muted/80 transition-colors whitespace-nowrap" data-testid="quick-deepseek">
                          <Brain className="w-3 h-3" /> DeepSeek
                        </button>
                        <button onClick={() => handleQuickAction("use Base chain")} className="flex items-center gap-1 px-2 py-1 rounded bg-muted font-mono text-[10px] hover:bg-muted/80 transition-colors whitespace-nowrap" data-testid="quick-base">
                          <Globe className="w-3 h-3" /> Base
                        </button>
                        <button onClick={() => handleQuickAction("make it fully autonomous")} className="flex items-center gap-1 px-2 py-1 rounded bg-muted font-mono text-[10px] hover:bg-muted/80 transition-colors whitespace-nowrap" data-testid="quick-auto">
                          <Zap className="w-3 h-3" /> Full Auto
                        </button>
                      </>
                    )}
                    {config.status === "idle" && (
                      <>
                        <button onClick={() => handleQuickAction("build a trading agent")} className="flex items-center gap-1 px-2 py-1 rounded bg-muted font-mono text-[10px] hover:bg-muted/80 transition-colors whitespace-nowrap" data-testid="quick-trading-btn">
                          <TrendingUp className="w-3 h-3" /> Trading
                        </button>
                        <button onClick={() => handleQuickAction("build a security agent")} className="flex items-center gap-1 px-2 py-1 rounded bg-muted font-mono text-[10px] hover:bg-muted/80 transition-colors whitespace-nowrap" data-testid="quick-security-btn">
                          <Shield className="w-3 h-3" /> Security
                        </button>
                        <button onClick={() => handleQuickAction("build a sniper agent")} className="flex items-center gap-1 px-2 py-1 rounded bg-muted font-mono text-[10px] hover:bg-muted/80 transition-colors whitespace-nowrap" data-testid="quick-sniper-btn">
                          <Zap className="w-3 h-3" /> Sniper
                        </button>
                        <button onClick={() => handleQuickAction("help")} className="flex items-center gap-1 px-2 py-1 rounded bg-muted font-mono text-[10px] hover:bg-muted/80 transition-colors whitespace-nowrap" data-testid="quick-help-btn">
                          <MessageSquare className="w-3 h-3" /> Help
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>

              <div className="hidden lg:flex flex-col w-72 border-l bg-muted/10">
                <div className="p-3 border-b">
                  <div className="flex items-center gap-2">
                    <Settings className="w-3.5 h-3.5 text-primary" />
                    <span className="font-mono text-xs font-bold">Agent Config</span>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-3 space-y-4">
                  <div className="space-y-2">
                    <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Name</div>
                    <div className="font-mono text-xs font-semibold" data-testid="config-name">
                      {config.name || "—"}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Type</div>
                    <div className="flex items-center gap-1.5">
                      {config.type ? (
                        <>
                          <span>{TEMPLATES[config.type]?.icon || "🤖"}</span>
                          <span className="font-mono text-xs font-semibold" data-testid="config-type">{TEMPLATES[config.type]?.name || config.type}</span>
                        </>
                      ) : (
                        <span className="font-mono text-xs text-muted-foreground" data-testid="config-type">Not selected</span>
                      )}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Chain</div>
                    <Badge variant="outline" className="font-mono text-[10px]" data-testid="config-chain">
                      {config.chain === "base" ? "Base" : config.chain === "xlayer" ? "XLayer" : "BNB Chain"}
                    </Badge>
                  </div>

                  <div className="space-y-2">
                    <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Model</div>
                    <Badge variant="outline" className="font-mono text-[10px]" data-testid="config-model">
                      <Cpu className="w-2.5 h-2.5 mr-1" />
                      {config.model === "deepseek" ? "DeepSeek V3" : config.model === "qwen" ? "Qwen 2.5" : "Llama 3.1"}
                    </Badge>
                  </div>

                  <div className="space-y-2">
                    <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Autonomy</div>
                    <Badge variant="outline" className="font-mono text-[10px]" data-testid="config-autonomy">
                      {config.autonomy === "full" ? "Full Auto" : config.autonomy === "supervised" ? "Supervised" : "Semi-Auto"}
                    </Badge>
                  </div>

                  <div className="space-y-2">
                    <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Skills ({config.skills.length})</div>
                    <div className="space-y-1" data-testid="config-skills">
                      {config.skills.length > 0 ? config.skills.map((s, i) => (
                        <div key={i} className="flex items-center gap-1.5 font-mono text-[10px]">
                          <CheckCircle2 className="w-2.5 h-2.5 text-emerald-500" />
                          {s}
                        </div>
                      )) : (
                        <div className="font-mono text-[10px] text-muted-foreground">None configured</div>
                      )}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Status</div>
                    <div className="flex items-center gap-1.5" data-testid="config-status">
                      <div className={`w-2 h-2 rounded-full ${
                        config.status === "live" ? "bg-emerald-500 animate-pulse" :
                        config.status === "building" || config.status === "deploying" ? "bg-amber-500 animate-pulse" :
                        config.status === "error" ? "bg-red-500" :
                        config.status === "configuring" ? "bg-blue-500" :
                        "bg-muted-foreground"
                      }`} />
                      <span className="font-mono text-xs capitalize">{config.status}</span>
                    </div>
                  </div>

                  {deployedAgentId && (
                    <div className="space-y-2 pt-2 border-t">
                      <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Agent ID</div>
                      <code className="font-mono text-[9px] text-primary break-all" data-testid="config-agent-id">{deployedAgentId}</code>
                    </div>
                  )}
                </div>

                {config.status === "configuring" && (
                  <div className="p-3 border-t">
                    <Button
                      size="sm"
                      className="w-full font-mono text-xs gap-1.5"
                      onClick={() => handleQuickAction("deploy")}
                      data-testid="sidebar-deploy"
                    >
                      <Rocket className="w-3.5 h-3.5" /> Deploy Agent
                    </Button>
                  </div>
                )}

                {config.status === "live" && (
                  <div className="p-3 border-t space-y-2">
                    <Link href="/autonomous-economy">
                      <Button size="sm" variant="outline" className="w-full font-mono text-xs gap-1.5" data-testid="button-manage">
                        <Activity className="w-3.5 h-3.5" /> Manage Agent
                      </Button>
                    </Link>
                    <Button
                      size="sm"
                      className="w-full font-mono text-xs gap-1.5"
                      onClick={() => {
                        setConfig({ name: "", bio: "", type: "", chain: "bnb", model: "llama", skills: [], autonomy: "semi", status: "idle" });
                        setDeployedAgentId(null);
                        setMessages([{
                          role: "system",
                          content: "Ready to build another agent. What do you need?",
                          timestamp: new Date(),
                          type: "info",
                        }]);
                      }}
                      data-testid="button-build-another"
                    >
                      <Plus className="w-3.5 h-3.5" /> Build Another
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
