import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { SEO } from "@/components/seo";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useWallet } from "@/hooks/use-wallet";
import {
  Send, Loader2, ArrowUp,
  CheckCircle2, Terminal, Sparkles, ChevronDown,
  Rocket, Globe, Monitor, RotateCcw, X, Code,
} from "lucide-react";

interface BuildMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  type?: "info" | "success" | "error" | "progress";
  preview?: string;
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

const TEMPLATES: Record<string, { name: string; bio: string; skills: string[]; icon: string; prompt: string }> = {
  trading: { name: "Trading Agent", bio: "Autonomous trading agent that monitors markets and executes trades across DEXs", skills: ["Market Scanner", "Signal Detector", "Trade Executor", "Risk Manager"], icon: "📈", prompt: "Build me a trading agent" },
  research: { name: "Research Agent", bio: "Deep analysis agent that researches tokens and on-chain data", skills: ["Token Analyzer", "Contract Auditor", "Whale Tracker", "Report Generator"], icon: "🔍", prompt: "Build me a research agent" },
  social: { name: "Social Agent", bio: "Content creation and engagement agent for Twitter/X and Telegram", skills: ["Content Writer", "Trend Monitor", "Community Manager", "Engagement Bot"], icon: "💬", prompt: "Build me a social media agent" },
  defi: { name: "DeFi Agent", bio: "Yield optimization agent that finds the best farming opportunities", skills: ["Yield Scanner", "LP Manager", "Auto Compounder", "Gas Optimizer"], icon: "🏦", prompt: "Build me a DeFi yield agent" },
  security: { name: "Security Agent", bio: "Contract security scanner that audits tokens and detects rug pulls", skills: ["Contract Scanner", "Honeypot Detector", "Rug Analyzer", "Wallet Monitor"], icon: "🛡️", prompt: "Build me a security agent" },
  sniper: { name: "Sniper Agent", bio: "Ultra-fast token sniper that detects new launches and executes buys", skills: ["Launch Detector", "Fast Executor", "Liquidity Checker", "Exit Planner"], icon: "🎯", prompt: "Build me a sniper agent" },
};

const CHAIN_MAP: Record<string, string> = { bnb: "bnbMainnet", base: "baseMainnet", xlayer: "xlayerMainnet" };
const MODEL_MAP: Record<string, string> = { llama: "meta-llama/Llama-3.3-70B-Instruct", deepseek: "deepseek-ai/DeepSeek-V3", qwen: "Qwen/Qwen2.5-72B-Instruct" };

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

