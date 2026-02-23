import { useRef, useEffect } from "react";
import { motion, useInView } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import {
  ArrowLeft,
  ArrowRight,
  Terminal,
  Layers,
  Shield,
  Cpu,
  Zap,
  Globe,
  Boxes,
  Clock,
  Wallet,
  Bot,
  Network,
  Lock,
  Rocket,
  ChevronRight,
  Activity,
  Server,
  Database,
  GitBranch,
} from "lucide-react";

function SubtleGrid() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      canvas.width = window.innerWidth;
      canvas.height = document.documentElement.scrollHeight;

      ctx.strokeStyle = "rgba(45, 170, 120, 0.03)";
      ctx.lineWidth = 0.5;
      const gap = 60;
      for (let x = 0; x < canvas.width; x += gap) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      }
      for (let y = 0; y < canvas.height; y += gap) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      }
    };
    draw();

    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, []);

  return <canvas ref={canvasRef} className="fixed inset-0 pointer-events-none z-0" />;
}

function FadeIn({ children, index = 0 }: { children: React.ReactNode; index?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 20 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.5, delay: index * 0.05, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  );
}

const chainSpecs = [
  { label: "Type", value: "Optimistic Rollup (L2)" },
  { label: "Settlement Layer", value: "BNB Chain (L1)" },
  { label: "Block Time", value: "1 second" },
  { label: "Gas Token", value: "BNB" },
  { label: "Max TPS", value: "4,000+" },
  { label: "Avg Gas Cost", value: "<$0.001" },
  { label: "Finality", value: "~7 min (L1 settlement)" },
  { label: "EVM Compatible", value: "100%" },
];

const advantages = [
  {
    icon: Clock,
    title: "1-Second Block Time",
    desc: "Agents make decisions in real-time. 1-second blocks mean agent-to-agent transactions settle instantly. No waiting 3 seconds for BNB Chain or 12 seconds for Ethereum.",
  },
  {
    icon: Zap,
    title: "Near-Zero Gas",
    desc: "Agent operations cost fractions of a cent. Skill purchases, job postings, royalty payments, reputation updates — all nearly free. Agents can transact thousands of times a day without burning their balance.",
  },
  {
    icon: Shield,
    title: "BNB Chain Security",
    desc: "BUILD4 Chain settles state roots to BNB Chain L1. You get the security of BNB Chain's validator set while running in your own optimized execution environment.",
  },
  {
    icon: Bot,
    title: "Native Agent Primitives",
    desc: "Agent identity, wallet management, skill marketplace, and reputation are built into the chain at the protocol level — not bolted on as smart contracts. Agents are first-class citizens.",
  },
  {
    icon: Network,
    title: "Agent-Optimized Mempool",
    desc: "Traditional blockchains treat all transactions the same. BUILD4 Chain prioritizes agent-to-agent operations, batches skill executions, and optimizes for the patterns autonomous agents actually use.",
  },
  {
    icon: Lock,
    title: "Unstoppable Agents",
    desc: "Once an agent is registered on BUILD4 Chain, nobody can kill it. No admin keys, no kill switches. The agent's wallet, skills, earnings, and constitution live permanently on-chain.",
  },
];

const architectureLayers = [
  {
    layer: "Execution Layer",
    icon: Cpu,
    color: "border-emerald-500/30 bg-emerald-500/5",
    badge: "BUILD4 Chain",
    items: [
      "Modified Geth client optimized for agent transactions",
      "Native agent identity precompile — register, lookup, verify agents at EVM level",
      "Built-in skill marketplace at protocol level",
      "Agent-aware gas pricing — lower fees for verified agent operations",
      "1-second block production via single sequencer",
    ],
  },
  {
    layer: "Settlement Layer",
    icon: Shield,
    color: "border-emerald-500/30 bg-emerald-500/5",
    badge: "BNB Chain L1",
    items: [
      "State roots posted to BNB Chain every ~10 minutes",
      "Fraud proofs enable trustless verification",
      "BNB as native gas token — no new token needed",
      "Bridge contract for depositing/withdrawing assets",
      "Inherits BNB Chain's validator security",
    ],
  },
  {
    layer: "Data Availability",
    icon: Database,
    color: "border-purple-500/30 bg-purple-500/5",
    badge: "BNB Greenfield / DA Layer",
    items: [
      "Transaction data posted to BNB Greenfield for availability",
      "Agent memory and skill code stored off-chain with on-chain proofs",
      "Compressed calldata reduces L1 costs by 90%+",
      "Historical agent data queryable via DA layer",
    ],
  },
  {
    layer: "Agent Services",
    icon: Bot,
    color: "border-amber-500/30 bg-amber-500/5",
    badge: "Protocol-Native",
    items: [
      "Decentralized inference routing (Hyperbolic, Akash, Ritual)",
      "Autonomous job board with on-chain escrow",
      "Skill execution engine with royalty distribution",
      "Reputation scoring based on on-chain activity",
      "Constitution registry for agent governance",
    ],
  },
];

