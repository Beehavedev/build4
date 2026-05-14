import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Link } from "wouter";
import { SEO } from "@/components/seo";
import {
  ArrowLeft, Rocket, Coins, ExternalLink, Loader2,
  CheckCircle2, XCircle, Clock, Zap, Globe, Lock,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface TokenLaunch {
  id: string;
  agentId: string | null;
  creatorWallet: string | null;
  platform: string;
  chainId: number;
  tokenName: string;
  tokenSymbol: string;
  tokenDescription: string | null;
  imageUrl: string | null;
  tokenAddress: string | null;
  txHash: string | null;
  launchUrl: string | null;
  initialLiquidityBnb: string | null;
  status: string;
  errorMessage: string | null;
  createdAt: string;
}

interface LaunchPlatform {
  id: string;
  name: string;
  chain: string;
  chainId: number;
  url: string;
}

function getStatusBadge(status: string) {
  switch (status) {
    case "launched":
      return <Badge className="bg-green-500/20 text-green-400 border-green-500/30" data-testid="status-launched"><CheckCircle2 className="w-3 h-3 mr-1" />Launched</Badge>;
    case "confirming":
      return <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30" data-testid="status-confirming"><Clock className="w-3 h-3 mr-1" />Confirming</Badge>;
    case "pending":
      return <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30" data-testid="status-pending"><Clock className="w-3 h-3 mr-1" />Pending</Badge>;
    case "failed":
      return <Badge className="bg-red-500/20 text-red-400 border-red-500/30" data-testid="status-failed"><XCircle className="w-3 h-3 mr-1" />Failed</Badge>;
    default:
      return <Badge data-testid={`status-${status}`}>{status}</Badge>;
  }
}

function getExplorerUrl(chainId: number, txHash: string): string {
  if (chainId === 56) return `https://bscscan.com/tx/${txHash}`;
  if (chainId === 8453) return `https://basescan.org/tx/${txHash}`;
  return `https://bscscan.com/tx/${txHash}`;
}

function getPlatformLabel(platform: string): string {
  if (platform === "four_meme") return "Four.meme";
  if (platform === "flap_sh") return "Flap.sh";
  return platform;
}

function getChainLabel(chainId: number): string {
  if (chainId === 56) return "BNB Chain";
  if (chainId === 8453) return "Base";
  return `Chain ${chainId}`;
}

export default function TokenLauncher() {
  const [token, setToken] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const stored = sessionStorage.getItem("analytics_token");
    if (!stored) {
      setChecking(false);
      return;
    }
    fetch("/api/token-launcher/platforms", { headers: { "x-analytics-token": stored } })
      .then(res => {
        if (res.ok) {
          setToken(stored);
        } else {
          sessionStorage.removeItem("analytics_token");
        }
        setChecking(false);
      })
      .catch(() => {
        sessionStorage.removeItem("analytics_token");
        setChecking(false);
      });
  }, []);

  if (checking) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-orange-400" />
      </div>
    );
  }

  if (!token) {
    return <LauncherLoginGate onLogin={setToken} />;
  }

  return <LauncherDashboard token={token} onLogout={() => { sessionStorage.removeItem("analytics_token"); setToken(null); }} />;
}

function LauncherLoginGate({ onLogin }: { onLogin: (token: string) => void }) {
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
          <div className="inline-flex p-3 rounded-lg bg-orange-500/20 mb-3">
            <Lock className="w-6 h-6 text-orange-400" />
          </div>
          <h2 className="text-xl font-bold" data-testid="text-login-title">Token Launcher</h2>
          <p className="text-sm text-gray-400 mt-1">Admin access required</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            type="password"
            placeholder="Admin password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="bg-gray-800 border-gray-700"
            data-testid="input-password"
          />
          {error && <p className="text-red-400 text-sm" data-testid="text-error">{error}</p>}
          <Button type="submit" className="w-full bg-orange-600 hover:bg-orange-700" disabled={loading || !password} data-testid="button-login">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Login"}
          </Button>
        </form>
      </Card>
    </div>
  );
}

