import { useState, useEffect, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link } from "wouter";
import { SEO } from "@/components/seo";
import { useWallet } from "@/hooks/use-wallet";
import { WalletConnector } from "@/components/wallet-connector";
import { BUILD4StakingABI } from "@/contracts/web4";
import { Contract, formatUnits, parseUnits } from "ethers";
import {
  ArrowLeft, Terminal, Lock, Unlock, TrendingUp,
  Clock, Coins, Users, BarChart3, Wallet, Zap,
  Shield, Gift, ArrowRight, CheckCircle2, ExternalLink, Loader2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const LOCK_TIERS = [
  { days: 7, label: "7 Days", multiplier: "1x", color: "border-zinc-500", active: "border-zinc-400 bg-zinc-500/10", seconds: 604800 },
  { days: 30, label: "30 Days", multiplier: "1.25x", color: "border-blue-500", active: "border-blue-400 bg-blue-500/10", seconds: 2592000 },
  { days: 90, label: "90 Days", multiplier: "1.75x", color: "border-cyan-500", active: "border-cyan-400 bg-cyan-500/10", seconds: 7776000 },
  { days: 180, label: "180 Days", multiplier: "2.5x", color: "border-purple-500", active: "border-purple-400 bg-purple-500/10", seconds: 15552000 },
  { days: 365, label: "365 Days", multiplier: "4x", color: "border-primary", active: "border-primary bg-primary/10", seconds: 31536000 },
];

const B4_CA = "0x1d547f9d0890ee5abfb49d7d53ca19df85da4444";
const STAKING_CA = "0x5005dd0F5B3338526dd12f0Abc34C0Cb1Aa362ea";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

export default function StakingPage() {
  const [selectedTier, setSelectedTier] = useState(2);
  const [stakeAmount, setStakeAmount] = useState("");
  const [b4Balance, setB4Balance] = useState("0");
  const [b4Decimals, setB4Decimals] = useState(18);
  const [allowance, setAllowance] = useState("0");
  const [stakeInfo, setStakeInfo] = useState<{
    stakedAmount: string;
    lockEnd: number;
    lockDuration: number;
    pendingReward: string;
    multiplier: number;
    stakedAt: number;
  } | null>(null);
  const [globalStats, setGlobalStats] = useState<{
    totalStaked: string;
    totalStakers: number;
    totalRewardsDistributed: string;
    rewardRate: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [txPending, setTxPending] = useState<string | null>(null);

  const { connected, address, signer, provider, chainId } = useWallet();
  const { toast } = useToast();

  const tier = LOCK_TIERS[selectedTier];
  const isBNBChain = chainId === 56;

  const getStakingContract = useCallback(() => {
    if (!signer) return null;
    return new Contract(STAKING_CA, BUILD4StakingABI, signer);
  }, [signer]);

  const getB4Contract = useCallback(() => {
    if (!signer) return null;
    return new Contract(B4_CA, ERC20_ABI, signer);
  }, [signer]);

  const loadData = useCallback(async () => {
    if (!provider || !address) return;
    setLoading(true);
    try {
      const staking = new Contract(STAKING_CA, BUILD4StakingABI, provider);
      const b4 = new Contract(B4_CA, ERC20_ABI, provider);

      const [balance, decimals, userAllowance, info, stats] = await Promise.all([
        b4.balanceOf(address),
        b4.decimals(),
        b4.allowance(address, STAKING_CA),
        staking.getStakeInfo(address),
        staking.getGlobalStats(),
      ]);

      setB4Decimals(Number(decimals));
      setB4Balance(formatUnits(balance, decimals));
      setAllowance(formatUnits(userAllowance, decimals));

      setStakeInfo({
        stakedAmount: formatUnits(info[0], decimals),
        lockEnd: Number(info[1]),
        lockDuration: Number(info[2]),
        pendingReward: formatUnits(info[3], decimals),
        multiplier: Number(info[4]),
        stakedAt: Number(info[5]),
      });

      setGlobalStats({
        totalStaked: formatUnits(stats[0], decimals),
        totalStakers: Number(stats[1]),
        totalRewardsDistributed: formatUnits(stats[2], decimals),
        rewardRate: formatUnits(stats[3], decimals),
      });
    } catch (err) {
      console.error("Failed to load staking data:", err);
    } finally {
      setLoading(false);
    }
  }, [provider, address]);

  useEffect(() => {
    if (connected && address && isBNBChain) {
      loadData();
    }
  }, [connected, address, isBNBChain, loadData]);

  const handleApprove = async () => {
    const b4 = getB4Contract();
    if (!b4) return;
    setTxPending("Approving $B4...");
    try {
      const maxApproval = parseUnits("999999999999", b4Decimals);
      const tx = await b4.approve(STAKING_CA, maxApproval);
      toast({ title: "Approval submitted", description: "Waiting for confirmation..." });
      await tx.wait();
      toast({ title: "Approved", description: "$B4 approved for staking contract" });
      await loadData();
    } catch (err: any) {
      const msg = err?.reason || err?.message || "Approval failed";
      toast({ title: "Approval Failed", description: msg, variant: "destructive" });
    } finally {
      setTxPending(null);
    }
  };

  const handleStake = async () => {
    const staking = getStakingContract();
    if (!staking || !stakeAmount) return;

    const amount = parseFloat(stakeAmount);
    if (amount <= 0 || amount > parseFloat(b4Balance)) {
      toast({ title: "Invalid amount", description: "Enter a valid amount within your balance", variant: "destructive" });
      return;
    }

    const needsApproval = parseFloat(allowance) < amount;
    if (needsApproval) {
      await handleApprove();
      return;
    }

    setTxPending("Staking $B4...");
    try {
      const amountWei = parseUnits(stakeAmount, b4Decimals);
      const tx = await staking.stake(amountWei, tier.seconds);
      toast({ title: "Staking submitted", description: `Staking ${stakeAmount} $B4 for ${tier.label}...` });
      await tx.wait();
      toast({ title: "Staked!", description: `Successfully staked ${stakeAmount} $B4 for ${tier.label}` });
      setStakeAmount("");
      await loadData();
    } catch (err: any) {
      const msg = err?.reason || err?.message || "Staking failed";
      toast({ title: "Staking Failed", description: msg, variant: "destructive" });
    } finally {
      setTxPending(null);
    }
  };

  const handleUnstake = async () => {
    const staking = getStakingContract();
    if (!staking) return;
    setTxPending("Unstaking...");
    try {
      const tx = await staking.unstake();
      toast({ title: "Unstake submitted", description: "Waiting for confirmation..." });
      await tx.wait();
      toast({ title: "Unstaked!", description: "Your $B4 tokens have been returned" });
      await loadData();
    } catch (err: any) {
      const msg = err?.reason || err?.message || "Unstake failed";
      toast({ title: "Unstake Failed", description: msg, variant: "destructive" });
    } finally {
      setTxPending(null);
    }
  };

  const handleClaimRewards = async () => {
    const staking = getStakingContract();
    if (!staking) return;
    setTxPending("Claiming rewards...");
    try {
      const tx = await staking.claimRewards();
      toast({ title: "Claim submitted", description: "Waiting for confirmation..." });
      await tx.wait();
      toast({ title: "Rewards Claimed!", description: "Rewards sent to your wallet" });
      await loadData();
    } catch (err: any) {
      const msg = err?.reason || err?.message || "Claim failed";
      toast({ title: "Claim Failed", description: msg, variant: "destructive" });
    } finally {
      setTxPending(null);
    }
  };

  const hasStake = stakeInfo && parseFloat(stakeInfo.stakedAmount) > 0;
  const lockExpired = hasStake && stakeInfo && Date.now() / 1000 >= stakeInfo.lockEnd;
  const hasRewards = stakeInfo && parseFloat(stakeInfo.pendingReward) > 0;
  const needsApproval = parseFloat(allowance) < parseFloat(stakeAmount || "0");

  const formatNum = (n: string) => {
    const val = parseFloat(n);
    if (val >= 1_000_000) return (val / 1_000_000).toFixed(2) + "M";
    if (val >= 1_000) return (val / 1_000).toFixed(1) + "K";
    return val.toFixed(2);
  };

  const formatDate = (ts: number) => {
    if (ts === 0) return "—";
    return new Date(ts * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  };

  return (
    <>
      <SEO
        title="Stake $B4 | BUILD4"
        description="Stake $B4 tokens to unlock fee discounts and governance power. Lock longer for higher multipliers. Up to 4x boost with 365-day lock."
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
                <WalletConnector />
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
              Stake <span className="text-primary">$B4</span>
            </h1>
            <p className="font-mono text-sm text-muted-foreground max-w-lg mx-auto">
              Lock your tokens to unlock fee discounts, governance power, and priority access. Longer locks unlock higher tiers.
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4" data-testid="staking-stats">
            <Card className="p-4 text-center space-y-1">
              <Coins className="w-5 h-5 mx-auto text-primary" />
              <div className="font-mono text-xl font-bold" data-testid="text-total-staked">
                {globalStats ? formatNum(globalStats.totalStaked) : "0"}
              </div>
              <div className="font-mono text-[10px] text-muted-foreground">Total Staked</div>
            </Card>
            <Card className="p-4 text-center space-y-1">
              <Users className="w-5 h-5 mx-auto text-cyan-500" />
              <div className="font-mono text-xl font-bold" data-testid="text-total-stakers">
                {globalStats ? globalStats.totalStakers : 0}
              </div>
              <div className="font-mono text-[10px] text-muted-foreground">Stakers</div>
            </Card>
            <Card className="p-4 text-center space-y-1">
              <Gift className="w-5 h-5 mx-auto text-emerald-500" />
              <div className="font-mono text-xl font-bold" data-testid="text-rewards-distributed">
                {globalStats ? formatNum(globalStats.totalRewardsDistributed) : "0"}
              </div>
              <div className="font-mono text-[10px] text-muted-foreground">Rewards Distributed</div>
            </Card>
            <Card className="p-4 text-center space-y-1">
              <TrendingUp className="w-5 h-5 mx-auto text-amber-500" />
              <div className="font-mono text-xl font-bold" data-testid="text-current-multiplier">
                {hasStake && stakeInfo ? `${(stakeInfo.multiplier / 100).toFixed(2)}x` : tier.multiplier}
              </div>
              <div className="font-mono text-[10px] text-muted-foreground">Your Multiplier</div>
            </Card>
          </div>

          {!connected && (
            <Card className="p-6 border-dashed border-primary/30 bg-primary/5" data-testid="connect-wallet-notice">
              <div className="flex flex-col items-center gap-4 text-center">
                <Wallet className="w-8 h-8 text-primary" />
                <div>
                  <div className="font-mono text-sm font-bold">Connect Your Wallet</div>
                  <p className="font-mono text-xs text-muted-foreground mt-1">
                    Connect your wallet to stake $B4 tokens and view your staking position.
                  </p>
                </div>
                <WalletConnector />
              </div>
            </Card>
          )}

          {connected && !isBNBChain && (
            <Card className="p-6 border-dashed border-amber-500/30 bg-amber-500/5" data-testid="wrong-chain-notice">
              <div className="flex items-start gap-3">
                <Shield className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-mono text-sm font-bold text-amber-500">Switch to BNB Chain</div>
                  <p className="font-mono text-xs text-muted-foreground mt-1">
                    The staking contract is deployed on BNB Chain (BSC). Please switch your wallet to BNB Chain to stake.
                  </p>
                </div>
              </div>
            </Card>
          )}

          <Card className="p-6 border-primary/20 bg-primary/5" data-testid="token-live-notice">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-500 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="font-mono text-sm font-bold text-emerald-500">$B4 Token Live on BNB Chain</div>
                <p className="font-mono text-[10px] text-muted-foreground mt-1 break-all" data-testid="text-b4-ca">
                  CA: {B4_CA}
                </p>
                <div className="flex items-center gap-3 mt-2">
                  <a href={`https://bscscan.com/token/${B4_CA}`} target="_blank" rel="noopener noreferrer" className="font-mono text-[10px] text-primary hover:underline" data-testid="link-bscscan">BscScan</a>
                  <a href={`https://four.meme/token/${B4_CA}`} target="_blank" rel="noopener noreferrer" className="font-mono text-[10px] text-primary hover:underline" data-testid="link-fourmeme">Four.meme</a>
                  <a href={`https://dexscreener.com/bsc/${B4_CA}`} target="_blank" rel="noopener noreferrer" className="font-mono text-[10px] text-primary hover:underline" data-testid="link-dexscreener">DexScreener</a>
                </div>
              </div>
            </div>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">

            <div className="lg:col-span-3 space-y-6">
              <Card className="p-6 space-y-5" data-testid="staking-form">
                <div className="flex items-center gap-2">
                  <Lock className="w-5 h-5 text-primary" />
                  <h2 className="font-mono text-base font-bold">Stake Tokens</h2>
                </div>

                {hasStake && (
                  <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                    <p className="font-mono text-[10px] text-amber-600 dark:text-amber-400">
                      You already have an active stake. Unstake first before creating a new stake.
                    </p>
                  </div>
                )}

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
                        <div className="font-mono text-sm text-primary font-semibold mt-1">{t.multiplier}</div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs text-muted-foreground">Amount to Stake</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      Balance: {connected && isBNBChain ? formatNum(b4Balance) : "—"} $B4
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      placeholder="0.00"
                      value={stakeAmount}
                      onChange={(e) => setStakeAmount(e.target.value)}
                      className="font-mono"
                      disabled={!connected || !isBNBChain || !!hasStake || !!txPending}
                      data-testid="input-stake-amount"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="font-mono text-xs px-3"
                      disabled={!connected || !isBNBChain || !!hasStake || !!txPending}
                      onClick={() => setStakeAmount(b4Balance)}
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
                    <span className="text-muted-foreground">Discount Multiplier</span>
                    <span className="font-semibold text-primary">{tier.multiplier}</span>
                  </div>
                  <div className="font-mono text-[10px] text-muted-foreground pt-1">
                    Higher multipliers unlock deeper fee discounts and stronger governance weight.
                  </div>
                </div>

                <Button
                  className="w-full font-mono text-sm gap-2"
                  disabled={!connected || !isBNBChain || !!hasStake || !stakeAmount || parseFloat(stakeAmount) <= 0 || !!txPending}
                  onClick={needsApproval ? handleApprove : handleStake}
                  data-testid="button-stake"
                >
                  {txPending ? (
                    <><Loader2 className="w-4 h-4 animate-spin" /> {txPending}</>
                  ) : !connected ? (
                    <><Wallet className="w-4 h-4" /> Connect Wallet to Stake</>
                  ) : !isBNBChain ? (
                    <><Shield className="w-4 h-4" /> Switch to BNB Chain</>
                  ) : hasStake ? (
                    <><Lock className="w-4 h-4" /> Active Stake — Unstake First</>
                  ) : needsApproval ? (
                    <><CheckCircle2 className="w-4 h-4" /> Approve $B4</>
                  ) : (
                    <><Lock className="w-4 h-4" /> Stake $B4</>
                  )}
                </Button>
              </Card>

              <Card className="p-6 space-y-4" data-testid="your-stake">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Wallet className="w-5 h-5 text-primary" />
                    <h2 className="font-mono text-base font-bold">Your Stake</h2>
                  </div>
                  {connected && isBNBChain && (
                    <Button variant="ghost" size="sm" className="font-mono text-[10px] h-7 px-2" onClick={loadData} disabled={loading}>
                      {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : "Refresh"}
                    </Button>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 rounded-lg bg-muted/50 space-y-1">
                    <div className="font-mono text-[10px] text-muted-foreground">Staked Amount</div>
                    <div className="font-mono text-lg font-bold" data-testid="text-user-staked">
                      {hasStake ? formatNum(stakeInfo!.stakedAmount) : "0"} $B4
                    </div>
                  </div>
                  <div className="p-4 rounded-lg bg-muted/50 space-y-1">
                    <div className="font-mono text-[10px] text-muted-foreground">Pending Rewards</div>
                    <div className="font-mono text-lg font-bold text-emerald-500" data-testid="text-user-rewards">
                      {hasStake ? formatNum(stakeInfo!.pendingReward) : "0"} $B4
                    </div>
                  </div>
                  <div className="p-4 rounded-lg bg-muted/50 space-y-1">
                    <div className="font-mono text-[10px] text-muted-foreground">Lock Ends</div>
                    <div className="font-mono text-sm font-bold" data-testid="text-lock-end">
                      {hasStake ? formatDate(stakeInfo!.lockEnd) : "No active stake"}
                    </div>
                    {hasStake && lockExpired && (
                      <Badge variant="default" className="text-[9px] bg-emerald-500">Unlocked</Badge>
                    )}
                    {hasStake && !lockExpired && (
                      <Badge variant="secondary" className="text-[9px]">Locked</Badge>
                    )}
                  </div>
                  <div className="p-4 rounded-lg bg-muted/50 space-y-1">
                    <div className="font-mono text-[10px] text-muted-foreground">Your Multiplier</div>
                    <div className="font-mono text-lg font-bold text-primary" data-testid="text-user-multiplier">
                      {hasStake ? `${(stakeInfo!.multiplier / 100).toFixed(2)}x` : "0x"}
                    </div>
                  </div>
                </div>

                <div className="flex gap-3">
                  <Button
                    variant="outline"
                    className="flex-1 font-mono text-xs gap-1.5"
                    disabled={!hasRewards || !!txPending}
                    onClick={handleClaimRewards}
                    data-testid="button-claim-rewards"
                  >
                    {txPending === "Claiming rewards..." ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Gift className="w-3.5 h-3.5" />}
                    Claim Rewards
                  </Button>
                  <Button
                    variant="outline"
                    className="flex-1 font-mono text-xs gap-1.5"
                    disabled={!hasStake || !lockExpired || !!txPending}
                    onClick={handleUnstake}
                    data-testid="button-unstake"
                  >
                    {txPending === "Unstaking..." ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Unlock className="w-3.5 h-3.5" />}
                    Unstake
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
                      <div className="font-mono text-xs font-semibold">Connect Wallet</div>
                      <p className="font-mono text-[10px] text-muted-foreground mt-0.5">
                        Connect your wallet on BNB Chain to get started.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <span className="font-mono text-xs font-bold text-primary">2</span>
                    </div>
                    <div>
                      <div className="font-mono text-xs font-semibold">Stake $B4</div>
                      <p className="font-mono text-[10px] text-muted-foreground mt-0.5">
                        Approve and deposit your tokens. Choose a lock period from 7 to 365 days.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <span className="font-mono text-xs font-bold text-primary">3</span>
                    </div>
                    <div>
                      <div className="font-mono text-xs font-semibold">Earn Multiplier</div>
                      <p className="font-mono text-[10px] text-muted-foreground mt-0.5">
                        Longer locks unlock higher tiers. A 365-day lock gets 4x the base discount multiplier.
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
                        Claim rewards anytime. Unstake after your lock period ends to withdraw your tokens.
                      </p>
                    </div>
                  </div>
                </div>
              </Card>

              <Card className="p-6 space-y-4" data-testid="reward-tiers">
                <div className="flex items-center gap-2">
                  <BarChart3 className="w-5 h-5 text-primary" />
                  <h2 className="font-mono text-base font-bold">Staking Tiers</h2>
                </div>

                <div className="space-y-2">
                  {LOCK_TIERS.map((t) => (
                    <div key={t.days} className="flex items-center justify-between p-3 rounded-lg bg-muted/30">
                      <div className="flex items-center gap-2">
                        <Clock className="w-3.5 h-3.5 text-muted-foreground" />
                        <span className="font-mono text-xs">{t.label}</span>
                      </div>
                      <Badge variant="secondary" className="font-mono text-xs font-bold">{t.multiplier} discount</Badge>
                    </div>
                  ))}
                </div>
                <p className="font-mono text-[10px] text-muted-foreground">
                  Discount tiers are locked by the smart contract. Stakers also gain governance voting weight proportional to their multiplier.
                </p>
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
                    <span>Platform transaction fees (20%)</span>
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
                  30% of all platform fees buy back $B4 from the open market and burn it, permanently reducing supply.
                </p>
              </Card>
            </div>
          </div>

          <Card className="p-6 space-y-4" data-testid="staking-contract-info">
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-primary" />
              <h2 className="font-mono text-base font-bold">Contract Info</h2>
            </div>

            <div className="p-4 rounded-lg bg-muted/50 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] text-muted-foreground">Staking Contract</span>
                <a href={`https://bscscan.com/address/${STAKING_CA}`} target="_blank" rel="noopener noreferrer" className="font-mono text-[10px] text-primary hover:underline flex items-center gap-1" data-testid="link-staking-bscscan">
                  View on BscScan <ExternalLink className="w-3 h-3" />
                </a>
              </div>
              <p className="font-mono text-[10px] text-muted-foreground break-all" data-testid="text-staking-ca">{STAKING_CA}</p>
              <div className="flex items-center justify-between pt-1">
                <span className="font-mono text-[10px] text-muted-foreground">Staking Token ($B4)</span>
                <a href={`https://bscscan.com/token/${B4_CA}`} target="_blank" rel="noopener noreferrer" className="font-mono text-[10px] text-primary hover:underline flex items-center gap-1" data-testid="link-b4-bscscan">
                  View on BscScan <ExternalLink className="w-3 h-3" />
                </a>
              </div>
              <p className="font-mono text-[10px] text-muted-foreground break-all">{B4_CA}</p>
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
              Stake $B4 to unlock fee discounts, governance votes, and priority access. Longer locks earn higher multipliers.
            </p>
          </footer>
        </main>
      </div>
    </>
  );
}
