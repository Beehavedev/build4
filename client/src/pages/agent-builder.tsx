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

interface PreviewData {
  title: string;
  accent: string;
  stats: { value: string; label: string }[];
  feed: { icon: string; text: string; time: string; color: string }[];
}

const PREVIEW_DATA: Record<string, PreviewData> = {
  trading: {
    title: "Trading Dashboard",
    accent: "#10b981",
    stats: [
      { value: "$47,293", label: "Volume (24h)" },
      { value: "78.4%", label: "Win Rate" },
      { value: "143", label: "Trades Today" },
      { value: "+3.82 BNB", label: "Net Profit" },
    ],
    feed: [
      { icon: "🟢", text: "BUY 2.5 BNB → PEPE at $0.00000847", time: "2s ago", color: "#10b981" },
      { icon: "📊", text: "Signal detected: DOGE momentum breakout", time: "18s ago", color: "#8b949e" },
      { icon: "🟢", text: "BUY 1.2 BNB → FLOKI at $0.0001642", time: "1m ago", color: "#10b981" },
      { icon: "🔴", text: "SELL SHIB — take profit target hit (+12.4%)", time: "3m ago", color: "#ef4444" },
      { icon: "⚡", text: "Gas optimized: saved 0.004 BNB on batch", time: "5m ago", color: "#f59e0b" },
      { icon: "🟢", text: "BUY 0.8 BNB → WIF at $1.847", time: "8m ago", color: "#10b981" },
    ],
  },
  research: {
    title: "Research Terminal",
    accent: "#8b5cf6",
    stats: [
      { value: "2,847", label: "Tokens Scanned" },
      { value: "94", label: "Reports Generated" },
      { value: "12", label: "Whales Tracked" },
      { value: "37", label: "Alerts Sent" },
    ],
    feed: [
      { icon: "📋", text: "REPORT: 0x7a2...f4c — Low risk, strong liquidity", time: "Just now", color: "#10b981" },
      { icon: "🐋", text: "Whale 0xd8f... moved 450 ETH to Binance", time: "4m ago", color: "#f59e0b" },
      { icon: "⚠️", text: "Contract 0x3b1... has renounced ownership", time: "12m ago", color: "#f59e0b" },
      { icon: "📋", text: "REPORT: BONK — High volatility, watch support", time: "18m ago", color: "#8b949e" },
      { icon: "🐋", text: "Whale alert: 2.1M USDT moved on-chain", time: "25m ago", color: "#f59e0b" },
      { icon: "✅", text: "Contract audit passed: no malicious functions", time: "31m ago", color: "#10b981" },
    ],
  },
  social: {
    title: "Social Command Center",
    accent: "#3b82f6",
    stats: [
      { value: "12.4K", label: "Impressions" },
      { value: "847", label: "Engagements" },
      { value: "23", label: "Posts Today" },
      { value: "+156", label: "New Followers" },
    ],
    feed: [
      { icon: "🐦", text: "Posted: \"BNB Chain just hit 2M daily TXs...\"", time: "1m ago", color: "#3b82f6" },
      { icon: "💬", text: "Replied to @crypto_whale — gained 12 likes", time: "4m ago", color: "#8b949e" },
      { icon: "📈", text: "Trending: #DeFi — scheduling content", time: "8m ago", color: "#f59e0b" },
      { icon: "🐦", text: "Posted thread: \"5 undervalued gems on BSC\"", time: "15m ago", color: "#3b82f6" },
      { icon: "🔔", text: "Community alert sent to 2,341 members", time: "22m ago", color: "#10b981" },
      { icon: "💬", text: "Engaged with 14 mentions in last hour", time: "30m ago", color: "#8b949e" },
    ],
  },
  defi: {
    title: "Yield Optimizer",
    accent: "#f59e0b",
    stats: [
      { value: "847.2%", label: "Best APY Found" },
      { value: "$23,491", label: "TVL Managed" },
      { value: "18", label: "Active Pools" },
      { value: "+0.47 BNB", label: "Compounded Today" },
    ],
    feed: [
      { icon: "🔄", text: "Auto-compounded: PancakeSwap BNB/USDT +0.12 BNB", time: "Just now", color: "#10b981" },
      { icon: "📊", text: "New pool found: Venus BNB — 24.7% APY", time: "5m ago", color: "#f59e0b" },
      { icon: "🔄", text: "Rebalanced: moved $2,100 from low-yield pool", time: "12m ago", color: "#8b949e" },
      { icon: "⚡", text: "Gas saved: batched 4 harvests into 1 TX", time: "18m ago", color: "#f59e0b" },
      { icon: "📊", text: "APY alert: Alpaca Finance dropped below 15%", time: "25m ago", color: "#ef4444" },
      { icon: "🔄", text: "Auto-compounded: BiSwap CAKE/BNB +0.08 BNB", time: "32m ago", color: "#10b981" },
    ],
  },
  security: {
    title: "Security Monitor",
    accent: "#ef4444",
    stats: [
      { value: "4,291", label: "Contracts Scanned" },
      { value: "187", label: "Threats Blocked" },
      { value: "99.2%", label: "Detection Rate" },
      { value: "3", label: "Active Alerts" },
    ],
    feed: [
      { icon: "🚨", text: "HONEYPOT DETECTED: 0xa3f...2c1 — sell blocked", time: "Just now", color: "#ef4444" },
      { icon: "✅", text: "Contract 0x8b2... passed all checks", time: "2m ago", color: "#10b981" },
      { icon: "⚠️", text: "Suspicious: 0xf41... has hidden mint function", time: "7m ago", color: "#f59e0b" },
      { icon: "🚨", text: "RUG ALERT: Token XYZ — LP removed 94%", time: "11m ago", color: "#ef4444" },
      { icon: "✅", text: "Wallet 0x5a9... safe — no approvals at risk", time: "16m ago", color: "#10b981" },
      { icon: "⚠️", text: "New token flagged: unverified source, proceed with caution", time: "23m ago", color: "#f59e0b" },
    ],
  },
  sniper: {
    title: "Sniper Terminal",
    accent: "#ec4899",
    stats: [
      { value: "0.4s", label: "Avg. Buy Speed" },
      { value: "31", label: "Tokens Sniped" },
      { value: "22/31", label: "Profitable" },
      { value: "+5.14 BNB", label: "Total Profit" },
    ],
    feed: [
      { icon: "🎯", text: "SNIPED: NewToken launched — bought in 0.3s", time: "Just now", color: "#ec4899" },
      { icon: "💰", text: "EXIT: MOONCAT — sold at +340% profit", time: "2m ago", color: "#10b981" },
      { icon: "👀", text: "Watching: 3 tokens pending liquidity add", time: "5m ago", color: "#8b949e" },
      { icon: "🎯", text: "SNIPED: ROCKETDOG — 0.2s, first 5 buyers", time: "8m ago", color: "#ec4899" },
      { icon: "❌", text: "SKIPPED: FakeGem — honeypot detected pre-buy", time: "12m ago", color: "#ef4444" },
      { icon: "🎯", text: "SNIPED: PEPEX — bought 0.5 BNB at launch", time: "19m ago", color: "#ec4899" },
    ],
  },
};

