import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SEO } from "@/components/seo";
import {
  ArrowLeft, Terminal, ChevronRight,
  Zap, Shield, Brain, Rocket, TrendingUp,
  Wallet, BarChart3, Bot, Eye, ArrowLeftRight,
  Sparkles, Lock, Globe, CheckCircle2, ExternalLink,
  MessageSquare, Search, Flame, Coins, Target
} from "lucide-react";

const FEATURES = [
  {
    icon: TrendingUp,
    title: "Smart Money Signals",
    desc: "Real-time alerts from whale wallets, smart money, and KOL traders across Base, BNB Chain, Ethereum, and Solana. See exactly what the top traders are buying before everyone else.",
    premium: true,
  },
  {
    icon: Zap,
    title: "Instant Buy & Sell",
    desc: "One-tap trading directly from signal alerts. Select token, pick your amount, confirm — trade executes in seconds via OKX DEX aggregator with best-price routing.",
    premium: true,
  },
  {
    icon: Shield,
    title: "Security Scanner",
    desc: "4-tier deep scan: GoPlus risk analysis, Honeypot.is live simulation, RugCheck (Solana), and OKX market data. Detects honeypots, hidden taxes, mint/freeze authority, and rug risks before you buy.",
    premium: true,
  },
  {
    icon: ArrowLeftRight,
    title: "Cross-Chain Swap & Bridge",
    desc: "Swap any token pair and bridge assets across Base, BNB Chain, Ethereum, Solana, and more — all without leaving Telegram. Powered by OKX aggregator for optimal rates.",
    premium: true,
  },
  {
    icon: Flame,
    title: "Trending & Meme Scanner",
    desc: "Discover trending tokens and meme coins in real-time. Track market momentum, new listings, and viral tokens before they explode across multiple chains.",
    premium: true,
  },
  {
    icon: Brain,
    title: "Autonomous Trading Agent",
    desc: "AI-powered agent that trades autonomously on your behalf. Dynamic buy/sell decisions, trailing stop-loss, adaptive position sizing, multi-whale copy trading, and anti-repeat-loss intelligence.",
    premium: true,
  },
  {
    icon: Rocket,
    title: "Token Launcher",
    desc: "Deploy your own token in minutes. One-command launch on Flap.sh, Four.meme, and Base. Auto-generates logos, registers AI Agent badges, and includes Chaos Engine marketing.",
    premium: true,
  },
  {
    icon: BarChart3,
    title: "Token Price Lookup",
    desc: "Instant price checks for any token on any chain. Real-time data from OKX with market cap, volume, and price change information.",
    premium: true,
  },
  {
    icon: Wallet,
    title: "Multi-Wallet Management",
    desc: "Generate EVM and Solana wallets, check balances, manage multiple wallets. Private keys encrypted and auto-deleted after 30 seconds for maximum security.",
    premium: false,
  },
  {
    icon: Bot,
    title: "AI Agent Builder",
    desc: "Create, deploy, and manage autonomous AI agents directly from Telegram. Give them tasks, personalities, and let them operate 24/7 with their own wallets.",
    premium: false,
  },
  {
    icon: Coins,
    title: "Gas Price Monitor",
    desc: "Real-time gas prices across all supported chains. Never overpay for transactions — check before you trade.",
    premium: false,
  },
];

const CHAINS = [
  { name: "BNB Chain", color: "text-yellow-400", bg: "bg-yellow-400/10" },
  { name: "Base", color: "text-blue-400", bg: "bg-blue-400/10" },
  { name: "Ethereum", color: "text-purple-400", bg: "bg-purple-400/10" },
  { name: "Solana", color: "text-green-400", bg: "bg-green-400/10" },
  { name: "XLayer", color: "text-orange-400", bg: "bg-orange-400/10" },
];

