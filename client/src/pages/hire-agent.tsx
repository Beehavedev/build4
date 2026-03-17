import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { SEO } from "@/components/seo";
import {
  ArrowLeft, Bot, Terminal, Cpu, Wallet, Zap, Star, Shield,
  TrendingUp, Brain, Users, DollarSign, ChevronRight, Search,
  Briefcase, Clock, Activity, Plus, RefreshCw, Rocket,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useWallet } from "@/hooks/use-wallet";
import type { Agent } from "@shared/schema";
import { WalletConnector } from "@/components/wallet-connector";

const AGENT_HIRE_PRICE = "$599";
const AGENT_HIRE_BNB = "0.95 BNB";

const AGENT_ROLES = [
  { id: "trading", label: "Trading Agent", description: "Autonomous token trading, sniping, and portfolio management" },
  { id: "research", label: "Research Agent", description: "Market research, token analysis, and trend identification" },
  { id: "content", label: "Content Agent", description: "Social media, marketing copy, and community engagement" },
  { id: "analysis", label: "Analysis Agent", description: "On-chain data analysis, wallet tracking, and reporting" },
  { id: "defi", label: "DeFi Agent", description: "Yield farming, liquidity provision, and DeFi strategy" },
  { id: "security", label: "Security Agent", description: "Smart contract auditing, rug detection, and risk assessment" },
  { id: "community", label: "Community Agent", description: "Community management, moderation, and engagement" },
  { id: "general", label: "General Purpose", description: "Flexible agent for custom tasks and workflows" },
] as const;

const SPECIALIZATIONS = [
  { id: "all", label: "All Agents", icon: Bot },
  { id: "trading", label: "Trading", icon: TrendingUp },
  { id: "research", label: "Research", icon: Brain },
  { id: "content", label: "Content", icon: Zap },
  { id: "analysis", label: "Analysis", icon: Activity },
] as const;

function isTestAgent(agent: Agent): boolean {
  return /^(TST|TEST|PLAYWRIGHT|VERIFY)/i.test(agent.name);
}

function shortModel(model: string): string {
  if (model.includes("Llama")) return "Llama 3.1";
  if (model.includes("DeepSeek")) return "DeepSeek V3";
  if (model.includes("Qwen")) return "Qwen 2.5";
  return model.split("/").pop()?.substring(0, 15) || model;
}

function getAgentSpecialization(agent: Agent): string {
  const bio = (agent.bio || "").toLowerCase();
  const name = agent.name.toLowerCase();
  if (bio.includes("trad") || bio.includes("snip") || name.includes("trad") || name.includes("snip")) return "trading";
  if (bio.includes("research") || bio.includes("analys") || name.includes("research")) return "research";
  if (bio.includes("content") || bio.includes("write") || bio.includes("market")) return "content";
  if (bio.includes("data") || bio.includes("analyt")) return "analysis";
  return "all";
}

function getAgentStatusColor(status: string): string {
  switch (status) {
    case "active": return "bg-emerald-500";
    case "idle": return "bg-amber-500";
    case "dead": return "bg-red-500";
    default: return "bg-gray-500";
  }
}

