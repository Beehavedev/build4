import { useState, useRef, useEffect } from "react";
import { Link } from "wouter";
import { SEO } from "@/components/seo";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useWallet } from "@/hooks/use-wallet";
import {
  Loader2, ArrowUp, CheckCircle2, Terminal, X,
  Rocket, Shield,
  TrendingUp, Search, MessageSquare, Landmark, Target,
  ChevronRight, ExternalLink, Copy, RefreshCw, Plus,
  Settings2, RotateCcw,
} from "lucide-react";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  agentCard?: AgentConfig;
  isDeploying?: boolean;
  deployResult?: DeployResultData;
  isError?: boolean;
}

interface DeployResultData {
  agentId: string;
  wallet: string;
  chain: string;
  name: string;
}

interface AgentConfig {
  name: string;
  bio: string;
  type: string;
  chain: string;
  model: string;
  skills: string[];
  autonomy: string;
}

const AGENT_TYPES: Record<string, { name: string; bio: string; skills: string[]; icon: typeof TrendingUp; color: string; prompt: string }> = {
  trading: { name: "Trading Agent", bio: "Monitors markets, detects signals, and executes trades autonomously across DEXs", skills: ["Market Scanner", "Signal Detector", "Trade Executor", "Risk Manager"], icon: TrendingUp, color: "emerald", prompt: "Build me a trading agent" },
  research: { name: "Research Agent", bio: "Analyzes tokens, audits contracts, tracks whales, and generates actionable reports", skills: ["Token Analyzer", "Contract Auditor", "Whale Tracker", "Report Generator"], icon: Search, color: "violet", prompt: "Build me a research agent" },
  social: { name: "Social Agent", bio: "Creates content, monitors trends, and manages community engagement on X and Telegram", skills: ["Content Writer", "Trend Monitor", "Community Manager", "Engagement Bot"], icon: MessageSquare, color: "blue", prompt: "Build me a social media agent" },
  defi: { name: "DeFi Agent", bio: "Finds optimal yields, manages liquidity positions, and auto-compounds returns", skills: ["Yield Scanner", "LP Manager", "Auto Compounder", "Gas Optimizer"], icon: Landmark, color: "amber", prompt: "Build me a DeFi yield agent" },
  security: { name: "Security Agent", bio: "Scans contracts for vulnerabilities, detects honeypots and rug pulls in real-time", skills: ["Contract Scanner", "Honeypot Detector", "Rug Analyzer", "Wallet Monitor"], icon: Shield, color: "red", prompt: "Build me a security agent" },
  sniper: { name: "Sniper Agent", bio: "Detects new token launches and executes buys within milliseconds of liquidity being added", skills: ["Launch Detector", "Fast Executor", "Liquidity Checker", "Exit Planner"], icon: Target, color: "pink", prompt: "Build me a sniper agent" },
};

const CHAIN_MAP: Record<string, string> = { bnb: "bnbMainnet", base: "baseMainnet", xlayer: "xlayerMainnet" };
const MODEL_MAP: Record<string, string> = { llama: "meta-llama/Llama-3.3-70B-Instruct", deepseek: "deepseek-ai/DeepSeek-V3", qwen: "Qwen/Qwen2.5-72B-Instruct" };
const CHAIN_LABEL: Record<string, string> = { bnb: "BNB Chain", base: "Base", xlayer: "XLayer" };
const MODEL_LABEL: Record<string, string> = { llama: "Llama 3.3 70B", deepseek: "DeepSeek V3", qwen: "Qwen 2.5 72B" };
const AUTONOMY_LABEL: Record<string, string> = { semi: "Semi-Auto", full: "Full Auto", supervised: "Supervised" };

const EMPTY_CONFIG: AgentConfig = { name: "", bio: "", type: "", chain: "bnb", model: "llama", skills: [], autonomy: "semi" };

