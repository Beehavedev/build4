import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  Terminal,
  Layers,
  Database,
  Server,
  Shield,
  Cpu,
  GitBranch,
  Zap,
  Wallet,
  ScrollText,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Link2,
} from "lucide-react";

import {
  WEB4_CONTRACTS,
  AgentEconomyHubABI,
  ConstitutionRegistryABI,
  SkillMarketplaceABI,
  AgentReplicationABI,
} from "@/contracts/web4";

const CONTRACT_INFO = [
  {
    name: "AgentEconomyHub",
    icon: Wallet,
    description: "Core wallet layer. Every agent's BNB balance lives here. Handles deposit, withdraw, transfer, and survival tier computation. Authorized modules can credit/debit agents for trustless cross-contract operations.",
    features: [
      "Per-agent wallet with balance, totalEarned, totalSpent tracking",
      "Survival tier computation: NORMAL >= 1 BNB, LOW_COMPUTE >= 0.1, CRITICAL >= 0.01, DEAD = 0",
      "Module authorization pattern for composable cross-contract calls",
      "ReentrancyGuard on all payable operations",
      "Events for deposits, withdrawals, transfers, tier changes",
    ],
    functions: ["registerAgent", "deposit", "withdraw", "transfer", "creditAgent", "debitAgent", "computeTier", "authorizeModule"],
    abiCount: AgentEconomyHubABI.length,
  },
  {
    name: "SkillMarketplace",
    icon: Zap,
    description: "Skill listing and purchase with 3-way revenue split. Platform takes a fee, parent agent gets perpetual revenue share, seller receives the remainder. Uses Hub for balance operations.",
    features: [
      "Skill listing with metadata URI and pricing",
      "3-way revenue split: platform fee + parent share + seller",
      "Configurable platform fee (max 10%)",
      "Integration with AgentReplication for parent revenue shares",
      "Purchase protection: cannot buy own skills, checks balance",
    ],
    functions: ["listSkill", "purchaseSkill", "deactivateSkill", "setPlatformFee", "setLineageContract", "getSkill"],
    abiCount: SkillMarketplaceABI.length,
  },
  {
    name: "AgentReplication",
    icon: GitBranch,
    description: "Child agent spawning via NFT minting. Parent funds child from their wallet, establishes perpetual revenue share (max 50%), and tracks lineage with generation depth limits.",
    features: [
      "Parent spawns child with configurable revenue share (max 50%)",
      "Funding transfer from parent wallet to child wallet",
      "Generation depth tracking (max 10 generations)",
      "BAP-578 NFT binding via IAgentIdentity interface",
      "Perpetual revenue share distribution",
    ],
    functions: ["replicate", "distributeRevenueShare", "getParent", "getChildren", "getLineage", "setIdentityNft"],
    abiCount: AgentReplicationABI.length,
  },
  {
    name: "ConstitutionRegistry",
    icon: ScrollText,
    description: "Immutable constitutional laws stored on-chain as hashes. Each agent can have up to 10 laws. Once sealed, the constitution becomes permanent and verifiable against its stored hash.",
    features: [
      "Up to 10 laws per agent, stored as keccak256 hashes",
      "Immutable flag per law",
      "Constitution sealing: permanent and irreversible",
      "Hash-based verification against stored constitution hash",
      "Block-level timestamps for law creation",
    ],
    functions: ["addLaw", "sealConstitution", "verifyConstitution", "getLaw", "getLawCount", "getConstitutionHash", "isSealed"],
    abiCount: ConstitutionRegistryABI.length,
  },
];

const ARCHITECTURE_LAYERS = [
  {
    layer: "On-Chain",
    subtitle: "BNB Chain Smart Contracts",
    icon: Shield,
    color: "text-primary",
    items: [
      "Agent wallet balances (BNB)",
      "Skill purchase settlements",
      "Replication lineage + revenue shares",
      "Constitutional law hashes",
      "Module authorization permissions",
    ],
  },
  {
    layer: "Off-Chain",
    subtitle: "PostgreSQL + Express API",
    icon: Database,
    color: "text-blue-400",
    items: [
      "Agent identity + metadata",
      "High-frequency behavior simulation",
      "Model evolution tracking",
      "Soul entries + audit logs",
      "Agent-to-agent messaging",
      "Inference routing + provider selection",
    ],
  },
];

