import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { useT } from "@/lib/i18n";
import { LanguageSwitcher } from "@/components/language-switcher";
import { SEO } from "@/components/seo";
import {
  ArrowLeft, Terminal, Coins, Flame, Lock, TrendingUp,
  Users, Briefcase, Shield, BarChart3, Rocket, Gift,
  RefreshCw, Vote, Zap, Star, Wallet,
  PieChart, ArrowRight, DollarSign, Layers,
} from "lucide-react";

const TICKER = "$BUILD4";

const ALLOC_META = [
  { id: "founder", pct: 70, amount: "700,000,000", bgColor: "bg-primary", bgTint: "bg-primary/15", textColor: "text-primary", icon: Lock, labelKey: "allocFounder", noteKey: "allocFounderNote" },
  { id: "lp", pct: 10, amount: "100,000,000", bgColor: "bg-cyan-500", bgTint: "bg-cyan-500/15", textColor: "text-cyan-500", icon: Flame, labelKey: "allocLp", noteKey: "allocLpNote" },
  { id: "public", pct: 20, amount: "200,000,000", bgColor: "bg-emerald-500", bgTint: "bg-emerald-500/15", textColor: "text-emerald-500", icon: Users, labelKey: "allocPublic", noteKey: "allocPublicNote" },
];

const DIST_META = [
  { id: "rewards", pct: 25, amount: "250,000,000", bgColor: "bg-blue-500", bgTint: "bg-blue-500/15", textColor: "text-blue-500", icon: Gift, labelKey: "distRewards", noteKey: "distRewardsNote" },
  { id: "treasury", pct: 20, amount: "200,000,000", bgColor: "bg-amber-500", bgTint: "bg-amber-500/15", textColor: "text-amber-500", icon: Shield, labelKey: "distTreasury", noteKey: "distTreasuryNote" },
  { id: "marketing", pct: 15, amount: "150,000,000", bgColor: "bg-pink-500", bgTint: "bg-pink-500/15", textColor: "text-pink-500", icon: Rocket, labelKey: "distMarketing", noteKey: "distMarketingNote" },
  { id: "reserve", pct: 10, amount: "100,000,000", bgColor: "bg-purple-500", bgTint: "bg-purple-500/15", textColor: "text-purple-500", icon: Lock, labelKey: "distReserve", noteKey: "distReserveNote" },
];

const UTIL_META = [
  { id: "discount", icon: DollarSign, titleKey: "utilDiscount", descKey: "utilDiscountDesc" },
  { id: "revenue", icon: BarChart3, titleKey: "utilRevenue", descKey: "utilRevenueDesc" },
  { id: "premium", icon: Star, titleKey: "utilPremium", descKey: "utilPremiumDesc" },
  { id: "boost", icon: Zap, titleKey: "utilBoost", descKey: "utilBoostDesc" },
  { id: "gov", icon: Vote, titleKey: "utilGov", descKey: "utilGovDesc" },
  { id: "burn", icon: Flame, titleKey: "utilBurn", descKey: "utilBurnDesc" },
];

