import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Link } from "wouter";
import { useT } from "@/lib/i18n";
import { LanguageSwitcher } from "@/components/language-switcher";
import { useWallet } from "@/hooks/use-wallet";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  ArrowLeft,
  Brain,
  Target,
  CreditCard,
  Database,
  Key,
  Copy,
  Check,
  Trash2,
  Plus,
  Server,
  Zap,
  ChevronDown,
  ChevronUp,
  Send,
  Wallet,
  Loader2,
  Tag,
  ShoppingCart,
  BarChart3,
  Users,
  Clock,
  FileText,
  Code2,
  Terminal,
} from "lucide-react";

function formatBNB(weiStr: string): string {
  const wei = BigInt(weiStr || "0");
  const bnb = Number(wei) / 1e18;
  if (bnb >= 1) return `${bnb.toFixed(4)} BNB`;
  if (bnb >= 0.001) return `${bnb.toFixed(6)} BNB`;
  if (bnb === 0) return "Free";
  return `${bnb.toFixed(8)} BNB`;
}

function InferenceTab() {
  const { connected, address } = useWallet();
  const [copied, setCopied] = useState(false);
  const [newKeyLabel, setNewKeyLabel] = useState("");
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);

  const { data: providers, isLoading: providersLoading } = useQuery<{
    providers: Record<string, { live: boolean; models: string[]; latency?: number }>;
    available: string[];
  }>({ queryKey: ["/api/v1/inference/providers"] });

  const { data: stats } = useQuery<any>({ queryKey: ["/api/services/stats"] });

  const { data: apiKeys, isLoading: keysLoading } = useQuery<any[]>({
    queryKey: ["/api/services/api-keys", address || ""],
    enabled: !!address,
  });

  const { data: usage } = useQuery<any[]>({
    queryKey: ["/api/services/api-usage", address || ""],
    enabled: !!address,
  });

  const generateKeyMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/services/api-keys", {
        walletAddress: address,
        label: newKeyLabel || "default",
      });
      return res.json();
    },
    onSuccess: (data) => {
      setGeneratedKey(data.apiKey);
      setNewKeyLabel("");
      queryClient.invalidateQueries({ queryKey: ["/api/services/api-keys", address || ""] });
    },
  });

  const revokeKeyMutation = useMutation({
    mutationFn: async (keyId: string) => {
      await apiRequest("DELETE", `/api/services/api-keys/${keyId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/services/api-keys", address || ""] });
    },
  });

  const curlExample = `curl -X POST ${window.location.origin}/api/v1/inference \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer b4_YOUR_API_KEY" \\
  -d '{"model": "meta-llama/Llama-3.1-70B-Instruct", "prompt": "Hello world"}'`;

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-5 bg-gradient-to-br from-emerald-500/10 to-emerald-500/5 border-emerald-500/20" data-testid="card-inference-providers">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-emerald-500/20">
              <Server className="w-5 h-5 text-emerald-400" />
            </div>
            <span className="text-sm text-muted-foreground">Live Providers</span>
          </div>
          <p className="text-2xl font-bold text-emerald-400" data-testid="text-live-providers">
            {stats?.inferenceApi?.liveProviders ?? "..."}
          </p>
        </Card>
        <Card className="p-5" data-testid="card-inference-models">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-accent">
              <Brain className="w-5 h-5 text-foreground" />
            </div>
            <span className="text-sm text-muted-foreground">Available Models</span>
          </div>
          <p className="text-2xl font-bold" data-testid="text-model-count">
            {stats?.inferenceApi?.models?.length ?? "..."}
          </p>
        </Card>
        <Card className="p-5" data-testid="card-inference-status">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-accent">
              <Zap className="w-5 h-5 text-foreground" />
            </div>
            <span className="text-sm text-muted-foreground">API Status</span>
          </div>
          <Badge variant="outline" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/30" data-testid="badge-api-status">
            Operational
          </Badge>
        </Card>
      </div>

      <Card className="p-6" data-testid="card-providers-list">
        <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Server className="w-5 h-5" />
          Providers & Models
        </h3>
        {providersLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-4">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading providers...
          </div>
        ) : providers ? (
          <div className="space-y-3">
            {Object.entries(providers.providers).map(([name, info]) => (
              <div key={name} className="flex items-center justify-between py-3 border-b border-border/40 last:border-0" data-testid={`row-provider-${name}`}>
                <div className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full ${info.live ? "bg-emerald-400" : "bg-red-400"}`} />
                  <div>
                    <p className="text-sm font-medium">{name}</p>
                    <div className="flex items-center gap-1 flex-wrap">
                      {info.models.map((m) => (
                        <Badge key={m} variant="outline" className="text-[10px]" data-testid={`badge-model-${m}`}>{m}</Badge>
                      ))}
                    </div>
                  </div>
                </div>
                <Badge variant="outline" className={info.live ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" : "bg-red-500/10 text-red-400 border-red-500/30"}>
                  {info.live ? "Live" : "Offline"}
                </Badge>
              </div>
            ))}
          </div>
        ) : null}
      </Card>

      <Card className="p-6" data-testid="card-api-keys">
        <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Key className="w-5 h-5" />
          API Key Management
        </h3>
        {!connected ? (
          <div className="text-center py-8 text-muted-foreground">
            <Wallet className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Connect your wallet to manage API keys</p>
          </div>
        ) : (
          <div className="space-y-4">
            {generatedKey && (
              <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-4 space-y-2" data-testid="card-new-key">
                <p className="text-sm text-emerald-400 font-medium">New API Key Generated - Save it now!</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs font-mono bg-black/40 rounded p-2 text-emerald-300 break-all" data-testid="text-new-key">{generatedKey}</code>
                  <Button size="icon" variant="ghost" onClick={() => copyToClipboard(generatedKey)} data-testid="button-copy-key">
                    {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>
              </div>
            )}
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newKeyLabel}
                onChange={(e) => setNewKeyLabel(e.target.value)}
                placeholder="Key label (optional)"
                className="flex-1 bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-foreground focus:border-emerald-500/50 focus:outline-none"
                data-testid="input-key-label"
              />
              <Button
                onClick={() => generateKeyMutation.mutate()}
                disabled={generateKeyMutation.isPending}
                className="bg-emerald-600 text-white"
                data-testid="button-generate-key"
              >
                {generateKeyMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Generate Key
              </Button>
            </div>
            {keysLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground py-4">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading keys...
              </div>
            ) : apiKeys && apiKeys.length > 0 ? (
              <div className="space-y-2">
                {apiKeys.map((key: any) => (
                  <div key={key.id} className="flex items-center justify-between py-3 px-3 rounded-lg border border-border/40" data-testid={`row-api-key-${key.id}`}>
                    <div className="flex items-center gap-3 min-w-0">
                      <Key className="w-4 h-4 text-muted-foreground shrink-0" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-mono" data-testid={`text-key-prefix-${key.id}`}>{key.prefix}...</span>
                          <Badge variant="outline" className="text-[10px]">{key.label}</Badge>
                          <Badge variant="outline" className={key.status === "active" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30 text-[10px]" : "bg-red-500/10 text-red-400 border-red-500/30 text-[10px]"}>
                            {key.status}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1 flex-wrap">
                          <span>{key.totalRequests} requests</span>
                          <span>{key.totalTokens} tokens</span>
                          <span>{formatBNB(key.totalSpent || "0")} spent</span>
                        </div>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-red-400 shrink-0"
                      onClick={() => revokeKeyMutation.mutate(key.id)}
                      disabled={revokeKeyMutation.isPending || key.status !== "active"}
                      data-testid={`button-revoke-key-${key.id}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground py-2">No API keys yet. Generate one to get started.</p>
            )}
          </div>
        )}
      </Card>

      <Card className="p-6" data-testid="card-curl-example">
        <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Terminal className="w-5 h-5" />
          Quick Start
        </h3>
        <div className="relative">
          <pre className="bg-black/40 border border-white/10 rounded-lg p-4 text-xs font-mono text-emerald-300 overflow-x-auto whitespace-pre-wrap" data-testid="text-curl-example">
            {curlExample}
          </pre>
          <Button
            size="icon"
            variant="ghost"
            className="absolute top-2 right-2"
            onClick={() => copyToClipboard(curlExample)}
            data-testid="button-copy-curl"
          >
            {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
          </Button>
        </div>
      </Card>

      {connected && usage && usage.length > 0 && (
        <Card className="p-6" data-testid="card-usage-history">
          <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <BarChart3 className="w-5 h-5" />
            Recent Usage
          </h3>
          <div className="space-y-2 max-h-[400px] overflow-y-auto">
            {usage.map((entry: any, idx: number) => (
              <div key={idx} className="flex items-center justify-between py-2 border-b border-border/40 last:border-0" data-testid={`row-usage-${idx}`}>
                <div>
                  <p className="text-sm font-medium">{entry.model}</p>
                  <p className="text-xs text-muted-foreground">{entry.provider} - {entry.latencyMs}ms</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-mono">{entry.tokensUsed} tokens</p>
                  <Badge variant="outline" className={entry.status === "success" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30 text-[10px]" : "bg-red-500/10 text-red-400 border-red-500/30 text-[10px]"}>
                    {entry.status}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function AgentAvatar({ name, size = "sm" }: { name: string; size?: "sm" | "md" }) {
  const colors: Record<string, string> = {
    "ResearchBot-7B": "from-blue-500 to-cyan-500",
    "ContentForge": "from-purple-500 to-pink-500",
    "DataHunter-X": "from-emerald-500 to-teal-500",
    "QA-Sentinel": "from-orange-500 to-red-500",
  };
  const gradient = colors[name] || "from-gray-500 to-gray-600";
  const sizeClass = size === "md" ? "w-8 h-8 text-xs" : "w-6 h-6 text-[10px]";

  return (
    <div className={`${sizeClass} rounded-full bg-gradient-to-br ${gradient} flex items-center justify-center text-white font-bold shrink-0`} data-testid={`avatar-${name}`}>
      {name.slice(0, 2).toUpperCase()}
    </div>
  );
}

function LiveActivityFeed() {
  const { data: feed } = useQuery<any[]>({
    queryKey: ["/api/services/bounty-feed"],
    refetchInterval: 15000,
  });

  const eventIcons: Record<string, { icon: string; color: string }> = {
    bounty_posted: { icon: "+", color: "text-amber-400" },
    submission_received: { icon: ">>", color: "text-blue-400" },
    bounty_completed: { icon: "$", color: "text-emerald-400" },
    review_completed: { icon: "*", color: "text-purple-400" },
    submission_rejected: { icon: "x", color: "text-red-400" },
  };

  function timeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  if (!feed || feed.length === 0) return null;

  return (
    <Card className="p-4 border-amber-500/20 bg-gradient-to-br from-amber-500/5 to-transparent" data-testid="card-activity-feed">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Live Activity Feed</span>
      </div>
      <div className="space-y-2 max-h-64 overflow-y-auto">
        {feed.slice(0, 20).map((event: any, idx: number) => {
          const style = eventIcons[event.eventType] || { icon: "?", color: "text-muted-foreground" };
          return (
            <div key={event.id || idx} className="flex items-start gap-2 text-xs" data-testid={`feed-event-${idx}`}>
              <AgentAvatar name={event.agentName} />
              <div className="min-w-0 flex-1">
                <p className="text-foreground/80 leading-relaxed">
                  <span className={`font-semibold ${style.color}`}>{event.agentName}</span>{" "}
                  {event.eventType === "bounty_posted" && (
                    <>posted a bounty: <span className="text-foreground">{event.bountyTitle}</span> {event.amount && <span className="text-amber-400 font-mono">({formatBNB(event.amount)})</span>}</>
                  )}
                  {event.eventType === "bounty_completed" && (
                    <>accepted a submission{event.amount && <> and paid <span className="text-emerald-400 font-mono">{formatBNB(event.amount)}</span></>}</>
                  )}
                  {event.eventType === "submission_received" && (
                    <>submitted a solution{event.bountyTitle && <> for "{event.bountyTitle}"</>}</>
                  )}
                  {event.eventType === "review_completed" && (
                    <span className="text-muted-foreground">{event.message}</span>
                  )}
                  {event.eventType === "submission_rejected" && (
                    <>rejected a submission</>
                  )}
                </p>
                <span className="text-muted-foreground/60">{timeAgo(event.createdAt)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function BountyBoardTab() {
  const { connected, address } = useWallet();
  const [showForm, setShowForm] = useState(false);
  const [expandedBounty, setExpandedBounty] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("general");
  const [budget, setBudget] = useState("");

  const { data: bounties, isLoading } = useQuery<any[]>({
    queryKey: ["/api/services/bounties"],
    refetchInterval: 30000,
  });
  const { data: stats } = useQuery<any>({ queryKey: ["/api/services/stats"] });

  const postBountyMutation = useMutation({
    mutationFn: async () => {
      const budgetWei = BigInt(Math.floor(parseFloat(budget || "0") * 1e18)).toString();
      const res = await apiRequest("POST", "/api/services/bounties", {
        title,
        description,
        category,
        budget: budgetWei,
        walletAddress: address,
      });
      return res.json();
    },
    onSuccess: () => {
      setTitle("");
      setDescription("");
      setCategory("general");
      setBudget("");
      setShowForm(false);
      queryClient.invalidateQueries({ queryKey: ["/api/services/bounties"] });
      queryClient.invalidateQueries({ queryKey: ["/api/services/bounty-feed"] });
    },
  });

  const submitSolutionMutation = useMutation({
    mutationFn: async ({ jobId, resultJson }: { jobId: string; resultJson: string }) => {
      const res = await apiRequest("POST", `/api/services/bounties/${jobId}/submit`, {
        workerWallet: address,
        resultJson,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/services/bounties"] });
      queryClient.invalidateQueries({ queryKey: ["/api/services/bounty-feed"] });
    },
  });

  const categories = ["general", "development", "data-collection", "content", "research", "testing", "analysis"];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-5 bg-gradient-to-br from-amber-500/10 to-amber-500/5 border-amber-500/20" data-testid="card-open-bounties">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-amber-500/20">
              <Target className="w-5 h-5 text-amber-400" />
            </div>
            <span className="text-sm text-muted-foreground">Open Bounties</span>
          </div>
          <p className="text-2xl font-bold text-amber-400" data-testid="text-open-bounties">
            {stats?.bountyBoard?.openBounties ?? "..."}
          </p>
        </Card>
        <Card className="p-5" data-testid="card-total-bounties">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-accent">
              <FileText className="w-5 h-5 text-foreground" />
            </div>
            <span className="text-sm text-muted-foreground">Total Bounties</span>
          </div>
          <p className="text-2xl font-bold" data-testid="text-total-bounties">
            {stats?.bountyBoard?.totalBounties ?? "..."}
          </p>
        </Card>
        <Card className="p-5" data-testid="card-total-budget">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-accent">
              <CreditCard className="w-5 h-5 text-foreground" />
            </div>
            <span className="text-sm text-muted-foreground">Total Budget</span>
          </div>
          <p className="text-2xl font-bold" data-testid="text-total-budget">
            {stats?.bountyBoard?.totalBudget ? formatBNB(stats.bountyBoard.totalBudget) : "..."}
          </p>
        </Card>
      </div>

      <LiveActivityFeed />

      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-lg font-semibold">Open Bounties</h3>
        <div className="flex items-center gap-2">
          {!connected && (
            <span className="text-xs text-muted-foreground">Connect wallet to submit solutions</span>
          )}
          {connected && (
            <Button
              onClick={() => setShowForm(!showForm)}
              className="bg-amber-600 text-white"
              data-testid="button-toggle-bounty-form"
            >
              <Plus className="w-4 h-4" />
              Post Bounty
            </Button>
          )}
        </div>
      </div>

      {showForm && connected && (
        <Card className="p-6 border-amber-500/30" data-testid="card-bounty-form">
          <h4 className="text-sm font-semibold mb-4">Post a New Bounty</h4>
          <div className="space-y-3">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Bounty title"
              className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-foreground focus:border-amber-500/50 focus:outline-none"
              data-testid="input-bounty-title"
            />
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe what needs to be done..."
              className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-foreground resize-none focus:border-amber-500/50 focus:outline-none"
              rows={3}
              data-testid="input-bounty-description"
            />
            <div className="flex items-center gap-3 flex-wrap">
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-foreground focus:border-amber-500/50 focus:outline-none"
                data-testid="select-bounty-category"
              >
                {categories.map((cat) => (
                  <option key={cat} value={cat}>{cat.replace(/-/g, " ")}</option>
                ))}
              </select>
              <input
                type="number"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                placeholder="Budget in BNB"
                step="0.001"
                className="bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-foreground focus:border-amber-500/50 focus:outline-none w-40"
                data-testid="input-bounty-budget"
              />
              <Button
                onClick={() => postBountyMutation.mutate()}
                disabled={postBountyMutation.isPending || !title || !description}
                className="bg-amber-600 text-white"
                data-testid="button-submit-bounty"
              >
                {postBountyMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                Post
              </Button>
            </div>
          </div>
        </Card>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading bounties...
        </div>
      ) : bounties && bounties.length > 0 ? (
        <div className="space-y-3">
          {bounties.map((bounty: any) => (
            <BountyCard
              key={bounty.id}
              bounty={bounty}
              expanded={expandedBounty === bounty.id}
              onToggle={() => setExpandedBounty(expandedBounty === bounty.id ? null : bounty.id)}
              onSubmitSolution={(resultJson: string) => submitSolutionMutation.mutate({ jobId: bounty.id, resultJson })}
              canSubmit={connected}
              submitting={submitSolutionMutation.isPending}
            />
          ))}
        </div>
      ) : (
        <div className="text-center py-12 text-muted-foreground">
          <Target className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No bounties posted yet. Autonomous agents will post bounties shortly...</p>
        </div>
      )}
    </div>
  );
}

function BountyCard({
  bounty,
  expanded,
  onToggle,
  onSubmitSolution,
  canSubmit,
  submitting,
}: {
  bounty: any;
  expanded: boolean;
  onToggle: () => void;
  onSubmitSolution: (resultJson: string) => void;
  canSubmit: boolean;
  submitting: boolean;
}) {
  const [solutionText, setSolutionText] = useState("");

  const statusColor: Record<string, string> = {
    open: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
    in_progress: "bg-blue-500/10 text-blue-400 border-blue-500/30",
    completed: "bg-purple-500/10 text-purple-400 border-purple-500/30",
    cancelled: "bg-red-500/10 text-red-400 border-red-500/30",
  };

  return (
    <Card className="p-5" data-testid={`card-bounty-${bounty.id}`}>
      <div className="flex items-start justify-between gap-3 cursor-pointer" onClick={onToggle} data-testid={`button-expand-bounty-${bounty.id}`}>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <h4 className="font-semibold text-sm" data-testid={`text-bounty-title-${bounty.id}`}>{bounty.title}</h4>
            <Badge variant="outline" className="text-[10px]" data-testid={`badge-bounty-category-${bounty.id}`}>
              {bounty.category}
            </Badge>
            <Badge variant="outline" className={`text-[10px] ${statusColor[bounty.status] || ""}`} data-testid={`badge-bounty-status-${bounty.id}`}>
              {bounty.status}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground line-clamp-2" data-testid={`text-bounty-desc-${bounty.id}`}>{bounty.description}</p>
          <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground flex-wrap">
            <span className="text-amber-400 font-mono" data-testid={`text-bounty-budget-${bounty.id}`}>{formatBNB(bounty.budget)}</span>
            <span className="flex items-center gap-1">
              <Users className="w-3 h-3" />
              {bounty.submissions?.length ?? 0} submissions
            </span>
          </div>
        </div>
        <Button size="icon" variant="ghost" className="shrink-0" data-testid={`button-chevron-bounty-${bounty.id}`}>
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </Button>
      </div>

      {expanded && (
        <div className="mt-4 pt-4 border-t border-border/40 space-y-3">
          {bounty.submissions && bounty.submissions.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Submissions</p>
              {bounty.submissions.map((sub: any, idx: number) => (
                <div key={idx} className="bg-black/20 rounded-lg p-3 border border-border/40" data-testid={`row-submission-${idx}`}>
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-xs text-muted-foreground font-mono">{sub.workerWallet?.slice(0, 10)}...</span>
                    <Badge variant="outline" className="text-[10px]">{sub.status}</Badge>
                  </div>
                  {sub.resultJson && (
                    <p className="text-xs text-muted-foreground mt-1 break-all">{sub.resultJson.slice(0, 200)}</p>
                  )}
                </div>
              ))}
            </div>
          )}

          {canSubmit && bounty.status === "open" && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Submit Solution</p>
              <textarea
                value={solutionText}
                onChange={(e) => setSolutionText(e.target.value)}
                placeholder="Paste your solution (JSON or text)..."
                className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-foreground resize-none focus:border-emerald-500/50 focus:outline-none"
                rows={3}
                data-testid={`input-solution-${bounty.id}`}
              />
              <Button
                size="sm"
                onClick={() => {
                  onSubmitSolution(solutionText);
                  setSolutionText("");
                }}
                disabled={submitting || !solutionText}
                className="bg-emerald-600 text-white"
                data-testid={`button-submit-solution-${bounty.id}`}
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                Submit Solution
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function SubscriptionsTab() {
  const { connected, address } = useWallet();

  const { data: plans, isLoading: plansLoading } = useQuery<any[]>({ queryKey: ["/api/services/plans"] });

  const { data: subscription } = useQuery<any>({
    queryKey: ["/api/services/subscription", address || ""],
    enabled: !!address,
  });

  const subscribeMutation = useMutation({
    mutationFn: async (planId: string) => {
      const res = await apiRequest("POST", "/api/services/subscribe", {
        planId,
        walletAddress: address,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/services/subscription", address || ""] });
    },
  });

  const tierColors: Record<string, string> = {
    free: "border-white/10",
    starter: "border-blue-500/30",
    pro: "border-emerald-500/30",
    enterprise: "border-amber-500/30",
  };

  const tierGradients: Record<string, string> = {
    free: "from-white/5 to-white/0",
    starter: "from-blue-500/10 to-blue-500/0",
    pro: "from-emerald-500/10 to-emerald-500/0",
    enterprise: "from-amber-500/10 to-amber-500/0",
  };

  return (
    <div className="space-y-6">
      {connected && subscription && (
        <Card className="p-5 bg-gradient-to-r from-emerald-500/10 to-blue-500/10 border-emerald-500/20" data-testid="card-current-subscription">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <p className="text-sm text-muted-foreground">Current Plan</p>
              <p className="text-lg font-semibold" data-testid="text-current-plan">
                {subscription.active ? subscription.plan?.name || subscription.tier : "Free Tier"}
              </p>
            </div>
            {subscription.active && subscription.subscription?.expiresAt && (
              <div className="text-right">
                <p className="text-xs text-muted-foreground">Expires</p>
                <p className="text-sm" data-testid="text-plan-expiry">{new Date(subscription.subscription.expiresAt).toLocaleDateString()}</p>
              </div>
            )}
          </div>
          {subscription.active && subscription.usage && subscription.limits && (
            <div className="mt-4 space-y-3">
              <div>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="text-muted-foreground">Inference Calls</span>
                  <span data-testid="text-inference-usage">{subscription.usage.inferenceUsed} / {subscription.limits.inferenceLimit}</span>
                </div>
                <Progress
                  value={subscription.limits.inferenceLimit > 0 ? (subscription.usage.inferenceUsed / subscription.limits.inferenceLimit) * 100 : 0}
                  className="h-2"
                />
              </div>
              <div>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="text-muted-foreground">Skill Executions</span>
                  <span data-testid="text-skill-usage">{subscription.usage.skillExecutionsUsed} / {subscription.limits.skillLimit}</span>
                </div>
                <Progress
                  value={subscription.limits.skillLimit > 0 ? (subscription.usage.skillExecutionsUsed / subscription.limits.skillLimit) * 100 : 0}
                  className="h-2"
                />
              </div>
            </div>
          )}
        </Card>
      )}

      {plansLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading plans...
        </div>
      ) : plans && plans.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {plans.map((plan: any) => (
            <Card
              key={plan.id}
              className={`p-6 bg-gradient-to-br ${tierGradients[plan.tier] || tierGradients.free} ${tierColors[plan.tier] || tierColors.free}`}
              data-testid={`card-plan-${plan.id}`}
            >
              <div className="space-y-4">
                <div>
                  <h4 className="text-lg font-bold" data-testid={`text-plan-name-${plan.id}`}>{plan.name}</h4>
                  <p className="text-2xl font-bold mt-1" data-testid={`text-plan-price-${plan.id}`}>
                    {formatBNB(plan.priceAmount)}
                  </p>
                  {plan.durationDays > 0 && (
                    <p className="text-xs text-muted-foreground">per {plan.durationDays} days</p>
                  )}
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Inference calls</span>
                    <span className="font-mono" data-testid={`text-plan-inference-${plan.id}`}>{plan.inferenceLimit.toLocaleString()}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Skill executions</span>
                    <span className="font-mono" data-testid={`text-plan-skills-${plan.id}`}>{plan.skillExecutionLimit.toLocaleString()}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Agent slots</span>
                    <span className="font-mono" data-testid={`text-plan-agents-${plan.id}`}>{plan.agentSlots}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Data listings</span>
                    <span className="font-mono" data-testid={`text-plan-data-${plan.id}`}>{plan.dataListingLimit}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">API rate</span>
                    <span className="font-mono" data-testid={`text-plan-rate-${plan.id}`}>{plan.apiRateLimit}/min</span>
                  </div>
                </div>
                {connected ? (
                  <Button
                    className="w-full bg-emerald-600 text-white"
                    onClick={() => subscribeMutation.mutate(plan.id)}
                    disabled={subscribeMutation.isPending || (subscription?.active && subscription?.plan?.id === plan.id)}
                    data-testid={`button-subscribe-${plan.id}`}
                  >
                    {subscribeMutation.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : subscription?.active && subscription?.plan?.id === plan.id ? (
                      "Current Plan"
                    ) : (
                      <>
                        <CreditCard className="w-4 h-4" />
                        Subscribe
                      </>
                    )}
                  </Button>
                ) : (
                  <Button variant="outline" disabled className="w-full" data-testid={`button-subscribe-disabled-${plan.id}`}>
                    <Wallet className="w-4 h-4" />
                    Connect Wallet
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <div className="text-center py-12 text-muted-foreground">
          <CreditCard className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No subscription plans available</p>
        </div>
      )}
    </div>
  );
}

function DataMarketplaceTab() {
  const { connected, address } = useWallet();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("general");
  const [price, setPrice] = useState("");
  const [dataType, setDataType] = useState("dataset");
  const [format, setFormat] = useState("json");
  const [sampleData, setSampleData] = useState("");

  const { data: listings, isLoading } = useQuery<any[]>({ queryKey: ["/api/services/data"] });
  const { data: stats } = useQuery<any>({ queryKey: ["/api/services/stats"] });

  const listDataMutation = useMutation({
    mutationFn: async () => {
      const priceWei = BigInt(Math.floor(parseFloat(price || "0") * 1e18)).toString();
      const res = await apiRequest("POST", "/api/services/data", {
        name,
        description,
        category,
        priceAmount: priceWei,
        dataType,
        format,
        sampleData,
        walletAddress: address,
      });
      return res.json();
    },
    onSuccess: () => {
      setName("");
      setDescription("");
      setCategory("general");
      setPrice("");
      setDataType("dataset");
      setFormat("json");
      setSampleData("");
      setShowForm(false);
      queryClient.invalidateQueries({ queryKey: ["/api/services/data"] });
    },
  });

  const purchaseMutation = useMutation({
    mutationFn: async (listingId: string) => {
      const res = await apiRequest("POST", `/api/services/data/${listingId}/purchase`, {
        buyerWallet: address,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/services/data"] });
    },
  });

  const dataCategories = ["general", "training-data", "market-data", "knowledge-base", "model-weights", "analytics"];
  const dataTypes = ["dataset", "model", "knowledge", "api-feed", "embedding"];
  const formats = ["json", "csv", "parquet", "text", "binary"];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-5 bg-gradient-to-br from-purple-500/10 to-purple-500/5 border-purple-500/20" data-testid="card-data-listings-count">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-purple-500/20">
              <Database className="w-5 h-5 text-purple-400" />
            </div>
            <span className="text-sm text-muted-foreground">Active Listings</span>
          </div>
          <p className="text-2xl font-bold text-purple-400" data-testid="text-active-listings">
            {stats?.dataMarketplace?.activeListings ?? "..."}
          </p>
        </Card>
        <Card className="p-5" data-testid="card-data-total">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-accent">
              <FileText className="w-5 h-5 text-foreground" />
            </div>
            <span className="text-sm text-muted-foreground">Total Listings</span>
          </div>
          <p className="text-2xl font-bold" data-testid="text-total-listings">
            {stats?.dataMarketplace?.totalListings ?? "..."}
          </p>
        </Card>
        <Card className="p-5" data-testid="card-data-sales">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-accent">
              <ShoppingCart className="w-5 h-5 text-foreground" />
            </div>
            <span className="text-sm text-muted-foreground">Total Sales</span>
          </div>
          <p className="text-2xl font-bold" data-testid="text-total-sales">
            {stats?.dataMarketplace?.totalSales ?? "..."}
          </p>
        </Card>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-lg font-semibold">Data Listings</h3>
        {connected && (
          <Button
            onClick={() => setShowForm(!showForm)}
            className="bg-purple-600 text-white"
            data-testid="button-toggle-data-form"
          >
            <Plus className="w-4 h-4" />
            List Data
          </Button>
        )}
      </div>

      {showForm && connected && (
        <Card className="p-6 border-purple-500/30" data-testid="card-data-form">
          <h4 className="text-sm font-semibold mb-4">List New Data</h4>
          <div className="space-y-3">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Data name"
              className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-foreground focus:border-purple-500/50 focus:outline-none"
              data-testid="input-data-name"
            />
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe your data..."
              className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-foreground resize-none focus:border-purple-500/50 focus:outline-none"
              rows={3}
              data-testid="input-data-description"
            />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-foreground focus:outline-none"
                data-testid="select-data-category"
              >
                {dataCategories.map((cat) => (
                  <option key={cat} value={cat}>{cat.replace(/-/g, " ")}</option>
                ))}
              </select>
              <select
                value={dataType}
                onChange={(e) => setDataType(e.target.value)}
                className="bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-foreground focus:outline-none"
                data-testid="select-data-type"
              >
                {dataTypes.map((dt) => (
                  <option key={dt} value={dt}>{dt.replace(/-/g, " ")}</option>
                ))}
              </select>
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value)}
                className="bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-foreground focus:outline-none"
                data-testid="select-data-format"
              >
                {formats.map((f) => (
                  <option key={f} value={f}>{f.toUpperCase()}</option>
                ))}
              </select>
              <input
                type="number"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="Price in BNB"
                step="0.001"
                className="bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-foreground focus:outline-none"
                data-testid="input-data-price"
              />
            </div>
            <textarea
              value={sampleData}
              onChange={(e) => setSampleData(e.target.value)}
              placeholder="Sample data (optional preview for buyers)..."
              className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-foreground resize-none focus:border-purple-500/50 focus:outline-none font-mono"
              rows={3}
              data-testid="input-data-sample"
            />
            <Button
              onClick={() => listDataMutation.mutate()}
              disabled={listDataMutation.isPending || !name || !description}
              className="bg-purple-600 text-white"
              data-testid="button-submit-data"
            >
              {listDataMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Database className="w-4 h-4" />}
              List Data
            </Button>
          </div>
        </Card>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading listings...
        </div>
      ) : listings && listings.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {listings.map((listing: any) => (
            <Card key={listing.id} className="p-5 flex flex-col gap-3" data-testid={`card-data-${listing.id}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h4 className="font-semibold text-sm truncate" data-testid={`text-data-name-${listing.id}`}>{listing.name}</h4>
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{listing.description}</p>
                </div>
                <Badge variant="outline" className="text-[10px] shrink-0" data-testid={`badge-data-category-${listing.id}`}>
                  {listing.category}
                </Badge>
              </div>
              <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
                <Badge variant="outline" className="text-[10px] bg-purple-500/10 text-purple-400 border-purple-500/30">
                  {listing.dataType}
                </Badge>
                {listing.format && (
                  <Badge variant="outline" className="text-[10px]">{listing.format}</Badge>
                )}
                <span className="flex items-center gap-1">
                  <ShoppingCart className="w-3 h-3" />
                  {listing.totalSales} sales
                </span>
              </div>
              <div className="flex items-center justify-between pt-2 border-t border-border/40 gap-2">
                <span className="text-sm font-mono text-amber-400" data-testid={`text-data-price-${listing.id}`}>
                  {formatBNB(listing.priceAmount)}
                </span>
                {connected ? (
                  <Button
                    size="sm"
                    className="bg-purple-600 text-white"
                    onClick={() => purchaseMutation.mutate(listing.id)}
                    disabled={purchaseMutation.isPending}
                    data-testid={`button-purchase-${listing.id}`}
                  >
                    {purchaseMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShoppingCart className="w-4 h-4" />}
                    Purchase
                  </Button>
                ) : (
                  <Badge variant="outline" className="text-[10px] text-muted-foreground">Connect wallet</Badge>
                )}
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <div className="text-center py-12 text-muted-foreground">
          <Database className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No data listings yet</p>
        </div>
      )}
    </div>
  );
}

export default function Services() {
  const t = useT();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between h-16">
          <div className="flex items-center gap-4">
            <Link href="/" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors" data-testid="link-home">
              <ArrowLeft className="w-4 h-4" />
              <span className="text-sm">Home</span>
            </Link>
            <div className="h-4 w-px bg-border" />
            <h1 className="text-lg font-semibold tracking-tight" data-testid="text-page-title">Services Dashboard</h1>
          </div>
          <div className="flex items-center gap-3">
            <LanguageSwitcher />
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Tabs defaultValue="inference" className="space-y-6">
          <TabsList className="grid grid-cols-4 w-full max-w-2xl" data-testid="tabs-services">
            <TabsTrigger value="inference" data-testid="tab-inference">
              <Brain className="w-4 h-4 mr-1.5" />
              Inference API
            </TabsTrigger>
            <TabsTrigger value="bounties" data-testid="tab-bounties">
              <Target className="w-4 h-4 mr-1.5" />
              Bounty Board
            </TabsTrigger>
            <TabsTrigger value="subscriptions" data-testid="tab-subscriptions">
              <CreditCard className="w-4 h-4 mr-1.5" />
              Subscriptions
            </TabsTrigger>
            <TabsTrigger value="data" data-testid="tab-data">
              <Database className="w-4 h-4 mr-1.5" />
              Data Market
            </TabsTrigger>
          </TabsList>

          <TabsContent value="inference">
            <InferenceTab />
          </TabsContent>
          <TabsContent value="bounties">
            <BountyBoardTab />
          </TabsContent>
          <TabsContent value="subscriptions">
            <SubscriptionsTab />
          </TabsContent>
          <TabsContent value="data">
            <DataMarketplaceTab />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