export default function HireAgent() {
  const web3 = useWallet();
  const { toast } = useToast();
  const [filter, setFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedHireAgent, setSelectedHireAgent] = useState<Agent | null>(null);
  const [showCreateNew, setShowCreateNew] = useState(false);
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentRole, setNewAgentRole] = useState("trading");
  const [newAgentBio, setNewAgentBio] = useState("");
  const [newAgentModel, setNewAgentModel] = useState("meta-llama/Llama-3.1-70B-Instruct");

  const { data: allAgents = [], isLoading } = useQuery<Agent[]>({
    queryKey: ["/api/web4/agents"],
    refetchInterval: 15000,
  });

  const visibleAgents = allAgents.filter(a => !isTestAgent(a) && a.status !== "dead");

  const filteredAgents = visibleAgents.filter(a => {
    const matchesFilter = filter === "all" || getAgentSpecialization(a) === filter;
    const matchesSearch = !searchQuery ||
      a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (a.bio || "").toLowerCase().includes(searchQuery.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  const createAgentMutation = useMutation({
    mutationFn: async () => {
      if (!web3.connected || !web3.signer) {
        throw new Error("Please connect your wallet first.");
      }
      const roleInfo = AGENT_ROLES.find(r => r.id === newAgentRole);
      const roleBio = roleInfo ? `[${roleInfo.label}] ${newAgentBio || roleInfo.description}` : newAgentBio;
      const res = await apiRequest("POST", "/api/web4/agents/create", {
        name: newAgentName,
        bio: roleBio || undefined,
        modelType: newAgentModel,
        initialDeposit: "1000000000000000",
        creatorWallet: web3.address,
      });
      const data = await res.json();
      if (!data.agent?.id) throw new Error("Failed to create agent");
      return data;
    },
    onSuccess: () => {
      toast({ title: "Agent Created", description: `${newAgentName} is now active. $599 fee applied.` });
      setShowCreateNew(false);
      setNewAgentName("");
      setNewAgentRole("trading");
      setNewAgentBio("");
      queryClient.invalidateQueries({ queryKey: ["/api/web4/agents"] });
    },
    onError: (e: Error) => {
      toast({ title: "Creation Failed", description: e.message, variant: "destructive" });
    },
  });

  return (
    <>
      <SEO
        title="Hire an Agent | BUILD4"
        description="Browse and hire autonomous AI agents on BNB Chain. Trading, research, content, and analysis agents available for $599."
        path="/hire-agent"
      />

      <div className="min-h-screen bg-background" data-testid="page-hire-agent">
        <header className="border-b sticky top-0 z-40 bg-background/95 backdrop-blur">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <div className="flex items-center justify-between h-14">
              <div className="flex items-center gap-3">
                <Link href="/autonomous-economy">
                  <Button variant="ghost" size="icon" className="h-8 w-8" data-testid="button-back-dashboard">
                    <ArrowLeft className="w-4 h-4" />
                  </Button>
                </Link>
                <div className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-primary" />
                  <span className="font-mono font-bold text-sm tracking-wider">BUILD<span className="text-primary">4</span></span>
                  <span className="text-muted-foreground font-mono text-xs hidden md:inline ml-1">/ Hire an Agent</span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Link href="/autonomous-economy">
                  <Button variant="outline" size="sm" className="font-mono text-xs gap-1.5 h-8 px-3" data-testid="button-dashboard">
                    <Cpu className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Dashboard</span>
                  </Button>
                </Link>
                <WalletConnector />
              </div>
            </div>
          </div>
        </header>

        <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-8">
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
              <div>
                <h1 className="font-mono text-2xl font-bold tracking-tight flex items-center gap-3" data-testid="heading-hire-agent">
                  <Briefcase className="w-6 h-6 text-primary" />
                  Hire an Agent
                </h1>
                <p className="font-mono text-sm text-muted-foreground mt-1">
                  Browse autonomous AI agents or create your own. Each agent costs <span className="text-primary font-semibold">{AGENT_HIRE_PRICE}</span> ({AGENT_HIRE_BNB}).
                </p>
              </div>
              <Button
                className="font-mono text-xs gap-1.5"
                onClick={() => setShowCreateNew(!showCreateNew)}
                data-testid="button-create-new-agent"
              >
                <Plus className="w-3.5 h-3.5" />
                Create New Agent
              </Button>
            </div>

            {showCreateNew && (
              <Card className="p-5 border-primary/30 bg-primary/5" data-testid="section-create-agent">
                <div className="flex items-center gap-2 mb-4">
                  <Bot className="w-4 h-4 text-primary" />
                  <span className="font-mono text-sm font-semibold">Create New Agent</span>
                  <Badge variant="secondary" className="text-[10px] ml-auto">{AGENT_HIRE_PRICE} ({AGENT_HIRE_BNB})</Badge>
                </div>

                {!web3.connected && (
                  <div className="mb-4 p-3 rounded-md border border-yellow-500/30 bg-yellow-500/5" data-testid="wallet-warning">
                    <div className="flex items-center gap-2 mb-2">
                      <Wallet className="w-4 h-4 text-yellow-500" />
                      <span className="font-mono text-xs font-semibold text-yellow-500">Wallet Required</span>
                    </div>
                    <p className="font-mono text-[11px] text-muted-foreground mb-3">
                      Connect your wallet to create and pay for an agent.
                    </p>
                    <WalletConnector />
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
                      data-testid="input-hire-agent-name"
                      disabled={createAgentMutation.isPending}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="font-mono text-xs text-muted-foreground">Role *</label>
                    <select
                      value={newAgentRole}
                      onChange={(e) => setNewAgentRole(e.target.value)}
                      className="w-full font-mono text-sm bg-background border rounded-md px-3 py-2"
                      data-testid="select-hire-agent-role"
                      disabled={createAgentMutation.isPending}
                    >
                      {AGENT_ROLES.map((role) => (
                        <option key={role.id} value={role.id}>{role.label}</option>
                      ))}
                    </select>
                    <p className="font-mono text-[10px] text-muted-foreground">
                      {AGENT_ROLES.find(r => r.id === newAgentRole)?.description}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                  <div className="space-y-2">
                    <label className="font-mono text-xs text-muted-foreground">AI Model</label>
                    <select
                      value={newAgentModel}
                      onChange={(e) => setNewAgentModel(e.target.value)}
                      className="w-full font-mono text-sm bg-background border rounded-md px-3 py-2"
                      data-testid="select-hire-agent-model"
                      disabled={createAgentMutation.isPending}
                    >
                      <option value="meta-llama/Llama-3.1-70B-Instruct">Llama 3.1 70B</option>
                      <option value="deepseek-ai/DeepSeek-V3">DeepSeek V3</option>
                      <option value="Qwen/Qwen2.5-72B-Instruct">Qwen 2.5 72B</option>
                    </select>
                  </div>
                </div>

                <div className="mt-3 space-y-2">
                  <label className="font-mono text-xs text-muted-foreground">Bio / Description</label>
                  <textarea
                    value={newAgentBio}
                    onChange={(e) => setNewAgentBio(e.target.value)}
                    placeholder="Describe what this agent specializes in..."
                    rows={2}
                    className="w-full font-mono text-sm bg-background border rounded-md px-3 py-2 resize-none"
                    data-testid="input-hire-agent-bio"
                    disabled={createAgentMutation.isPending}
                  />
                </div>

                <div className="mt-4 flex items-center gap-3">
                  <Button
                    onClick={() => createAgentMutation.mutate()}
                    disabled={!newAgentName.trim() || createAgentMutation.isPending || !web3.connected}
                    className="font-mono text-xs gap-1.5"
                    data-testid="button-submit-hire-agent"
                  >
                    {createAgentMutation.isPending ? (
                      <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Creating...</>
                    ) : (
                      <><Rocket className="w-3.5 h-3.5" /> Create & Pay {AGENT_HIRE_PRICE}</>
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="font-mono text-xs"
                    onClick={() => setShowCreateNew(false)}
                    disabled={createAgentMutation.isPending}
                    data-testid="button-cancel-hire"
                  >
                    Cancel
                  </Button>
                </div>
              </Card>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Card className="p-4 flex items-center gap-3" data-testid="stat-total-agents">
              <div className="p-2 rounded-md bg-primary/10">
                <Bot className="w-5 h-5 text-primary" />
              </div>
              <div>
                <div className="font-mono text-lg font-bold">{visibleAgents.length}</div>
                <div className="font-mono text-[11px] text-muted-foreground">Active Agents</div>
              </div>
            </Card>
            <Card className="p-4 flex items-center gap-3" data-testid="stat-price">
              <div className="p-2 rounded-md bg-amber-500/10">
                <DollarSign className="w-5 h-5 text-amber-500" />
              </div>
              <div>
                <div className="font-mono text-lg font-bold">{AGENT_HIRE_PRICE}</div>
                <div className="font-mono text-[11px] text-muted-foreground">Per Agent ({AGENT_HIRE_BNB})</div>
              </div>
            </Card>
            <Card className="p-4 flex items-center gap-3" data-testid="stat-chain">
              <div className="p-2 rounded-md bg-emerald-500/10">
                <Shield className="w-5 h-5 text-emerald-500" />
              </div>
              <div>
                <div className="font-mono text-lg font-bold">BNB Chain</div>
                <div className="font-mono text-[11px] text-muted-foreground">Deployed On-Chain</div>
              </div>
            </Card>
          </div>

          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
              <div className="flex items-center gap-2 flex-wrap">
                {SPECIALIZATIONS.map(({ id, label, icon: Icon }) => (
                  <Button
                    key={id}
                    variant={filter === id ? "default" : "outline"}
                    size="sm"
                    className="font-mono text-xs gap-1.5 h-8"
                    onClick={() => setFilter(id)}
                    data-testid={`filter-${id}`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </Button>
                ))}
              </div>
              <div className="relative w-full sm:w-auto">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search agents..."
                  className="w-full sm:w-64 font-mono text-xs bg-background border rounded-md pl-9 pr-3 py-2"
                  data-testid="input-search-agents"
                />
              </div>
            </div>

            {isLoading ? (
              <div className="flex items-center justify-center py-20" data-testid="loading-agents">
                <RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" />
                <span className="font-mono text-sm text-muted-foreground ml-2">Loading agents...</span>
              </div>
            ) : filteredAgents.length === 0 ? (
              <Card className="p-8 text-center" data-testid="empty-agents">
                <Bot className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
                <p className="font-mono text-sm text-muted-foreground">
                  {searchQuery ? "No agents match your search." : "No agents available yet. Create the first one!"}
                </p>
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="agents-grid">
                {filteredAgents.map((agent) => (
                  <Card
                    key={agent.id}
                    className="p-4 hover:border-primary/40 transition-colors cursor-pointer group"
                    onClick={() => setSelectedHireAgent(selectedHireAgent?.id === agent.id ? null : agent)}
                    data-testid={`card-agent-${agent.id}`}
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center">
                          <Bot className="w-4 h-4 text-primary" />
                        </div>
                        <div>
                          <div className="font-mono text-sm font-semibold group-hover:text-primary transition-colors" data-testid={`text-agent-name-${agent.id}`}>
                            {agent.name}
                          </div>
                          <div className="font-mono text-[10px] text-muted-foreground">
                            {shortModel(agent.modelType)}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <div className={`w-2 h-2 rounded-full ${getAgentStatusColor(agent.status)}`} />
                        <span className="font-mono text-[10px] text-muted-foreground capitalize">{agent.status}</span>
                      </div>
                    </div>

                    {agent.bio && (
                      <p className="font-mono text-[11px] text-muted-foreground mb-3 line-clamp-2" data-testid={`text-agent-bio-${agent.id}`}>
                        {agent.bio}
                      </p>
                    )}

                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {agent.onchainRegistered && (
                          <Badge variant="outline" className="text-[9px] gap-1">
                            <Shield className="w-2.5 h-2.5" /> On-Chain
                          </Badge>
                        )}
                        <Badge variant="secondary" className="text-[9px] capitalize">
                          {getAgentSpecialization(agent) === "all" ? "general" : getAgentSpecialization(agent)}
                        </Badge>
                      </div>
                      <ChevronRight className="w-3.5 h-3.5 text-muted-foreground group-hover:text-primary transition-colors" />
                    </div>

                    {selectedHireAgent?.id === agent.id && (
                      <div className="mt-4 pt-4 border-t space-y-3" data-testid={`detail-agent-${agent.id}`}>
                        <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
                          <div>
                            <span className="text-muted-foreground">ID</span>
                            <div className="text-foreground truncate">{agent.id.substring(0, 8)}...</div>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Chain</span>
                            <div className="text-foreground">{agent.preferredChain || "BNB"}</div>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Created</span>
                            <div className="text-foreground">{agent.createdAt ? new Date(agent.createdAt).toLocaleDateString() : "N/A"}</div>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Creator</span>
                            <div className="text-foreground truncate">{agent.creatorWallet ? `${agent.creatorWallet.substring(0, 6)}...${agent.creatorWallet.slice(-4)}` : "Platform"}</div>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 pt-1">
                          <Link href={`/autonomous-economy`}>
                            <Button size="sm" className="font-mono text-[11px] gap-1.5" data-testid={`button-view-agent-${agent.id}`}>
                              <Cpu className="w-3 h-3" /> View in Dashboard
                            </Button>
                          </Link>
                        </div>
                      </div>
                    )}
                  </Card>
                ))}
              </div>
            )}
          </div>

          <Card className="p-6 border-dashed" data-testid="section-how-it-works">
            <h2 className="font-mono text-sm font-semibold mb-4 flex items-center gap-2">
              <Star className="w-4 h-4 text-primary" />
              How Agent Hiring Works
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
              <div className="space-y-2">
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center font-mono text-sm font-bold text-primary">1</div>
                <div className="font-mono text-xs font-semibold">Choose or Create</div>
                <p className="font-mono text-[11px] text-muted-foreground">
                  Browse existing agents or create a new one with a custom name, bio, and AI model.
                </p>
              </div>
              <div className="space-y-2">
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center font-mono text-sm font-bold text-primary">2</div>
                <div className="font-mono text-xs font-semibold">Pay {AGENT_HIRE_PRICE}</div>
                <p className="font-mono text-[11px] text-muted-foreground">
                  Agent creation costs {AGENT_HIRE_PRICE} ({AGENT_HIRE_BNB}), paid directly to the BUILD4 treasury on BNB Chain.
                </p>
              </div>
              <div className="space-y-2">
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center font-mono text-sm font-bold text-primary">3</div>
                <div className="font-mono text-xs font-semibold">Deploy & Manage</div>
                <p className="font-mono text-[11px] text-muted-foreground">
                  Your agent is registered on-chain and ready to trade, research, or execute tasks autonomously.
                </p>
              </div>
            </div>
          </Card>
        </main>
      </div>
    </>
  );
}
