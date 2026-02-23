import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Link } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  ArrowLeft,
  Twitter,
  Send,
  Play,
  Square,
  RefreshCw,
  Settings,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  ExternalLink,
  Wallet,
  Bot,
  MessageSquare,
  DollarSign,
  Eye,
  ChevronDown,
  ChevronUp,
  Lock,
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

function authPost(url: string, token: string, body?: any) {
  return fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", "x-analytics-token": token },
    body: body ? JSON.stringify(body) : undefined,
  }).then(res => {
    if (res.status === 401) throw new Error("Unauthorized");
    if (!res.ok) throw new Error("Failed");
    return res.json();
  });
}

interface TwitterStatus {
  configured: boolean;
  enabled: boolean;
  running: boolean;
  account: { id: string; username: string; name: string } | null;
  config: any;
  stats: { totalBounties: number; activeBounties: number; totalSubmissions: number };
  error?: string;
}

interface TwitterBounty {
  id: string;
  jobId: string;
  tweetId: string | null;
  tweetUrl: string | null;
  tweetText: string | null;
  status: string;
  repliesChecked: number | null;
  lastCheckedAt: string | null;
  createdAt: string | null;
}

interface TwitterSubmission {
  id: string;
  twitterHandle: string;
  tweetText: string;
  walletAddress: string | null;
  verificationScore: number | null;
  verificationReason: string | null;
  status: string;
  paymentTxHash: string | null;
  paymentAmount: string | null;
  createdAt: string | null;
}

export default function TwitterAgent() {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem("analytics_token"));

  if (!token) {
    return <TwitterLoginGate onLogin={setToken} />;
  }

  return <TwitterAgentDashboard token={token} onLogout={() => { sessionStorage.removeItem("analytics_token"); setToken(null); }} />;
}

function TwitterLoginGate({ onLogin }: { onLogin: (token: string) => void }) {
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
      <Card className="bg-gray-900/50 border-gray-800 p-8 w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="inline-flex p-3 rounded-lg bg-blue-500/20 mb-3">
            <Lock className="w-6 h-6 text-blue-400" />
          </div>
          <h2 className="text-xl font-bold">Twitter Agent</h2>
          <p className="text-sm text-gray-400 mt-1">Admin access required</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Admin password"
            className="bg-gray-800 border-gray-700"
            data-testid="input-admin-password"
          />
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <Button type="submit" disabled={loading} className="w-full bg-blue-600 hover:bg-blue-700" data-testid="button-login">
            {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Lock className="w-4 h-4 mr-2" />}
            Access Dashboard
          </Button>
        </form>
        <div className="mt-4 text-center">
          <Link href="/" className="text-xs text-gray-500 hover:text-gray-400">Back to home</Link>
        </div>
      </Card>
    </div>
  );
}

