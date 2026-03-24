import { useState } from "react";
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SEO } from "@/components/seo";
import { useToast } from "@/hooks/use-toast";
import { useWallet } from "@/hooks/use-wallet";
import { apiRequest } from "@/lib/queryClient";
import { useQuery } from "@tanstack/react-query";
import { WORKSPACE_PLANS } from "@shared/schema";
import type { PlanTier } from "@shared/schema";
import {
  CheckCircle2, ArrowLeft, Zap, Crown, Rocket,
  Loader2, ExternalLink, Terminal, Shield,
  ChevronRight, Star, Users, Bot,
} from "lucide-react";
import { ethers } from "ethers";

const PLAN_ORDER: PlanTier[] = ["free", "pro", "enterprise"];

const PLAN_ICONS: Record<PlanTier, typeof Zap> = {
  free: Rocket,
  pro: Zap,
  enterprise: Crown,
};

const PLAN_COLORS: Record<PlanTier, { border: string; bg: string; badge: string; button: string }> = {
  free: {
    border: "border-[#383838]",
    bg: "bg-[#1e1e1e]",
    badge: "bg-[#252526] text-[#cccccc]",
    button: "bg-[#383838] hover:bg-[#505050] text-white",
  },
  pro: {
    border: "border-emerald-500/30",
    bg: "bg-[#1e1e1e]",
    badge: "bg-emerald-500/10 text-emerald-400",
    button: "bg-emerald-600 hover:bg-emerald-500 text-white",
  },
  enterprise: {
    border: "border-amber-500/30",
    bg: "bg-[#1e1e1e]",
    badge: "bg-amber-500/10 text-amber-400",
    button: "bg-amber-600 hover:bg-amber-500 text-white",
  },
};

const TREASURY_WALLET = "0x5Ff57464152c9285A8526a0665d996dA66e2def1";