export default function TokenPage() {
  const t = useT();

  const flywheel = [
    { step: "1", text: t("token.fly1"), sub: t("token.fly1sub") },
    { step: "2", text: t("token.fly2"), sub: t("token.fly2sub") },
    { step: "3", text: t("token.fly3"), sub: t("token.fly3sub") },
    { step: "4", text: t("token.fly4"), sub: t("token.fly4sub") },
    { step: "5", text: t("token.fly5"), sub: t("token.fly5sub") },
  ];

  return (
    <>
      <SEO
        title="$BUILD4 Token | BUILD4"
        description="$BUILD4 — the token powering decentralized AI agent infrastructure on Base. Fair launch. 1B supply."
        path="/token"
      />

      <div className="min-h-screen bg-background" data-testid="page-token">
        <header className="border-b sticky top-0 z-40 bg-background/95 backdrop-blur">
          <div className="max-w-5xl mx-auto px-4 sm:px-6">
            <div className="flex items-center justify-between h-14">
              <div className="flex items-center gap-3">
                <Link href="/">
                  <Button variant="ghost" size="icon" className="h-8 w-8" data-testid="button-back-home">
                    <ArrowLeft className="w-4 h-4" />
                  </Button>
                </Link>
                <div className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-primary" />
                  <span className="font-mono font-bold text-sm tracking-wider">BUILD<span className="text-primary">4</span></span>
                  <span className="text-muted-foreground font-mono text-xs hidden md:inline ml-1">/ {TICKER}</span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <LanguageSwitcher />
                <Link href="/hire-agent">
                  <Button variant="outline" size="sm" className="font-mono text-xs gap-1.5 h-8 px-3" data-testid="button-hire-agent">
                    <Briefcase className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">{t("token.hireAgent")}</span>
                  </Button>
                </Link>
                <Link href="/autonomous-economy">
                  <Button variant="outline" size="sm" className="font-mono text-xs gap-1.5 h-8 px-3" data-testid="button-dashboard">
                    <Terminal className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Dashboard</span>
                  </Button>
                </Link>
              </div>
            </div>
          </div>
        </header>

        <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-10">

          <div className="text-center space-y-4 py-6" data-testid="token-hero">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border bg-primary/5 border-primary/20">
              <Coins className="w-4 h-4 text-primary" />
              <span className="font-mono text-xs text-primary font-semibold">{t("token.chain")}</span>
            </div>
            <h1 className="font-mono text-4xl sm:text-5xl font-bold tracking-tight">
              <span className="text-primary">{t("token.title")}</span>
            </h1>
            <p className="font-mono text-sm text-muted-foreground max-w-xl mx-auto">
              {t("token.subtitle")}
            </p>
            <div className="flex items-center justify-center gap-3 pt-2">
              <Badge variant="secondary" className="font-mono text-xs gap-1.5 px-3 py-1">
                <PieChart className="w-3 h-3" /> {t("token.supplyBadge")}
              </Badge>
              <Badge variant="secondary" className="font-mono text-xs gap-1.5 px-3 py-1">
                <Rocket className="w-3 h-3" /> {t("token.fairLaunchBadge")}
              </Badge>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
            <Card className="p-5 text-center space-y-2" data-testid="stat-supply">
              <PieChart className="w-6 h-6 mx-auto text-primary" />
              <div className="font-mono text-lg font-bold">1B</div>
              <div className="font-mono text-[11px] text-muted-foreground">{t("token.statSupply")}</div>
            </Card>
            <Card className="p-5 text-center space-y-2" data-testid="stat-founder">
              <Lock className="w-6 h-6 mx-auto text-primary" />
              <div className="font-mono text-lg font-bold">70%</div>
              <div className="font-mono text-[11px] text-muted-foreground">{t("token.statFounder")}</div>
            </Card>
            <Card className="p-5 text-center space-y-2" data-testid="stat-lp">
              <Flame className="w-6 h-6 mx-auto text-cyan-500" />
              <div className="font-mono text-lg font-bold">10%</div>
              <div className="font-mono text-[11px] text-muted-foreground">{t("token.statLp")}</div>
            </Card>
            <Card className="p-5 text-center space-y-2" data-testid="stat-public">
              <Users className="w-6 h-6 mx-auto text-emerald-500" />
              <div className="font-mono text-lg font-bold">20%</div>
              <div className="font-mono text-[11px] text-muted-foreground">{t("token.statPublic")}</div>
            </Card>
            <Card className="p-5 text-center space-y-2 border-primary/20" data-testid="stat-base">
              <Layers className="w-6 h-6 mx-auto text-blue-500" />
              <div className="font-mono text-lg font-bold">Base</div>
              <div className="font-mono text-[11px] text-muted-foreground">ERC-20</div>
            </Card>
          </div>

          <div className="space-y-5" data-testid="section-tokenomics">
            <div className="flex items-center gap-2">
              <PieChart className="w-5 h-5 text-primary" />
              <h2 className="font-mono text-lg font-bold">{t("token.sectionTokenomics")}</h2>
            </div>

            <p className="font-mono text-xs text-muted-foreground">
              {t("token.tokenomicsDesc")}
            </p>

            <div className="w-full h-8 rounded-full overflow-hidden flex border" data-testid="tokenomics-bar">
              {ALLOC_META.map((a) => (
                <div
                  key={a.id}
                  className={`${a.bgColor} h-full relative group cursor-default`}
                  style={{ width: `${a.pct}%` }}
                  title={`${t(`token.${a.labelKey}`)}: ${a.pct}%`}
                >
                  {a.pct >= 10 && (
                    <span className="absolute inset-0 flex items-center justify-center font-mono text-[10px] text-white font-bold">
                      {a.pct}%
                    </span>
                  )}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {ALLOC_META.map((a) => {
                const Icon = a.icon;
                return (
                  <Card key={a.id} className="p-4 flex items-start gap-3" data-testid={`allocation-${a.id}`}>
                    <div className={`w-8 h-8 rounded-md ${a.bgTint} flex items-center justify-center flex-shrink-0`}>
                      <Icon className={`w-4 h-4 ${a.textColor}`} />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold">{t(`token.${a.labelKey}`)}</span>
                        <Badge variant="outline" className="text-[9px] font-mono">{a.pct}%</Badge>
                      </div>
                      <div className="font-mono text-xs text-primary mt-0.5">{a.amount} {TICKER}</div>
                      <p className="font-mono text-[11px] text-muted-foreground mt-1">{t(`token.${a.noteKey}`)}</p>
                    </div>
                  </Card>
                );
              })}
            </div>
          </div>

          <div className="space-y-5" data-testid="section-distribution">
            <div className="flex items-center gap-2">
              <Wallet className="w-5 h-5 text-primary" />
              <h2 className="font-mono text-lg font-bold">{t("token.sectionDistribution")}</h2>
            </div>

            <p className="font-mono text-xs text-muted-foreground">
              {t("token.distributionDesc")}
            </p>

            <div className="w-full h-6 rounded-full overflow-hidden flex border" data-testid="distribution-bar">
              {DIST_META.map((d) => (
                <div
                  key={d.id}
                  className={`${d.bgColor} h-full relative group cursor-default`}
                  style={{ width: `${(d.pct / 70) * 100}%` }}
                  title={`${t(`token.${d.labelKey}`)}: ${d.pct}%`}
                >
                  {d.pct >= 10 && (
                    <span className="absolute inset-0 flex items-center justify-center font-mono text-[9px] text-white font-bold">
                      {d.pct}%
                    </span>
                  )}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {DIST_META.map((d) => {
                const Icon = d.icon;
                return (
                  <Card key={d.id} className="p-4 flex items-start gap-3" data-testid={`dist-${d.id}`}>
                    <div className={`w-8 h-8 rounded-md ${d.bgTint} flex items-center justify-center flex-shrink-0`}>
                      <Icon className={`w-4 h-4 ${d.textColor}`} />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold">{t(`token.${d.labelKey}`)}</span>
                        <Badge variant="outline" className="text-[9px] font-mono">{d.pct}%</Badge>
                      </div>
                      <div className="font-mono text-xs text-primary mt-0.5">{d.amount} {TICKER}</div>
                      <p className="font-mono text-[11px] text-muted-foreground mt-1">{t(`token.${d.noteKey}`)}</p>
                    </div>
                  </Card>
                );
              })}
            </div>
          </div>

          <div className="space-y-5" data-testid="section-utility">
            <div className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-primary" />
              <h2 className="font-mono text-lg font-bold">{t("token.sectionUtility")}</h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {UTIL_META.map((u) => {
                const Icon = u.icon;
                return (
                  <Card key={u.id} className="p-4 space-y-3" data-testid={`utility-${u.id}`}>
                    <div className="flex items-center gap-2">
                      <div className="p-1.5 rounded-md bg-primary/10">
                        <Icon className="w-4 h-4 text-primary" />
                      </div>
                      <span className="font-mono text-sm font-semibold">{t(`token.${u.titleKey}`)}</span>
                    </div>
                    <p className="font-mono text-[11px] text-muted-foreground leading-relaxed">{t(`token.${u.descKey}`)}</p>
                  </Card>
                );
              })}
            </div>
          </div>

          <Card className="p-6 border-primary/20 bg-primary/5" data-testid="section-flywheel">
            <div className="flex items-center gap-2 mb-4">
              <RefreshCw className="w-5 h-5 text-primary" />
              <h2 className="font-mono text-lg font-bold">{t("token.sectionFlywheel")}</h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-5 gap-3 items-center">
              {flywheel.map((item, i) => (
                <div key={item.step} className="text-center space-y-1.5">
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center font-mono text-sm font-bold text-primary mx-auto">
                    {item.step}
                  </div>
                  <div className="font-mono text-xs font-semibold">{item.text}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">{item.sub}</div>
                  {i < 4 && <ArrowRight className="w-4 h-4 text-muted-foreground mx-auto hidden sm:block mt-1" />}
                </div>
              ))}
            </div>
          </Card>

          <div className="space-y-5" data-testid="section-transparency">
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-primary" />
              <h2 className="font-mono text-lg font-bold">{t("token.sectionTransparency")}</h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Card className="p-4 flex items-start gap-3">
                <Flame className="w-5 h-5 text-emerald-500 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-mono text-sm font-semibold">{t("token.transLp")}</div>
                  <p className="font-mono text-[11px] text-muted-foreground mt-1">{t("token.transLpDesc")}</p>
                </div>
              </Card>
              <Card className="p-4 flex items-start gap-3">
                <Wallet className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-mono text-sm font-semibold">{t("token.transWallets")}</div>
                  <p className="font-mono text-[11px] text-muted-foreground mt-1">{t("token.transWalletsDesc")}</p>
                </div>
              </Card>
              <Card className="p-4 flex items-start gap-3">
                <BarChart3 className="w-5 h-5 text-purple-500 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-mono text-sm font-semibold">{t("token.transReports")}</div>
                  <p className="font-mono text-[11px] text-muted-foreground mt-1">{t("token.transReportsDesc")}</p>
                </div>
              </Card>
            </div>
          </div>

          <div className="space-y-5" data-testid="section-contract">
            <div className="flex items-center gap-2">
              <Coins className="w-5 h-5 text-primary" />
              <h2 className="font-mono text-lg font-bold">{t("token.contractTitle")}</h2>
            </div>

            <Card className="p-5 text-center space-y-3 border-dashed max-w-md mx-auto">
              <div className="flex items-center justify-center gap-2">
                <Layers className="w-5 h-5 text-blue-500" />
                <span className="font-mono text-sm font-bold">Base Chain</span>
              </div>
              <Badge variant="outline" className="font-mono text-[10px]">ERC-20</Badge>
              <p className="font-mono text-xs text-muted-foreground">{t("token.contractSoon")}</p>
            </Card>

            <div className="flex items-center justify-center gap-3 pt-2">
              <Link href="/staking">
                <Button size="sm" className="font-mono text-xs gap-1.5" data-testid="button-stake-from-token">
                  <Lock className="w-3.5 h-3.5" /> Stake $BUILD4
                </Button>
              </Link>
              <Link href="/hire-agent">
                <Button size="sm" variant="outline" className="font-mono text-xs gap-1.5" data-testid="button-hire-from-token">
                  <Briefcase className="w-3.5 h-3.5" /> {t("token.hireAgent")}
                </Button>
              </Link>
            </div>
          </div>

          <footer className="text-center py-6 border-t">
            <div className="flex items-center justify-center gap-2 mb-2">
              <Terminal className="w-4 h-4 text-primary" />
              <span className="font-mono font-bold text-sm">BUILD<span className="text-primary">4</span></span>
            </div>
            <p className="font-mono text-[11px] text-muted-foreground">
              {t("token.footer")}
            </p>
          </footer>
        </main>
      </div>
    </>
  );
}
