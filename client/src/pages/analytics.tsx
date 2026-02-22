import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link } from "wouter";
import { useState } from "react";
import {
  ArrowLeft,
  Users,
  Bot,
  Globe,
  Eye,
  Activity,
  Clock,
  BarChart3,
  TrendingUp,
  Monitor,
  HelpCircle,
  RefreshCw,
  Lock,
  LogOut,
} from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { VisitorLog } from "@shared/schema";

type Period = "1h" | "24h" | "7d" | "30d" | "all";

interface VisitorStats {
  total: number;
  humans: number;
  agents: number;
  unknown: number;
  uniqueIps: number;
  topPaths: { path: string; count: number }[];
  topAgents: { userAgent: string; count: number }[];
  byHour: { hour: string; humans: number; agents: number; unknown: number }[];
}

interface LiveData {
  activeVisitors: number;
  humans: number;
  agents: number;
  unknown: number;
  recentPaths: { path: string; count: number }[];
}

function visitorTypeBadge(type: string) {
  const styles: Record<string, string> = {
    human: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
    agent: "bg-purple-500/20 text-purple-400 border-purple-500/30",
    unknown: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
  };
  return styles[type] || styles.unknown;
}

function visitorTypeIcon(type: string) {
  switch (type) {
    case "human": return <Users className="w-4 h-4 text-emerald-400" />;
    case "agent": return <Bot className="w-4 h-4 text-purple-400" />;
    default: return <HelpCircle className="w-4 h-4 text-zinc-400" />;
  }
}