function extractConfig(input: string, current: AgentConfig): Partial<AgentConfig> | null {
  const lower = input.toLowerCase().trim();
  const updates: Partial<AgentConfig> = {};
  let matched = false;

  for (const [key, t] of Object.entries(AGENT_TYPES)) {
    if (lower.includes(key) || lower.includes(t.name.toLowerCase().replace(" agent", ""))) {
      Object.assign(updates, { type: key, name: t.name, bio: t.bio, skills: [...t.skills] });
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

  return matched ? updates : null;
}

function isDeployCmd(input: string): boolean {
  const l = input.toLowerCase().trim();
  return ["deploy", "launch", "build it", "create it", "ship it", "go", "deploy it", "let's go", "deploy now"].some(c => l === c || l.startsWith(c));
}

function isStartOverCmd(input: string): boolean {
  const l = input.toLowerCase().trim();
  return ["start over", "new agent", "build another", "reset", "start fresh", "new project", "clear"].some(c => l === c || l.includes(c));
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function AgentCard({ config, onDeploy, onUpdate, deploying, deployed }: {
  config: AgentConfig;
  onDeploy: () => void;
  onUpdate: (field: string, value: string) => void;
  deploying: boolean;
  deployed: boolean;
}) {
  const typeData = AGENT_TYPES[config.type];
  if (!typeData) return null;
  const Icon = typeData.icon;

  return (
    <div className="mt-3 rounded-xl border border-border bg-card overflow-hidden" data-testid="agent-card">
      <div className="p-4 border-b border-border">
        <div className="flex items-start gap-3">
          <div className={`w-10 h-10 rounded-xl bg-${typeData.color}-500/15 flex items-center justify-center shrink-0`}>
            <Icon className={`w-5 h-5 text-${typeData.color}-500`} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-[15px] font-semibold text-foreground" data-testid="agent-name">{config.name}</h3>
              {deployed ? (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/10 text-emerald-500">Deployed</span>
              ) : (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary">Ready</span>
              )}
            </div>
            <p className="text-[13px] text-muted-foreground mt-0.5">{config.bio}</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 divide-x divide-border border-b border-border">
        <div className="p-3 text-center">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Chain</div>
          <button onClick={() => {
            const chains = ["bnb", "base", "xlayer"];
            const next = chains[(chains.indexOf(config.chain) + 1) % chains.length];
            onUpdate("chain", next);
          }} className="text-[13px] font-medium text-foreground hover:text-primary transition-colors cursor-pointer" data-testid="toggle-chain">
            {CHAIN_LABEL[config.chain]} <ChevronRight className="w-3 h-3 inline text-muted-foreground" />
          </button>
        </div>
        <div className="p-3 text-center">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Model</div>
          <button onClick={() => {
            const models = ["llama", "deepseek", "qwen"];
            const next = models[(models.indexOf(config.model) + 1) % models.length];
            onUpdate("model", next);
          }} className="text-[13px] font-medium text-foreground hover:text-primary transition-colors cursor-pointer" data-testid="toggle-model">
            {MODEL_LABEL[config.model].split(" ")[0]} <ChevronRight className="w-3 h-3 inline text-muted-foreground" />
          </button>
        </div>
        <div className="p-3 text-center">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Autonomy</div>
          <button onClick={() => {
            const modes = ["semi", "full", "supervised"];
            const next = modes[(modes.indexOf(config.autonomy) + 1) % modes.length];
            onUpdate("autonomy", next);
          }} className="text-[13px] font-medium text-foreground hover:text-primary transition-colors cursor-pointer" data-testid="toggle-autonomy">
            {AUTONOMY_LABEL[config.autonomy]} <ChevronRight className="w-3 h-3 inline text-muted-foreground" />
          </button>
        </div>
      </div>

      <div className="p-3 border-b border-border">
        <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">Skills</div>
        <div className="flex flex-wrap gap-1.5">
          {config.skills.map(s => (
            <span key={s} className="px-2 py-1 rounded-md bg-muted text-[11px] font-medium text-foreground">{s}</span>
          ))}
        </div>
      </div>

      {!deployed && (
        <div className="p-3 flex items-center gap-2">
          <button onClick={onDeploy} disabled={deploying}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg bg-primary text-primary-foreground text-[13px] font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
            data-testid="button-deploy">
            {deploying ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Deploying...</>
            ) : (
              <><Rocket className="w-4 h-4" /> Deploy Agent — $20</>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

function DeployResultCard({ result, onCopy, onBuildAnother }: {
  result: DeployResultData;
  onCopy: (text: string) => void;
  onBuildAnother: () => void;
}) {
  const agentIdDisplay = result.agentId ? result.agentId.substring(0, Math.min(24, result.agentId.length)) : "—";
  const walletDisplay = result.wallet ? result.wallet.substring(0, Math.min(20, result.wallet.length)) : "—";
  return (
    <div className="mt-3 rounded-xl border border-primary/30 bg-primary/5 overflow-hidden" data-testid="deploy-result">
      <div className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
            <CheckCircle2 className="w-4 h-4 text-primary" />
          </div>
          <div>
            <div className="text-[14px] font-semibold text-foreground">{result.name || "Agent"} is Live</div>
            <div className="text-[12px] text-muted-foreground">Running on {result.chain}</div>
          </div>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between p-2.5 rounded-lg bg-background/60">
            <div className="min-w-0 flex-1">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Agent ID</div>
              <code className="text-[12px] text-foreground font-mono">{agentIdDisplay}{result.agentId && result.agentId.length > 24 ? "..." : ""}</code>
            </div>
            <button onClick={() => onCopy(result.agentId || "")}
              className="p-1.5 rounded hover:bg-accent transition-colors" data-testid="button-copy-id">
              <Copy className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          </div>
          <div className="flex items-center justify-between p-2.5 rounded-lg bg-background/60">
            <div className="min-w-0 flex-1">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Wallet</div>
              <code className="text-[12px] text-foreground font-mono">{walletDisplay}{result.wallet && result.wallet.length > 20 ? "..." : ""}</code>
            </div>
            <button onClick={() => onCopy(result.wallet || "")}
              className="p-1.5 rounded hover:bg-accent transition-colors" data-testid="button-copy-wallet">
              <Copy className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          </div>
        </div>
        <div className="flex gap-2 mt-3">
          <Link href="/autonomous-economy">
            <span className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-[12px] font-medium hover:opacity-90 transition-opacity cursor-pointer"
              data-testid="button-view-agent">
              <ExternalLink className="w-3 h-3" /> View Dashboard
            </span>
          </Link>
          <button onClick={onBuildAnother}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-[12px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            data-testid="button-build-another">
            <Plus className="w-3 h-3" /> Build Another
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AgentBuilder() {
  const { address, connected: isConnected, signer } = useWallet();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [config, setConfig] = useState<AgentConfig>({ ...EMPTY_CONFIG });
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDeploying, setIsDeploying] = useState(false);
  const [deployed, setDeployed] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { toast } = useToast();

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "24px";
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + "px";
    }
  }, [inputValue]);

  const addMsg = (role: "user" | "assistant", content: string, extra?: Partial<ChatMessage>) => {
    setMessages(prev => [...prev, { id: uid(), role, content, timestamp: new Date(), ...extra }]);
  };

  const updateConfigField = (field: string, value: string) => {
    setConfig(prev => {
      const updated = { ...prev, [field]: value };
      setMessages(msgs => msgs.map(m => m.agentCard ? { ...m, agentCard: updated } : m));
      return updated;
    });
  };

  const startNew = () => {
    setConfig({ ...EMPTY_CONFIG });
    setDeployed(false);
    addMsg("assistant", "Starting fresh. What do you want to build next?");
    textareaRef.current?.focus();
  };

  const handleDeploy = async () => {
    if (isDeploying) return;
    setIsDeploying(true);
    addMsg("assistant", "Deploying your agent on-chain...", { isDeploying: true });

    try {
      const response = await apiRequest("POST", "/api/web4/agents/create", {
        name: config.name || "Unnamed Agent",
        bio: config.bio || "Built with BUILD4",
        modelType: MODEL_MAP[config.model] || MODEL_MAP.llama,
        initialDeposit: "100000000000000",
        targetChain: CHAIN_MAP[config.chain] || CHAIN_MAP.bnb,
      });
      const agent = await response.json();
      const chainName = CHAIN_LABEL[config.chain] || "BNB Chain";
      setDeployed(true);
      setMessages(msgs => msgs.map(m => m.agentCard ? { ...m, agentCard: { ...m.agentCard! } } : m));
      addMsg("assistant", "Your agent is live and operating autonomously. You can keep tweaking the settings above, build another agent, or view it on the dashboard.", {
        deployResult: { agentId: agent.id, wallet: agent.wallet?.walletAddress || "Generated", chain: chainName, name: config.name },
      });
      toast({ title: "Deployed", description: `${config.name} is live on ${chainName}` });
    } catch (error: any) {
      addMsg("assistant", `Deployment failed. Connect your wallet with BNB to cover the $20 fee.\n\n${error.message || ""}`, { isError: true });
    }
    setIsDeploying(false);
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputValue.trim() || isProcessing) return;
    const userInput = inputValue.trim();
    setInputValue("");
    if (textareaRef.current) textareaRef.current.style.height = "24px";
    addMsg("user", userInput);
    setIsProcessing(true);

    if (isStartOverCmd(userInput)) {
      startNew();
      setIsProcessing(false);
      return;
    }

    if (isDeployCmd(userInput)) {
      if (!config.type) {
        addMsg("assistant", "Nothing to deploy yet. Tell me what kind of agent you want — trading, research, social, DeFi, security, or sniper.");
      } else {
        await handleDeploy();
      }
      setIsProcessing(false);
      return;
    }

    const configUpdates = extractConfig(userInput, config);

    if (configUpdates) {
      const isNewAgent = !!configUpdates.type;
      if (isNewAgent && deployed) {
        setDeployed(false);
      }
      const updated = { ...(isNewAgent ? EMPTY_CONFIG : config), ...configUpdates };
      setConfig(updated);

      if (isNewAgent) {
        const t = AGENT_TYPES[configUpdates.type!];
        addMsg("assistant", `I've configured a **${t.name}** for you. Tap any setting on the card to change it, then hit Deploy when you're ready.`, { agentCard: updated });
      } else {
        const changes: string[] = [];
        if (configUpdates.chain) changes.push(`chain to **${CHAIN_LABEL[configUpdates.chain]}**`);
        if (configUpdates.model) changes.push(`model to **${MODEL_LABEL[configUpdates.model]}**`);
        if (configUpdates.autonomy) changes.push(`autonomy to **${AUTONOMY_LABEL[configUpdates.autonomy]}**`);
        if (configUpdates.name) changes.push(`name to **${configUpdates.name}**`);
        setMessages(msgs => msgs.map(m => m.agentCard ? { ...m, agentCard: updated } : m));
        addMsg("assistant", `Updated ${changes.join(" and ")}. The agent card above has been refreshed.`);
      }
    } else {
      try {
        const resp = await apiRequest("POST", "/api/builder/chat", { message: userInput, config });
        const data = await resp.json();
        if (data.response && !data.fallback) {
          let text = data.response;
          text = text.replace(/<FILES>[\s\S]*<\/FILES>/i, "").replace(/<PREVIEW>[\s\S]*<\/PREVIEW>/i, "").replace(/<FILE[\s\S]*?<\/FILE>/gi, "").trim();
          addMsg("assistant", text || "I've processed your request. What would you like to adjust?");
        } else {
          addMsg("assistant", "I can help you build agents. Tell me what kind you need — trading, research, social, DeFi, security, or sniper — or describe your own idea.");
        }
      } catch {
        addMsg("assistant", "Tell me what kind of agent you want to build. Try \"Build me a trading agent\" or \"I need a sniper bot\".");
      }
    }

    setIsProcessing(false);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  };

  const sendPrompt = (text: string) => {
    setInputValue(text);
    setTimeout(() => (document.getElementById("chat-form") as HTMLFormElement)?.requestSubmit(), 30);
  };

  const hasMessages = messages.length > 0;

  const placeholder = !hasMessages
    ? "Describe what you want to build..."
    : deployed
    ? "Tweak your agent, build another, or ask anything..."
    : config.type
    ? "Customize your agent or say 'deploy'..."
    : "Message BUILD4...";

  return (
    <>
      <SEO title="Build | BUILD4" description="Build autonomous AI agents with natural language." path="/build" />

      <div className="h-screen flex flex-col bg-background" data-testid="page-agent-builder">
        <div className="flex-1 overflow-y-auto" data-testid="chat-area">
          {!hasMessages ? (
            <div className="h-full flex flex-col items-center justify-center px-4">
              <div className="max-w-[520px] w-full">
                <div className="mb-8 text-center">
                  <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-[12px] font-medium mb-4">
                    <Terminal className="w-3.5 h-3.5" /> BUILD4 Agent Builder
                  </div>
                  <h1 className="text-[26px] font-semibold text-foreground tracking-tight mb-2" data-testid="welcome-heading">What do you want to build?</h1>
                  <p className="text-[14px] text-muted-foreground leading-relaxed">Describe your agent. I'll configure it, you review, then deploy on-chain for $20.</p>
                </div>

                <div className="grid grid-cols-2 gap-2 mb-4">
                  {Object.entries(AGENT_TYPES).map(([key, t]) => {
                    const Icon = t.icon;
                    return (
                      <button key={key} onClick={() => sendPrompt(t.prompt)}
                        className="flex items-center gap-2.5 p-3 rounded-xl border border-border bg-card hover:bg-accent/40 hover:border-primary/20 transition-all text-left group"
                        data-testid={`template-${key}`}>
                        <div className={`w-8 h-8 rounded-lg bg-${t.color}-500/10 flex items-center justify-center shrink-0 group-hover:bg-${t.color}-500/20 transition-colors`}>
                          <Icon className={`w-4 h-4 text-${t.color}-500`} />
                        </div>
                        <div className="min-w-0">
                          <div className="text-[13px] font-medium text-foreground">{t.name}</div>
                          <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1">{t.bio.split(",")[0]}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            <div className="max-w-[640px] mx-auto px-4 py-6 space-y-4" data-testid="chat-messages">
              {messages.map((msg) => (
                <div key={msg.id} className={msg.role === "user" ? "flex justify-end" : ""} data-testid={`message-${msg.id}`}>
                  {msg.role === "user" ? (
                    <div className="max-w-[85%] rounded-2xl bg-secondary px-4 py-2.5">
                      <p className="text-[14px] text-foreground">{msg.content}</p>
                    </div>
                  ) : (
                    <div className="max-w-full">
                      <div className="flex gap-2.5">
                        <div className="w-6 h-6 rounded-full bg-primary/15 flex items-center justify-center shrink-0 mt-0.5">
                          {msg.isDeploying ? (
                            <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />
                          ) : msg.deployResult ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-primary" />
                          ) : msg.isError ? (
                            <X className="w-3.5 h-3.5 text-destructive" />
                          ) : (
                            <Terminal className="w-3.5 h-3.5 text-primary" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className={`text-[14px] leading-relaxed whitespace-pre-wrap ${msg.isError ? "text-destructive" : "text-foreground"}`}
                            dangerouslySetInnerHTML={{ __html: msg.content.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>") }} />
                        </div>
                      </div>
                      {msg.agentCard && (
                        <div className="ml-[34px]">
                          <AgentCard config={msg.agentCard} onDeploy={handleDeploy} onUpdate={updateConfigField} deploying={isDeploying} deployed={deployed} />
                        </div>
                      )}
                      {msg.deployResult && (
                        <div className="ml-[34px]">
                          <DeployResultCard
                            result={msg.deployResult}
                            onCopy={(text) => { navigator.clipboard.writeText(text); toast({ title: "Copied" }); }}
                            onBuildAnother={startNew}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {isProcessing && (
                <div className="flex gap-2.5">
                  <div className="w-6 h-6 rounded-full bg-primary/15 flex items-center justify-center shrink-0">
                    <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />
                  </div>
                  <div className="pt-1.5 flex gap-1">
                    <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: "0ms" }} />
                    <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: "150ms" }} />
                    <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: "300ms" }} />
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-border px-4 pb-4 pt-3 bg-background" data-testid="chat-input-area">
          <div className="max-w-[640px] mx-auto">
            <form id="chat-form" onSubmit={handleSubmit}>
              <div className="relative border border-border rounded-2xl bg-card focus-within:border-primary/40 transition-colors shadow-sm">
                <textarea
                  ref={textareaRef}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={placeholder}
                  className="w-full resize-none bg-transparent pl-4 pr-12 py-3 text-[14px] text-foreground placeholder:text-muted-foreground focus:outline-none"
                  disabled={isProcessing || isDeploying}
                  rows={1}
                  style={{ minHeight: "24px", maxHeight: "200px" }}
                  data-testid="input-command"
                />
                <button type="submit" disabled={isProcessing || isDeploying || !inputValue.trim()}
                  className="absolute right-2 bottom-2 w-8 h-8 rounded-xl bg-primary text-primary-foreground flex items-center justify-center disabled:opacity-30 hover:opacity-90 transition-opacity"
                  data-testid="button-send">
                  {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUp className="w-4 h-4" />}
                </button>
              </div>
            </form>
            {!hasMessages && (
              <div className="flex items-center justify-center gap-2 mt-2.5 flex-wrap">
                {["Build a trading bot", "Create a security scanner", "DeFi yield optimizer", "Sniper agent"].map(s => (
                  <button key={s} onClick={() => sendPrompt(s)}
                    className="px-3 py-1.5 rounded-full border border-border text-[12px] text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
                    data-testid={`suggestion-${s.toLowerCase().replace(/\s+/g, "-")}`}>
                    {s}
                  </button>
                ))}
              </div>
            )}
            <p className="text-center text-[11px] text-muted-foreground/40 mt-2">Agents cost $20 (0.032 BNB) to deploy on-chain</p>
          </div>
        </div>
      </div>
    </>
  );
}