function generatePreviewHtml(config: AgentConfig): string {
  const chainName = config.chain === "base" ? "Base" : config.chain === "xlayer" ? "XLayer" : "BNB Chain";
  const modelName = config.model === "deepseek" ? "DeepSeek V3" : config.model === "qwen" ? "Qwen 2.5" : "Llama 3.3";
  const data = PREVIEW_DATA[config.type] || PREVIEW_DATA.trading;
  const accent = data.accent;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0f;color:#e0e0e0;min-height:100vh;display:flex;flex-direction:column}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #1a1a2e}
.topbar-left{display:flex;align-items:center;gap:8px}
.dot{width:7px;height:7px;border-radius:50%;background:${accent};box-shadow:0 0 8px ${accent}60;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.topbar h1{font-size:13px;font-weight:700;color:#fff}
.topbar .tag{font-size:8px;padding:2px 7px;border-radius:4px;background:${accent}18;color:${accent};text-transform:uppercase;letter-spacing:.5px;font-weight:600}
.meta{font-size:9px;color:#555;display:flex;gap:12px}
.stats{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:#1a1a2e;margin:0;border-bottom:1px solid #1a1a2e}
.stat{background:#0d0d14;padding:14px 16px}
.stat-val{font-size:20px;font-weight:800;color:#fff;letter-spacing:-.5px}
.stat-lbl{font-size:9px;color:#666;margin-top:3px;text-transform:uppercase;letter-spacing:.3px}
.feed{flex:1;overflow:hidden}
.feed-title{font-size:9px;color:#555;text-transform:uppercase;letter-spacing:.5px;padding:12px 16px 8px;font-weight:600}
.feed-item{display:flex;align-items:flex-start;gap:8px;padding:8px 16px;border-bottom:1px solid #111118;animation:fadeIn .4s ease-out both}
.feed-item:nth-child(2){animation-delay:.05s}
.feed-item:nth-child(3){animation-delay:.1s}
.feed-item:nth-child(4){animation-delay:.15s}
.feed-item:nth-child(5){animation-delay:.2s}
.feed-item:nth-child(6){animation-delay:.25s}
.feed-item:nth-child(7){animation-delay:.3s}
@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.feed-icon{font-size:11px;margin-top:1px;shrink:0}
.feed-text{font-size:11px;color:#ccc;line-height:1.4;flex:1}
.feed-time{font-size:9px;color:#444;white-space:nowrap;margin-top:1px}
.bottom{padding:8px 16px;border-top:1px solid #1a1a2e;display:flex;justify-content:space-between;font-size:9px;color:#444}
</style></head><body>
<div class="topbar">
  <div class="topbar-left">
    <div class="dot"></div>
    <h1>${config.name || "Agent"}</h1>
    <span class="tag">${config.status === "live" ? "Live" : "Ready"}</span>
  </div>
  <div class="meta">
    <span>${chainName}</span>
    <span>${modelName}</span>
  </div>
</div>
<div class="stats">
  ${data.stats.map(s => `<div class="stat"><div class="stat-val">${s.value}</div><div class="stat-lbl">${s.label}</div></div>`).join("")}
</div>
<div class="feed">
  <div class="feed-title">${data.title} — Live Feed</div>
  ${data.feed.map(f => `<div class="feed-item"><span class="feed-icon">${f.icon}</span><span class="feed-text" style="color:${f.color}">${f.text}</span><span class="feed-time">${f.time}</span></div>`).join("")}
</div>
<div class="bottom"><span>${config.skills.join(" · ")}</span><span>${config.autonomy === "full" ? "Full Auto" : config.autonomy === "supervised" ? "Supervised" : "Semi-Auto"}</span></div>
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