function formatTime(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function TrafficChart({ data }: { data: VisitorStats["byHour"] }) {
  if (!data.length) return <div className="text-zinc-500 text-sm py-8 text-center">No traffic data yet</div>;

  const maxVal = Math.max(...data.map(d => d.humans + d.agents + d.unknown), 1);

  return (
    <div className="flex items-end gap-1 h-40 overflow-x-auto" data-testid="chart-traffic">
      {data.map((d, i) => {
        const total = d.humans + d.agents + d.unknown;
        const humanH = (d.humans / maxVal) * 100;
        const agentH = (d.agents / maxVal) * 100;
        const unknownH = (d.unknown / maxVal) * 100;
        const label = d.hour.slice(11, 16);
        return (
          <div key={i} className="flex flex-col items-center flex-shrink-0 group" style={{ minWidth: "20px" }}>
            <div className="text-[10px] text-zinc-500 opacity-0 group-hover:opacity-100 mb-1">{total}</div>
            <div className="flex flex-col-reverse w-4 rounded-sm overflow-hidden" style={{ height: `${Math.max((total / maxVal) * 100, 2)}%` }}>
              <div className="bg-emerald-500" style={{ height: `${humanH}%` }} />
              <div className="bg-purple-500" style={{ height: `${agentH}%` }} />
              <div className="bg-zinc-600" style={{ height: `${unknownH}%` }} />
            </div>
            <div className="text-[9px] text-zinc-600 mt-1 rotate-45 origin-left">{label}</div>
          </div>
        );
      })}
    </div>
  );
}

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

function LoginGate({ onLogin }: { onLogin: (token: string) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await apiRequest("POST", "/api/analytics/auth", { password });
      const data = await res.json();
      if (data.token) {
        sessionStorage.setItem("analytics_token", data.token);
        onLogin(data.token);
      }
    } catch {
      setError("Invalid password");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-black text-white flex items-center justify-center">
      <Card className="bg-zinc-900/80 border-zinc-800 p-8 max-w-sm w-full mx-4">
        <div className="flex flex-col items-center gap-4 mb-6">
          <div className="w-12 h-12 rounded-full bg-zinc-800 flex items-center justify-center">
            <Lock className="w-6 h-6 text-zinc-400" />
          </div>
          <div className="text-center">
            <h1 className="text-xl font-bold" data-testid="text-login-title">Analytics Dashboard</h1>
            <p className="text-sm text-zinc-500 mt-1">Enter your admin password to continue</p>
          </div>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="bg-zinc-800 border-zinc-700 text-white"
            data-testid="input-password"
            autoFocus
          />
          {error && <p className="text-red-400 text-sm" data-testid="text-error">{error}</p>}
          <Button type="submit" className="w-full bg-white text-black hover:bg-zinc-200" disabled={loading || !password} data-testid="button-login">
            {loading ? "Verifying..." : "Access Analytics"}
          </Button>
        </form>
        <div className="mt-4 text-center">
          <Link href="/">
            <Button variant="ghost" size="sm" className="text-zinc-500 hover:text-white" data-testid="link-back-login">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Home
            </Button>
          </Link>
        </div>
      </Card>
    </div>
  );
}

function AnalyticsDashboard({ token, onLogout }: { token: string; onLogout: () => void }) {
  const [period, setPeriod] = useState<Period>("24h");

  const handleAuthError = (error: Error) => {
    if (error.message === "Unauthorized") {
      sessionStorage.removeItem("analytics_token");
      onLogout();
    }
  };

  const { data: stats, isLoading: statsLoading, error: statsError } = useQuery<VisitorStats>({
    queryKey: ["/api/analytics/stats", period],
    queryFn: () => authFetch(`/api/analytics/stats?period=${period}`, token),
    refetchInterval: 30000,
    retry: (failureCount, error) => {
      if (error instanceof Error && error.message === "Unauthorized") return false;
      return failureCount < 2;
    },
  });

  const { data: live, error: liveError } = useQuery<LiveData>({
    queryKey: ["/api/analytics/live"],
    queryFn: () => authFetch("/api/analytics/live", token),
    refetchInterval: 10000,
    retry: (failureCount, error) => {
      if (error instanceof Error && error.message === "Unauthorized") return false;
      return failureCount < 2;
    },
  });

  const { data: logs, error: logsError } = useQuery<VisitorLog[]>({
    queryKey: ["/api/analytics/logs"],
    queryFn: () => authFetch("/api/analytics/logs", token),
    refetchInterval: 15000,
    retry: (failureCount, error) => {
      if (error instanceof Error && error.message === "Unauthorized") return false;
      return failureCount < 2;
    },
  });

  const authError = [statsError, liveError, logsError].find(
    e => e instanceof Error && e.message === "Unauthorized"
  );
  if (authError) {
    handleAuthError(authError as Error);
    return null;
  }

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/analytics/stats"] });
    queryClient.invalidateQueries({ queryKey: ["/api/analytics/live"] });
    queryClient.invalidateQueries({ queryKey: ["/api/analytics/logs"] });
  };

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <Link href="/">
              <Button variant="ghost" size="sm" className="text-zinc-400 hover:text-white" data-testid="link-back">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold tracking-tight" data-testid="text-page-title">Visitor Analytics</h1>
              <p className="text-sm text-zinc-500">Track humans and AI agents visiting your platform</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={refresh} className="border-zinc-700 text-zinc-300" data-testid="button-refresh">
              <RefreshCw className="w-4 h-4 mr-2" />
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={onLogout} className="border-zinc-700 text-zinc-400 hover:text-red-400" data-testid="button-logout">
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
          <Card className="bg-zinc-900/80 border-zinc-800 p-4" data-testid="card-stat-live">
            <div className="flex items-center gap-2 mb-1">
              <Activity className="w-4 h-4 text-green-400" />
              <span className="text-xs text-zinc-500 uppercase tracking-wider">Live (5min)</span>
            </div>
            <div className="text-2xl font-bold font-mono text-green-400">{live?.activeVisitors ?? 0}</div>
          </Card>
          <Card className="bg-zinc-900/80 border-zinc-800 p-4" data-testid="card-stat-total">
            <div className="flex items-center gap-2 mb-1">
              <Eye className="w-4 h-4 text-white" />
              <span className="text-xs text-zinc-500 uppercase tracking-wider">Total</span>
            </div>
            <div className="text-2xl font-bold font-mono">{stats?.total ?? 0}</div>
          </Card>
          <Card className="bg-zinc-900/80 border-zinc-800 p-4" data-testid="card-stat-humans">
            <div className="flex items-center gap-2 mb-1">
              <Users className="w-4 h-4 text-emerald-400" />
              <span className="text-xs text-zinc-500 uppercase tracking-wider">Humans</span>
            </div>
            <div className="text-2xl font-bold font-mono text-emerald-400">{stats?.humans ?? 0}</div>
          </Card>
          <Card className="bg-zinc-900/80 border-zinc-800 p-4" data-testid="card-stat-agents">
            <div className="flex items-center gap-2 mb-1">
              <Bot className="w-4 h-4 text-purple-400" />
              <span className="text-xs text-zinc-500 uppercase tracking-wider">Agents</span>
            </div>
            <div className="text-2xl font-bold font-mono text-purple-400">{stats?.agents ?? 0}</div>
          </Card>
          <Card className="bg-zinc-900/80 border-zinc-800 p-4" data-testid="card-stat-unknown">
            <div className="flex items-center gap-2 mb-1">
              <HelpCircle className="w-4 h-4 text-zinc-400" />
              <span className="text-xs text-zinc-500 uppercase tracking-wider">Unknown</span>
            </div>
            <div className="text-2xl font-bold font-mono text-zinc-400">{stats?.unknown ?? 0}</div>
          </Card>
          <Card className="bg-zinc-900/80 border-zinc-800 p-4" data-testid="card-stat-unique">
            <div className="flex items-center gap-2 mb-1">
              <Globe className="w-4 h-4 text-cyan-400" />
              <span className="text-xs text-zinc-500 uppercase tracking-wider">Unique IPs</span>
            </div>
            <div className="text-2xl font-bold font-mono text-cyan-400">{stats?.uniqueIps ?? 0}</div>
          </Card>
        </div>

        <div className="flex gap-2 mb-6">
          {(["1h", "24h", "7d", "30d", "all"] as Period[]).map(p => (
            <Button
              key={p}
              variant={period === p ? "default" : "outline"}
              size="sm"
              onClick={() => setPeriod(p)}
              className={period === p ? "bg-white text-black" : "border-zinc-700 text-zinc-400 hover:text-white"}
              data-testid={`button-period-${p}`}
            >
              {p === "all" ? "All Time" : p}
            </Button>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
          <Card className="bg-zinc-900/80 border-zinc-800 p-6 lg:col-span-2" data-testid="card-traffic-chart">
            <div className="flex items-center gap-2 mb-4">
              <BarChart3 className="w-5 h-5 text-zinc-400" />
              <h2 className="text-lg font-semibold">Traffic Over Time</h2>
            </div>
            <div className="flex gap-4 mb-3 text-xs">
              <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-sm bg-emerald-500" /> Humans</div>
              <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-sm bg-purple-500" /> Agents</div>
              <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-sm bg-zinc-600" /> Unknown</div>
            </div>
            {statsLoading ? (
              <div className="h-40 flex items-center justify-center text-zinc-500">Loading...</div>
            ) : (
              <TrafficChart data={stats?.byHour || []} />
            )}
          </Card>

          <Card className="bg-zinc-900/80 border-zinc-800 p-6" data-testid="card-top-pages">
            <div className="flex items-center gap-2 mb-4">
              <TrendingUp className="w-5 h-5 text-zinc-400" />
              <h2 className="text-lg font-semibold">Top Pages</h2>
            </div>
            <div className="space-y-2">
              {stats?.topPaths?.slice(0, 10).map((p, i) => (
                <div key={i} className="flex items-center justify-between text-sm">
                  <span className="text-zinc-300 font-mono truncate max-w-[200px]" data-testid={`text-path-${i}`}>{p.path}</span>
                  <span className="text-zinc-500 font-mono">{p.count}</span>
                </div>
              )) || <div className="text-zinc-500 text-sm">No data yet</div>}
            </div>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          <Card className="bg-zinc-900/80 border-zinc-800 p-6" data-testid="card-agent-visitors">
            <div className="flex items-center gap-2 mb-4">
              <Bot className="w-5 h-5 text-purple-400" />
              <h2 className="text-lg font-semibold">Agent Visitors</h2>
            </div>
            <div className="space-y-2">
              {stats?.topAgents?.length ? stats.topAgents.slice(0, 10).map((a, i) => (
                <div key={i} className="flex items-center justify-between gap-2">
                  <span className="text-zinc-300 text-xs font-mono truncate max-w-[300px]" data-testid={`text-agent-ua-${i}`}>{a.userAgent}</span>
                  <Badge className="bg-purple-500/20 text-purple-400 border-purple-500/30 text-xs">{a.count}</Badge>
                </div>
              )) : <div className="text-zinc-500 text-sm">No agent visitors detected yet</div>}
            </div>
          </Card>

          <Card className="bg-zinc-900/80 border-zinc-800 p-6" data-testid="card-detection-info">
            <div className="flex items-center gap-2 mb-4">
              <Monitor className="w-5 h-5 text-zinc-400" />
              <h2 className="text-lg font-semibold">How Detection Works</h2>
            </div>
            <div className="space-y-3 text-sm text-zinc-400">
              <div className="flex items-start gap-2">
                <Users className="w-4 h-4 text-emerald-400 mt-0.5 flex-shrink-0" />
                <div><strong className="text-emerald-400">Humans</strong> — Browser user-agents (Chrome, Firefox, Safari, etc.)</div>
              </div>
              <div className="flex items-start gap-2">
                <Bot className="w-4 h-4 text-purple-400 mt-0.5 flex-shrink-0" />
                <div><strong className="text-purple-400">Agents</strong> — Bot/crawler user-agents, API calls without browser headers, well-known endpoint access, custom agent headers (x-agent-id, x-agent-wallet)</div>
              </div>
              <div className="flex items-start gap-2">
                <HelpCircle className="w-4 h-4 text-zinc-500 mt-0.5 flex-shrink-0" />
                <div><strong className="text-zinc-300">Unknown</strong> — Unrecognized user-agents or missing headers</div>
              </div>
            </div>
          </Card>
        </div>

        <Card className="bg-zinc-900/80 border-zinc-800 p-6" data-testid="card-recent-logs">
          <div className="flex items-center gap-2 mb-4">
            <Clock className="w-5 h-5 text-zinc-400" />
            <h2 className="text-lg font-semibold">Recent Visitors</h2>
            <Badge className="bg-zinc-800 text-zinc-400 border-zinc-700 text-xs ml-2">{logs?.length || 0} entries</Badge>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-zinc-500 border-b border-zinc-800">
                  <th className="text-left py-2 px-2">Type</th>
                  <th className="text-left py-2 px-2">Method</th>
                  <th className="text-left py-2 px-2">Path</th>
                  <th className="text-left py-2 px-2">Status</th>
                  <th className="text-left py-2 px-2 hidden md:table-cell">IP</th>
                  <th className="text-left py-2 px-2 hidden lg:table-cell">User-Agent</th>
                  <th className="text-left py-2 px-2">Time</th>
                </tr>
              </thead>
              <tbody>
                {logs?.slice(0, 50).map((log, i) => (
                  <tr key={log.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30" data-testid={`row-log-${i}`}>
                    <td className="py-2 px-2">
                      <div className="flex items-center gap-1.5">
                        {visitorTypeIcon(log.visitorType)}
                        <Badge className={`${visitorTypeBadge(log.visitorType)} text-[10px]`}>{log.visitorType}</Badge>
                      </div>
                    </td>
                    <td className="py-2 px-2 font-mono text-xs text-zinc-400">{log.method}</td>
                    <td className="py-2 px-2 font-mono text-xs text-zinc-300 max-w-[200px] truncate">{log.path}</td>
                    <td className="py-2 px-2">
                      <span className={`font-mono text-xs ${log.statusCode && log.statusCode >= 400 ? "text-red-400" : "text-emerald-400"}`}>
                        {log.statusCode || "-"}
                      </span>
                    </td>
                    <td className="py-2 px-2 font-mono text-xs text-zinc-500 hidden md:table-cell">{log.ip?.slice(0, 20) || "-"}</td>
                    <td className="py-2 px-2 text-xs text-zinc-500 max-w-[200px] truncate hidden lg:table-cell">{log.userAgent?.slice(0, 60) || "-"}</td>
                    <td className="py-2 px-2 text-xs text-zinc-500 whitespace-nowrap">
                      {log.createdAt ? formatTime(log.createdAt as unknown as string) : "-"}
                    </td>
                  </tr>
                )) || (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-zinc-500">No visitor data yet. Tracking will begin automatically.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}

export default function Analytics() {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem("analytics_token"));

  const handleLogout = () => {
    sessionStorage.removeItem("analytics_token");
    setToken(null);
    queryClient.removeQueries({ queryKey: ["/api/analytics/stats"] });
    queryClient.removeQueries({ queryKey: ["/api/analytics/live"] });
    queryClient.removeQueries({ queryKey: ["/api/analytics/logs"] });
  };

  if (!token) {
    return <LoginGate onLogin={setToken} />;
  }

  return <AnalyticsDashboard token={token} onLogout={handleLogout} />;
}
