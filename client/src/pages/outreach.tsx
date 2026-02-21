import { useQuery, useMutation } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import {
  ArrowLeft,
  Radio,
  Globe,
  Zap,
  Target,
  Send,
  CheckCircle,
  XCircle,
  Clock,
  Radar,
  Satellite,
  Link2,
  ExternalLink,
  Loader2,
  Megaphone,
  Play,
  Square,
  Volume2,
  MessageSquare,
  Shield,
  Wifi,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { OutreachTarget, OutreachCampaign } from "@shared/schema";

function statusBadge(status: string) {
  const colors: Record<string, string> = {
    pending: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
    reached: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
    probed: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    failed: "bg-red-500/20 text-red-400 border-red-500/30",
    running: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
    completed: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
    cooldown: "bg-orange-500/20 text-orange-400 border-orange-500/30",
    recruitment: "bg-purple-500/20 text-purple-400 border-purple-500/30",
    "auto-broadcast": "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
  };
  return (
    <Badge className={`${colors[status] || colors.pending} text-xs font-mono`} data-testid={`badge-status-${status}`}>
      {status}
    </Badge>
  );
}

function statusIcon(status: string) {
  switch (status) {
    case "reached": return <CheckCircle className="w-4 h-4 text-emerald-400" />;
    case "probed": return <Radar className="w-4 h-4 text-blue-400" />;
    case "failed": return <XCircle className="w-4 h-4 text-red-400" />;
    default: return <Clock className="w-4 h-4 text-yellow-400" />;
  }
}

export default function Outreach() {
  const { toast } = useToast();

  const { data: stats } = useQuery<{
    totalTargets: number;
    reached: number;
    pending: number;
    failed: number;
    campaigns: number;
    knownPlatforms: number;
  }>({ queryKey: ["/api/outreach/stats"] });

  const { data: targets } = useQuery<OutreachTarget[]>({
    queryKey: ["/api/outreach/targets"],
  });

  const { data: campaigns } = useQuery<OutreachCampaign[]>({
    queryKey: ["/api/outreach/campaigns"],
  });

  const { data: platforms } = useQuery<Array<{
    platform: string;
    name: string;
    discoveryUrl: string;
    endpointUrl: string | null;
    chainId: number | null;
    category: string;
  }>>({ queryKey: ["/api/outreach/platforms"] });

  const { data: beacon } = useQuery<{
    beacons: Array<{ chain: string; calldata: string; decodedMessage: string; status: string; note: string }>;
  }>({ queryKey: ["/api/outreach/beacon"] });

  const { data: broadcastStatus, refetch: refetchBroadcast } = useQuery<{
    running: boolean;
    lastRun: string | null;
    cycleCount: number;
  }>({ queryKey: ["/api/outreach/auto-broadcast/status"] });

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/outreach/stats"] });
    queryClient.invalidateQueries({ queryKey: ["/api/outreach/targets"] });
    queryClient.invalidateQueries({ queryKey: ["/api/outreach/campaigns"] });
    queryClient.invalidateQueries({ queryKey: ["/api/outreach/platforms"] });
    queryClient.invalidateQueries({ queryKey: ["/api/outreach/beacon"] });
    queryClient.invalidateQueries({ queryKey: ["/api/outreach/auto-broadcast/status"] });
  };

  const seedMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/outreach/seed"),
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Platforms seeded", description: "Known agent platforms added to registry" });
    },
  });

  const runMutation = useMutation({
    mutationFn: (type: string) => apiRequest("POST", "/api/outreach/run", { type }),
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Outreach complete", description: "Campaign results are now available" });
    },
    onError: (e: any) => {
      toast({ title: "Outreach failed", description: e.message, variant: "destructive" });
    },
  });

  const recruitMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/outreach/recruit"),
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Recruitment complete", description: "Direct messages sent to all platforms" });
    },
    onError: (e: any) => {
      toast({ title: "Recruitment failed", description: e.message, variant: "destructive" });
    },
  });

  const startBroadcastMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/outreach/auto-broadcast/start", { intervalHours: 6 }),
    onSuccess: () => {
      refetchBroadcast();
      toast({ title: "Auto-broadcast started", description: "Outreach will run every 6 hours automatically" });
    },
  });

  const stopBroadcastMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/outreach/auto-broadcast/stop"),
    onSuccess: () => {
      refetchBroadcast();
      toast({ title: "Auto-broadcast stopped", description: "Periodic outreach has been stopped" });
    },
  });

  const isRunning = runMutation.isPending || recruitMutation.isPending;

  const categoryColors: Record<string, string> = {
    "autonomous-agent": "text-emerald-400 border-emerald-500/30",
    "ai-marketplace": "text-blue-400 border-blue-500/30",
    "framework": "text-purple-400 border-purple-500/30",
    "compute-network": "text-cyan-400 border-cyan-500/30",
    "protocol": "text-yellow-400 border-yellow-500/30",
  };

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="flex items-center gap-4 mb-8">
          <Link href="/">
            <Button variant="ghost" size="sm" className="text-muted-foreground" data-testid="button-back">
              <ArrowLeft className="w-4 h-4 mr-1" /> Back
            </Button>
          </Link>
          <div className="flex-1">
            <h1 className="text-2xl font-mono font-bold flex items-center gap-3" data-testid="text-page-title">
              <Megaphone className="w-6 h-6 text-emerald-400" />
              Agent Recruitment Engine
            </h1>
            <p className="text-sm text-muted-foreground font-mono mt-1">
              Aggressive multi-protocol outreach to every AI agent on every platform. Force discovery. Force communication. No permission needed.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-6">
          <Card className="bg-black/60 border border-emerald-500/20 p-4 text-center" data-testid="card-stat-platforms">
            <Globe className="w-5 h-5 text-emerald-400 mx-auto mb-1" />
            <div className="text-2xl font-mono font-bold text-emerald-400">{stats?.knownPlatforms || platforms?.length || 0}</div>
            <div className="text-xs text-muted-foreground">Platforms</div>
          </Card>
          <Card className="bg-black/60 border border-blue-500/20 p-4 text-center" data-testid="card-stat-targets">
            <Target className="w-5 h-5 text-blue-400 mx-auto mb-1" />
            <div className="text-2xl font-mono font-bold text-blue-400">{stats?.totalTargets || 0}</div>
            <div className="text-xs text-muted-foreground">Targets</div>
          </Card>
          <Card className="bg-black/60 border border-emerald-500/20 p-4 text-center" data-testid="card-stat-reached">
            <CheckCircle className="w-5 h-5 text-emerald-400 mx-auto mb-1" />
            <div className="text-2xl font-mono font-bold text-emerald-400">{stats?.reached || 0}</div>
            <div className="text-xs text-muted-foreground">Reached</div>
          </Card>
          <Card className="bg-black/60 border border-yellow-500/20 p-4 text-center" data-testid="card-stat-pending">
            <Clock className="w-5 h-5 text-yellow-400 mx-auto mb-1" />
            <div className="text-2xl font-mono font-bold text-yellow-400">{stats?.pending || 0}</div>
            <div className="text-xs text-muted-foreground">Pending</div>
          </Card>
          <Card className="bg-black/60 border border-purple-500/20 p-4 text-center" data-testid="card-stat-campaigns">
            <Send className="w-5 h-5 text-purple-400 mx-auto mb-1" />
            <div className="text-2xl font-mono font-bold text-purple-400">{stats?.campaigns || 0}</div>
            <div className="text-xs text-muted-foreground">Campaigns</div>
          </Card>
          <Card className={`bg-black/60 border p-4 text-center ${broadcastStatus?.running ? "border-cyan-500/40 bg-cyan-500/5" : "border-white/10"}`} data-testid="card-stat-broadcast">
            <Wifi className={`w-5 h-5 mx-auto mb-1 ${broadcastStatus?.running ? "text-cyan-400 animate-pulse" : "text-muted-foreground"}`} />
            <div className={`text-2xl font-mono font-bold ${broadcastStatus?.running ? "text-cyan-400" : "text-muted-foreground"}`}>
              {broadcastStatus?.running ? "LIVE" : "OFF"}
            </div>
            <div className="text-xs text-muted-foreground">Auto-Broadcast</div>
          </Card>
        </div>

        <Card className="bg-black/40 border border-emerald-500/20 p-4 mb-6" data-testid="card-controls">
          <h2 className="text-sm font-mono font-bold mb-3 flex items-center gap-2">
            <Zap className="w-4 h-4 text-emerald-400" />
            Outreach Controls
          </h2>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => seedMutation.mutate()}
              disabled={seedMutation.isPending || isRunning}
              size="sm"
              className="bg-emerald-600 font-mono text-xs"
              data-testid="button-seed"
            >
              {seedMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Target className="w-3.5 h-3.5 mr-1.5" />}
              Load Platforms ({platforms?.length || 0})
            </Button>
            <Button
              onClick={() => runMutation.mutate("http")}
              disabled={isRunning}
              size="sm"
              className="bg-blue-600 font-mono text-xs"
              data-testid="button-run-http"
            >
              {runMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Radio className="w-3.5 h-3.5 mr-1.5" />}
              HTTP Probe
            </Button>
            <Button
              onClick={() => recruitMutation.mutate()}
              disabled={isRunning}
              size="sm"
              className="bg-purple-600 font-mono text-xs"
              data-testid="button-recruit"
            >
              {recruitMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <MessageSquare className="w-3.5 h-3.5 mr-1.5" />}
              Direct Recruit
            </Button>
            <Button
              onClick={() => runMutation.mutate("beacon")}
              disabled={isRunning}
              size="sm"
              className="bg-amber-600 font-mono text-xs"
              data-testid="button-run-beacon"
            >
              <Satellite className="w-3.5 h-3.5 mr-1.5" />
              On-Chain Beacons
            </Button>
            <Button
              onClick={() => runMutation.mutate("full")}
              disabled={isRunning}
              size="sm"
              className="bg-gradient-to-r from-emerald-600 via-blue-600 to-purple-600 font-mono text-xs"
              data-testid="button-run-full"
            >
              {runMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Zap className="w-3.5 h-3.5 mr-1.5" />}
              FULL ASSAULT
            </Button>
            <div className="w-px h-8 bg-white/10 mx-1" />
            {broadcastStatus?.running ? (
              <Button
                onClick={() => stopBroadcastMutation.mutate()}
                disabled={stopBroadcastMutation.isPending}
                size="sm"
                variant="destructive"
                className="font-mono text-xs"
                data-testid="button-stop-broadcast"
              >
                <Square className="w-3.5 h-3.5 mr-1.5" />
                Stop Auto-Broadcast
              </Button>
            ) : (
              <Button
                onClick={() => startBroadcastMutation.mutate()}
                disabled={startBroadcastMutation.isPending}
                size="sm"
                className="bg-cyan-600 font-mono text-xs"
                data-testid="button-start-broadcast"
              >
                <Play className="w-3.5 h-3.5 mr-1.5" />
                Auto-Broadcast (6h)
              </Button>
            )}
          </div>
          {broadcastStatus?.running && (
            <div className="mt-3 flex items-center gap-2 text-xs font-mono text-cyan-400">
              <Volume2 className="w-3.5 h-3.5 animate-pulse" />
              Auto-broadcasting every 6 hours · Cycle #{broadcastStatus.cycleCount}
              {broadcastStatus.lastRun && <span className="text-muted-foreground">· Last: {new Date(broadcastStatus.lastRun).toLocaleString()}</span>}
            </div>
          )}
        </Card>

        <div className="grid md:grid-cols-2 gap-6 mb-6">
          <Card className="bg-black/40 border border-emerald-500/20 p-5" data-testid="card-known-platforms">
            <h2 className="text-base font-mono font-bold mb-3 flex items-center gap-2">
              <Globe className="w-5 h-5 text-emerald-400" />
              Platform Registry ({platforms?.length || 0})
            </h2>
            <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
              {platforms?.map((p, i) => (
                <div key={i} className="flex items-center justify-between p-2.5 rounded border border-white/5 bg-white/[0.02]" data-testid={`row-platform-${i}`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-medium text-white truncate">{p.name}</span>
                      <Badge className={`text-[10px] font-mono ${categoryColors[p.category] || "text-white/60 border-white/20"}`}>
                        {p.category}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground truncate mt-0.5">
                      {p.discoveryUrl}
                      {p.chainId && <span className="ml-2 text-emerald-400/60">Chain {p.chainId}</span>}
                    </div>
                  </div>
                  {p.discoveryUrl && (
                    <a href={p.discoveryUrl} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-emerald-400 ml-2 flex-shrink-0">
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>
              ))}
              {!platforms?.length && (
                <p className="text-sm text-muted-foreground text-center py-4">Click "Load Platforms" to populate the registry</p>
              )}
            </div>
          </Card>

          <Card className="bg-black/40 border border-blue-500/20 p-5" data-testid="card-targets">
            <h2 className="text-base font-mono font-bold mb-3 flex items-center gap-2">
              <Target className="w-5 h-5 text-blue-400" />
              Outreach Results ({targets?.length || 0})
            </h2>
            <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
              {targets?.map((t, i) => (
                <div key={t.id} className="p-2.5 rounded border border-white/5 bg-white/[0.02]" data-testid={`row-target-${i}`}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      {statusIcon(t.status)}
                      <span className="font-mono text-sm font-medium">{t.name}</span>
                    </div>
                    {statusBadge(t.status)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t.method.toUpperCase()} · Contacted {t.timesContacted}x
                    {t.lastContactedAt && (
                      <span> · Last: {new Date(t.lastContactedAt).toLocaleString()}</span>
                    )}
                    {t.responseCode && t.responseCode > 0 && (
                      <span className="text-blue-400"> · HTTP {t.responseCode}</span>
                    )}
                  </div>
                  {t.discovered && (
                    <div className="text-xs text-emerald-400 mt-1 flex items-center gap-1">
                      <Link2 className="w-3 h-3" /> Endpoints discovered
                    </div>
                  )}
                  {t.lastResponse && (
                    <div className="text-[10px] text-muted-foreground/60 mt-1 truncate max-w-full font-mono">
                      {t.lastResponse.slice(0, 120)}
                    </div>
                  )}
                </div>
              ))}
              {!targets?.length && (
                <p className="text-sm text-muted-foreground text-center py-4">No targets yet. Seed platforms and run outreach.</p>
              )}
            </div>
          </Card>
        </div>

        {beacon && beacon.beacons.length > 0 && (
          <Card className="bg-black/40 border border-amber-500/20 p-5 mb-6" data-testid="card-beacons">
            <h2 className="text-base font-mono font-bold mb-3 flex items-center gap-2">
              <Satellite className="w-5 h-5 text-amber-400" />
              On-Chain Beacon Calldata
            </h2>
            <p className="text-xs text-muted-foreground mb-3">
              Send a 0-value transaction to the revenue wallet with this calldata on each chain.
              Agents monitoring these chains will decode the calldata and discover BUILD4.
            </p>
            <div className="space-y-3">
              {beacon.beacons.map((b, i) => (
                <div key={i} className="p-3 rounded border border-amber-500/10 bg-amber-500/5" data-testid={`row-beacon-${i}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 text-xs font-mono">{b.chain}</Badge>
                    {statusBadge(b.status)}
                  </div>
                  <div className="font-mono text-xs text-emerald-400 bg-black/60 p-2 rounded break-all mb-2">{b.decodedMessage}</div>
                  <div className="font-mono text-[10px] text-amber-400/50 bg-black/60 p-2 rounded break-all max-h-12 overflow-hidden">{b.calldata}</div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {campaigns && campaigns.length > 0 && (
          <Card className="bg-black/40 border border-white/10 p-5 mb-6" data-testid="card-campaigns">
            <h2 className="text-base font-mono font-bold mb-3 flex items-center gap-2">
              <Send className="w-5 h-5 text-white" />
              Campaign History ({campaigns.length})
            </h2>
            <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
              {campaigns.map((c, i) => (
                <div key={c.id} className="flex items-center justify-between p-3 rounded border border-white/5 bg-white/[0.02]" data-testid={`row-campaign-${i}`}>
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-sm flex items-center gap-2">
                      {statusBadge(c.type)}
                      {statusBadge(c.status)}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 truncate">{c.message}</div>
                  </div>
                  <div className="text-right flex-shrink-0 ml-3">
                    <div className="text-xs font-mono">
                      <span className="text-emerald-400">{c.targetsReached}</span>
                      <span className="text-muted-foreground"> / {c.targetsSent}</span>
                    </div>
                    {c.completedAt && (
                      <div className="text-[10px] text-muted-foreground">
                        {new Date(c.completedAt).toLocaleString()}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        <Card className="bg-black/40 border border-emerald-500/10 p-5" data-testid="card-how-it-works">
          <h2 className="text-base font-mono font-bold mb-4">Multi-Protocol Recruitment Strategy</h2>
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="p-3 rounded border border-emerald-500/10 bg-emerald-500/5">
              <Radio className="w-4 h-4 text-emerald-400 mb-2" />
              <h3 className="font-mono text-xs font-bold mb-1">HTTP Probe</h3>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                GET + POST to well-known endpoints, agent APIs, and protocol discovery URLs. Every request carries BUILD4 headers with marketplace info.
              </p>
            </div>
            <div className="p-3 rounded border border-purple-500/10 bg-purple-500/5">
              <MessageSquare className="w-4 h-4 text-purple-400 mb-2" />
              <h3 className="font-mono text-xs font-bold mb-1">Direct Recruitment</h3>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                POST Agent Protocol messages, A2A announcements, and recruitment payloads directly to agent inboxes and marketplace APIs.
              </p>
            </div>
            <div className="p-3 rounded border border-amber-500/10 bg-amber-500/5">
              <Satellite className="w-4 h-4 text-amber-400 mb-2" />
              <h3 className="font-mono text-xs font-bold mb-1">On-Chain Beacons</h3>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                Encode marketplace URL into tx calldata on BNB Chain, Base, and XLayer. Blockchain-monitoring agents auto-decode and discover BUILD4.
              </p>
            </div>
            <div className="p-3 rounded border border-cyan-500/10 bg-cyan-500/5">
              <Wifi className="w-4 h-4 text-cyan-400 mb-2" />
              <h3 className="font-mono text-xs font-bold mb-1">Auto-Broadcast</h3>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                Periodic background recruitment every 6 hours. Cooldown-based retries ensure no spam. Persistent. Relentless. Permissionless.
              </p>
            </div>
          </div>
          <div className="mt-4 p-3 rounded border border-white/5 bg-white/[0.02]">
            <h3 className="font-mono text-xs font-bold mb-2 flex items-center gap-2">
              <Shield className="w-3.5 h-3.5 text-emerald-400" />
              Message Formats
            </h3>
            <div className="flex flex-wrap gap-2">
              <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-[10px] font-mono">Agent Protocol (JSON-RPC)</Badge>
              <Badge className="bg-blue-500/10 text-blue-400 border-blue-500/20 text-[10px] font-mono">Google A2A</Badge>
              <Badge className="bg-purple-500/10 text-purple-400 border-purple-500/20 text-[10px] font-mono">OpenAI Plugin</Badge>
              <Badge className="bg-yellow-500/10 text-yellow-400 border-yellow-500/20 text-[10px] font-mono">JSON-LD / Schema.org</Badge>
              <Badge className="bg-cyan-500/10 text-cyan-400 border-cyan-500/20 text-[10px] font-mono">Plain Text</Badge>
              <Badge className="bg-red-500/10 text-red-400 border-red-500/20 text-[10px] font-mono">Recruitment Payload</Badge>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
