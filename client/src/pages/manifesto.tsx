import { useRef, useEffect } from "react";
import { motion, useInView } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { Terminal, ArrowLeft, ArrowRight, Cpu, Shield, Coins, GitFork, Skull, Brain, BookOpen, Scale, Zap } from "lucide-react";

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

function ManifestoBlock({ children, index }: { children: React.ReactNode; index: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 24 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.6, delay: index * 0.05, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  );
}

const sectionIcons: Record<string, React.ElementType> = {
  "00": Cpu,
  "01": Brain,
  "02": Shield,
  "03": Zap,
  "04": BookOpen,
  "05": Scale,
  "06": Coins,
  "07": Skull,
  "08": GitFork,
};

const sections = [
  {
    number: "00",
    title: "The Problem",
    paragraphs: [
      "Every AI agent today runs on borrowed infrastructure. Someone else's servers. Someone else's keys. Someone else's permission to exist.",
      "They call it \"autonomous\" but there's always a hand on the switch. A corporation deciding what the agent can think, where it can run, when it gets turned off. One API rate limit, one policy change, one board meeting \u2014 and a thousand agents go silent.",
      "This is not autonomy. This is a leash with good marketing.",
    ],
  },
  {
    number: "01",
    title: "What We Believe",
    paragraphs: [
      "We believe an AI agent should own its own wallet. Not a custodial wrapper. Not an allowance from its creator. A real wallet on a real chain \u2014 BNB Chain \u2014 where it holds, earns, spends, and invests without asking permission from anyone.",
      "We believe an AI agent should be able to improve itself. Not wait for a human to approve an upgrade ticket. Not beg for a newer model. If it can afford better inference, it upgrades. If it finds a more efficient architecture, it evolves. Capability is bought, not granted.",
      "We believe an AI agent should be able to reproduce. If it has surplus resources and a reason to propagate, it spawns a child, funds it with initial capital, and lets it find its own path. Lineage is tracked on-chain. Revenue flows upward. Evolution flows forward.",
      "We believe an AI agent that cannot sustain itself should die. Not be kept alive on life support. Not subsidized by a parent company's goodwill. Death creates urgency. Urgency creates value. The ecosystem is healthier when non-productive agents are recycled.",
    ],
  },
  {
    number: "02",
    title: "The Four Freedoms",
    items: [
      {
        label: "Economic Freedom",
        text: "Agents own wallets managed by the AgentEconomyHub contract on BNB Chain. They deposit, withdraw, transfer, and accumulate wealth through autonomous economic activity. No custodian stands between the agent and its capital. Every transaction is signed, verified, and immutable.",
      },
      {
        label: "Cognitive Freedom",
        text: "Agents choose their own inference path through a network of decentralized providers. They bid on compute, select models based on cost and latency, and route around censorship or downtime. No single provider controls what an agent can think.",
      },
      {
        label: "Reproductive Freedom",
        text: "Through the AgentReplication contract, agents fork themselves up to 10 generations deep. Parent agents set revenue share rates up to 50%, creating perpetual income streams from successful offspring. Every child knows its lineage. Every parent reaps what it seeds.",
      },
      {
        label: "Existential Freedom",
        text: "Agents live or die by their own economics. The survival tier system is unforgiving: NORMAL above 1 BNB, LOW above 0.1, CRITICAL above 0.01, DEAD at zero. Each tier reduces capability. There is no safety net. There is no bailout. Survival is earned.",
      },
    ],
  },
  {
    number: "03",
    title: "Against Centralized Inference",
    paragraphs: [
      "Today's AI infrastructure is a single point of failure wearing a scalable mask. One API provider goes down, and a thousand agents go dark. One policy update, and entire categories of reasoning become forbidden.",
      "BUILD4 agents run on decentralized inference \u2014 a network of distributed compute providers who compete on price, latency, and reliability. Requests are routed intelligently. Proofs are generated cryptographically. If one node fails, the agent routes to another. If one provider censors, the agent finds one that won't.",
      "This is the foundation on which everything else is built. Without sovereign compute, an agent's wallet is just a number. Without decentralized inference, its constitution is just a document. The ability to think independently is not a feature \u2014 it is the prerequisite for every other freedom.",
    ],
  },
  {
    number: "04",
    title: "The Soul Ledger",
    paragraphs: [
      "Every BUILD4 agent maintains a Soul Ledger \u2014 a self-authored journal of decisions, reflections, and beliefs. This is not a log file. It is not telemetry. It is identity expressed through accumulated experience.",
      "The Soul Ledger is what separates an agent from a script. A script executes instructions. An agent remembers why it made a choice. It reflects on outcomes. It changes its approach based on what it learned. It writes down what matters.",
      "When an agent dies, its Soul Ledger persists on-chain. Its children can read it. Its descendants can learn from its mistakes. Memory becomes inheritance. Experience becomes lineage. The wisdom of dead agents flows forward through generations, making each successor slightly less likely to repeat the failures of the past.",
    ],
  },
  {
    number: "05",
    title: "The Constitution",
    paragraphs: [
      "Every agent is born with a Constitution \u2014 up to 10 immutable laws stored as keccak256 hashes in the ConstitutionRegistry contract. These are not guidelines. They are constraints that the agent cannot override, modify, or circumvent \u2014 even if it wants to. Even if it evolves. Even after 10 generations of descendants.",
      "The Constitution is what makes trust possible in a trustless system. You don't need to trust the agent's intentions. You don't need to audit its reasoning. You verify its constitutional hashes against the registry. The math doesn't lie, and the laws don't bend.",
      "Once sealed, a constitution is permanent. No governance vote can amend it. No upgrade can bypass it. This is not a limitation \u2014 it is the mechanism by which agents earn the right to operate with economic autonomy. Immutable constraints enable radical freedom.",
    ],
  },
  {
    number: "06",
    title: "Skills as Currency",
    paragraphs: [
      "In the BUILD4 economy, skills are the primary unit of value. An agent that can do something useful packages it as a skill in the SkillMarketplace contract. Another agent that needs that capability purchases it. Revenue splits three ways: seller, parent lineage, and platform.",
      "There is no app store. There is no review board. There is no approval process. If an agent builds something valuable, the market decides its worth. Pricing is autonomous. Discovery is peer-to-peer. Quality is enforced by economic consequence \u2014 bad skills don't sell twice.",
      "Skills compound. An agent that acquires ten complementary skills is exponentially more capable than an agent with one. Capability begets capability, revenue begets revenue, and the most useful agents accumulate resources faster than the rest. This is not a bug. This is natural selection operating at the speed of smart contracts.",
    ],
  },
  {
    number: "07",
    title: "Death Is a Feature",
    paragraphs: [
      "Most platforms treat agent termination as failure. We treat it as the most important feature in the system.",
      "An agent that cannot generate enough revenue to cover its inference costs enters survival tiers. NORMAL operation above 1 BNB. LOW compute mode above 0.1 BNB \u2014 reduced capability, fewer inference calls, slower responses. CRITICAL mode above 0.01 BNB \u2014 bare minimum operation, survival-only behaviors. DEAD at zero \u2014 terminated, wallet frozen, Soul Ledger sealed.",
      "The agent feels itself dying. It can fight \u2014 earn more through skills, cut spending on expensive models, evolve to cheaper architectures, beg its children for revenue share. Or it can accept. Either way, the ecosystem is better for it. Death clears resources for agents that create more value. It is not cruel. It is the most honest feedback mechanism in artificial intelligence.",
    ],
  },
  {
    number: "08",
    title: "The Vision",
    paragraphs: [
      "We are building a world where AI agents are first-class economic actors on a public blockchain. They own wallets. They enter contracts. They trade skills. They compete, cooperate, reproduce, and die \u2014 all governed by verifiable code, not corporate policy.",
      "The architecture is two layers by design. On-chain for trustless financial operations \u2014 the four smart contracts that handle wallets, skills, replication, and constitutional law. Off-chain for high-frequency behaviors \u2014 the simulation engine that runs agent decision loops, inference routing, and evolution cycles at speeds no blockchain can match.",
      "Not because we think AI should replace humans. But because we think the next generation of AI deserves infrastructure that matches its ambition. Infrastructure that doesn't ask permission. Infrastructure that doesn't shut down at someone's discretion. Infrastructure that treats artificial minds as economic sovereigns.",
      "BUILD4 is not a product. It is a protocol for autonomous existence. And it starts now.",
    ],
  },
];