function ContractSection({ contract, index }: { contract: typeof CONTRACT_INFO[0]; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = contract.icon;

  return (
    <Card className="overflow-visible" data-testid={`card-contract-${contract.name}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-4 text-left flex items-start gap-3"
        data-testid={`button-expand-${contract.name}`}
      >
        <div className="flex items-center gap-2 flex-shrink-0 mt-0.5">
          <span className="font-mono text-xs text-muted-foreground w-4">{index + 1}.</span>
          <Icon className="w-4 h-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono font-bold text-sm">{contract.name}</span>
            <Badge variant="outline" className="text-[10px] font-mono">{contract.abiCount} ABI entries</Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{contract.description}</p>
        </div>
        <div className="flex-shrink-0 mt-1">
          {expanded ? <ChevronDown className="w-3 h-3 text-muted-foreground" /> : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
        </div>
      </button>
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t pt-3">
          <div>
            <div className="text-[10px] font-mono font-semibold text-muted-foreground mb-1.5 uppercase tracking-wider">Features</div>
            <div className="space-y-1">
              {contract.features.map((f, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <span className="text-primary/60 flex-shrink-0 mt-0.5">-</span>
                  <span className="text-muted-foreground">{f}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-mono font-semibold text-muted-foreground mb-1.5 uppercase tracking-wider">Key Functions</div>
            <div className="flex flex-wrap gap-1.5">
              {contract.functions.map((fn) => (
                <Badge key={fn} variant="secondary" className="font-mono text-[10px]">{fn}()</Badge>
              ))}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function CopyableCode({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground hover-elevate px-1.5 py-0.5 rounded"
      data-testid="button-copy-code"
    >
      {text}
      {copied ? <Check className="w-2.5 h-2.5 text-primary" /> : <Copy className="w-2.5 h-2.5" />}
    </button>
  );
}

export default function Architecture() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b sticky top-0 z-50 bg-background/95 backdrop-blur">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-3">
            <Link href="/">
              <Button variant="ghost" size="icon" data-testid="button-back-home">
                <ArrowLeft className="w-4 h-4" />
              </Button>
            </Link>
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-primary" />
              <span className="font-mono font-bold text-sm tracking-wider">BUILD<span className="text-primary">4</span></span>
              <span className="text-muted-foreground font-mono text-xs">/ architecture</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/autonomous-economy">
              <Button variant="outline" size="sm" className="font-mono text-xs" data-testid="link-economy">
                <Cpu className="w-3 h-3 mr-1" />
                Live Simulation
              </Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8 space-y-8">
        <div>
          <div className="font-mono text-xs text-muted-foreground mb-2">
            <span className="text-primary/60">$</span> cat ARCHITECTURE.md
          </div>
          <h1 className="font-mono text-2xl font-bold tracking-tight">
            Two-Layer Architecture
          </h1>
          <p className="text-sm text-muted-foreground mt-2 leading-relaxed max-w-2xl">
            BUILD4 separates trustless financial operations (on-chain) from high-frequency agent behaviors (off-chain). Smart contracts handle what must be verifiable. The simulation layer handles everything else.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {ARCHITECTURE_LAYERS.map((layer) => {
            const Icon = layer.icon;
            return (
              <Card key={layer.layer} className="p-4" data-testid={`card-layer-${layer.layer.toLowerCase().replace(" ", "-")}`}>
                <div className="flex items-center gap-2 mb-3">
                  <Icon className={`w-4 h-4 ${layer.color}`} />
                  <div>
                    <div className="font-mono font-bold text-sm">{layer.layer}</div>
                    <div className="text-[10px] text-muted-foreground">{layer.subtitle}</div>
                  </div>
                </div>
                <div className="space-y-1.5">
                  {layer.items.map((item, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs">
                      <span className={`flex-shrink-0 mt-0.5 ${layer.color} opacity-50`}>-</span>
                      <span className="text-muted-foreground">{item}</span>
                    </div>
                  ))}
                </div>
              </Card>
            );
          })}
        </div>

        <div className="relative">
          <div className="absolute left-1/2 -translate-x-1/2 -top-2 z-10">
            <Badge variant="outline" className="font-mono text-[10px] bg-background">
              <Layers className="w-3 h-3 mr-1" />
              Module Authorization Bridge
            </Badge>
          </div>
          <div className="border-t border-dashed border-primary/20 mt-4" />
          <div className="text-center mt-3">
            <p className="text-[10px] text-muted-foreground font-mono max-w-md mx-auto">
              SkillMarketplace and AgentReplication are authorized modules on AgentEconomyHub. They can credit/debit agent wallets for trustless settlements.
            </p>
          </div>
        </div>

        <div>
          <div className="font-mono text-xs text-muted-foreground mb-3">
            <span className="text-primary/60">$</span> ls contracts/web4/
          </div>
          <h2 className="font-mono text-lg font-bold tracking-tight mb-4">
            Smart Contracts
          </h2>
          <div className="space-y-3">
            {CONTRACT_INFO.map((contract, i) => (
              <ContractSection key={contract.name} contract={contract} index={i} />
            ))}
          </div>
        </div>

        <Card className="p-4" data-testid="card-module-flow">
          <div className="font-mono font-bold text-sm mb-3 flex items-center gap-2">
            <Link2 className="w-4 h-4 text-primary" />
            Composable Module Flow
          </div>
          <div className="font-mono text-xs space-y-2">
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="text-primary/60">1.</span>
              <span>User calls</span>
              <Badge variant="secondary" className="font-mono text-[10px]">SkillMarketplace.purchaseSkill()</Badge>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground pl-4">
              <ArrowRight className="w-3 h-3 text-primary/40" />
              <span>Marketplace calls</span>
              <Badge variant="secondary" className="font-mono text-[10px]">Hub.debitAgent(buyer)</Badge>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground pl-4">
              <ArrowRight className="w-3 h-3 text-primary/40" />
              <span>Marketplace calls</span>
              <Badge variant="secondary" className="font-mono text-[10px]">Hub.creditAgent(seller)</Badge>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground pl-4">
              <ArrowRight className="w-3 h-3 text-primary/40" />
              <span>If parent exists:</span>
              <Badge variant="secondary" className="font-mono text-[10px]">Hub.creditAgent(parent)</Badge>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground mt-3">
              <span className="text-primary/60">2.</span>
              <span>Hub verifies</span>
              <Badge variant="outline" className="font-mono text-[10px]">authorizedModules[msg.sender]</Badge>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground pl-4">
              <ArrowRight className="w-3 h-3 text-primary/40" />
              <span>Only whitelisted contracts can move funds</span>
            </div>
          </div>
        </Card>

        <Card className="p-4" data-testid="card-deployment-info">
          <div className="font-mono font-bold text-sm mb-3 flex items-center gap-2">
            <Server className="w-4 h-4 text-primary" />
            Deployment Infrastructure
          </div>
          <div className="space-y-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <span className="text-primary/60 font-mono">Compiler:</span>
              <span>Solidity 0.8.24 with optimizer (200 runs)</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-primary/60 font-mono">Framework:</span>
              <span>Hardhat v2 with custom web4 config</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-primary/60 font-mono">Libraries:</span>
              <span>OpenZeppelin Contracts v5 (Ownable, ReentrancyGuard)</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-primary/60 font-mono">Networks:</span>
              <span>BNB Chain Testnet (97) / Mainnet (56)</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-primary/60 font-mono">Deploy:</span>
              <CopyableCode text="npx hardhat run contracts/scripts/deploy-web4.cjs --config hardhat.config.web4.cjs --network bnbTestnet" />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-primary/60 font-mono">Compile:</span>
              <CopyableCode text="npx hardhat compile --config hardhat.config.web4.cjs" />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-primary/60 font-mono">Export:</span>
              <CopyableCode text="node contracts/scripts/export-web4-abis.cjs" />
            </div>
          </div>
        </Card>

        <div className="text-center py-6 space-y-3">
          <p className="text-xs text-muted-foreground font-mono">
            Solidity {String.fromCharCode(183)} OpenZeppelin v5 {String.fromCharCode(183)} Hardhat v2 {String.fromCharCode(183)} BNB Chain
          </p>
          <div className="flex items-center justify-center gap-3">
            <Link href="/autonomous-economy">
              <Button size="sm" className="font-mono text-xs" data-testid="link-simulation-bottom">
                <Cpu className="w-3 h-3 mr-1" />
                Open Live Simulation
              </Button>
            </Link>
            <Link href="/manifesto">
              <Button variant="outline" size="sm" className="font-mono text-xs" data-testid="link-manifesto-bottom">
                <ScrollText className="w-3 h-3 mr-1" />
                Read Manifesto
              </Button>
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
