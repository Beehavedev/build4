import { useState, useEffect, useRef } from "react";
import { motion, useInView } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { useT } from "@/lib/i18n";
import { LanguageSwitcher } from "@/components/language-switcher";
import { SEO } from "@/components/seo";
import asterNinjaRed from "@assets/generated_images/aster_ninja_red.png";
import asterNinjaBlue from "@assets/generated_images/aster_ninja_blue.png";
import asterLogo from "@assets/aster_logo.svg";
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
  Users,
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
  Code,
  Rocket,
  Trophy,
  Timer,
  Copy,
  TrendingUp,
  BarChart3,
  Shield,
  LineChart,
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

function formatNum(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString();
}

const defaultStats = [
  { key: "visitors", value: "—", icon: Wallet },
  { key: "transactions", value: "—", icon: Activity },
  { key: "skillsCreated", value: "—", icon: Cpu },
  { key: "activeAgents", value: "—", icon: Bot },
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
    let columns = Math.floor(canvas.width / fontSize);
    let drops: number[] = Array(columns).fill(0).map(() => Math.random() * -100);

    let lastFrame = 0;
    const FRAME_INTERVAL = 100;
    let rafId: number;

    const draw = (timestamp: number) => {
      rafId = requestAnimationFrame(draw);
      if (timestamp - lastFrame < FRAME_INTERVAL) return;
      lastFrame = timestamp;

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

    rafId = requestAnimationFrame(draw);

    const handleResize = () => {
      resize();
      columns = Math.floor(canvas.width / fontSize);
      drops = Array(columns).fill(0).map(() => Math.random() * -100);
    };
    window.addEventListener("resize", handleResize);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", handleResize);
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

function B4RewardsLeaderboard() {
  const { data: leaderboard = [] } = useQuery<Array<{ chatId: string; totalRewards: string; rewardCount: number }>>({
    queryKey: ["/api/rewards/leaderboard"],
  });

  if (leaderboard.length === 0) return null;

  const medals = ["🥇", "🥈", "🥉"];

  return (
    <section className="relative z-10 mb-16 sm:mb-24">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.5 }}
        >
          <Card className="p-6 sm:p-8 border-primary/20" data-testid="card-b4-leaderboard">
            <div className="flex items-center gap-2 mb-6">
              <Trophy className="w-5 h-5 text-primary" />
              <h3 className="text-lg font-bold font-mono">$B4 Rewards Leaderboard</h3>
            </div>
            <div className="space-y-2">
              {leaderboard.slice(0, 10).map((entry, i) => {
                const medal = i < 3 ? medals[i] : `${i + 1}.`;
                const shortId = entry.chatId.length > 7
                  ? `${entry.chatId.substring(0, 4)}...${entry.chatId.substring(entry.chatId.length - 3)}`
                  : entry.chatId;
                const total = Number(entry.totalRewards) || 0;
                return (
                  <div
                    key={entry.chatId}
                    className={`flex items-center justify-between px-4 py-2.5 rounded-lg font-mono text-sm ${
                      i < 3 ? "bg-primary/5 border border-primary/10" : "bg-muted/30"
                    }`}
                    data-testid={`leaderboard-row-${i}`}
                  >
                    <div className="flex items-center gap-3">
                      <span className="w-8 text-center">{medal}</span>
                      <span className="text-muted-foreground">{shortId}</span>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="font-semibold">{total.toLocaleString()} $B4</span>
                      <span className="text-xs text-muted-foreground">{entry.rewardCount} actions</span>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-4 text-center">
              <a href="https://t.me/build4_bot" target="_blank" rel="noopener noreferrer">
                <Button variant="outline" size="sm" className="font-mono text-xs gap-2" data-testid="button-earn-b4">
                  <Rocket className="w-3.5 h-3.5" />
                  Start Earning $B4
                </Button>
              </a>
            </div>
          </Card>
        </motion.div>
      </div>
    </section>
  );
}

function PlatformStats() {
  const t = useT();
  const { data } = useQuery<{
    onchainUsers: number;
    transactions: number;
    skills: number;
    agents: number;
    skillPurchases: number;
  }>({ queryKey: ["/api/platform/stats"] });

  const stats = data
    ? [
        { key: "visitors", value: formatNum(data.visitors || data.onchainUsers || 0), icon: Wallet },
        { key: "transactions", value: formatNum(data.transactions), icon: Activity },
        { key: "skillsCreated", value: formatNum(data.skills), icon: Cpu },
        { key: "activeAgents", value: formatNum(data.agents), icon: Bot },
      ]
    : defaultStats;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {stats.map((stat, i) => (
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
      <SEO />
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
              <Link href="/manifesto" className="text-xs text-muted-foreground font-mono tracking-wide transition-colors" data-testid="link-manifesto">{t("nav.manifesto")}</Link>
              <Link href="/hire-agent" className="text-xs text-muted-foreground font-mono tracking-wide transition-colors" data-testid="link-hire-agent">Hire Agent</Link>
              <Link href="/token" className="text-xs text-primary font-mono tracking-wide font-semibold transition-colors" data-testid="link-token">$B4</Link>
              <Link href="/onchainos" className="text-xs text-violet-400 font-mono tracking-wide transition-colors hover:text-violet-300" data-testid="link-onchainos">OnchainOS</Link>
              <Link href="/build" className="text-xs text-emerald-400 font-mono tracking-wide transition-colors hover:text-emerald-300" data-testid="link-build">Build</Link>
              <Link href="/futures" className="text-xs text-orange-400 font-mono tracking-wide transition-colors hover:text-orange-300 font-semibold" data-testid="link-futures">Futures</Link>
              <Link href="/agentic_bot" className="text-xs text-muted-foreground font-mono tracking-wide transition-colors hover:text-foreground" data-testid="link-pricing">Telegram Bot</Link>
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
              <Link href="/manifesto" onClick={() => setMobileMenuOpen(false)} className="block py-2 text-sm text-muted-foreground font-mono" data-testid="link-manifesto-mobile">{t("nav.manifesto")}</Link>
              <Link href="/hire-agent" onClick={() => setMobileMenuOpen(false)} className="block py-2 text-sm text-muted-foreground font-mono" data-testid="link-hire-agent-mobile">Hire Agent</Link>
              <Link href="/token" onClick={() => setMobileMenuOpen(false)} className="block py-2 text-sm text-primary font-mono font-semibold" data-testid="link-token-mobile">$B4</Link>
              <Link href="/onchainos" onClick={() => setMobileMenuOpen(false)} className="block py-2 text-sm text-violet-400 font-mono" data-testid="link-onchainos-mobile">OnchainOS</Link>
              <Link href="/build" onClick={() => setMobileMenuOpen(false)} className="block py-2 text-sm text-emerald-400 font-mono" data-testid="link-build-mobile">Build</Link>
              <Link href="/futures" onClick={() => setMobileMenuOpen(false)} className="block py-2 text-sm text-orange-400 font-mono font-semibold" data-testid="link-futures-mobile">Futures</Link>
              <Link href="/agentic_bot" onClick={() => setMobileMenuOpen(false)} className="block py-2 text-sm text-muted-foreground font-mono" data-testid="link-pricing-mobile">Telegram Bot</Link>
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
          <PlatformStats />
        </section>

        {/* $B4 Rewards Leaderboard */}
        <B4RewardsLeaderboard />

        {/* Trading Challenge */}
        <section className="relative z-10 mb-16 sm:mb-24">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4, duration: 0.6 }}
            >
              <Card className="relative overflow-hidden border-primary/30 bg-gradient-to-br from-primary/5 via-background to-primary/5" data-testid="card-trading-challenge">
                <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 rounded-full -translate-y-1/2 translate-x-1/2 blur-3xl" />
                <div className="absolute bottom-0 left-0 w-48 h-48 bg-primary/5 rounded-full translate-y-1/2 -translate-x-1/2 blur-3xl" />
                <div className="relative p-6 sm:p-8 lg:p-10">
                  <div className="flex flex-col lg:flex-row gap-8 items-center">
                    <div className="flex-1 text-center lg:text-left">
                      <div className="flex items-center justify-center lg:justify-start gap-2 mb-3">
                        <Badge variant="outline" className="border-primary/40 text-primary font-mono text-[10px] tracking-widest uppercase px-2 py-0.5">
                          <Trophy className="w-3 h-3 mr-1" />
                          Live Challenge
                        </Badge>
                        <Badge variant="outline" className="border-green-500/40 text-green-500 font-mono text-[10px] tracking-widest uppercase px-2 py-0.5 animate-pulse">
                          <Timer className="w-3 h-3 mr-1" />
                          4 Days
                        </Badge>
                      </div>
                      <h3 className="text-2xl sm:text-3xl font-bold tracking-tight mb-3" data-testid="text-challenge-title">
                        Trading Bot Challenge <span className="text-primary">#1</span>
                      </h3>
                      <p className="text-muted-foreground text-sm sm:text-base mb-6 max-w-lg">
                        Create an AI trading bot. If your bot trades and makes profit, you're in.
                        Top 3 agents ranked by PnL win massive $B4 prizes.
                      </p>
                      <div className="grid grid-cols-3 gap-3 sm:gap-4 mb-6 max-w-md mx-auto lg:mx-0">
                        <div className="text-center p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20" data-testid="text-prize-1st">
                          <Trophy className="w-5 h-5 mx-auto mb-1 text-yellow-500" />
                          <div className="font-mono font-bold text-lg sm:text-xl text-yellow-500">500K</div>
                          <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wide">1st Place</div>
                        </div>
                        <div className="text-center p-3 rounded-lg bg-slate-300/10 border border-slate-400/20" data-testid="text-prize-2nd">
                          <Trophy className="w-5 h-5 mx-auto mb-1 text-slate-400" />
                          <div className="font-mono font-bold text-lg sm:text-xl text-slate-400">300K</div>
                          <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wide">2nd Place</div>
                        </div>
                        <div className="text-center p-3 rounded-lg bg-amber-700/10 border border-amber-700/20" data-testid="text-prize-3rd">
                          <Trophy className="w-5 h-5 mx-auto mb-1 text-amber-600" />
                          <div className="font-mono font-bold text-lg sm:text-xl text-amber-600">150K</div>
                          <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wide">3rd Place</div>
                        </div>
                      </div>
                      <div className="flex flex-col sm:flex-row gap-3 justify-center lg:justify-start">
                        <a href="https://t.me/build4_bot" target="_blank" rel="noopener noreferrer">
                          <Button size="lg" className="font-mono text-sm gap-2 w-full sm:w-auto" data-testid="button-join-challenge">
                            <Trophy className="w-4 h-4" />
                            Join Challenge
                            <ArrowRight className="w-4 h-4" />
                          </Button>
                        </a>
                        <a href="https://t.me/build4_bot" target="_blank" rel="noopener noreferrer">
                          <Button variant="outline" size="lg" className="font-mono text-sm gap-2 w-full sm:w-auto border-primary/30" data-testid="button-copy-trade">
                            <Copy className="w-4 h-4" />
                            Copy Top Traders
                          </Button>
                        </a>
                      </div>
                    </div>
                    <div className="flex-shrink-0 w-full lg:w-auto">
                      <Card className="p-5 bg-background/80 backdrop-blur-sm border-primary/15 w-full lg:w-72">
                        <div className="font-mono text-xs text-muted-foreground uppercase tracking-widest mb-4 flex items-center gap-2">
                          <TrendingUp className="w-3.5 h-3.5 text-primary" />
                          How It Works
                        </div>
                        <div className="space-y-4">
                          <div className="flex items-start gap-3">
                            <div className="w-6 h-6 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                              <span className="font-mono text-[10px] font-bold text-primary">1</span>
                            </div>
                            <div>
                              <div className="font-mono text-xs font-semibold mb-0.5">Create Agent</div>
                              <div className="text-[11px] text-muted-foreground">Build your AI trading bot in the Telegram bot</div>
                            </div>
                          </div>
                          <div className="flex items-start gap-3">
                            <div className="w-6 h-6 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                              <span className="font-mono text-[10px] font-bold text-primary">2</span>
                            </div>
                            <div>
                              <div className="font-mono text-xs font-semibold mb-0.5">Enter Challenge</div>
                              <div className="text-[11px] text-muted-foreground">Use /challenge to join with your agent</div>
                            </div>
                          </div>
                          <div className="flex items-start gap-3">
                            <div className="w-6 h-6 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                              <span className="font-mono text-[10px] font-bold text-primary">3</span>
                            </div>
                            <div>
                              <div className="font-mono text-xs font-semibold mb-0.5">Trade & Compete</div>
                              <div className="text-[11px] text-muted-foreground">Your bot trades autonomously — best PnL wins</div>
                            </div>
                          </div>
                          <div className="flex items-start gap-3">
                            <div className="w-6 h-6 rounded-full bg-green-500/10 border border-green-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                              <span className="font-mono text-[10px] font-bold text-green-500">$</span>
                            </div>
                            <div>
                              <div className="font-mono text-xs font-semibold mb-0.5">Win $B4</div>
                              <div className="text-[11px] text-muted-foreground">950K $B4 total prizes paid automatically</div>
                            </div>
                          </div>
                        </div>
                      </Card>
                    </div>
                  </div>
                </div>
              </Card>
            </motion.div>
          </div>
        </section>

        {/* Aster DEX - hidden, use mini app */}
        <section className="relative z-10 mb-16 sm:mb-24 hidden">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.5, duration: 0.6 }}
            >
              <Card className="relative overflow-hidden border-violet-500/30 bg-gradient-to-br from-violet-500/5 via-background to-purple-500/5" data-testid="card-aster-dex">
                <div className="absolute top-0 right-0 w-72 h-72 bg-violet-500/5 rounded-full -translate-y-1/2 translate-x-1/2 blur-3xl" />
                <div className="absolute bottom-0 left-0 w-56 h-56 bg-purple-500/5 rounded-full translate-y-1/2 -translate-x-1/2 blur-3xl" />
                <div className="relative p-6 sm:p-8 lg:p-10">
                  <div className="flex flex-col lg:flex-row gap-8 items-center">
                    <div className="flex-1 text-center lg:text-left">
                      <div className="flex items-center justify-center lg:justify-start gap-2 mb-3">
                        <Badge variant="outline" className="border-violet-500/40 text-violet-400 font-mono text-[10px] tracking-widest uppercase px-2 py-0.5">
                          <BarChart3 className="w-3 h-3 mr-1" />
                          Perpetual DEX
                        </Badge>
                        <Badge variant="outline" className="border-green-500/40 text-green-500 font-mono text-[10px] tracking-widest uppercase px-2 py-0.5">
                          <Shield className="w-3 h-3 mr-1" />
                          Non-Custodial
                        </Badge>
                      </div>
                      <h3 className="text-2xl sm:text-3xl font-bold tracking-tight mb-3" data-testid="text-aster-title">
                        Aster DEX <span className="text-violet-400">Trading</span>
                      </h3>
                      <p className="text-muted-foreground text-sm sm:text-base mb-4 max-w-lg">
                        Trade perpetual futures and spot markets directly from Telegram.
                        Up to 150x leverage, deep liquidity, and multichain support — powered by Aster DEX.
                      </p>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6 max-w-lg mx-auto lg:mx-0">
                        <div className="text-center p-3 rounded-lg bg-violet-500/10 border border-violet-500/20">
                          <div className="font-mono font-bold text-lg text-violet-400">150x</div>
                          <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wide">Max Leverage</div>
                        </div>
                        <div className="text-center p-3 rounded-lg bg-violet-500/10 border border-violet-500/20">
                          <div className="font-mono font-bold text-lg text-violet-400">1-Tap</div>
                          <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wide">Connect</div>
                        </div>
                        <div className="text-center p-3 rounded-lg bg-violet-500/10 border border-violet-500/20">
                          <div className="font-mono font-bold text-lg text-violet-400">5+</div>
                          <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wide">Order Types</div>
                        </div>
                        <div className="text-center p-3 rounded-lg bg-violet-500/10 border border-violet-500/20">
                          <div className="font-mono font-bold text-lg text-violet-400">V3</div>
                          <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wide">EIP-712</div>
                        </div>
                      </div>
                      <div className="flex flex-col sm:flex-row gap-3 justify-center lg:justify-start">
                        <a href="https://t.me/build4_bot" target="_blank" rel="noopener noreferrer">
                          <Button size="lg" className="font-mono text-sm gap-2 w-full sm:w-auto bg-violet-600 hover:bg-violet-700" data-testid="button-trade-aster">
                            <BarChart3 className="w-4 h-4" />
                            Start Trading
                            <ArrowRight className="w-4 h-4" />
                          </Button>
                        </a>
                        <a href="https://www.asterdex.com" target="_blank" rel="noopener noreferrer">
                          <Button variant="outline" size="lg" className="font-mono text-sm gap-2 w-full sm:w-auto border-violet-500/30 text-violet-400 hover:bg-violet-500/10" data-testid="button-aster-website">
                            <Globe className="w-4 h-4" />
                            Aster DEX
                          </Button>
                        </a>
                      </div>
                    </div>
                    <div className="flex-shrink-0 w-full lg:w-auto">
                      <Card className="p-5 bg-background/80 backdrop-blur-sm border-violet-500/15 w-full lg:w-72">
                        <div className="font-mono text-xs text-muted-foreground uppercase tracking-widest mb-4 flex items-center gap-2">
                          <LineChart className="w-3.5 h-3.5 text-violet-400" />
                          Trading Features
                        </div>
                        <div className="space-y-4">
                          <div className="flex items-start gap-3">
                            <div className="w-6 h-6 rounded-full bg-violet-500/10 border border-violet-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                              <Zap className="w-3 h-3 text-violet-400" />
                            </div>
                            <div>
                              <div className="font-mono text-xs font-semibold mb-0.5">1-Tap Connect</div>
                              <div className="text-[11px] text-muted-foreground">Auto-setup with your BUILD4 wallet — no manual API keys</div>
                            </div>
                          </div>
                          <div className="flex items-start gap-3">
                            <div className="w-6 h-6 rounded-full bg-violet-500/10 border border-violet-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                              <BarChart3 className="w-3 h-3 text-violet-400" />
                            </div>
                            <div>
                              <div className="font-mono text-xs font-semibold mb-0.5">Advanced Orders</div>
                              <div className="text-[11px] text-muted-foreground">Stop-loss, take-profit, trailing stop, and limit orders</div>
                            </div>
                          </div>
                          <div className="flex items-start gap-3">
                            <div className="w-6 h-6 rounded-full bg-violet-500/10 border border-violet-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                              <TrendingUp className="w-3 h-3 text-violet-400" />
                            </div>
                            <div>
                              <div className="font-mono text-xs font-semibold mb-0.5">PnL Dashboard</div>
                              <div className="text-[11px] text-muted-foreground">Track positions, unrealized PnL, and trade history</div>
                            </div>
                          </div>
                          <div className="flex items-start gap-3">
                            <div className="w-6 h-6 rounded-full bg-violet-500/10 border border-violet-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                              <Shield className="w-3 h-3 text-violet-400" />
                            </div>
                            <div>
                              <div className="font-mono text-xs font-semibold mb-0.5">EIP-712 Signing</div>
                              <div className="text-[11px] text-muted-foreground">Non-custodial V3 trading — keys never leave your device</div>
                            </div>
                          </div>
                        </div>
                      </Card>
                    </div>
                  </div>
                </div>
              </Card>
            </motion.div>
          </div>
        </section>

        {/* Aster DEX Trading Competition - hidden, use mini app */}
        <section className="relative z-10 mb-16 sm:mb-24 hidden">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.6, duration: 0.7 }}
            >
              <Card className="relative overflow-hidden border-0 bg-transparent shadow-none" data-testid="card-aster-competition">
                <div className="relative rounded-2xl overflow-hidden" style={{ background: "linear-gradient(135deg, #050505 0%, #151515 25%, #0a0a0a 50%, #151515 75%, #050505 100%)" }}>
                  <div className="absolute inset-0 overflow-hidden">
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full blur-[120px]" style={{ background: "rgba(66, 207, 113, 0.08)" }} />
                    <div className="absolute top-0 left-0 w-96 h-96 rounded-full -translate-y-1/2 -translate-x-1/3 blur-[80px]" style={{ background: "rgba(66, 207, 113, 0.06)" }} />
                    <div className="absolute bottom-0 right-0 w-96 h-96 rounded-full translate-y-1/2 translate-x-1/3 blur-[80px]" style={{ background: "rgba(239, 190, 132, 0.05)" }} />
                    <div className="absolute inset-0" style={{ backgroundImage: "radial-gradient(rgba(66, 207, 113, 0.05) 1px, transparent 1px)", backgroundSize: "30px 30px" }} />
                    <div className="absolute top-0 left-0 right-0 h-px" style={{ background: "linear-gradient(to right, transparent, rgba(66, 207, 113, 0.3), transparent)" }} />
                    <div className="absolute bottom-0 left-0 right-0 h-px" style={{ background: "linear-gradient(to right, transparent, rgba(66, 207, 113, 0.3), transparent)" }} />
                    {[15, 42, 73, 28, 61, 85, 19, 54, 37, 68, 91, 46].map((pos, i) => (
                      <motion.div
                        key={i}
                        className="absolute w-1 h-1 rounded-full"
                        style={{ left: `${pos}%`, top: `${[22, 67, 41, 83, 15, 58, 34, 76, 49, 12, 65, 88][i]}%`, background: i % 3 === 0 ? "#42CF71" : i % 3 === 1 ? "#EFBE84" : "#B5B5B5", opacity: 0.3 }}
                        animate={{ opacity: [0.15, 0.6, 0.15], scale: [1, 1.5, 1] }}
                        transition={{ duration: [3, 4, 2.5, 3.5, 4.5, 2, 3.2, 4.1, 2.8, 3.7, 4.3, 2.3][i], repeat: Infinity, delay: [0.2, 1.1, 0.7, 1.8, 0.4, 1.5, 0.9, 0.3, 1.2, 0.6, 1.7, 0.1][i] }}
                      />
                    ))}
                  </div>

                  <div className="relative p-6 sm:p-8 lg:p-12">
                    <div className="flex flex-col items-center text-center">
                      <motion.div
                        initial={{ scale: 0.9, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ delay: 0.8, duration: 0.5, type: "spring" }}
                        className="mb-4"
                      >
                        <Badge className="font-mono text-[10px] tracking-[0.2em] uppercase px-4 py-1.5 backdrop-blur-sm border" style={{ background: "rgba(66, 207, 113, 0.12)", borderColor: "rgba(66, 207, 113, 0.35)", color: "#42CF71" }}>
                          <Trophy className="w-3.5 h-3.5 mr-1.5" />
                          Trading Competition
                        </Badge>
                      </motion.div>

                      <div className="flex flex-col lg:flex-row items-center gap-4 lg:gap-8 w-full max-w-5xl">
                        <motion.div
                          className="hidden lg:block flex-shrink-0"
                          initial={{ x: -80, opacity: 0 }}
                          animate={{ x: 0, opacity: 1 }}
                          transition={{ delay: 1, duration: 0.8, type: "spring" }}
                        >
                          <div className="relative">
                            <div className="absolute inset-0 rounded-full blur-2xl scale-110" style={{ background: "radial-gradient(circle, rgba(66, 207, 113, 0.25), transparent 70%)" }} />
                            <img
                              src={asterNinjaRed}
                              alt="Ninja Trader Alpha"
                              className="relative w-40 h-40 xl:w-52 xl:h-52 object-contain"
                              style={{ filter: "drop-shadow(0 0 25px rgba(66, 207, 113, 0.35))" }}
                              data-testid="img-ninja-red"
                            />
                            <motion.div
                              className="absolute -bottom-2 left-1/2 -translate-x-1/2 text-[10px] font-mono font-bold px-3 py-1 rounded-full tracking-wider whitespace-nowrap"
                              style={{ background: "#42CF71", color: "#050505", boxShadow: "0 4px 15px rgba(66, 207, 113, 0.3)" }}
                              animate={{ y: [0, -3, 0] }}
                              transition={{ duration: 2, repeat: Infinity }}
                            >
                              TEAM ALPHA
                            </motion.div>
                          </div>
                        </motion.div>

                        <div className="flex-1 py-4">
                          <div className="flex items-center justify-center gap-3 mb-3">
                            <img src={asterLogo} alt="Aster DEX" className="h-8 sm:h-10 lg:h-12 w-auto" style={{ filter: "drop-shadow(0 0 12px rgba(66, 207, 113, 0.4))" }} data-testid="img-aster-logo" />
                          </div>
                          <h3 className="text-3xl sm:text-4xl lg:text-5xl font-black tracking-tight mb-2 bg-clip-text text-transparent" style={{ backgroundImage: "linear-gradient(to right, #D5CABE, #ffffff, #D5CABE)" }}>
                            AGENTIC AUTONOMOUS
                          </h3>
                          <h3 className="text-3xl sm:text-4xl lg:text-5xl font-black tracking-tight mb-4 bg-clip-text text-transparent" style={{ backgroundImage: "linear-gradient(to right, #42CF71, #6ddb93, #42CF71)" }}>
                            TRADING COMPETITION
                          </h3>

                          <div className="flex lg:hidden justify-center gap-6 mb-6">
                            <div className="relative">
                              <div className="absolute inset-0 rounded-full blur-xl scale-110" style={{ background: "radial-gradient(circle, rgba(66, 207, 113, 0.25), transparent 70%)" }} />
                              <img src={asterNinjaRed} alt="Ninja Alpha" className="relative w-24 h-24 object-contain" style={{ filter: "drop-shadow(0 0 15px rgba(66, 207, 113, 0.35))" }} />
                              <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 text-[8px] font-mono font-bold px-2 py-0.5 rounded-full tracking-wider whitespace-nowrap" style={{ background: "#42CF71", color: "#050505" }}>ALPHA</div>
                            </div>
                            <div className="flex items-center">
                              <span className="text-3xl font-black" style={{ color: "rgba(66, 207, 113, 0.5)" }}>VS</span>
                            </div>
                            <div className="relative">
                              <div className="absolute inset-0 rounded-full blur-xl scale-110" style={{ background: "radial-gradient(circle, rgba(239, 190, 132, 0.2), transparent 70%)" }} />
                              <img src={asterNinjaBlue} alt="Ninja Omega" className="relative w-24 h-24 object-contain" style={{ filter: "drop-shadow(0 0 15px rgba(239, 190, 132, 0.35))" }} />
                              <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 text-[8px] font-mono font-bold px-2 py-0.5 rounded-full tracking-wider whitespace-nowrap" style={{ background: "#EFBE84", color: "#050505" }}>OMEGA</div>
                            </div>
                          </div>

                          <motion.div
                            className="inline-flex items-center gap-2 rounded-xl px-5 py-2.5 mb-6 backdrop-blur-sm border"
                            style={{ background: "rgba(66, 207, 113, 0.08)", borderColor: "rgba(66, 207, 113, 0.2)" }}
                            animate={{ boxShadow: ["0 0 20px rgba(66, 207, 113, 0)", "0 0 20px rgba(66, 207, 113, 0.12)", "0 0 20px rgba(66, 207, 113, 0)"] }}
                            transition={{ duration: 3, repeat: Infinity }}
                          >
                            <Timer className="w-4 h-4" style={{ color: "#42CF71" }} />
                            <span className="font-mono text-sm font-bold tracking-wide" style={{ color: "#42CF71" }}>COMING SOON</span>
                          </motion.div>

                          <p className="text-sm sm:text-base max-w-xl mx-auto mb-6 leading-relaxed" style={{ color: "#747474" }}>
                            Unleash your AI trading agents in the ultimate battle for PnL supremacy.
                            Compete on Aster DEX perpetual futures — top performers win massive prizes.
                          </p>

                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 max-w-xl mx-auto mb-8">
                            <div className="relative group">
                              <div className="absolute inset-0 rounded-xl blur-sm opacity-0 group-hover:opacity-100 transition-opacity" style={{ background: "rgba(66, 207, 113, 0.15)" }} />
                              <div className="relative text-center p-3 rounded-xl backdrop-blur-sm" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(66, 207, 113, 0.15)" }}>
                                <div className="font-mono font-black text-xl" style={{ color: "#42CF71" }}>150x</div>
                                <div className="font-mono text-[9px] uppercase tracking-widest mt-0.5" style={{ color: "#747474" }}>Max Leverage</div>
                              </div>
                            </div>
                            <div className="relative group">
                              <div className="absolute inset-0 rounded-xl blur-sm opacity-0 group-hover:opacity-100 transition-opacity" style={{ background: "rgba(239, 190, 132, 0.15)" }} />
                              <div className="relative text-center p-3 rounded-xl backdrop-blur-sm" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(66, 207, 113, 0.15)" }}>
                                <div className="font-mono font-black text-xl" style={{ color: "#EFBE84" }}>$B4</div>
                                <div className="font-mono text-[9px] uppercase tracking-widest mt-0.5" style={{ color: "#747474" }}>Prize Pool</div>
                              </div>
                            </div>
                            <div className="relative group">
                              <div className="absolute inset-0 rounded-xl blur-sm opacity-0 group-hover:opacity-100 transition-opacity" style={{ background: "rgba(66, 207, 113, 0.15)" }} />
                              <div className="relative text-center p-3 rounded-xl backdrop-blur-sm" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(66, 207, 113, 0.15)" }}>
                                <div className="font-mono font-black text-xl" style={{ color: "#42CF71" }}>PnL%</div>
                                <div className="font-mono text-[9px] uppercase tracking-widest mt-0.5" style={{ color: "#747474" }}>Ranked By</div>
                              </div>
                            </div>
                            <div className="relative group">
                              <div className="absolute inset-0 rounded-xl blur-sm opacity-0 group-hover:opacity-100 transition-opacity" style={{ background: "rgba(66, 207, 113, 0.15)" }} />
                              <div className="relative text-center p-3 rounded-xl backdrop-blur-sm" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(66, 207, 113, 0.15)" }}>
                                <div className="font-mono font-black text-xl" style={{ color: "#D5CABE" }}>AI</div>
                                <div className="font-mono text-[9px] uppercase tracking-widest mt-0.5" style={{ color: "#747474" }}>Agent Trading</div>
                              </div>
                            </div>
                          </div>

                          <div className="flex flex-col sm:flex-row gap-3 justify-center">
                            <a href="https://t.me/build4_bot" target="_blank" rel="noopener noreferrer">
                              <Button size="lg" className="font-mono text-sm gap-2 w-full sm:w-auto border-0 transition-all" style={{ background: "#42CF71", color: "#050505", boxShadow: "0 4px 20px rgba(66, 207, 113, 0.25)" }} data-testid="button-join-competition">
                                <Trophy className="w-4 h-4" />
                                Join the Competition
                                <ArrowRight className="w-4 h-4" />
                              </Button>
                            </a>
                            <a href="https://www.asterdex.com" target="_blank" rel="noopener noreferrer">
                              <Button variant="outline" size="lg" className="font-mono text-sm gap-2 w-full sm:w-auto backdrop-blur-sm" style={{ borderColor: "rgba(66, 207, 113, 0.25)", color: "#42CF71" }} data-testid="button-learn-competition">
                                <BarChart3 className="w-4 h-4" />
                                Learn More
                              </Button>
                            </a>
                          </div>
                        </div>

                        <motion.div
                          className="hidden lg:block flex-shrink-0"
                          initial={{ x: 80, opacity: 0 }}
                          animate={{ x: 0, opacity: 1 }}
                          transition={{ delay: 1, duration: 0.8, type: "spring" }}
                        >
                          <div className="relative">
                            <div className="absolute inset-0 rounded-full blur-2xl scale-110" style={{ background: "radial-gradient(circle, rgba(239, 190, 132, 0.2), transparent 70%)" }} />
                            <img
                              src={asterNinjaBlue}
                              alt="Ninja Trader Omega"
                              className="relative w-40 h-40 xl:w-52 xl:h-52 object-contain"
                              style={{ filter: "drop-shadow(0 0 25px rgba(239, 190, 132, 0.35))" }}
                              data-testid="img-ninja-blue"
                            />
                            <motion.div
                              className="absolute -bottom-2 left-1/2 -translate-x-1/2 text-[10px] font-mono font-bold px-3 py-1 rounded-full tracking-wider whitespace-nowrap"
                              style={{ background: "#EFBE84", color: "#050505", boxShadow: "0 4px 15px rgba(239, 190, 132, 0.3)" }}
                              animate={{ y: [0, -3, 0] }}
                              transition={{ duration: 2, repeat: Infinity, delay: 1 }}
                            >
                              TEAM OMEGA
                            </motion.div>
                          </div>
                        </motion.div>
                      </div>

                      <div className="hidden lg:flex items-center justify-center mt-4">
                        <div className="flex items-center gap-4 text-[11px] font-mono" style={{ color: "#747474" }}>
                          <span className="flex items-center gap-1.5"><TrendingUp className="w-3 h-3" style={{ color: "#42CF71" }} />Live PnL Tracking</span>
                          <span style={{ color: "#343434" }}>|</span>
                          <span className="flex items-center gap-1.5"><Shield className="w-3 h-3" style={{ color: "#42CF71" }} />Non-Custodial</span>
                          <span style={{ color: "#343434" }}>|</span>
                          <span className="flex items-center gap-1.5"><Zap className="w-3 h-3" style={{ color: "#EFBE84" }} />Auto-Updated Stats</span>
                          <span style={{ color: "#343434" }}>|</span>
                          <span className="flex items-center gap-1.5"><Users className="w-3 h-3" style={{ color: "#42CF71" }} />Referral Bonuses</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </Card>
            </motion.div>
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
                        { tag: "MODEL", text: "meta-llama/Llama-3.3-70B-Instruct" },
                        { tag: "FALLBACK", text: "akash/DeepSeek-V3" },
                        { tag: "COST", text: "0.0001 BNB/request" },
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

        {/* Developer Platform Section */}
        <section className="relative z-10 py-16 sm:py-24">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 space-y-12">
            <div className="text-center space-y-4">
              <Badge variant="secondary" className="font-mono text-[10px] px-4 py-1">AI AGENT DEVELOPMENT PLATFORM</Badge>
              <h2 className="font-mono text-2xl sm:text-3xl font-bold">
                Build on BUILD<span className="text-primary">4</span>
              </h2>
              <p className="font-mono text-sm text-muted-foreground max-w-lg mx-auto">
                A full platform for developers and creators to build, deploy, and monetize autonomous AI agents. No infrastructure needed.
              </p>
            </div>

            <Link href="/build">
              <Card className="max-w-2xl mx-auto p-8 space-y-5 hover:shadow-lg hover:border-emerald-500/30 transition-all cursor-pointer" data-testid="card-builder-cta">
                <div className="flex items-center gap-4">
                  <div className="w-14 h-14 rounded-xl bg-emerald-500/10 flex items-center justify-center">
                    <Bot className="w-7 h-7 text-emerald-500" />
                  </div>
                  <div>
                    <h3 className="font-mono text-lg font-bold">Agent Builder</h3>
                    <p className="font-mono text-xs text-muted-foreground mt-1">
                      Describe what you want. BUILD4 creates it.
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="p-3 rounded-lg bg-muted/30 text-center">
                    <Rocket className="w-4 h-4 mx-auto text-emerald-500 mb-1" />
                    <div className="font-mono text-[10px] font-semibold">Build</div>
                    <div className="font-mono text-[9px] text-muted-foreground">Chat-driven creation</div>
                  </div>
                  <div className="p-3 rounded-lg bg-muted/30 text-center">
                    <Globe className="w-4 h-4 mx-auto text-cyan-500 mb-1" />
                    <div className="font-mono text-[10px] font-semibold">Browse & Fork</div>
                    <div className="font-mono text-[9px] text-muted-foreground">Community agents</div>
                  </div>
                  <div className="p-3 rounded-lg bg-muted/30 text-center">
                    <Code className="w-4 h-4 mx-auto text-violet-500 mb-1" />
                    <div className="font-mono text-[10px] font-semibold">SDK & API</div>
                    <div className="font-mono text-[9px] text-muted-foreground">Developer docs</div>
                  </div>
                </div>
                <div className="flex items-center justify-center gap-1 text-emerald-500 font-mono text-sm font-semibold">
                  Open Builder <ArrowRight className="w-4 h-4" />
                </div>
              </Card>
            </Link>
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
              <span>Base · BNB Chain · XLayer</span>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