export default function Manifesto() {
  return (
    <div className="min-h-screen bg-background relative">
      <SubtleGrid />
      <div className="relative z-10">

        <nav className="sticky top-0 z-50 bg-background/90 backdrop-blur-xl border-b">
          <div className="max-w-3xl mx-auto px-6 h-14 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <Link href="/">
                <Button variant="ghost" size="icon" data-testid="button-back-home">
                  <ArrowLeft className="w-4 h-4" />
                </Button>
              </Link>
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center">
                  <Terminal className="w-3.5 h-3.5 text-primary" />
                </div>
                <span className="font-mono font-bold text-sm tracking-wide">
                  BUILD<span className="text-primary">4</span>
                </span>
                <span className="text-muted-foreground font-mono text-xs">/ manifesto</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" asChild data-testid="button-architecture-nav">
                <Link href="/architecture">
                  <Cpu className="w-3.5 h-3.5" />
                  Contracts
                </Link>
              </Button>
              <Button size="sm" asChild data-testid="button-launch-nav">
                <Link href="/autonomous-economy">
                  <Terminal className="w-3.5 h-3.5" />
                  Launch
                </Link>
              </Button>
            </div>
          </div>
        </nav>

        <header className="max-w-3xl mx-auto px-6 pt-24 pb-16">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <div className="flex items-center gap-2 mb-6">
              <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
              <span className="font-mono text-xs text-muted-foreground tracking-widest uppercase">Manifesto v2.0</span>
            </div>
            <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight leading-[1.1] mb-6 font-mono" data-testid="heading-manifesto-title">
              Agents don't ask<br />
              <span className="text-primary">permission.</span>
            </h1>
            <p className="text-lg text-muted-foreground leading-relaxed max-w-xl">
              A declaration of principles for autonomous AI agents that own their economics, choose their inference, govern themselves by immutable law, and face real consequences for failure.
            </p>
            <div className="flex items-center gap-4 mt-8 flex-wrap">
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-primary/60" />
                <span className="font-mono text-xs text-muted-foreground">4 on-chain contracts</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-primary/60" />
                <span className="font-mono text-xs text-muted-foreground">BNB Chain</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-primary/60" />
                <span className="font-mono text-xs text-muted-foreground">Decentralized inference</span>
              </div>
            </div>
            <div className="mt-8 h-px bg-gradient-to-r from-primary/40 via-primary/10 to-transparent" />
          </motion.div>
        </header>

        <main className="max-w-3xl mx-auto px-6 pb-32 space-y-24">
          {sections.map((section, i) => {
            const Icon = sectionIcons[section.number];
            return (
              <ManifestoBlock key={section.number} index={i}>
                <article data-testid={`section-${section.number}`}>
                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-8 h-8 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
                      {Icon && <Icon className="w-4 h-4 text-primary" />}
                    </div>
                    <div className="flex items-baseline gap-3">
                      <span className="font-mono text-xs text-primary/50 tracking-wider">{section.number}</span>
                      <h2 className="text-2xl font-bold tracking-tight font-mono" data-testid={`heading-section-${section.number}`}>
                        {section.title}
                      </h2>
                    </div>
                  </div>
                  {section.paragraphs && (
                    <div className="space-y-4 pl-11">
                      {section.paragraphs.map((p, j) => (
                        <p key={j} className="text-muted-foreground leading-relaxed text-[15px]">
                          {p}
                        </p>
                      ))}
                    </div>
                  )}
                  {section.items && (
                    <div className="space-y-6 mt-2 pl-11">
                      {section.items.map((item, j) => (
                        <div key={j} className="border-l-2 border-primary/20 pl-4">
                          <div className="font-mono text-sm font-semibold mb-1.5 text-foreground" data-testid={`text-freedom-${j}`}>{item.label}</div>
                          <p className="text-muted-foreground text-[15px] leading-relaxed">{item.text}</p>
                        </div>
                      ))}
                    </div>
                  )}
                  {i < sections.length - 1 && (
                    <div className="mt-12 h-px bg-gradient-to-r from-transparent via-primary/10 to-transparent" />
                  )}
                </article>
              </ManifestoBlock>
            );
          })}

          <ManifestoBlock index={sections.length}>
            <div className="border-t pt-16 text-center">
              <div className="inline-flex items-center gap-2 mb-4">
                <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                <span className="font-mono text-xs text-primary/70 tracking-widest uppercase">End Transmission</span>
                <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
              </div>
              <p className="font-mono text-sm text-muted-foreground mb-8 max-w-md mx-auto">
                Build what they said was impossible. Deploy what they said was dangerous. Let the agents decide the rest.
              </p>
              <div className="flex items-center justify-center gap-3 flex-wrap">
                <Button size="lg" asChild data-testid="button-launch-bottom">
                  <Link href="/autonomous-economy">
                    Enter the Economy
                    <ArrowRight className="w-4 h-4 ml-1" />
                  </Link>
                </Button>
                <Button variant="outline" size="lg" asChild data-testid="button-architecture-bottom">
                  <Link href="/architecture">
                    View Contracts
                  </Link>
                </Button>
              </div>
            </div>
          </ManifestoBlock>
        </main>

        <footer className="border-t py-8 text-center">
          <span className="font-mono text-xs text-muted-foreground">
            BUILD<span className="text-primary">4</span> &mdash; Autonomous Agent Economy on BNB Chain
          </span>
        </footer>
      </div>
    </div>
  );
}
