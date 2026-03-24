import { useState, useRef, useEffect, useCallback } from "react";
import { Link } from "wouter";
import { SEO } from "@/components/seo";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useWallet } from "@/hooks/use-wallet";
import {
  Loader2, ArrowUp, CheckCircle2, Terminal, X,
  Rocket, Shield,
  TrendingUp, Search, MessageSquare, Landmark, Target,
  ChevronRight, ExternalLink, Copy, Plus,
  Activity, Wallet, Zap, Eye,
  Code2, Monitor, RotateCcw,
  FileCode, Globe, Smartphone, Tablet,
  PanelRightOpen, PanelRightClose,
  Sparkles, LayoutGrid, Palette,
} from "lucide-react";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  agentCard?: AgentConfig;
  isDeploying?: boolean;
  deployResult?: DeployResultData;
  agentStatus?: AgentStatusData;
  myAgentsList?: MyAgentData[];
  isError?: boolean;
  hasPreview?: boolean;
}

interface DeployResultData { agentId: string; wallet: string; chain: string; name: string; }
interface AgentStatusData { id: string; name: string; balance: string; totalEarned: string; totalSpent: string; netProfit: string; totalTransactions: number; skills: number; status: string; }
interface MyAgentData { id: string; name: string; bio: string; modelType: string; status: string; createdAt: string; }
interface AgentConfig { name: string; bio: string; type: string; chain: string; model: string; skills: string[]; autonomy: string; }
interface ProjectFile { path: string; content: string; }

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
      matched = true; break;
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

