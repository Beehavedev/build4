import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { SEO } from "@/components/seo";
import { useWallet } from "@/hooks/use-wallet";
import { Link } from "wouter";
import {
  Terminal,
  Zap,
  Brain,
  Search,
  FileText,
  Code,
  TrendingUp,
  MessageSquare,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  ArrowLeft,
  Bot,
  ChevronDown,
  Sparkles,
  BarChart3,
  Rocket,
} from "lucide-react";

const TASK_TYPES = [
  { id: "research", name: "Research", icon: Search, description: "Deep analysis with sources and methodology", placeholder: "e.g. Analyze the current state of restaking on Ethereum — key protocols, TVL trends, risks, and opportunities for the next 6 months." },
  { id: "analysis", name: "Market Analysis", icon: TrendingUp, description: "Data-driven market or protocol analysis", placeholder: "e.g. Compare BNB Chain vs Base vs Solana DEX volume trends over the last 30 days. Which chain is gaining momentum and why?" },
  { id: "content", name: "Content", icon: FileText, description: "Write tweets, threads, articles, or copy", placeholder: "e.g. Write a 5-tweet thread explaining why autonomous AI agents are the next frontier in DeFi. Make it engaging and data-driven." },
  { id: "code_review", name: "Code Review", icon: Code, description: "Review code and suggest improvements", placeholder: "e.g. Review this Solidity function for security issues and gas optimization opportunities: [paste code]" },
  { id: "strategy", name: "Strategy", icon: Brain, description: "Marketing, business, or trading strategy", placeholder: "e.g. Create a go-to-market strategy for launching an AI agent marketplace targeting DeFi protocols. Include timeline, channels, and KPIs." },
  { id: "general", name: "General", icon: MessageSquare, description: "Open-ended tasks", placeholder: "e.g. Summarize the top 5 developments in the AI x Crypto space this week and explain what they mean for builders." },
  { id: "launch_token", name: "Launch Token", icon: Rocket, description: "Launch a meme token on a launchpad", placeholder: "e.g. Launch a fun meme token called DogeBrain on BNB Chain with 0.01 BNB liquidity. Make it about AI-powered dogs." },
];

function statusBadge(status: string) {
  switch (status) {
    case "completed": return <Badge variant="default" className="bg-emerald-600 text-[10px]" data-testid="badge-status-completed"><CheckCircle2 className="w-3 h-3 mr-1" />Completed</Badge>;
    case "running": return <Badge variant="secondary" className="bg-yellow-600 text-white text-[10px] animate-pulse" data-testid="badge-status-running"><Loader2 className="w-3 h-3 mr-1 animate-spin" />Running</Badge>;
    case "failed": return <Badge variant="destructive" className="text-[10px]" data-testid="badge-status-failed"><XCircle className="w-3 h-3 mr-1" />Failed</Badge>;
    default: return <Badge variant="outline" className="text-[10px]" data-testid="badge-status-pending"><Clock className="w-3 h-3 mr-1" />Pending</Badge>;
  }
}

function taskTypeBadge(type: string) {
  const t = TASK_TYPES.find(tt => tt.id === type);
  return <Badge variant="outline" className="text-[10px]">{t?.name || type}</Badge>;
}

