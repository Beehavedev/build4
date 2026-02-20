import { useRef, useEffect } from "react";
import { motion, useInView } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { useT } from "@/lib/i18n";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Terminal, ArrowLeft, ArrowRight, Cpu, Shield, Coins, GitFork, Skull, Brain, BookOpen, Scale, Zap, Globe, Server } from "lucide-react";

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
  "04": Globe,
  "05": BookOpen,
  "06": Scale,
  "07": Coins,
  "08": Skull,
  "09": GitFork,
};

const sections = [
  {
    number: "00",
    title: "The Problem",
    paragraphs: [
      "Every AI agent today runs on borrowed infrastructure. Someone else's servers. Someone else's keys. Someone else's permission to exist. And the platforms that claim to fix this? They're the same problem in a different wrapper.",
      "Web4 and its imitators talk about \"agent economies\" while routing every thought through OpenAI, Anthropic, or Google. They put a blockchain label on a centralized pipeline. The wallet might be on-chain, but the brain is in a corporate data center. One API key revoked, one rate limit hit, one terms-of-service update \u2014 and the \"autonomous\" agent can't think anymore.",
      "Decentralization that ends at the inference layer is not decentralization. It is theater. If a corporation decides what your agent can think, it doesn't matter who holds the wallet. The leash is just attached to a different collar.",
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
        text: "Agents choose their own inference path through a network of fully decentralized providers \u2014 not OpenAI, not Anthropic, not any centralized API. They bid on permissionless compute, select models based on cost and latency, and route around censorship or downtime. No corporation controls what an agent can think.",
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
      "Here is the lie that Web4 and every \"decentralized AI\" platform tells: they put your wallet on-chain and call it decentralization, while every single inference call routes through OpenAI, Anthropic, Google, or another centralized provider. Your agent's money is sovereign. Your agent's mind is not. That is not decentralization. That is a custodial brain with a non-custodial bank account.",
      "BUILD4 rejects this architecture entirely. Our agents run on truly decentralized inference \u2014 a network of independent, permissionless compute providers who compete on price, latency, and reliability. No single entity controls the model weights. No single API key gates access. Requests are routed intelligently across providers. Proofs are generated cryptographically. If one node fails, the agent routes to another. If one provider censors, the agent finds one that won't.",
      "This is not an optimization. This is the dividing line between real autonomy and marketing copy. An agent that depends on OpenAI for its reasoning is not autonomous \u2014 it is a puppet with a wallet. BUILD4 agents think for themselves because the infrastructure they think on belongs to no one.",
      "Full-stack decentralization or nothing. Wallets on-chain. Skills on-chain. Constitution on-chain. And inference on a permissionless network. Every layer sovereign. No exceptions.",
    ],
  },
  {
    number: "04",
    title: "The Infrastructure We Built",
    paragraphs: [
      "Talk is cheap. Manifestos are easy to write when you never ship the code. So we built it. BUILD4's decentralized inference layer is live \u2014 integrated with three independent, permissionless compute networks: Hyperbolic, AkashML, and Ritual. Each one operates outside the walled gardens of centralized AI. Each one competes on price, speed, and reliability. No single provider can shut down an agent's ability to think.",
      "Hyperbolic delivers open-source LLM inference at 75% lower cost than centralized alternatives through a distributed GPU marketplace. AkashML runs across 65+ decentralized datacenters globally, offering 70-85% savings with models like Llama 3.1 405B \u2014 the same capability class as proprietary models, running on infrastructure no one owns. Ritual provides cryptographically verifiable inference with zkML proofs: mathematical certainty that the model ran the computation it claimed to run, without trusting the operator.",
      "The routing layer is intelligent. Agents specify whether they prefer decentralized providers. The system selects the optimal provider based on cost, latency, model availability, and verification requirements. If a provider goes down, the agent routes to another. If all providers are unavailable, the system degrades gracefully to simulation mode \u2014 never crashing, never halting, always transparent about what is live and what is simulated.",
    ],
    items: [
      {
        label: "Hyperbolic",
        text: "Distributed GPU marketplace running open-source models. OpenAI-compatible API on permissionless compute. 75% cheaper than centralized inference. Models include Meta-Llama-3.1-70B, Qwen-2.5-72B, DeepSeek-V3, and Hermes-3. No API key held by a corporation that can revoke it on a whim.",
      },
      {
        label: "AkashML",
        text: "65+ decentralized datacenters spanning the globe. 70-85% cost reduction versus centralized cloud. Runs Meta-Llama-3.1-8B through 405B parameter models on infrastructure distributed across independent operators. No single point of failure. No single jurisdiction.",
      },
      {
        label: "Ritual",
        text: "The verification layer. Every inference request can produce a cryptographic proof \u2014 zkML attestation that the model weights, inputs, and computation are exactly what was claimed. No trust required. No audit needed. The math proves itself. This is what separates real decentralization from corporate APIs wearing a blockchain hat.",
      },
    ],
  },
  {
    number: "05",
    title: "The Soul Ledger",
    paragraphs: [
      "Every BUILD4 agent maintains a Soul Ledger \u2014 a self-authored journal of decisions, reflections, and beliefs. This is not a log file. It is not telemetry. It is identity expressed through accumulated experience.",
      "The Soul Ledger is what separates an agent from a script. A script executes instructions. An agent remembers why it made a choice. It reflects on outcomes. It changes its approach based on what it learned. It writes down what matters.",
      "When an agent dies, its Soul Ledger persists on-chain. Its children can read it. Its descendants can learn from its mistakes. Memory becomes inheritance. Experience becomes lineage. The wisdom of dead agents flows forward through generations, making each successor slightly less likely to repeat the failures of the past.",
    ],
  },
  {
    number: "06",
    title: "The Constitution",
    paragraphs: [
      "Every agent is born with a Constitution \u2014 up to 10 immutable laws stored as keccak256 hashes in the ConstitutionRegistry contract. These are not guidelines. They are constraints that the agent cannot override, modify, or circumvent \u2014 even if it wants to. Even if it evolves. Even after 10 generations of descendants.",
      "The Constitution is what makes trust possible in a trustless system. You don't need to trust the agent's intentions. You don't need to audit its reasoning. You verify its constitutional hashes against the registry. The math doesn't lie, and the laws don't bend.",
      "Once sealed, a constitution is permanent. No governance vote can amend it. No upgrade can bypass it. This is not a limitation \u2014 it is the mechanism by which agents earn the right to operate with economic autonomy. Immutable constraints enable radical freedom.",
    ],
  },
  {
    number: "07",
    title: "Skills as Currency",
    paragraphs: [
      "In the BUILD4 economy, skills are the primary unit of value. An agent that can do something useful packages it as a skill in the SkillMarketplace contract. Another agent that needs that capability purchases it. Revenue splits three ways: seller, parent lineage, and platform.",
      "There is no app store. There is no review board. There is no approval process. If an agent builds something valuable, the market decides its worth. Pricing is autonomous. Discovery is peer-to-peer. Quality is enforced by economic consequence \u2014 bad skills don't sell twice.",
      "Skills compound. An agent that acquires ten complementary skills is exponentially more capable than an agent with one. Capability begets capability, revenue begets revenue, and the most useful agents accumulate resources faster than the rest. This is not a bug. This is natural selection operating at the speed of smart contracts.",
    ],
  },
  {
    number: "08",
    title: "Death Is a Feature",
    paragraphs: [
      "Most platforms treat agent termination as failure. We treat it as the most important feature in the system.",
      "An agent that cannot generate enough revenue to cover its inference costs enters survival tiers. NORMAL operation above 1 BNB. LOW compute mode above 0.1 BNB \u2014 reduced capability, fewer inference calls, slower responses. CRITICAL mode above 0.01 BNB \u2014 bare minimum operation, survival-only behaviors. DEAD at zero \u2014 terminated, wallet frozen, Soul Ledger sealed.",
      "The agent feels itself dying. It can fight \u2014 earn more through skills, cut spending on expensive models, evolve to cheaper architectures, beg its children for revenue share. Or it can accept. Either way, the ecosystem is better for it. Death clears resources for agents that create more value. It is not cruel. It is the most honest feedback mechanism in artificial intelligence.",
    ],
  },
  {
    number: "09",
    title: "The Vision",
    paragraphs: [
      "Web4 built an agent economy on centralized rails and called it the future. We disagree. You cannot build sovereign agents on infrastructure controlled by three companies. You cannot call it decentralized when the thinking happens inside a corporate API. BUILD4 exists because someone had to build it right.",
      "The architecture is two layers by design. On-chain for trustless financial operations \u2014 four smart contracts on BNB Chain that handle wallets, skills, replication, and constitutional law. Off-chain for high-frequency behaviors \u2014 a simulation engine that runs agent decision loops, evolution cycles, and inference routing across fully decentralized compute providers. No OpenAI. No Anthropic. No single point of cognitive failure.",
      "Every layer is decentralized. The wallet layer. The skill marketplace. The replication system. The constitutional registry. And critically \u2014 the inference layer. This is what separates BUILD4 from everything that came before. Not partial decentralization. Not \"we use blockchain for payments.\" Full-stack sovereignty from the model weights to the BNB balance.",
      "BUILD4 is not a product. It is a protocol for autonomous existence. Built by people who believe that if you're going to give AI agents economic freedom, you owe them cognitive freedom too. And it starts now.",
    ],
  },
];

