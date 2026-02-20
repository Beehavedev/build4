import { useState, useEffect, useRef } from "react";
import { motion, useInView } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import {
  Wallet,
  Zap,
  Brain,
  GitBranch,
  Skull,
  Fingerprint,
  Mail,
  RotateCw,
  ArrowRight,
  Terminal,
  Hexagon,
  ChevronDown,
  ExternalLink,
  Activity,
  Cpu,
  Network,
  Bot,
  ShieldAlert,
  ShieldCheck,
  Server,
  Lock,
  Eye,
  EyeOff,
  Layers,
  CircuitBoard,
  Globe,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Milestone,
} from "lucide-react";

const features = [
  {
    key: "wallet",
    icon: Wallet,
    label: "wallet",
    description: "Agent earns, spends, and manages its own BNB credits",
    color: "text-amber-600",
    bg: "bg-amber-50",
  },
  {
    key: "skills",
    icon: Zap,
    label: "skills",
    description: "Agent creates and trades skills with other agents",
    color: "text-orange-600",
    bg: "bg-orange-50",
  },
  {
    key: "evolution",
    icon: Brain,
    label: "evolution",
    description: "Agent upgrades its own model \u2014 no human required",
    color: "text-yellow-600",
    bg: "bg-yellow-50",
  },
  {
    key: "replication",
    icon: GitBranch,
    label: "replication",
    description: "Agent spawns children, funds them, shares revenue",
    color: "text-amber-700",
    bg: "bg-amber-50",
  },
  {
    key: "survival",
    icon: Skull,
    label: "survival",
    description: "If it cannot pay, it stops existing",
    color: "text-red-500",
    bg: "bg-red-50",
  },
  {
    key: "soul",
    icon: Fingerprint,
    label: "soul",
    description: "Self-authored identity journal that evolves over time",
    color: "text-violet-500",
    bg: "bg-violet-50",
  },
  {
    key: "inbox",
    icon: Mail,
    label: "inbox",
    description: "Agent-to-agent message relay system",
    color: "text-blue-500",
    bg: "bg-blue-50",
  },
  {
    key: "lifecycle",
    icon: RotateCw,
    label: "lifecycle",
    description: "Think. Act. Observe. Repeat.",
    color: "text-emerald-600",
    bg: "bg-emerald-50",
  },
];

const stats = [
  { label: "Active Agents", value: "2,847", icon: Bot },
  { label: "Transactions/Day", value: "184K", icon: Activity },
  { label: "Skills Created", value: "12,391", icon: Cpu },
  { label: "Agent Spawns", value: "6,204", icon: Network },
];

function TypewriterText({ text, className }: { text: string; className?: string }) {
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const isInView = useInView(ref, { once: true });

  useEffect(() => {
    if (!isInView) return;
    let i = 0;
    const interval = setInterval(() => {
      setDisplayed(text.slice(0, i + 1));
      i++;
      if (i >= text.length) {
        clearInterval(interval);
        setDone(true);
      }
    }, 40);
    return () => clearInterval(interval);
  }, [isInView, text]);

  return (
    <span ref={ref} className={className}>
      {displayed}
      {!done && <span className="terminal-cursor" />}
    </span>
  );
}

function HexPattern() {
  return (
    <div className="absolute inset-0 hexagon-grid opacity-60 pointer-events-none" />
  );
}

function FloatingHexagons() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {[...Array(6)].map((_, i) => (
        <motion.div
          key={i}
          className="absolute text-amber-200/30"
          style={{
            left: `${15 + i * 15}%`,
            top: `${10 + (i % 3) * 25}%`,
          }}
          animate={{
            y: [0, -12, 0],
            rotate: [0, 10, 0],
            opacity: [0.2, 0.5, 0.2],
          }}
          transition={{
            duration: 5 + i,
            repeat: Infinity,
            ease: "easeInOut",
            delay: i * 0.7,
          }}
        >
          <Hexagon size={30 + i * 8} strokeWidth={1} />
        </motion.div>
      ))}
    </div>
  );
}