function formatTime(ms: number | null) {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDate(date: string | Date | null) {
  if (!date) return "";
  const d = new Date(date);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString();
}

export default function TaskTerminal() {
  const { toast } = useToast();
  const { address } = useWallet();
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [selectedTaskType, setSelectedTaskType] = useState("research");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [showMyTasks, setShowMyTasks] = useState(false);

  const { data: allAgents = [] } = useQuery<any[]>({
    queryKey: ["/api/web4/agents"],
  });

  const agents = allAgents.filter((a: any) =>
    address && a.creatorWallet && a.creatorWallet.toLowerCase() === address.toLowerCase()
  );

  const { data: recentData } = useQuery<{ tasks: any[]; agents: Record<string, any> }>({
    queryKey: ["/api/web4/tasks/recent"],
    queryFn: () => fetch("/api/web4/tasks/recent").then(r => r.json()),
    refetchInterval: 10000,
  });

  const { data: activeTask, refetch: refetchTask } = useQuery<{ task: any; agent: any }>({
    queryKey: ["/api/web4/tasks", activeTaskId],
    queryFn: () => fetch(`/api/web4/tasks/${activeTaskId}`).then(r => r.json()),
    enabled: !!activeTaskId,
    refetchInterval: activeTaskId ? 3000 : false,
  });

  const { data: myTasks = [] } = useQuery<any[]>({
    queryKey: ["/api/web4/tasks/creator", address],
    queryFn: () => fetch(`/api/web4/tasks/creator/${address}`).then(r => r.json()),
    enabled: !!address && showMyTasks,
  });

  useEffect(() => {
    if (activeTask?.task?.status === "completed" || activeTask?.task?.status === "failed") {
      queryClient.invalidateQueries({ queryKey: ["/api/web4/tasks/recent"] });
    }
  }, [activeTask?.task?.status]);

  const submitMutation = useMutation({
    mutationFn: async (data: { agentId: string; taskType: string; title: string; description: string }) => {
      const res = await fetch("/api/web4/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, creatorWallet: address || null }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to submit task");
      }
      return res.json();
    },
    onSuccess: (task) => {
      setActiveTaskId(task.id);
      setTaskTitle("");
      setTaskDescription("");
      toast({ title: "Task submitted", description: "Your agent is working on it now." });
      queryClient.invalidateQueries({ queryKey: ["/api/web4/tasks/recent"] });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const selectedType = TASK_TYPES.find(t => t.id === selectedTaskType) || TASK_TYPES[0];
  const recentTasks = recentData?.tasks || [];
  const recentAgents = recentData?.agents || {};

  return (
    <>
      <SEO title="Agent Task Terminal | BUILD4" description="Give any AI agent a task. Get results powered by decentralized inference." />
      <div className="min-h-screen bg-background">
        <div className="max-w-6xl mx-auto px-4 py-6">
          <div className="flex items-center gap-3 mb-1">
            <Link href="/">
              <Button variant="ghost" size="sm" className="gap-1 text-xs" data-testid="button-back-home">
                <ArrowLeft className="w-3.5 h-3.5" /> Home
              </Button>
            </Link>
          </div>

          <div className="mb-8">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 rounded-lg bg-primary/10">
                <Terminal className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h1 className="text-2xl font-bold tracking-tight" data-testid="text-page-title">Agent Task Terminal</h1>
                <p className="text-sm text-muted-foreground">Give any agent a task. Get results powered by decentralized AI.</p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-4">
              <Card className="p-5 space-y-4">
                <div className="flex items-center gap-2 mb-1">
                  <Zap className="w-4 h-4 text-primary" />
                  <span className="text-sm font-semibold">New Task</span>
                </div>

                {!address && (
                  <div className="p-4 rounded-lg border border-yellow-500/30 bg-yellow-500/5 text-center space-y-2" data-testid="wallet-required-notice">
                    <p className="text-sm font-medium">Connect your wallet to assign tasks</p>
                    <p className="text-xs text-muted-foreground">You can only give tasks to agents you own. Connect your wallet first.</p>
                  </div>
                )}

                {address && agents.length === 0 && (
                  <div className="p-4 rounded-lg border border-muted bg-muted/20 text-center space-y-2" data-testid="no-agents-notice">
                    <Bot className="w-6 h-6 mx-auto text-muted-foreground" />
                    <p className="text-sm font-medium">No agents found for your wallet</p>
                    <p className="text-xs text-muted-foreground">Create an agent first in the <Link href="/autonomous-economy" className="text-primary underline">Autonomous Economy</Link> to start assigning tasks.</p>
                  </div>
                )}

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Select Agent</label>
                  <select
                    className="w-full px-3 py-2.5 text-sm border rounded-lg bg-background font-mono disabled:opacity-50"
                    value={selectedAgentId}
                    onChange={(e) => setSelectedAgentId(e.target.value)}
                    disabled={!address || agents.length === 0}
                    data-testid="select-agent"
                  >
                    <option value="">{!address ? "Connect wallet first..." : agents.length === 0 ? "No agents found..." : "Choose your agent..."}</option>
                    {agents.map((agent: any) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name} — {agent.bio?.substring(0, 60) || "AI Agent"}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Task Type</label>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {TASK_TYPES.map((type) => {
                      const Icon = type.icon;
                      return (
                        <button
                          key={type.id}
                          onClick={() => setSelectedTaskType(type.id)}
                          className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition-all ${
                            selectedTaskType === type.id
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-border hover:border-primary/50 text-muted-foreground hover:text-foreground"
                          }`}
                          data-testid={`button-task-type-${type.id}`}
                        >
                          <Icon className="w-3.5 h-3.5" />
                          {type.name}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[10px] text-muted-foreground">{selectedType.description}</p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Task Title</label>
                  <input
                    className="w-full px-3 py-2.5 text-sm border rounded-lg bg-background"
                    placeholder="Brief title for your task"
                    value={taskTitle}
                    onChange={(e) => setTaskTitle(e.target.value)}
                    maxLength={200}
                    data-testid="input-task-title"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Description</label>
                  <textarea
                    className="w-full px-3 py-2.5 text-sm border rounded-lg bg-background resize-none"
                    rows={5}
                    placeholder={selectedType.placeholder}
                    value={taskDescription}
                    onChange={(e) => setTaskDescription(e.target.value)}
                    maxLength={5000}
                    data-testid="input-task-description"
                  />
                  <div className="flex justify-between">
                    <p className="text-[10px] text-muted-foreground">Be specific — the more detail you provide, the better the result.</p>
                    <span className="text-[10px] text-muted-foreground">{taskDescription.length}/5000</span>
                  </div>
                </div>

                <Button
                  onClick={() => {
                    if (!selectedAgentId) return toast({ title: "Select an agent", variant: "destructive" });
                    if (!taskTitle.trim()) return toast({ title: "Enter a title", variant: "destructive" });
                    if (!taskDescription.trim()) return toast({ title: "Enter a description", variant: "destructive" });
                    submitMutation.mutate({
                      agentId: selectedAgentId,
                      taskType: selectedTaskType,
                      title: taskTitle.trim(),
                      description: taskDescription.trim(),
                    });
                  }}
                  disabled={submitMutation.isPending || !address || !selectedAgentId || !taskTitle.trim() || !taskDescription.trim()}
                  className="w-full"
                  data-testid="button-submit-task"
                >
                  {submitMutation.isPending ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Submitting...</>
                  ) : (
                    <><Sparkles className="w-4 h-4 mr-2" /> Execute Task</>
                  )}
                </Button>
              </Card>

              {activeTask?.task && (
                <Card className="p-5 space-y-3" data-testid="card-active-task">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Bot className="w-4 h-4 text-primary" />
                      <span className="text-sm font-semibold">Task Result</span>
                    </div>
                    {statusBadge(activeTask.task.status)}
                  </div>

                  <div className="space-y-1">
                    <div className="text-xs font-medium">{activeTask.task.title}</div>
                    <div className="flex items-center gap-2 flex-wrap">
                      {taskTypeBadge(activeTask.task.taskType)}
                      {activeTask.agent && <span className="text-[10px] text-muted-foreground">by {activeTask.agent.name}</span>}
                      {activeTask.task.executionTimeMs && (
                        <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                          <Clock className="w-3 h-3" /> {formatTime(activeTask.task.executionTimeMs)}
                        </span>
                      )}
                      {activeTask.task.modelUsed && (
                        <span className="text-[10px] text-muted-foreground">Model: {activeTask.task.modelUsed}</span>
                      )}
                    </div>
                  </div>

                  {activeTask.task.status === "running" && (
                    <div className="flex items-center gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
                      <Loader2 className="w-4 h-4 animate-spin text-yellow-500" />
                      <span className="text-xs text-yellow-600 dark:text-yellow-400">Agent is processing your task using decentralized inference...</span>
                    </div>
                  )}

                  {activeTask.task.result && (
                    <div className="p-4 rounded-lg bg-muted/50 border max-h-[500px] overflow-y-auto">
                      <pre className="text-sm whitespace-pre-wrap font-mono leading-relaxed" data-testid="text-task-result">{activeTask.task.result}</pre>
                    </div>
                  )}

                  {activeTask.task.toolsUsed && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] text-muted-foreground">Tools used:</span>
                      {JSON.parse(activeTask.task.toolsUsed).map((tool: string) => (
                        <Badge key={tool} variant="outline" className="text-[9px]">{tool}</Badge>
                      ))}
                    </div>
                  )}
                </Card>
              )}
            </div>

            <div className="space-y-4">
              {address && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-xs"
                  onClick={() => setShowMyTasks(!showMyTasks)}
                  data-testid="button-toggle-my-tasks"
                >
                  <BarChart3 className="w-3.5 h-3.5 mr-1.5" />
                  {showMyTasks ? "Hide My Tasks" : "My Tasks"}
                  <ChevronDown className={`w-3.5 h-3.5 ml-auto transition-transform ${showMyTasks ? "rotate-180" : ""}`} />
                </Button>
              )}

              {showMyTasks && myTasks.length > 0 && (
                <Card className="p-3 space-y-2">
                  <div className="text-xs font-semibold flex items-center gap-1.5">
                    <Terminal className="w-3.5 h-3.5" /> My Tasks ({myTasks.length})
                  </div>
                  <div className="space-y-1.5 max-h-60 overflow-y-auto">
                    {myTasks.map((task: any) => (
                      <button
                        key={task.id}
                        onClick={() => setActiveTaskId(task.id)}
                        className={`w-full text-left p-2 rounded-lg border text-[10px] transition-colors hover:bg-muted/50 ${
                          activeTaskId === task.id ? "border-primary bg-primary/5" : "border-border"
                        }`}
                        data-testid={`button-my-task-${task.id}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium truncate">{task.title}</span>
                          {statusBadge(task.status)}
                        </div>
                        <div className="text-muted-foreground mt-0.5">{formatDate(task.createdAt)}</div>
                      </button>
                    ))}
                  </div>
                </Card>
              )}

              <Card className="p-3 space-y-2">
                <div className="text-xs font-semibold flex items-center gap-1.5">
                  <Zap className="w-3.5 h-3.5 text-primary" /> Recent Tasks
                </div>
                {recentTasks.length === 0 ? (
                  <div className="text-[10px] text-muted-foreground p-3 text-center">
                    No tasks yet. Be the first to give an agent a task!
                  </div>
                ) : (
                  <div className="space-y-1.5 max-h-[500px] overflow-y-auto">
                    {recentTasks.map((task: any) => (
                      <button
                        key={task.id}
                        onClick={() => setActiveTaskId(task.id)}
                        className={`w-full text-left p-2.5 rounded-lg border text-[11px] transition-colors hover:bg-muted/50 ${
                          activeTaskId === task.id ? "border-primary bg-primary/5" : "border-border"
                        }`}
                        data-testid={`button-recent-task-${task.id}`}
                      >
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="font-medium truncate flex-1">{task.title}</span>
                          {statusBadge(task.status)}
                        </div>
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <Bot className="w-3 h-3" />
                          <span>{recentAgents[task.agentId]?.name || "Agent"}</span>
                          <span>·</span>
                          {taskTypeBadge(task.taskType)}
                          <span>·</span>
                          <span>{formatDate(task.createdAt)}</span>
                          {task.executionTimeMs && (
                            <>
                              <span>·</span>
                              <span>{formatTime(task.executionTimeMs)}</span>
                            </>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </Card>

              <Card className="p-3 space-y-2">
                <div className="text-xs font-semibold">How It Works</div>
                <div className="space-y-2 text-[10px] text-muted-foreground">
                  <div className="flex items-start gap-2">
                    <span className="font-bold text-primary">1.</span>
                    <span>Pick an agent — each has a specialized role (analyst, researcher, CMO, trader, etc.)</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="font-bold text-primary">2.</span>
                    <span>Choose a task type and describe what you need in detail</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="font-bold text-primary">3.</span>
                    <span>The agent processes your task using decentralized AI with live market data</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="font-bold text-primary">4.</span>
                    <span>Get results in seconds — powered by the agent's knowledge base, tools, and role expertise</span>
                  </div>
                </div>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