export default function Pricing() {
  const { address, signer, isConnected } = useWallet();
  const { toast } = useToast();
  const [upgrading, setUpgrading] = useState<PlanTier | null>(null);

  const { data: currentPlan, refetch } = useQuery({
    queryKey: ["/api/workspace/plan", address],
    queryFn: async () => {
      if (!address) return { plan: "free" as PlanTier };
      const resp = await fetch(`/api/workspace/plan/${address}`);
      return resp.json();
    },
    enabled: !!address,
  });

  const handleUpgrade = async (tier: PlanTier) => {
    if (!isConnected || !signer || !address) {
      toast({ title: "Connect Wallet", description: "Connect your wallet to upgrade", variant: "destructive" });
      return;
    }

    const plan = WORKSPACE_PLANS[tier];
    if (plan.price === "0") return;

    setUpgrading(tier);

    try {
      const tx = await signer.sendTransaction({
        to: TREASURY_WALLET,
        value: BigInt(plan.price),
      });

      toast({ title: "Transaction Sent", description: `Confirming ${plan.priceLabel} payment...` });

      await tx.wait();

      const resp = await apiRequest("POST", "/api/workspace/upgrade", {
        walletAddress: address,
        plan: tier,
        txHash: tx.hash,
      });

      const data = await resp.json();

      if (data.success) {
        toast({ title: "Upgraded!", description: `You're now on the ${plan.name} plan` });
        refetch();
      } else {
        toast({ title: "Error", description: data.error || "Upgrade failed", variant: "destructive" });
      }
    } catch (error: any) {
      if (error.code === "ACTION_REJECTED" || error.code === 4001) {
        toast({ title: "Cancelled", description: "Transaction was cancelled" });
      } else {
        toast({ title: "Error", description: error.message || "Payment failed", variant: "destructive" });
      }
    } finally {
      setUpgrading(null);
    }
  };

  const userPlan = (currentPlan?.plan || "free") as PlanTier;

  return (
    <>
      <SEO title="Pricing | BUILD4" description="Choose the right plan for building AI agents." path="/pricing" />

      <div className="min-h-screen bg-[#0a0a0a] text-[#cccccc]" data-testid="page-pricing">
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
                  <span className="font-mono text-xs text-[#858585]">Pricing</span>
                </div>
              </div>
              <Link href="/build">
                <Button size="sm" className="gap-1 h-7 px-3 bg-emerald-600 hover:bg-emerald-500 text-white font-mono text-[10px]" data-testid="button-go-build">
                  <Rocket className="w-3 h-3" /> Open Workspace
                </Button>
              </Link>
            </div>
          </div>
        </header>

        <div className="max-w-5xl mx-auto px-4 py-12 sm:py-20">
          <div className="text-center space-y-4 mb-12">
            <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 font-mono text-[10px]">
              WORKSPACE PLANS
            </Badge>
            <h1 className="font-mono text-2xl sm:text-4xl font-bold text-white">
              Build AI agents at any scale
            </h1>
            <p className="font-mono text-sm text-[#858585] max-w-lg mx-auto">
              Start free. Pay with BNB when you need more power. All plans include the full IDE workspace, AI assistant, and on-chain deployment.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6 mb-16" data-testid="pricing-cards">
            {PLAN_ORDER.map((tier) => {
              const plan = WORKSPACE_PLANS[tier];
              const colors = PLAN_COLORS[tier];
              const Icon = PLAN_ICONS[tier];
              const isCurrent = userPlan === tier;
              const isPopular = tier === "pro";

              return (
                <Card key={tier} className={`relative p-5 sm:p-6 ${colors.bg} ${colors.border} border-2 ${isPopular ? "ring-1 ring-emerald-500/20" : ""} flex flex-col`}
                  data-testid={`plan-${tier}`}>
                  {isPopular && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                      <Badge className="bg-emerald-600 text-white font-mono text-[9px] px-3">MOST POPULAR</Badge>
                    </div>
                  )}

                  <div className="flex items-center gap-2 mb-3">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${tier === "pro" ? "bg-emerald-500/10" : tier === "enterprise" ? "bg-amber-500/10" : "bg-[#252526]"}`}>
                      <Icon className={`w-4 h-4 ${tier === "pro" ? "text-emerald-400" : tier === "enterprise" ? "text-amber-400" : "text-[#858585]"}`} />
                    </div>
                    <div>
                      <div className="font-mono text-sm font-bold text-white">{plan.name}</div>
                    </div>
                  </div>

                  <div className="mb-4">
                    <div className="flex items-baseline gap-1.5">
                      <span className="font-mono text-2xl sm:text-3xl font-bold text-white">{plan.priceLabel}</span>
                      {"priceFiat" in plan && (
                        <span className="font-mono text-xs text-[#505050]">≈ {plan.priceFiat}</span>
                      )}
                    </div>
                    {tier !== "free" && (
                      <div className="font-mono text-[10px] text-[#505050] mt-0.5">per 30 days</div>
                    )}
                  </div>

                  <div className="space-y-2 flex-1 mb-5">
                    {plan.features.map((feature, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <CheckCircle2 className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${tier === "pro" ? "text-emerald-400" : tier === "enterprise" ? "text-amber-400" : "text-[#505050]"}`} />
                        <span className="font-mono text-[11px] text-[#cccccc]">{feature}</span>
                      </div>
                    ))}
                  </div>

                  {isCurrent ? (
                    <Button disabled className="w-full font-mono text-[11px] h-9 bg-[#252526] text-[#858585]" data-testid={`button-current-${tier}`}>
                      <CheckCircle2 className="w-3 h-3 mr-1" /> Current Plan
                    </Button>
                  ) : tier === "free" ? (
                    <Link href="/build">
                      <Button className={`w-full font-mono text-[11px] h-9 ${colors.button}`} data-testid={`button-start-free`}>
                        Get Started Free
                      </Button>
                    </Link>
                  ) : (
                    <Button onClick={() => handleUpgrade(tier)}
                      disabled={!!upgrading || (tier === "pro" && userPlan === "enterprise")}
                      className={`w-full font-mono text-[11px] h-9 ${colors.button}`}
                      data-testid={`button-upgrade-${tier}`}>
                      {upgrading === tier ? (
                        <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Processing...</>
                      ) : !isConnected ? (
                        "Connect Wallet to Upgrade"
                      ) : (
                        `Upgrade — ${plan.priceLabel}`
                      )}
                    </Button>
                  )}
                </Card>
              );
            })}
          </div>

          <div className="max-w-3xl mx-auto space-y-8">
            <div className="text-center">
              <h2 className="font-mono text-lg font-bold text-white mb-2">Compare Plans</h2>
              <p className="font-mono text-[11px] text-[#505050]">All plans include the full IDE workspace and AI-powered agent builder</p>
            </div>

            <div className="border border-[#252526] rounded-lg overflow-hidden" data-testid="comparison-table">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[#252526] bg-[#141414]">
                    <th className="text-left font-mono text-[10px] text-[#858585] p-3 uppercase tracking-wider">Feature</th>
                    {PLAN_ORDER.map(tier => (
                      <th key={tier} className="text-center font-mono text-[10px] text-[#858585] p-3 uppercase tracking-wider">
                        {WORKSPACE_PLANS[tier].name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { label: "Agent Workspaces", values: ["1", "10", "Unlimited"] },
                    { label: "Deploys / Month", values: ["2", "50", "Unlimited"] },
                    { label: "AI Chat Credits", values: ["50", "2,000", "Unlimited"] },
                    { label: "Supported Chains", values: ["BNB Chain", "All 3 chains", "All 3 chains"] },
                    { label: "Templates", values: ["Community", "All", "All + Custom"] },
                    { label: "Agent Forking", values: ["—", "✓", "✓"] },
                    { label: "Priority Inference", values: ["—", "✓", "✓"] },
                    { label: "Dedicated Node", values: ["—", "—", "Coming Soon"] },
                    { label: "Custom Skills SDK", values: ["—", "—", "Coming Soon"] },
                    { label: "White-label", values: ["—", "—", "Coming Soon"] },
                    { label: "Support", values: ["Community", "Standard", "Priority"] },
                  ].map((row, i) => (
                    <tr key={i} className="border-b border-[#1a1a1a]">
                      <td className="font-mono text-[11px] text-[#cccccc] p-3">{row.label}</td>
                      {row.values.map((val, j) => (
                        <td key={j} className={`text-center font-mono text-[11px] p-3 ${val === "✓" ? "text-emerald-400" : val === "—" ? "text-[#383838]" : "text-[#cccccc]"}`}>
                          {val}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[
                { icon: Shield, title: "Secure Payments", desc: "Pay directly on-chain with BNB. No credit cards, no intermediaries." },
                { icon: Bot, title: "Real Deployment", desc: "Agents get their own wallet, on-chain identity, and live runtime." },
                { icon: Users, title: "Cancel Anytime", desc: "No lock-in. Your agents keep running even after your plan expires." },
              ].map((item, i) => (
                <div key={i} className="p-4 rounded-lg border border-[#252526] bg-[#141414] text-center space-y-2">
                  <item.icon className="w-5 h-5 mx-auto text-emerald-400" />
                  <div className="font-mono text-xs font-bold text-white">{item.title}</div>
                  <p className="font-mono text-[10px] text-[#858585] leading-relaxed">{item.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        <footer className="border-t border-[#252526] py-6">
          <div className="max-w-5xl mx-auto px-4 flex items-center justify-between">
            <span className="font-mono text-[10px] text-[#383838]">BUILD4 — Autonomous AI Agent Economy</span>
            <span className="font-mono text-[10px] text-[#383838]">Payments in BNB on BNB Chain</span>
          </div>
        </footer>
      </div>
    </>
  );
}