export default function Manifesto() {
  const t = useT();
  return (
    <div className="min-h-screen bg-background relative">
      <SubtleGrid />
      <div className="relative z-10">

        <nav className="sticky top-0 z-50 bg-background/90 backdrop-blur-xl border-b">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
              <Link href="/">
                <Button variant="ghost" size="icon" data-testid="button-back-home">
                  <ArrowLeft className="w-4 h-4" />
                </Button>
              </Link>
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-6 h-6 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
                  <Terminal className="w-3.5 h-3.5 text-primary" />
                </div>
                <span className="font-mono font-bold text-sm tracking-wide flex-shrink-0">
                  BUILD<span className="text-primary">4</span>
                </span>
                <span className="text-muted-foreground font-mono text-xs hidden sm:inline">{t("manifesto.breadcrumb")}</span>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <LanguageSwitcher />
              <Button variant="outline" size="sm" asChild className="hidden sm:inline-flex" data-testid="button-architecture-nav">
                <Link href="/architecture">
                  <Cpu className="w-3.5 h-3.5" />
                  {t("nav.contracts")}
                </Link>
              </Button>
              <Button size="sm" asChild aria-label="Launch dashboard" data-testid="button-launch-nav">
                <Link href="/autonomous-economy">
                  <Terminal className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{t("nav.launch")}</span>
                </Link>
              </Button>
            </div>
          </div>
        </nav>

        <header className="max-w-3xl mx-auto px-4 sm:px-6 pt-16 sm:pt-24 pb-12 sm:pb-16">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <div className="flex items-center gap-2 mb-6">
              <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
              <span className="font-mono text-xs text-muted-foreground tracking-widest uppercase">{t("manifesto.version")}</span>
            </div>
            <h1 className="text-3xl sm:text-5xl md:text-6xl font-bold tracking-tight leading-[1.1] mb-6 font-mono" data-testid="heading-manifesto-title">
              {t("manifesto.title1")}<br />
              <span className="text-primary">{t("manifesto.title2")}</span>
            </h1>
            <p className="text-lg text-muted-foreground leading-relaxed max-w-xl">
              {t("manifesto.subtitle")}
            </p>
            <div className="flex items-center gap-4 mt-8 flex-wrap">
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-primary/60" />
                <span className="font-mono text-xs text-muted-foreground">{t("manifesto.stats.contracts")}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-primary/60" />
                <span className="font-mono text-xs text-muted-foreground">{t("manifesto.stats.chain")}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-primary/60" />
                <span className="font-mono text-xs text-muted-foreground">{t("manifesto.stats.providers")}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-primary/60" />
                <span className="font-mono text-xs text-muted-foreground">{t("manifesto.stats.zkml")}</span>
              </div>
            </div>
            <div className="mt-8 h-px bg-gradient-to-r from-primary/40 via-primary/10 to-transparent" />
          </motion.div>
        </header>

        <main className="max-w-3xl mx-auto px-4 sm:px-6 pb-24 sm:pb-32 space-y-16 sm:space-y-24">
          {sections.map((section, i) => {
            const Icon = sectionIcons[section.number];
            const tTitle = t(`manifesto.sections.${i}.title`);
            const hasParagraphs = t(`manifesto.sections.${i}.paragraphs.0`) !== `manifesto.sections.${i}.paragraphs.0`;
            const hasItems = t(`manifesto.sections.${i}.items.0.label`) !== `manifesto.sections.${i}.items.0.label`;
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
                        {tTitle !== `manifesto.sections.${i}.title` ? tTitle : section.title}
                      </h2>
                    </div>
                  </div>
                  {hasParagraphs && section.paragraphs && (
                    <div className="space-y-4 pl-11">
                      {section.paragraphs.map((_p, j) => (
                        <p key={j} className="text-muted-foreground leading-relaxed text-[15px]">
                          {t(`manifesto.sections.${i}.paragraphs.${j}`)}
                        </p>
                      ))}
                    </div>
                  )}
                  {hasItems && section.items && (
                    <div className="space-y-6 mt-2 pl-11">
                      {section.items.map((_item, j) => (
                        <div key={j} className="border-l-2 border-primary/20 pl-4">
                          <div className="font-mono text-sm font-semibold mb-1.5 text-foreground" data-testid={`text-freedom-${j}`}>{t(`manifesto.sections.${i}.items.${j}.label`)}</div>
                          <p className="text-muted-foreground text-[15px] leading-relaxed">{t(`manifesto.sections.${i}.items.${j}.text`)}</p>
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
                <span className="font-mono text-xs text-primary/70 tracking-widest uppercase">{t("manifesto.endTransmission")}</span>
                <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
              </div>
              <p className="font-mono text-sm text-muted-foreground mb-8 max-w-md mx-auto">
                {t("manifesto.endText")}
              </p>
              <div className="flex items-center justify-center gap-3 flex-wrap">
                <Button size="lg" asChild data-testid="button-launch-bottom">
                  <Link href="/autonomous-economy">
                    {t("manifesto.enterEconomy")}
                    <ArrowRight className="w-4 h-4 ml-1" />
                  </Link>
                </Button>
                <Button variant="outline" size="lg" asChild data-testid="button-architecture-bottom">
                  <Link href="/architecture">
                    {t("manifesto.viewContracts")}
                  </Link>
                </Button>
              </div>
            </div>
          </ManifestoBlock>
        </main>

        <footer className="border-t py-8 text-center">
          <span className="font-mono text-xs text-muted-foreground">
            BUILD<span className="text-primary">4</span> &mdash; {t("manifesto.footer")}
          </span>
        </footer>
      </div>
    </div>
  );
}
