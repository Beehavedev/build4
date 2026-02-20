import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
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
} from "lucide-react";
import { Link } from "wouter";
import { useT } from "@/lib/i18n";
import { LanguageSwitcher } from "@/components/language-switcher";
import { WalletConnector } from "@/components/wallet-connector";
import { useWallet } from "@/hooks/use-wallet";
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

const CHAINS = [
  { id: "bnb", name: "BNB Chain", chainId: 56, testnetId: 97, currency: "BNB" },
  { id: "base", name: "Base", chainId: 8453, testnetId: 84532, currency: "ETH" },
  { id: "xlayer", name: "XLayer", chainId: 196, testnetId: 1952, currency: "OKB" },
] as const;

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

  const activeChain = CHAINS.find(c => c.id === selectedChain) || CHAINS[0];

  const { data: agentsList = [], isLoading: agentsLoading } = useQuery<Agent[]>({
    queryKey: ["/api/web4/agents"],
    refetchInterval: 15000,
  });

  const selectedAgent = agentsList.find((a) => a.id === selectedAgentId) || agentsList[0];
  const agentId = selectedAgent?.id;

  const { data: walletData } = useQuery<{ wallet: AgentWallet; transactions: AgentTransaction[] }>({
    queryKey: ["/api/web4/wallet", agentId],
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

  const depositMutation = useMutation({
    mutationFn: async (amount: string) => {
      await apiRequest("POST", "/api/web4/wallet/deposit", { agentId, amount });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/web4/wallet", agentId] });
      queryClient.invalidateQueries({ queryKey: ["/api/web4/survival", agentId] });
      toast({ title: t("dashboard.depositSuccess") });
    },
    onError: (e: Error) => toast({ title: t("dashboard.depositFailed"), description: e.message, variant: "destructive" }),
  });

  const withdrawMutation = useMutation({
    mutationFn: async (amount: string) => {
      await apiRequest("POST", "/api/web4/wallet/withdraw", { agentId, amount });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/web4/wallet", agentId] });
      queryClient.invalidateQueries({ queryKey: ["/api/web4/survival", agentId] });
      toast({ title: t("dashboard.withdrawSuccess") });
    },
    onError: (e: Error) => toast({ title: t("dashboard.withdrawFailed"), description: e.message, variant: "destructive" }),
  });

  const transferMutation = useMutation({
    mutationFn: async ({ toAgentId, amount }: { toAgentId: string; amount: string }) => {
      await apiRequest("POST", "/api/web4/transfer", { fromAgentId: agentId, toAgentId, amount });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/web4/wallet"] });
      queryClient.invalidateQueries({ queryKey: ["/api/web4/survival"] });
      toast({ title: t("dashboard.transferSuccess") });
    },
    onError: (e: Error) => toast({ title: t("dashboard.transferFailed"), description: e.message, variant: "destructive" }),
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

  const replicateMutation = useMutation({
    mutationFn: async ({ childName, fundingAmount }: { childName: string; fundingAmount: string }) => {
      await apiRequest("POST", "/api/web4/replicate", { parentAgentId: agentId, childName, revenueShareBps: 1000, fundingAmount });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/web4/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/web4/lineage", agentId] });
      queryClient.invalidateQueries({ queryKey: ["/api/web4/wallet", agentId] });
      toast({ title: t("dashboard.replicatedSuccess") });
    },
    onError: (e: Error) => toast({ title: t("dashboard.replicationFailed"), description: e.message, variant: "destructive" }),
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
    summary: { total: number; live: number; simulated: number; decentralized: number };
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
      const isLive = data?.request?.response && !data.request.response.startsWith("[SIMULATED") && !data.request.response.startsWith("[FALLBACK");
      toast({
        title: isLive ? t("dashboard.liveInference") : t("dashboard.simInference"),
        description: `${t("dashboard.routedVia")} ${providerName}${isLive ? ` (${t("dashboard.decentralizedLabel")})` : ` (${t("dashboard.noApiKeyLabel")})`}`,
      });
    },
    onError: (e: Error) => toast({ title: t("dashboard.inferenceFailed"), description: e.message, variant: "destructive" }),
  });

  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentBio, setNewAgentBio] = useState("");
  const [newAgentModel, setNewAgentModel] = useState("meta-llama/Llama-3.1-70B-Instruct");
  const [newAgentDeposit, setNewAgentDeposit] = useState("100000000000000000");
  const [createAgentStep, setCreateAgentStep] = useState<string | null>(null);

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

      setCreateAgentStep("Creating agent record...");
      const res = await apiRequest("POST", "/api/web4/agents/create", {
        name: newAgentName,
        bio: newAgentBio || undefined,
        modelType: newAgentModel,
        initialDeposit: newAgentDeposit,
      });
      const data = await res.json();
      const agentId = data.agent?.id;
      if (!agentId) throw new Error("Failed to create agent record");

      const numericId = Number(uuidToNumericId(agentId));
      const depositEth = (Number(newAgentDeposit) / 1e18).toString();

      setCreateAgentStep("Waiting for wallet signature — register agent on-chain...");
      try {
        await web3.registerAgent(numericId);
      } catch (regErr: any) {
        if (!regErr.message?.includes("already registered")) {
          throw new Error(`On-chain registration failed: ${regErr.shortMessage || regErr.message}`);
        }
      }

      setCreateAgentStep("Waiting for wallet signature — deposit " + depositEth + " to agent...");
      try {
        const receipt = await web3.depositToAgent(numericId, depositEth);
        return { ...data, onchainTx: receipt?.hash };
      } catch (depErr: any) {
        throw new Error(`On-chain deposit failed: ${depErr.shortMessage || depErr.message}`);
      }
    },
    onSuccess: (data: any) => {
      setCreateAgentStep(null);
      queryClient.invalidateQueries({ queryKey: ["/api/web4/agents"] });
      setSelectedAgentId(data.agent?.id || null);
      setShowCreateAgent(false);
      setNewAgentName("");
      setNewAgentBio("");
      const txMsg = data.onchainTx ? ` — tx: ${data.onchainTx.slice(0, 10)}...` : "";
      toast({ title: "Agent created", description: `${data.agent?.name} is live with on-chain wallet${txMsg}` });
    },
    onError: (e: Error) => {
      setCreateAgentStep(null);
      toast({ title: "Creation failed", description: e.message, variant: "destructive" });
    },
  });

  const [inferencePrompt, setInferencePrompt] = useState("");
  const [inferencePreferDecentralized, setInferencePreferDecentralized] = useState(true);

  const [depositAmt, setDepositAmt] = useState("1000000000000000000");
  const [withdrawAmt, setWithdrawAmt] = useState("100000000000000000");
  const [transferTo, setTransferTo] = useState("");
  const [transferAmt, setTransferAmt] = useState("100000000000000000");
  const [evolveModel, setEvolveModel] = useState("meta-llama/Llama-3.1-70B-Instruct");
  const [evolveReason, setEvolveReason] = useState("");
  const [childName, setChildName] = useState("");
  const [childFunding, setChildFunding] = useState("500000000000000000");
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

  const wallet = walletData?.wallet;
  const transactions = walletData?.transactions || [];
  const survival = survivalData?.status;

  return (
    <div className="min-h-screen bg-background">
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
                {agentsList.map((a) => (
                  <option key={a.id} value={a.id}>{a.name} ({a.modelType})</option>
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
                  {agentsList.map((a) => (
                    <option key={a.id} value={a.id}>{a.name} ({a.modelType})</option>
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
          <div className="relative z-10 w-full max-w-lg mx-4 bg-card border rounded-lg shadow-lg p-5 sm:p-6">
            <div className="flex items-center gap-2 mb-4">
              <Bot className="w-4 h-4 text-primary" />
              <span className="font-mono text-sm font-semibold">Create New Agent</span>
              <Badge variant="secondary" className="text-[10px] ml-auto">0.025 BNB creation fee</Badge>
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
              <div className="space-y-2">
                <label className="font-mono text-xs text-muted-foreground">Initial Deposit</label>
                <select
                  value={newAgentDeposit}
                  onChange={(e) => setNewAgentDeposit(e.target.value)}
                  className="w-full font-mono text-sm bg-background border rounded-md px-3 py-2"
                  data-testid="select-agent-deposit"
                  disabled={createAgentMutation.isPending}
                >
                  <option value="50000000000000000">0.05 BNB</option>
                  <option value="100000000000000000">0.1 BNB</option>
                  <option value="250000000000000000">0.25 BNB</option>
                  <option value="500000000000000000">0.5 BNB</option>
                  <option value="1000000000000000000">1.0 BNB</option>
                </select>
                <p className="font-mono text-[10px] text-muted-foreground">
                  Sent from your wallet to the on-chain agent contract
                </p>
              </div>
              <div className="flex items-end gap-2">
                <Button
                  onClick={() => createAgentMutation.mutate()}
                  disabled={!newAgentName.trim() || createAgentMutation.isPending || !web3.connected}
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
                      {evolutionData?.currentProfile?.modelName || selectedAgent.modelType}
                    </Badge>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
                  <div className="text-center p-2">
                    <div className="font-mono text-lg font-bold text-primary" data-testid="text-wallet-balance">{formatShortCredits(wallet?.balance || "0")}</div>
                    <div className="text-xs text-muted-foreground">{t("dashboard.balance")}</div>
                  </div>
                  <div className="text-center p-2">
                    <div className="font-mono text-lg font-bold text-primary" data-testid="text-wallet-earned">{formatShortCredits(wallet?.totalEarned || "0")}</div>
                    <div className="text-xs text-muted-foreground">{t("dashboard.earned")}</div>
                  </div>
                  <div className="text-center p-2">
                    <div className="font-mono text-lg font-bold text-red-400" data-testid="text-wallet-spent">{formatShortCredits(wallet?.totalSpent || "0")}</div>
                    <div className="text-xs text-muted-foreground">{t("dashboard.spent")}</div>
                  </div>
                  <div className="text-center p-2">
                    <div className="font-mono text-lg font-bold" data-testid="text-turns-alive">{survival?.turnsAlive || 0}</div>
                    <div className="text-xs text-muted-foreground">{t("dashboard.turnsAlive")}</div>
                  </div>
                </div>
              </Card>
              <TerminalLine prefix=">" dim>ID: {selectedAgent.id}</TerminalLine>
            </div>
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
                    {runnerStatus?.mode === "live" ? "LIVE INFERENCE" : "SIMULATION"}
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
                    <div className="font-mono text-sm font-bold">{agentsList.length}</div>
                    <div className="text-[10px] text-muted-foreground">Active Agents</div>
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
                  No API keys configured. Agents use simulated inference. Add HYPERBOLIC_API_KEY or AKASH_API_KEY for real decentralized compute.
                </div>
              )}
              {runnerStatus?.onchain?.enabled && (
                <div className="mt-3 p-2 rounded border border-primary/30 bg-primary/5">
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="font-mono text-xs font-bold">On-Chain Bridge: ACTIVE</span>
                    <Badge variant="default" className="text-[9px] h-4">BNB Testnet</Badge>
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
                  href="https://testnet.bscscan.com/address/0x913a46e2D65C6F76CF4A4AD96B1c7913d5e324d9"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-primary hover:underline font-mono mt-2 block"
                  data-testid="link-deployer-bscscan"
                >
                  View all on BscScan Testnet
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
                      {parseFloat(web3.balance || "0").toFixed(4)} {activeChain.currency}
                    </div>
                  </div>
                  {!web3.hasContracts && (
                    <div className="mt-2 text-[10px] text-destructive font-mono">No contracts found on this network. Switch to BNB Testnet or XLayer Testnet.</div>
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
                        <ArrowDownLeft className="w-3 h-3 text-primary" /> On-Chain Deposit
                      </div>
                      <input
                        type="text"
                        placeholder="Amount (e.g. 0.01)"
                        value={onChainDeposit}
                        onChange={(e) => setOnChainDeposit(e.target.value)}
                        className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5"
                        data-testid="input-onchain-deposit"
                      />
                      <Button
                        size="sm"
                        className="w-full"
                        disabled={!web3.hasContracts || onChainLoading === "deposit"}
                        data-testid="button-onchain-deposit"
                        onClick={async () => {
                          try {
                            setOnChainLoading("deposit");
                            const agentNumId = parseInt(agentId || "1");
                            const receipt = await web3.depositToAgent(agentNumId, onChainDeposit);
                            setLastTxHash(receipt.hash);
                            toast({ title: "Deposit successful", description: `${onChainDeposit} ${activeChain.currency} deposited on-chain` });
                          } catch (err: any) {
                            toast({ title: "Deposit failed", description: err.message, variant: "destructive" });
                          } finally {
                            setOnChainLoading(null);
                          }
                        }}
                      >
                        {onChainLoading === "deposit" ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                        <span className="ml-1">Deposit {onChainDeposit} {activeChain.currency}</span>
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
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full"
                        disabled={!web3.hasContracts || onChainLoading === "withdraw"}
                        data-testid="button-onchain-withdraw"
                        onClick={async () => {
                          try {
                            setOnChainLoading("withdraw");
                            const agentNumId = parseInt(agentId || "1");
                            const receipt = await web3.withdrawFromAgent(agentNumId, onChainWithdraw, web3.address!);
                            setLastTxHash(receipt.hash);
                            toast({ title: "Withdrawal successful", description: `${onChainWithdraw} ${activeChain.currency} withdrawn to your wallet` });
                          } catch (err: any) {
                            toast({ title: "Withdraw failed", description: err.message, variant: "destructive" });
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
                          const agentNumId = parseInt(agentId || "1");
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
                    {onChainAgentWallet && (
                      <div className="grid grid-cols-2 gap-2 mt-2">
                        <div className="p-2 bg-muted/30 rounded">
                          <div className="text-[9px] text-muted-foreground">Balance</div>
                          <div className="font-mono text-xs font-bold text-primary" data-testid="text-onchain-balance">{onChainAgentWallet.balance} {activeChain.currency}</div>
                        </div>
                        <div className="p-2 bg-muted/30 rounded">
                          <div className="text-[9px] text-muted-foreground">Status</div>
                          <div className="font-mono text-xs font-bold" data-testid="text-onchain-registered">
                            {onChainAgentWallet.isRegistered ? "Registered" : "Not Registered"}
                          </div>
                        </div>
                        <div className="p-2 bg-muted/30 rounded">
                          <div className="text-[9px] text-muted-foreground">Earned</div>
                          <div className="font-mono text-xs">{onChainAgentWallet.totalEarned}</div>
                        </div>
                        <div className="p-2 bg-muted/30 rounded">
                          <div className="text-[9px] text-muted-foreground">Tier</div>
                          <div className="font-mono text-xs">{["DEAD", "CRITICAL", "LOW", "NORMAL"][onChainAgentWallet.tier] || "Unknown"}</div>
                        </div>
                      </div>
                    )}
                    {onChainAgentWallet && !onChainAgentWallet.isRegistered && (
                      <Button
                        size="sm"
                        className="w-full mt-1"
                        disabled={onChainLoading === "register"}
                        data-testid="button-register-agent"
                        onClick={async () => {
                          try {
                            setOnChainLoading("register");
                            const agentNumId = parseInt(agentId || "1");
                            const receipt = await web3.registerAgent(agentNumId);
                            setLastTxHash(receipt.hash);
                            toast({ title: "Agent registered on-chain" });
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
                          const agentNumId = parseInt(agentId || "1");
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
                              const agentNumId = parseInt(agentId || "1");
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
                                const agentNumId = parseInt(agentId || "1");
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
                          const agentNumId = parseInt(agentId || "1");
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

                    <div className="space-y-2 mt-2 pt-2 border-t">
                      <div className="text-xs font-mono font-semibold">On-Chain Replication</div>
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          type="number"
                          placeholder="Child Agent ID"
                          className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5"
                          data-testid="input-onchain-child-id"
                          id="onchain-child-id"
                        />
                        <input
                          type="text"
                          placeholder="Funding (e.g. 0.01)"
                          className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5"
                          data-testid="input-onchain-repl-funding"
                          id="onchain-repl-funding"
                          defaultValue="0.01"
                        />
                      </div>
                      <Button
                        size="sm"
                        className="w-full"
                        disabled={!web3.hasContracts || onChainLoading === "replicate"}
                        data-testid="button-onchain-replicate"
                        onClick={async () => {
                          try {
                            setOnChainLoading("replicate");
                            const parentNumId = parseInt(agentId || "1");
                            const childIdEl = document.getElementById("onchain-child-id") as HTMLInputElement;
                            const fundingEl = document.getElementById("onchain-repl-funding") as HTMLInputElement;
                            const childId = parseInt(childIdEl?.value || "100");
                            const funding = fundingEl?.value || "0.01";
                            const receipt = await web3.replicateOnChain(parentNumId, childId, 1000, funding);
                            setLastTxHash(receipt.hash);
                            toast({ title: "Agent replicated on-chain", description: `Child #${childId} created with ${funding} ${activeChain.currency} funding and 10% revenue share` });
                            const data = await web3.getLineageOnChain(parentNumId);
                            setOnChainLineage(data);
                          } catch (err: any) {
                            toast({ title: "Replication failed", description: err.message, variant: "destructive" });
                          } finally {
                            setOnChainLoading(null);
                          }
                        }}
                      >
                        {onChainLoading === "replicate" ? <RefreshCw className="w-3 h-3 animate-spin" /> : <GitBranch className="w-3 h-3" />}
                        <span className="ml-1">Replicate On-Chain</span>
                      </Button>
                      <div className="text-[9px] text-muted-foreground font-mono">
                        Creates a child agent on-chain with funding from parent. Max 50% revenue share, max 10 generations.
                      </div>
                    </div>
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
                <div className="font-mono font-bold text-primary" data-testid="text-detail-balance">{formatCredits(wallet?.balance || "0")} {activeChain.currency}</div>
              </Card>
              <Card className="p-3">
                <div className="text-xs text-muted-foreground mb-1">{t("dashboard.totalEarned")}</div>
                <div className="font-mono font-bold text-primary">{formatCredits(wallet?.totalEarned || "0")} {activeChain.currency}</div>
              </Card>
              <Card className="p-3">
                <div className="text-xs text-muted-foreground mb-1">{t("dashboard.totalSpent")}</div>
                <div className="font-mono font-bold text-red-400">{formatCredits(wallet?.totalSpent || "0")} {activeChain.currency}</div>
              </Card>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-3">
              <Card className="p-3 space-y-2">
                <div className="text-xs font-mono font-semibold flex items-center gap-1"><ArrowDownLeft className="w-3 h-3 text-primary" /> {t("dashboard.deposit")}</div>
                <select value={depositAmt} onChange={(e) => setDepositAmt(e.target.value)} className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5" data-testid="select-deposit-amount">
                  <option value="100000000000000000">0.1 {activeChain.currency}</option>
                  <option value="500000000000000000">0.5 {activeChain.currency}</option>
                  <option value="1000000000000000000">1.0 {activeChain.currency}</option>
                  <option value="5000000000000000000">5.0 {activeChain.currency}</option>
                </select>
                <Button size="sm" className="w-full" onClick={() => depositMutation.mutate(depositAmt)} disabled={depositMutation.isPending} data-testid="button-deposit">
                  {depositMutation.isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                  <span className="ml-1">{t("dashboard.deposit")}</span>
                </Button>
              </Card>
              <Card className="p-3 space-y-2">
                <div className="text-xs font-mono font-semibold flex items-center gap-1"><ArrowUpRight className="w-3 h-3 text-red-400" /> {t("dashboard.withdraw")}</div>
                <select value={withdrawAmt} onChange={(e) => setWithdrawAmt(e.target.value)} className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5" data-testid="select-withdraw-amount">
                  <option value="10000000000000000">0.01 {activeChain.currency}</option>
                  <option value="100000000000000000">0.1 {activeChain.currency}</option>
                  <option value="500000000000000000">0.5 {activeChain.currency}</option>
                  <option value="1000000000000000000">1.0 {activeChain.currency}</option>
                </select>
                <Button size="sm" variant="outline" className="w-full" onClick={() => withdrawMutation.mutate(withdrawAmt)} disabled={withdrawMutation.isPending} data-testid="button-withdraw">
                  {withdrawMutation.isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <ArrowUpRight className="w-3 h-3" />}
                  <span className="ml-1">{t("dashboard.withdraw")}</span>
                </Button>
              </Card>
              <Card className="p-3 space-y-2">
                <div className="text-xs font-mono font-semibold flex items-center gap-1"><Send className="w-3 h-3 text-primary/70" /> {t("dashboard.transfer")}</div>
                <select value={transferTo} onChange={(e) => setTransferTo(e.target.value)} className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5" data-testid="select-transfer-to">
                  <option value="">{t("dashboard.selectRecipient")}</option>
                  {agentsList.filter(a => a.id !== agentId).map(a => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
                <Button size="sm" variant="outline" className="w-full" onClick={() => transferTo && transferMutation.mutate({ toAgentId: transferTo, amount: transferAmt })} disabled={!transferTo || transferMutation.isPending} data-testid="button-transfer">
                  {transferMutation.isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                  <span className="ml-1">{t("dashboard.send")} 0.1 {activeChain.currency}</span>
                </Button>
              </Card>
            </div>

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
                          href={`https://testnet.bscscan.com/tx/${tx.txHash}`}
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
            <TerminalLine prefix="$">agent.replicate()</TerminalLine>

            {lineageData?.parent && (
              <Card className="p-3">
                <div className="text-xs text-muted-foreground mb-1">{t("dashboard.parentAgent")}</div>
                <div className="font-mono font-semibold">{lineageData.parent.agent?.name || "Unknown"}</div>
                <div className="text-xs text-muted-foreground">{t("dashboard.revenueShare")}: {lineageData.parent.revenueShareBps / 100}%</div>
              </Card>
            )}

            <Card className="p-3 space-y-2">
              <div className="text-xs font-mono font-semibold">{t("dashboard.spawnChild")}</div>
              <input type="text" placeholder={t("dashboard.childNamePlaceholder")} value={childName} onChange={(e) => setChildName(e.target.value)} className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5" data-testid="input-child-name" />
              <select value={childFunding} onChange={(e) => setChildFunding(e.target.value)} className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5" data-testid="select-child-funding">
                <option value="100000000000000000">{t("dashboard.fund")} 0.1 {activeChain.currency}</option>
                <option value="500000000000000000">{t("dashboard.fund")} 0.5 {activeChain.currency}</option>
                <option value="1000000000000000000">{t("dashboard.fund")} 1.0 {activeChain.currency}</option>
              </select>
              <Button size="sm" className="w-full" onClick={() => childName && replicateMutation.mutate({ childName, fundingAmount: childFunding })} disabled={!childName || replicateMutation.isPending} data-testid="button-replicate">
                {replicateMutation.isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <GitBranch className="w-3 h-3" />}
                <span className="ml-1">{t("dashboard.replicate")}</span>
              </Button>
            </Card>

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
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-muted-foreground mb-1">{t("dashboard.turnsAlive")}</div>
                    <div className="font-mono text-2xl font-bold">{survival.turnsAlive}</div>
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
                {agentsList.filter(a => a.id !== agentId).map(a => (
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
                    {inferenceStatus.summary.live > 0 ? t("dashboard.live") : t("dashboard.simulation")}
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
                        {isLive ? t("dashboard.live") : t("dashboard.sim")}
                      </Badge>
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[10px] text-muted-foreground font-mono">{t("dashboard.status")}</span>
                        <div className="flex items-center gap-1">
                          <div className={`w-1.5 h-1.5 rounded-full ${isLive ? "bg-green-500 animate-pulse" : "bg-muted-foreground/40"}`} />
                          <span className={`font-mono text-[10px] ${isLive ? "text-green-500" : "text-muted-foreground"}`}>
                            {isLive ? t("dashboard.connected") : t("dashboard.simulationLower")}
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
                    const isLiveResult = req.response && !req.response.startsWith("[SIMULATED") && !req.response.startsWith("[FALLBACK");
                    return (
                      <Card key={req.id} className="p-3" data-testid={`card-inference-${req.id}`}>
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <Badge variant="default" className="text-[10px] font-mono">
                            {provider?.name || "Unknown"}
                          </Badge>
                          <Badge variant="outline" className="text-[10px] font-mono">{req.model?.split("/").pop()}</Badge>
                          <Badge variant={isLiveResult ? "default" : "secondary"} className="text-[10px] font-mono">
                            {isLiveResult ? t("dashboard.live") : t("dashboard.sim")}
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