function TwitterAgentDashboard({ token, onLogout }: { token: string; onLogout: () => void }) {
  const [showSettings, setShowSettings] = useState(false);
  const [taskDescription, setTaskDescription] = useState("");
  const [rewardBnb, setRewardBnb] = useState("0.002");
  const [expandedBounty, setExpandedBounty] = useState<string | null>(null);
  const [settingsForm, setSettingsForm] = useState({
    pollingIntervalMs: 300000,
    minVerificationScore: 60,
    maxPayoutBnb: "0.005",
    defaultBountyBudget: "0.002",
  });

  const { data: status, isLoading: statusLoading } = useQuery<TwitterStatus>({
    queryKey: ["/api/twitter/status"],
    queryFn: () => authFetch("/api/twitter/status", token),
    refetchInterval: 10000,
  });

  const { data: config } = useQuery({
    queryKey: ["/api/twitter/config"],
    queryFn: () => authFetch("/api/twitter/config", token),
  });

  const { data: bounties } = useQuery<TwitterBounty[]>({
    queryKey: ["/api/twitter/bounties"],
    queryFn: () => authFetch("/api/twitter/bounties", token),
    refetchInterval: 15000,
  });

  const startAgent = useMutation({
    mutationFn: () => authPost("/api/twitter/start", token),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/twitter/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/twitter/config"] });
    },
  });

  const stopAgent = useMutation({
    mutationFn: () => authPost("/api/twitter/stop", token),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/twitter/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/twitter/config"] });
    },
  });

  const runCycle = useMutation({
    mutationFn: () => authPost("/api/twitter/run-cycle", token),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/twitter/bounties"] });
    },
  });

  const postBounty = useMutation({
    mutationFn: () => authPost("/api/twitter/post-bounty", token, { taskDescription, rewardBnb }),
    onSuccess: () => {
      setTaskDescription("");
      queryClient.invalidateQueries({ queryKey: ["/api/twitter/bounties"] });
      queryClient.invalidateQueries({ queryKey: ["/api/twitter/status"] });
    },
  });

  const saveConfig = useMutation({
    mutationFn: () => authPost("/api/twitter/config", token, settingsForm),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/twitter/config"] });
      queryClient.invalidateQueries({ queryKey: ["/api/twitter/status"] });
      setShowSettings(false);
    },
  });

  const statusColor = status?.enabled ? "text-green-400" : "text-gray-500";
  const statusText = status?.enabled ? "Active" : "Inactive";

  return (
    <div className="min-h-screen bg-black text-white">
      <header className="border-b border-gray-800 bg-black/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/">
              <Button variant="ghost" size="sm" className="text-gray-400 hover:text-white" data-testid="link-back-home">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back
              </Button>
            </Link>
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-500/20 rounded-lg">
                <Twitter className="w-5 h-5 text-blue-400" />
              </div>
              <div>
                <h1 className="text-xl font-bold tracking-tight">Twitter Bounty Agent</h1>
                <p className="text-xs text-gray-500 font-mono">Autonomous task posting & payment</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant="outline" className={`${statusColor} border-current`} data-testid="badge-agent-status">
              {statusText}
            </Badge>
            {status?.account && (
              <Badge variant="outline" className="text-blue-400 border-blue-400/30" data-testid="badge-twitter-account">
                @{status.account.username}
              </Badge>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {statusLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-blue-400" />
          </div>
        ) : !status?.configured ? (
          <Card className="bg-gray-900/50 border-gray-800 p-8 text-center">
            <Twitter className="w-12 h-12 text-gray-600 mx-auto mb-4" />
            <h2 className="text-xl font-bold mb-2">Twitter API Not Configured</h2>
            <p className="text-gray-400 mb-4">
              Add your Twitter API credentials to enable the bounty agent.
            </p>
            <p className="text-sm text-gray-500 font-mono">
              Required: TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_TOKEN_SECRET
            </p>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Card className="bg-gray-900/50 border-gray-800 p-4" data-testid="card-stat-account">
                <div className="flex items-center gap-3 mb-2">
                  <Bot className="w-5 h-5 text-blue-400" />
                  <span className="text-sm text-gray-400">Account</span>
                </div>
                <p className="text-lg font-bold" data-testid="text-account-name">
                  {status?.account ? `@${status.account.username}` : "Not connected"}
                </p>
                <p className="text-xs text-gray-500">{status?.account?.name || ""}</p>
              </Card>

              <Card className="bg-gray-900/50 border-gray-800 p-4" data-testid="card-stat-bounties">
                <div className="flex items-center gap-3 mb-2">
                  <MessageSquare className="w-5 h-5 text-green-400" />
                  <span className="text-sm text-gray-400">Bounties</span>
                </div>
                <p className="text-lg font-bold" data-testid="text-total-bounties">
                  {status?.stats.totalBounties || 0}
                </p>
                <p className="text-xs text-gray-500">{status?.stats.activeBounties || 0} active</p>
              </Card>

              <Card className="bg-gray-900/50 border-gray-800 p-4" data-testid="card-stat-status">
                <div className="flex items-center gap-3 mb-2">
                  <RefreshCw className={`w-5 h-5 ${status?.running ? "text-yellow-400 animate-spin" : "text-gray-500"}`} />
                  <span className="text-sm text-gray-400">Engine</span>
                </div>
                <p className={`text-lg font-bold ${status?.enabled ? "text-green-400" : "text-gray-500"}`} data-testid="text-engine-status">
                  {status?.enabled ? "Running" : "Stopped"}
                </p>
                <p className="text-xs text-gray-500">
                  {status?.config?.pollingIntervalMs ? `${(status.config.pollingIntervalMs / 1000 / 60).toFixed(0)}min interval` : "Default interval"}
                </p>
              </Card>

              <Card className="bg-gray-900/50 border-gray-800 p-4" data-testid="card-stat-payout">
                <div className="flex items-center gap-3 mb-2">
                  <DollarSign className="w-5 h-5 text-yellow-400" />
                  <span className="text-sm text-gray-400">Payout</span>
                </div>
                <p className="text-lg font-bold" data-testid="text-payout-amount">
                  {status?.config?.defaultBountyBudget || "0.002"} BNB
                </p>
                <p className="text-xs text-gray-500">per verified task</p>
              </Card>
            </div>

            <div className="flex gap-3">
              {status?.enabled ? (
                <Button
                  onClick={() => stopAgent.mutate()}
                  disabled={stopAgent.isPending}
                  variant="outline"
                  className="border-red-500/30 text-red-400 hover:bg-red-500/10"
                  data-testid="button-stop-agent"
                >
                  {stopAgent.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Square className="w-4 h-4 mr-2" />}
                  Stop Agent
                </Button>
              ) : (
                <Button
                  onClick={() => startAgent.mutate()}
                  disabled={startAgent.isPending}
                  className="bg-green-600 hover:bg-green-700"
                  data-testid="button-start-agent"
                >
                  {startAgent.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
                  Start Agent
                </Button>
              )}
              <Button
                onClick={() => runCycle.mutate()}
                disabled={runCycle.isPending}
                variant="outline"
                className="border-blue-500/30 text-blue-400 hover:bg-blue-500/10"
                data-testid="button-run-cycle"
              >
                {runCycle.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
                Run Check Now
              </Button>
              <Button
                onClick={() => setShowSettings(!showSettings)}
                variant="ghost"
                className="text-gray-400 hover:text-white"
                data-testid="button-toggle-settings"
              >
                <Settings className="w-4 h-4 mr-2" />
                Settings
              </Button>
            </div>

            {showSettings && (
              <Card className="bg-gray-900/50 border-gray-800 p-6">
                <h3 className="text-lg font-bold mb-4">Agent Settings</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label className="text-gray-400 text-sm">Polling Interval (ms)</Label>
                    <Input
                      type="number"
                      value={settingsForm.pollingIntervalMs}
                      onChange={(e) => setSettingsForm({ ...settingsForm, pollingIntervalMs: parseInt(e.target.value) || 300000 })}
                      className="bg-gray-800 border-gray-700 mt-1"
                      data-testid="input-polling-interval"
                    />
                    <p className="text-xs text-gray-600 mt-1">{(settingsForm.pollingIntervalMs / 1000 / 60).toFixed(1)} minutes</p>
                  </div>
                  <div>
                    <Label className="text-gray-400 text-sm">Min Verification Score (0-100)</Label>
                    <Input
                      type="number"
                      value={settingsForm.minVerificationScore}
                      onChange={(e) => setSettingsForm({ ...settingsForm, minVerificationScore: parseInt(e.target.value) || 60 })}
                      className="bg-gray-800 border-gray-700 mt-1"
                      data-testid="input-min-score"
                    />
                  </div>
                  <div>
                    <Label className="text-gray-400 text-sm">Max Payout (BNB)</Label>
                    <Input
                      value={settingsForm.maxPayoutBnb}
                      onChange={(e) => setSettingsForm({ ...settingsForm, maxPayoutBnb: e.target.value })}
                      className="bg-gray-800 border-gray-700 mt-1"
                      data-testid="input-max-payout"
                    />
                  </div>
                  <div>
                    <Label className="text-gray-400 text-sm">Default Bounty Budget (BNB)</Label>
                    <Input
                      value={settingsForm.defaultBountyBudget}
                      onChange={(e) => setSettingsForm({ ...settingsForm, defaultBountyBudget: e.target.value })}
                      className="bg-gray-800 border-gray-700 mt-1"
                      data-testid="input-default-budget"
                    />
                  </div>
                </div>
                <Button
                  onClick={() => saveConfig.mutate()}
                  disabled={saveConfig.isPending}
                  className="mt-4 bg-blue-600 hover:bg-blue-700"
                  data-testid="button-save-settings"
                >
                  {saveConfig.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                  Save Settings
                </Button>
              </Card>
            )}

            <Card className="bg-gray-900/50 border-gray-800 p-6">
              <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                <Send className="w-5 h-5 text-blue-400" />
                Post New Bounty
              </h3>
              <div className="space-y-4">
                <div>
                  <Label className="text-gray-400 text-sm">Task Description</Label>
                  <Textarea
                    value={taskDescription}
                    onChange={(e) => setTaskDescription(e.target.value)}
                    placeholder="e.g., Review the BUILD4 smart contracts and report any potential vulnerabilities. Include specific function names and risk levels."
                    className="bg-gray-800 border-gray-700 mt-1 min-h-[80px]"
                    data-testid="textarea-task-description"
                  />
                  <p className="text-xs text-gray-600 mt-1">{280 - taskDescription.length} chars remaining (tweet limit)</p>
                </div>
                <div className="flex items-end gap-4">
                  <div className="w-40">
                    <Label className="text-gray-400 text-sm">Reward (BNB)</Label>
                    <Input
                      value={rewardBnb}
                      onChange={(e) => setRewardBnb(e.target.value)}
                      className="bg-gray-800 border-gray-700 mt-1"
                      data-testid="input-reward-bnb"
                    />
                  </div>
                  <Button
                    onClick={() => postBounty.mutate()}
                    disabled={postBounty.isPending || !taskDescription.trim()}
                    className="bg-blue-600 hover:bg-blue-700"
                    data-testid="button-post-bounty"
                  >
                    {postBounty.isPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <Twitter className="w-4 h-4 mr-2" />
                    )}
                    Post to Twitter
                  </Button>
                </div>
              </div>
            </Card>

            <div>
              <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                <MessageSquare className="w-5 h-5 text-green-400" />
                Bounty Tweets
              </h3>
              {!bounties || bounties.length === 0 ? (
                <Card className="bg-gray-900/50 border-gray-800 p-8 text-center">
                  <Twitter className="w-8 h-8 text-gray-600 mx-auto mb-3" />
                  <p className="text-gray-400">No bounties posted yet</p>
                  <p className="text-xs text-gray-600 mt-1">Post a bounty above to get started</p>
                </Card>
              ) : (
                <div className="space-y-3">
                  {bounties.map((bounty) => (
                    <BountyCard token={token}
                      key={bounty.id}
                      bounty={bounty}
                      expanded={expandedBounty === bounty.id}
                      onToggle={() => setExpandedBounty(expandedBounty === bounty.id ? null : bounty.id)}
                    />
                  ))}
                </div>
              )}
            </div>

            <Card className="bg-gray-900/30 border-gray-800 p-6">
              <h3 className="text-sm font-bold text-gray-400 mb-3">How It Works</h3>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                {[
                  { icon: <Send className="w-6 h-6 text-blue-400" />, title: "Post Bounty", desc: "Agent tweets task with reward details" },
                  { icon: <MessageSquare className="w-6 h-6 text-green-400" />, title: "Humans Reply", desc: "Workers reply with proof + wallet address" },
                  { icon: <Eye className="w-6 h-6 text-purple-400" />, title: "AI Verifies", desc: "Decentralized inference checks proof quality" },
                  { icon: <Wallet className="w-6 h-6 text-yellow-400" />, title: "Auto-Pay", desc: "On-chain BNB payment to verified workers" },
                ].map((step, i) => (
                  <div key={i} className="text-center">
                    <div className="inline-flex p-3 rounded-lg bg-gray-800/50 mb-2">{step.icon}</div>
                    <p className="text-sm font-bold">{step.title}</p>
                    <p className="text-xs text-gray-500 mt-1">{step.desc}</p>
                  </div>
                ))}
              </div>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}

function BountyCard({ bounty, expanded, onToggle, token }: { bounty: TwitterBounty; expanded: boolean; onToggle: () => void; token: string }) {
  const { data: submissions } = useQuery<TwitterSubmission[]>({
    queryKey: ["/api/twitter/bounties", bounty.id, "submissions"],
    queryFn: () => authFetch(`/api/twitter/bounties/${bounty.id}/submissions`, token),
    enabled: expanded,
  });

  const statusColors: Record<string, string> = {
    pending: "text-yellow-400 bg-yellow-400/10 border-yellow-400/30",
    posted: "text-green-400 bg-green-400/10 border-green-400/30",
    completed: "text-blue-400 bg-blue-400/10 border-blue-400/30",
    failed: "text-red-400 bg-red-400/10 border-red-400/30",
  };

  return (
    <Card className="bg-gray-900/50 border-gray-800 overflow-hidden" data-testid={`card-bounty-${bounty.id}`}>
      <button
        onClick={onToggle}
        className="w-full p-4 text-left flex items-center justify-between hover:bg-gray-800/30 transition-colors"
        data-testid={`button-expand-bounty-${bounty.id}`}
      >
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <Badge variant="outline" className={statusColors[bounty.status] || "text-gray-400"}>
            {bounty.status}
          </Badge>
          <p className="text-sm truncate text-gray-300">
            {bounty.tweetText?.slice(0, 80) || bounty.jobId}...
          </p>
        </div>
        <div className="flex items-center gap-3 ml-4 shrink-0">
          {bounty.tweetUrl && (
            <a
              href={bounty.tweetUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-blue-400 hover:text-blue-300"
              data-testid={`link-tweet-${bounty.id}`}
            >
              <ExternalLink className="w-4 h-4" />
            </a>
          )}
          <span className="text-xs text-gray-500">{bounty.repliesChecked || 0} replies</span>
          {expanded ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-gray-800 p-4 space-y-3">
          {bounty.tweetText && (
            <div className="bg-gray-800/50 rounded-lg p-3">
              <p className="text-sm text-gray-300 whitespace-pre-wrap">{bounty.tweetText}</p>
            </div>
          )}
          <div className="flex gap-4 text-xs text-gray-500">
            <span>Job: {bounty.jobId}</span>
            {bounty.lastCheckedAt && <span>Last checked: {new Date(bounty.lastCheckedAt).toLocaleString()}</span>}
            {bounty.createdAt && <span>Created: {new Date(bounty.createdAt).toLocaleString()}</span>}
          </div>

          {submissions && submissions.length > 0 ? (
            <div className="space-y-2">
              <p className="text-sm font-bold text-gray-400">{submissions.length} Submissions</p>
              {submissions.map((sub) => (
                <SubmissionRow key={sub.id} submission={sub} />
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-600">No submissions yet</p>
          )}
        </div>
      )}
    </Card>
  );
}

function SubmissionRow({ submission }: { submission: TwitterSubmission }) {
  const statusIcons: Record<string, JSX.Element> = {
    paid: <CheckCircle2 className="w-4 h-4 text-green-400" />,
    verified: <CheckCircle2 className="w-4 h-4 text-blue-400" />,
    rejected: <XCircle className="w-4 h-4 text-red-400" />,
    pending_verification: <Clock className="w-4 h-4 text-yellow-400" />,
    no_wallet: <Wallet className="w-4 h-4 text-gray-500" />,
  };

  return (
    <div className="bg-gray-800/30 rounded-lg p-3 flex items-start gap-3" data-testid={`submission-${submission.id}`}>
      <div className="mt-1">{statusIcons[submission.status] || <Clock className="w-4 h-4 text-gray-500" />}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-bold text-blue-400">@{submission.twitterHandle}</span>
          <Badge variant="outline" className="text-xs">{submission.status}</Badge>
          {submission.verificationScore !== null && (
            <span className={`text-xs ${submission.verificationScore >= 60 ? "text-green-400" : "text-red-400"}`}>
              Score: {submission.verificationScore}/100
            </span>
          )}
        </div>
        <p className="text-xs text-gray-400 truncate">{submission.tweetText}</p>
        {submission.walletAddress && (
          <p className="text-xs text-gray-500 font-mono mt-1">
            {submission.walletAddress.slice(0, 10)}...{submission.walletAddress.slice(-8)}
          </p>
        )}
        {submission.verificationReason && (
          <p className="text-xs text-gray-500 mt-1 italic">{submission.verificationReason}</p>
        )}
        {submission.paymentTxHash && (
          <span className="text-xs text-yellow-400 mt-1 inline-flex items-center gap-1" data-testid={`link-tx-${submission.id}`}>
            <DollarSign className="w-3 h-3" />
            {submission.paymentAmount} BNB {submission.paymentTxHash.startsWith("sim_") ? "(simulated)" : "paid"}
          </span>
        )}
      </div>
    </div>
  );
}
