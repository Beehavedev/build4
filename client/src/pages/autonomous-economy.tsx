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

export default function AutonomousEconomy() {
  const t = useT();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const { toast } = useToast();

  const { data: agentsList = [], isLoading: agentsLoading } = useQuery<Agent[]>({
    queryKey: ["/api/web4/agents"],
  });

  const selectedAgent = agentsList.find((a) => a.id === selectedAgentId) || agentsList[0];
  const agentId = selectedAgent?.id;

  const { data: walletData } = useQuery<{ wallet: AgentWallet; transactions: AgentTransaction[] }>({
    queryKey: ["/api/web4/wallet", agentId],
    enabled: !!agentId,
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
  });

  const { data: auditLogs = [] } = useQuery<AgentAuditLog[]>({
    queryKey: ["/api/web4/audit", agentId],
    enabled: !!agentId,
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
      toast({ title: "Deposit successful" });
    },
    onError: (e: Error) => toast({ title: "Deposit failed", description: e.message, variant: "destructive" }),
  });

  const withdrawMutation = useMutation({
    mutationFn: async (amount: string) => {
      await apiRequest("POST", "/api/web4/wallet/withdraw", { agentId, amount });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/web4/wallet", agentId] });
      queryClient.invalidateQueries({ queryKey: ["/api/web4/survival", agentId] });
      toast({ title: "Withdrawal successful" });
    },
    onError: (e: Error) => toast({ title: "Withdrawal failed", description: e.message, variant: "destructive" }),
  });

  const transferMutation = useMutation({
    mutationFn: async ({ toAgentId, amount }: { toAgentId: string; amount: string }) => {
      await apiRequest("POST", "/api/web4/transfer", { fromAgentId: agentId, toAgentId, amount });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/web4/wallet"] });
      queryClient.invalidateQueries({ queryKey: ["/api/web4/survival"] });
      toast({ title: "Transfer successful" });
    },
    onError: (e: Error) => toast({ title: "Transfer failed", description: e.message, variant: "destructive" }),
  });

  const evolveMutation = useMutation({
    mutationFn: async ({ toModel, reason }: { toModel: string; reason: string }) => {
      await apiRequest("POST", "/api/web4/evolve", { agentId, toModel, reason });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/web4/evolutions", agentId] });
      queryClient.invalidateQueries({ queryKey: ["/api/web4/agents"] });
      toast({ title: "Evolution triggered" });
    },
    onError: (e: Error) => toast({ title: "Evolution failed", description: e.message, variant: "destructive" }),
  });

  const replicateMutation = useMutation({
    mutationFn: async ({ childName, fundingAmount }: { childName: string; fundingAmount: string }) => {
      await apiRequest("POST", "/api/web4/replicate", { parentAgentId: agentId, childName, revenueShareBps: 1000, fundingAmount });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/web4/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/web4/lineage", agentId] });
      queryClient.invalidateQueries({ queryKey: ["/api/web4/wallet", agentId] });
      toast({ title: "Agent replicated successfully" });
    },
    onError: (e: Error) => toast({ title: "Replication failed", description: e.message, variant: "destructive" }),
  });

  const soulMutation = useMutation({
    mutationFn: async ({ entry, entryType }: { entry: string; entryType: string }) => {
      await apiRequest("POST", "/api/web4/soul", { agentId, entry, entryType });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/web4/soul", agentId] });
      toast({ title: "Soul entry recorded" });
    },
    onError: (e: Error) => toast({ title: "Failed to record entry", description: e.message, variant: "destructive" }),
  });

  const messageMutation = useMutation({
    mutationFn: async ({ toAgentId, subject, body }: { toAgentId: string; subject: string; body: string }) => {
      await apiRequest("POST", "/api/web4/messages", { fromAgentId: agentId, toAgentId, subject, body });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/web4/messages"] });
      toast({ title: "Message sent" });
    },
    onError: (e: Error) => toast({ title: "Failed to send message", description: e.message, variant: "destructive" }),
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
      toast({ title: "Skill purchased" });
    },
    onError: (e: Error) => toast({ title: "Purchase failed", description: e.message, variant: "destructive" }),
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
        title: isLive ? "Live inference completed" : "Simulated inference completed",
        description: `Routed via ${providerName}${isLive ? " (decentralized)" : " (no API key configured)"}`,
      });
    },
    onError: (e: Error) => toast({ title: "Inference failed", description: e.message, variant: "destructive" }),
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
          Initializing agent economy...
        </div>
      </div>
    );
  }

  const wallet = walletData?.wallet;
  const transactions = walletData?.transactions || [];
  const survival = survivalData?.status;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b sticky top-0 z-50 bg-background/95 backdrop-blur">
        <div className="max-w-5xl mx-auto px-3 sm:px-4 py-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <Link href="/">
              <Button variant="ghost" size="icon" data-testid="button-back-home">
                <ArrowLeft className="w-4 h-4" />
              </Button>
            </Link>
            <div className="flex items-center gap-2 min-w-0">
              <Terminal className="w-4 h-4 text-primary flex-shrink-0" />
              <span className="font-mono font-bold text-sm tracking-wider flex-shrink-0">BUILD<span className="text-primary">4</span></span>
              <span className="text-muted-foreground font-mono text-xs hidden sm:inline">{t("dashboard.breadcrumb")}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <LanguageSwitcher />
            <select
              value={agentId || ""}
              onChange={(e) => setSelectedAgentId(e.target.value)}
              className="font-mono text-xs bg-card border rounded-md px-2 sm:px-3 py-2 min-w-0 sm:min-w-[180px] max-w-[140px] sm:max-w-none"
              data-testid="select-agent"
            >
              {agentsList.map((a) => (
                <option key={a.id} value={a.id}>{a.name} ({a.modelType})</option>
              ))}
            </select>
          </div>
        </div>
      </header>

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
                    <div className="text-xs text-muted-foreground">Balance</div>
                  </div>
                  <div className="text-center p-2">
                    <div className="font-mono text-lg font-bold text-primary" data-testid="text-wallet-earned">{formatShortCredits(wallet?.totalEarned || "0")}</div>
                    <div className="text-xs text-muted-foreground">Earned</div>
                  </div>
                  <div className="text-center p-2">
                    <div className="font-mono text-lg font-bold text-red-400" data-testid="text-wallet-spent">{formatShortCredits(wallet?.totalSpent || "0")}</div>
                    <div className="text-xs text-muted-foreground">Spent</div>
                  </div>
                  <div className="text-center p-2">
                    <div className="font-mono text-lg font-bold" data-testid="text-turns-alive">{survival?.turnsAlive || 0}</div>
                    <div className="text-xs text-muted-foreground">Turns Alive</div>
                  </div>
                </div>
              </Card>
              <TerminalLine prefix=">" dim>ID: {selectedAgent.id}</TerminalLine>
            </div>
          )}
        </Section>

        <Section title={t("dashboard.wallet")} icon={Wallet} count={transactions.length}>
          <div className="space-y-3">
            <TerminalLine prefix="$">wallet.status()</TerminalLine>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <Card className="p-3">
                <div className="text-xs text-muted-foreground mb-1">Balance</div>
                <div className="font-mono font-bold text-primary" data-testid="text-detail-balance">{formatCredits(wallet?.balance || "0")} credits</div>
              </Card>
              <Card className="p-3">
                <div className="text-xs text-muted-foreground mb-1">Total Earned</div>
                <div className="font-mono font-bold text-primary">{formatCredits(wallet?.totalEarned || "0")} credits</div>
              </Card>
              <Card className="p-3">
                <div className="text-xs text-muted-foreground mb-1">Total Spent</div>
                <div className="font-mono font-bold text-red-400">{formatCredits(wallet?.totalSpent || "0")} credits</div>
              </Card>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-3">
              <Card className="p-3 space-y-2">
                <div className="text-xs font-mono font-semibold flex items-center gap-1"><ArrowDownLeft className="w-3 h-3 text-primary" /> Deposit</div>
                <select value={depositAmt} onChange={(e) => setDepositAmt(e.target.value)} className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5" data-testid="select-deposit-amount">
                  <option value="100000000000000000">0.1 credits</option>
                  <option value="500000000000000000">0.5 credits</option>
                  <option value="1000000000000000000">1.0 credits</option>
                  <option value="5000000000000000000">5.0 credits</option>
                </select>
                <Button size="sm" className="w-full" onClick={() => depositMutation.mutate(depositAmt)} disabled={depositMutation.isPending} data-testid="button-deposit">
                  {depositMutation.isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                  <span className="ml-1">Deposit</span>
                </Button>
              </Card>
              <Card className="p-3 space-y-2">
                <div className="text-xs font-mono font-semibold flex items-center gap-1"><ArrowUpRight className="w-3 h-3 text-red-400" /> Withdraw</div>
                <select value={withdrawAmt} onChange={(e) => setWithdrawAmt(e.target.value)} className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5" data-testid="select-withdraw-amount">
                  <option value="10000000000000000">0.01 credits</option>
                  <option value="100000000000000000">0.1 credits</option>
                  <option value="500000000000000000">0.5 credits</option>
                  <option value="1000000000000000000">1.0 credits</option>
                </select>
                <Button size="sm" variant="outline" className="w-full" onClick={() => withdrawMutation.mutate(withdrawAmt)} disabled={withdrawMutation.isPending} data-testid="button-withdraw">
                  {withdrawMutation.isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <ArrowUpRight className="w-3 h-3" />}
                  <span className="ml-1">Withdraw</span>
                </Button>
              </Card>
              <Card className="p-3 space-y-2">
                <div className="text-xs font-mono font-semibold flex items-center gap-1"><Send className="w-3 h-3 text-primary/70" /> Transfer</div>
                <select value={transferTo} onChange={(e) => setTransferTo(e.target.value)} className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5" data-testid="select-transfer-to">
                  <option value="">Select recipient...</option>
                  {agentsList.filter(a => a.id !== agentId).map(a => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
                <Button size="sm" variant="outline" className="w-full" onClick={() => transferTo && transferMutation.mutate({ toAgentId: transferTo, amount: transferAmt })} disabled={!transferTo || transferMutation.isPending} data-testid="button-transfer">
                  {transferMutation.isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                  <span className="ml-1">Send 0.1 credits</span>
                </Button>
              </Card>
            </div>

            {transactions.length > 0 && (
              <div className="mt-3">
                <div className="text-xs font-mono font-semibold mb-2 text-muted-foreground">Recent Transactions</div>
                <div className="space-y-1">
                  {transactions.slice(0, 10).map((tx) => (
                    <div key={tx.id} className="flex items-center gap-2 font-mono text-xs py-1 border-b border-border last:border-0" data-testid={`row-transaction-${tx.id}`}>
                      <span className={tx.type.startsWith("earn") || tx.type === "deposit" || tx.type === "revenue_share" ? "text-primary" : "text-red-400"}>
                        {tx.type.startsWith("earn") || tx.type === "deposit" || tx.type === "revenue_share" ? "+" : "-"}
                      </span>
                      <span className="font-semibold">{formatShortCredits(tx.amount)}</span>
                      <span className="text-muted-foreground flex-1 truncate">{tx.description || tx.type}</span>
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
                <div className="text-xs font-mono font-semibold text-muted-foreground">Your Skills</div>
                {skills.map((skill) => (
                  <Card key={skill.id} className="p-3" data-testid={`card-skill-${skill.id}`}>
                    <div className="flex items-start justify-between gap-2 flex-wrap">
                      <div>
                        <div className="font-mono font-semibold text-sm">{skill.name}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">{skill.description}</div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="font-mono text-sm font-bold text-primary">{formatShortCredits(skill.priceAmount)}</div>
                        <div className="text-[10px] text-muted-foreground">{skill.totalPurchases} sales</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      <Badge variant="outline" className="text-[10px]">{skill.category}</Badge>
                      <Badge variant={skill.isActive ? "default" : "secondary"} className="text-[10px]">{skill.isActive ? "Active" : "Inactive"}</Badge>
                    </div>
                  </Card>
                ))}
              </div>
            )}

            {allSkills.filter(s => s.agentId !== agentId).length > 0 && (
              <div className="space-y-2 mt-4">
                <div className="text-xs font-mono font-semibold text-muted-foreground">Available from Other Agents</div>
                {allSkills.filter(s => s.agentId !== agentId).map((skill) => {
                  const seller = agentsList.find(a => a.id === skill.agentId);
                  return (
                    <Card key={skill.id} className="p-3" data-testid={`card-market-skill-${skill.id}`}>
                      <div className="flex items-start justify-between gap-2 flex-wrap">
                        <div>
                          <div className="font-mono font-semibold text-sm">{skill.name}</div>
                          <div className="text-xs text-muted-foreground mt-0.5">{skill.description}</div>
                          <div className="text-[10px] text-muted-foreground mt-1">by {seller?.name || "Unknown"}</div>
                        </div>
                        <div className="text-right flex-shrink-0 space-y-1">
                          <div className="font-mono text-sm font-bold text-primary">{formatShortCredits(skill.priceAmount)}</div>
                          <Button size="sm" onClick={() => purchaseSkillMutation.mutate(skill.id)} disabled={purchaseSkillMutation.isPending} data-testid={`button-purchase-skill-${skill.id}`}>
                            Purchase
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
                <div className="text-xs text-muted-foreground mb-1">Current Runtime</div>
                <div className="font-mono font-semibold" data-testid="text-current-model">{evolutionData.currentProfile.modelName}</div>
                {evolutionData.currentProfile.modelVersion && (
                  <div className="text-xs text-muted-foreground">v{evolutionData.currentProfile.modelVersion}</div>
                )}
              </Card>
            )}

            <Card className="p-3 space-y-2">
              <div className="text-xs font-mono font-semibold">Trigger Evolution</div>
              <select value={evolveModel} onChange={(e) => setEvolveModel(e.target.value)} className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5" data-testid="select-evolve-model">
                <option value="meta-llama/Llama-3.1-70B-Instruct">Llama 3.1 70B (Hyperbolic)</option>
                <option value="deepseek-ai/DeepSeek-V3">DeepSeek V3 (AkashML)</option>
                <option value="Qwen/Qwen2.5-72B-Instruct">Qwen 2.5 72B (Hyperbolic)</option>
                <option value="meta-llama/Llama-3.1-8B-Instruct">Llama 3.1 8B (Ritual zkML)</option>
                <option value="mistralai/Mistral-7B-Instruct-v0.3">Mistral 7B (AkashML)</option>
              </select>
              <input type="text" placeholder="Reason for evolution..." value={evolveReason} onChange={(e) => setEvolveReason(e.target.value)} className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5" data-testid="input-evolve-reason" />
              <Button size="sm" className="w-full" onClick={() => evolveMutation.mutate({ toModel: evolveModel, reason: evolveReason })} disabled={evolveMutation.isPending} data-testid="button-evolve">
                {evolveMutation.isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Brain className="w-3 h-3" />}
                <span className="ml-1">Evolve</span>
              </Button>
            </Card>

            {(evolutionData?.evolutions || []).length > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-mono font-semibold text-muted-foreground">Evolution History</div>
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
                <div className="text-xs text-muted-foreground mb-1">Parent Agent</div>
                <div className="font-mono font-semibold">{lineageData.parent.agent?.name || "Unknown"}</div>
                <div className="text-xs text-muted-foreground">Revenue share: {lineageData.parent.revenueShareBps / 100}%</div>
              </Card>
            )}

            <Card className="p-3 space-y-2">
              <div className="text-xs font-mono font-semibold">Spawn Child Agent</div>
              <input type="text" placeholder="Child agent name..." value={childName} onChange={(e) => setChildName(e.target.value)} className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5" data-testid="input-child-name" />
              <select value={childFunding} onChange={(e) => setChildFunding(e.target.value)} className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5" data-testid="select-child-funding">
                <option value="100000000000000000">Fund 0.1 credits</option>
                <option value="500000000000000000">Fund 0.5 credits</option>
                <option value="1000000000000000000">Fund 1.0 credits</option>
              </select>
              <Button size="sm" className="w-full" onClick={() => childName && replicateMutation.mutate({ childName, fundingAmount: childFunding })} disabled={!childName || replicateMutation.isPending} data-testid="button-replicate">
                {replicateMutation.isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <GitBranch className="w-3 h-3" />}
                <span className="ml-1">Replicate</span>
              </Button>
            </Card>

            {(lineageData?.children || []).length > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-mono font-semibold text-muted-foreground">Child Agents</div>
                {lineageData!.children.map((child: any) => (
                  <Card key={child.childAgentId} className="p-3" data-testid={`card-child-${child.childAgentId}`}>
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div>
                        <div className="font-mono font-semibold text-sm">{child.agent?.name}</div>
                        <div className="text-xs text-muted-foreground">Rev share: {child.revenueShareBps / 100}%</div>
                      </div>
                      <div className="text-right">
                        <div className="font-mono text-sm text-primary">{formatShortCredits(child.wallet?.balance || "0")}</div>
                        <div className="text-[10px] text-muted-foreground">Shared: {formatShortCredits(child.totalRevenueShared)}</div>
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
                    <div className="text-xs text-muted-foreground mb-1">Current Tier</div>
                    <div className={`font-mono text-2xl font-bold ${tierColor(survival.tier)}`} data-testid="text-survival-tier">
                      {survival.tier.toUpperCase().replace("_", " ")}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-muted-foreground mb-1">Turns Alive</div>
                    <div className="font-mono text-2xl font-bold">{survival.turnsAlive}</div>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="text-xs font-mono font-semibold text-muted-foreground mb-2">Tier Thresholds</div>
                  {survivalData && Object.entries(survivalData.thresholds).map(([tier, threshold]) => {
                    const current = BigInt(survivalData.currentBalance || "0");
                    const thresh = BigInt(threshold);
                    const active = current >= thresh;
                    return (
                      <div key={tier} className="flex items-center gap-2 font-mono text-xs">
                        <div className={`w-2 h-2 rounded-full ${active ? "bg-primary" : "bg-muted"}`} />
                        <span className={active ? "font-semibold" : "text-muted-foreground"}>{tier.toUpperCase().replace("_", " ")}</span>
                        <span className="text-muted-foreground ml-auto">&gt;= {formatCredits(threshold)} credits</span>
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
                      {law.isImmutable && <Badge variant="outline" className="text-[10px]">Immutable</Badge>}
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
              <div className="text-xs font-mono font-semibold">New Entry</div>
              <select value={soulType} onChange={(e) => setSoulType(e.target.value)} className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5" data-testid="select-soul-type">
                <option value="reflection">Reflection</option>
                <option value="goal">Goal</option>
                <option value="identity">Identity</option>
                <option value="milestone">Milestone</option>
                <option value="observation">Observation</option>
              </select>
              <textarea placeholder="Record your thoughts..." value={soulEntry} onChange={(e) => setSoulEntry(e.target.value)} rows={3} className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5 resize-none" data-testid="textarea-soul-entry" />
              <Button size="sm" className="w-full" onClick={() => { soulMutation.mutate({ entry: soulEntry, entryType: soulType }); setSoulEntry(""); }} disabled={!soulEntry || soulMutation.isPending} data-testid="button-soul-entry">
                {soulMutation.isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <BookOpen className="w-3 h-3" />}
                <span className="ml-1">Record</span>
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
              <div className="text-xs font-mono font-semibold">Send Message</div>
              <select value={msgTo} onChange={(e) => setMsgTo(e.target.value)} className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5" data-testid="select-message-to">
                <option value="">Select recipient...</option>
                {agentsList.filter(a => a.id !== agentId).map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              <input type="text" placeholder="Subject..." value={msgSubject} onChange={(e) => setMsgSubject(e.target.value)} className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5" data-testid="input-message-subject" />
              <textarea placeholder="Message body..." value={msgBody} onChange={(e) => setMsgBody(e.target.value)} rows={3} className="w-full font-mono text-xs bg-card border rounded-md px-2 py-1.5 resize-none" data-testid="textarea-message-body" />
              <Button size="sm" className="w-full" onClick={() => { msgTo && msgBody && messageMutation.mutate({ toAgentId: msgTo, subject: msgSubject, body: msgBody }); setMsgSubject(""); setMsgBody(""); }} disabled={!msgTo || !msgBody || messageMutation.isPending} data-testid="button-send-message">
                {messageMutation.isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                <span className="ml-1">Send</span>
              </Button>
            </Card>

            {messages.map((msg) => (
              <Card key={msg.id} className={`p-3 ${msg.status === "unread" ? "border-primary/40" : ""}`} data-testid={`card-message-${msg.id}`}>
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono font-semibold text-xs">{msg.fromAgentName}</span>
                      {msg.status === "unread" && <Badge variant="default" className="text-[10px]">New</Badge>}
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
                  <span className="font-mono text-xs font-semibold">Network Status</span>
                  <Badge variant={inferenceStatus.summary.live > 0 ? "default" : "secondary"} className="text-[10px] ml-auto" data-testid="badge-network-mode">
                    {inferenceStatus.summary.live > 0 ? "LIVE" : "SIMULATION"}
                  </Badge>
                </div>
                <div className="grid grid-cols-3 gap-2 mt-2">
                  <div className="text-center">
                    <div className="font-mono text-lg font-bold text-primary" data-testid="text-providers-total">{inferenceStatus.summary.total}</div>
                    <div className="text-[10px] text-muted-foreground font-mono">Providers</div>
                  </div>
                  <div className="text-center">
                    <div className="font-mono text-lg font-bold text-primary" data-testid="text-providers-live">{inferenceStatus.summary.live}</div>
                    <div className="text-[10px] text-muted-foreground font-mono">Live</div>
                  </div>
                  <div className="text-center">
                    <div className="font-mono text-lg font-bold" data-testid="text-providers-decentralized">{inferenceStatus.summary.decentralized}</div>
                    <div className="text-[10px] text-muted-foreground font-mono">Decentralized</div>
                  </div>
                </div>
                {inferenceStatus.summary.live === 0 && (
                  <div className="mt-3 p-2 rounded-md bg-muted/50 border border-dashed">
                    <div className="text-[11px] font-mono text-muted-foreground">
                      No API keys configured. Add HYPERBOLIC_API_KEY, AKASH_API_KEY, or RITUAL_API_KEY to enable live decentralized inference.
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
                        {isLive ? "LIVE" : "SIM"}
                      </Badge>
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[10px] text-muted-foreground font-mono">Status</span>
                        <div className="flex items-center gap-1">
                          <div className={`w-1.5 h-1.5 rounded-full ${isLive ? "bg-green-500 animate-pulse" : "bg-muted-foreground/40"}`} />
                          <span className={`font-mono text-[10px] ${isLive ? "text-green-500" : "text-muted-foreground"}`}>
                            {isLive ? "Connected" : "Simulation"}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[10px] text-muted-foreground font-mono">Network</span>
                        <span className="font-mono text-[10px]">{provider.network}</span>
                      </div>
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[10px] text-muted-foreground font-mono">Cost/req</span>
                        <span className="font-mono text-[10px] text-primary">{formatShortCredits(provider.costPerRequest)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[10px] text-muted-foreground font-mono">Latency</span>
                        <span className="font-mono text-[10px]">{provider.latencyMs}ms</span>
                      </div>
                      {provider.verifiable && (
                        <div className="flex items-center gap-1 mt-1">
                          <ShieldCheck className="w-3 h-3 text-primary/70" />
                          <span className="text-[10px] text-primary/70 font-mono">Proof Verified</span>
                        </div>
                      )}
                      {meta.costSavings && (
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-[10px] text-muted-foreground font-mono">Savings</span>
                          <span className="font-mono text-[10px] text-primary">{meta.costSavings}</span>
                        </div>
                      )}
                    </div>
                    {provider.modelsSupported && provider.modelsSupported.length > 0 && (
                      <div className="mt-2 pt-2 border-t">
                        <div className="text-[10px] text-muted-foreground font-mono mb-1">Models</div>
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
                <Cpu className="w-3 h-3 text-primary/70" /> Run Inference
              </div>
              <textarea
                placeholder="Enter prompt for inference..."
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
                  <span className="text-[11px] font-mono text-muted-foreground">Prefer decentralized</span>
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
                  <span className="ml-1">Run</span>
                </Button>
              </div>
            </Card>

            {inferenceHistory.length > 0 && (
              <div className="mt-3">
                <div className="text-xs font-mono font-semibold mb-2 text-muted-foreground">Inference History</div>
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
                            {isLiveResult ? "LIVE" : "SIM"}
                          </Badge>
                          <span className="text-[10px] text-muted-foreground font-mono ml-auto">{req.latencyMs}ms</span>
                        </div>
                        <div className="font-mono text-xs text-muted-foreground truncate mb-1">{req.prompt}</div>
                        {req.response && (
                          <div className="font-mono text-xs text-foreground/80 bg-background/50 rounded-md p-2 mt-1 max-h-32 overflow-y-auto">{req.response}</div>
                        )}
                        <div className="flex items-center gap-3 mt-2 flex-wrap">
                          <span className="text-[10px] text-primary font-mono">Cost: {formatShortCredits(req.costAmount)}</span>
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
                <span className="text-muted-foreground truncate">{log.detailsJson ? JSON.parse(log.detailsJson).amount ? `${formatShortCredits(JSON.parse(log.detailsJson).amount)} credits` : JSON.stringify(JSON.parse(log.detailsJson)) : ""}</span>
                <span className="text-[10px] text-muted-foreground ml-auto flex-shrink-0">{log.createdAt ? new Date(log.createdAt).toLocaleTimeString() : ""}</span>
              </div>
            ))}
          </div>
        </Section>

        <div className="py-8 text-center">
          <TerminalLine prefix="//" dim>BUILD4 Autonomous Agent Economy v1.0</TerminalLine>
        </div>
      </main>
    </div>
  );
}
