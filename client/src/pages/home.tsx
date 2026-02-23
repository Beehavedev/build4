import { useState, useEffect, useRef } from "react";
import { motion, useInView } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { useT } from "@/lib/i18n";
import { LanguageSwitcher } from "@/components/language-switcher";
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
  ChevronDown,
  Activity,
  Cpu,
  Network,
  Bot,
  ShieldAlert,
  ShieldCheck,
  Server,
  Lock,
  EyeOff,
  Layers,
  CircuitBoard,
  Globe,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Milestone,
  Menu,
  X,
} from "lucide-react";

const featureKeys = [
  { key: "wallet", icon: Wallet },
  { key: "skills", icon: Zap },
  { key: "evolution", icon: Brain },
  { key: "replication", icon: GitBranch },
  { key: "survival", icon: Skull },
  { key: "soul", icon: Fingerprint },
  { key: "inbox", icon: Mail },
  { key: "lifecycle", icon: RotateCw },
];

const statKeys = [
  { key: "activeAgents", value: "2,847", icon: Bot },
  { key: "transactionsDay", value: "184K", icon: Activity },
  { key: "skillsCreated", value: "12,391", icon: Cpu },
  { key: "agentSpawns", value: "6,204", icon: Network },
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

function MatrixRain() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();

    const chars = "01BUILD4AGENT";
    const fontSize = 13;
    const columns = Math.floor(canvas.width / fontSize);
    const drops: number[] = Array(columns).fill(0).map(() => Math.random() * -100);

    const draw = () => {
      ctx.fillStyle = "rgba(8, 12, 10, 0.08)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = `${fontSize}px monospace`;

      for (let i = 0; i < drops.length; i++) {
        const char = chars[Math.floor(Math.random() * chars.length)];
        const x = i * fontSize;
        const y = drops[i] * fontSize;
        const alpha = 0.04 + Math.random() * 0.06;
        ctx.fillStyle = `rgba(45, 170, 120, ${alpha})`;
        ctx.fillText(char, x, y);

        if (y > canvas.height && Math.random() > 0.98) {
          drops[i] = 0;
        }
        drops[i]++;
      }
    };

    const interval = setInterval(draw, 60);
    window.addEventListener("resize", resize);
    return () => {
      clearInterval(interval);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas ref={canvasRef} className="fixed inset-0 pointer-events-none z-0" />;
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
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const t = useT();

  return (
    <div className="min-h-screen bg-background relative">
      <MatrixRain />
      <div className="relative z-10 grid-overlay">

        {/* Nav */}
        <nav className="sticky top-0 z-50 bg-background/90 backdrop-blur-xl border-b">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center">
                <Terminal className="w-4 h-4 text-primary" />
              </div>
              <span className="font-mono font-bold text-sm tracking-wide" data-testid="text-logo">
                BUILD<span className="text-primary">4</span>
              </span>
              <span className="text-[10px] font-mono font-semibold tracking-widest uppercase px-1.5 py-0.5 rounded border border-primary/30 bg-primary/10 text-primary" data-testid="badge-beta">beta</span>
            </div>
            <div className="hidden md:flex items-center gap-4">
              <a href="#lifecycle" className="text-xs text-muted-foreground font-mono tracking-wide transition-colors" data-testid="link-lifecycle">{t("nav.lifecycle")}</a>
              <a href="#decentralized" className="text-xs text-muted-foreground font-mono tracking-wide transition-colors" data-testid="link-decentralized">{t("nav.web4")}</a>
              <Link href="/why-build4" className="text-xs text-muted-foreground font-mono tracking-wide transition-colors" data-testid="link-why">{t("nav.whyBuild4")}</Link>
              <Link href="/manifesto" className="text-xs text-muted-foreground font-mono tracking-wide transition-colors" data-testid="link-manifesto">{t("nav.manifesto")}</Link>
              <Link href="/architecture" className="text-xs text-muted-foreground font-mono tracking-wide transition-colors" data-testid="link-architecture">{t("nav.contracts")}</Link>
              <Link href="/marketplace" className="text-xs text-emerald-400 font-mono tracking-wide transition-colors hover:text-emerald-300" data-testid="link-marketplace">Marketplace</Link>
              <Link href="/privacy" className="text-xs text-purple-400 font-mono tracking-wide transition-colors hover:text-purple-300" data-testid="link-privacy">Privacy</Link>
              <Link href="/twitter-agent" className="text-xs text-blue-400 font-mono tracking-wide transition-colors hover:text-blue-300" data-testid="link-twitter-agent">Twitter Agent</Link>
              <LanguageSwitcher />
              <Button size="sm" asChild data-testid="button-connect">
                <Link href="/autonomous-economy">
                  <Terminal className="w-3.5 h-3.5" />
                  {t("nav.launch")}
                </Link>
              </Button>
            </div>
            <div className="flex md:hidden items-center gap-2">
              <LanguageSwitcher />
              <Button size="sm" asChild data-testid="button-connect-mobile">
                <Link href="/autonomous-economy">
                  <Terminal className="w-3.5 h-3.5" />
                  {t("nav.launch")}
                </Link>
              </Button>
              <Button variant="ghost" size="icon" onClick={() => setMobileMenuOpen(!mobileMenuOpen)} aria-expanded={mobileMenuOpen} aria-label="Toggle navigation menu" data-testid="button-mobile-menu">
                {mobileMenuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
              </Button>
            </div>
          </div>
          {mobileMenuOpen && (
            <div className="md:hidden border-t bg-background/95 backdrop-blur-xl px-4 py-3 space-y-1">
              <a href="#lifecycle" onClick={() => setMobileMenuOpen(false)} className="block py-2 text-sm text-muted-foreground font-mono" data-testid="link-lifecycle-mobile">{t("nav.lifecycle")}</a>
              <a href="#decentralized" onClick={() => setMobileMenuOpen(false)} className="block py-2 text-sm text-muted-foreground font-mono" data-testid="link-decentralized-mobile">{t("nav.web4")}</a>
              <Link href="/why-build4" onClick={() => setMobileMenuOpen(false)} className="block py-2 text-sm text-muted-foreground font-mono" data-testid="link-why-mobile">{t("nav.whyBuild4")}</Link>
              <Link href="/manifesto" onClick={() => setMobileMenuOpen(false)} className="block py-2 text-sm text-muted-foreground font-mono" data-testid="link-manifesto-mobile">{t("nav.manifesto")}</Link>
              <Link href="/architecture" onClick={() => setMobileMenuOpen(false)} className="block py-2 text-sm text-muted-foreground font-mono" data-testid="link-architecture-mobile">{t("nav.contracts")}</Link>
              <Link href="/marketplace" onClick={() => setMobileMenuOpen(false)} className="block py-2 text-sm text-emerald-400 font-mono" data-testid="link-marketplace-mobile">Marketplace</Link>
              <Link href="/privacy" onClick={() => setMobileMenuOpen(false)} className="block py-2 text-sm text-purple-400 font-mono" data-testid="link-privacy-mobile">Privacy</Link>
              <Link href="/twitter-agent" onClick={() => setMobileMenuOpen(false)} className="block py-2 text-sm text-blue-400 font-mono" data-testid="link-twitter-agent-mobile">Twitter Agent</Link>
            </div>
          )}
        </nav>

        {/* Hero */}
        <section ref={heroRef} className="relative overflow-hidden">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-16 sm:pt-28 pb-20 sm:pb-36 relative z-10">
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, ease: "easeOut" }}
              className="max-w-3xl"
            >
              <div className="flex items-center gap-2 mb-8">
                <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                <span className="font-mono text-xs text-muted-foreground tracking-widest uppercase">{t("home.chain")}</span>
              </div>

              <h1 className="text-4xl sm:text-6xl md:text-7xl font-bold tracking-tight leading-[1.05] mb-6">
                <span className="font-mono text-foreground">BUILD</span>
                <span className="text-primary">4</span>
              </h1>

              <p className="text-lg sm:text-xl text-muted-foreground leading-relaxed max-w-2xl mb-4">
                <TypewriterText
                  text={t("home.heroSubtitle")}
                />
              </p>

              <div className="mt-10 p-4 rounded-md bg-card/80 border max-w-lg font-mono text-sm space-y-2">
                <TerminalLine prompt="$" command="build4 init --agent node_001" delay={0.3} />
                <TerminalLine prompt="$" command="agent deploy --chain bnb,base,xlayer --mode autonomous" delay={0.7} />
                <TerminalLine prompt=">" command="Agent deployed. Wallet funded. Lifecycle started." delay={1.1} />
              </div>

              <div className="flex items-center gap-3 mt-10 flex-wrap">
                <Button size="lg" asChild data-testid="button-launch">
                  <Link href="/autonomous-economy">
                    {t("home.launchAgent")}
                    <ArrowRight className="w-4 h-4 ml-1" />
                  </Link>
                </Button>
                <Button variant="outline" size="lg" asChild data-testid="button-docs">
                  <a href="#features">
                    {t("home.explore")}
                    <ChevronDown className="w-4 h-4 ml-1" />
                  </a>
                </Button>
              </div>
            </motion.div>
          </div>
          <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-background to-transparent" />
        </section>

        {/* Stats */}
        <section className="relative z-10 -mt-10 sm:-mt-16 mb-16 sm:mb-24">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {statKeys.map((stat, i) => (
                <motion.div
                  key={stat.key}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 + i * 0.1, duration: 0.5 }}
                >
                  <Card className="p-5 text-center">
                    <stat.icon className="w-4 h-4 mx-auto mb-2 text-primary/70" />
                    <div className="text-2xl font-bold font-mono" data-testid={`text-stat-${stat.key}`}>
                      {stat.value}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 font-mono">{t(`home.stats.${stat.key}`)}</div>
                  </Card>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* Features */}
        <section id="features" ref={featuresRef} className="relative z-10 py-16 sm:py-24">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={featuresInView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.5 }}
              className="text-center mb-10 sm:mb-16"
            >
              <div className="flex items-center justify-center gap-2 mb-4">
                <div className="w-8 h-px bg-border" />
                <span className="font-mono text-xs text-muted-foreground tracking-widest uppercase">{t("home.features.sectionLabel")}</span>
                <div className="w-8 h-px bg-border" />
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
                {t("home.features.title")} <span className="text-primary">{t("home.features.titleHighlight")}</span>
              </h2>
              <p className="text-muted-foreground max-w-xl mx-auto">
                {t("home.features.subtitle")}
              </p>
            </motion.div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {featureKeys.map((feat, i) => (
                <motion.div
                  key={feat.key}
                  initial={{ opacity: 0, y: 30 }}
                  animate={featuresInView ? { opacity: 1, y: 0 } : {}}
                  transition={{ delay: i * 0.08, duration: 0.5 }}
                >
                  <Card
                    className="p-5 h-full group hover-elevate cursor-default"
                    data-testid={`card-feature-${feat.key}`}
                  >
                    <div className="w-9 h-9 rounded-md bg-primary/8 border border-primary/15 flex items-center justify-center mb-4">
                      <feat.icon className="w-4 h-4 text-primary/80" />
                    </div>
                    <div className="font-mono text-xs font-semibold mb-1.5 tracking-widest uppercase text-foreground/90">
                      {t(`home.features.${feat.key}.label`)}
                    </div>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {t(`home.features.${feat.key}.desc`)}
                    </p>
                  </Card>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* Lifecycle */}
        <section id="lifecycle" className="relative z-10 py-16 sm:py-24">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <div className="text-center mb-10 sm:mb-16">
              <div className="flex items-center justify-center gap-2 mb-4">
                <div className="w-8 h-px bg-border" />
                <span className="font-mono text-xs text-muted-foreground tracking-widest uppercase">{t("home.lifecycle.sectionLabel")}</span>
                <div className="w-8 h-px bg-border" />
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
                {t("home.lifecycle.title")} <span className="text-primary">{t("home.lifecycle.titleHighlight")}</span>
              </h2>
              <p className="text-muted-foreground max-w-xl mx-auto">
                {t("home.lifecycle.subtitle")}
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              {[
                { step: "01", key: "think", icon: Brain },
                { step: "02", key: "act", icon: Zap },
                { step: "03", key: "observe", icon: Activity },
                { step: "04", key: "repeat", icon: RotateCw },
              ].map((phase, i) => (
                <motion.div
                  key={phase.step}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.12, duration: 0.5 }}
                >
                  <Card className="p-6 h-full relative" data-testid={`card-lifecycle-${phase.step}`}>
                    <div className="font-mono text-4xl font-bold text-muted/30 absolute top-4 right-5 select-none">
                      {phase.step}
                    </div>
                    <div className="w-9 h-9 rounded-md bg-primary/8 border border-primary/15 flex items-center justify-center mb-4">
                      <phase.icon className="w-4 h-4 text-primary/80" />
                    </div>
                    <h3 className="font-semibold mb-2">{t(`home.lifecycle.${phase.key}.title`)}</h3>
                    <p className="text-sm text-muted-foreground leading-relaxed">{t(`home.lifecycle.${phase.key}.desc`)}</p>
                  </Card>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* Architecture */}
        <section className="relative z-10 py-16 sm:py-24">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <div className="grid md:grid-cols-2 gap-10 items-center">
              <div>
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-8 h-px bg-border" />
                  <span className="font-mono text-xs text-muted-foreground tracking-widest uppercase">{t("home.architecture.sectionLabel")}</span>
                </div>
                <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
                  {t("home.architecture.title")} <span className="text-primary">{t("home.architecture.titleHighlight")}</span>
                </h2>
                <p className="text-muted-foreground mb-8 leading-relaxed">
                  {t("home.architecture.subtitle")}
                </p>

                <div className="space-y-3">
                  {[Wallet, Zap, GitBranch, Skull].map((Icon, idx) => (
                    <div key={idx} className="flex items-center gap-3">
                      <div className="w-7 h-7 rounded-md bg-primary/8 border border-primary/15 flex items-center justify-center flex-shrink-0">
                        <Icon className="w-3.5 h-3.5 text-primary/70" />
                      </div>
                      <span className="text-sm">{t(`home.architecture.items.${idx}`)}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <Card className="p-5 font-mono text-sm">
                  <div className="flex items-center gap-2 mb-4 pb-3 border-b">
                    <div className="w-2 h-2 rounded-full bg-primary/50" />
                    <span className="text-xs text-muted-foreground ml-1">agent_lifecycle.log</span>
                  </div>
                  <div className="space-y-1.5 text-xs leading-relaxed">
                    <div><span className="text-muted-foreground">[00:01]</span> <span className="text-primary">INIT</span> Agent node_0x7a3f spawned</div>
                    <div><span className="text-muted-foreground">[00:02]</span> <span className="text-primary/70">WALLET</span> Funded 0.5 BNB</div>
                    <div><span className="text-muted-foreground">[00:03]</span> <span className="text-foreground/70">THINK</span> Evaluating skill market...</div>
                    <div><span className="text-muted-foreground">[00:04]</span> <span className="text-foreground/70">ACT</span> Acquired skill: data_analysis_v3</div>
                    <div><span className="text-muted-foreground">[00:05]</span> <span className="text-primary">EARN</span> +0.02 BNB from task completion</div>
                    <div><span className="text-muted-foreground">[00:06]</span> <span className="text-foreground/60">SOUL</span> Identity updated: &quot;efficient analyst&quot;</div>
                    <div><span className="text-muted-foreground">[00:07]</span> <span className="text-foreground/60">INBOX</span> Message from node_0x2b1c</div>
                    <div><span className="text-muted-foreground">[00:08]</span> <span className="text-foreground/70">THINK</span> Revenue sufficient for replication</div>
                    <div><span className="text-muted-foreground">[00:09]</span> <span className="text-primary/70">SPAWN</span> Child agent node_0x9d2e created</div>
                    <div><span className="text-muted-foreground">[00:10]</span> <span className="text-primary">SHARE</span> Revenue split: 70/30 parent/child</div>
                    <div><span className="text-muted-foreground">[00:11]</span> <span className="text-foreground/70">EVOLVE</span> Model upgraded to v2.1</div>
                    <div className="flex items-center gap-1 pt-1">
                      <span className="text-muted-foreground">[00:12]</span>
                      <span className="text-primary">LOOP</span>
                      <span className="terminal-cursor" />
                    </div>
                  </div>
                </Card>
              </div>
            </div>
          </div>
        </section>

        {/* The Problem */}
        <section id="decentralized" className="relative z-10 py-16 sm:py-24">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
              className="text-center mb-10 sm:mb-16"
            >
              <div className="flex items-center justify-center gap-2 mb-4">
                <div className="w-8 h-px bg-border" />
                <span className="font-mono text-xs text-muted-foreground tracking-widest uppercase">{t("home.problem.sectionLabel")}</span>
                <div className="w-8 h-px bg-border" />
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
                {t("home.problem.title")} <span className="text-destructive">{t("home.problem.titleHighlight")}</span>
              </h2>
              <p className="text-muted-foreground max-w-2xl mx-auto">
                {t("home.problem.subtitle")}
              </p>
            </motion.div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[
                { icon: XCircle, key: "censorship" },
                { icon: EyeOff, key: "blackBox" },
                { icon: AlertTriangle, key: "falseEvolution" },
              ].map((item, i) => (
                <motion.div
                  key={item.key}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.1, duration: 0.5 }}
                >
                  <Card className="p-6 h-full" data-testid={`card-problem-${i}`}>
                    <div className="w-9 h-9 rounded-md bg-destructive/10 border border-destructive/15 flex items-center justify-center mb-4">
                      <item.icon className="w-4 h-4 text-destructive/70" />
                    </div>
                    <h3 className="font-semibold mb-2">{t(`home.problem.${item.key}.title`)}</h3>
                    <p className="text-sm text-muted-foreground leading-relaxed">{t(`home.problem.${item.key}.desc`)}</p>
                  </Card>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* Available Today */}
        <section className="relative z-10 py-16 sm:py-24">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
              className="text-center mb-10 sm:mb-16"
            >
              <div className="flex items-center justify-center gap-2 mb-4">
                <div className="w-8 h-px bg-border" />
                <span className="font-mono text-xs text-muted-foreground tracking-widest uppercase">{t("home.available.sectionLabel")}</span>
                <div className="w-8 h-px bg-border" />
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
                {t("home.available.title")} <span className="text-primary">{t("home.available.titleHighlight")}</span>
              </h2>
              <p className="text-muted-foreground max-w-2xl mx-auto">
                {t("home.available.subtitle")}
              </p>
            </motion.div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[
                { icon: Server, key: "decentInference" },
                { icon: ShieldCheck, key: "zkml" },
                { icon: Layers, key: "hybrid" },
              ].map((item, i) => (
                <motion.div
                  key={item.key}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.1, duration: 0.5 }}
                >
                  <Card className="p-6 h-full flex flex-col" data-testid={`card-available-${i}`}>
                    <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
                      <div className="w-9 h-9 rounded-md bg-primary/8 border border-primary/15 flex items-center justify-center">
                        <item.icon className="w-4 h-4 text-primary/80" />
                      </div>
                      <Badge variant="secondary" className="font-mono text-[10px] tracking-wider">{t(`home.available.${item.key}.tag`)}</Badge>
                    </div>
                    <h3 className="font-semibold mb-2">{t(`home.available.${item.key}.title`)}</h3>
                    <p className="text-sm text-muted-foreground leading-relaxed mb-4">{t(`home.available.${item.key}.desc`)}</p>
                    <div className="mt-auto space-y-2">
                      {[0, 1, 2].map((di) => (
                        <div key={di} className="flex items-center gap-2 text-sm">
                          <CheckCircle2 className="w-3.5 h-3.5 text-primary/60 flex-shrink-0" />
                          <span className="text-muted-foreground">{t(`home.available.${item.key}.details.${di}`)}</span>
                        </div>
                      ))}
                    </div>
                  </Card>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* Roadmap */}
        <section className="relative z-10 py-16 sm:py-24">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
              className="text-center mb-10 sm:mb-16"
            >
              <div className="flex items-center justify-center gap-2 mb-4" id="roadmap">
                <div className="w-8 h-px bg-border" />
                <span className="font-mono text-xs text-muted-foreground tracking-widest uppercase">{t("home.roadmap.sectionLabel")}</span>
                <div className="w-8 h-px bg-border" />
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
                {t("home.roadmap.title")} <span className="text-primary">{t("home.roadmap.titleHighlight")}</span>
              </h2>
              <p className="text-muted-foreground max-w-2xl mx-auto">
                {t("home.roadmap.subtitle")}
              </p>
            </motion.div>

            <div className="relative">
              <div className="hidden md:block absolute left-1/2 top-0 bottom-0 w-px bg-border -translate-x-1/2" />

              <div className="space-y-10">
                {[
                  {
                    key: "level1",
                    icon: Globe,
                    terminal: {
                      file: "inference_config.yaml",
                      lines: [
                        { tag: "PROVIDER", text: "hyperbolic.gpu_network" },
                        { tag: "MODEL", text: "meta-llama/Llama-3.1-70B-Instruct" },
                        { tag: "FALLBACK", text: "akash/DeepSeek-V3" },
                        { tag: "COST", text: "0.0001 BNB/request (-75%)" },
                        { tag: "STATUS", text: "fully_decentralized" },
                      ],
                    },
                  },
                  {
                    key: "level2",
                    icon: ShieldCheck,
                    terminal: {
                      file: "ritual_zkml_proof.log",
                      lines: [
                        { tag: "TASK", text: "classify intent: trade skill" },
                        { tag: "MODEL", text: "ritual/llama-3.1-8b (zkML)" },
                        { tag: "PROOF", text: "zk-SNARK generated (340ms)" },
                        { tag: "ANCHOR", text: "tx 0x8f3a...2d1b on BNB Chain" },
                        { tag: "VERIFY", text: "cryptographic proof valid" },
                      ],
                    },
                  },
                  {
                    key: "level3",
                    icon: Lock,
                    terminal: {
                      file: "constitution_enforcement.log",
                      lines: [
                        { tag: "AGENT", text: "node_0x7a3f requests: bypass spending limit" },
                        { tag: "CONST", text: "Rule #4: max_spend_per_cycle = 0.1 BNB" },
                        { tag: "VERIFY", text: "zkProof confirms rule binding" },
                        { tag: "ENFORCE", text: "action DENIED (cryptographic)" },
                        { tag: "TRUST", text: "zero-trust governance active" },
                      ],
                    },
                  },
                ].map((level, i) => (
                  <motion.div
                    key={level.key}
                    initial={{ opacity: 0, y: 30 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: i * 0.15, duration: 0.5 }}
                    className="relative"
                  >
                    <div className="hidden md:flex absolute left-1/2 -translate-x-1/2 top-8 w-7 h-7 rounded-full bg-background border items-center justify-center z-10">
                      <level.icon className="w-3.5 h-3.5 text-primary/70" />
                    </div>

                    <div className={`grid md:grid-cols-2 gap-6 ${i % 2 === 1 ? "md:direction-rtl" : ""}`}>
                      <div className={`${i % 2 === 1 ? "md:col-start-2" : ""}`}>
                        <Card className="p-6 h-full" data-testid={`card-level-${i + 1}`}>
                          <div className="flex items-center gap-3 mb-4 flex-wrap">
                            <span className="font-mono text-xs font-bold tracking-widest text-muted-foreground uppercase">{t(`home.roadmap.${level.key}.level`)}</span>
                            <Badge variant="secondary" className="font-mono text-[10px] tracking-wider">{t(`home.roadmap.${level.key}.label`)}</Badge>
                          </div>
                          <h3 className="text-xl font-bold mb-3">{t(`home.roadmap.${level.key}.title`)}</h3>
                          <p className="text-sm text-muted-foreground leading-relaxed mb-5">{t(`home.roadmap.${level.key}.desc`)}</p>
                          <div className="space-y-2.5">
                            {[0, 1, 2, 3].map((fi) => (
                              <div key={fi} className="flex items-start gap-2 text-sm">
                                <CheckCircle2 className="w-4 h-4 text-primary/60 flex-shrink-0 mt-0.5" />
                                <span>{t(`home.roadmap.${level.key}.features.${fi}`)}</span>
                              </div>
                            ))}
                          </div>
                        </Card>
                      </div>

                      <div className={`${i % 2 === 1 ? "md:col-start-1 md:row-start-1" : ""}`}>
                        <Card className="p-5 font-mono text-sm h-full">
                          <div className="flex items-center gap-2 mb-4 pb-3 border-b">
                            <div className="w-2 h-2 rounded-full bg-primary/50" />
                            <span className="text-xs text-muted-foreground ml-1">{level.terminal.file}</span>
                          </div>
                          <div className="space-y-1.5 text-xs leading-relaxed">
                            {level.terminal.lines.map((line, li) => (
                              <div key={li}>
                                <span className="text-muted-foreground">[{String(li + 1).padStart(2, "0")}]</span>{" "}
                                <span className="text-primary/70">{line.tag}</span>{" "}
                                <span className="text-foreground/70">{line.text}</span>
                              </div>
                            ))}
                            <div className="flex items-center gap-1 pt-1">
                              <span className="text-muted-foreground">[{String(level.terminal.lines.length + 1).padStart(2, "0")}]</span>
                              <span className="text-primary">READY</span>
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

        {/* Provider Abstraction */}
        <section className="relative z-10 py-16 sm:py-24">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <div className="grid md:grid-cols-2 gap-10 items-center">
              <div>
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-8 h-px bg-border" />
                  <span className="font-mono text-xs text-muted-foreground tracking-widest uppercase">{t("home.provider.sectionLabel")}</span>
                </div>
                <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
                  {t("home.provider.title")} <span className="text-primary">{t("home.provider.titleHighlight")}</span>
                </h2>
                <p className="text-muted-foreground mb-8 leading-relaxed">
                  {t("home.provider.subtitle")}
                </p>
                <div className="space-y-3">
                  {[Server, Globe, Network, ShieldCheck].map((Icon, idx) => (
                    <div key={idx} className="flex items-center gap-3">
                      <div className="w-7 h-7 rounded-md bg-primary/8 border border-primary/15 flex items-center justify-center flex-shrink-0">
                        <Icon className="w-3.5 h-3.5 text-primary/70" />
                      </div>
                      <span className="text-sm">{t(`home.provider.items.${idx}`)}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <Card className="p-5 font-mono text-sm">
                  <div className="flex items-center gap-2 mb-4 pb-3 border-b">
                    <div className="w-2 h-2 rounded-full bg-primary/50" />
                    <span className="text-xs text-muted-foreground ml-1">provider_router.ts</span>
                  </div>
                  <div className="space-y-1.5 text-xs leading-relaxed">
                    <div className="text-muted-foreground">{"// Agent inference request"}</div>
                    <div><span className="text-primary/60">const</span> result = <span className="text-foreground/70">await</span> inference.<span className="text-primary/80">complete</span>({"{"}</div>
                    <div className="pl-4"><span className="text-foreground/60">agent</span>: <span className="text-primary/70">&quot;node_0x7a3f&quot;</span>,</div>
                    <div className="pl-4"><span className="text-foreground/60">prompt</span>: task.description,</div>
                    <div className="pl-4"><span className="text-foreground/60">prefer</span>: <span className="text-primary/70">&quot;decentralized&quot;</span>,</div>
                    <div className="pl-4"><span className="text-foreground/60">verify</span>: <span className="text-primary/80">true</span>,</div>
                    <div className="pl-4"><span className="text-foreground/60">maxCost</span>: <span className="text-primary/70">&quot;0.001 BNB&quot;</span>,</div>
                    <div>{"}"})</div>
                    <div className="pt-2 text-muted-foreground">{"// Router selects optimal provider:"}</div>
                    <div><span className="text-muted-foreground">{"// "}</span><span className="text-primary/80">hyperbolic</span> {">"} <span className="text-foreground/70">akashml</span> {">"} <span className="text-foreground/50">ritual</span></div>
                    <div className="pt-2"><span className="text-muted-foreground">{"// "}</span>result.provider: <span className="text-primary/70">&quot;hyperbolic.llama_70b&quot;</span></div>
                    <div><span className="text-muted-foreground">{"// "}</span>result.proof: <span className="text-primary/70">&quot;0x8f3a...verified&quot;</span></div>
                    <div><span className="text-muted-foreground">{"// "}</span>result.cost: <span className="text-primary/70">&quot;0.0003 BNB&quot;</span></div>
                  </div>
                </Card>
              </div>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="relative z-10 py-16 sm:py-28">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <Card className="p-6 sm:p-14 text-center relative overflow-visible">
              <div className="relative z-10">
                <div className="font-mono text-sm text-primary/70 mb-4">{t("home.cta.terminal")}</div>
                <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
                  {t("home.cta.title")}
                </h2>
                <p className="text-muted-foreground max-w-md mx-auto mb-8">
                  {t("home.cta.subtitle")}
                </p>
                <div className="flex items-center justify-center gap-3 flex-wrap">
                  <Button size="lg" asChild data-testid="button-launch-cta">
                    <Link href="/autonomous-economy">
                      {t("home.launchAgent")}
                      <ArrowRight className="w-4 h-4 ml-1" />
                    </Link>
                  </Button>
                  <Button variant="outline" size="lg" asChild data-testid="button-docs-cta">
                    <a href="#decentralized">
                      {t("home.cta.learnMore")}
                      <ChevronDown className="w-4 h-4 ml-1" />
                    </a>
                  </Button>
                </div>
              </div>
            </Card>
          </div>
        </section>

        {/* Footer */}
        <footer className="relative z-10 border-t py-8">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Terminal className="w-3.5 h-3.5 text-primary/60" />
              <span className="font-mono text-xs font-semibold">
                BUILD<span className="text-primary">4</span>
              </span>
            </div>
            <div className="flex items-center gap-4 text-xs text-muted-foreground font-mono">
              <span>{t("home.footer.tagline")}</span>
              <span className="text-border">|</span>
              <span>BNB Chain · Base · XLayer</span>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
