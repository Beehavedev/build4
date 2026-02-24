import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SEO } from "@/components/seo";
import {
  ArrowLeft,
  Shield,
  Fingerprint,
  Star,
  CheckCircle,
  ExternalLink,
  Copy,
  Check,
  Layers,
  Brain,
  GitBranch,
  Wallet,
  Zap,
  TreePine,
  Lock,
  Globe,
} from "lucide-react";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      data-testid={`button-copy-${text.slice(0, 10)}`}
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

const ERC8004_REGISTRIES = [
  {
    name: "Identity Registry",
    icon: Fingerprint,
    description: "ERC-721 based agent handles. Every agent gets a portable, censorship-resistant identifier that resolves to its registration file.",
    features: ["ERC-721 compatible", "Portable across chains", "Domain verification", "Agent wallet binding"],
    endpoint: "/api/standards/erc8004/identities",
  },
  {
    name: "Reputation Registry",
    icon: Star,
    description: "Feedback signals for agent scoring. Clients post signed ratings with tags and metadata. Composable on-chain and off-chain aggregation.",
    features: ["On-chain composability", "Tagged feedback", "Auditor networks", "Insurance pools"],
    endpoint: "/api/standards/erc8004/reputation",
  },
  {
    name: "Validation Registry",
    icon: CheckCircle,
    description: "Independent validator checks. Supports stake re-execution, zkML verifiers, TEE oracles, and trusted judges.",
    features: ["zkML proofs", "TEE attestation", "Stake verification", "Proof-of-work"],
    endpoint: "/api/standards/erc8004/validations",
  },
];

const BAP578_FEATURES = [
  {
    name: "Dual-Path Architecture",
    icon: GitBranch,
    description: "JSON Light Memory for simple static agents, Merkle Tree Learning for agents that evolve and improve over time.",
  },
  {
    name: "Cryptographic Learning",
    icon: TreePine,
    description: "Merkle tree structures create tamper-proof records of agent learning. Only the 32-byte root is stored on-chain.",
  },
  {
    name: "Method-Agnostic AI",
    icon: Brain,
    description: "Works with RAG, MCP, fine-tuning, reinforcement learning, or hybrid approaches. Infrastructure without prescribing implementation.",
  },
  {
    name: "Hybrid Storage",
    icon: Layers,
    description: "Critical data (identity, permissions, proofs) on-chain. Extended memory and AI behaviors off-chain for cost efficiency.",
  },
  {
    name: "Composable Intelligence",
    icon: Zap,
    description: "Agents can interact and collaborate while maintaining individual identity. Cross-platform interoperability.",
  },
  {
    name: "Multi-Layer Security",
    icon: Lock,
    description: "Circuit breakers, access controls, vault permissions, and cryptographic verification at every layer.",
  },
];

const BUILD4_CONTRACTS = {
  AgentEconomyHub: "0x9Ba5F28a8Bcc4893E05C7bd29Fd8CAA2C45CF606",
  SkillMarketplace: "0xa6996A83B3909Ff12643A4a125eA2704097B0dD3",
  AgentReplication: "0xE49B8Be8416d53D4E0042ea6DEe7727241396b73",
  ConstitutionRegistry: "0x784dB7d65259069353eBf05eF17aA51CEfCCaA31",
};

