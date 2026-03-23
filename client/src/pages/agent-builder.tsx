import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { SEO } from "@/components/seo";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useWallet } from "@/hooks/use-wallet";
import { useQuery } from "@tanstack/react-query";
import { WORKSPACE_PLANS } from "@shared/schema";
import type { PlanTier } from "@shared/schema";
import {
  Terminal, Bot, Send, Loader2, Sparkles,
  Monitor, Globe, RotateCcw, CheckCircle2,
  Code, Eye, ChevronRight, X, File, Folder, FolderOpen,
  TrendingUp, Shield, Layers, Zap, Brain, Search,
  ArrowLeft, Crown, Rocket, PanelLeft, PanelLeftClose,
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
  trading: { name: "Trading Agent", bio: "Autonomous trading agent that monitors markets, identifies opportunities, and executes trades across DEXs", skills: ["Market Scanner", "Signal Detector", "Trade Executor", "Risk Manager"], icon: "📈" },
  research: { name: "Research Agent", bio: "Deep analysis agent that researches tokens, projects, and on-chain data to produce actionable reports", skills: ["Token Analyzer", "Contract Auditor", "Whale Tracker", "Report Generator"], icon: "🔍" },
  social: { name: "Social Agent", bio: "Content creation and engagement agent for Twitter/X, Telegram, and Discord", skills: ["Content Writer", "Trend Monitor", "Community Manager", "Engagement Bot"], icon: "💬" },
  defi: { name: "DeFi Agent", bio: "Yield optimization agent that finds the best farming opportunities and compounds returns", skills: ["Yield Scanner", "LP Manager", "Auto Compounder", "Gas Optimizer"], icon: "🏦" },
  security: { name: "Security Agent", bio: "Contract security scanner that audits tokens, detects rug pulls, and monitors wallets", skills: ["Contract Scanner", "Honeypot Detector", "Rug Analyzer", "Wallet Monitor"], icon: "🛡️" },
  sniper: { name: "Sniper Agent", bio: "Ultra-fast token sniper that detects new launches and executes buys within seconds", skills: ["Launch Detector", "Fast Executor", "Liquidity Checker", "Exit Planner"], icon: "🎯" },
};

const CHAIN_MAP: Record<string, string> = { bnb: "bnbMainnet", base: "baseMainnet", xlayer: "xlayerMainnet" };
const MODEL_MAP: Record<string, string> = { llama: "meta-llama/Llama-3.3-70B-Instruct", deepseek: "deepseek-ai/DeepSeek-V3", qwen: "Qwen/Qwen2.5-72B-Instruct" };

function generateAgentCode(config: AgentConfig): string {
  if (!config.type) return "";
  const chainName = config.chain === "base" ? "Base" : config.chain === "xlayer" ? "XLayer" : "BNB Chain";
  const modelName = config.model === "deepseek" ? "DeepSeek-V3" : config.model === "qwen" ? "Qwen2.5-72B" : "Llama-3.3-70B";
  return `import { Agent } from "@build4/sdk";
import { ${config.skills.map(s => s.replace(/\s+/g, "")).join(", ")} } from "@build4/skills";

const agent = new Agent({
  name: "${config.name || "Unnamed Agent"}",
  description: "${config.bio || "Built with BUILD4"}",
  chain: "${config.chain}",
  model: "${modelName}",
  autonomy: "${config.autonomy}",
});

${config.skills.map(s => `agent.use(new ${s.replace(/\s+/g, "")}());`).join("\n")}

agent.on("ready", () => {
  console.log(\`[\${agent.name}] Live on ${chainName}\`);
  console.log(\`Wallet: \${agent.wallet.address}\`);
  agent.start();
});

agent.deploy();
`;
}

