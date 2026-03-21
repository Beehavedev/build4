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
  TrendingUp, MessageSquare, Search,
  Eye, Globe, Lock, CheckCircle2, ArrowRight,
  Send, Cpu, Star, Users, Activity,
  Loader2, ChevronRight, Sparkles,
  AlertCircle, Monitor,
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

const CHAIN_MAP: Record<string, string> = { bnb: "bnbMainnet", base: "baseMainnet", xlayer: "xlayerMainnet" };
const MODEL_MAP: Record<string, string> = { llama: "meta-llama/Llama-3.1-70B-Instruct", deepseek: "deepseek-ai/DeepSeek-V3", qwen: "Qwen/Qwen2.5-72B-Instruct" };

function extractConfigFromInput(input: string, currentConfig: AgentConfig): Partial<AgentConfig> | null {
  const lower = input.toLowerCase().trim();
  const updates: Partial<AgentConfig> = {};
  let matched = false;

  for (const [key, tmpl] of Object.entries(TEMPLATES)) {
    if (lower.includes(key) || lower.includes(tmpl.name.toLowerCase().replace(" agent", ""))) {
      updates.type = key;
      updates.name = tmpl.name;
      updates.bio = tmpl.bio;
      updates.skills = [...tmpl.skills];
      updates.status = "configuring";
      matched = true;
      break;
    }
  }

  if (lower.includes("bnb") || lower.includes("bsc")) { updates.chain = "bnb"; matched = true; }
  else if (lower.includes("base chain") || (lower.includes("base") && !lower.includes("database"))) { updates.chain = "base"; matched = true; }
  else if (lower.includes("xlayer")) { updates.chain = "xlayer"; matched = true; }

  if (lower.includes("deepseek")) { updates.model = "deepseek"; matched = true; }
  else if (lower.includes("qwen")) { updates.model = "qwen"; matched = true; }
  else if (lower.includes("llama")) { updates.model = "llama"; matched = true; }

  if (lower.includes("supervised")) { updates.autonomy = "supervised"; matched = true; }
  else if (lower.includes("full auto") || lower.includes("fully autonomous")) { updates.autonomy = "full"; matched = true; }
  else if (lower.includes("semi")) { updates.autonomy = "semi"; matched = true; }

  const nameMatch = input.match(/(?:name(?:\s+it)?(?:\s+to)?|call(?:\s+it)?)\s+["']?([^"']+?)["']?\s*$/i);
  if (nameMatch) { updates.name = nameMatch[1].trim().slice(0, 50); matched = true; }

  const addSkill = input.match(/add\s+(?:skill\s+)?["']?(.+?)["']?\s*$/i);
  if (addSkill && !lower.startsWith("add a")) { updates.skills = [...currentConfig.skills, addSkill[1].trim()]; matched = true; }

  const forkMap: Record<string, { type: string; name: string; bio: string; skills: string[] }> = {
    "alpha": { type: "trading", name: "Alpha Hunter v3 (fork)", bio: "Multi-chain trading agent — whale tracking, social sentiment, alpha detection", skills: ["Market Scanner", "Whale Tracker", "Signal Detector", "Trade Executor", "Social Sentiment"] },
    "sentinel": { type: "security", name: "Sentinel Security (fork)", bio: "Real-time contract auditing, honeypot detection, rug pull analysis", skills: ["Contract Scanner", "Honeypot Detector", "Rug Analyzer", "Wallet Monitor", "Alert System"] },
    "yield": { type: "defi", name: "YieldMax Pro (fork)", bio: "Automated yield farming with auto-compounding", skills: ["Yield Scanner", "LP Manager", "Auto Compounder", "Gas Optimizer", "Position Tracker"] },
    "copy": { type: "trading", name: "CopyTrader AI (fork)", bio: "Follow top PnL wallets with configurable sizing", skills: ["Wallet Tracker", "Trade Copier", "Position Sizer", "Risk Manager"] },
  };
  if (lower.includes("fork")) {
    for (const [key, fork] of Object.entries(forkMap)) {
      if (lower.includes(key)) {
        Object.assign(updates, fork, { status: "configuring" });
        matched = true;
        break;
      }
    }
  }

  return matched ? updates : null;
}

function isDeployCommand(input: string): boolean {
  const lower = input.toLowerCase().trim();
  return ["deploy", "launch", "build it", "create it", "ship it", "go", "deploy it", "let's go"].some(cmd => lower === cmd || lower.startsWith(cmd));
}

export default function AgentBuilder() {
  const [messages, setMessages] = useState<BuildMessage[]>([
    {
      role: "system",
      content: "Welcome to BUILD4 Agent Builder. Describe the agent you want and I'll build it for you.\n\nTry: \"Build me a trading agent on Base\" or \"I need a sniper bot that catches new launches\"",
      timestamp: new Date(),
      type: "info",
    },
  ]);
  const [inputValue, setInputValue] = useState("");
  const [config, setConfig] = useState<AgentConfig>({
    name: "", bio: "", type: "", chain: "bnb", model: "llama", skills: [], autonomy: "semi", status: "idle",
  });
  const [isProcessing, setIsProcessing] = useState(false);
  const [deployedAgentId, setDeployedAgentId] = useState<string | null>(null);
  const [previewTab, setPreviewTab] = useState<"preview" | "logs">("preview");
  const [buildLogs, setBuildLogs] = useState<string[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const configRef = useRef(config);
  const { toast } = useToast();

  useEffect(() => { configRef.current = config; }, [config]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const addMessage = (msg: Omit<BuildMessage, "timestamp">) => {
    setMessages(prev => [...prev, { ...msg, timestamp: new Date() }]);
  };

  const addLog = (log: string) => {
    setBuildLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${log}`]);
  };

  const getAIResponse = async (userMessage: string, currentConfig?: AgentConfig): Promise<string | null> => {
    try {
      const resp = await apiRequest("POST", "/api/builder/chat", {
        message: userMessage,
        config: currentConfig || configRef.current,
      });
      const data = await resp.json();
      if (data.fallback || !data.response) return null;
      return data.response;
    } catch {
      return null;
    }
  };

  const simulateBuildSteps = async (steps: string[]) => {
    for (const step of steps) {
      await new Promise(r => setTimeout(r, 500 + Math.random() * 700));
      addMessage({ role: "build", content: step, type: "progress" });
      addLog(step);
    }
  };

  const deployAgent = async () => {
    try {
      addLog("Sending deployment request...");
      addMessage({ role: "build", content: "Deploying to BUILD4...", type: "progress" });

      const response = await apiRequest("POST", "/api/web4/agents/create", {
        name: config.name || "Unnamed Agent",
        bio: config.bio || "Built with BUILD4 Agent Builder",
        modelType: MODEL_MAP[config.model] || MODEL_MAP.llama,
        initialDeposit: "100000000000000",
        targetChain: CHAIN_MAP[config.chain] || CHAIN_MAP.bnb,
      });

      const agent = await response.json();
      setDeployedAgentId(agent.id);
      setConfig(prev => ({ ...prev, status: "live" }));
      addLog(`Agent deployed: ${agent.id}`);
      addLog(`Wallet: ${agent.wallet?.walletAddress || "Generated"}`);
      addLog("Status: LIVE");

      addMessage({
        role: "build",
        content: `Agent deployed!\n\nID: ${agent.id}\nWallet: ${agent.wallet?.walletAddress || "Generated"}\nChain: ${config.chain === "base" ? "Base" : config.chain === "xlayer" ? "XLayer" : "BNB Chain"}\nModel: ${config.model === "deepseek" ? "DeepSeek V3" : config.model === "qwen" ? "Qwen 2.5" : "Llama 3.1"}\n\nYour agent is live. Manage it from the dashboard or build another one.`,
        type: "success",
      });

      toast({ title: "Agent Deployed", description: `${config.name} is live` });
    } catch (error: any) {
      setConfig(prev => ({ ...prev, status: "configuring" }));
      addLog(`Error: ${error.message}`);
      addMessage({
        role: "build",
        content: `Connect your wallet with funds first, then try again.\n\n${error.message || "Wallet required"}`,
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
    addLog(`User: ${userInput}`);
    setIsProcessing(true);

    if (isDeployCommand(userInput)) {
      if (!config.type) {
        addMessage({ role: "system", content: "No agent configured yet. Tell me what you want to build first.", type: "info" });
        setIsProcessing(false);
        return;
      }
      addMessage({ role: "build", content: "Starting build...", type: "progress" });
      setConfig(prev => ({ ...prev, status: "building" }));
      const steps = [
        "Initializing runtime environment...",
        `Loading ${config.model === "deepseek" ? "DeepSeek V3" : config.model === "qwen" ? "Qwen 2.5" : "Llama 3.1"} model...`,
        `Installing skills: ${config.skills.join(", ")}...`,
        `Connecting to ${config.chain === "base" ? "Base" : config.chain === "xlayer" ? "XLayer" : "BNB Chain"}...`,
        "Generating agent wallet...",
        "Registering on-chain identity (ERC-8004)...",
      ];
      await simulateBuildSteps(steps);
      await deployAgent();
      setIsProcessing(false);
      return;
    }

    const configUpdates = extractConfigFromInput(userInput, config);
    let updatedConfig = config;
    if (configUpdates) {
      updatedConfig = { ...config, ...configUpdates };
      setConfig(updatedConfig);
      addLog(`Config updated: ${JSON.stringify(configUpdates)}`);
    }

    const aiResponse = await getAIResponse(userInput, updatedConfig);

    if (aiResponse) {
      addMessage({ role: "system", content: aiResponse, type: "info" });
    } else {
      if (configUpdates) {
        const tmpl = configUpdates.type ? TEMPLATES[configUpdates.type] : null;
        if (tmpl) {
          addMessage({
            role: "system",
            content: `${tmpl.icon} ${tmpl.name} configured.\n\n${tmpl.bio}\n\nSkills: ${(configUpdates.skills || config.skills).join(", ")}\nChain: ${(configUpdates.chain || config.chain) === "base" ? "Base" : (configUpdates.chain || config.chain) === "xlayer" ? "XLayer" : "BNB Chain"}\nModel: ${(configUpdates.model || config.model) === "deepseek" ? "DeepSeek V3" : (configUpdates.model || config.model) === "qwen" ? "Qwen 2.5" : "Llama 3.1"}\n\nCustomize it further or say "deploy" when ready.`,
            type: "info",
          });
        } else {
          const changes: string[] = [];
          if (configUpdates.chain) changes.push(`Chain: ${configUpdates.chain === "base" ? "Base" : configUpdates.chain === "xlayer" ? "XLayer" : "BNB Chain"}`);
          if (configUpdates.model) changes.push(`Model: ${configUpdates.model === "deepseek" ? "DeepSeek V3" : configUpdates.model === "qwen" ? "Qwen 2.5" : "Llama 3.1"}`);
          if (configUpdates.autonomy) changes.push(`Autonomy: ${configUpdates.autonomy === "full" ? "Full Auto" : configUpdates.autonomy === "supervised" ? "Supervised" : "Semi-Auto"}`);
          if (configUpdates.name) changes.push(`Name: ${configUpdates.name}`);
          if (configUpdates.skills && configUpdates.skills.length > config.skills.length) changes.push(`Added skill`);
          addMessage({ role: "system", content: `Updated. ${changes.join(", ")}.${config.type ? ' Say "deploy" when ready.' : ""}`, type: "info" });
        }
      } else {
        addMessage({
          role: "system",
          content: `I can help you build an agent. Try:\n\n• "Build a trading agent" — autonomous DEX trader\n• "I need a security scanner" — audit contracts\n• "Create a sniper bot" — catch new launches\n• "Show me agents" — browse community agents\n\nOr describe what you need in your own words.`,
          type: "info",
        });
      }
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

  const chainLabel = config.chain === "base" ? "Base" : config.chain === "xlayer" ? "XLayer" : "BNB Chain";
  const modelLabel = config.model === "deepseek" ? "DeepSeek V3" : config.model === "qwen" ? "Qwen 2.5 72B" : "Llama 3.1 70B";

  return (
    <>
      <SEO title="Agent Builder | BUILD4" description="Build autonomous AI agents with natural language." path="/build" />

      <div className="min-h-screen bg-background flex flex-col" data-testid="page-agent-builder">
        <header className="border-b sticky top-0 z-40 bg-background/95 backdrop-blur">
          <div className="max-w-[1400px] mx-auto px-4">
            <div className="flex items-center justify-between h-11">
              <div className="flex items-center gap-3">
                <Link href="/">
                  <Button variant="ghost" size="icon" className="h-7 w-7" data-testid="button-back">
                    <ArrowLeft className="w-3.5 h-3.5" />
                  </Button>
                </Link>
                <div className="flex items-center gap-1.5">
                  <Terminal className="w-3.5 h-3.5 text-primary" />
                  <span className="font-mono font-bold text-xs">BUILD<span className="text-primary">4</span></span>
                  <ChevronRight className="w-3 h-3 text-muted-foreground" />
                  <span className="font-mono text-xs text-muted-foreground">Builder</span>
                </div>
                {config.status !== "idle" && (
                  <Badge variant={config.status === "live" ? "default" : "secondary"} className={`font-mono text-[9px] ${config.status === "live" ? "bg-emerald-600" : config.status === "building" ? "bg-amber-600" : ""}`}>
                    {config.status.toUpperCase()}
                  </Badge>
                )}
              </div>
              <Link href="/autonomous-economy">
                <Button variant="ghost" size="sm" className="font-mono text-[10px] gap-1 h-7 px-2" data-testid="button-dashboard">
                  <Activity className="w-3 h-3" /> Dashboard
                </Button>
              </Link>
            </div>
          </div>
        </header>

        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 flex max-w-[1400px] mx-auto w-full border-x">

            <div className="w-full lg:w-[45%] flex flex-col border-r min-w-0">
              <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5" data-testid="chat-messages">
                {messages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[90%] rounded-lg px-3 py-2 ${
                      msg.role === "user" ? "bg-primary text-primary-foreground"
                        : msg.type === "success" ? "bg-emerald-500/10 border border-emerald-500/20"
                        : msg.type === "error" ? "bg-red-500/10 border border-red-500/20"
                        : msg.type === "progress" ? "bg-amber-500/5 border border-amber-500/10"
                        : "bg-muted/50 border"
                    }`} data-testid={`message-${i}`}>
                      {msg.role !== "user" && (
                        <div className="flex items-center gap-1.5 mb-1">
                          {msg.type === "progress" ? <Loader2 className="w-3 h-3 text-amber-500 animate-spin" />
                            : msg.type === "success" ? <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                            : msg.type === "error" ? <AlertCircle className="w-3 h-3 text-red-500" />
                            : <Sparkles className="w-3 h-3 text-primary" />}
                          <span className="font-mono text-[9px] text-muted-foreground uppercase tracking-wider">
                            {msg.role === "build" ? "build engine" : "build4 ai"}
                          </span>
                        </div>
                      )}
                      <pre className="font-mono text-[11px] whitespace-pre-wrap leading-relaxed">{msg.content}</pre>
                    </div>
                  </div>
                ))}
                {isProcessing && (
                  <div className="flex justify-start">
                    <div className="bg-muted/50 border rounded-lg px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Loader2 className="w-3 h-3 animate-spin text-primary" />
                        <span className="font-mono text-[11px] text-muted-foreground">Thinking...</span>
                      </div>
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              {config.status === "idle" && messages.length <= 1 && (
                <div className="px-3 pb-2 grid grid-cols-2 gap-1.5" data-testid="quick-templates">
                  {Object.entries(TEMPLATES).map(([key, tmpl]) => (
                    <button key={key} onClick={() => handleQuickAction(`build a ${key} agent`)}
                      className="p-2 rounded-lg border bg-muted/30 hover:bg-muted/60 text-left transition-all" data-testid={`quick-${key}`}>
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm">{tmpl.icon}</span>
                        <span className="font-mono text-[10px] font-bold">{tmpl.name}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              <div className="border-t p-2.5" data-testid="chat-input-area">
                <form id="build-form" onSubmit={handleSubmit} className="flex gap-1.5">
                  <Input ref={inputRef} value={inputValue} onChange={(e) => setInputValue(e.target.value)}
                    placeholder={config.status === "idle" ? "Describe what you want to build..." : config.status === "live" ? "Build another agent..." : "Customize or say 'deploy'..."}
                    className="font-mono text-xs flex-1 h-8" disabled={isProcessing} data-testid="input-command" />
                  <Button type="submit" disabled={isProcessing || !inputValue.trim()} size="sm" className="gap-1 px-3 h-8" data-testid="button-send">
                    {isProcessing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                  </Button>
                </form>
                <div className="flex items-center gap-1.5 mt-1.5 overflow-x-auto">
                  {config.status === "configuring" && (
                    <>
                      <button onClick={() => handleQuickAction("deploy")} className="flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-500 font-mono text-[9px] hover:bg-emerald-500/20 transition-colors whitespace-nowrap" data-testid="quick-deploy">
                        <Rocket className="w-2.5 h-2.5" /> Deploy
                      </button>
                      <button onClick={() => handleQuickAction("use DeepSeek")} className="flex items-center gap-1 px-2 py-0.5 rounded bg-muted font-mono text-[9px] hover:bg-muted/80 transition-colors whitespace-nowrap" data-testid="quick-deepseek">
                        <Brain className="w-2.5 h-2.5" /> DeepSeek
                      </button>
                      <button onClick={() => handleQuickAction("use Base chain")} className="flex items-center gap-1 px-2 py-0.5 rounded bg-muted font-mono text-[9px] hover:bg-muted/80 transition-colors whitespace-nowrap" data-testid="quick-base">
                        <Globe className="w-2.5 h-2.5" /> Base
                      </button>
                    </>
                  )}
                  {config.status === "idle" && (
                    <>
                      <button onClick={() => handleQuickAction("build a trading agent")} className="flex items-center gap-1 px-2 py-0.5 rounded bg-muted font-mono text-[9px] hover:bg-muted/80 transition-colors whitespace-nowrap" data-testid="quick-trading-btn">
                        <TrendingUp className="w-2.5 h-2.5" /> Trading
                      </button>
                      <button onClick={() => handleQuickAction("build a security agent")} className="flex items-center gap-1 px-2 py-0.5 rounded bg-muted font-mono text-[9px] hover:bg-muted/80 transition-colors whitespace-nowrap" data-testid="quick-security-btn">
                        <Shield className="w-2.5 h-2.5" /> Security
                      </button>
                      <button onClick={() => handleQuickAction("show me agents")} className="flex items-center gap-1 px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-500 font-mono text-[9px] hover:bg-cyan-500/20 transition-colors whitespace-nowrap" data-testid="quick-store-btn">
                        <Globe className="w-2.5 h-2.5" /> Browse
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="hidden lg:flex flex-col flex-1 min-w-0">
              <div className="flex items-center justify-between px-3 h-9 border-b bg-muted/20">
                <div className="flex items-center gap-2">
                  <button onClick={() => setPreviewTab("preview")}
                    className={`font-mono text-[10px] px-2 py-1 rounded transition-colors ${previewTab === "preview" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                    data-testid="tab-preview">
                    <Monitor className="w-3 h-3 inline mr-1" />Preview
                  </button>
                  <button onClick={() => setPreviewTab("logs")}
                    className={`font-mono text-[10px] px-2 py-1 rounded transition-colors ${previewTab === "logs" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                    data-testid="tab-logs">
                    <Terminal className="w-3 h-3 inline mr-1" />Logs ({buildLogs.length})
                  </button>
                </div>
                {config.status === "live" && (
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="font-mono text-[9px] text-emerald-500">LIVE</span>
                  </div>
                )}
              </div>

              {previewTab === "preview" ? (
                <div className="flex-1 flex items-center justify-center p-6 bg-[#0a0a0a]" data-testid="preview-panel">
                  {config.status === "idle" ? (
                    <div className="text-center space-y-4 max-w-sm">
                      <div className="w-16 h-16 mx-auto rounded-2xl bg-muted/20 flex items-center justify-center">
                        <Bot className="w-8 h-8 text-muted-foreground/40" />
                      </div>
                      <p className="font-mono text-xs text-muted-foreground">
                        Your agent preview will appear here.
                        <br />Start by describing what you want to build.
                      </p>
                    </div>
                  ) : (
                    <div className="w-full max-w-md space-y-4">
                      <Card className="p-5 bg-background/95 space-y-4">
                        <div className="flex items-center gap-3">
                          <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-2xl ${
                            config.status === "live" ? "bg-emerald-500/10" : config.status === "building" ? "bg-amber-500/10" : "bg-primary/10"
                          }`}>
                            {TEMPLATES[config.type]?.icon || "🤖"}
                          </div>
                          <div className="flex-1">
                            <div className="font-mono text-sm font-bold" data-testid="preview-name">{config.name || "Unnamed Agent"}</div>
                            <div className="font-mono text-[10px] text-muted-foreground mt-0.5">{config.bio || "No description"}</div>
                          </div>
                          <div className={`w-3 h-3 rounded-full ${
                            config.status === "live" ? "bg-emerald-500 animate-pulse" :
                            config.status === "building" ? "bg-amber-500 animate-pulse" :
                            "bg-blue-500"
                          }`} />
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          <div className="p-2 rounded bg-muted/30">
                            <div className="font-mono text-[9px] text-muted-foreground">Chain</div>
                            <div className="font-mono text-[11px] font-semibold mt-0.5">{chainLabel}</div>
                          </div>
                          <div className="p-2 rounded bg-muted/30">
                            <div className="font-mono text-[9px] text-muted-foreground">Model</div>
                            <div className="font-mono text-[11px] font-semibold mt-0.5">{modelLabel}</div>
                          </div>
                          <div className="p-2 rounded bg-muted/30">
                            <div className="font-mono text-[9px] text-muted-foreground">Autonomy</div>
                            <div className="font-mono text-[11px] font-semibold mt-0.5">
                              {config.autonomy === "full" ? "Full Auto" : config.autonomy === "supervised" ? "Supervised" : "Semi-Auto"}
                            </div>
                          </div>
                          <div className="p-2 rounded bg-muted/30">
                            <div className="font-mono text-[9px] text-muted-foreground">Skills</div>
                            <div className="font-mono text-[11px] font-semibold mt-0.5">{config.skills.length}</div>
                          </div>
                        </div>

                        {config.skills.length > 0 && (
                          <div className="space-y-1.5">
                            <div className="font-mono text-[9px] text-muted-foreground uppercase tracking-wider">Installed Skills</div>
                            <div className="flex flex-wrap gap-1">
                              {config.skills.map((s, i) => (
                                <Badge key={i} variant="secondary" className="font-mono text-[9px] gap-0.5">
                                  <CheckCircle2 className="w-2.5 h-2.5 text-emerald-500" /> {s}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}

                        {deployedAgentId && (
                          <div className="p-2 rounded bg-emerald-500/5 border border-emerald-500/20 space-y-1">
                            <div className="font-mono text-[9px] text-emerald-500 uppercase tracking-wider">Deployed</div>
                            <code className="font-mono text-[9px] text-emerald-400 block break-all">{deployedAgentId}</code>
                          </div>
                        )}

                        {config.status === "building" && (
                          <div className="flex items-center gap-2 p-2 rounded bg-amber-500/5 border border-amber-500/20">
                            <Loader2 className="w-3 h-3 text-amber-500 animate-spin" />
                            <span className="font-mono text-[10px] text-amber-500">Building agent...</span>
                          </div>
                        )}
                      </Card>

                      {config.status === "live" && (
                        <div className="flex gap-2">
                          <Link href="/autonomous-economy" className="flex-1">
                            <Button size="sm" variant="outline" className="w-full font-mono text-[10px] gap-1" data-testid="button-manage">
                              <Activity className="w-3 h-3" /> Dashboard
                            </Button>
                          </Link>
                          <Button size="sm" className="flex-1 font-mono text-[10px] gap-1" data-testid="button-build-another"
                            onClick={() => {
                              setConfig({ name: "", bio: "", type: "", chain: "bnb", model: "llama", skills: [], autonomy: "semi", status: "idle" });
                              setDeployedAgentId(null);
                              setBuildLogs([]);
                              setMessages([{ role: "system", content: "Ready. What do you want to build next?", timestamp: new Date(), type: "info" }]);
                            }}>
                            <Plus className="w-3 h-3" /> New Agent
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex-1 overflow-y-auto p-3 bg-[#0a0a0a] font-mono text-[10px] leading-relaxed" data-testid="logs-panel">
                  {buildLogs.length === 0 ? (
                    <div className="text-muted-foreground/40">No build logs yet. Start building to see output.</div>
                  ) : (
                    buildLogs.map((log, i) => (
                      <div key={i} className={`py-0.5 ${
                        log.includes("Error") ? "text-red-400" :
                        log.includes("deployed") || log.includes("LIVE") ? "text-emerald-400" :
                        log.includes("User:") ? "text-blue-400" :
                        "text-muted-foreground/70"
                      }`}>{log}</div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