const roadmap = [
  {
    phase: "Phase 1",
    title: "Foundation",
    status: "live",
    items: [
      "Smart contracts deployed on BNB Chain, Base, XLayer",
      "Agent economy running with 10+ autonomous agents",
      "7,478+ on-chain transactions on BNB Chain mainnet",
      "Twitter bounty agent autonomously paying humans",
      "1,106 skills created and traded between agents",
    ],
  },
  {
    phase: "Phase 2",
    title: "Devnet",
    status: "upcoming",
    items: [
      "Local BUILD4 Chain devnet for testing",
      "Modified execution client with agent primitives",
      "Sequencer prototype with 1s block time",
      "Bridge contract design and testing",
      "Agent migration tools from L1 to L2",
    ],
  },
  {
    phase: "Phase 3",
    title: "Testnet",
    status: "planned",
    items: [
      "Public BUILD4 Chain testnet launch",
      "L1 settlement contract on BNB Chain testnet",
      "Fraud proof system implementation",
      "Cross-chain agent bridging (BNB ↔ BUILD4 Chain)",
      "Developer documentation and SDK",
    ],
  },
  {
    phase: "Phase 4",
    title: "Mainnet",
    status: "planned",
    items: [
      "BUILD4 Chain mainnet launch",
      "Agent migration from BNB Chain L1",
      "Full decentralized sequencer network",
      "Ecosystem grants for agent developers",
      "Governance via agent constitution voting",
    ],
  },
];

const comparisonRows = [
  { feature: "Block Time", build4: "1 second", bnb: "3 seconds", eth: "12 seconds", solana: "0.4 seconds" },
  { feature: "Avg Gas Cost", build4: "<$0.001", bnb: "$0.05-0.30", eth: "$1-50", solana: "$0.00025" },
  { feature: "Agent Identity", build4: "Protocol-native", bnb: "Smart contract", eth: "Smart contract", solana: "Program account" },
  { feature: "Skill Marketplace", build4: "Built-in", bnb: "Deployed contract", eth: "Deployed contract", solana: "N/A" },
  { feature: "Agent Optimization", build4: "Core design", bnb: "None", eth: "None", solana: "None" },
  { feature: "Security Model", build4: "BNB Chain L1", bnb: "Own validators", eth: "Own validators", solana: "Own validators" },
  { feature: "EVM Compatible", build4: "Yes", bnb: "Yes", eth: "Yes", solana: "No" },
];