function generatePreviewHtml(config: AgentConfig): string {
  const skills = config.skills.length > 0 ? config.skills : ["monitoring", "execution"];
  const chainName = config.chain === "base" ? "Base" : config.chain === "xlayer" ? "XLayer" : "BNB Chain";
  const modelName = config.model === "deepseek" ? "DeepSeek V3" : config.model === "qwen" ? "Qwen 2.5" : "Llama 3.3";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0f;color:#e0e0e0;min-height:100vh;display:flex;flex-direction:column}
.header{background:linear-gradient(135deg,#0d1117,#161b22);border-bottom:1px solid #21262d;padding:14px 20px;display:flex;align-items:center;gap:10px}
.header .dot{width:8px;height:8px;border-radius:50%;background:#10b981;animation:pulse 2s infinite}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.header h1{font-size:15px;font-weight:700;color:#fff}.header .badge{font-size:9px;padding:3px 8px;border-radius:6px;background:#10b98120;color:#10b981;text-transform:uppercase;letter-spacing:.5px}
.content{flex:1;padding:20px;display:flex;flex-direction:column;gap:16px}
.card{background:#161b22;border:1px solid #21262d;border-radius:10px;padding:16px}
.card-title{font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px}
.stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.stat{background:#0d1117;border-radius:8px;padding:10px}
.stat-value{font-size:18px;font-weight:700;color:#fff}.stat-label{font-size:10px;color:#8b949e;margin-top:3px}
.skill-list{display:flex;flex-wrap:wrap;gap:6px}.skill{font-size:10px;padding:4px 10px;border-radius:6px;background:#10b98115;color:#10b981;border:1px solid #10b98130}
.chart{height:70px;background:#0d1117;border-radius:8px;display:flex;align-items:end;padding:6px;gap:2px}
.bar{flex:1;background:linear-gradient(to top,#10b981,#10b98160);border-radius:3px 3px 0 0;animation:grow .8s ease-out}@keyframes grow{from{height:0}}
.status-bar{background:#10b981;padding:8px 20px;display:flex;justify-content:space-between;font-size:10px;color:#fff;font-weight:600}
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

export default function AgentBuilder() {
  const { address, connected: isConnected, signer } = useWallet();
  const [messages, setMessages] = useState<BuildMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [config, setConfig] = useState<AgentConfig>({
    name: "", bio: "", type: "", chain: "bnb", model: "llama", skills: [], autonomy: "semi", status: "idle",
  });
  const [isProcessing, setIsProcessing] = useState(false);
  const [deployedAgentId, setDeployedAgentId] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [previewHtml, setPreviewHtml] = useState("");
  const [projectFiles, setProjectFiles] = useState<Record<string, string>>({});
  const chatEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const configRef = useRef(config);
  const { toast } = useToast();

  useEffect(() => { configRef.current = config; }, [config]);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "24px";
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + "px";
    }
  }, [inputValue]);

  const addMessage = (msg: Omit<BuildMessage, "timestamp">) => {
    setMessages(prev => [...prev, { ...msg, timestamp: new Date() }]);
  };

  const getAIResponse = async (userMessage: string, currentConfig?: AgentConfig): Promise<{ text: string; preview?: string; files?: { path: string; content: string }[] } | null> => {
    try {
      const resp = await apiRequest("POST", "/api/builder/chat", { message: userMessage, config: currentConfig || configRef.current });
      const data = await resp.json();
      if (data.fallback || !data.response) return null;
      return { text: data.response, preview: data.preview, files: data.files };
    } catch { return null; }
  };

  const deployAgent = async () => {
    try {
      addMessage({ role: "assistant", content: "Deploying to BUILD4 Cloud...", type: "progress" });
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
      const chainName = config.chain === "base" ? "Base" : config.chain === "xlayer" ? "XLayer" : "BNB Chain";
      addMessage({
        role: "assistant",
        content: `Your agent is live!\n\nAgent ID: ${agent.id}\nWallet: ${agent.wallet?.walletAddress || "Generated"}\nChain: ${chainName}\nStatus: Running\n\nYour agent is now autonomous and operating on-chain.`,
        type: "success",
      });
      toast({ title: "Deployed", description: `${config.name} is live` });
    } catch (error: any) {
      setConfig(prev => ({ ...prev, status: "configuring" }));
      addMessage({ role: "assistant", content: `Connect your wallet with BNB to deploy.\n\n${error.message || "Wallet required"}`, type: "error" });
    }
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputValue.trim() || isProcessing) return;
    const userInput = inputValue.trim();
    setInputValue("");
    if (textareaRef.current) textareaRef.current.style.height = "24px";
    addMessage({ role: "user", content: userInput });
    setIsProcessing(true);

    if (isDeployCommand(userInput)) {
      if (!config.type && Object.keys(projectFiles).length === 0) {
        addMessage({ role: "assistant", content: "Nothing to deploy yet. Tell me what you want to build first." });
        setIsProcessing(false);
        return;
      }
      setConfig(prev => ({ ...prev, status: "building" }));
      const chainName = config.chain === "base" ? "Base" : config.chain === "xlayer" ? "XLayer" : "BNB Chain";
      const modelName = config.model === "deepseek" ? "DeepSeek V3" : config.model === "qwen" ? "Qwen 2.5" : "Llama 3.3";
      addMessage({ role: "assistant", content: `Starting deployment...\n\nLoading ${modelName}...\nInstalling skills: ${config.skills.join(", ")}...\nConnecting to ${chainName}...\nGenerating wallet...\nRegistering on-chain identity (ERC-8004)...`, type: "progress" });
      await new Promise(r => setTimeout(r, 2000));
      await deployAgent();
      setIsProcessing(false);
      return;
    }

    const configUpdates = extractConfigFromInput(userInput, config);

    if (configUpdates) {
      const updatedConfig = { ...config, ...configUpdates };
      setConfig(updatedConfig);
      const isTemplateMatch = !!configUpdates.type;

      if (isTemplateMatch) {
        const tmpl = TEMPLATES[configUpdates.type!];
        const chainName = updatedConfig.chain === "base" ? "Base" : updatedConfig.chain === "xlayer" ? "XLayer" : "BNB Chain";
        const modelName = updatedConfig.model === "deepseek" ? "DeepSeek V3" : updatedConfig.model === "qwen" ? "Qwen 2.5" : "Llama 3.3";
        setPreviewHtml(generatePreviewHtml(updatedConfig));
        setShowPreview(true);
        addMessage({
          role: "assistant",
          content: `${tmpl.icon} **${tmpl.name}** is ready.\n\n${tmpl.bio}\n\nSkills: ${tmpl.skills.join(", ")}\nChain: ${chainName}\nModel: ${modelName}\nAutonomy: Semi-Auto\n\nCustomize anything or say **deploy** when ready.`,
          type: "success",
        });
      } else {
        const changes: string[] = [];
        if (configUpdates.chain) changes.push(`Chain → ${configUpdates.chain === "base" ? "Base" : configUpdates.chain === "xlayer" ? "XLayer" : "BNB Chain"}`);
        if (configUpdates.model) changes.push(`Model → ${configUpdates.model === "deepseek" ? "DeepSeek V3" : configUpdates.model === "qwen" ? "Qwen 2.5" : "Llama 3.3"}`);
        if (configUpdates.autonomy) changes.push(`Autonomy → ${configUpdates.autonomy === "full" ? "Full Auto" : configUpdates.autonomy === "supervised" ? "Supervised" : "Semi-Auto"}`);
        if (configUpdates.name) changes.push(`Name → ${configUpdates.name}`);
        if (configUpdates.skills && configUpdates.skills.length > config.skills.length) changes.push("Skill added");
        setPreviewHtml(generatePreviewHtml(updatedConfig));
        addMessage({ role: "assistant", content: `Updated: ${changes.join(", ")}.${updatedConfig.type ? ' Say **deploy** when ready.' : ""}` });
      }
      setIsProcessing(false);
      textareaRef.current?.focus();
      return;
    }

    const aiResponse = await getAIResponse(userInput, config);

    if (aiResponse) {
      let preview = aiResponse.preview;
      if (aiResponse.files && aiResponse.files.length > 0) {
        const newFiles: Record<string, string> = { ...projectFiles };
        for (const f of aiResponse.files) newFiles[f.path] = f.content;
        setProjectFiles(newFiles);
        if (!preview) {
          const htmlFile = aiResponse.files.find(f => f.path.endsWith(".html"));
          const cssFile = aiResponse.files.find(f => f.path.endsWith(".css"));
          const jsFile = aiResponse.files.find(f => f.path.endsWith(".js"));
          if (htmlFile) {
            let html = htmlFile.content;
            if (cssFile) html = html.replace("</head>", `<style>${cssFile.content}</style></head>`);
            if (jsFile) html = html.replace("</body>", `<script>${jsFile.content}</script></body>`);
            preview = html;
          }
        }
      }
      if (preview) {
        setPreviewHtml(preview);
        setShowPreview(true);
      }
      addMessage({ role: "assistant", content: aiResponse.text, preview });
    } else {
      addMessage({ role: "assistant", content: "I can help you build that. Try telling me what kind of agent you need — a trading bot, security scanner, DeFi optimizer, or describe your own idea." });
    }

    setIsProcessing(false);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleSuggestion = (text: string) => {
    setInputValue(text);
    setTimeout(() => {
      const form = document.getElementById("chat-form") as HTMLFormElement;
      form?.requestSubmit();
    }, 30);
  };

  const hasMessages = messages.length > 0;

  function renderContent(text: string) {
    return text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }

  return (
    <>
      <SEO title="Build | BUILD4" description="Build autonomous AI agents with natural language." path="/build" />

      <div className="h-screen flex flex-col bg-background" data-testid="page-agent-builder">
        <div className="flex-1 flex overflow-hidden">

          <div className={`flex-1 flex flex-col min-w-0 ${showPreview ? "border-r border-border" : ""}`}>

            <div className="flex-1 overflow-y-auto" data-testid="chat-area">
              {!hasMessages ? (
                <div className="h-full flex flex-col items-center justify-center px-4">
                  <div className="max-w-[540px] w-full">
                    <div className="mb-10 text-center">
                      <h1 className="text-[28px] font-semibold text-foreground tracking-tight mb-2" data-testid="welcome-heading">What do you want to build?</h1>
                      <p className="text-[15px] text-muted-foreground">Describe your agent and I'll set it up. Deploy on-chain in minutes.</p>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5 mb-6">
                      {Object.entries(TEMPLATES).map(([key, tmpl]) => (
                        <button key={key} onClick={() => handleSuggestion(tmpl.prompt)}
                          className="flex items-start gap-3 p-3.5 rounded-xl border border-border bg-card hover:bg-accent/60 transition-colors text-left group"
                          data-testid={`template-${key}`}>
                          <span className="text-xl mt-0.5 shrink-0">{tmpl.icon}</span>
                          <div className="min-w-0">
                            <div className="text-[13px] font-medium text-foreground group-hover:text-primary transition-colors">{tmpl.name}</div>
                            <div className="text-[12px] text-muted-foreground mt-0.5 line-clamp-1">{tmpl.bio}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="max-w-[700px] mx-auto px-4 py-6 space-y-5" data-testid="chat-messages">
                  {messages.map((msg, i) => (
                    <div key={i} className={msg.role === "user" ? "flex justify-end" : ""} data-testid={`message-${i}`}>
                      {msg.role === "user" ? (
                        <div className="max-w-[85%] rounded-2xl bg-secondary px-4 py-2.5">
                          <p className="text-[14px] text-foreground leading-relaxed">{msg.content}</p>
                        </div>
                      ) : (
                        <div className="flex gap-3 max-w-full">
                          <div className="w-6 h-6 rounded-full bg-primary/15 flex items-center justify-center shrink-0 mt-1">
                            {msg.type === "progress" ? (
                              <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />
                            ) : msg.type === "success" ? (
                              <CheckCircle2 className="w-3.5 h-3.5 text-primary" />
                            ) : msg.type === "error" ? (
                              <X className="w-3.5 h-3.5 text-destructive" />
                            ) : (
                              <Terminal className="w-3.5 h-3.5 text-primary" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1 pt-0.5">
                            <div
                              className={`text-[14px] leading-relaxed whitespace-pre-wrap ${msg.type === "error" ? "text-destructive" : "text-foreground"}`}
                              dangerouslySetInnerHTML={{ __html: renderContent(msg.content) }}
                            />
                            {msg.type === "success" && config.status === "configuring" && (
                              <div className="flex gap-2 mt-3 flex-wrap">
                                <button onClick={() => handleSuggestion("deploy")}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-[12px] font-medium hover:opacity-90 transition-opacity"
                                  data-testid="inline-deploy">
                                  <Rocket className="w-3 h-3" /> Deploy now — $20
                                </button>
                                <button onClick={() => handleSuggestion("switch to Base chain")}
                                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border text-[12px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                                  data-testid="inline-base">Base chain</button>
                                <button onClick={() => handleSuggestion("use DeepSeek model")}
                                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border text-[12px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                                  data-testid="inline-deepseek">DeepSeek</button>
                                <button onClick={() => handleSuggestion("set full autonomy")}
                                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border text-[12px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                                  data-testid="inline-auto">Full Auto</button>
                              </div>
                            )}
                            {deployedAgentId && msg.type === "success" && config.status === "live" && (
                              <div className="flex gap-2 mt-3">
                                <button onClick={() => { navigator.clipboard.writeText(deployedAgentId); toast({ title: "Copied" }); }}
                                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border text-[12px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                                  data-testid="button-copy-id">Copy Agent ID</button>
                                <Link href="/autonomous-economy">
                                  <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border text-[12px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
                                    data-testid="button-view-agent">View Dashboard</span>
                                </Link>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                  {isProcessing && messages[messages.length - 1]?.type !== "progress" && (
                    <div className="flex gap-3">
                      <div className="w-6 h-6 rounded-full bg-primary/15 flex items-center justify-center shrink-0 mt-1">
                        <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />
                      </div>
                      <div className="pt-1">
                        <div className="flex gap-1">
                          <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: "0ms" }} />
                          <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: "150ms" }} />
                          <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: "300ms" }} />
                        </div>
                      </div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>
              )}
            </div>

            <div className="shrink-0 px-4 pb-4 pt-2" data-testid="chat-input-area">
              <div className="max-w-[700px] mx-auto">
                <form id="chat-form" onSubmit={handleSubmit}>
                  <div className="relative border border-border rounded-2xl bg-card focus-within:border-primary/40 transition-colors">
                    <textarea
                      ref={textareaRef}
                      value={inputValue}
                      onChange={(e) => setInputValue(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder={!hasMessages ? "Describe what you want to build..." : "Message BUILD4..."}
                      className="w-full resize-none bg-transparent pl-4 pr-12 py-3 text-[14px] text-foreground placeholder:text-muted-foreground focus:outline-none"
                      disabled={isProcessing}
                      rows={1}
                      style={{ minHeight: "24px", maxHeight: "200px" }}
                      data-testid="input-command"
                    />
                    <button type="submit" disabled={isProcessing || !inputValue.trim()}
                      className="absolute right-2 bottom-2 w-8 h-8 rounded-lg bg-primary text-primary-foreground flex items-center justify-center disabled:opacity-30 hover:opacity-90 transition-opacity"
                      data-testid="button-send">
                      {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUp className="w-4 h-4" />}
                    </button>
                  </div>
                </form>
                {!hasMessages && (
                  <div className="flex items-center justify-center gap-2 mt-3 flex-wrap">
                    {[
                      "Build a trading bot",
                      "Create a security scanner",
                      "DeFi yield optimizer",
                      "Twitter engagement agent",
                    ].map(s => (
                      <button key={s} onClick={() => handleSuggestion(s)}
                        className="px-3 py-1.5 rounded-full border border-border text-[12px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                        data-testid={`suggestion-${s.toLowerCase().replace(/\s+/g, "-")}`}>
                        {s}
                      </button>
                    ))}
                  </div>
                )}
                <div className="text-center mt-2">
                  <span className="text-[11px] text-muted-foreground/50">BUILD4 can make mistakes. Agents cost $20 to deploy.</span>
                </div>
              </div>
            </div>
          </div>

          {showPreview && previewHtml && (
            <div className="hidden lg:flex flex-col w-[42%] max-w-[550px] min-w-[280px]">
              <div className="flex items-center justify-between px-3 h-10 border-b border-border shrink-0">
                <div className="flex items-center gap-2">
                  <div className="flex gap-1">
                    <div className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]/70" />
                    <div className="w-2.5 h-2.5 rounded-full bg-[#febc2e]/70" />
                    <div className="w-2.5 h-2.5 rounded-full bg-[#28c840]/70" />
                  </div>
                  <div className="flex-1 ml-2 px-3 py-1 rounded-md bg-muted/50 flex items-center gap-1.5">
                    <Globe className="w-3 h-3 text-muted-foreground shrink-0" />
                    <span className="text-[11px] text-muted-foreground truncate">
                      {config.name ? `${config.name.toLowerCase().replace(/\s+/g, "-")}.build4.io` : "preview.build4.io"}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => { const iframe = document.getElementById("preview-iframe") as HTMLIFrameElement; if (iframe) iframe.srcdoc = iframe.srcdoc; }}
                    className="p-1 hover:bg-accent rounded transition-colors" data-testid="button-refresh-preview">
                    <RotateCcw className="w-3.5 h-3.5 text-muted-foreground" />
                  </button>
                  <button onClick={() => setShowPreview(false)}
                    className="p-1 hover:bg-accent rounded transition-colors" data-testid="button-close-preview">
                    <X className="w-3.5 h-3.5 text-muted-foreground" />
                  </button>
                </div>
              </div>
              <div className="flex-1 bg-white overflow-hidden">
                <iframe id="preview-iframe" className="w-full h-full border-0" data-testid="preview-iframe" sandbox="allow-scripts" srcDoc={previewHtml} />
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
