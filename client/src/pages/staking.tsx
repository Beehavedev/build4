import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link } from "wouter";
import { SEO } from "@/components/seo";
import {
  ArrowLeft, Terminal, Lock, Unlock, TrendingUp,
  Clock, Coins, Users, BarChart3, Wallet, Zap,
  Shield, Gift, Timer, ArrowRight, CheckCircle2,
} from "lucide-react";

const LOCK_TIERS = [
  { days: 7, label: "7 Days", multiplier: "1x", apy: "12%", color: "border-zinc-500", active: "border-zinc-400 bg-zinc-500/10" },
  { days: 30, label: "30 Days", multiplier: "1.25x", apy: "15%", color: "border-blue-500", active: "border-blue-400 bg-blue-500/10" },
  { days: 90, label: "90 Days", multiplier: "1.75x", apy: "21%", color: "border-cyan-500", active: "border-cyan-400 bg-cyan-500/10" },
  { days: 180, label: "180 Days", multiplier: "2.5x", apy: "30%", color: "border-purple-500", active: "border-purple-400 bg-purple-500/10" },
  { days: 365, label: "365 Days", multiplier: "4x", apy: "48%", color: "border-primary", active: "border-primary bg-primary/10" },
];

const TOKEN_NOT_LAUNCHED = true;