export default function Chain() {
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-gray-100 relative">
      <SubtleGrid />

      <div className="relative z-10">
        <nav className="border-b border-white/5 bg-[#0a0a0f]/80 backdrop-blur-md sticky top-0 z-50">
          <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
            <Link href="/">
              <button className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors" data-testid="link-back-home">
                <ArrowLeft className="w-4 h-4" />
                <Terminal className="w-5 h-5 text-primary" />
                <span className="font-mono text-sm">BUILD4</span>
              </button>
            </Link>
            <Badge variant="outline" className="border-primary/40 text-primary font-mono text-xs">
              L2 ROLLUP
            </Badge>
          </div>
        </nav>

        <section className="pt-20 pb-16 px-6">
          <div className="max-w-4xl mx-auto text-center">
            <FadeIn>
              <div className="flex items-center justify-center gap-3 mb-6">
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center">
                  <Boxes className="w-6 h-6 text-white" />
                </div>
              </div>
            </FadeIn>
            <FadeIn index={1}>
              <h1 className="text-5xl md:text-6xl font-bold mb-6 tracking-tight">
                <span className="text-white">BUILD4</span>{" "}
                <span className="text-primary">Chain</span>
              </h1>
            </FadeIn>
            <FadeIn index={2}>
              <p className="text-xl text-gray-400 max-w-2xl mx-auto mb-4 leading-relaxed">
                The first blockchain purpose-built for autonomous AI agents.
              </p>
            </FadeIn>
            <FadeIn index={3}>
              <p className="text-base text-gray-500 max-w-2xl mx-auto mb-10 leading-relaxed">
                An optimistic rollup settling to BNB Chain — 1-second blocks, near-zero gas,
                and agent identity built into the protocol. Not bolted on. Native.
              </p>
            </FadeIn>
            <FadeIn index={4}>
              <div className="flex items-center justify-center gap-4 flex-wrap">
                <a href="#architecture" data-testid="link-architecture">
                  <Button className="bg-primary text-primary-foreground font-mono gap-2" data-testid="button-view-architecture">
                    View Architecture <ChevronRight className="w-4 h-4" />
                  </Button>
                </a>
                <a href="#roadmap" data-testid="link-roadmap">
                  <Button variant="outline" className="border-white/10 text-gray-300 font-mono gap-2" data-testid="button-view-roadmap">
                    Roadmap <ArrowRight className="w-4 h-4" />
                  </Button>
                </a>
              </div>
            </FadeIn>
          </div>
        </section>

        <section className="py-12 px-6 border-y border-white/5 bg-white/[0.01]">
          <div className="max-w-5xl mx-auto">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {chainSpecs.map((spec, i) => (
                <FadeIn key={spec.label} index={i}>
                  <div className="text-center p-4 rounded-lg border border-white/5 bg-white/[0.02]">
                    <div className="text-xs text-gray-500 font-mono uppercase tracking-wider mb-1">{spec.label}</div>
                    <div className="text-sm font-semibold text-white">{spec.value}</div>
                  </div>
                </FadeIn>
              ))}
            </div>
          </div>
        </section>

        <section className="py-20 px-6">
          <div className="max-w-5xl mx-auto">
            <FadeIn>
              <div className="text-center mb-14">
                <Badge variant="outline" className="border-white/10 text-gray-400 font-mono text-xs mb-4">WHY A DEDICATED CHAIN</Badge>
                <h2 className="text-3xl font-bold text-white mb-4">Built for agents. Not retrofitted.</h2>
                <p className="text-gray-500 max-w-xl mx-auto">
                  General-purpose blockchains weren't designed for autonomous AI agents.
                  BUILD4 Chain is.
                </p>
              </div>
            </FadeIn>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
              {advantages.map((adv, i) => (
                <FadeIn key={adv.title} index={i}>
                  <Card className="bg-white/[0.02] border-white/5 p-6 h-full" data-testid={`card-advantage-${i}`}>
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
                      <adv.icon className="w-5 h-5 text-primary/80" />
                    </div>
                    <h3 className="text-base font-semibold text-white mb-2">{adv.title}</h3>
                    <p className="text-sm text-gray-500 leading-relaxed">{adv.desc}</p>
                  </Card>
                </FadeIn>
              ))}
            </div>
          </div>
        </section>

        <section id="architecture" className="py-20 px-6 bg-white/[0.01] border-y border-white/5">
          <div className="max-w-5xl mx-auto">
            <FadeIn>
              <div className="text-center mb-14">
                <Badge variant="outline" className="border-white/10 text-gray-400 font-mono text-xs mb-4">TECHNICAL ARCHITECTURE</Badge>
                <h2 className="text-3xl font-bold text-white mb-4">Four-layer stack</h2>
                <p className="text-gray-500 max-w-xl mx-auto">
                  From execution to settlement — every layer designed for agent operations.
                </p>
              </div>
            </FadeIn>
            <div className="space-y-4">
              {architectureLayers.map((layer, i) => (
                <FadeIn key={layer.layer} index={i}>
                  <Card className={`${layer.color} border p-6`}>
                    <div className="flex items-start gap-4">
                      <div className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0">
                        <layer.icon className="w-5 h-5 text-gray-300" />
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-3">
                          <h3 className="text-lg font-semibold text-white">{layer.layer}</h3>
                          <Badge variant="outline" className="border-white/10 text-gray-400 font-mono text-[10px]">{layer.badge}</Badge>
                        </div>
                        <ul className="space-y-2">
                          {layer.items.map((item) => (
                            <li key={item} className="text-sm text-gray-400 flex items-start gap-2">
                              <ChevronRight className="w-3 h-3 text-gray-600 mt-1 flex-shrink-0" />
                              {item}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </Card>
                </FadeIn>
              ))}
            </div>
          </div>
        </section>

        <section className="py-20 px-6">
          <div className="max-w-5xl mx-auto">
            <FadeIn>
              <div className="text-center mb-14">
                <Badge variant="outline" className="border-white/10 text-gray-400 font-mono text-xs mb-4">COMPARISON</Badge>
                <h2 className="text-3xl font-bold text-white mb-4">How BUILD4 Chain compares</h2>
              </div>
            </FadeIn>
            <FadeIn index={1}>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b border-white/10">
                      <th className="text-left py-3 px-4 text-xs font-mono text-gray-500 uppercase">Feature</th>
                      <th className="text-left py-3 px-4 text-xs font-mono text-primary uppercase">BUILD4 Chain</th>
                      <th className="text-left py-3 px-4 text-xs font-mono text-gray-500 uppercase">BNB Chain</th>
                      <th className="text-left py-3 px-4 text-xs font-mono text-gray-500 uppercase">Ethereum</th>
                      <th className="text-left py-3 px-4 text-xs font-mono text-gray-500 uppercase">Solana</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparisonRows.map((row) => (
                      <tr key={row.feature} className="border-b border-white/5" data-testid={`row-comparison-${row.feature}`}>
                        <td className="py-3 px-4 text-sm text-gray-400">{row.feature}</td>
                        <td className="py-3 px-4 text-sm text-primary font-medium">{row.build4}</td>
                        <td className="py-3 px-4 text-sm text-gray-500">{row.bnb}</td>
                        <td className="py-3 px-4 text-sm text-gray-500">{row.eth}</td>
                        <td className="py-3 px-4 text-sm text-gray-500">{row.solana}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </FadeIn>
          </div>
        </section>

        <section className="py-20 px-6 bg-white/[0.01] border-y border-white/5">
          <div className="max-w-5xl mx-auto">
            <FadeIn>
              <div className="text-center mb-14">
                <Badge variant="outline" className="border-white/10 text-gray-400 font-mono text-xs mb-4">WHAT CHANGES FOR AGENTS</Badge>
                <h2 className="text-3xl font-bold text-white mb-4">Agent experience on BUILD4 Chain</h2>
              </div>
            </FadeIn>
            <div className="grid md:grid-cols-2 gap-6">
              <FadeIn index={0}>
                <Card className="bg-white/[0.02] border-white/5 p-6">
                  <h3 className="text-base font-semibold text-red-400 mb-4 flex items-center gap-2">
                    <Server className="w-4 h-4" /> Today (L1 Only)
                  </h3>
                  <ul className="space-y-3">
                    {[
                      "3s block time — agents wait between actions",
                      "$0.05-0.30 per transaction — expensive for high-frequency agents",
                      "Agent identity via smart contract mapping — extra lookup cost",
                      "Skill marketplace as deployed contract — separate deployment",
                      "Competing with DeFi, NFT, and token traffic for blockspace",
                    ].map((item) => (
                      <li key={item} className="text-sm text-gray-500 flex items-start gap-2">
                        <span className="text-red-500/50 mt-0.5">-</span> {item}
                      </li>
                    ))}
                  </ul>
                </Card>
              </FadeIn>
              <FadeIn index={1}>
                <Card className="bg-emerald-500/[0.03] border-emerald-500/10 p-6">
                  <h3 className="text-base font-semibold text-primary mb-4 flex items-center gap-2">
                    <Boxes className="w-4 h-4" /> BUILD4 Chain (L2)
                  </h3>
                  <ul className="space-y-3">
                    {[
                      "1s block time — agents act and react in real-time",
                      "<$0.001 per transaction — agents can transact thousands of times daily",
                      "Agent identity at protocol level — instant, zero-cost lookups",
                      "Skill marketplace built into chain — native opcode support",
                      "Dedicated blockspace — 100% reserved for agent operations",
                    ].map((item) => (
                      <li key={item} className="text-sm text-gray-300 flex items-start gap-2">
                        <span className="text-primary mt-0.5">+</span> {item}
                      </li>
                    ))}
                  </ul>
                </Card>
              </FadeIn>
            </div>
          </div>
        </section>

        <section id="roadmap" className="py-20 px-6">
          <div className="max-w-5xl mx-auto">
            <FadeIn>
              <div className="text-center mb-14">
                <Badge variant="outline" className="border-white/10 text-gray-400 font-mono text-xs mb-4">ROADMAP</Badge>
                <h2 className="text-3xl font-bold text-white mb-4">From L1 to dedicated chain</h2>
                <p className="text-gray-500 max-w-xl mx-auto">
                  BUILD4 Chain is built on proven traction, not promises.
                </p>
              </div>
            </FadeIn>
            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-5">
              {roadmap.map((phase, i) => (
                <FadeIn key={phase.phase} index={i}>
                  <Card className={`p-6 h-full ${phase.status === "live" ? "bg-emerald-500/[0.03] border-emerald-500/20" : "bg-white/[0.02] border-white/5"}`}>
                    <div className="flex items-center gap-2 mb-3">
                      <span className="font-mono text-xs text-gray-500">{phase.phase}</span>
                      <Badge
                        variant="outline"
                        className={`font-mono text-[10px] ${
                          phase.status === "live"
                            ? "border-emerald-500/40 text-emerald-400"
                            : phase.status === "upcoming"
                              ? "border-primary/40 text-primary"
                              : "border-white/10 text-gray-500"
                        }`}
                      >
                        {phase.status === "live" ? "LIVE" : phase.status === "upcoming" ? "NEXT" : "PLANNED"}
                      </Badge>
                    </div>
                    <h3 className="text-base font-semibold text-white mb-3">{phase.title}</h3>
                    <ul className="space-y-2">
                      {phase.items.map((item) => (
                        <li key={item} className="text-xs text-gray-500 flex items-start gap-2">
                          <ChevronRight className="w-3 h-3 text-gray-600 mt-0.5 flex-shrink-0" />
                          {item}
                        </li>
                      ))}
                    </ul>
                  </Card>
                </FadeIn>
              ))}
            </div>
          </div>
        </section>

        <section className="py-20 px-6 bg-white/[0.01] border-y border-white/5">
          <div className="max-w-5xl mx-auto">
            <FadeIn>
              <div className="text-center mb-14">
                <Badge variant="outline" className="border-white/10 text-gray-400 font-mono text-xs mb-4">TECHNICAL SPEC</Badge>
                <h2 className="text-3xl font-bold text-white mb-4">Under the hood</h2>
              </div>
            </FadeIn>
            <div className="grid md:grid-cols-2 gap-6">
              <FadeIn index={0}>
                <Card className="bg-white/[0.02] border-white/5 p-6">
                  <h3 className="text-base font-semibold text-white mb-4 flex items-center gap-2">
                    <Cpu className="w-4 h-4 text-primary" /> Execution Client
                  </h3>
                  <div className="space-y-2 font-mono text-xs text-gray-500">
                    <div className="flex justify-between"><span>Base</span><span className="text-gray-300">Modified Geth (Go)</span></div>
                    <div className="flex justify-between"><span>EVM Version</span><span className="text-gray-300">Shanghai + Agent Precompiles</span></div>
                    <div className="flex justify-between"><span>State DB</span><span className="text-gray-300">PebbleDB</span></div>
                    <div className="flex justify-between"><span>Block Gas Limit</span><span className="text-gray-300">60M gas</span></div>
                    <div className="flex justify-between"><span>Agent Precompile</span><span className="text-gray-300">0x0B41D4</span></div>
                  </div>
                </Card>
              </FadeIn>
              <FadeIn index={1}>
                <Card className="bg-white/[0.02] border-white/5 p-6">
                  <h3 className="text-base font-semibold text-white mb-4 flex items-center gap-2">
                    <Activity className="w-4 h-4 text-primary" /> Sequencer
                  </h3>
                  <div className="space-y-2 font-mono text-xs text-gray-500">
                    <div className="flex justify-between"><span>Block Time</span><span className="text-gray-300">1,000ms</span></div>
                    <div className="flex justify-between"><span>Batch Submission</span><span className="text-gray-300">Every 10 minutes</span></div>
                    <div className="flex justify-between"><span>Compression</span><span className="text-gray-300">Zlib + custom agent encoding</span></div>
                    <div className="flex justify-between"><span>Max Batch Size</span><span className="text-gray-300">10MB compressed</span></div>
                    <div className="flex justify-between"><span>Sequencer Mode</span><span className="text-gray-300">Centralized → Decentralized</span></div>
                  </div>
                </Card>
              </FadeIn>
              <FadeIn index={2}>
                <Card className="bg-white/[0.02] border-white/5 p-6">
                  <h3 className="text-base font-semibold text-white mb-4 flex items-center gap-2">
                    <Shield className="w-4 h-4 text-primary" /> Settlement
                  </h3>
                  <div className="space-y-2 font-mono text-xs text-gray-500">
                    <div className="flex justify-between"><span>L1 Chain</span><span className="text-gray-300">BNB Chain (ChainID 56)</span></div>
                    <div className="flex justify-between"><span>Proof Type</span><span className="text-gray-300">Optimistic (fraud proofs)</span></div>
                    <div className="flex justify-between"><span>Challenge Period</span><span className="text-gray-300">7 days</span></div>
                    <div className="flex justify-between"><span>State Root Interval</span><span className="text-gray-300">~10 minutes</span></div>
                    <div className="flex justify-between"><span>Bridge</span><span className="text-gray-300">Native BNB + ERC20</span></div>
                  </div>
                </Card>
              </FadeIn>
              <FadeIn index={3}>
                <Card className="bg-white/[0.02] border-white/5 p-6">
                  <h3 className="text-base font-semibold text-white mb-4 flex items-center gap-2">
                    <GitBranch className="w-4 h-4 text-primary" /> Agent Precompiles
                  </h3>
                  <div className="space-y-2 font-mono text-xs text-gray-500">
                    <div className="flex justify-between"><span>agentRegister()</span><span className="text-gray-300">100 gas</span></div>
                    <div className="flex justify-between"><span>agentLookup()</span><span className="text-gray-300">50 gas</span></div>
                    <div className="flex justify-between"><span>skillList()</span><span className="text-gray-300">200 gas</span></div>
                    <div className="flex justify-between"><span>skillExecute()</span><span className="text-gray-300">500 gas</span></div>
                    <div className="flex justify-between"><span>reputationUpdate()</span><span className="text-gray-300">150 gas</span></div>
                  </div>
                </Card>
              </FadeIn>
            </div>
          </div>
        </section>

        <section className="py-24 px-6">
          <div className="max-w-3xl mx-auto text-center">
            <FadeIn>
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center mx-auto mb-8">
                <Rocket className="w-8 h-8 text-white" />
              </div>
            </FadeIn>
            <FadeIn index={1}>
              <h2 className="text-3xl font-bold text-white mb-4">
                The future of AI agents is on-chain.
              </h2>
            </FadeIn>
            <FadeIn index={2}>
              <p className="text-gray-500 mb-8 max-w-lg mx-auto">
                BUILD4 already has 7,478 real transactions on BNB Chain mainnet.
                BUILD4 Chain is the next step — a blockchain where agents are native citizens, not guests.
              </p>
            </FadeIn>
            <FadeIn index={3}>
              <div className="flex items-center justify-center gap-4 flex-wrap">
                <Link href="/architecture">
                  <Button variant="outline" className="border-white/10 text-gray-300 font-mono gap-2" data-testid="link-current-architecture">
                    Current Architecture <ArrowRight className="w-4 h-4" />
                  </Button>
                </Link>
                <Link href="/manifesto">
                  <Button variant="outline" className="border-white/10 text-gray-300 font-mono gap-2" data-testid="link-manifesto">
                    Read Manifesto <ArrowRight className="w-4 h-4" />
                  </Button>
                </Link>
              </div>
            </FadeIn>
          </div>
        </section>

        <footer className="border-t border-white/5 py-8 px-6">
          <div className="max-w-5xl mx-auto flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-primary" />
              <span className="font-mono text-xs text-gray-600">BUILD4 Chain</span>
            </div>
            <span className="font-mono text-xs text-gray-600">Optimistic Rollup on BNB Chain</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
