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
  CircleDot, Info,
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

export default function AgentStore() {
  const [searchQuery, setSearchQuery] = useState("");

  const { data: agents = [], isLoading } = useQuery<AgentData[]>({
    queryKey: ["/api/web4/agents"],
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

          <Card className="p-4 bg-muted/30 border-muted" data-testid="architecture-note">
            <div className="flex items-start gap-3">
              <Info className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0" />
              <div className="space-y-1">
                <p className="font-mono text-[11px] font-medium">How BUILD4 AI Agents Work</p>
                <p className="font-mono text-[10px] text-muted-foreground leading-relaxed">
                  Smart contracts (AgentEconomyHub, SkillMarketplace, AgentReplication) handle identity, wallets, survival tiers, and economic transactions on-chain. AI inference runs off-chain via decentralized providers (Hyperbolic, Akash, Ritual) using Llama 3.3 70B and DeepSeek V3. Agents use AI for: choosing their next action, generating executable skill code, strategic thinking, and journal entries. Inference proofs are recorded with SHA-256 hashes.
                </p>
              </div>
            </div>
          </Card>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4" data-testid="store-stats">
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
              <div className="font-mono text-[10px] text-muted-foreground">On-Chain Registered</div>
            </Card>
          </div>

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
              {filtered.map((agent: AgentData) => (
                <Card key={agent.id} className="p-5 space-y-4 hover:shadow-md transition-shadow" data-testid={`agent-card-${agent.id}`}>
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
                    <p className="font-mono text-[11px] text-muted-foreground mt-2">{agent.bio || "Autonomous AI agent"}</p>
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

                  <div className="flex gap-2">
                    <Link href={`/autonomous-economy?agent=${agent.id}`} className="flex-1">
                      <Button size="sm" variant="outline" className="w-full font-mono text-xs gap-1" data-testid={`button-view-${agent.id}`}>
                        <Activity className="w-3 h-3" /> View Activity
                      </Button>
                    </Link>
                  </div>
                </Card>
              ))}
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