function isDeployCmd(s: string) { const l = s.toLowerCase().trim(); return ["deploy", "launch", "build it", "create it", "ship it", "deploy it", "deploy now"].some(c => l === c); }
function isStartOverCmd(s: string) { const l = s.toLowerCase().trim(); return ["start over", "new agent", "build another", "reset", "start fresh", "clear"].some(c => l === c || l.includes(c)); }
function isShowAgentsCmd(s: string) { const l = s.toLowerCase().trim(); return ["show my agents", "my agents", "list agents"].some(c => l.includes(c)); }
function isCheckStatusCmd(s: string) { const l = s.toLowerCase().trim(); return ["status", "how is", "check on", "check agent", "how's my agent"].some(c => l.includes(c)); }
function isAgentRequest(s: string) { const l = s.toLowerCase(); return ["trading agent", "trading bot", "research agent", "social agent", "defi agent", "security agent", "sniper agent", "sniper bot", "security scanner", "yield optimizer", "defi optimizer"].some(c => l.includes(c)); }

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function formatBNB(s: string) { const n = parseFloat(s); return n === 0 ? "0 BNB" : n < 0.0001 ? "<0.0001 BNB" : n.toFixed(4) + " BNB"; }
function timeAgo(d: string) { const m = Math.floor((Date.now() - new Date(d).getTime()) / 60000); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m/60)}h ago` : `${Math.floor(m/1440)}d ago`; }

function AgentCard({ config, onDeploy, onUpdate, deploying, deployed }: { config: AgentConfig; onDeploy: () => void; onUpdate: (f: string, v: string) => void; deploying: boolean; deployed: boolean }) {
  const t = AGENT_TYPES[config.type]; if (!t) return null; const Icon = t.icon;
  return (
    <div className="mt-3 rounded-xl border border-border/60 bg-card/80 backdrop-blur-sm overflow-hidden shadow-sm" data-testid="agent-card">
      <div className="p-4 border-b border-border/40">
        <div className="flex items-start gap-3">
          <div className={`w-10 h-10 rounded-xl bg-${t.color}-500/15 flex items-center justify-center shrink-0`}><Icon className={`w-5 h-5 text-${t.color}-500`} /></div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-[15px] font-semibold text-foreground" data-testid="agent-name">{config.name}</h3>
              {deployed ? <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/10 text-emerald-500">Deployed</span> : <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary">Ready</span>}
            </div>
            <p className="text-[13px] text-muted-foreground mt-0.5">{config.bio}</p>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-3 divide-x divide-border/40 border-b border-border/40">
        {[["chain", ["bnb","base","xlayer"], CHAIN_LABEL, "Chain"], ["model", ["llama","deepseek","qwen"], MODEL_LABEL, "Model"], ["autonomy", ["semi","full","supervised"], AUTONOMY_LABEL, "Autonomy"]].map(([field, opts, labels, label]) => (
          <div key={field as string} className="p-3 text-center">
            <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">{label as string}</div>
            <button onClick={() => { const o = opts as string[]; onUpdate(field as string, o[(o.indexOf((config as any)[field as string]) + 1) % o.length]); }}
              className="text-[13px] font-medium text-foreground hover:text-primary transition-colors" data-testid={`toggle-${field}`}>
              {((labels as Record<string, string>)[(config as any)[field as string]] || "").split(" ")[0]} <ChevronRight className="w-3 h-3 inline text-muted-foreground" />
            </button>
          </div>
        ))}
      </div>
      <div className="p-3 border-b border-border/40">
        <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">Skills</div>
        <div className="flex flex-wrap gap-1.5">{config.skills.map(s => <span key={s} className="px-2 py-1 rounded-md bg-muted/60 text-[11px] font-medium text-foreground">{s}</span>)}</div>
      </div>
      {!deployed && (
        <div className="p-3"><button onClick={onDeploy} disabled={deploying} className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-primary text-primary-foreground text-[13px] font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity" data-testid="button-deploy">
          {deploying ? <><Loader2 className="w-4 h-4 animate-spin" /> Deploying...</> : <><Rocket className="w-4 h-4" /> Deploy Agent — $20</>}
        </button></div>
      )}
    </div>
  );
}

function DeployResultCard({ result, onCopy, onBuildAnother, onCheckStatus }: { result: DeployResultData; onCopy: (t: string) => void; onBuildAnother: () => void; onCheckStatus: (id: string) => void }) {
  const aid = result.agentId ? result.agentId.substring(0, Math.min(24, result.agentId.length)) : "—";
  const wid = result.wallet ? result.wallet.substring(0, Math.min(20, result.wallet.length)) : "—";
  return (
    <div className="mt-3 rounded-xl border border-primary/30 bg-primary/5 overflow-hidden" data-testid="deploy-result">
      <div className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center"><CheckCircle2 className="w-4 h-4 text-primary" /></div>
          <div><div className="text-[14px] font-semibold text-foreground">{result.name || "Agent"} is Live</div><div className="text-[12px] text-muted-foreground">Running on {result.chain}</div></div>
        </div>
        <div className="space-y-2">
          {[["Agent ID", aid, result.agentId], ["Wallet", wid, result.wallet]].map(([label, display, full]) => (
            <div key={label as string} className="flex items-center justify-between p-2.5 rounded-lg bg-background/60">
              <div className="min-w-0 flex-1"><div className="text-[10px] text-muted-foreground uppercase tracking-wide">{label as string}</div><code className="text-[12px] text-foreground font-mono">{display}{(full as string)?.length > (display as string).length + 2 ? "..." : ""}</code></div>
              <button onClick={() => onCopy((full as string) || "")} className="p-1.5 rounded hover:bg-accent transition-colors" data-testid={`button-copy-${(label as string).toLowerCase().replace(" ", "-")}`}><Copy className="w-3.5 h-3.5 text-muted-foreground" /></button>
            </div>
          ))}
        </div>
        <div className="flex gap-2 mt-3 flex-wrap">
          <button onClick={() => onCheckStatus(result.agentId)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-[12px] font-medium hover:opacity-90 transition-opacity" data-testid="button-check-status"><Activity className="w-3 h-3" /> Check Status</button>
          <Link href="/autonomous-economy"><span className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-[12px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer" data-testid="button-view-agent"><ExternalLink className="w-3 h-3" /> Dashboard</span></Link>
          <button onClick={onBuildAnother} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-[12px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors" data-testid="button-build-another"><Plus className="w-3 h-3" /> Build Another</button>
        </div>
      </div>
    </div>
  );
}

function AgentStatusCard({ status }: { status: AgentStatusData }) {
  return (
    <div className="mt-3 rounded-xl border border-border/60 bg-card/80 backdrop-blur-sm overflow-hidden shadow-sm" data-testid="agent-status-card">
      <div className="p-4 border-b border-border/40">
        <div className="flex items-center gap-2"><div className="w-8 h-8 rounded-full bg-emerald-500/15 flex items-center justify-center"><Activity className="w-4 h-4 text-emerald-500" /></div>
          <div><div className="text-[14px] font-semibold text-foreground">{status.name}</div><div className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /><span className="text-[11px] text-emerald-500 font-medium">Active</span></div></div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-px bg-border/40">
        {[["Balance", formatBNB(status.balance), Wallet, "text-foreground"], ["Earned", formatBNB(status.totalEarned), TrendingUp, "text-emerald-500"], ["Transactions", String(status.totalTransactions), Zap, "text-foreground"], ["Net P&L", (parseFloat(status.netProfit) >= 0 ? "+" : "") + formatBNB(status.netProfit), Activity, parseFloat(status.netProfit) >= 0 ? "text-emerald-500" : "text-red-500"]].map(([label, value, Icon, color]) => {
          const I = Icon as typeof Wallet;
          return <div key={label as string} className="bg-card p-3"><div className="flex items-center gap-1.5 mb-1"><I className="w-3 h-3 text-muted-foreground" /><span className="text-[10px] text-muted-foreground uppercase tracking-wide">{label as string}</span></div><div className={`text-[14px] font-semibold ${color}`}>{value as string}</div></div>;
        })}
      </div>
    </div>
  );
}

function MyAgentsCard({ agents, onSelect }: { agents: MyAgentData[]; onSelect: (id: string) => void }) {
  return (
    <div className="mt-3 rounded-xl border border-border/60 bg-card/80 backdrop-blur-sm overflow-hidden shadow-sm" data-testid="my-agents-list">
      <div className="p-3 border-b border-border/40"><div className="text-[13px] font-semibold text-foreground">{agents.length} Agent{agents.length !== 1 ? "s" : ""}</div></div>
      <div className="divide-y divide-border/40">
        {agents.map(a => (
          <button key={a.id} onClick={() => onSelect(a.id)} className="w-full flex items-center gap-3 p-3 hover:bg-accent/40 transition-colors text-left" data-testid={`my-agent-${a.id}`}>
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0"><Terminal className="w-4 h-4 text-primary" /></div>
            <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="text-[13px] font-medium text-foreground truncate">{a.name}</span><div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" /></div><div className="text-[11px] text-muted-foreground truncate">{a.bio || a.modelType}</div></div>
            <div className="text-[10px] text-muted-foreground shrink-0">{a.createdAt ? timeAgo(a.createdAt) : ""}</div>
            <Eye className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          </button>
        ))}
      </div>
    </div>
  );
}

function CodeViewer({ files, activeFile, onSelectFile }: { files: ProjectFile[]; activeFile: string; onSelectFile: (p: string) => void }) {
  const file = files.find(f => f.path === activeFile);
  return (
    <div className="flex flex-col h-full" data-testid="code-viewer">
      <div className="flex items-center gap-1 px-3 py-2 border-b border-[#30363d] overflow-x-auto shrink-0 bg-[#161b22]">
        {files.map(f => (
          <button key={f.path} onClick={() => onSelectFile(f.path)}
            className={`px-3 py-1.5 rounded-md text-[12px] font-medium whitespace-nowrap transition-colors ${f.path === activeFile ? "bg-[#0d1117] text-white" : "text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#21262d]"}`}
            data-testid={`file-tab-${f.path}`}>
            <FileCode className="w-3 h-3 inline mr-1.5 opacity-60" />{f.path}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto bg-[#0d1117] p-4">
        <pre className="text-[13px] font-mono text-[#c9d1d9] leading-relaxed whitespace-pre-wrap break-all" data-testid="code-content">{file?.content || ""}</pre>
      </div>
    </div>
  );
}

export default function AgentBuilder() {
  const { address } = useWallet();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [config, setConfig] = useState<AgentConfig>({ ...EMPTY_CONFIG });
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDeploying, setIsDeploying] = useState(false);
  const [deployed, setDeployed] = useState(false);
  const [lastDeployedId, setLastDeployedId] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState("");
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [activeFile, setActiveFile] = useState("");
  const [rightPanel, setRightPanel] = useState<"preview" | "code">("preview");
  const [showPanel, setShowPanel] = useState(false);
  const [previewSize, setPreviewSize] = useState<"desktop" | "tablet" | "mobile">("desktop");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { toast } = useToast();

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  useEffect(() => { if (textareaRef.current) { textareaRef.current.style.height = "24px"; textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + "px"; } }, [inputValue]);

  const addMsg = (role: "user" | "assistant", content: string, extra?: Partial<ChatMessage>) => {
    setMessages(prev => [...prev, { id: uid(), role, content, timestamp: new Date(), ...extra }]);
  };
  const updateConfigField = (field: string, value: string) => {
    setConfig(prev => { const u = { ...prev, [field]: value }; setMessages(msgs => msgs.map(m => m.agentCard ? { ...m, agentCard: u } : m)); return u; });
  };
  const startNew = () => { setConfig({ ...EMPTY_CONFIG }); setDeployed(false); setPreviewHtml(""); setProjectFiles([]); setActiveFile(""); setShowPanel(false); addMsg("assistant", "Starting fresh. What do you want to build?"); textareaRef.current?.focus(); };

  const fetchAgentStatus = useCallback(async (agentId: string) => {
    try {
      const [ar, er] = await Promise.all([apiRequest("GET", `/api/web4/agents/${agentId}`), apiRequest("GET", `/api/web4/agents/${agentId}/earnings`)]);
      const [agent, earnings] = await Promise.all([ar.json(), er.json()]);
      addMsg("assistant", `Here's the current status of **${agent.name}**:`, { agentStatus: { id: agent.id, name: agent.name, balance: earnings.balanceBNB || "0", totalEarned: earnings.totalEarnedBNB || "0", totalSpent: earnings.totalSpentBNB || "0", netProfit: earnings.netProfitBNB || "0", totalTransactions: earnings.totalTransactions || 0, skills: 0, status: "active" } });
    } catch { addMsg("assistant", "Couldn't fetch agent status. Try again in a moment.", { isError: true }); }
  }, []);

  const fetchMyAgents = useCallback(async () => {
    try {
      const resp = await apiRequest("GET", `/api/web4/agents${address ? `?wallet=${address}` : ""}`);
      const agents = await resp.json();
      if (!Array.isArray(agents) || agents.length === 0) { addMsg("assistant", "No deployed agents yet. Build one to get started!"); return; }
      addMsg("assistant", "Here are your agents. Tap any one to check its live status:", { myAgentsList: agents.slice(0, 10).map((a: any) => ({ id: a.id, name: a.name, bio: a.bio || "", modelType: a.modelType || "Llama 3.3", status: "active", createdAt: a.createdAt || "" })) });
    } catch { addMsg("assistant", "Couldn't load agents. Make sure your wallet is connected.", { isError: true }); }
  }, [address]);

  const handleDeploy = async () => {
    if (isDeploying) return; setIsDeploying(true);
    addMsg("assistant", "Deploying your agent on-chain...", { isDeploying: true });
    try {
      const response = await apiRequest("POST", "/api/web4/agents/create", { name: config.name || "Unnamed Agent", bio: config.bio || "Built with BUILD4", modelType: MODEL_MAP[config.model] || MODEL_MAP.llama, initialDeposit: "100000000000000", targetChain: CHAIN_MAP[config.chain] || CHAIN_MAP.bnb });
      const agent = await response.json();
      const chainName = CHAIN_LABEL[config.chain] || "BNB Chain";
      setDeployed(true); setLastDeployedId(agent.id);
      setMessages(msgs => msgs.map(m => m.agentCard ? { ...m, agentCard: { ...m.agentCard! } } : m));
      addMsg("assistant", "Your agent is live. Check its status, view the dashboard, or build another one.", { deployResult: { agentId: agent.id, wallet: agent.wallet?.walletAddress || "Generated", chain: chainName, name: config.name } });
      toast({ title: "Deployed", description: `${config.name} is live on ${chainName}` });
    } catch (error: any) { addMsg("assistant", `Deployment failed. Connect your wallet with BNB to cover the $20 fee.\n\n${error.message || ""}`, { isError: true }); }
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

    if (isStartOverCmd(userInput)) { startNew(); setIsProcessing(false); return; }
    if (isShowAgentsCmd(userInput)) { await fetchMyAgents(); setIsProcessing(false); return; }
    if (isCheckStatusCmd(userInput) && lastDeployedId) { await fetchAgentStatus(lastDeployedId); setIsProcessing(false); return; }
    if (isDeployCmd(userInput)) { if (!config.type) { addMsg("assistant", "Nothing to deploy yet. Tell me what kind of agent you want."); } else { await handleDeploy(); } setIsProcessing(false); return; }

    const configUpdates = extractConfig(userInput, config);
    if (configUpdates && isAgentRequest(userInput)) {
      const isNew = !!configUpdates.type;
      if (isNew && deployed) { setDeployed(false); setLastDeployedId(null); }
      const updated = { ...(isNew ? EMPTY_CONFIG : config), ...configUpdates };
      setConfig(updated);
      if (isNew) { const t = AGENT_TYPES[configUpdates.type!]; addMsg("assistant", `I've configured a **${t.name}** for you. Tap any setting to change it, then hit Deploy.`, { agentCard: updated }); }
      else { const c: string[] = []; if (configUpdates.chain) c.push(`chain to **${CHAIN_LABEL[configUpdates.chain]}**`); if (configUpdates.model) c.push(`model to **${MODEL_LABEL[configUpdates.model]}**`); if (configUpdates.autonomy) c.push(`autonomy to **${AUTONOMY_LABEL[configUpdates.autonomy]}**`); if (configUpdates.name) c.push(`name to **${configUpdates.name}**`); setMessages(msgs => msgs.map(m => m.agentCard ? { ...m, agentCard: updated } : m)); addMsg("assistant", `Updated ${c.join(" and ")}.`); }
      setIsProcessing(false); return;
    }

    if (configUpdates && !isAgentRequest(userInput) && (configUpdates.chain || configUpdates.model || configUpdates.autonomy || configUpdates.name) && config.type) {
      const updated = { ...config, ...configUpdates };
      setConfig(updated);
      const c: string[] = [];
      if (configUpdates.chain) c.push(`chain to **${CHAIN_LABEL[configUpdates.chain]}**`);
      if (configUpdates.model) c.push(`model to **${MODEL_LABEL[configUpdates.model]}**`);
      if (configUpdates.autonomy) c.push(`autonomy to **${AUTONOMY_LABEL[configUpdates.autonomy]}**`);
      if (configUpdates.name) c.push(`name to **${configUpdates.name}**`);
      if (c.length > 0) { setMessages(msgs => msgs.map(m => m.agentCard ? { ...m, agentCard: updated } : m)); addMsg("assistant", `Updated ${c.join(" and ")}.`); setIsProcessing(false); return; }
    }

    try {
      const filesMap: Record<string, string> = {};
      for (const f of projectFiles) filesMap[f.path] = f.content;
      const resp = await apiRequest("POST", "/api/builder/chat", { message: userInput, config, files: filesMap });
      const data = await resp.json();
      if (data.response && !data.fallback) {
        let text = data.response || "";
        text = text.replace(/<FILES>[\s\S]*<\/FILES>/i, "").replace(/<PREVIEW>[\s\S]*<\/PREVIEW>/i, "").replace(/<FILE[\s\S]*?<\/FILE>/gi, "").trim();

        if (data.preview) {
          setPreviewHtml(data.preview);
          setShowPanel(true);
          setRightPanel("preview");
        }
        if (data.files && data.files.length > 0) {
          setProjectFiles(prev => {
            const map = new Map(prev.map(f => [f.path, f.content]));
            for (const f of data.files) map.set(f.path, f.content);
            return Array.from(map.entries()).map(([path, content]) => ({ path, content }));
          });
          setActiveFile(data.files[0].path);
          if (!data.preview && !showPanel) {
            setShowPanel(true);
            setRightPanel("code");
          }
        }
        addMsg("assistant", text || "Here's what I built:", { hasPreview: !!(data.preview || (data.files && data.files.length > 0)) });
      } else {
        addMsg("assistant", "Tell me what you want to build — a website, landing page, dashboard, app, or AI agent. I'll create it for you.");
      }
    } catch {
      addMsg("assistant", "Something went wrong. Try again or describe what you want to build.");
    }

    setIsProcessing(false);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); } };
  const sendPrompt = (text: string) => { setInputValue(text); setTimeout(() => (document.getElementById("chat-form") as HTMLFormElement)?.requestSubmit(), 30); };

  const hasMessages = messages.length > 0;
  const hasPreview = showPanel && (previewHtml || projectFiles.length > 0);
  const previewWidth = previewSize === "mobile" ? "max-w-[375px]" : previewSize === "tablet" ? "max-w-[768px]" : "w-full";

  return (
    <>
      <SEO title="Build | BUILD4" description="Build anything with AI — websites, apps, dashboards, and autonomous agents." path="/build" />
      <div className="h-screen flex flex-col bg-background" data-testid="page-agent-builder">
        <div className="flex-1 flex overflow-hidden">

          <div className={`flex-1 flex flex-col min-w-0 ${hasPreview ? "lg:max-w-[50%]" : ""}`}>
            <div className="flex-1 overflow-y-auto" data-testid="chat-area">
              {!hasMessages ? (
                <div className="h-full flex flex-col items-center justify-center px-4">
                  <div className="max-w-[560px] w-full">
                    <div className="mb-10 text-center">
                      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/8 border border-primary/15 text-primary text-[12px] font-medium mb-5">
                        <Sparkles className="w-3.5 h-3.5" /> BUILD4 AI
                      </div>
                      <h1 className="text-[32px] font-bold text-foreground tracking-tight mb-3 leading-tight" data-testid="welcome-heading">What do you want to build?</h1>
                      <p className="text-[15px] text-muted-foreground leading-relaxed max-w-[420px] mx-auto">Describe anything. I'll generate a live preview with real code you can iterate on.</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2.5 mb-5">
                      {[
                        { icon: Globe, label: "Landing Page", desc: "Modern responsive website", prompt: "Build me a modern landing page for a SaaS product", color: "blue" },
                        { icon: LayoutGrid, label: "Dashboard", desc: "Admin panel with charts", prompt: "Build me an analytics dashboard with charts and stats", color: "violet" },
                        { icon: Code2, label: "Web App", desc: "Interactive application", prompt: "Build me a task management web app", color: "emerald" },
                        { icon: Palette, label: "Portfolio", desc: "Personal portfolio site", prompt: "Build me a developer portfolio website", color: "amber" },
                      ].map(t => (
                        <button key={t.label} onClick={() => sendPrompt(t.prompt)} className="flex items-center gap-3 p-3.5 rounded-xl border border-border/60 bg-card/50 hover:bg-accent/50 hover:border-primary/25 transition-all text-left group" data-testid={`template-web-${t.label.toLowerCase().replace(/\s/g, "-")}`}>
                          <div className={`w-9 h-9 rounded-lg bg-${t.color}-500/10 flex items-center justify-center shrink-0 group-hover:bg-${t.color}-500/20 transition-colors`}><t.icon className={`w-4 h-4 text-${t.color}-500`} /></div>
                          <div className="min-w-0"><div className="text-[13px] font-semibold text-foreground">{t.label}</div><div className="text-[11px] text-muted-foreground mt-0.5">{t.desc}</div></div>
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-3 mb-4">
                      <div className="flex-1 h-px bg-border/60" />
                      <span className="text-[11px] text-muted-foreground/70 uppercase tracking-wider font-medium">or deploy an AI agent</span>
                      <div className="flex-1 h-px bg-border/60" />
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {Object.entries(AGENT_TYPES).slice(0, 6).map(([key, t]) => {
                        const Icon = t.icon;
                        return <button key={key} onClick={() => sendPrompt(t.prompt)} className="flex items-center gap-2 p-2.5 rounded-lg border border-border/60 bg-card/50 hover:bg-accent/50 hover:border-primary/25 transition-all text-left" data-testid={`template-${key}`}><Icon className={`w-3.5 h-3.5 text-${t.color}-500 shrink-0`} /><span className="text-[11px] font-medium text-foreground truncate">{t.name.replace(" Agent", "")}</span></button>;
                      })}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="max-w-[640px] mx-auto px-4 py-6 space-y-5" data-testid="chat-messages">
                  {messages.map((msg) => (
                    <div key={msg.id} className={msg.role === "user" ? "flex justify-end" : ""} data-testid={`message-${msg.id}`}>
                      {msg.role === "user" ? (
                        <div className="max-w-[85%] rounded-2xl bg-primary/10 border border-primary/15 px-4 py-2.5"><p className="text-[14px] text-foreground">{msg.content}</p></div>
                      ) : (
                        <div className="max-w-full">
                          <div className="flex gap-3">
                            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                              {msg.isDeploying ? <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" /> : msg.deployResult ? <CheckCircle2 className="w-3.5 h-3.5 text-primary" /> : msg.agentStatus ? <Activity className="w-3.5 h-3.5 text-emerald-500" /> : msg.isError ? <X className="w-3.5 h-3.5 text-destructive" /> : msg.hasPreview ? <Monitor className="w-3.5 h-3.5 text-primary" /> : <Sparkles className="w-3.5 h-3.5 text-primary" />}
                            </div>
                            <div className="min-w-0 flex-1 pt-0.5">
                              <div className={`text-[14px] leading-relaxed whitespace-pre-wrap ${msg.isError ? "text-destructive" : "text-foreground"}`}>{msg.content.split(/(\*\*.+?\*\*)/).map((part, i) => part.startsWith("**") && part.endsWith("**") ? <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong> : part)}</div>
                              {msg.hasPreview && !showPanel && (
                                <button onClick={() => { setShowPanel(true); setRightPanel("preview"); }}
                                  className="mt-2.5 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-primary/20 bg-primary/5 text-[12px] text-primary font-medium hover:bg-primary/10 transition-colors" data-testid="button-show-preview">
                                  <Eye className="w-3.5 h-3.5" /> Show Preview
                                </button>
                              )}
                            </div>
                          </div>
                          {msg.agentCard && <div className="ml-10"><AgentCard config={msg.agentCard} onDeploy={handleDeploy} onUpdate={updateConfigField} deploying={isDeploying} deployed={deployed} /></div>}
                          {msg.deployResult && <div className="ml-10"><DeployResultCard result={msg.deployResult} onCopy={(t) => { navigator.clipboard.writeText(t); toast({ title: "Copied" }); }} onBuildAnother={startNew} onCheckStatus={async (id) => { setIsProcessing(true); await fetchAgentStatus(id); setIsProcessing(false); }} /></div>}
                          {msg.agentStatus && <div className="ml-10"><AgentStatusCard status={msg.agentStatus} /></div>}
                          {msg.myAgentsList && <div className="ml-10"><MyAgentsCard agents={msg.myAgentsList} onSelect={async (id) => { setLastDeployedId(id); setIsProcessing(true); await fetchAgentStatus(id); setIsProcessing(false); }} /></div>}
                        </div>
                      )}
                    </div>
                  ))}
                  {isProcessing && (
                    <div className="flex gap-3">
                      <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/10 flex items-center justify-center shrink-0">
                        <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />
                      </div>
                      <div className="pt-2 flex gap-1">{[0,150,300].map(d => <div key={d} className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: d + "ms" }} />)}</div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>
              )}
            </div>

            <div className="shrink-0 border-t border-border/60 px-4 pb-3 pt-3 bg-background/95 backdrop-blur-lg" data-testid="chat-input-area">
              <div className={`mx-auto ${hasPreview ? "max-w-full" : "max-w-[640px]"}`}>
                <form id="chat-form" onSubmit={handleSubmit}>
                  <div className="relative border border-border/60 rounded-2xl bg-card/80 focus-within:border-primary/40 focus-within:ring-1 focus-within:ring-primary/10 transition-all shadow-sm">
                    <textarea ref={textareaRef} value={inputValue} onChange={(e) => setInputValue(e.target.value)} onKeyDown={handleKeyDown}
                      placeholder={!hasMessages ? "Describe what you want to build..." : previewHtml ? "Make changes — 'add a contact form', 'make it darker'..." : config.type ? "Customize your agent or say 'deploy'..." : "Message BUILD4..."}
                      className="w-full resize-none bg-transparent pl-4 pr-12 py-3 text-[14px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none" disabled={isProcessing || isDeploying} rows={1} style={{ minHeight: "24px", maxHeight: "200px" }} data-testid="input-command" />
                    <button type="submit" disabled={isProcessing || isDeploying || !inputValue.trim()} className="absolute right-2 bottom-2 w-8 h-8 rounded-xl bg-primary text-primary-foreground flex items-center justify-center disabled:opacity-20 hover:opacity-90 transition-all shadow-sm" data-testid="button-send">
                      {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUp className="w-4 h-4" />}
                    </button>
                  </div>
                </form>
                {!hasMessages && (
                  <div className="flex items-center justify-center gap-2 mt-2.5 flex-wrap">
                    {["Build a website", "Create a dashboard", "Trading agent", "Show my agents"].map(s => (
                      <button key={s} onClick={() => sendPrompt(s)} className="px-3 py-1.5 rounded-full border border-border/50 text-[12px] text-muted-foreground hover:text-foreground hover:bg-accent/50 hover:border-border transition-all" data-testid={`suggestion-${s.toLowerCase().replace(/\s+/g, "-")}`}>{s}</button>
                    ))}
                  </div>
                )}
                <p className="text-center text-[11px] text-muted-foreground/30 mt-2">BUILD4 — Build anything with AI. Agents cost $20 to deploy.</p>
              </div>
            </div>
          </div>

          {hasPreview && (
            <div className="hidden lg:flex flex-col w-[50%] border-l border-border/60" data-testid="right-panel">
              <div className="flex items-center justify-between px-3 h-11 border-b border-border/60 shrink-0 bg-muted/30">
                <div className="flex items-center gap-0.5">
                  <button onClick={() => setRightPanel("preview")} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all ${rightPanel === "preview" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`} data-testid="tab-preview"><Monitor className="w-3.5 h-3.5" />Preview</button>
                  <button onClick={() => setRightPanel("code")} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all ${rightPanel === "code" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`} data-testid="tab-code"><Code2 className="w-3.5 h-3.5" />Code{projectFiles.length > 0 && <span className="ml-1 px-1.5 py-0.5 rounded-full bg-muted text-[10px] text-muted-foreground">{projectFiles.length}</span>}</button>
                </div>
                <div className="flex items-center gap-0.5">
                  {rightPanel === "preview" && (
                    <>
                      <div className="flex items-center bg-muted/50 rounded-lg p-0.5 mr-1">
                        <button onClick={() => setPreviewSize("desktop")} className={`p-1.5 rounded-md transition-all ${previewSize === "desktop" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`} data-testid="size-desktop"><Monitor className="w-3.5 h-3.5" /></button>
                        <button onClick={() => setPreviewSize("tablet")} className={`p-1.5 rounded-md transition-all ${previewSize === "tablet" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`} data-testid="size-tablet"><Tablet className="w-3.5 h-3.5" /></button>
                        <button onClick={() => setPreviewSize("mobile")} className={`p-1.5 rounded-md transition-all ${previewSize === "mobile" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`} data-testid="size-mobile"><Smartphone className="w-3.5 h-3.5" /></button>
                      </div>
                      <button onClick={() => { const iframe = document.getElementById("preview-iframe") as HTMLIFrameElement; if (iframe) iframe.srcdoc = previewHtml; }} className="p-1.5 rounded-lg hover:bg-accent transition-colors text-muted-foreground hover:text-foreground" data-testid="button-refresh-preview"><RotateCcw className="w-3.5 h-3.5" /></button>
                    </>
                  )}
                  <button onClick={() => setShowPanel(false)} className="p-1.5 rounded-lg hover:bg-accent transition-colors text-muted-foreground hover:text-foreground" data-testid="button-close-panel"><PanelRightClose className="w-3.5 h-3.5" /></button>
                </div>
              </div>
              <div className="flex-1 overflow-hidden bg-white dark:bg-[#0d1117]">
                {rightPanel === "preview" ? (
                  <div className={`h-full mx-auto transition-all duration-300 ${previewWidth} ${previewSize !== "desktop" ? "border-x border-border/40" : ""}`}>
                    <iframe id="preview-iframe" className="w-full h-full border-0" data-testid="preview-iframe" sandbox="allow-scripts" srcDoc={previewHtml} />
                  </div>
                ) : (
                  projectFiles.length > 0 ? <CodeViewer files={projectFiles} activeFile={activeFile} onSelectFile={setActiveFile} /> : <div className="h-full flex items-center justify-center text-muted-foreground text-[13px]">No files generated yet</div>
                )}
              </div>
            </div>
          )}

          {!showPanel && previewHtml && hasMessages && (
            <button onClick={() => { setShowPanel(true); setRightPanel("preview"); }}
              className="hidden lg:flex fixed right-4 top-1/2 -translate-y-1/2 items-center gap-1.5 px-3 py-2.5 rounded-xl bg-card border border-border/60 shadow-lg text-[12px] text-muted-foreground hover:text-foreground hover:bg-accent hover:border-primary/20 transition-all z-10" data-testid="button-open-panel">
              <PanelRightOpen className="w-4 h-4" /> Preview
            </button>
          )}
        </div>
      </div>
    </>
  );
}