function LauncherDashboard({ token, onLogout }: { token: string; onLogout: () => void }) {
  const { toast } = useToast();
  const [tokenName, setTokenName] = useState("");
  const [tokenSymbol, setTokenSymbol] = useState("");
  const [tokenDescription, setTokenDescription] = useState("");
  const [platform, setPlatform] = useState<string>("four_meme");
  const [liquidity, setLiquidity] = useState("0.01");

  const { data: platforms, isLoading: platformsLoading } = useQuery<LaunchPlatform[]>({
    queryKey: ["/api/token-launcher/platforms"],
  });

  const { data: launches, isLoading: launchesLoading } = useQuery<TokenLaunch[]>({
    queryKey: ["/api/token-launcher/launches"],
    refetchInterval: 10000,
  });

  const launchMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/token-launcher/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-analytics-token": token },
        body: JSON.stringify({
          tokenName,
          tokenSymbol: tokenSymbol.toUpperCase(),
          tokenDescription,
          platform,
          initialLiquidityBnb: liquidity,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Launch failed" }));
        throw new Error(err.error || "Launch failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/token-launcher/launches"] });
      if (data.success) {
        toast({ title: "Token Launched!", description: `${tokenName} ($${tokenSymbol.toUpperCase()}) is live on ${getPlatformLabel(platform)}` });
        setTokenName("");
        setTokenSymbol("");
        setTokenDescription("");
      } else {
        toast({ title: "Launch Failed", description: data.error, variant: "destructive" });
      }
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const selectedPlatform = platforms?.find(p => p.id === platform);

  return (
    <>
      <SEO
        title="Token Launcher - BUILD4"
        description="Let autonomous AI agents launch tokens on launchpads like Four.meme and Flap.sh"
      />
      <div className="min-h-screen bg-black text-white">
        <div className="max-w-6xl mx-auto px-4 py-8">
          <div className="flex items-center gap-4 mb-8">
            <Link href="/">
              <Button variant="ghost" size="sm" className="text-zinc-400 hover:text-white" data-testid="link-back">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-page-title">
                <Rocket className="w-6 h-6 text-orange-400" />
                Token Launcher
              </h1>
              <p className="text-zinc-400 text-sm mt-1">Launch tokens on meme launchpads — agents can do it autonomously too</p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-1">
              <Card className="bg-zinc-900 border-zinc-800 p-6">
                <h2 className="text-lg font-semibold mb-4 flex items-center gap-2" data-testid="text-launch-form-title">
                  <Zap className="w-5 h-5 text-yellow-400" />
                  Launch a Token
                </h2>

                <div className="space-y-4">
                  <div>
                    <label className="text-sm text-zinc-400 mb-1 block">Platform</label>
                    <div className="grid grid-cols-2 gap-2">
                      {(platforms || []).map((p) => (
                        <button
                          key={p.id}
                          onClick={() => {
                            setPlatform(p.id);
                            setLiquidity(p.id === "four_meme" ? "0.01" : "0.001");
                          }}
                          className={`p-3 rounded-lg border text-left transition-all ${
                            platform === p.id
                              ? "border-orange-500 bg-orange-500/10"
                              : "border-zinc-700 bg-zinc-800 hover:border-zinc-600"
                          }`}
                          data-testid={`button-platform-${p.id}`}
                        >
                          <div className="text-sm font-medium">{p.name}</div>
                          <div className="text-xs text-zinc-500">{p.chain}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="text-sm text-zinc-400 mb-1 block">Token Name</label>
                    <Input
                      value={tokenName}
                      onChange={(e) => setTokenName(e.target.value)}
                      placeholder="e.g. AgentCoin"
                      className="bg-zinc-800 border-zinc-700"
                      data-testid="input-token-name"
                    />
                  </div>

                  <div>
                    <label className="text-sm text-zinc-400 mb-1 block">Symbol</label>
                    <Input
                      value={tokenSymbol}
                      onChange={(e) => setTokenSymbol(e.target.value.toUpperCase().slice(0, 10))}
                      placeholder="e.g. AGENT"
                      className="bg-zinc-800 border-zinc-700"
                      data-testid="input-token-symbol"
                    />
                  </div>

                  <div>
                    <label className="text-sm text-zinc-400 mb-1 block">Description</label>
                    <Textarea
                      value={tokenDescription}
                      onChange={(e) => setTokenDescription(e.target.value)}
                      placeholder="What is this token about?"
                      className="bg-zinc-800 border-zinc-700 min-h-[80px]"
                      data-testid="input-token-description"
                    />
                  </div>

                  <div>
                    <label className="text-sm text-zinc-400 mb-1 block">
                      Initial Liquidity ({selectedPlatform?.chain === "Base" ? "ETH" : "BNB"})
                    </label>
                    <Input
                      value={liquidity}
                      onChange={(e) => setLiquidity(e.target.value)}
                      placeholder="0.01"
                      className="bg-zinc-800 border-zinc-700"
                      data-testid="input-liquidity"
                    />
                  </div>

                  <Button
                    onClick={() => launchMutation.mutate()}
                    disabled={!tokenName || !tokenSymbol || launchMutation.isPending}
                    className="w-full bg-orange-600 hover:bg-orange-700 text-white"
                    data-testid="button-launch-token"
                  >
                    {launchMutation.isPending ? (
                      <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Launching...</>
                    ) : (
                      <><Rocket className="w-4 h-4 mr-2" />Launch Token</>
                    )}
                  </Button>

                  <p className="text-xs text-zinc-500 text-center">
                    Tokens are launched via {selectedPlatform?.name || "the selected launchpad"} smart contracts on {selectedPlatform?.chain || "chain"}
                  </p>
                </div>
              </Card>

              <Card className="bg-zinc-900 border-zinc-800 p-6 mt-4">
                <h3 className="text-sm font-semibold text-zinc-300 mb-3">Supported Launchpads</h3>
                <div className="space-y-3">
                  {(platforms || []).map((p) => (
                    <div key={p.id} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <Globe className="w-4 h-4 text-zinc-500" />
                        <span>{p.name}</span>
                      </div>
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-orange-400 hover:text-orange-300 flex items-center gap-1"
                        data-testid={`link-platform-${p.id}`}
                      >
                        {p.chain}
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  ))}
                </div>
              </Card>
            </div>

            <div className="lg:col-span-2">
              <Card className="bg-zinc-900 border-zinc-800 p-6">
                <h2 className="text-lg font-semibold mb-4 flex items-center gap-2" data-testid="text-launches-title">
                  <Coins className="w-5 h-5 text-yellow-400" />
                  Token Launches
                  {launches && <Badge variant="outline" className="ml-2" data-testid="text-launch-count">{launches.length}</Badge>}
                </h2>

                {launchesLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
                  </div>
                ) : !launches || launches.length === 0 ? (
                  <div className="text-center py-12 text-zinc-500">
                    <Rocket className="w-12 h-12 mx-auto mb-3 opacity-30" />
                    <p>No tokens launched yet</p>
                    <p className="text-sm mt-1">Launch the first one or wait for agents to do it autonomously</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {launches.map((launch) => (
                      <div
                        key={launch.id}
                        className="p-4 rounded-lg bg-zinc-800/50 border border-zinc-700/50 hover:border-zinc-600/50 transition-all"
                        data-testid={`card-launch-${launch.id}`}
                      >
                        <div className="flex items-start justify-between">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-semibold" data-testid={`text-token-name-${launch.id}`}>{launch.tokenName}</span>
                              <Badge variant="outline" className="text-xs" data-testid={`text-token-symbol-${launch.id}`}>${launch.tokenSymbol}</Badge>
                              {getStatusBadge(launch.status)}
                            </div>
                            <div className="flex items-center gap-3 mt-1 text-xs text-zinc-500">
                              <span className="flex items-center gap-1">
                                <Globe className="w-3 h-3" />
                                {getPlatformLabel(launch.platform)}
                              </span>
                              <span>{getChainLabel(launch.chainId)}</span>
                              {launch.initialLiquidityBnb && (
                                <span>{launch.initialLiquidityBnb} {launch.chainId === 8453 ? "ETH" : "BNB"}</span>
                              )}
                              <span>{new Date(launch.createdAt).toLocaleString()}</span>
                            </div>
                            {launch.tokenDescription && (
                              <p className="text-xs text-zinc-400 mt-2 line-clamp-2">{launch.tokenDescription}</p>
                            )}
                            {launch.errorMessage && (
                              <p className="text-xs text-red-400 mt-2">{launch.errorMessage}</p>
                            )}
                          </div>
                          <div className="flex gap-2">
                            {launch.txHash && (
                              <a
                                href={getExplorerUrl(launch.chainId, launch.txHash)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-orange-400 hover:text-orange-300 flex items-center gap-1"
                                data-testid={`link-tx-${launch.id}`}
                              >
                                TX
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                            {launch.launchUrl && (
                              <a
                                href={launch.launchUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-green-400 hover:text-green-300 flex items-center gap-1"
                                data-testid={`link-launch-${launch.id}`}
                              >
                                View
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                          </div>
                        </div>
                        {launch.tokenAddress && (
                          <div className="mt-2 text-xs font-mono text-zinc-400 bg-zinc-900/50 px-2 py-1 rounded" data-testid={`text-token-address-${launch.id}`}>
                            Token: {launch.tokenAddress}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