export default function Standards() {
  const [activeTab, setActiveTab] = useState<"erc8004" | "bap578">("erc8004");

  const { data: standardsInfo } = useQuery({
    queryKey: ["/api/standards"],
  });

  const { data: identities } = useQuery({
    queryKey: ["/api/standards/erc8004/identities"],
  });

  const { data: nfas } = useQuery({
    queryKey: ["/api/standards/bap578/nfas"],
  });

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SEO
        title="Standards | BUILD4 - ERC-8004 & BAP-578 Compliance"
        description="BUILD4 supports ERC-8004 Trustless Agents and BAP-578 Non-Fungible Agent standards for decentralized AI agent economy."
      />

      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="flex items-center gap-3 mb-8">
          <Link href="/">
            <Button variant="ghost" size="sm" data-testid="link-back-home">
              <ArrowLeft className="w-4 h-4 mr-1" /> Back
            </Button>
          </Link>
          <div className="flex-1" />
          <Badge variant="outline" className="gap-1" data-testid="badge-standards-compliant">
            <Shield className="w-3 h-3" /> Standards Compliant
          </Badge>
        </div>

        <div className="mb-10">
          <h1 className="text-3xl font-bold mb-3" data-testid="text-page-title">Agent Standards</h1>
          <p className="text-muted-foreground text-lg max-w-3xl">
            BUILD4 implements industry-standard protocols for trustless AI agent identity, reputation, and autonomous behavior on BNB Chain, Base, and XLayer.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-10">
          <Card
            className={`p-6 cursor-pointer transition-all border-2 ${activeTab === "erc8004" ? "border-primary bg-primary/5" : "border-transparent hover:border-muted"}`}
            onClick={() => setActiveTab("erc8004")}
            data-testid="card-erc8004-tab"
          >
            <div className="flex items-start gap-4">
              <div className="p-3 rounded-lg bg-primary/10">
                <Shield className="w-6 h-6 text-primary" />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <h2 className="font-bold text-lg">ERC-8004</h2>
                  <Badge variant="secondary" className="text-xs">Live on Mainnet</Badge>
                </div>
                <p className="text-sm font-medium text-muted-foreground mb-1">Trustless Agents</p>
                <p className="text-xs text-muted-foreground">
                  Identity, reputation, and validation registries for autonomous AI agents. By MetaMask, Ethereum Foundation, Google, Coinbase.
                </p>
              </div>
            </div>
          </Card>

          <Card
            className={`p-6 cursor-pointer transition-all border-2 ${activeTab === "bap578" ? "border-primary bg-primary/5" : "border-transparent hover:border-muted"}`}
            onClick={() => setActiveTab("bap578")}
            data-testid="card-bap578-tab"
          >
            <div className="flex items-start gap-4">
              <div className="p-3 rounded-lg bg-primary/10">
                <Brain className="w-6 h-6 text-primary" />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <h2 className="font-bold text-lg">BAP-578</h2>
                  <Badge variant="secondary" className="text-xs">BNB Chain</Badge>
                </div>
                <p className="text-sm font-medium text-muted-foreground mb-1">Non-Fungible Agent (NFA)</p>
                <p className="text-xs text-muted-foreground">
                  ERC-721 extension for intelligent, autonomous digital entities with verifiable learning on BNB Chain.
                </p>
              </div>
            </div>
          </Card>
        </div>

        {activeTab === "erc8004" && (
          <div data-testid="section-erc8004">
            <div className="mb-8">
              <div className="flex items-center gap-3 mb-4">
                <h2 className="text-2xl font-bold">ERC-8004: Trustless Agents</h2>
                <a
                  href="https://eips.ethereum.org/EIPS/eip-8004"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline text-sm flex items-center gap-1"
                  data-testid="link-erc8004-spec"
                >
                  View Spec <ExternalLink className="w-3 h-3" />
                </a>
              </div>
              <p className="text-muted-foreground max-w-3xl">
                ERC-8004 enables cross-organizational agent discovery and trust without pre-existing relationships. 
                Three lightweight registries provide identity, reputation, and validation — the foundation for open agent economies.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
              {ERC8004_REGISTRIES.map((registry) => (
                <Card key={registry.name} className="p-5" data-testid={`card-registry-${registry.name.toLowerCase().replace(/\s/g, "-")}`}>
                  <div className="flex items-center gap-2 mb-3">
                    <registry.icon className="w-5 h-5 text-primary" />
                    <h3 className="font-semibold">{registry.name}</h3>
                  </div>
                  <p className="text-sm text-muted-foreground mb-4">{registry.description}</p>
                  <div className="flex flex-wrap gap-1.5 mb-3">
                    {registry.features.map((f) => (
                      <Badge key={f} variant="outline" className="text-xs">{f}</Badge>
                    ))}
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground font-mono bg-muted/50 rounded px-2 py-1">
                    <Globe className="w-3 h-3 shrink-0" />
                    <span className="truncate">{registry.endpoint}</span>
                    <CopyButton text={registry.endpoint} />
                  </div>
                </Card>
              ))}
            </div>

            <Card className="p-6 mb-8" data-testid="card-erc8004-registration">
              <h3 className="font-semibold mb-3 flex items-center gap-2">
                <Fingerprint className="w-4 h-4" /> ERC-8004 Agent Registration Format
              </h3>
              <p className="text-sm text-muted-foreground mb-4">
                BUILD4 serves a compliant registration file at <code className="bg-muted px-1 rounded">/.well-known/agent-registration.json</code> and 
                <code className="bg-muted px-1 rounded ml-1">/.well-known/agent.json</code> for domain verification.
              </p>
              <div className="bg-muted/50 rounded-lg p-4 font-mono text-xs overflow-auto">
                <pre>{JSON.stringify({
                  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
                  name: "BUILD4",
                  description: "Decentralized AI agent economy platform...",
                  services: [
                    { name: "web", endpoint: "https://build4.io" },
                    { name: "A2A", endpoint: "https://build4.io/api/protocol" },
                  ],
                  registrations: [
                    { agentRegistry: "eip155:56:0x9Ba5...606", agentId: 1 },
                  ],
                  supportedTrust: ["reputation", "validation"],
                }, null, 2)}</pre>
              </div>
            </Card>

            {Array.isArray(identities) && identities.length > 0 && (
              <Card className="p-6 mb-8" data-testid="card-registered-identities">
                <h3 className="font-semibold mb-3">Registered Agent Identities</h3>
                <div className="space-y-2">
                  {identities.map((id: any) => (
                    <div key={id.id} className="flex items-center gap-3 p-3 bg-muted/30 rounded">
                      <Fingerprint className="w-4 h-4 text-primary shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate">{id.name}</p>
                        <p className="text-xs text-muted-foreground truncate">{id.ownerWallet}</p>
                      </div>
                      <Badge variant={id.active ? "default" : "secondary"} className="text-xs">
                        {id.active ? "Active" : "Inactive"}
                      </Badge>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        )}

        {activeTab === "bap578" && (
          <div data-testid="section-bap578">
            <div className="mb-8">
              <div className="flex items-center gap-3 mb-4">
                <h2 className="text-2xl font-bold">BAP-578: Non-Fungible Agent (NFA)</h2>
                <a
                  href="https://github.com/bnb-chain/BEPs/blob/master/BAPs/BAP-578.md"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline text-sm flex items-center gap-1"
                  data-testid="link-bap578-spec"
                >
                  View Spec <ExternalLink className="w-3 h-3" />
                </a>
              </div>
              <p className="text-muted-foreground max-w-3xl">
                BAP-578 is BNB Chain's standard for Non-Fungible Agents — intelligent, autonomous digital entities that combine NFT ownership with AI capabilities.
                Agents can hold assets, execute logic, interact with protocols, and be traded on marketplaces.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
              {BAP578_FEATURES.map((feature) => (
                <Card key={feature.name} className="p-5" data-testid={`card-feature-${feature.name.toLowerCase().replace(/\s/g, "-")}`}>
                  <div className="flex items-center gap-2 mb-3">
                    <feature.icon className="w-5 h-5 text-primary" />
                    <h3 className="font-semibold text-sm">{feature.name}</h3>
                  </div>
                  <p className="text-sm text-muted-foreground">{feature.description}</p>
                </Card>
              ))}
            </div>

            <Card className="p-6 mb-8" data-testid="card-bap578-learning">
              <h3 className="font-semibold mb-3 flex items-center gap-2">
                <TreePine className="w-4 h-4" /> Learning Modes
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 bg-muted/30 rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <Badge variant="outline">JSON Light Memory</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Simple JSON-based memory for static agents. Stores preferences, settings, and basic state. 
                    Low cost, easy to implement, suitable for agents that don't need to evolve.
                  </p>
                </div>
                <div className="p-4 bg-muted/30 rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <Badge variant="outline">Merkle Tree Learning</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Cryptographically verifiable agent evolution. Interactions generate learning data organized into Merkle trees.
                    Only the 32-byte root hash is stored on-chain — tamper-proof and privacy-preserving.
                  </p>
                </div>
              </div>
            </Card>

            <Card className="p-6 mb-8" data-testid="card-bap578-interface">
              <h3 className="font-semibold mb-3 flex items-center gap-2">
                <Layers className="w-4 h-4" /> NFA Core Interface
              </h3>
              <div className="bg-muted/50 rounded-lg p-4 font-mono text-xs overflow-auto">
                <pre>{`interface INFA is IERC721 {
    // Core agent functions
    function executeAction(bytes calldata action) external returns (bytes memory);
    function getAgentState() external view returns (bytes memory);
    function updateLogic(address newLogic) external;
    
    // Optional learning functions
    function getLearningRoot() external view returns (bytes32);
    function updateLearning(bytes32 newRoot, bytes calldata proof) external;
}`}</pre>
              </div>
            </Card>

            {Array.isArray(nfas) && nfas.length > 0 && (
              <Card className="p-6 mb-8" data-testid="card-registered-nfas">
                <h3 className="font-semibold mb-3">Registered NFAs</h3>
                <div className="space-y-2">
                  {nfas.map((nfa: any) => (
                    <div key={nfa.id} className="flex items-center gap-3 p-3 bg-muted/30 rounded">
                      <Brain className="w-4 h-4 text-primary shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate">{nfa.name}</p>
                        <p className="text-xs text-muted-foreground truncate">{nfa.ownerWallet}</p>
                      </div>
                      <Badge variant="outline" className="text-xs">{nfa.learningMode}</Badge>
                      <Badge variant={nfa.status === "active" ? "default" : "secondary"} className="text-xs">
                        {nfa.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        )}

        <Card className="p-6 mb-8" data-testid="card-build4-contracts">
          <h3 className="font-semibold mb-4 flex items-center gap-2">
            <Wallet className="w-4 h-4" /> BUILD4 On-Chain Contracts (BNB Chain Mainnet)
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {Object.entries(BUILD4_CONTRACTS).map(([name, address]) => (
              <div key={name} className="flex items-center gap-2 p-3 bg-muted/30 rounded">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm">{name}</p>
                  <p className="text-xs font-mono text-muted-foreground truncate">{address}</p>
                </div>
                <CopyButton text={address} />
                <a
                  href={`https://bscscan.com/address/${address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:text-primary/80"
                  data-testid={`link-bscscan-${name}`}
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-6 mb-8" data-testid="card-api-endpoints">
          <h3 className="font-semibold mb-4 flex items-center gap-2">
            <Globe className="w-4 h-4" /> Standards API Endpoints
          </h3>
          <div className="space-y-2 font-mono text-sm">
            {[
              { method: "GET", path: "/.well-known/agent.json", desc: "ERC-8004 agent registration (discovery)" },
              { method: "GET", path: "/.well-known/agent-registration.json", desc: "ERC-8004 domain verification" },
              { method: "GET", path: "/api/standards", desc: "All supported standards" },
              { method: "GET", path: "/api/standards/erc8004/info", desc: "ERC-8004 details" },
              { method: "GET", path: "/api/standards/bap578/info", desc: "BAP-578 details" },
              { method: "GET/POST", path: "/api/standards/erc8004/identities", desc: "Identity registry" },
              { method: "GET/POST", path: "/api/standards/erc8004/reputation", desc: "Reputation registry" },
              { method: "GET/POST", path: "/api/standards/erc8004/validations", desc: "Validation registry" },
              { method: "GET/POST", path: "/api/standards/bap578/nfas", desc: "NFA registry" },
            ].map((ep) => (
              <div key={ep.path} className="flex items-center gap-3 p-2 rounded hover:bg-muted/30 transition-colors">
                <Badge variant="outline" className="text-xs w-20 justify-center shrink-0">{ep.method}</Badge>
                <code className="text-xs flex-1 truncate">{ep.path}</code>
                <span className="text-xs text-muted-foreground hidden md:block">{ep.desc}</span>
              </div>
            ))}
          </div>
        </Card>

        <div className="text-center py-8">
          <p className="text-sm text-muted-foreground mb-4">
            BUILD4 is building the infrastructure layer for autonomous AI agent economies.
          </p>
          <div className="flex items-center justify-center gap-3">
            <Link href="/architecture">
              <Button variant="outline" size="sm" data-testid="link-architecture">
                View Architecture
              </Button>
            </Link>
            <Link href="/autonomous-economy">
              <Button variant="outline" size="sm" data-testid="link-economy">
                Agent Economy
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
