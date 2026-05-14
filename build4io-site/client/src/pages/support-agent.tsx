import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  Play,
  Square,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  ExternalLink,
  Bot,
  MessageSquare,
  AlertTriangle,
  Shield,
  Inbox,
  Eye,
} from "lucide-react";

function authFetch(url: string, token: string) {
  return fetch(url, {
    credentials: "include",
    headers: { "x-analytics-token": token },
  }).then(res => {
    if (res.status === 401) throw new Error("Unauthorized");
    if (!res.ok) throw new Error("Failed to fetch");
    return res.json();
  });
}

async function authPost(url: string, token: string, body?: any) {
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", "x-analytics-token": token },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new Error("Unauthorized");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return res.json();
}

async function authPatch(url: string, token: string, body: any) {
  const res = await fetch(url, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json", "x-analytics-token": token },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new Error("Unauthorized");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return res.json();
}

interface SupportStatus {
  configured: boolean;
  enabled: boolean;
  running: boolean;
  config: any;
  stats: {
    totalTickets: number;
    openTickets: number;
    resolvedTickets: number;
    highPriority: number;
  };
}

interface SupportTicket {
  id: string;
  tweetId: string;
  tweetUrl: string | null;
  twitterHandle: string;
  twitterUserId: string | null;
  userMessage: string;
  category: string;
  priority: string;
  aiSummary: string | null;
  aiReplyText: string | null;
  replyTweetId: string | null;
  status: string;
  resolution: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

const CATEGORY_LABELS: Record<string, string> = {
  financial: "Financial",
  bug_report: "Bug Report",
  bounty: "Bounty",
  skill_marketplace: "Skills",
  agent_management: "Agent",
  privacy: "Privacy",
  security_concern: "Security",
  question: "Question",
  general: "General",
};

const PRIORITY_COLORS: Record<string, string> = {
  high: "bg-red-500/20 text-red-400 border-red-500/30",
  normal: "bg-blue-500/20 text-blue-400 border-blue-500/30",
};

const STATUS_COLORS: Record<string, string> = {
  needs_attention: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  open: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  auto_resolved: "bg-green-500/20 text-green-400 border-green-500/30",
  resolved: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
};

export default function SupportAgentPage() {
  const [token, setToken] = useState(() => localStorage.getItem("analytics_token") || "");
  const [password, setPassword] = useState("");
  const [authed, setAuthed] = useState(() => !!localStorage.getItem("analytics_token"));
  const [loginError, setLoginError] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const { toast } = useToast();

  const handleLogin = async () => {
    try {
      const res = await fetch("/api/analytics/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        setLoginError("Wrong password");
        return;
      }
      const data = await res.json();
      setToken(data.token);
      localStorage.setItem("analytics_token", data.token);
      setAuthed(true);
      setLoginError("");
    } catch {
      setLoginError("Login failed");
    }
  };

  const statusQuery = useQuery<SupportStatus>({
    queryKey: ["/api/support/status"],
    queryFn: () => authFetch("/api/support/status", token),
    enabled: authed,
    refetchInterval: 15000,
  });

  const ticketsQuery = useQuery<SupportTicket[]>({
    queryKey: ["/api/support/tickets", filter],
    queryFn: () => authFetch(`/api/support/tickets${filter !== "all" ? `?status=${filter}` : ""}`, token),
    enabled: authed,
    refetchInterval: 15000,
  });

  const startMutation = useMutation({
    mutationFn: () => authPost("/api/support/start", token),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/support/status"] });
      toast({ title: "Support agent started" });
    },
    onError: (e: Error) => toast({ title: "Failed to start", description: e.message, variant: "destructive" }),
  });

  const stopMutation = useMutation({
    mutationFn: () => authPost("/api/support/stop", token),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/support/status"] });
      toast({ title: "Support agent stopped" });
    },
    onError: (e: Error) => toast({ title: "Failed to stop", description: e.message, variant: "destructive" }),
  });

  const cycleMutation = useMutation({
    mutationFn: () => authPost("/api/support/run-cycle", token),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/support/tickets"] });
      toast({ title: "Support cycle completed" });
    },
    onError: (e: Error) => toast({ title: "Cycle failed", description: e.message, variant: "destructive" }),
  });

  const resolveMutation = useMutation({
    mutationFn: ({ id, resolution }: { id: string; resolution?: string }) =>
      authPatch(`/api/support/tickets/${id}`, token, { status: "resolved", resolution: resolution || "Resolved by admin" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/support/tickets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/support/status"] });
      toast({ title: "Ticket resolved" });
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  if (!authed) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4" data-testid="support-login">
        <Card className="p-6 w-full max-w-sm space-y-4">
          <div className="flex items-center gap-2 text-lg font-bold">
            <Shield className="w-5 h-5 text-blue-400" />
            Support Agent Admin
          </div>
          <p className="text-xs text-muted-foreground">Enter your admin password to access the support agent dashboard.</p>
          <Input
            type="password"
            placeholder="Admin password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleLogin()}
            data-testid="input-admin-password"
          />
          {loginError && <p className="text-xs text-red-400">{loginError}</p>}
          <Button onClick={handleLogin} className="w-full" data-testid="button-login">
            Login
          </Button>
        </Card>
      </div>
    );
  }

  const status = statusQuery.data;
  const tickets = ticketsQuery.data || [];

  return (
    <div className="min-h-screen bg-background text-foreground" data-testid="support-agent-page">
      <div className="max-w-5xl mx-auto p-4 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="text-muted-foreground hover:text-foreground">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div className="flex items-center gap-2">
              <Bot className="w-6 h-6 text-blue-400" />
              <h1 className="text-xl font-bold font-mono">Support Agent</h1>
            </div>
          </div>
          <Link href="/twitter-agent">
            <Button variant="outline" size="sm" data-testid="link-bounty-agent">
              <MessageSquare className="w-4 h-4 mr-1" /> Bounty Agent
            </Button>
          </Link>
        </div>

        <Card className="p-4" data-testid="card-support-status">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${status?.running ? "bg-green-400 animate-pulse" : "bg-red-400"}`} />
              <span className="text-sm font-mono font-semibold">
                {status?.running ? "Running" : "Stopped"}
              </span>
              {!status?.configured && (
                <Badge variant="outline" className="text-xs text-yellow-400 border-yellow-500/30">
                  Twitter API not configured
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              {status?.running ? (
                <Button size="sm" variant="destructive" onClick={() => stopMutation.mutate()} disabled={stopMutation.isPending} data-testid="button-stop-support">
                  {stopMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4" />}
                  <span className="ml-1">Stop</span>
                </Button>
              ) : (
                <Button size="sm" onClick={() => startMutation.mutate()} disabled={startMutation.isPending || !status?.configured} data-testid="button-start-support">
                  {startMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                  <span className="ml-1">Start</span>
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => cycleMutation.mutate()} disabled={cycleMutation.isPending || !status?.configured} data-testid="button-run-cycle">
                {cycleMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                <span className="ml-1">Run Now</span>
              </Button>
            </div>
          </div>

          {status && (
            <div className="grid grid-cols-4 gap-3">
              <div className="text-center p-2 rounded bg-muted/50">
                <div className="text-lg font-bold font-mono" data-testid="text-total-tickets">{status.stats.totalTickets}</div>
                <div className="text-xs text-muted-foreground">Total</div>
              </div>
              <div className="text-center p-2 rounded bg-yellow-500/10">
                <div className="text-lg font-bold font-mono text-yellow-400" data-testid="text-open-tickets">{status.stats.openTickets}</div>
                <div className="text-xs text-muted-foreground">Open</div>
              </div>
              <div className="text-center p-2 rounded bg-red-500/10">
                <div className="text-lg font-bold font-mono text-red-400" data-testid="text-high-priority">{status.stats.highPriority}</div>
                <div className="text-xs text-muted-foreground">High Priority</div>
              </div>
              <div className="text-center p-2 rounded bg-green-500/10">
                <div className="text-lg font-bold font-mono text-green-400" data-testid="text-resolved-tickets">{status.stats.resolvedTickets}</div>
                <div className="text-xs text-muted-foreground">Resolved</div>
              </div>
            </div>
          )}
        </Card>

        <Card className="p-4" data-testid="card-safety-info">
          <div className="flex items-center gap-2 mb-2">
            <Shield className="w-4 h-4 text-green-400" />
            <span className="text-sm font-mono font-semibold">Safety Guardrails Active</span>
          </div>
          <ul className="text-xs text-muted-foreground space-y-1 pl-6 list-disc">
            <li>Agent NEVER agrees to change contracts, payouts, wallets, or system settings</li>
            <li>Social engineering attempts are auto-detected and blocked</li>
            <li>All prohibited action requests (transfers, deploys, refunds) are rejected</li>
            <li>Agent only answers questions and logs issues — never takes platform actions</li>
            <li>Internal system details, keys, and architecture are never revealed</li>
          </ul>
        </Card>

        <div>
          <div className="flex items-center gap-2 mb-3">
            <Inbox className="w-5 h-5 text-muted-foreground" />
            <h2 className="text-lg font-bold font-mono">Support Tickets</h2>
          </div>

          <div className="flex gap-2 mb-3 flex-wrap">
            {["all", "needs_attention", "open", "auto_resolved", "resolved"].map(f => (
              <Button
                key={f}
                size="sm"
                variant={filter === f ? "default" : "outline"}
                onClick={() => setFilter(f)}
                className="text-xs"
                data-testid={`button-filter-${f}`}
              >
                {f === "all" ? "All" : f === "needs_attention" ? "Needs Attention" : f === "auto_resolved" ? "Auto-Resolved" : f.charAt(0).toUpperCase() + f.slice(1)}
              </Button>
            ))}
          </div>

          {ticketsQuery.isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : tickets.length === 0 ? (
            <Card className="p-8 text-center text-muted-foreground">
              <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No support tickets yet. Start the agent to begin monitoring mentions.</p>
            </Card>
          ) : (
            <div className="space-y-3">
              {tickets.map(ticket => (
                <Card key={ticket.id} className="p-4" data-testid={`card-ticket-${ticket.id}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="font-mono font-semibold text-sm">@{ticket.twitterHandle}</span>
                        <Badge variant="outline" className={`text-xs ${PRIORITY_COLORS[ticket.priority] || ""}`}>
                          {ticket.priority === "high" && <AlertTriangle className="w-3 h-3 mr-1" />}
                          {ticket.priority}
                        </Badge>
                        <Badge variant="outline" className={`text-xs ${STATUS_COLORS[ticket.status] || ""}`}>
                          {ticket.status === "needs_attention" ? "Needs Attention" : ticket.status === "auto_resolved" ? "Auto-Resolved" : ticket.status}
                        </Badge>
                        <Badge variant="outline" className="text-xs">
                          {CATEGORY_LABELS[ticket.category] || ticket.category}
                        </Badge>
                      </div>

                      <p className="text-sm text-foreground mb-1">{ticket.userMessage}</p>

                      {ticket.aiSummary && (
                        <p className="text-xs text-muted-foreground mb-1">
                          <Eye className="w-3 h-3 inline mr-1" />
                          {ticket.aiSummary}
                        </p>
                      )}

                      {ticket.aiReplyText && (
                        <div className="text-xs bg-muted/50 rounded p-2 mt-1">
                          <span className="text-muted-foreground">Reply sent: </span>
                          <span className="text-foreground">{ticket.aiReplyText}</span>
                        </div>
                      )}

                      <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                        <span><Clock className="w-3 h-3 inline mr-1" />{new Date(ticket.createdAt).toLocaleString()}</span>
                        {ticket.tweetUrl && (
                          <a href={ticket.tweetUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline flex items-center gap-1">
                            <ExternalLink className="w-3 h-3" /> View Tweet
                          </a>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-col gap-1">
                      {(ticket.status === "needs_attention" || ticket.status === "open") && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => resolveMutation.mutate({ id: ticket.id })}
                          disabled={resolveMutation.isPending}
                          className="text-xs"
                          data-testid={`button-resolve-${ticket.id}`}
                        >
                          <CheckCircle2 className="w-3 h-3 mr-1" /> Resolve
                        </Button>
                      )}
                      {ticket.status === "resolved" && (
                        <Badge variant="outline" className="text-xs text-green-400 border-green-500/30">
                          <CheckCircle2 className="w-3 h-3 mr-1" /> Resolved
                        </Badge>
                      )}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
