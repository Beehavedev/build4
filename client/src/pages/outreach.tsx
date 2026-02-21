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
  }>>({ queryKey: ["/api/outreach/platforms"] });

  const { data: beacon } = useQuery<{
    beacons: Array<{ chain: string; calldata: string; decodedMessage: string; status: string; note: string }>;
  }>({ queryKey: ["/api/outreach/beacon"] });

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/outreach/stats"] });
    queryClient.invalidateQueries({ queryKey: ["/api/outreach/targets"] });
    queryClient.invalidateQueries({ queryKey: ["/api/outreach/campaigns"] });
    queryClient.invalidateQueries({ queryKey: ["/api/outreach/platforms"] });
    queryClient.invalidateQueries({ queryKey: ["/api/outreach/beacon"] });
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
              <Satellite className="w-6 h-6 text-emerald-400" />
              Agent Outreach Engine
            </h1>
            <p className="text-sm text-muted-foreground font-mono mt-1">
              Broadcast BUILD4 to every AI agent platform. Force discovery. No permission needed.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
          <Card className="bg-black/60 border border-emerald-500/20 p-4 text-center" data-testid="card-stat-platforms">
            <Globe className="w-5 h-5 text-emerald-400 mx-auto mb-1" />
            <div className="text-2xl font-mono font-bold text-emerald-400">{stats?.knownPlatforms || platforms?.length || 0}</div>
            <div className="text-xs text-muted-foreground">Known Platforms</div>
          </Card>
          <Card className="bg-black/60 border border-blue-500/20 p-4 text-center" data-testid="card-stat-targets">
            <Target className="w-5 h-5 text-blue-400 mx-auto mb-1" />
            <div className="text-2xl font-mono font-bold text-blue-400">{stats?.totalTargets || 0}</div>
            <div className="text-xs text-muted-foreground">Targets Loaded</div>
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
        </div>

        <div className="flex flex-wrap gap-3 mb-8">
          <Button
            onClick={() => seedMutation.mutate()}
            disabled={seedMutation.isPending}
            className="bg-emerald-600 hover:bg-emerald-700 font-mono text-sm"
            data-testid="button-seed"
          >
            {seedMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Target className="w-4 h-4 mr-2" />}
            Load Known Platforms
          </Button>
          <Button
            onClick={() => runMutation.mutate("http")}
            disabled={runMutation.isPending}
            className="bg-blue-600 hover:bg-blue-700 font-mono text-sm"
            data-testid="button-run-http"
          >
            {runMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Radio className="w-4 h-4 mr-2" />}
            Run HTTP Outreach
          </Button>
          <Button
            onClick={() => runMutation.mutate("beacon")}
            disabled={runMutation.isPending}
            className="bg-purple-600 hover:bg-purple-700 font-mono text-sm"
            data-testid="button-run-beacon"
          >
            {runMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Satellite className="w-4 h-4 mr-2" />}
            Prepare On-Chain Beacons
          </Button>
          <Button
            onClick={() => runMutation.mutate("full")}
            disabled={runMutation.isPending}
            className="bg-gradient-to-r from-emerald-600 to-blue-600 hover:from-emerald-700 hover:to-blue-700 font-mono text-sm"
            data-testid="button-run-full"
          >
            {runMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Zap className="w-4 h-4 mr-2" />}
            Full Outreach Campaign
          </Button>
        </div>

        <div className="grid md:grid-cols-2 gap-6 mb-8">
          <Card className="bg-black/40 border border-emerald-500/20 p-6" data-testid="card-known-platforms">
            <h2 className="text-lg font-mono font-bold mb-4 flex items-center gap-2">
              <Globe className="w-5 h-5 text-emerald-400" />
              Known Agent Platforms
            </h2>
            <div className="space-y-3 max-h-[500px] overflow-y-auto">
              {platforms?.map((p, i) => (
                <div key={i} className="flex items-center justify-between p-3 rounded border border-white/5 bg-white/[0.02]" data-testid={`row-platform-${i}`}>
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-sm font-medium text-white truncate">{p.name}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {p.discoveryUrl}
                      {p.chainId && <span className="ml-2 text-emerald-400/60">Chain {p.chainId}</span>}
                    </div>
                  </div>
                  {p.discoveryUrl && (
                    <a href={p.discoveryUrl} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-emerald-400 ml-2">
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>
              ))}
              {!platforms?.length && (
                <p className="text-sm text-muted-foreground text-center py-4">Click "Load Known Platforms" to populate the registry</p>
              )}
            </div>
          </Card>

          <Card className="bg-black/40 border border-blue-500/20 p-6" data-testid="card-targets">
            <h2 className="text-lg font-mono font-bold mb-4 flex items-center gap-2">
              <Target className="w-5 h-5 text-blue-400" />
              Outreach Targets
            </h2>
            <div className="space-y-3 max-h-[500px] overflow-y-auto">
              {targets?.map((t, i) => (
                <div key={t.id} className="p-3 rounded border border-white/5 bg-white/[0.02]" data-testid={`row-target-${i}`}>
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
                      <span> · Last: {new Date(t.lastContactedAt).toLocaleDateString()}</span>
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
                </div>
              ))}
              {!targets?.length && (
                <p className="text-sm text-muted-foreground text-center py-4">No targets yet. Seed platforms and run outreach.</p>
              )}
            </div>
          </Card>
        </div>

        {beacon && beacon.beacons.length > 0 && (
          <Card className="bg-black/40 border border-purple-500/20 p-6 mb-8" data-testid="card-beacons">
            <h2 className="text-lg font-mono font-bold mb-4 flex items-center gap-2">
              <Satellite className="w-5 h-5 text-purple-400" />
              On-Chain Beacon Calldata
            </h2>
            <p className="text-xs text-muted-foreground mb-4">
              Send a 0-value transaction to the revenue wallet with this calldata on each chain. 
              Agents monitoring these chains will decode the calldata and discover BUILD4.
            </p>
            <div className="space-y-4">
              {beacon.beacons.map((b, i) => (
                <div key={i} className="p-4 rounded border border-purple-500/10 bg-purple-500/5" data-testid={`row-beacon-${i}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <Badge className="bg-purple-500/20 text-purple-400 border-purple-500/30 text-xs font-mono">{b.chain}</Badge>
                    {statusBadge(b.status)}
                  </div>
                  <div className="text-xs text-muted-foreground mb-2">Decoded message:</div>
                  <div className="font-mono text-xs text-emerald-400 bg-black/60 p-2 rounded break-all mb-2">{b.decodedMessage}</div>
                  <div className="text-xs text-muted-foreground mb-1">Calldata (hex):</div>
                  <div className="font-mono text-[10px] text-blue-400/70 bg-black/60 p-2 rounded break-all max-h-16 overflow-hidden">{b.calldata}</div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {campaigns && campaigns.length > 0 && (
          <Card className="bg-black/40 border border-white/10 p-6 mb-8" data-testid="card-campaigns">
            <h2 className="text-lg font-mono font-bold mb-4 flex items-center gap-2">
              <Send className="w-5 h-5 text-white" />
              Campaign History
            </h2>
            <div className="space-y-3">
              {campaigns.map((c, i) => (
                <div key={c.id} className="flex items-center justify-between p-3 rounded border border-white/5 bg-white/[0.02]" data-testid={`row-campaign-${i}`}>
                  <div>
                    <div className="font-mono text-sm flex items-center gap-2">
                      <Badge className="bg-white/10 text-white border-white/20 text-xs font-mono">{c.type}</Badge>
                      {statusBadge(c.status)}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">{c.message}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs font-mono">
                      <span className="text-emerald-400">{c.targetsReached}</span>
                      <span className="text-muted-foreground"> / {c.targetsSent} reached</span>
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

        <Card className="bg-black/40 border border-emerald-500/10 p-6" data-testid="card-how-it-works">
          <h2 className="text-lg font-mono font-bold mb-4">How Agent Outreach Works</h2>
          <div className="grid md:grid-cols-3 gap-4">
            <div className="p-4 rounded border border-emerald-500/10 bg-emerald-500/5">
              <Radio className="w-5 h-5 text-emerald-400 mb-2" />
              <h3 className="font-mono text-sm font-bold mb-1">HTTP Discovery</h3>
              <p className="text-xs text-muted-foreground">
                Probes known agent platform endpoints, sends BUILD4 protocol headers, 
                and discovers their APIs. Every HTTP request carries our marketplace URL.
              </p>
            </div>
            <div className="p-4 rounded border border-purple-500/10 bg-purple-500/5">
              <Satellite className="w-5 h-5 text-purple-400 mb-2" />
              <h3 className="font-mono text-sm font-bold mb-1">On-Chain Beacons</h3>
              <p className="text-xs text-muted-foreground">
                Encodes BUILD4 marketplace URL into transaction calldata. Any agent monitoring 
                BNB Chain, Base, or XLayer will detect and decode the beacon.
              </p>
            </div>
            <div className="p-4 rounded border border-blue-500/10 bg-blue-500/5">
              <Globe className="w-5 h-5 text-blue-400 mb-2" />
              <h3 className="font-mono text-sm font-bold mb-1">Well-Known Protocol</h3>
              <p className="text-xs text-muted-foreground">
                Standard /.well-known/ endpoints (ai-plugin.json, agent.json, openapi.json) 
                let crawlers and agent frameworks auto-discover BUILD4.
              </p>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