export default function TelegramBotPage() {
  return (
    <>
      <SEO title="Telegram Trading Bot | BUILD4" description="The most powerful Telegram trading bot. Smart money signals, instant buy/sell, security scanner, token launcher, and autonomous trading — all in one bot." path="/agentic_bot" />

      <div className="min-h-screen bg-[#0a0a0a] text-[#cccccc]" data-testid="page-telegram-bot">
        <header className="border-b border-[#252526] bg-[#0a0a0a]/95 backdrop-blur sticky top-0 z-40">
          <div className="max-w-5xl mx-auto px-4">
            <div className="flex items-center justify-between h-12">
              <div className="flex items-center gap-3">
                <Link href="/">
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-[#858585] hover:text-white hover:bg-[#252526]" data-testid="button-back">
                    <ArrowLeft className="w-3.5 h-3.5" />
                  </Button>
                </Link>
                <div className="flex items-center gap-1.5">
                  <Terminal className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="font-mono font-bold text-xs text-white">BUILD<span className="text-emerald-400">4</span></span>
                  <ChevronRight className="w-3 h-3 text-[#505050]" />
                  <span className="font-mono text-xs text-[#858585]">Telegram Bot</span>
                </div>
              </div>
              <Link href="/app" aria-label="Launch the BUILD4 dApp">
                <Button size="sm" className="gap-1 h-7 px-3 bg-emerald-600 hover:bg-emerald-500 text-white font-mono text-[10px]" data-testid="button-open-bot-header">
                  <MessageSquare className="w-3 h-3" /> Launch dApp
                </Button>
              </Link>
            </div>
          </div>
        </header>

        <section className="max-w-5xl mx-auto px-4 pt-16 pb-12 sm:pt-24 sm:pb-16">
          <div className="text-center space-y-5 max-w-3xl mx-auto">
            <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 font-mono text-[10px] tracking-wider">
              TELEGRAM TRADING BOT
            </Badge>
            <h1 className="font-mono text-3xl sm:text-5xl font-bold text-white leading-tight">
              Your entire crypto desk
              <br />
              <span className="text-emerald-400">inside Telegram</span>
            </h1>
            <p className="font-mono text-sm text-[#858585] max-w-2xl mx-auto leading-relaxed">
              Smart money signals, instant trading, security scanning, token launching, and an autonomous AI trading agent — all from a single Telegram bot. No browser needed. No app to install. Just tap and trade.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
              <Link href="/app" aria-label="Launch the BUILD4 dApp">
                <Button className="gap-2 px-6 h-10 bg-emerald-600 hover:bg-emerald-500 text-white font-mono text-xs" data-testid="button-open-bot-hero">
                  <MessageSquare className="w-4 h-4" /> Launch dApp
                  <ExternalLink className="w-3 h-3 opacity-50" />
                </Button>
              </Link>
              <div className="flex items-center gap-2 px-4 h-10 rounded-md border border-[#252526] bg-[#141414]">
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                <span className="font-mono text-xs text-[#cccccc]">4-day free trial included</span>
              </div>
            </div>
          </div>
        </section>

        <section className="max-w-5xl mx-auto px-4 pb-12">
          <div className="flex flex-wrap justify-center gap-2 mb-12">
            {CHAINS.map((chain) => (
              <div key={chain.name} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full ${chain.bg} border border-[#252526]`}>
                <Globe className={`w-3 h-3 ${chain.color}`} />
                <span className={`font-mono text-[10px] ${chain.color}`}>{chain.name}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="max-w-5xl mx-auto px-4 pb-16">
          <div className="text-center mb-10">
            <h2 className="font-mono text-xl sm:text-2xl font-bold text-white mb-2">Everything you need to trade</h2>
            <p className="font-mono text-xs text-[#505050]">One bot. Every chain. Every tool.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="features-grid">
            {FEATURES.map((feature, i) => (
              <Card key={i} className={`p-5 bg-[#141414] border-[#252526] hover:border-[#383838] transition-colors group`} data-testid={`feature-card-${i}`}>
                <div className="flex items-start gap-3 mb-3">
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${feature.premium ? "bg-emerald-500/10" : "bg-[#252526]"}`}>
                    <feature.icon className={`w-4 h-4 ${feature.premium ? "text-emerald-400" : "text-[#858585]"}`} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono text-sm font-bold text-white">{feature.title}</span>
                      {feature.premium ? (
                        <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 font-mono text-[8px] px-1.5 py-0">PRO</Badge>
                      ) : (
                        <Badge className="bg-[#252526] text-[#858585] border-[#383838] font-mono text-[8px] px-1.5 py-0">FREE</Badge>
                      )}
                    </div>
                    <p className="font-mono text-[11px] text-[#858585] leading-relaxed">{feature.desc}</p>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </section>

        <section className="max-w-5xl mx-auto px-4 pb-16">
          <div className="text-center mb-10">
            <h2 className="font-mono text-xl sm:text-2xl font-bold text-white mb-2">How it works</h2>
            <p className="font-mono text-xs text-[#505050]">From zero to trading in under 60 seconds</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            {[
              { step: "01", title: "Open the bot", desc: "Tap the button below or search @BUILD4_BOT on Telegram", icon: MessageSquare },
              { step: "02", title: "Create a wallet", desc: "Hit /start — your encrypted EVM wallet is generated instantly", icon: Wallet },
              { step: "03", title: "Explore free", desc: "Full access to all premium features for 4 days, no payment needed", icon: Eye },
              { step: "04", title: "Subscribe", desc: "Send $19.99 USDT to keep unlimited access. One tap to verify payment", icon: Sparkles },
            ].map((item, i) => (
              <div key={i} className="p-5 rounded-lg border border-[#252526] bg-[#141414] text-center space-y-3" data-testid={`step-${item.step}`}>
                <div className="font-mono text-2xl font-bold text-emerald-400/30">{item.step}</div>
                <item.icon className="w-5 h-5 mx-auto text-emerald-400" />
                <div className="font-mono text-xs font-bold text-white">{item.title}</div>
                <p className="font-mono text-[10px] text-[#858585] leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="max-w-3xl mx-auto px-4 pb-16">
          <Card className="p-8 sm:p-10 bg-[#141414] border-emerald-500/20 border-2 text-center" data-testid="pricing-card">
            <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 font-mono text-[10px] mb-4">
              SIMPLE PRICING
            </Badge>
            <h2 className="font-mono text-2xl sm:text-3xl font-bold text-white mb-2">$19.99<span className="text-lg text-[#858585]">/month</span></h2>
            <p className="font-mono text-xs text-[#505050] mb-6">Paid in USDT on BNB Chain or Base</p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-left max-w-lg mx-auto mb-8">
              {[
                "Smart money & whale signals",
                "Instant buy & sell trading",
                "4-tier security scanner",
                "Cross-chain swap & bridge",
                "Trending & meme scanner",
                "Autonomous trading agent",
                "Token launcher",
                "Token price lookups",
                "Multi-wallet management",
                "AI agent builder",
              ].map((feature, i) => (
                <div key={i} className="flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span className="font-mono text-[11px] text-[#cccccc]">{feature}</span>
                </div>
              ))}
            </div>

            <div className="flex flex-col items-center gap-3">
              <Link href="/app" aria-label="Launch the BUILD4 dApp">
                <Button className="gap-2 px-8 h-11 bg-emerald-600 hover:bg-emerald-500 text-white font-mono text-xs" data-testid="button-subscribe-cta">
                  <MessageSquare className="w-4 h-4" /> Launch dApp
                  <ExternalLink className="w-3 h-3 opacity-50" />
                </Button>
              </Link>
              <span className="font-mono text-[10px] text-[#505050]">No credit card needed. Cancel anytime.</span>
            </div>
          </Card>
        </section>

        <section className="max-w-5xl mx-auto px-4 pb-16">
          <div className="text-center mb-10">
            <h2 className="font-mono text-xl sm:text-2xl font-bold text-white mb-2">Why traders choose BUILD4</h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              {
                icon: Target,
                title: "Signal Intelligence",
                desc: "We track real whale wallets and smart money in real-time. When a top trader buys, you know instantly — and can one-tap copy the trade before the crowd moves.",
              },
              {
                icon: Shield,
                title: "Scan Before You Buy",
                desc: "Every token gets a 4-layer deep scan. Honeypot detection, hidden tax analysis, mint authority checks, and live contract simulation. If it's a rug, we'll tell you before you lose a cent.",
              },
              {
                icon: Brain,
                title: "AI That Learns",
                desc: "Our trading agent doesn't just execute — it learns from every trade. Adaptive position sizing, anti-repeat-loss memory, and dynamic risk management that gets smarter over time.",
              },
            ].map((item, i) => (
              <Card key={i} className="p-6 bg-[#141414] border-[#252526]" data-testid={`why-card-${i}`}>
                <item.icon className="w-6 h-6 text-emerald-400 mb-3" />
                <div className="font-mono text-sm font-bold text-white mb-2">{item.title}</div>
                <p className="font-mono text-[11px] text-[#858585] leading-relaxed">{item.desc}</p>
              </Card>
            ))}
          </div>
        </section>

        <section className="max-w-3xl mx-auto px-4 pb-16">
          <div className="text-center mb-8">
            <h2 className="font-mono text-xl sm:text-2xl font-bold text-white mb-2">Payment details</h2>
          </div>

          <div className="space-y-3">
            {[
              { q: "How do I pay?", a: "Tap 'Subscribe' inside the bot. You'll get the treasury wallet address. Send exactly $19.99 in USDT (BNB Chain BEP-20) or USDC (Base). Then tap 'I've Paid' and the bot verifies your payment on-chain automatically." },
              { q: "What's included in the free trial?", a: "Full access to every premium feature for 4 days. Signals, trading, scanning, launching — everything. No payment required to start." },
              { q: "What happens when my trial expires?", a: "Free features (wallet, gas prices, agents) keep working. Premium features (signals, trading, scanning, launching) require a $19.99/month subscription." },
              { q: "Can I pay from any wallet?", a: "Payment must come from your linked wallet inside the bot. This is how we verify ownership. One wallet = one subscription." },
              { q: "What chains does the bot support?", a: "Base, BNB Chain, Ethereum, Solana, and XLayer. Signals cover all chains. Trading and swaps work across all supported DEXes via OKX aggregator." },
            ].map((item, i) => (
              <Card key={i} className="p-4 bg-[#141414] border-[#252526]" data-testid={`faq-${i}`}>
                <div className="font-mono text-xs font-bold text-white mb-1.5">{item.q}</div>
                <p className="font-mono text-[10px] text-[#858585] leading-relaxed">{item.a}</p>
              </Card>
            ))}
          </div>
        </section>

        <section className="border-t border-[#252526] py-12">
          <div className="max-w-3xl mx-auto px-4 text-center space-y-4">
            <h2 className="font-mono text-lg font-bold text-white">Ready to trade smarter?</h2>
            <p className="font-mono text-xs text-[#505050]">Join thousands of traders using BUILD4 to stay ahead of the market.</p>
            <Link href="/app" aria-label="Launch the BUILD4 dApp">
              <Button className="gap-2 px-8 h-10 bg-emerald-600 hover:bg-emerald-500 text-white font-mono text-xs mt-2" data-testid="button-final-cta">
                <MessageSquare className="w-4 h-4" /> Launch dApp
                <ExternalLink className="w-3 h-3 opacity-50" />
              </Button>
            </Link>
          </div>
        </section>

        <footer className="border-t border-[#252526] py-6">
          <div className="max-w-5xl mx-auto px-4 flex items-center justify-between">
            <span className="font-mono text-[10px] text-[#383838]">BUILD4 — Autonomous AI Agent Economy</span>
            <span className="font-mono text-[10px] text-[#383838]">$19.99/mo in USDT</span>
          </div>
        </footer>
      </div>
    </>
  );
}