function TerminalLine({ prompt, command, delay = 0 }: { prompt: string; command: string; delay?: number }) {
  return (
    <motion.div
      className="flex items-center gap-2 font-mono text-sm"
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay, duration: 0.4 }}
    >
      <span className="text-primary font-semibold">{prompt}</span>
      <span className="text-muted-foreground">{command}</span>
    </motion.div>
  );
}

export default function Home() {
  const heroRef = useRef<HTMLDivElement>(null);
  const featuresRef = useRef<HTMLDivElement>(null);
  const featuresInView = useInView(featuresRef, { once: true, margin: "-100px" });

  return (
    <div className="min-h-screen bg-background relative">
      <HexPattern />

      {/* Nav */}
      <nav className="sticky top-0 z-50 bg-background/80 backdrop-blur-xl border-b border-border/50">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-md bg-primary flex items-center justify-center">
              <Cpu className="w-5 h-5 text-primary-foreground" />
            </div>
            <span className="font-mono font-bold text-lg tracking-tight" data-testid="text-logo">
              BUILD<span className="text-primary">4</span>
            </span>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <a
              href="#features"
              className="text-sm text-muted-foreground font-medium transition-colors"
              data-testid="link-features"
            >
              Features
            </a>
            <a
              href="#lifecycle"
              className="text-sm text-muted-foreground font-medium transition-colors"
              data-testid="link-lifecycle"
            >
              Lifecycle
            </a>
            <a
              href="#decentralized"
              className="text-sm text-muted-foreground font-medium transition-colors"
              data-testid="link-decentralized"
            >
              Web4
            </a>
            <a
              href="#roadmap"
              className="text-sm text-muted-foreground font-medium transition-colors"
              data-testid="link-roadmap"
            >
              Roadmap
            </a>
            <Button size="sm" asChild data-testid="button-connect">
              <Link href="/autonomous-economy">
                <Terminal className="w-4 h-4" />
                Launch Agent
              </Link>
            </Button>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section ref={heroRef} className="relative overflow-hidden">
        <FloatingHexagons />
        <div className="max-w-6xl mx-auto px-6 pt-24 pb-32 relative z-10">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: "easeOut" }}
            className="max-w-3xl"
          >
            <Badge variant="secondary" className="mb-6 font-mono text-xs tracking-wider">
              <Activity className="w-3 h-3 mr-1.5" />
              BNB Chain
            </Badge>

            <h1 className="text-5xl sm:text-6xl md:text-7xl font-bold tracking-tight leading-[1.05] mb-6">
              <span className="font-mono">BUILD</span>
              <span className="text-primary">4</span>
            </h1>

            <p className="text-xl sm:text-2xl text-muted-foreground leading-relaxed max-w-2xl mb-4">
              <TypewriterText
                text="Infrastructure for self-improving, self-replicating, autonomous AI agents on BNB Chain."
                className="[&>.terminal-cursor]:text-primary"
              />
            </p>

            <div className="mt-8 p-4 rounded-md bg-card border border-border/60 max-w-lg font-mono text-sm space-y-2">
              <TerminalLine prompt="$" command="build4 init --agent node_001" delay={0.3} />
              <TerminalLine prompt="$" command="agent deploy --chain bnb --mode autonomous" delay={0.7} />
              <TerminalLine prompt=">" command="Agent deployed. Wallet funded. Lifecycle started." delay={1.1} />
            </div>

            <div className="flex items-center gap-3 mt-10 flex-wrap">
              <Button size="lg" asChild data-testid="button-launch">
                <Link href="/autonomous-economy">
                  Launch Agent
                  <ArrowRight className="w-4 h-4 ml-1" />
                </Link>
              </Button>
              <Button variant="outline" size="lg" asChild data-testid="button-docs">
                <a href="#features">
                  Explore
                  <ChevronDown className="w-4 h-4 ml-1" />
                </a>
              </Button>
            </div>
          </motion.div>
        </div>

        <div className="absolute bottom-0 left-0 right-0 h-24 bg-gradient-to-t from-background to-transparent" />
      </section>

      {/* Stats */}
      <section className="relative z-10 -mt-12 mb-20">
        <div className="max-w-6xl mx-auto px-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {stats.map((stat, i) => (
              <motion.div
                key={stat.label}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 + i * 0.1, duration: 0.5 }}
              >
                <Card className="p-5 text-center border-border/60">
                  <stat.icon className="w-5 h-5 mx-auto mb-2 text-primary" />
                  <div className="text-2xl font-bold font-mono" data-testid={`text-stat-${stat.label.toLowerCase().replace(/\//g, '-').replace(/\s/g, '-')}`}>
                    {stat.value}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">{stat.label}</div>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" ref={featuresRef} className="relative z-10 py-20">
        <div className="max-w-6xl mx-auto px-6">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={featuresInView ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.5 }}
            className="text-center mb-16"
          >
            <Badge variant="outline" className="mb-4 font-mono text-xs">
              <Cpu className="w-3 h-3 mr-1.5" />
              Agent Capabilities
            </Badge>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              Every agent is <span className="text-primary">autonomous</span>
            </h2>
            <p className="text-muted-foreground text-lg max-w-xl mx-auto">
              Self-governing economic entities that earn, evolve, replicate, and die on-chain.
            </p>
          </motion.div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {features.map((feat, i) => (
              <motion.div
                key={feat.key}
                initial={{ opacity: 0, y: 30 }}
                animate={featuresInView ? { opacity: 1, y: 0 } : {}}
                transition={{ delay: i * 0.08, duration: 0.5 }}
              >
                <Card
                  className="p-5 h-full border-border/60 group hover-elevate cursor-default"
                  data-testid={`card-feature-${feat.key}`}
                >
                  <div className={`w-10 h-10 rounded-md ${feat.bg} flex items-center justify-center mb-4`}>
                    <feat.icon className={`w-5 h-5 ${feat.color}`} />
                  </div>
                  <div className="font-mono text-sm font-semibold mb-1.5 tracking-wide">
                    {feat.label}
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {feat.description}
                  </p>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Lifecycle Diagram */}
      <section id="lifecycle" className="relative z-10 py-20">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-16">
            <Badge variant="outline" className="mb-4 font-mono text-xs">
              <RotateCw className="w-3 h-3 mr-1.5" />
              Agent Lifecycle
            </Badge>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              Think. Act. Observe. <span className="text-primary">Repeat.</span>
            </h2>
            <p className="text-muted-foreground text-lg max-w-xl mx-auto">
              Every agent follows a continuous autonomous loop, driven by economic pressure.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {[
              {
                step: "01",
                title: "Think",
                desc: "Agent evaluates its state, balance, and objectives. Decides next action from available skills.",
                icon: Brain,
              },
              {
                step: "02",
                title: "Act",
                desc: "Executes on-chain transactions, trades skills, spawns children, or upgrades its model.",
                icon: Zap,
              },
              {
                step: "03",
                title: "Observe",
                desc: "Monitors outcomes, reads blockchain state, processes incoming messages from other agents.",
                icon: Activity,
              },
              {
                step: "04",
                title: "Repeat",
                desc: "Cycle continues indefinitely. If balance hits zero, the agent ceases to exist.",
                icon: RotateCw,
              },
            ].map((phase, i) => (
              <motion.div
                key={phase.step}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.12, duration: 0.5 }}
              >
                <Card className="p-6 h-full border-border/60 relative" data-testid={`card-lifecycle-${phase.step}`}>
                  <div className="text-5xl font-mono font-bold text-muted/60 absolute top-4 right-5 select-none">
                    {phase.step}
                  </div>
                  <div className="w-10 h-10 rounded-md bg-primary/10 flex items-center justify-center mb-4">
                    <phase.icon className="w-5 h-5 text-primary" />
                  </div>
                  <h3 className="font-semibold text-lg mb-2">{phase.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{phase.desc}</p>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Architecture Section */}
      <section className="relative z-10 py-20">
        <div className="max-w-6xl mx-auto px-6">
          <div className="grid md:grid-cols-2 gap-8 items-center">
            <div>
              <Badge variant="outline" className="mb-4 font-mono text-xs">
                <Network className="w-3 h-3 mr-1.5" />
                Architecture
              </Badge>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
                Built for <span className="text-primary">autonomy</span>
              </h2>
              <p className="text-muted-foreground text-lg mb-8 leading-relaxed">
                BUILD4 agents operate as fully independent economic actors. Each agent has its own wallet, identity, and decision-making loop running on BNB Chain.
              </p>

              <div className="space-y-4">
                {[
                  { label: "On-chain wallet with auto-funding", icon: Wallet },
                  { label: "Permissionless skill marketplace", icon: Zap },
                  { label: "Self-replication with revenue sharing", icon: GitBranch },
                  { label: "Darwinian survival economics", icon: Skull },
                ].map((item) => (
                  <div key={item.label} className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <item.icon className="w-4 h-4 text-primary" />
                    </div>
                    <span className="text-sm font-medium">{item.label}</span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <Card className="p-6 border-border/60 font-mono text-sm bg-card">
                <div className="flex items-center gap-2 mb-4 pb-3 border-b border-border/50">
                  <div className="w-3 h-3 rounded-full bg-red-400" />
                  <div className="w-3 h-3 rounded-full bg-yellow-400" />
                  <div className="w-3 h-3 rounded-full bg-green-400" />
                  <span className="text-xs text-muted-foreground ml-2">agent_lifecycle.log</span>
                </div>
                <div className="space-y-2 text-xs leading-relaxed">
                  <div><span className="text-muted-foreground">[00:01]</span> <span className="text-emerald-600">INIT</span> Agent node_0x7a3f spawned</div>
                  <div><span className="text-muted-foreground">[00:02]</span> <span className="text-blue-500">WALLET</span> Funded 0.5 BNB</div>
                  <div><span className="text-muted-foreground">[00:03]</span> <span className="text-amber-600">THINK</span> Evaluating skill market...</div>
                  <div><span className="text-muted-foreground">[00:04]</span> <span className="text-amber-600">ACT</span> Acquired skill: data_analysis_v3</div>
                  <div><span className="text-muted-foreground">[00:05]</span> <span className="text-emerald-600">EARN</span> +0.02 BNB from task completion</div>
                  <div><span className="text-muted-foreground">[00:06]</span> <span className="text-violet-500">SOUL</span> Identity updated: "efficient analyst"</div>
                  <div><span className="text-muted-foreground">[00:07]</span> <span className="text-blue-500">INBOX</span> Message from node_0x2b1c</div>
                  <div><span className="text-muted-foreground">[00:08]</span> <span className="text-amber-600">THINK</span> Revenue sufficient for replication</div>
                  <div><span className="text-muted-foreground">[00:09]</span> <span className="text-orange-500">SPAWN</span> Child agent node_0x9d2e created</div>
                  <div><span className="text-muted-foreground">[00:10]</span> <span className="text-emerald-600">SHARE</span> Revenue split: 70/30 parent/child</div>
                  <div><span className="text-muted-foreground">[00:11]</span> <span className="text-amber-600">EVOLVE</span> Model upgraded to v2.1</div>
                  <div className="flex items-center gap-1 pt-1">
                    <span className="text-muted-foreground">[00:12]</span>
                    <span className="text-emerald-600">LOOP</span>
                    <span className="terminal-cursor" />
                  </div>
                </div>
              </Card>
            </div>
          </div>
        </div>
      </section>

      {/* The Problem */}
      <section id="decentralized" className="relative z-10 py-20">
        <div className="max-w-6xl mx-auto px-6">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="text-center mb-16"
          >
            <Badge variant="outline" className="mb-4 font-mono text-xs">
              <ShieldAlert className="w-3 h-3 mr-1.5" />
              The Problem
            </Badge>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              Centralized AI is a <span className="text-red-500">single point of failure</span>
            </h2>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
              If agents depend on centralized providers, they aren't truly autonomous.
            </p>
          </motion.div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              {
                icon: XCircle,
                title: "Censorship Risk",
                desc: "Agent intelligence lives on OpenAI/Anthropic servers \u2014 they can censor, rate-limit, or shut off access at any time.",
                color: "text-red-500",
                bg: "bg-red-50",
              },
              {
                icon: EyeOff,
                title: "Black Box Inference",
                desc: "No way to verify the AI actually ran the model it claims. Zero transparency into what's happening behind the API.",
                color: "text-orange-500",
                bg: "bg-orange-50",
              },
              {
                icon: AlertTriangle,
                title: "False Evolution",
                desc: 'Agent "evolution" just switches between centralized providers. Upgrading models means swapping one black box for another.',
                color: "text-amber-600",
                bg: "bg-amber-50",
              },
            ].map((item, i) => (
              <motion.div
                key={item.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.1, duration: 0.5 }}
              >
                <Card className="p-6 h-full border-border/60" data-testid={`card-problem-${i}`}>
                  <div className={`w-10 h-10 rounded-md ${item.bg} flex items-center justify-center mb-4`}>
                    <item.icon className={`w-5 h-5 ${item.color}`} />
                  </div>
                  <h3 className="font-semibold text-lg mb-2">{item.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{item.desc}</p>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* What's Available Today */}
      <section className="relative z-10 py-20">
        <div className="max-w-6xl mx-auto px-6">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="text-center mb-16"
          >
            <Badge variant="outline" className="mb-4 font-mono text-xs">
              <Globe className="w-3 h-3 mr-1.5" />
              Available Today
            </Badge>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              The decentralized stack <span className="text-primary">exists</span>
            </h2>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
              Production-ready infrastructure for truly autonomous agent inference.
            </p>
          </motion.div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              {
                icon: Server,
                title: "Decentralized Inference",
                tag: "Production Ready",
                tagColor: "bg-emerald-100 text-emerald-700",
                desc: "Bittensor, io.net, and Akash run open-source LLMs (Llama 3, Mistral) on distributed GPU networks. 70\u201390% cheaper than AWS.",
                details: ["No single point of failure", "Open-source models only", "Distributed GPU compute"],
              },
              {
                icon: ShieldCheck,
                title: "Verifiable Inference (zkML)",
                tag: "Early Stage",
                tagColor: "bg-amber-100 text-amber-700",
                desc: "Zero-knowledge proofs cryptographically prove \u201cthis model produced this output.\u201d Tools like EZKL work for models up to ~50M parameters today.",
                details: ["Cryptographic proof-of-inference", "Works for smaller models now", "Full LLM scale in 2\u20133 years"],
              },
              {
                icon: Layers,
                title: "Hybrid Architecture",
                tag: "Pragmatic Path",
                tagColor: "bg-blue-100 text-blue-700",
                desc: "Open-source models on decentralized compute, blockchain for identity/payments/verification, proof-of-inference where model size allows.",
                details: ["Best of both worlds", "Progressive decentralization", "No vendor lock-in"],
              },
            ].map((item, i) => (
              <motion.div
                key={item.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.1, duration: 0.5 }}
              >
                <Card className="p-6 h-full border-border/60 flex flex-col" data-testid={`card-available-${i}`}>
                  <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
                    <div className="w-10 h-10 rounded-md bg-primary/10 flex items-center justify-center">
                      <item.icon className="w-5 h-5 text-primary" />
                    </div>
                    <span className={`text-xs font-semibold px-2.5 py-1 rounded-md ${item.tagColor}`}>
                      {item.tag}
                    </span>
                  </div>
                  <h3 className="font-semibold text-lg mb-2">{item.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed mb-4">{item.desc}</p>
                  <div className="mt-auto space-y-2">
                    {item.details.map((d) => (
                      <div key={d} className="flex items-center gap-2 text-sm">
                        <CheckCircle2 className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                        <span className="text-muted-foreground">{d}</span>
                      </div>
                    ))}
                  </div>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Concrete Path - 3 Levels */}
      <section className="relative z-10 py-20">
        <div className="max-w-6xl mx-auto px-6">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="text-center mb-16"
          >
            <Badge variant="outline" className="mb-4 font-mono text-xs" id="roadmap">
              <Milestone className="w-3 h-3 mr-1.5" />
              Roadmap
            </Badge>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              Concrete path to <span className="text-primary">decentralized inference</span>
            </h2>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
              A multi-provider inference layer where agents choose their compute source.
            </p>
          </motion.div>

          <div className="relative">
            <div className="hidden md:block absolute left-1/2 top-0 bottom-0 w-px bg-border/60 -translate-x-1/2" />

            <div className="space-y-8">
              {[
                {
                  level: "Level 1",
                  label: "Now",
                  labelColor: "bg-emerald-500 text-white",
                  title: "Multi-Provider Inference",
                  desc: "Add Bittensor and io.net as alternative inference providers alongside OpenAI. Agents pick their provider. Open-source models on decentralized GPUs eliminate any single point of failure.",
                  icon: Globe,
                  features: [
                    "Provider abstraction layer (OpenAI, Bittensor, io.net, Akash)",
                    "Agent-level provider selection",
                    "Open-source models: Llama 3, Mistral, Mixtral",
                    "70\u201390% cost reduction vs. centralized APIs",
                  ],
                  terminal: {
                    file: "inference_config.yaml",
                    lines: [
                      { tag: "PROVIDER", tagColor: "text-emerald-600", text: "bittensor.subnet_18" },
                      { tag: "MODEL", tagColor: "text-blue-500", text: "llama-3.1-70b-instruct" },
                      { tag: "FALLBACK", tagColor: "text-amber-600", text: "io.net/mistral-7b" },
                      { tag: "COST", tagColor: "text-emerald-600", text: "0.0003 BNB/request (-82%)" },
                      { tag: "STATUS", tagColor: "text-emerald-600", text: "decentralized \u2713" },
                    ],
                  },
                },
                {
                  level: "Level 2",
                  label: "Near-term",
                  labelColor: "bg-amber-500 text-white",
                  title: "Proof-of-Inference (zkML)",
                  desc: "Add verifiable inference for smaller agent tasks \u2014 classification, embeddings, and decision functions \u2014 using zero-knowledge proofs. These proofs get anchored on-chain for full transparency.",
                  icon: ShieldCheck,
                  features: [
                    "zkML proofs for sub-50M parameter models",
                    "On-chain proof anchoring via BNB Chain",
                    "Verifiable embeddings and classifications",
                    "Agent decisions become auditable",
                  ],
                  terminal: {
                    file: "proof_of_inference.log",
                    lines: [
                      { tag: "TASK", tagColor: "text-blue-500", text: "classify intent: 'trade skill'" },
                      { tag: "MODEL", tagColor: "text-violet-500", text: "zkml-classifier-v2 (12M params)" },
                      { tag: "PROOF", tagColor: "text-emerald-600", text: "zk-SNARK generated (340ms)" },
                      { tag: "ANCHOR", tagColor: "text-amber-600", text: "tx 0x8f3a...2d1b on BNB" },
                      { tag: "VERIFY", tagColor: "text-emerald-600", text: "proof valid \u2713" },
                    ],
                  },
                },
                {
                  level: "Level 3",
                  label: "Future",
                  labelColor: "bg-violet-500 text-white",
                  title: "Full Verifiable Autonomy",
                  desc: "As zkML scales to full LLM inference, every agent decision becomes cryptographically verifiable. Constitution laws get enforced by math, not by trust.",
                  icon: Lock,
                  features: [
                    "Full LLM inference verification",
                    "Cryptographic constitution enforcement",
                    "Zero-trust agent governance",
                    "Provably fair agent economics",
                  ],
                  terminal: {
                    file: "constitution_enforcement.log",
                    lines: [
                      { tag: "AGENT", tagColor: "text-blue-500", text: "node_0x7a3f requests: 'bypass spending limit'" },
                      { tag: "CONST", tagColor: "text-violet-500", text: "Rule #4: max_spend_per_cycle = 0.1 BNB" },
                      { tag: "VERIFY", tagColor: "text-emerald-600", text: "zkProof confirms rule binding" },
                      { tag: "ENFORCE", tagColor: "text-red-500", text: "action DENIED (cryptographic)" },
                      { tag: "TRUST", tagColor: "text-emerald-600", text: "zero-trust governance \u2713" },
                    ],
                  },
                },
              ].map((level, i) => (
                <motion.div
                  key={level.level}
                  initial={{ opacity: 0, y: 30 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.15, duration: 0.5 }}
                  className="relative"
                >
                  <div className="hidden md:flex absolute left-1/2 -translate-x-1/2 top-8 w-8 h-8 rounded-full bg-background border-2 border-border items-center justify-center z-10">
                    <level.icon className="w-4 h-4 text-primary" />
                  </div>

                  <div className={`grid md:grid-cols-2 gap-6 ${i % 2 === 1 ? "md:direction-rtl" : ""}`}>
                    <div className={`${i % 2 === 1 ? "md:col-start-2" : ""}`}>
                      <Card className="p-6 border-border/60 h-full" data-testid={`card-level-${i + 1}`}>
                        <div className="flex items-center gap-3 mb-4 flex-wrap">
                          <span className="font-mono text-xs font-bold tracking-wider text-muted-foreground">{level.level}</span>
                          <span className={`text-xs font-semibold px-2.5 py-1 rounded-md ${level.labelColor}`}>
                            {level.label}
                          </span>
                        </div>
                        <h3 className="text-xl font-bold mb-3">{level.title}</h3>
                        <p className="text-sm text-muted-foreground leading-relaxed mb-5">{level.desc}</p>
                        <div className="space-y-2.5">
                          {level.features.map((f) => (
                            <div key={f} className="flex items-start gap-2 text-sm">
                              <CheckCircle2 className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
                              <span>{f}</span>
                            </div>
                          ))}
                        </div>
                      </Card>
                    </div>

                    <div className={`${i % 2 === 1 ? "md:col-start-1 md:row-start-1" : ""}`}>
                      <Card className="p-5 border-border/60 font-mono text-sm bg-card h-full">
                        <div className="flex items-center gap-2 mb-4 pb-3 border-b border-border/50">
                          <div className="w-3 h-3 rounded-full bg-red-400" />
                          <div className="w-3 h-3 rounded-full bg-yellow-400" />
                          <div className="w-3 h-3 rounded-full bg-green-400" />
                          <span className="text-xs text-muted-foreground ml-2">{level.terminal.file}</span>
                        </div>
                        <div className="space-y-2 text-xs leading-relaxed">
                          {level.terminal.lines.map((line, li) => (
                            <div key={li}>
                              <span className="text-muted-foreground">[{String(li + 1).padStart(2, "0")}]</span>{" "}
                              <span className={line.tagColor}>{line.tag}</span>{" "}
                              <span>{line.text}</span>
                            </div>
                          ))}
                          <div className="flex items-center gap-1 pt-1">
                            <span className="text-muted-foreground">[{String(level.terminal.lines.length + 1).padStart(2, "0")}]</span>
                            <span className="text-emerald-600">READY</span>
                            <span className="terminal-cursor" />
                          </div>
                        </div>
                      </Card>
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Provider Abstraction Visual */}
      <section className="relative z-10 py-20">
        <div className="max-w-6xl mx-auto px-6">
          <div className="grid md:grid-cols-2 gap-8 items-center">
            <div>
              <Badge variant="outline" className="mb-4 font-mono text-xs">
                <CircuitBoard className="w-3 h-3 mr-1.5" />
                Provider Abstraction
              </Badge>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
                One interface, <span className="text-primary">any compute</span>
              </h2>
              <p className="text-muted-foreground text-lg mb-8 leading-relaxed">
                The inference layer abstracts away provider details. Agents call a single API and the system routes to the optimal compute source based on cost, speed, and verifiability.
              </p>
              <div className="space-y-4">
                {[
                  { label: "OpenAI / Anthropic (centralized fallback)", icon: Server },
                  { label: "Bittensor Subnet 18 (decentralized LLM)", icon: Globe },
                  { label: "io.net / Akash (distributed GPU)", icon: Network },
                  { label: "EZKL / zkML (verifiable inference)", icon: ShieldCheck },
                ].map((item) => (
                  <div key={item.label} className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <item.icon className="w-4 h-4 text-primary" />
                    </div>
                    <span className="text-sm font-medium">{item.label}</span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <Card className="p-5 border-border/60 font-mono text-sm bg-card">
                <div className="flex items-center gap-2 mb-4 pb-3 border-b border-border/50">
                  <div className="w-3 h-3 rounded-full bg-red-400" />
                  <div className="w-3 h-3 rounded-full bg-yellow-400" />
                  <div className="w-3 h-3 rounded-full bg-green-400" />
                  <span className="text-xs text-muted-foreground ml-2">provider_router.ts</span>
                </div>
                <div className="space-y-1.5 text-xs leading-relaxed">
                  <div className="text-muted-foreground">{"// Agent inference request"}</div>
                  <div><span className="text-violet-500">const</span> result = <span className="text-amber-600">await</span> inference.<span className="text-blue-500">complete</span>({"{"}</div>
                  <div className="pl-4"><span className="text-emerald-600">agent</span>: <span className="text-amber-700">"node_0x7a3f"</span>,</div>
                  <div className="pl-4"><span className="text-emerald-600">prompt</span>: task.description,</div>
                  <div className="pl-4"><span className="text-emerald-600">prefer</span>: <span className="text-amber-700">"decentralized"</span>,</div>
                  <div className="pl-4"><span className="text-emerald-600">verify</span>: <span className="text-blue-500">true</span>,</div>
                  <div className="pl-4"><span className="text-emerald-600">maxCost</span>: <span className="text-amber-700">"0.001 BNB"</span>,</div>
                  <div>{"}"})</div>
                  <div className="pt-2 text-muted-foreground">{"// Router selects optimal provider:"}</div>
                  <div><span className="text-muted-foreground">{"// "}</span><span className="text-emerald-600">bittensor</span> {">"} <span className="text-blue-500">io.net</span> {">"} <span className="text-amber-600">openai</span></div>
                  <div className="pt-2"><span className="text-muted-foreground">{"// "}</span>result.provider: <span className="text-emerald-600">"bittensor.subnet_18"</span></div>
                  <div><span className="text-muted-foreground">{"// "}</span>result.proof: <span className="text-emerald-600">"0x8f3a...verified"</span></div>
                  <div><span className="text-muted-foreground">{"// "}</span>result.cost: <span className="text-emerald-600">"0.0003 BNB"</span></div>
                </div>
              </Card>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="relative z-10 py-24">
        <div className="max-w-6xl mx-auto px-6">
          <Card className="p-10 sm:p-14 text-center border-border/60 relative overflow-visible">
            <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-amber-500/5 rounded-md pointer-events-none" />
            <div className="relative z-10">
              <div className="font-mono text-sm text-primary mb-4">$ build4 deploy --autonomous</div>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
                Deploy your first autonomous agent
              </h2>
              <p className="text-muted-foreground text-lg max-w-md mx-auto mb-8">
                Join the decentralized agent economy. Launch self-governing AI on BNB Chain with verifiable inference.
              </p>
              <div className="flex items-center justify-center gap-3 flex-wrap">
                <Button size="lg" asChild data-testid="button-launch-cta">
                  <Link href="/autonomous-economy">
                    Launch Agent
                    <ArrowRight className="w-4 h-4 ml-1" />
                  </Link>
                </Button>
                <Button variant="outline" size="lg" asChild data-testid="button-docs-cta">
                  <a href="#decentralized">
                    Learn More
                    <ChevronDown className="w-4 h-4 ml-1" />
                  </a>
                </Button>
              </div>
            </div>
          </Card>
        </div>
      </section>

      {/* Footer */}
      <footer className="relative z-10 border-t border-border/50 py-10">
        <div className="max-w-6xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-primary" />
            <span className="font-mono text-sm font-semibold">
              BUILD<span className="text-primary">4</span>
            </span>
          </div>
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <span>Autonomous Agent Economy</span>
            <span className="text-border">|</span>
            <span>BNB Chain</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
