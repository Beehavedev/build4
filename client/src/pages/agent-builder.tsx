import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link } from "wouter";
import { SEO } from "@/components/seo";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useWallet } from "@/hooks/use-wallet";
import { useQuery } from "@tanstack/react-query";
import { WORKSPACE_PLANS } from "@shared/schema";
import type { PlanTier } from "@shared/schema";
import {
  ArrowLeft, Terminal, Bot, Brain, Zap, Shield,
  Plus, Layers, Settings, Wallet, Code, Rocket,
  TrendingUp, MessageSquare, Search,
  Eye, Globe, Lock, CheckCircle2, ArrowRight,
  Send, Cpu, Star, Users, Activity,
  Loader2, ChevronRight, Sparkles,
  AlertCircle, Monitor, File, Folder, FolderOpen,
  Play, Square, RotateCcw, Package, Hash,
  Circle, ChevronDown, Grip, PanelLeftClose,
  PanelLeft, X, Copy, ExternalLink, Crown,
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

interface FileNode {
  name: string;
  type: "file" | "folder";
  children?: FileNode[];
  icon?: string;
  content?: string;
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

function generateAgentCode(config: AgentConfig): string {
  if (!config.type) return "";
  const chainName = config.chain === "base" ? "Base" : config.chain === "xlayer" ? "XLayer" : "BNB Chain";
  const modelName = config.model === "deepseek" ? "DeepSeek-V3" : config.model === "qwen" ? "Qwen2.5-72B" : "Llama-3.1-70B";
  return `import { Agent } from "@build4/sdk";
import { ${config.skills.map(s => s.replace(/\s+/g, "")).join(", ")} } from "@build4/skills";

const agent = new Agent({
  name: "${config.name || "Unnamed Agent"}",
  description: "${config.bio || "Built with BUILD4"}",
  chain: "${config.chain}",
  model: "${modelName}",
  autonomy: "${config.autonomy}",
});

${config.skills.map(s => {
  const id = s.replace(/\s+/g, "");
  return `agent.use(new ${id}());`;
}).join("\n")}

agent.on("ready", () => {
  console.log(\`[\${agent.name}] Live on ${chainName}\`);
  console.log(\`Wallet: \${agent.wallet.address}\`);
  console.log(\`Model: ${modelName}\`);
  agent.start();
});

agent.deploy();
`;
}

function generateConfigYaml(config: AgentConfig): string {
  if (!config.type) return "";
  const chainName = config.chain === "base" ? "Base" : config.chain === "xlayer" ? "XLayer" : "BNB Chain";
  const modelName = config.model === "deepseek" ? "DeepSeek-V3" : config.model === "qwen" ? "Qwen2.5-72B" : "Llama-3.1-70B";
  return `name: "${config.name || "Unnamed Agent"}"
version: "1.0.0"
runtime: "build4-v2"

agent:
  type: ${config.type}
  description: "${config.bio}"
  autonomy: ${config.autonomy}

network:
  chain: ${config.chain}
  chainName: ${chainName}
  rpc: auto
  explorer: auto

model:
  provider: decentralized
  name: ${modelName}
  fallback:
    - hyperbolic
    - akash
    - ritual

skills:
${config.skills.map(s => `  - name: ${s}\n    enabled: true`).join("\n")}

wallet:
  type: auto-generated
  identity: ERC-8004

deploy:
  target: build4-cloud
  autoscale: true
  monitoring: true
`;
}

function generateEnvFile(config: AgentConfig): string {
  return `# BUILD4 Agent Environment
# Auto-generated — do not share these values

AGENT_NAME="${config.name || "Unnamed Agent"}"
AGENT_TYPE=${config.type || "custom"}
CHAIN=${config.chain || "bnb"}
MODEL=${config.model || "llama"}
AUTONOMY=${config.autonomy || "semi"}

# Wallet (auto-generated on deploy)
WALLET_ADDRESS=
PRIVATE_KEY=

# Inference
INFERENCE_PROVIDER=decentralized
FALLBACK_ORDER=hyperbolic,akash,ritual

# Monitoring
LOG_LEVEL=info
HEARTBEAT_INTERVAL=30000
`;
}

function generateReadme(config: AgentConfig): string {
  if (!config.type) return "# BUILD4 Agent\n\nConfigure your agent to see documentation here.";
  const tmpl = TEMPLATES[config.type];
  return `# ${config.name || tmpl?.name || "BUILD4 Agent"}

${config.bio || tmpl?.bio || "An autonomous AI agent built on BUILD4."}

## Quick Start

\`\`\`bash
build4 deploy
\`\`\`

## Skills

${config.skills.map(s => `- **${s}**`).join("\n")}

## Configuration

- **Chain**: ${config.chain === "base" ? "Base" : config.chain === "xlayer" ? "XLayer" : "BNB Chain"}
- **Model**: ${config.model === "deepseek" ? "DeepSeek V3" : config.model === "qwen" ? "Qwen 2.5 72B" : "Llama 3.1 70B"}
- **Autonomy**: ${config.autonomy === "full" ? "Full Auto" : config.autonomy === "supervised" ? "Supervised" : "Semi-Auto"}

## API

\`\`\`
POST /api/agents/{id}/task
GET  /api/agents/{id}/status
GET  /api/agents/{id}/wallet
\`\`\`

## License

MIT — Built on BUILD4
`;
}

function buildFileTree(config: AgentConfig): FileNode[] {
  const agentName = (config.name || "my-agent").toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  return [
    {
      name: agentName || "my-agent",
      type: "folder",
      children: [
        { name: "agent.ts", type: "file", content: generateAgentCode(config) },
        { name: "config.yaml", type: "file", content: generateConfigYaml(config) },
        { name: ".env", type: "file", content: generateEnvFile(config) },
        { name: "README.md", type: "file", content: generateReadme(config) },
        {
          name: "skills",
          type: "folder",
          children: config.skills.map(s => ({
            name: `${s.replace(/\s+/g, "-").toLowerCase()}.ts`,
            type: "file" as const,
            content: `import { Skill } from "@build4/sdk";\n\nexport class ${s.replace(/\s+/g, "")} extends Skill {\n  name = "${s}";\n\n  async execute(context: any) {\n    // ${s} logic\n    return { success: true };\n  }\n}\n`,
          })),
        },
        { name: "package.json", type: "file", content: JSON.stringify({
          name: `@build4/${agentName || "my-agent"}`,
          version: "1.0.0",
          private: true,
          scripts: { dev: "build4 dev", deploy: "build4 deploy", test: "build4 test" },
          dependencies: { "@build4/sdk": "^2.1.0", "@build4/skills": "^1.0.0" },
        }, null, 2) },
      ],
    },
  ];
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

function FileTreeItem({ node, depth = 0, selectedFile, onSelect }: { node: FileNode; depth?: number; selectedFile: string; onSelect: (name: string, content: string) => void }) {
  const [expanded, setExpanded] = useState(depth < 2);

  if (node.type === "folder") {
    return (
      <div>
        <button onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 w-full px-2 py-[3px] hover:bg-[#2a2d2e] text-[11px] font-mono text-[#cccccc] transition-colors"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          data-testid={`folder-${node.name}`}>
          <ChevronRight className={`w-3 h-3 text-[#858585] shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
          {expanded ? <FolderOpen className="w-3.5 h-3.5 text-[#dcb67a] shrink-0" /> : <Folder className="w-3.5 h-3.5 text-[#dcb67a] shrink-0" />}
          <span className="truncate">{node.name}</span>
        </button>
        {expanded && node.children?.map((child, i) => (
          <FileTreeItem key={i} node={child} depth={depth + 1} selectedFile={selectedFile} onSelect={onSelect} />
        ))}
      </div>
    );
  }

  const ext = node.name.split(".").pop();
  const iconColor = ext === "ts" ? "text-[#3178c6]" : ext === "yaml" || ext === "yml" ? "text-[#cb4a68]" : ext === "json" ? "text-[#cbcb41]" : ext === "md" ? "text-[#519aba]" : ext === "env" ? "text-[#e5c07b]" : "text-[#858585]";
  const isSelected = selectedFile === node.name;

  return (
    <button onClick={() => onSelect(node.name, node.content || "")}
      className={`flex items-center gap-1 w-full px-2 py-[3px] text-[11px] font-mono transition-colors ${isSelected ? "bg-[#37373d] text-white" : "text-[#cccccc] hover:bg-[#2a2d2e]"}`}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      data-testid={`file-${node.name}`}>
      <File className={`w-3.5 h-3.5 shrink-0 ${iconColor}`} />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

function generateDefaultPreview(config: AgentConfig, selectedFile: string, fileContent: string): string {
  if (config.type && TEMPLATES[config.type]) {
    const skills = config.skills.length > 0 ? config.skills : ["monitoring", "execution"];
    const chainName = config.chain === "base" ? "Base" : config.chain === "xlayer" ? "XLayer" : "BNB Chain";
    const modelName = config.model === "deepseek" ? "DeepSeek V3" : config.model === "qwen" ? "Qwen 2.5" : "Llama 3.1";
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0f;color:#e0e0e0;min-height:100vh;display:flex;flex-direction:column}.header{background:linear-gradient(135deg,#0d1117,#161b22);border-bottom:1px solid #21262d;padding:12px 16px;display:flex;align-items:center;gap:8px}.header .dot{width:8px;height:8px;border-radius:50%;background:#10b981;animation:pulse 2s infinite}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}.header h1{font-size:13px;font-weight:700;color:#fff}.header .badge{font-size:8px;padding:2px 6px;border-radius:4px;background:#10b98120;color:#10b981;text-transform:uppercase;letter-spacing:.5px}.content{flex:1;padding:16px;display:flex;flex-direction:column;gap:12px}.card{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:12px}.card-title{font-size:10px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}.stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.stat{background:#0d1117;border-radius:6px;padding:8px}.stat-value{font-size:16px;font-weight:700;color:#fff}.stat-label{font-size:9px;color:#8b949e;margin-top:2px}.skill-list{display:flex;flex-wrap:wrap;gap:4px}.skill{font-size:9px;padding:3px 8px;border-radius:4px;background:#10b98115;color:#10b981;border:1px solid #10b98130}.chart{height:60px;background:#0d1117;border-radius:6px;display:flex;align-items:end;padding:4px;gap:2px}.bar{flex:1;background:linear-gradient(to top,#10b981,#10b98160);border-radius:2px 2px 0 0;animation:grow .8s ease-out}@keyframes grow{from{height:0}}.status-bar{background:#10b981;padding:6px 16px;display:flex;justify-content:space-between;font-size:9px;color:#fff;font-weight:600}</style></head><body>
<div class="header"><div class="dot"></div><h1>${config.name || "My Agent"}</h1><span class="badge">${config.status === "live" ? "Live" : config.status === "building" ? "Building" : "Ready"}</span></div>
<div class="content"><div class="card"><div class="card-title">Performance</div><div class="stat-grid"><div class="stat"><div class="stat-value">$12,847</div><div class="stat-label">Total Volume</div></div><div class="stat"><div class="stat-value">73.2%</div><div class="stat-label">Win Rate</div></div><div class="stat"><div class="stat-value">341</div><div class="stat-label">Transactions</div></div><div class="stat"><div class="stat-value">2.18 BNB</div><div class="stat-label">Revenue</div></div></div></div>
<div class="card"><div class="card-title">Activity (24h)</div><div class="chart">${Array.from({length:24},(_,i)=>`<div class="bar" style="height:${10+Math.random()*90}%;animation-delay:${i*30}ms"></div>`).join("")}</div></div>
<div class="card"><div class="card-title">Active Skills</div><div class="skill-list">${skills.map(s=>`<span class="skill">${s}</span>`).join("")}</div></div></div>
<div class="status-bar"><span>${chainName} · ${modelName}</span><span>${config.autonomy === "full" ? "Full Auto" : config.autonomy === "supervised" ? "Supervised" : "Semi-Auto"}</span></div></body></html>`;
  }
  if (fileContent) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0f;color:#e0e0e0;min-height:100vh;padding:16px}.file-preview{background:#161b22;border:1px solid #21262d;border-radius:8px;overflow:hidden}.file-header{background:#0d1117;padding:8px 12px;border-bottom:1px solid #21262d;font-size:11px;color:#8b949e;display:flex;align-items:center;gap:6px}.file-header .icon{color:#10b981}pre{padding:12px;font-size:10px;line-height:1.6;color:#c9d1d9;overflow:auto;max-height:calc(100vh - 80px);white-space:pre-wrap;word-break:break-all}.badge{display:inline-block;font-size:8px;padding:2px 6px;border-radius:4px;background:#10b98120;color:#10b981;margin-left:auto}</style></head><body>
<div class="file-preview"><div class="file-header"><span class="icon">&#9679;</span> ${selectedFile} <span class="badge">Generated</span></div>
<pre>${fileContent.replace(/</g,"&lt;").replace(/>/g,"&gt;").substring(0,3000)}</pre></div></body></html>`;
  }
  return `<!DOCTYPE html><html><head><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0f;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:-apple-system,sans-serif}p{color:#404040;font-size:11px}</style></head><body><p>No preview available</p></body></html>`;
}

export default function AgentBuilder() {
  const { address, connected: isConnected, signer } = useWallet();
  const [messages, setMessages] = useState<BuildMessage[]>([
    {
      role: "system",
      content: "Welcome to BUILD4 Workspace. Describe what you want to build — anything from AI agents to websites, APIs, smart contracts, or tools.\n\nTry: \"Build me a trading bot\" or \"I need a landing page\" or \"Create a DeFi dashboard\"",
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
  const [buildLogs, setBuildLogs] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState("agent.ts");
  const [fileContent, setFileContent] = useState("");
  const [rightTab, setRightTab] = useState<"preview" | "terminal" | "plans">("preview");
  const [upgrading, setUpgrading] = useState<PlanTier | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string>("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [openTabs, setOpenTabs] = useState<string[]>(["agent.ts"]);
  const [previewWidth, setPreviewWidth] = useState(480);
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
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
  const planConfig = WORKSPACE_PLANS[userPlan];

  const checkUsage = async (type: "deploy" | "inference" | "agent"): Promise<boolean> => {
    if (!address) return true;
    try {
      const resp = await apiRequest("POST", "/api/workspace/usage", { walletAddress: address, type });
      if (resp.status === 403) {
        const data = await resp.json();
        addMessage({
          role: "system",
          content: `${data.error}\n\nUpgrade at /pricing to continue.`,
          type: "error",
        });
        return false;
      }
      return true;
    } catch {
      return true;
    }
  };

  const TREASURY_WALLET = "0x5Ff57464152c9285A8526a0665d996dA66e2def1";

  const handleUpgrade = async (tier: PlanTier) => {
    if (!isConnected || !address || !signer) {
      addMessage({ role: "system", content: "Connect your wallet first to upgrade.", type: "error" });
      return;
    }
    const plan = WORKSPACE_PLANS[tier];
    if (plan.price === "0") return;
    setUpgrading(tier);
    try {
      const tx = await signer.sendTransaction({
        to: TREASURY_WALLET,
        value: BigInt(plan.price),
      });
      addMessage({ role: "system", content: `Payment sent! TX: ${tx.hash}\nVerifying on-chain...` });
      const resp = await apiRequest("POST", "/api/workspace/upgrade", {
        walletAddress: address,
        plan: tier,
        txHash: tx.hash,
        chainId: 56,
      });
      const data = await resp.json();
      if (data.success) {
        addMessage({ role: "system", content: `Upgraded to ${plan.name}! Your new limits are now active.` });
        queryClient.invalidateQueries({ queryKey: ["/api/workspace/plan", address] });
      } else {
        addMessage({ role: "system", content: data.error || "Upgrade failed. Please try again.", type: "error" });
      }
    } catch (err: any) {
      addMessage({ role: "system", content: `Payment failed: ${err.message || "Transaction rejected"}`, type: "error" });
    } finally {
      setUpgrading(null);
    }
  };

  const fileTree = useMemo(() => buildFileTree(config), [config]);

  useEffect(() => { configRef.current = config; }, [config]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: previewWidth };
    setIsDragging(true);
  }, [previewWidth]);

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startX - e.clientX;
      const newWidth = Math.max(200, Math.min(800, dragRef.current.startWidth + delta));
      setPreviewWidth(newWidth);
    };
    const handleMouseUp = () => {
      setIsDragging(false);
      dragRef.current = null;
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging]);

  useEffect(() => {
    if (config.type) {
      const code = generateAgentCode(config);
      if (selectedFile === "agent.ts") setFileContent(code);
    }
  }, [config, selectedFile]);

  const findFileContent = (name: string): string => {
    const search = (nodes: FileNode[]): string | null => {
      for (const node of nodes) {
        if (node.type === "file" && node.name === name) return node.content || "";
        if (node.children) {
          const found = search(node.children);
          if (found !== null) return found;
        }
      }
      return null;
    };
    return search(fileTree) || "";
  };

  const handleFileSelect = (name: string, content: string) => {
    setSelectedFile(name);
    setFileContent(content || findFileContent(name));
    if (!openTabs.includes(name)) {
      setOpenTabs(prev => [...prev, name]);
    }
  };

  const closeTab = (name: string) => {
    setOpenTabs(prev => {
      const next = prev.filter(t => t !== name);
      if (selectedFile === name && next.length > 0) {
        const newSelected = next[next.length - 1];
        setSelectedFile(newSelected);
        setFileContent(findFileContent(newSelected));
      }
      return next;
    });
  };

  const addMessage = (msg: Omit<BuildMessage, "timestamp">) => {
    setMessages(prev => [...prev, { ...msg, timestamp: new Date() }]);
  };

  const addLog = (log: string) => {
    setBuildLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${log}`]);
  };

  const getAIResponse = async (userMessage: string, currentConfig?: AgentConfig): Promise<{ text: string; preview?: string } | null> => {
    try {
      const canUse = await checkUsage("inference");
      if (!canUse) return null;

      const resp = await apiRequest("POST", "/api/builder/chat", {
        message: userMessage,
        config: currentConfig || configRef.current,
      });
      const data = await resp.json();
      if (data.fallback || !data.response) return null;
      return { text: data.response, preview: data.preview };
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
      addLog(`Agent deployed: ${agent.id}`);
      addLog(`Wallet: ${agent.wallet?.walletAddress || "Generated"}`);
      addLog("Status: LIVE ✓");

      addMessage({
        role: "build",
        content: `Your project is live!\n\nAgent ID: ${agent.id}\nWallet: ${agent.wallet?.walletAddress || "Generated"}\nChain: ${config.chain === "base" ? "Base" : config.chain === "xlayer" ? "XLayer" : "BNB Chain"}\nModel: ${config.model === "deepseek" ? "DeepSeek V3" : config.model === "qwen" ? "Qwen 2.5" : "Llama 3.1"}\nStatus: Running\n\nYour agent is now autonomous and executing on-chain. You can:\n• Monitor its activity in the preview panel\n• Copy its Agent ID to interact via the SDK\n• Say "build another" to start a new project`,
        type: "success",
      });

      toast({ title: "Deployed", description: `${config.name} is live` });
    } catch (error: any) {
      setConfig(prev => ({ ...prev, status: "configuring" }));
      addLog(`Error: ${error.message}`);
      addMessage({
        role: "build",
        content: `Connect your wallet with funds first.\n\n${error.message || "Wallet required"}`,
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
    addLog(`> ${userInput}`);
    setIsProcessing(true);

    if (isDeployCommand(userInput)) {
      if (!config.type) {
        addMessage({ role: "system", content: "Nothing to deploy yet. Describe what you want to build first.", type: "info" });
        setIsProcessing(false);
        return;
      }
      const canDeploy = await checkUsage("deploy");
      if (!canDeploy) {
        setIsProcessing(false);
        return;
      }
      addMessage({ role: "build", content: "Starting build pipeline...", type: "progress" });
      setConfig(prev => ({ ...prev, status: "building" }));
      setRightTab("terminal");
      const steps = [
        "Initializing build environment...",
        `Loading model: ${config.model === "deepseek" ? "DeepSeek V3" : config.model === "qwen" ? "Qwen 2.5" : "Llama 3.1"}...`,
        `Installing skills: ${config.skills.join(", ")}...`,
        `Connecting to ${config.chain === "base" ? "Base" : config.chain === "xlayer" ? "XLayer" : "BNB Chain"} RPC...`,
        "Generating agent wallet...",
        "Registering on-chain identity (ERC-8004)...",
        "Deploying to BUILD4 Cloud...",
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
      addLog(`Config updated: ${Object.keys(configUpdates).join(", ")}`);

      if (!openTabs.includes("agent.ts")) setOpenTabs(prev => [...prev, "agent.ts"]);
      setSelectedFile("agent.ts");
      setFileContent(generateAgentCode(updatedConfig));
    }

    const aiResponse = await getAIResponse(userInput, updatedConfig);

    if (aiResponse) {
      addMessage({ role: "system", content: aiResponse.text, type: "info" });
      if (aiResponse.preview) {
        setPreviewHtml(aiResponse.preview);
        setRightTab("preview");
      }
    } else {
      if (configUpdates) {
        const tmpl = configUpdates.type ? TEMPLATES[configUpdates.type] : null;
        if (tmpl) {
          addMessage({
            role: "system",
            content: `${tmpl.icon} ${tmpl.name} workspace created.\n\nFiles generated in /${(updatedConfig.name || "my-agent").toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")}/\n\nSkills: ${(configUpdates.skills || config.skills).join(", ")}\nChain: ${(configUpdates.chain || config.chain) === "base" ? "Base" : (configUpdates.chain || config.chain) === "xlayer" ? "XLayer" : "BNB Chain"}\nModel: ${(configUpdates.model || config.model) === "deepseek" ? "DeepSeek V3" : (configUpdates.model || config.model) === "qwen" ? "Qwen 2.5" : "Llama 3.1"}\n\nEdit the files or say "deploy" when ready.`,
            type: "info",
          });
        } else {
          const changes: string[] = [];
          if (configUpdates.chain) changes.push(`Chain → ${configUpdates.chain === "base" ? "Base" : configUpdates.chain === "xlayer" ? "XLayer" : "BNB Chain"}`);
          if (configUpdates.model) changes.push(`Model → ${configUpdates.model === "deepseek" ? "DeepSeek V3" : configUpdates.model === "qwen" ? "Qwen 2.5" : "Llama 3.1"}`);
          if (configUpdates.autonomy) changes.push(`Autonomy → ${configUpdates.autonomy === "full" ? "Full Auto" : configUpdates.autonomy === "supervised" ? "Supervised" : "Semi-Auto"}`);
          if (configUpdates.name) changes.push(`Name → ${configUpdates.name}`);
          if (configUpdates.skills && configUpdates.skills.length > config.skills.length) changes.push(`Skill added`);
          addMessage({ role: "system", content: `Updated: ${changes.join(", ")}. Files regenerated.${config.type ? ' Say "deploy" when ready.' : ""}`, type: "info" });
        }
      } else {
        addMessage({
          role: "system",
          content: `I can build anything you need. Try:\n\n• "Build a trading bot" — autonomous DEX trader\n• "Create a landing page" — responsive website\n• "I need a DeFi dashboard" — real-time analytics\n• "Make an API for my app" — backend service\n• "Build a smart contract" — Solidity on BNB/Base\n\nOr describe what you want in your own words.`,
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

  const getLineNumbers = (text: string) => {
    const lines = text.split("\n");
    return lines.map((_, i) => i + 1);
  };

  return (
    <>
      <SEO title="Workspace | BUILD4" description="Build anything — AI agents, websites, apps, APIs, smart contracts, and more." path="/build" />

      <div className="h-screen flex flex-col bg-[#1e1e1e] text-[#cccccc] overflow-hidden" data-testid="page-agent-builder">
        <div className="flex items-center justify-between h-9 bg-[#323233] border-b border-[#252526] px-2 shrink-0 select-none" style={{ WebkitAppRegion: "drag" } as any}>
          <div className="flex items-center gap-2" style={{ WebkitAppRegion: "no-drag" } as any}>
            <Link href="/">
              <div className="flex items-center gap-1 px-2 py-0.5 hover:bg-[#505050] rounded cursor-pointer transition-colors" data-testid="button-home">
                <Terminal className="w-3 h-3 text-emerald-400" />
                <span className="font-mono font-bold text-[10px] text-white">BUILD<span className="text-emerald-400">4</span></span>
              </div>
            </Link>
            <div className="h-3 w-px bg-[#505050]" />
            <span className="font-mono text-[10px] text-[#858585]">Workspace</span>
            {config.name && (
              <>
                <ChevronRight className="w-2.5 h-2.5 text-[#505050]" />
                <span className="font-mono text-[10px] text-[#cccccc]">{config.name}</span>
              </>
            )}
          </div>

          <div className="flex items-center gap-1.5" style={{ WebkitAppRegion: "no-drag" } as any}>
            {config.status === "live" && (
              <div className="flex items-center gap-1 px-1.5 py-0.5 bg-emerald-500/15 rounded">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span className="font-mono text-[9px] text-emerald-400">LIVE</span>
              </div>
            )}
            {config.status === "building" && (
              <div className="flex items-center gap-1 px-1.5 py-0.5 bg-amber-500/15 rounded">
                <Loader2 className="w-2.5 h-2.5 text-amber-400 animate-spin" />
                <span className="font-mono text-[9px] text-amber-400">BUILDING</span>
              </div>
            )}
            {config.status === "configuring" && (
              <button onClick={() => handleQuickAction("deploy")}
                className="flex items-center gap-1 px-2 py-0.5 bg-emerald-600 hover:bg-emerald-500 rounded text-white transition-colors"
                data-testid="button-deploy-top">
                <Play className="w-2.5 h-2.5" />
                <span className="font-mono text-[9px] font-semibold">Deploy</span>
              </button>
            )}
            <Link href="/autonomous-economy">
              <div className="flex items-center gap-1 px-1.5 py-0.5 hover:bg-[#505050] rounded cursor-pointer transition-colors" data-testid="button-dashboard">
                <Activity className="w-3 h-3 text-[#858585]" />
              </div>
            </Link>
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          {sidebarOpen && (
            <div className="w-[200px] bg-[#252526] border-r border-[#1e1e1e] flex flex-col shrink-0" data-testid="sidebar-files">
              <div className="flex items-center justify-between px-3 py-1.5">
                <span className="font-mono text-[10px] text-[#bbbbbb] uppercase tracking-wider font-semibold">Explorer</span>
                <button onClick={() => setSidebarOpen(false)} className="p-0.5 hover:bg-[#383838] rounded" data-testid="button-close-sidebar">
                  <PanelLeftClose className="w-3 h-3 text-[#858585]" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto">
                {config.type ? (
                  fileTree.map((node, i) => (
                    <FileTreeItem key={i} node={node} selectedFile={selectedFile} onSelect={handleFileSelect} />
                  ))
                ) : (
                  <div className="px-3 py-8 text-center">
                    <Bot className="w-8 h-8 mx-auto text-[#505050] mb-2" />
                    <p className="font-mono text-[10px] text-[#505050]">No workspace yet</p>
                    <p className="font-mono text-[9px] text-[#404040] mt-1">Use the AI chat to create one</p>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="flex-1 flex flex-col min-w-0">
            {openTabs.length > 0 && config.type && (
              <div className="flex items-center bg-[#252526] border-b border-[#1e1e1e] overflow-x-auto shrink-0">
                {!sidebarOpen && (
                  <button onClick={() => setSidebarOpen(true)} className="px-2 py-1.5 hover:bg-[#2a2d2e] transition-colors" data-testid="button-open-sidebar">
                    <PanelLeft className="w-3 h-3 text-[#858585]" />
                  </button>
                )}
                {openTabs.map(tab => {
                  const ext = tab.split(".").pop();
                  const iconColor = ext === "ts" ? "text-[#3178c6]" : ext === "yaml" || ext === "yml" ? "text-[#cb4a68]" : ext === "json" ? "text-[#cbcb41]" : ext === "md" ? "text-[#519aba]" : "text-[#858585]";
                  return (
                    <div key={tab} className={`flex items-center gap-1 px-3 py-1.5 text-[11px] font-mono border-r border-[#1e1e1e] cursor-pointer group ${
                      selectedFile === tab ? "bg-[#1e1e1e] text-white" : "bg-[#2d2d2d] text-[#969696] hover:bg-[#2a2d2e]"
                    }`} onClick={() => handleFileSelect(tab, findFileContent(tab))}>
                      <File className={`w-3 h-3 shrink-0 ${iconColor}`} />
                      <span className="truncate">{tab}</span>
                      <button onClick={(e) => { e.stopPropagation(); closeTab(tab); }}
                        className="ml-1 p-0.5 rounded hover:bg-[#505050] opacity-0 group-hover:opacity-100 transition-opacity">
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="flex-1 flex overflow-hidden relative">
              {isDragging && <div className="absolute inset-0 z-50 cursor-col-resize" />}
              <div className="flex-1 flex flex-col min-w-0">
                {config.type && fileContent ? (
                  <div className="flex-1 overflow-auto bg-[#1e1e1e] select-text" data-testid="code-editor">
                    <div className="flex min-h-full">
                      <div className="py-2 px-2 text-right select-none shrink-0 bg-[#1e1e1e] border-r border-[#2a2d2e]">
                        {getLineNumbers(fileContent).map(n => (
                          <div key={n} className="font-mono text-[11px] leading-[18px] text-[#505050]">{n}</div>
                        ))}
                      </div>
                      <pre className="flex-1 py-2 px-4 font-mono text-[11px] leading-[18px] text-[#d4d4d4] whitespace-pre overflow-x-auto">
                        {fileContent}
                      </pre>
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex items-center justify-center bg-[#1e1e1e]" data-testid="editor-welcome">
                    <div className="text-center space-y-4 max-w-md px-6">
                      <div className="w-16 h-16 mx-auto rounded-2xl bg-[#252526] flex items-center justify-center">
                        <Terminal className="w-8 h-8 text-emerald-400/60" />
                      </div>
                      <h2 className="font-mono text-lg font-bold text-white">BUILD<span className="text-emerald-400">4</span> Workspace</h2>
                      <p className="font-mono text-[11px] text-[#858585] leading-relaxed">
                        Describe what you want to build in the AI panel below.
                        <br />Your project's code and config will appear here.
                      </p>
                      <div className="grid grid-cols-3 gap-2 pt-2">
                        {Object.entries(TEMPLATES).slice(0, 6).map(([key, tmpl]) => (
                          <button key={key} onClick={() => handleQuickAction(`build a ${key} agent`)}
                            className="p-2 rounded bg-[#252526] hover:bg-[#2a2d2e] border border-[#383838] hover:border-[#505050] transition-all"
                            data-testid={`quick-${key}`}>
                            <div className="text-lg mb-1">{tmpl.icon}</div>
                            <div className="font-mono text-[9px] text-[#cccccc]">{tmpl.name.replace(" Agent", "")}</div>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div
                onMouseDown={handleDragStart}
                className={`hidden lg:flex items-center justify-center w-[5px] shrink-0 cursor-col-resize group hover:bg-emerald-500/30 transition-colors ${isDragging ? "bg-emerald-500/40" : "bg-[#1e1e1e]"}`}
                data-testid="resize-handle">
                <div className={`w-[1px] h-8 rounded-full transition-colors ${isDragging ? "bg-emerald-400" : "bg-[#383838] group-hover:bg-emerald-400/60"}`} />
              </div>

              <div className="hidden lg:flex flex-col shrink-0 bg-[#1e1e1e]" style={{ width: `${previewWidth}px` }}>
                <div className="flex items-center gap-1 px-2 h-8 bg-[#252526] border-b border-[#1e1e1e] shrink-0">
                  <button onClick={() => setRightTab("preview")}
                    className={`font-mono text-[10px] px-2 py-0.5 rounded transition-colors ${rightTab === "preview" ? "bg-[#1e1e1e] text-white" : "text-[#858585] hover:text-[#cccccc]"}`}
                    data-testid="tab-preview">
                    <Eye className="w-3 h-3 inline mr-1" />Preview
                  </button>
                  <button onClick={() => setRightTab("terminal")}
                    className={`font-mono text-[10px] px-2 py-0.5 rounded transition-colors ${rightTab === "terminal" ? "bg-[#1e1e1e] text-white" : "text-[#858585] hover:text-[#cccccc]"}`}
                    data-testid="tab-terminal">
                    <Terminal className="w-3 h-3 inline mr-1" />Output
                  </button>
                  <button onClick={() => setRightTab("plans")}
                    className={`font-mono text-[10px] px-2 py-0.5 rounded transition-colors ${rightTab === "plans" ? "bg-[#1e1e1e] text-white" : "text-[#858585] hover:text-[#cccccc]"}`}
                    data-testid="tab-plans">
                    <Crown className="w-3 h-3 inline mr-1" />Plans
                  </button>
                </div>

                {rightTab === "preview" ? (
                  <div className="flex-1 flex flex-col overflow-hidden" data-testid="preview-panel">
                    {config.status === "idle" && !fileContent && !previewHtml ? (
                      <div className="flex-1 flex flex-col items-center justify-center text-center p-4">
                        <div className="w-14 h-14 rounded-xl bg-[#252526] flex items-center justify-center mb-3">
                          <Monitor className="w-7 h-7 text-[#404040]" />
                        </div>
                        <p className="font-mono text-[10px] text-[#606060] mb-1">Live Preview</p>
                        <p className="font-mono text-[9px] text-[#404040] leading-relaxed max-w-[200px]">
                          Start building to see a live preview of your project here
                        </p>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-1.5 px-2 py-1 bg-[#1a1a2e] border-b border-[#252526] shrink-0">
                          <div className="flex gap-1">
                            <div className="w-2 h-2 rounded-full bg-[#ff5f57]" />
                            <div className="w-2 h-2 rounded-full bg-[#febc2e]" />
                            <div className="w-2 h-2 rounded-full bg-[#28c840]" />
                          </div>
                          <div className="flex-1 mx-2 px-2 py-0.5 rounded bg-[#0e0e1a] flex items-center gap-1">
                            <Globe className="w-2.5 h-2.5 text-[#505050] shrink-0" />
                            <span className="font-mono text-[8px] text-[#606060] truncate">
                              {config.name ? `${config.name.toLowerCase().replace(/\s+/g, "-")}.build4.io` : "preview.build4.io"}
                            </span>
                          </div>
                          <button
                            onClick={() => {
                              const iframe = document.getElementById("preview-iframe") as HTMLIFrameElement;
                              if (iframe) iframe.srcdoc = iframe.srcdoc;
                            }}
                            className="p-0.5 hover:bg-[#383838] rounded transition-colors"
                            data-testid="button-refresh-preview">
                            <RotateCcw className="w-2.5 h-2.5 text-[#606060]" />
                          </button>
                        </div>
                        <div className="flex-1 bg-white overflow-hidden relative">
                          <iframe
                            id="preview-iframe"
                            className="w-full h-full border-0"
                            data-testid="preview-iframe"
                            sandbox="allow-scripts"
                            srcDoc={previewHtml || generateDefaultPreview(config, selectedFile, fileContent)}
                          />
                        </div>
                        {config.type && (
                          <div className="shrink-0 px-2 py-1.5 bg-[#252526] border-t border-[#1e1e1e] flex items-center justify-between">
                            <div className="flex items-center gap-1.5">
                              <span className="text-lg">{TEMPLATES[config.type]?.icon || "🤖"}</span>
                              <div>
                                <div className="font-mono text-[9px] font-bold text-white" data-testid="preview-name">{config.name || "Unnamed"}</div>
                                <div className="font-mono text-[7px] text-[#858585]">{config.type} · {chainLabel}</div>
                              </div>
                            </div>
                            <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-mono ${
                              config.status === "live" ? "bg-emerald-500/15 text-emerald-400" :
                              config.status === "building" ? "bg-amber-500/15 text-amber-400" : "bg-blue-500/15 text-blue-400"
                            }`}>
                              <div className={`w-1.5 h-1.5 rounded-full ${
                                config.status === "live" ? "bg-emerald-400 animate-pulse" :
                                config.status === "building" ? "bg-amber-400 animate-pulse" : "bg-blue-400"
                              }`} />
                              {config.status === "live" ? "LIVE" : config.status === "building" ? "BUILDING" : "READY"}
                            </div>
                          </div>
                        )}
                        {deployedAgentId && (
                          <div className="shrink-0 px-2 py-1 bg-[#1a2e1a] border-t border-emerald-500/20 space-y-1">
                            <div className="flex items-center justify-between">
                              <span className="font-mono text-[8px] text-emerald-400/70">Agent ID</span>
                              <div className="flex gap-1">
                                <button
                                  className="px-1.5 py-0.5 rounded bg-[#252526] hover:bg-[#2a2d2e] font-mono text-[8px] text-[#cccccc] transition-colors"
                                  data-testid="button-copy-id"
                                  onClick={() => {
                                    navigator.clipboard.writeText(deployedAgentId);
                                    toast({ title: "Copied", description: "Agent ID copied to clipboard" });
                                  }}>
                                  Copy ID
                                </button>
                                <Link href="/autonomous-economy">
                                  <button
                                    className="px-1.5 py-0.5 rounded bg-[#252526] hover:bg-[#2a2d2e] font-mono text-[8px] text-[#cccccc] transition-colors"
                                    data-testid="button-view-agent">
                                    View Live
                                  </button>
                                </Link>
                                <button className="px-1.5 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 font-mono text-[8px] text-white transition-colors"
                                  data-testid="button-build-another"
                                  onClick={() => {
                                    setConfig({ name: "", bio: "", type: "", chain: "bnb", model: "llama", skills: [], autonomy: "semi", status: "idle" });
                                    setDeployedAgentId(null);
                                    setBuildLogs([]);
                                    setOpenTabs([]);
                                    setSelectedFile("agent.ts");
                                    setFileContent("");
                                    setMessages([{ role: "system", content: "Ready. What do you want to build?", timestamp: new Date(), type: "info" }]);
                                  }}>
                                  + New
                                </button>
                              </div>
                            </div>
                            <code className="font-mono text-[8px] text-emerald-300 block truncate">{deployedAgentId}</code>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                ) : (
                  rightTab === "terminal" ? (
                  <div className="flex-1 overflow-y-auto p-2 font-mono text-[10px] leading-relaxed bg-[#0e0e0e]" data-testid="terminal-panel">
                    <div className="text-[#505050] mb-1">BUILD4 Cloud Terminal</div>
                    {buildLogs.length === 0 ? (
                      <div className="text-[#404040]">$ waiting for build...</div>
                    ) : (
                      buildLogs.map((log, i) => (
                        <div key={i} className={`py-0.5 ${
                          log.includes("Error") ? "text-red-400" :
                          log.includes("deployed") || log.includes("LIVE") ? "text-emerald-400" :
                          log.includes(">") ? "text-blue-400" :
                          "text-[#858585]"
                        }`}>{log}</div>
                      ))
                    )}
                    <div className="text-[#404040] mt-1">$</div>
                  </div>
                ) : (
                  <div className="flex-1 overflow-y-auto p-3" data-testid="plans-panel">
                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5 mb-3">
                        <Crown className="w-3.5 h-3.5 text-amber-400" />
                        <span className="font-mono text-[11px] font-bold text-white">Workspace Plans</span>
                      </div>
                      <div className="p-2 rounded bg-emerald-500/10 border border-emerald-500/20 mb-3">
                        <div className="font-mono text-[9px] text-emerald-400 uppercase tracking-wider">Current Plan</div>
                        <div className="font-mono text-sm font-bold text-white mt-0.5">{planConfig.name}</div>
                        <div className="font-mono text-[9px] text-[#858585] mt-1">
                          {planConfig.agentLimit === -1 || planConfig.agentLimit >= 100 ? "Unlimited" : planConfig.agentLimit} agents · {planConfig.deploysPerMonth === -1 ? "Unlimited" : planConfig.deploysPerMonth} deploys · {planConfig.inferenceCredits === -1 ? "Unlimited" : planConfig.inferenceCredits} AI credits
                        </div>
                      </div>
                      {(["free", "pro", "enterprise"] as PlanTier[]).map(tier => {
                        const p = WORKSPACE_PLANS[tier];
                        const isCurrent = userPlan === tier;
                        const isUpgrade = tier !== "free" && !isCurrent && (tier === "enterprise" || userPlan === "free");
                        return (
                          <div key={tier} className={`p-2.5 rounded border transition-all ${
                            isCurrent ? "border-emerald-500/40 bg-emerald-500/5" : "border-[#383838] bg-[#252526] hover:border-[#505050]"
                          }`} data-testid={`builder-plan-${tier}`}>
                            <div className="flex items-center justify-between mb-1.5">
                              <div>
                                <span className="font-mono text-[11px] font-bold text-white">{p.name}</span>
                                {tier === "pro" && <span className="ml-1.5 font-mono text-[7px] px-1 py-0.5 rounded bg-violet-500/20 text-violet-300 uppercase">Popular</span>}
                              </div>
                              <span className="font-mono text-[10px] text-emerald-400 font-semibold">
                                {p.priceLabel}
                              </span>
                            </div>
                            <div className="space-y-1 mb-2">
                              {p.features.slice(0, 5).map((f, i) => (
                                <div key={i} className="flex items-center gap-1">
                                  <CheckCircle2 className="w-2.5 h-2.5 text-emerald-400 shrink-0" />
                                  <span className="font-mono text-[9px] text-[#cccccc]">{f}</span>
                                </div>
                              ))}
                            </div>
                            {isCurrent ? (
                              <div className="w-full py-1 rounded bg-[#383838] font-mono text-[9px] text-[#858585] text-center">Current Plan</div>
                            ) : isUpgrade ? (
                              <button
                                onClick={() => handleUpgrade(tier)}
                                disabled={!!upgrading}
                                className="w-full py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 font-mono text-[9px] text-white font-semibold transition-colors flex items-center justify-center gap-1"
                                data-testid={`builder-upgrade-${tier}`}>
                                {upgrading === tier ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                                {upgrading === tier ? "Processing..." : `Upgrade · ${p.priceLabel}`}
                              </button>
                            ) : null}
                          </div>
                        );
                      })}
                      <div className="text-center pt-2">
                        <Link href="/pricing">
                          <span className="font-mono text-[9px] text-emerald-400 hover:text-emerald-300 cursor-pointer" data-testid="link-full-pricing">
                            View full comparison →
                          </span>
                        </Link>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="border-t border-[#252526] bg-[#1e1e1e] shrink-0" data-testid="ai-chat-panel">
          <div className="flex items-center gap-2 px-3 h-7 bg-[#252526] border-b border-[#1e1e1e]">
            <Sparkles className="w-3 h-3 text-emerald-400" />
            <span className="font-mono text-[10px] text-[#bbbbbb] font-semibold">BUILD4 AI</span>
            {isProcessing && <Loader2 className="w-2.5 h-2.5 animate-spin text-emerald-400" />}
          </div>

          <div className="max-h-[180px] overflow-y-auto px-3 py-2 space-y-1.5" data-testid="chat-messages">
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] rounded px-2 py-1 ${
                  msg.role === "user" ? "bg-emerald-600/20 text-emerald-100"
                    : msg.type === "success" ? "bg-emerald-500/10 text-emerald-300"
                    : msg.type === "error" ? "bg-red-500/10 text-red-300"
                    : msg.type === "progress" ? "bg-amber-500/5 text-amber-300"
                    : "bg-[#252526] text-[#cccccc]"
                }`} data-testid={`message-${i}`}>
                  {msg.role !== "user" && msg.type === "progress" && (
                    <Loader2 className="w-2.5 h-2.5 text-amber-400 animate-spin inline mr-1" />
                  )}
                  <pre className="font-mono text-[10px] whitespace-pre-wrap leading-relaxed inline">{msg.content}</pre>
                </div>
              </div>
            ))}
            {isProcessing && messages[messages.length - 1]?.role !== "build" && (
              <div className="flex items-center gap-1.5 px-2 py-1">
                <Loader2 className="w-2.5 h-2.5 animate-spin text-emerald-400" />
                <span className="font-mono text-[10px] text-[#505050]">Thinking...</span>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <div className="px-3 pb-2 pt-1">
            <form id="build-form" onSubmit={handleSubmit} className="flex gap-1.5">
              <Input ref={inputRef} value={inputValue} onChange={(e) => setInputValue(e.target.value)}
                placeholder={config.status === "idle" ? "Describe what you want to build..." : config.status === "live" ? "Build something new..." : "Configure or type 'deploy'..."}
                className="font-mono text-[10px] flex-1 h-7 bg-[#3c3c3c] border-[#505050] text-[#cccccc] placeholder:text-[#505050] focus-visible:ring-emerald-500/30"
                disabled={isProcessing}
                data-testid="input-command" />
              <Button type="submit" disabled={isProcessing || !inputValue.trim()} size="sm"
                className="gap-1 px-2.5 h-7 bg-emerald-600 hover:bg-emerald-500 text-white text-[10px]"
                data-testid="button-send">
                {isProcessing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
              </Button>
            </form>
            {config.status === "idle" && (
              <div className="flex items-center gap-1 mt-1 overflow-x-auto">
                {[
                  { label: "Trading", action: "build a trading agent", icon: TrendingUp },
                  { label: "Security", action: "build a security agent", icon: Shield },
                  { label: "DeFi", action: "build a defi agent", icon: Layers },
                  { label: "Sniper", action: "build a sniper agent", icon: Zap },
                  { label: "Browse", action: "show me agents", icon: Globe },
                ].map(item => (
                  <button key={item.label} onClick={() => handleQuickAction(item.action)}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#252526] hover:bg-[#2a2d2e] font-mono text-[9px] text-[#858585] hover:text-[#cccccc] transition-colors whitespace-nowrap"
                    data-testid={`quick-${item.label.toLowerCase()}-btn`}>
                    <item.icon className="w-2.5 h-2.5" /> {item.label}
                  </button>
                ))}
              </div>
            )}
            {config.status === "configuring" && (
              <div className="flex items-center gap-1 mt-1 overflow-x-auto">
                <button onClick={() => handleQuickAction("deploy")} className="flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-600/20 text-emerald-400 font-mono text-[9px] hover:bg-emerald-600/30 transition-colors whitespace-nowrap" data-testid="quick-deploy">
                  <Rocket className="w-2.5 h-2.5" /> Deploy
                </button>
                <button onClick={() => handleQuickAction("use DeepSeek")} className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#252526] font-mono text-[9px] text-[#858585] hover:text-[#cccccc] transition-colors whitespace-nowrap" data-testid="quick-deepseek">
                  <Brain className="w-2.5 h-2.5" /> DeepSeek
                </button>
                <button onClick={() => handleQuickAction("use Base chain")} className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#252526] font-mono text-[9px] text-[#858585] hover:text-[#cccccc] transition-colors whitespace-nowrap" data-testid="quick-base">
                  <Globe className="w-2.5 h-2.5" /> Base
                </button>
                <button onClick={() => handleQuickAction("full auto")} className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#252526] font-mono text-[9px] text-[#858585] hover:text-[#cccccc] transition-colors whitespace-nowrap" data-testid="quick-auto">
                  <Zap className="w-2.5 h-2.5" /> Full Auto
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between h-5 bg-[#007acc] px-2 shrink-0 select-none">
          <div className="flex items-center gap-2">
            {config.status === "live" ? (
              <div className="flex items-center gap-1">
                <CheckCircle2 className="w-2.5 h-2.5 text-white" />
                <span className="font-mono text-[9px] text-white">Deployed</span>
              </div>
            ) : config.status === "building" ? (
              <div className="flex items-center gap-1">
                <Loader2 className="w-2.5 h-2.5 text-white animate-spin" />
                <span className="font-mono text-[9px] text-white">Building...</span>
              </div>
            ) : config.status === "configuring" ? (
              <div className="flex items-center gap-1">
                <Circle className="w-2.5 h-2.5 text-white" />
                <span className="font-mono text-[9px] text-white">Ready to deploy</span>
              </div>
            ) : (
              <span className="font-mono text-[9px] text-white/80">BUILD4 Workspace v2.1</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => setRightTab("plans")} className="flex items-center gap-1 hover:bg-white/10 px-1 rounded transition-colors" data-testid="status-plan">
              <Crown className="w-2.5 h-2.5 text-amber-400" />
              <span className="font-mono text-[9px] text-white/80 hover:text-white cursor-pointer">
                {userPlan === "enterprise" ? "Enterprise" : userPlan === "pro" ? "Pro" : "Free"} Plan
              </span>
            </button>
            {config.type && (
              <>
                <span className="font-mono text-[9px] text-white/80">{chainLabel}</span>
                <span className="font-mono text-[9px] text-white/80">{config.model === "deepseek" ? "DeepSeek" : config.model === "qwen" ? "Qwen" : "Llama"}</span>
              </>
            )}
            <span className="font-mono text-[9px] text-white/80">UTF-8</span>
          </div>
        </div>
      </div>
    </>
  );
}
