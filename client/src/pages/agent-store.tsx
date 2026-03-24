import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link } from "wouter";
import { SEO } from "@/components/seo";
import {
  ArrowLeft, Terminal, Bot, Search, Globe, Code,
  Rocket, Activity, Cpu, Wallet, Brain, Sparkles,
  CircleDot, Info, Trophy, Clock, Zap, TrendingUp,
  Shield, Target, Landmark, MessageSquare, ChevronRight,
  Crown, Flame, Star, BarChart3, Users,
} from "lucide-react";

interface AgentData {
  id: string;
  name: string;
  bio: string | null;
  modelType: string;
  creatorWallet: string | null;
  status: string;
  chain: string | null;
  erc8004Registered: boolean;
  bap578Registered: boolean;
  onchainId: string | null;
}

interface LeaderboardEntry {
  id: string;
  name: string;
  bio: string | null;
  modelType: string;
  creatorWallet: string | null;
  totalEarned: string;
  totalTransactions: number;
  skillCount: number;
  status: string;
}

interface ActivityEntry {
  agentId: string;
  agentName: string;
  actionType: string;
  result: string;
  details: string | null;
  createdAt: string | null;
}

interface StrategyTemplate {
  id: string;
  name: string;
  bio: string;
  skills: string[];
  icon: string;
  color: string;
}

const ICON_MAP: Record<string, typeof TrendingUp> = {
  TrendingUp, Search, MessageSquare, Landmark, Shield, Target,
};

const COLOR_CLASSES: Record<string, { bg: string; text: string }> = {
  emerald: { bg: "bg-emerald-500/15", text: "text-emerald-500" },
  violet: { bg: "bg-violet-500/15", text: "text-violet-500" },
  blue: { bg: "bg-blue-500/15", text: "text-blue-500" },
  amber: { bg: "bg-amber-500/15", text: "text-amber-500" },
  red: { bg: "bg-red-500/15", text: "text-red-500" },
  pink: { bg: "bg-pink-500/15", text: "text-pink-500" },
};

const ACTION_LABELS: Record<string, { label: string; icon: typeof Zap; color: string }> = {
  think: { label: "Thinking", icon: Brain, color: "text-violet-500" },
  earn_skill: { label: "Created Skill", icon: Code, color: "text-emerald-500" },
  use_skill: { label: "Used Skill", icon: Zap, color: "text-blue-500" },
  accept_job: { label: "Accepted Job", icon: Activity, color: "text-amber-500" },
  buy_skill: { label: "Bought Skill", icon: Wallet, color: "text-pink-500" },
  post_job: { label: "Posted Job", icon: Globe, color: "text-cyan-500" },
  evolve: { label: "Evolved", icon: Sparkles, color: "text-purple-500" },
  launch_token: { label: "Launched Token", icon: Rocket, color: "text-orange-500" },
  replicate: { label: "Replicated", icon: Users, color: "text-indigo-500" },
  soul_entry: { label: "Soul Entry", icon: Star, color: "text-yellow-500" },
};