function generateDefaultPreview(config: AgentConfig): string {
  const skills = config.skills.length > 0 ? config.skills : ["monitoring", "execution"];
  const chainName = config.chain === "base" ? "Base" : config.chain === "xlayer" ? "XLayer" : "BNB Chain";
  const modelName = config.model === "deepseek" ? "DeepSeek V3" : config.model === "qwen" ? "Qwen 2.5" : "Llama 3.3";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0f;color:#e0e0e0;min-height:100vh;display:flex;flex-direction:column}
.header{background:linear-gradient(135deg,#0d1117,#161b22);border-bottom:1px solid #21262d;padding:12px 16px;display:flex;align-items:center;gap:8px}
.header .dot{width:8px;height:8px;border-radius:50%;background:#10b981;animation:pulse 2s infinite}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.header h1{font-size:13px;font-weight:700;color:#fff}.header .badge{font-size:8px;padding:2px 6px;border-radius:4px;background:#10b98120;color:#10b981;text-transform:uppercase;letter-spacing:.5px}
.content{flex:1;padding:16px;display:flex;flex-direction:column;gap:12px}
.card{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:12px}
.card-title{font-size:10px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}
.stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.stat{background:#0d1117;border-radius:6px;padding:8px}
.stat-value{font-size:16px;font-weight:700;color:#fff}.stat-label{font-size:9px;color:#8b949e;margin-top:2px}
.skill-list{display:flex;flex-wrap:wrap;gap:4px}.skill{font-size:9px;padding:3px 8px;border-radius:4px;background:#10b98115;color:#10b981;border:1px solid #10b98130}
.chart{height:60px;background:#0d1117;border-radius:6px;display:flex;align-items:end;padding:4px;gap:2px}
.bar{flex:1;background:linear-gradient(to top,#10b981,#10b98160);border-radius:2px 2px 0 0;animation:grow .8s ease-out}@keyframes grow{from{height:0}}
.status-bar{background:#10b981;padding:6px 16px;display:flex;justify-content:space-between;font-size:9px;color:#fff;font-weight:600}
</style></head><body>
<div class="header"><div class="dot"></div><h1>${config.name || "My Agent"}</h1><span class="badge">${config.status === "live" ? "Live" : "Ready"}</span></div>
<div class="content">
<div class="card"><div class="card-title">Performance</div><div class="stat-grid"><div class="stat"><div class="stat-value">$12,847</div><div class="stat-label">Total Volume</div></div><div class="stat"><div class="stat-value">73.2%</div><div class="stat-label">Win Rate</div></div><div class="stat"><div class="stat-value">341</div><div class="stat-label">Transactions</div></div><div class="stat"><div class="stat-value">2.18 BNB</div><div class="stat-label">Revenue</div></div></div></div>
<div class="card"><div class="card-title">Activity (24h)</div><div class="chart">${Array.from({length:24},(_,i)=>`<div class="bar" style="height:${10+Math.random()*90}%;animation-delay:${i*30}ms"></div>`).join("")}</div></div>
<div class="card"><div class="card-title">Active Skills</div><div class="skill-list">${skills.map(s=>`<span class="skill">${s}</span>`).join("")}</div></div>
</div>
<div class="status-bar"><span>${chainName} · ${modelName}</span><span>${config.autonomy === "full" ? "Full Auto" : config.autonomy === "supervised" ? "Supervised" : "Semi-Auto"}</span></div>
</body></html>`;
}

function generateLoadingPreview(message: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0f;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.container{text-align:center;max-width:280px}.spinner{width:32px;height:32px;border:2px solid #21262d;border-top-color:#10b981;border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 16px}
@keyframes spin{to{transform:rotate(360deg)}}p{color:#606060;font-size:11px;line-height:1.6}
</style></head><body><div class="container"><div class="spinner"></div><p>${message}</p></div></body></html>`;
}

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

  return matched ? updates : null;
}

function isDeployCommand(input: string): boolean {
  const lower = input.toLowerCase().trim();
  return ["deploy", "launch", "build it", "create it", "ship it", "go", "deploy it", "let's go"].some(cmd => lower === cmd || lower.startsWith(cmd));
}

export default function AgentBuilder() {
  const { address, connected: isConnected, signer } = useWallet();
  const [messages, setMessages] = useState<BuildMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [config, setConfig] = useState<AgentConfig>({
    name: "", bio: "", type: "", chain: "bnb", model: "llama", skills: [], autonomy: "semi", status: "idle",
  });
  const [isProcessing, setIsProcessing] = useState(false);
  const [deployedAgentId, setDeployedAgentId] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string>("");
  const [showCode, setShowCode] = useState(false);
  const [projectFiles, setProjectFiles] = useState<Record<string, string>>({});
  const chatEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const configRef = useRef(config);
  const { toast } = useToast();

  const { data: planData } = useQuery({
    queryKey: ["/api/workspace/plan", address],
    queryFn: async () => {
      if (!address) return null;
      const resp = await fetch(`/api/workspace/plan/${address}`);
      return resp.json();
    },
    enabled: !!address,
  });

  const userPlan = (planData?.plan || "free") as PlanTier;

  const checkUsage = async (type: "deploy" | "inference" | "agent"): Promise<boolean> => {
    if (!address) return true;
    try {
      const resp = await apiRequest("POST", "/api/workspace/usage", { walletAddress: address, type });
      if (resp.status === 403) {
        const data = await resp.json();
        addMessage({ role: "system", content: `${data.error}\n\nUpgrade at /pricing to continue.`, type: "error" });
        return false;
      }
      return true;
    } catch { return true; }
  };

  useEffect(() => { configRef.current = config; }, [config]);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 150) + "px";
    }
  }, [inputValue]);

  const addMessage = (msg: Omit<BuildMessage, "timestamp">) => {
    setMessages(prev => [...prev, { ...msg, timestamp: new Date() }]);
  };

  const getAIResponse = async (userMessage: string, currentConfig?: AgentConfig): Promise<{ text: string; preview?: string; files?: { path: string; content: string }[] } | null> => {
    try {
      const canUse = await checkUsage("inference");
      if (!canUse) return null;
      const resp = await apiRequest("POST", "/api/builder/chat", { message: userMessage, config: currentConfig || configRef.current });
      const data = await resp.json();
      if (data.fallback || !data.response) return null;
      return { text: data.response, preview: data.preview, files: data.files };
    } catch { return null; }
  };

  const deployAgent = async () => {
    try {
      addMessage({ role: "build", content: "Deploying to BUILD4 Cloud...", type: "progress" });
      const response = await apiRequest("POST", "/api/web4/agents/create", {
        name: config.name || "Unnamed Agent",
        bio: config.bio || "Built with BUILD4",
        modelType: MODEL_MAP[config.model] || MODEL_MAP.llama,
        initialDeposit: "100000000000000",
        targetChain: CHAIN_MAP[config.chain] || CHAIN_MAP.bnb,
      });
      const agent = await response.json();
      setDeployedAgentId(agent.id);
      setConfig(prev => ({ ...prev, status: "live" }));
      addMessage({
        role: "build",
        content: `Your agent is live!\n\nAgent ID: ${agent.id}\nWallet: ${agent.wallet?.walletAddress || "Generated"}\nChain: ${config.chain === "base" ? "Base" : config.chain === "xlayer" ? "XLayer" : "BNB Chain"}\nStatus: Running\n\nYour agent is now autonomous and executing on-chain.`,
        type: "success",
      });
      toast({ title: "Deployed", description: `${config.name} is live` });
    } catch (error: any) {
      setConfig(prev => ({ ...prev, status: "configuring" }));
      addMessage({ role: "build", content: `Connect your wallet with funds first.\n\n${error.message || "Wallet required"}`, type: "error" });
    }
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputValue.trim() || isProcessing) return;
    const userInput = inputValue.trim();
    setInputValue("");
    addMessage({ role: "user", content: userInput });
    setIsProcessing(true);

    if (isDeployCommand(userInput)) {
      if (!config.type && Object.keys(projectFiles).length === 0) {
        addMessage({ role: "system", content: "Nothing to deploy yet. Tell me what you want to build first.", type: "info" });
        setIsProcessing(false);
        return;
      }
      const canDeploy = await checkUsage("deploy");
      if (!canDeploy) { setIsProcessing(false); return; }
      setConfig(prev => ({ ...prev, status: "building" }));
      addMessage({ role: "build", content: "Starting build pipeline...", type: "progress" });
      const steps = [
        `Loading model: ${config.model === "deepseek" ? "DeepSeek V3" : config.model === "qwen" ? "Qwen 2.5" : "Llama 3.3"}...`,
        `Installing skills: ${config.skills.join(", ")}...`,
        `Connecting to ${config.chain === "base" ? "Base" : config.chain === "xlayer" ? "XLayer" : "BNB Chain"}...`,
        "Generating agent wallet...",
        "Registering on-chain identity (ERC-8004)...",
      ];
      for (const step of steps) {
        await new Promise(r => setTimeout(r, 400 + Math.random() * 500));
        addMessage({ role: "build", content: step, type: "progress" });
      }
      await deployAgent();
      setIsProcessing(false);
      return;
    }

    const configUpdates = extractConfigFromInput(userInput, config);
    let updatedConfig = config;
    const isTemplateMatch = configUpdates?.type ? true : false;
    if (configUpdates) {
      updatedConfig = { ...config, ...configUpdates };
      setConfig(updatedConfig);
      if (isTemplateMatch) {
        setPreviewHtml(generateDefaultPreview(updatedConfig));
      }
    }

    if (!isTemplateMatch) {
      setPreviewHtml(generateLoadingPreview("Generating your project..."));
    }

    const aiResponse = await getAIResponse(userInput, updatedConfig);

    if (aiResponse) {
      addMessage({ role: "system", content: aiResponse.text, type: "info" });
      if (aiResponse.files && aiResponse.files.length > 0) {
        const newFiles: Record<string, string> = { ...projectFiles };
        for (const f of aiResponse.files) newFiles[f.path] = f.content;
        setProjectFiles(newFiles);
        if (!aiResponse.preview) {
          const htmlFile = aiResponse.files.find(f => f.path.endsWith("index.html") || f.path.endsWith(".html"));
          const cssFile = aiResponse.files.find(f => f.path.endsWith(".css"));
          const jsFile = aiResponse.files.find(f => f.path.endsWith(".js"));
          if (htmlFile) {
            let html = htmlFile.content;
            if (cssFile && !html.includes(cssFile.content.substring(0, 30))) html = html.replace("</head>", `<style>${cssFile.content}</style></head>`);
            if (jsFile && !html.includes(jsFile.content.substring(0, 30))) html = html.replace("</body>", `<script>${jsFile.content}</script></body>`);
            aiResponse.preview = html;
          }
        }
      }
      if (aiResponse.preview) setPreviewHtml(aiResponse.preview);
    } else {
      if (configUpdates) {
        const tmpl = configUpdates.type ? TEMPLATES[configUpdates.type] : null;
        if (tmpl) {
          addMessage({ role: "system", content: `${tmpl.icon} ${tmpl.name} configured.\n\nI've set up ${tmpl.skills.join(", ")} skills on ${updatedConfig.chain === "base" ? "Base" : updatedConfig.chain === "xlayer" ? "XLayer" : "BNB Chain"} with ${updatedConfig.model === "deepseek" ? "DeepSeek V3" : updatedConfig.model === "qwen" ? "Qwen 2.5" : "Llama 3.3"}.\n\nYou can customize it further or say **deploy** when ready.`, type: "info" });
        } else {
          const changes: string[] = [];
          if (configUpdates.chain) changes.push(`Chain → ${configUpdates.chain === "base" ? "Base" : configUpdates.chain === "xlayer" ? "XLayer" : "BNB Chain"}`);
          if (configUpdates.model) changes.push(`Model → ${configUpdates.model === "deepseek" ? "DeepSeek V3" : configUpdates.model === "qwen" ? "Qwen 2.5" : "Llama 3.3"}`);
          if (configUpdates.autonomy) changes.push(`Autonomy → ${configUpdates.autonomy}`);
          if (configUpdates.name) changes.push(`Name → ${configUpdates.name}`);
          addMessage({ role: "system", content: `Updated: ${changes.join(", ")}.${config.type ? ' Say **deploy** when ready.' : ""}`, type: "info" });
        }
      } else {
        addMessage({ role: "system", content: `I can help you build that. Try describing what you need:\n\n• "Build a trading bot that snipes new tokens"\n• "Create a DeFi yield optimizer"\n• "I need a security scanner for rug pulls"\n• "Make a social media agent for Twitter"\n\nOr just tell me what you're trying to do.`, type: "info" });
      }
    }

    setIsProcessing(false);
    textareaRef.current?.focus();
  };

  const handleQuickAction = (action: string) => {
    setInputValue(action);
    setTimeout(() => {
      const form = document.getElementById("build-form") as HTMLFormElement;
      form?.requestSubmit();
    }, 50);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const hasMessages = messages.length > 0;
  const codeContent = config.type ? generateAgentCode(config) : "";

  return (
    <>
      <SEO title="Build | BUILD4" description="Build autonomous AI agents with natural language. Just describe what you want." path="/build" />

      <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden" data-testid="page-agent-builder">
        <div className="flex items-center justify-between h-12 border-b px-4 shrink-0">
          <div className="flex items-center gap-3">
            <Link href="/">
              <div className="flex items-center gap-1.5 hover:opacity-80 cursor-pointer transition-opacity" data-testid="button-home">
                <Terminal className="w-4 h-4 text-emerald-500" />
                <span className="font-semibold text-sm">BUILD<span className="text-emerald-500">4</span></span>
              </div>
            </Link>
            {config.name && (
              <>
                <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">{config.name}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {config.status === "live" && (
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-emerald-500/10">
                <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-xs font-medium text-emerald-500">Live</span>
              </div>
            )}
            {config.status === "building" && (
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-amber-500/10">
                <Loader2 className="w-3 h-3 text-amber-500 animate-spin" />
                <span className="text-xs font-medium text-amber-500">Building</span>
              </div>
            )}
            {config.status === "configuring" && (
              <Button size="sm" variant="default" onClick={() => handleQuickAction("deploy")}
                className="h-7 gap-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs"
                data-testid="button-deploy-top">
                <Rocket className="w-3 h-3" /> Deploy
              </Button>
            )}
            {(config.type || Object.keys(projectFiles).length > 0) && (
              <Button size="sm" variant="ghost" onClick={() => setShowCode(!showCode)}
                className="h-7 gap-1 text-xs"
                data-testid="button-toggle-code">
                <Code className="w-3.5 h-3.5" /> {showCode ? "Hide Code" : "Code"}
              </Button>
            )}
            <Link href="/autonomous-economy">
              <Button size="sm" variant="ghost" className="h-7 text-xs" data-testid="button-dashboard">
                Dashboard
              </Button>
            </Link>
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 flex flex-col min-w-0 border-r">
            {!hasMessages ? (
              <div className="flex-1 flex flex-col items-center justify-center px-6">
                <div className="max-w-lg w-full space-y-8">
                  <div className="text-center space-y-3">
                    <div className="w-12 h-12 mx-auto rounded-2xl bg-emerald-500/10 flex items-center justify-center">
                      <Sparkles className="w-6 h-6 text-emerald-500" />
                    </div>
                    <h1 className="text-2xl font-semibold tracking-tight">What do you want to build?</h1>
                    <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                      Describe your idea and I'll create an autonomous AI agent for you. Deploy it on-chain in minutes.
                    </p>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {Object.entries(TEMPLATES).map(([key, tmpl]) => (
                      <button key={key} onClick={() => handleQuickAction(`Build me a ${key} agent`)}
                        className="p-3 rounded-lg border bg-card hover:bg-accent/50 hover:border-emerald-500/30 transition-all text-left group"
                        data-testid={`template-${key}`}>
                        <div className="text-xl mb-1.5">{tmpl.icon}</div>
                        <div className="text-sm font-medium group-hover:text-emerald-500 transition-colors">{tmpl.name.replace(" Agent", "")}</div>
                        <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{tmpl.bio.substring(0, 60)}...</div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4" data-testid="chat-messages">
                {messages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[80%] ${msg.role === "user" ? "" : "flex gap-3"}`}>
                      {msg.role !== "user" && (
                        <div className="w-7 h-7 rounded-full bg-emerald-500/10 flex items-center justify-center shrink-0 mt-0.5">
                          {msg.type === "progress" ? (
                            <Loader2 className="w-3.5 h-3.5 text-emerald-500 animate-spin" />
                          ) : msg.type === "success" ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                          ) : (
                            <Sparkles className="w-3.5 h-3.5 text-emerald-500" />
                          )}
                        </div>
                      )}
                      <div className={`rounded-2xl px-4 py-2.5 ${
                        msg.role === "user"
                          ? "bg-emerald-600 text-white"
                          : msg.type === "error"
                          ? "bg-destructive/10 text-destructive"
                          : "bg-muted"
                      }`} data-testid={`message-${i}`}>
                        <pre className="text-sm whitespace-pre-wrap leading-relaxed font-sans">{msg.content}</pre>
                      </div>
                    </div>
                  </div>
                ))}
                {isProcessing && messages[messages.length - 1]?.role !== "build" && (
                  <div className="flex gap-3">
                    <div className="w-7 h-7 rounded-full bg-emerald-500/10 flex items-center justify-center shrink-0">
                      <Loader2 className="w-3.5 h-3.5 text-emerald-500 animate-spin" />
                    </div>
                    <div className="bg-muted rounded-2xl px-4 py-2.5">
                      <span className="text-sm text-muted-foreground">Thinking...</span>
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>
            )}

            <div className="shrink-0 border-t p-4" data-testid="chat-input-area">
              <form id="build-form" onSubmit={handleSubmit}>
                <div className="relative flex items-end border rounded-xl bg-card p-1">
                  <textarea
                    ref={textareaRef}
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={!hasMessages ? "Describe what you want to build..." : config.status === "configuring" ? "Customize your agent or type 'deploy'..." : "Ask me anything..."}
                    className="flex-1 resize-none border-0 bg-transparent px-3 py-2.5 text-sm focus:outline-none focus:ring-0 placeholder:text-muted-foreground min-h-[40px] max-h-[150px]"
                    disabled={isProcessing}
                    rows={1}
                    data-testid="input-command"
                  />
                  <Button type="submit" size="sm" disabled={isProcessing || !inputValue.trim()}
                    className="m-1 h-8 w-8 p-0 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white shrink-0"
                    data-testid="button-send">
                    {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  </Button>
                </div>
              </form>
              {!hasMessages && (
                <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                  {[
                    { label: "Trading bot", action: "Build a trading agent that snipes new tokens on BNB Chain" },
                    { label: "Security scanner", action: "Build a security agent that detects rug pulls" },
                    { label: "DeFi optimizer", action: "Build a DeFi agent that finds the best yields" },
                    { label: "Twitter agent", action: "Build a social agent for Twitter" },
                  ].map(item => (
                    <button key={item.label} onClick={() => handleQuickAction(item.action)}
                      className="px-3 py-1.5 rounded-full border text-xs text-muted-foreground hover:text-foreground hover:border-emerald-500/50 hover:bg-emerald-500/5 transition-all"
                      data-testid={`suggestion-${item.label.toLowerCase().replace(/\s+/g, "-")}`}>
                      {item.label}
                    </button>
                  ))}
                </div>
              )}
              {config.status === "configuring" && hasMessages && (
                <div className="flex items-center gap-1.5 mt-2">
                  <button onClick={() => handleQuickAction("deploy")}
                    className="px-3 py-1.5 rounded-full bg-emerald-600/10 border border-emerald-500/30 text-xs text-emerald-500 font-medium hover:bg-emerald-600/20 transition-all"
                    data-testid="quick-deploy">
                    <Rocket className="w-3 h-3 inline mr-1" /> Deploy now
                  </button>
                  <button onClick={() => handleQuickAction("use DeepSeek model")}
                    className="px-3 py-1.5 rounded-full border text-xs text-muted-foreground hover:text-foreground transition-all"
                    data-testid="quick-deepseek">
                    DeepSeek
                  </button>
                  <button onClick={() => handleQuickAction("switch to Base chain")}
                    className="px-3 py-1.5 rounded-full border text-xs text-muted-foreground hover:text-foreground transition-all"
                    data-testid="quick-base">
                    Base
                  </button>
                  <button onClick={() => handleQuickAction("set full autonomy")}
                    className="px-3 py-1.5 rounded-full border text-xs text-muted-foreground hover:text-foreground transition-all"
                    data-testid="quick-auto">
                    Full Auto
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="hidden lg:flex flex-col w-[45%] max-w-[600px] min-w-[300px] bg-muted/30">
            {showCode && codeContent ? (
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="flex items-center justify-between px-3 h-10 border-b shrink-0">
                  <div className="flex items-center gap-2">
                    <Code className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-xs font-medium">agent.ts</span>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setShowCode(false)} className="h-6 w-6 p-0">
                    <X className="w-3.5 h-3.5" />
                  </Button>
                </div>
                <div className="flex-1 overflow-auto bg-[#1e1e1e]">
                  <div className="flex min-h-full">
                    <div className="py-3 px-3 text-right select-none shrink-0 border-r border-[#2a2d2e]">
                      {codeContent.split("\n").map((_, i) => (
                        <div key={i} className="font-mono text-[11px] leading-5 text-[#505050]">{i + 1}</div>
                      ))}
                    </div>
                    <pre className="flex-1 py-3 px-4 font-mono text-[11px] leading-5 text-[#d4d4d4] whitespace-pre overflow-x-auto">
                      {codeContent}
                    </pre>
                  </div>
                </div>
              </div>
            ) : previewHtml ? (
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="flex items-center gap-2 px-3 h-10 border-b shrink-0">
                  <div className="flex gap-1">
                    <div className="w-2.5 h-2.5 rounded-full bg-red-400/80" />
                    <div className="w-2.5 h-2.5 rounded-full bg-yellow-400/80" />
                    <div className="w-2.5 h-2.5 rounded-full bg-green-400/80" />
                  </div>
                  <div className="flex-1 mx-2 px-3 py-1 rounded-md bg-muted flex items-center gap-1.5">
                    <Globe className="w-3 h-3 text-muted-foreground shrink-0" />
                    <span className="text-[11px] text-muted-foreground truncate">
                      {config.name ? `${config.name.toLowerCase().replace(/\s+/g, "-")}.build4.io` : "preview.build4.io"}
                    </span>
                  </div>
                  <button onClick={() => { const iframe = document.getElementById("preview-iframe") as HTMLIFrameElement; if (iframe) iframe.srcdoc = iframe.srcdoc; }}
                    className="p-1 hover:bg-accent rounded transition-colors" data-testid="button-refresh-preview">
                    <RotateCcw className="w-3.5 h-3.5 text-muted-foreground" />
                  </button>
                </div>
                <div className="flex-1 bg-white overflow-hidden">
                  <iframe id="preview-iframe" className="w-full h-full border-0" data-testid="preview-iframe" sandbox="allow-scripts" srcDoc={previewHtml} />
                </div>
                {deployedAgentId && (
                  <div className="shrink-0 px-3 py-2 border-t bg-emerald-500/5 flex items-center justify-between">
                    <div>
                      <div className="text-[10px] text-muted-foreground">Agent ID</div>
                      <code className="text-xs text-emerald-500 font-mono">{deployedAgentId.substring(0, 16)}...</code>
                    </div>
                    <div className="flex gap-1.5">
                      <Button size="sm" variant="outline" className="h-7 text-xs" data-testid="button-copy-id"
                        onClick={() => { navigator.clipboard.writeText(deployedAgentId); toast({ title: "Copied" }); }}>
                        Copy ID
                      </Button>
                      <Link href="/autonomous-economy">
                        <Button size="sm" variant="outline" className="h-7 text-xs" data-testid="button-view-agent">
                          View Live
                        </Button>
                      </Link>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
                <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
                  <Monitor className="w-8 h-8 text-muted-foreground/50" />
                </div>
                <h3 className="text-sm font-medium mb-1">Preview</h3>
                <p className="text-xs text-muted-foreground max-w-[200px]">
                  Start building to see a live preview of your agent here
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