export default function StakingPage() {
  const [selectedTier, setSelectedTier] = useState(2);
  const [stakeAmount, setStakeAmount] = useState("");

  const tier = LOCK_TIERS[selectedTier];

  return (
    <>
      <SEO
        title="Stake $BUILD4 | BUILD4"
        description="Stake $BUILD4 tokens to earn rewards. Lock longer for higher multipliers. Up to 4x rewards with 365-day lock."
        path="/staking"
      />

      <div className="min-h-screen bg-background" data-testid="page-staking">
        <header className="border-b sticky top-0 z-40 bg-background/95 backdrop-blur">
          <div className="max-w-5xl mx-auto px-4 sm:px-6">
            <div className="flex items-center justify-between h-14">
              <div className="flex items-center gap-3">
                <Link href="/token">
                  <Button variant="ghost" size="icon" className="h-8 w-8" data-testid="button-back-token">
                    <ArrowLeft className="w-4 h-4" />
                  </Button>
                </Link>
                <div className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-primary" />
                  <span className="font-mono font-bold text-sm tracking-wider">BUILD<span className="text-primary">4</span></span>
                  <span className="text-muted-foreground font-mono text-xs hidden md:inline ml-1">/ Staking</span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Link href="/token">
                  <Button variant="outline" size="sm" className="font-mono text-xs gap-1.5 h-8 px-3" data-testid="button-tokenomics">
                    <Coins className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Tokenomics</span>
                  </Button>
                </Link>
              </div>
            </div>
          </div>
        </header>

        <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-8">

          <div className="text-center space-y-4 py-4" data-testid="staking-hero">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border bg-primary/5 border-primary/20">
              <Lock className="w-4 h-4 text-primary" />
              <span className="font-mono text-xs text-primary font-semibold">STAKING</span>
            </div>
            <h1 className="font-mono text-3xl sm:text-4xl font-bold tracking-tight">
              Stake <span className="text-primary">$BUILD4</span>
            </h1>
            <p className="font-mono text-sm text-muted-foreground max-w-lg mx-auto">
              Lock your tokens to earn a share of platform revenue. Longer locks earn higher rewards through multiplier tiers.
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4" data-testid="staking-stats">
            <Card className="p-4 text-center space-y-1">
              <Coins className="w-5 h-5 mx-auto text-primary" />
              <div className="font-mono text-xl font-bold" data-testid="text-total-staked">0</div>
              <div className="font-mono text-[10px] text-muted-foreground">Total Staked</div>
            </Card>
            <Card className="p-4 text-center space-y-1">
              <Users className="w-5 h-5 mx-auto text-cyan-500" />
              <div className="font-mono text-xl font-bold" data-testid="text-total-stakers">0</div>
              <div className="font-mono text-[10px] text-muted-foreground">Stakers</div>
            </Card>
            <Card className="p-4 text-center space-y-1">
              <Gift className="w-5 h-5 mx-auto text-emerald-500" />
              <div className="font-mono text-xl font-bold" data-testid="text-rewards-distributed">0</div>
              <div className="font-mono text-[10px] text-muted-foreground">Rewards Paid</div>
            </Card>
            <Card className="p-4 text-center space-y-1">
              <TrendingUp className="w-5 h-5 mx-auto text-amber-500" />
              <div className="font-mono text-xl font-bold" data-testid="text-current-apy">{tier.apy}</div>
              <div className="font-mono text-[10px] text-muted-foreground">Current APY</div>
            </Card>
          </div>

          {TOKEN_NOT_LAUNCHED && (
            <Card className="p-6 border-dashed border-amber-500/30 bg-amber-500/5" data-testid="token-not-launched-notice">
              <div className="flex items-start gap-3">
                <Timer className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-mono text-sm font-bold text-amber-500">Token Not Yet Launched</div>
                  <p className="font-mono text-xs text-muted-foreground mt-1">
                    $BUILD4 has not launched yet. Staking will be available immediately after the token launches on Four.meme (BNB Chain) and Flap.sh (XLayer). The staking contract is deployed and ready.
                  </p>
                </div>
              </div>
            </Card>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">

            <div className="lg:col-span-3 space-y-6">
              <Card className="p-6 space-y-5" data-testid="staking-form">
                <div className="flex items-center gap-2">
                  <Lock className="w-5 h-5 text-primary" />
                  <h2 className="font-mono text-base font-bold">Stake Tokens</h2>
                </div>

                <div className="space-y-3">
                  <div className="font-mono text-xs text-muted-foreground">Select Lock Period</div>
                  <div className="grid grid-cols-5 gap-2" data-testid="lock-tier-selector">
                    {LOCK_TIERS.map((t, i) => (
                      <button
                        key={t.days}
                        onClick={() => setSelectedTier(i)}
                        className={`p-3 rounded-lg border-2 text-center transition-all cursor-pointer ${
                          selectedTier === i ? t.active : "border-border hover:border-muted-foreground/30"
                        }`}
                        data-testid={`button-tier-${t.days}`}
                      >
                        <div className="font-mono text-xs font-bold">{t.label}</div>
                        <div className="font-mono text-[10px] text-muted-foreground mt-1">{t.multiplier}</div>
                        <div className="font-mono text-[10px] text-primary font-semibold mt-0.5">{t.apy}</div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs text-muted-foreground">Amount to Stake</span>
                    <span className="font-mono text-[10px] text-muted-foreground">Balance: 0 BUILD4</span>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      placeholder="0.00"
                      value={stakeAmount}
                      onChange={(e) => setStakeAmount(e.target.value)}
                      className="font-mono"
                      disabled={TOKEN_NOT_LAUNCHED}
                      data-testid="input-stake-amount"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="font-mono text-xs px-3"
                      disabled={TOKEN_NOT_LAUNCHED}
                      onClick={() => setStakeAmount("0")}
                      data-testid="button-max-stake"
                    >
                      MAX
                    </Button>
                  </div>
                </div>

                <div className="space-y-2 p-4 rounded-lg bg-muted/50">
                  <div className="flex justify-between font-mono text-xs">
                    <span className="text-muted-foreground">Lock Period</span>
                    <span className="font-semibold">{tier.label}</span>
                  </div>
                  <div className="flex justify-between font-mono text-xs">
                    <span className="text-muted-foreground">Reward Multiplier</span>
                    <span className="font-semibold text-primary">{tier.multiplier}</span>
                  </div>
                  <div className="flex justify-between font-mono text-xs">
                    <span className="text-muted-foreground">Estimated APY</span>
                    <span className="font-semibold text-emerald-500">{tier.apy}</span>
                  </div>
                  <div className="flex justify-between font-mono text-xs">
                    <span className="text-muted-foreground">Estimated Earnings</span>
                    <span className="font-semibold">
                      {stakeAmount && parseFloat(stakeAmount) > 0
                        ? `${(parseFloat(stakeAmount) * parseFloat(tier.apy) / 100 * tier.days / 365).toFixed(2)} BUILD4`
                        : "0 BUILD4"}
                    </span>
                  </div>
                </div>

                <Button
                  className="w-full font-mono text-sm gap-2"
                  disabled={TOKEN_NOT_LAUNCHED || !stakeAmount || parseFloat(stakeAmount) <= 0}
                  data-testid="button-stake"
                >
                  <Lock className="w-4 h-4" />
                  {TOKEN_NOT_LAUNCHED ? "Staking Opens After Launch" : "Stake BUILD4"}
                </Button>
              </Card>

              <Card className="p-6 space-y-4" data-testid="your-stake">
                <div className="flex items-center gap-2">
                  <Wallet className="w-5 h-5 text-primary" />
                  <h2 className="font-mono text-base font-bold">Your Stake</h2>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 rounded-lg bg-muted/50 space-y-1">
                    <div className="font-mono text-[10px] text-muted-foreground">Staked Amount</div>
                    <div className="font-mono text-lg font-bold" data-testid="text-user-staked">0 BUILD4</div>
                  </div>
                  <div className="p-4 rounded-lg bg-muted/50 space-y-1">
                    <div className="font-mono text-[10px] text-muted-foreground">Pending Rewards</div>
                    <div className="font-mono text-lg font-bold text-emerald-500" data-testid="text-user-rewards">0 BUILD4</div>
                  </div>
                  <div className="p-4 rounded-lg bg-muted/50 space-y-1">
                    <div className="font-mono text-[10px] text-muted-foreground">Lock Ends</div>
                    <div className="font-mono text-sm font-bold" data-testid="text-lock-end">No active stake</div>
                  </div>
                  <div className="p-4 rounded-lg bg-muted/50 space-y-1">
                    <div className="font-mono text-[10px] text-muted-foreground">Your Multiplier</div>
                    <div className="font-mono text-lg font-bold text-primary" data-testid="text-user-multiplier">0x</div>
                  </div>
                </div>

                <div className="flex gap-3">
                  <Button
                    variant="outline"
                    className="flex-1 font-mono text-xs gap-1.5"
                    disabled={true}
                    data-testid="button-claim-rewards"
                  >
                    <Gift className="w-3.5 h-3.5" /> Claim Rewards
                  </Button>
                  <Button
                    variant="outline"
                    className="flex-1 font-mono text-xs gap-1.5"
                    disabled={true}
                    data-testid="button-unstake"
                  >
                    <Unlock className="w-3.5 h-3.5" /> Unstake
                  </Button>
                </div>
              </Card>
            </div>

            <div className="lg:col-span-2 space-y-6">
              <Card className="p-6 space-y-4" data-testid="how-it-works">
                <div className="flex items-center gap-2">
                  <Zap className="w-5 h-5 text-primary" />
                  <h2 className="font-mono text-base font-bold">How It Works</h2>
                </div>

                <div className="space-y-4">
                  <div className="flex items-start gap-3">
                    <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <span className="font-mono text-xs font-bold text-primary">1</span>
                    </div>
                    <div>
                      <div className="font-mono text-xs font-semibold">Stake $BUILD4</div>
                      <p className="font-mono text-[10px] text-muted-foreground mt-0.5">
                        Deposit your tokens and choose a lock period from 7 to 365 days.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <span className="font-mono text-xs font-bold text-primary">2</span>
                    </div>
                    <div>
                      <div className="font-mono text-xs font-semibold">Earn Rewards</div>
                      <p className="font-mono text-[10px] text-muted-foreground mt-0.5">
                        30% of all platform fees are used to buy back $BUILD4. Half goes to stakers as rewards.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <span className="font-mono text-xs font-bold text-primary">3</span>
                    </div>
                    <div>
                      <div className="font-mono text-xs font-semibold">Multiplier Boost</div>
                      <p className="font-mono text-[10px] text-muted-foreground mt-0.5">
                        Longer locks earn higher multipliers. A 365 day lock gets 4x the base reward rate.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <span className="font-mono text-xs font-bold text-primary">4</span>
                    </div>
                    <div>
                      <div className="font-mono text-xs font-semibold">Claim or Unstake</div>
                      <p className="font-mono text-[10px] text-muted-foreground mt-0.5">
                        Claim rewards anytime. Unstake after your lock period ends to withdraw everything.
                      </p>
                    </div>
                  </div>
                </div>
              </Card>

              <Card className="p-6 space-y-4" data-testid="reward-tiers">
                <div className="flex items-center gap-2">
                  <BarChart3 className="w-5 h-5 text-primary" />
                  <h2 className="font-mono text-base font-bold">Reward Tiers</h2>
                </div>

                <div className="space-y-2">
                  {LOCK_TIERS.map((t) => (
                    <div key={t.days} className="flex items-center justify-between p-3 rounded-lg bg-muted/30">
                      <div className="flex items-center gap-2">
                        <Clock className="w-3.5 h-3.5 text-muted-foreground" />
                        <span className="font-mono text-xs">{t.label}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <Badge variant="secondary" className="font-mono text-[10px]">{t.multiplier}</Badge>
                        <span className="font-mono text-xs font-bold text-emerald-500">{t.apy}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>

              <Card className="p-6 space-y-4" data-testid="revenue-source">
                <div className="flex items-center gap-2">
                  <Shield className="w-5 h-5 text-primary" />
                  <h2 className="font-mono text-base font-bold">Revenue Sources</h2>
                </div>

                <div className="space-y-2 font-mono text-xs">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                    <span>Agent creation fees</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                    <span>Skill marketplace commissions</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                    <span>Agent hire fees (20%)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                    <span>Inference request fees</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                    <span>Bounty completion fees</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                    <span>Token launch fees</span>
                  </div>
                </div>

                <p className="font-mono text-[10px] text-muted-foreground">
                  30% of all platform fees buy back $BUILD4. 50% of buyback is burned. 50% goes to staking rewards.
                </p>
              </Card>
            </div>
          </div>

          <Card className="p-6 space-y-4" data-testid="staking-contract-info">
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-primary" />
              <h2 className="font-mono text-base font-bold">Contract Security</h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-mono text-xs font-semibold">Reentrancy Protected</div>
                  <p className="font-mono text-[10px] text-muted-foreground">OpenZeppelin ReentrancyGuard on all state-changing functions</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-mono text-xs font-semibold">Time-Locked Withdrawals</div>
                  <p className="font-mono text-[10px] text-muted-foreground">Tokens cannot be withdrawn before lock period ends</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-mono text-xs font-semibold">Open Source</div>
                  <p className="font-mono text-[10px] text-muted-foreground">Contract code is fully verified and open source on-chain</p>
                </div>
              </div>
            </div>
          </Card>

          <footer className="text-center py-6 border-t">
            <div className="flex items-center justify-center gap-2 mb-2">
              <Terminal className="w-4 h-4 text-primary" />
              <span className="font-mono font-bold text-sm">BUILD<span className="text-primary">4</span></span>
            </div>
            <p className="font-mono text-[11px] text-muted-foreground">
              Stake $BUILD4 to earn platform revenue. Longer locks earn higher rewards.
            </p>
          </footer>
        </main>
      </div>
    </>
  );
}