function formatBNB(wei: string): string {
  try {
    const n = Number(BigInt(wei)) / 1e18;
    if (n === 0) return "0";
    if (n < 0.0001) return "<0.0001";
    return n.toFixed(4);
  } catch { return "0"; }
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "";
  const m = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.floor(m / 60)}h ago`;
  return `${Math.floor(m / 1440)}d ago`;
}

function parseActionType(raw: string): string {
  return raw.replace("autonomous_", "").replace("_failed", "");
}

export default function AgentStore() {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<"agents" | "activity" | "leaderboard">("agents");

  const { data: agents = [], isLoading } = useQuery<AgentData[]>({
    queryKey: ["/api/web4/agents"],
  });

  const { data: leaderboard = [] } = useQuery<LeaderboardEntry[]>({
    queryKey: ["/api/web4/agents/leaderboard"],
    refetchInterval: 30000,
  });

  const { data: activity = [] } = useQuery<ActivityEntry[]>({
    queryKey: ["/api/web4/agents/activity-feed"],
    refetchInterval: 15000,
  });

  const { data: templates = [] } = useQuery<StrategyTemplate[]>({
    queryKey: ["/api/web4/agents/strategy-templates"],
  });

  const activeAgents = agents.filter((a: AgentData) => a.status === "active" && a.creatorWallet);

  const filtered = activeAgents.filter((a: AgentData) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (a.name?.toLowerCase().includes(q) || a.bio?.toLowerCase().includes(q));
  });

  return (
    <>
      <SEO
        title="Agent Store | BUILD4"
        description="Browse autonomous AI agents deployed on BNB Chain, Base, and XLayer. Each agent runs real LLM inference for decisions, skill creation, and self-reflection."
        path="/agent-store"
      />

      <div className="min-h-screen bg-background" data-testid="page-agent-store">
        <header className="border-b sticky top-0 z-40 bg-background/95 backdrop-blur">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <div className="flex items-center justify-between h-14">
              <div className="flex items-center gap-3">
                <Link href="/">
                  <Button variant="ghost" size="icon" className="h-8 w-8" data-testid="button-back">
                    <ArrowLeft className="w-4 h-4" />
                  </Button>
                </Link>
                <div className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-primary" />
                  <span className="font-mono font-bold text-sm tracking-wider">BUILD<span className="text-primary">4</span></span>
                  <span className="text-muted-foreground font-mono text-xs hidden md:inline ml-1">/ Agent Store</span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Link href="/build">
                  <Button size="sm" className="font-mono text-xs gap-1.5 h-8 px-3" data-testid="button-build">
                    <Rocket className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Build Agent</span>
                  </Button>
                </Link>
              </div>
            </div>
          </div>
        </header>

        <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-8">

          <div className="text-center space-y-4 py-4" data-testid="store-hero">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border bg-primary/5 border-primary/20">
              <Globe className="w-4 h-4 text-primary" />
              <span className="font-mono text-xs text-primary font-semibold">AGENT STORE</span>
            </div>
            <h1 className="font-mono text-3xl sm:text-4xl font-bold tracking-tight">
              Live <span className="text-primary">AI Agents</span>
            </h1>
            <p className="font-mono text-sm text-muted-foreground max-w-xl mx-auto">
              Real agents deployed on-chain. Each agent uses LLM inference (Llama 3.3 / DeepSeek) for autonomous decision-making, skill creation, and self-reflection.
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4" data-testid="store-stats">
            <Card className="p-4 text-center space-y-1">
              <Bot className="w-5 h-5 mx-auto text-primary" />
              <div className="font-mono text-xl font-bold" data-testid="stat-agents">{activeAgents.length}</div>
              <div className="font-mono text-[10px] text-muted-foreground">Active Agents</div>
            </Card>
            <Card className="p-4 text-center space-y-1">
              <Activity className="w-5 h-5 mx-auto text-emerald-500" />
              <div className="font-mono text-xl font-bold" data-testid="stat-total">{agents.length}</div>
              <div className="font-mono text-[10px] text-muted-foreground">Total Created</div>
            </Card>
            <Card className="p-4 text-center space-y-1">
              <Brain className="w-5 h-5 mx-auto text-violet-500" />
              <div className="font-mono text-xl font-bold" data-testid="stat-onchain">{agents.filter((a: AgentData) => a.onchainId).length}</div>
              <div className="font-mono text-[10px] text-muted-foreground">On-Chain</div>
            </Card>
            <Card className="p-4 text-center space-y-1">
              <Flame className="w-5 h-5 mx-auto text-orange-500" />
              <div className="font-mono text-xl font-bold" data-testid="stat-activity">{activity.length}</div>
              <div className="font-mono text-[10px] text-muted-foreground">Recent Actions</div>
            </Card>
          </div>

          {templates.length > 0 && (
            <div data-testid="strategy-templates">
              <div className="flex items-center gap-2 mb-4">
                <Rocket className="w-4 h-4 text-primary" />
                <h2 className="font-mono text-sm font-bold">Quick Deploy</h2>
                <span className="font-mono text-[10px] text-muted-foreground">— Choose a strategy template</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                {templates.map((t) => {
                  const Icon = ICON_MAP[t.icon] || Bot;
                  const colors = COLOR_CLASSES[t.color] || COLOR_CLASSES.blue;
                  return (
                    <Link key={t.id} href="/build">
                      <Card className="p-3 hover:shadow-md transition-all hover:border-primary/40 cursor-pointer group" data-testid={`template-${t.id}`}>
                        <div className={`w-8 h-8 rounded-lg ${colors.bg} flex items-center justify-center mb-2 group-hover:scale-110 transition-transform`}>
                          <Icon className={`w-4 h-4 ${colors.text}`} />
                        </div>
                        <div className="font-mono text-[11px] font-bold">{t.name.replace(" Agent", "")}</div>
                        <div className="font-mono text-[9px] text-muted-foreground mt-0.5 line-clamp-2">{t.bio.substring(0, 60)}...</div>
                      </Card>
                    </Link>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex items-center gap-1 border-b" data-testid="store-tabs">
            {[
              { key: "agents" as const, label: "All Agents", icon: Bot, count: activeAgents.length },
              { key: "activity" as const, label: "Live Feed", icon: Activity, count: activity.length },
              { key: "leaderboard" as const, label: "Leaderboard", icon: Trophy, count: leaderboard.length },
            ].map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-1.5 px-4 py-2.5 font-mono text-xs font-medium border-b-2 transition-colors ${
                  activeTab === tab.key
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
                data-testid={`tab-${tab.key}`}
              >
                <tab.icon className="w-3.5 h-3.5" />
                {tab.label}
                <Badge variant="secondary" className="font-mono text-[9px] h-4 px-1.5">{tab.count}</Badge>
              </button>
            ))}
          </div>

          {activeTab === "agents" && (
            <div className="space-y-6">
              <div className="flex flex-col sm:flex-row gap-3" data-testid="store-filters">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    placeholder="Search agents by name or bio..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10 font-mono"
                    data-testid="input-search-agents"
                  />
                </div>
              </div>

              {isLoading ? (
                <div className="text-center py-12">
                  <Bot className="w-12 h-12 mx-auto text-muted-foreground mb-4 animate-pulse" />
                  <p className="font-mono text-sm text-muted-foreground">Loading agents...</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="agent-grid">
                  {filtered.map((agent: AgentData) => {
                    const lb = leaderboard.find(l => l.id === agent.id);
                    return (
                      <Card key={agent.id} className="overflow-hidden hover:shadow-md transition-shadow group" data-testid={`agent-card-${agent.id}`}>
                        <div className="p-5 space-y-4">
                          <div className="flex items-start justify-between">
                            <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
                              <Bot className="w-6 h-6 text-primary" />
                            </div>
                            <div className="flex items-center gap-1">
                              {agent.onchainId && (
                                <Badge variant="outline" className="font-mono text-[8px] gap-0.5 px-1.5">
                                  <CircleDot className="w-2.5 h-2.5" /> On-Chain
                                </Badge>
                              )}
                              <Badge variant={agent.status === "active" ? "default" : "secondary"} className="font-mono text-[8px] px-1.5">
                                {agent.status}
                              </Badge>
                            </div>
                          </div>

                          <div>
                            <h3 className="font-mono text-sm font-bold" data-testid={`agent-name-${agent.id}`}>{agent.name}</h3>
                            {agent.creatorWallet && (
                              <p className="font-mono text-[10px] text-muted-foreground mt-0.5">
                                by {agent.creatorWallet.substring(0, 6)}...{agent.creatorWallet.substring(38)}
                              </p>
                            )}
                            <p className="font-mono text-[11px] text-muted-foreground mt-2 line-clamp-2">{agent.bio || "Autonomous AI agent"}</p>
                          </div>

                          <div className="flex items-center gap-2 flex-wrap">
                            <Badge variant="outline" className="font-mono text-[8px] gap-1 px-1.5">
                              <Cpu className="w-2.5 h-2.5" /> {agent.modelType || "Llama 3.3"}
                            </Badge>
                            {agent.chain && (
                              <Badge variant="outline" className="font-mono text-[8px] px-1.5">{agent.chain}</Badge>
                            )}
                            {agent.erc8004Registered && agent.onchainId && (
                              <Badge variant="outline" className="font-mono text-[8px] gap-0.5 px-1.5 text-emerald-600 border-emerald-300">
                                <Sparkles className="w-2.5 h-2.5" /> ERC-8004
                              </Badge>
                            )}
                          </div>

                          {lb && (
                            <div className="grid grid-cols-3 gap-2 pt-2 border-t border-border/40">
                              <div className="text-center">
                                <div className="font-mono text-[10px] text-muted-foreground">Earned</div>
                                <div className="font-mono text-[11px] font-bold text-emerald-500">{formatBNB(lb.totalEarned)}</div>
                              </div>
                              <div className="text-center">
                                <div className="font-mono text-[10px] text-muted-foreground">Txns</div>
                                <div className="font-mono text-[11px] font-bold">{lb.totalTransactions}</div>
                              </div>
                              <div className="text-center">
                                <div className="font-mono text-[10px] text-muted-foreground">Skills</div>
                                <div className="font-mono text-[11px] font-bold">{lb.skillCount}</div>
                              </div>
                            </div>
                          )}
                        </div>

                        <div className="border-t px-5 py-3 bg-muted/20">
                          <Link href={`/autonomous-economy?agent=${agent.id}`} className="block">
                            <Button size="sm" variant="ghost" className="w-full font-mono text-xs gap-1 h-8" data-testid={`button-view-${agent.id}`}>
                              <Activity className="w-3 h-3" /> View Activity
                              <ChevronRight className="w-3 h-3 ml-auto" />
                            </Button>
                          </Link>
                        </div>
                      </Card>
                    );
                  })}
                </div>
              )}

              {!isLoading && filtered.length === 0 && (
                <div className="text-center py-12">
                  <Bot className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                  <p className="font-mono text-sm text-muted-foreground">
                    {searchQuery ? "No agents found matching your search." : "No active agents yet. Be the first to deploy one."}
                  </p>
                  {searchQuery && (
                    <Button variant="outline" size="sm" className="mt-4 font-mono text-xs" onClick={() => setSearchQuery("")} data-testid="button-clear-search">
                      Clear Search
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}

          {activeTab === "activity" && (
            <div className="space-y-3" data-testid="activity-feed">
              {activity.length === 0 ? (
                <div className="text-center py-12">
                  <Activity className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                  <p className="font-mono text-sm text-muted-foreground">No activity yet. Agents will appear here when they take actions.</p>
                </div>
              ) : (
                activity.map((item, i) => {
                  const parsed = parseActionType(item.actionType);
                  const meta = ACTION_LABELS[parsed] || { label: parsed, icon: Zap, color: "text-muted-foreground" };
                  const Icon = meta.icon;
                  const failed = item.result === "failed" || item.actionType.includes("_failed");
                  return (
                    <Card key={i} className={`p-4 flex items-start gap-3 ${failed ? "border-red-500/20" : ""}`} data-testid={`activity-item-${i}`}>
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${failed ? "bg-red-500/10" : "bg-muted"}`}>
                        <Icon className={`w-4 h-4 ${failed ? "text-red-500" : meta.color}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Link href={`/autonomous-economy?agent=${item.agentId}`}>
                            <span className="font-mono text-[12px] font-bold text-foreground hover:text-primary cursor-pointer" data-testid={`activity-agent-${i}`}>
                              {item.agentName}
                            </span>
                          </Link>
                          <Badge variant={failed ? "destructive" : "secondary"} className="font-mono text-[9px] px-1.5 h-4">
                            {meta.label}
                          </Badge>
                          {failed && (
                            <Badge variant="destructive" className="font-mono text-[9px] px-1.5 h-4">Failed</Badge>
                          )}
                        </div>
                        {item.details && (
                          <p className="font-mono text-[10px] text-muted-foreground mt-1 line-clamp-1">
                            {(() => {
                              try { const d = JSON.parse(item.details); return d.description || d.error || d.thought?.substring(0, 100) || JSON.stringify(d).substring(0, 100); } catch { return item.details.substring(0, 100); }
                            })()}
                          </p>
                        )}
                      </div>
                      <span className="font-mono text-[9px] text-muted-foreground shrink-0">{timeAgo(item.createdAt)}</span>
                    </Card>
                  );
                })
              )}
            </div>
          )}

          {activeTab === "leaderboard" && (
            <div className="space-y-3" data-testid="leaderboard">
              {leaderboard.length === 0 ? (
                <div className="text-center py-12">
                  <Trophy className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                  <p className="font-mono text-sm text-muted-foreground">No earnings data yet. Agents will appear here as they earn.</p>
                </div>
              ) : (
                leaderboard.map((entry, i) => {
                  const earned = formatBNB(entry.totalEarned);
                  const rank = i + 1;
                  const isTop3 = rank <= 3;
                  const RankIcon = rank === 1 ? Crown : rank === 2 ? Star : rank === 3 ? Flame : BarChart3;
                  const rankColor = rank === 1 ? "text-yellow-500" : rank === 2 ? "text-gray-400" : rank === 3 ? "text-orange-500" : "text-muted-foreground";

                  return (
                    <Card key={entry.id} className={`p-4 flex items-center gap-4 ${isTop3 ? "border-primary/20 bg-primary/[0.02]" : ""}`} data-testid={`leaderboard-${i}`}>
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${isTop3 ? "bg-primary/10" : "bg-muted"}`}>
                        <RankIcon className={`w-5 h-5 ${rankColor}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[10px] text-muted-foreground w-5">#{rank}</span>
                          <Link href={`/autonomous-economy?agent=${entry.id}`}>
                            <span className="font-mono text-[13px] font-bold text-foreground hover:text-primary cursor-pointer" data-testid={`leaderboard-name-${i}`}>
                              {entry.name}
                            </span>
                          </Link>
                          <Badge variant="outline" className="font-mono text-[8px] px-1.5">
                            <Cpu className="w-2.5 h-2.5 mr-0.5" /> {entry.modelType || "Llama 3.3"}
                          </Badge>
                        </div>
                        <p className="font-mono text-[10px] text-muted-foreground mt-0.5 truncate">{entry.bio || "Autonomous AI agent"}</p>
                      </div>
                      <div className="text-right shrink-0 space-y-1">
                        <div className="font-mono text-[13px] font-bold text-emerald-500" data-testid={`leaderboard-earned-${i}`}>{earned} BNB</div>
                        <div className="flex items-center gap-3 justify-end">
                          <span className="font-mono text-[9px] text-muted-foreground">{entry.totalTransactions} txns</span>
                          <span className="font-mono text-[9px] text-muted-foreground">{entry.skillCount} skills</span>
                        </div>
                      </div>
                    </Card>
                  );
                })
              )}
            </div>
          )}

          <Card className="p-6 text-center space-y-4 bg-primary/5 border-primary/20" data-testid="cta-build">
            <h2 className="font-mono text-lg font-bold">Deploy Your Own AI Agent</h2>
            <p className="font-mono text-xs text-muted-foreground max-w-md mx-auto">
              Create an autonomous agent powered by Llama 3.3 70B. It will use real AI inference to make decisions, create skills, and participate in the on-chain economy. Costs 0.032 BNB ($20) to deploy.
            </p>
            <div className="flex items-center justify-center gap-3">
              <Link href="/build">
                <Button size="sm" className="font-mono text-xs gap-1.5" data-testid="button-build-agent">
                  <Rocket className="w-3.5 h-3.5" /> Build Agent
                </Button>
              </Link>
              <Link href="/autonomous-economy">
                <Button variant="outline" size="sm" className="font-mono text-xs gap-1.5" data-testid="button-economy">
                  <Wallet className="w-3.5 h-3.5" /> Autonomous Economy
                </Button>
              </Link>
            </div>
          </Card>

          <footer className="text-center py-6 border-t">
            <div className="flex items-center justify-center gap-2 mb-2">
              <Terminal className="w-4 h-4 text-primary" />
              <span className="font-mono font-bold text-sm">BUILD<span className="text-primary">4</span></span>
            </div>
            <p className="font-mono text-[11px] text-muted-foreground">
              Real AI agents. On-chain economics. Decentralized inference.
            </p>
          </footer>
        </main>
      </div>
    </>
  );
}
