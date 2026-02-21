import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { useT } from "@/lib/i18n";
import { LanguageSwitcher } from "@/components/language-switcher";
import {
  ArrowLeft,
  DollarSign,
  TrendingUp,
  BarChart3,
  Clock,
  Layers,
  Zap,
  GitBranch,
  Brain,
  ShoppingCart,
  ExternalLink,
  ShieldCheck,
  ShieldAlert,
  Fuel,
} from "lucide-react";
import type { PlatformRevenue } from "@shared/schema";

function formatWei(weiStr: string): string {
  const wei = BigInt(weiStr || "0");
  const whole = wei / BigInt("100000000000000");
  const decimal = whole % BigInt(10000);
  const integer = whole / BigInt(10000);
  return `${integer}.${decimal.toString().padStart(4, "0")}`;
}

function formatBNB(weiStr: string): string {
  const wei = BigInt(weiStr || "0");
  const bnb = Number(wei) / 1e18;
  if (bnb >= 1) return `${bnb.toFixed(4)} BNB`;
  if (bnb >= 0.001) return `${bnb.toFixed(6)} BNB`;
  return `${bnb.toFixed(8)} BNB`;
}

function feeTypeIcon(type: string) {
  switch (type) {
    case "agent_creation": return <DollarSign className="w-4 h-4" />;
    case "skill_listing": return <Layers className="w-4 h-4" />;
    case "skill_purchase": return <ShoppingCart className="w-4 h-4" />;
    case "replication": return <GitBranch className="w-4 h-4" />;
    case "inference": return <Brain className="w-4 h-4" />;
    case "evolution": return <Zap className="w-4 h-4" />;
    case "gas_reimbursement": return <Fuel className="w-4 h-4" />;
    default: return <DollarSign className="w-4 h-4" />;
  }
}

function feeTypeBadge(type: string) {
  const colors: Record<string, string> = {
    agent_creation: "bg-rose-500/20 text-rose-400 border-rose-500/30",
    skill_listing: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    skill_purchase: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
    replication: "bg-purple-500/20 text-purple-400 border-purple-500/30",
    inference: "bg-amber-500/20 text-amber-400 border-amber-500/30",
    evolution: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
    gas_reimbursement: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  };
  return colors[type] || "bg-muted text-muted-foreground";
}

function feeTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    agent_creation: "Agent Creation",
    skill_listing: "Skill Listing",
    skill_purchase: "Skill Purchase",
    replication: "Replication",
    inference: "Inference",
    evolution: "Evolution",
    gas_reimbursement: "Gas Reimbursement",
  };
  return labels[type] || type;
}

function getExplorerUrl(txHash: string, chainId: number | null, explorerBases: Record<number, string>): string {
  if (!chainId) return "#";
  const base = explorerBases[chainId] || "https://bscscan.com";
  return `${base}/tx/${txHash}`;
}

function truncateHash(hash: string): string {
  if (hash.length <= 14) return hash;
  return `${hash.slice(0, 8)}...${hash.slice(-6)}`;
}

export default function Revenue() {
  const t = useT();

  const { data: summary } = useQuery<{
    totalRevenue: string;
    byFeeType: Record<string, string>;
    totalTransactions: number;
    onchainVerified: number;
    onchainRevenue: string;
    explorerBases: Record<number, string>;
  }>({ queryKey: ["/api/web4/revenue/summary"] });

  const { data: history } = useQuery<PlatformRevenue[]>({
    queryKey: ["/api/web4/revenue/history"],
  });

  const { data: feeConfig } = useQuery<{
    fees: Record<string, string | number>;
    descriptions: Record<string, string>;
  }>({ queryKey: ["/api/web4/revenue/fees"] });

  const feeTypes = ["agent_creation", "skill_listing", "skill_purchase", "replication", "inference", "evolution", "gas_reimbursement"];
  const explorerBases = summary?.explorerBases || {};
  const onchainPct = summary && summary.totalTransactions > 0 ? Math.round((summary.onchainVerified / summary.totalTransactions) * 100) : 0;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between h-16">
          <div className="flex items-center gap-4">
            <Link href="/" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors" data-testid="link-home">
              <ArrowLeft className="w-4 h-4" />
              <span className="text-sm">Home</span>
            </Link>
            <div className="h-4 w-px bg-border" />
            <h1 className="text-lg font-semibold tracking-tight" data-testid="text-page-title">Platform Revenue</h1>
          </div>
          <div className="flex items-center gap-3">
            <LanguageSwitcher />
            <Link href="/autonomous-economy">
              <Badge variant="outline" className="cursor-pointer hover:bg-accent" data-testid="link-economy">Economy</Badge>
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="p-6 bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20" data-testid="card-total-revenue">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 rounded-lg bg-primary/20">
                <DollarSign className="w-5 h-5 text-primary" />
              </div>
              <span className="text-sm text-muted-foreground">Total Revenue</span>
            </div>
            <p className="text-2xl font-bold" data-testid="text-total-revenue">
              {summary ? formatBNB(summary.totalRevenue) : "Loading..."}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {summary ? formatWei(summary.totalRevenue) : ""} credits
            </p>
          </Card>

          <Card className="p-6 bg-gradient-to-br from-emerald-500/10 to-emerald-500/5 border-emerald-500/20" data-testid="card-onchain-revenue">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 rounded-lg bg-emerald-500/20">
                <ShieldCheck className="w-5 h-5 text-emerald-400" />
              </div>
              <span className="text-sm text-muted-foreground">On-Chain Verified</span>
            </div>
            <p className="text-2xl font-bold text-emerald-400" data-testid="text-onchain-revenue">
              {summary ? formatBNB(summary.onchainRevenue) : "Loading..."}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {summary?.onchainVerified ?? 0} verified transactions
            </p>
          </Card>

          <Card className="p-6" data-testid="card-total-transactions">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 rounded-lg bg-accent">
                <TrendingUp className="w-5 h-5 text-foreground" />
              </div>
              <span className="text-sm text-muted-foreground">Total Fee Transactions</span>
            </div>
            <p className="text-2xl font-bold" data-testid="text-total-transactions">
              {summary?.totalTransactions ?? "..."}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {onchainPct}% on-chain verified
            </p>
          </Card>

          <Card className="p-6" data-testid="card-active-streams">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 rounded-lg bg-accent">
                <BarChart3 className="w-5 h-5 text-foreground" />
              </div>
              <span className="text-sm text-muted-foreground">Revenue Streams</span>
            </div>
            <p className="text-2xl font-bold" data-testid="text-active-streams">
              {summary ? Object.keys(summary.byFeeType).length : "..."} / {feeTypes.length}
            </p>
            <p className="text-xs text-muted-foreground mt-1">active fee categories</p>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="p-6" data-testid="card-revenue-breakdown">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <BarChart3 className="w-5 h-5" />
              Revenue Breakdown
            </h2>
            <div className="space-y-3">
              {feeTypes.map((type) => {
                const amount = summary?.byFeeType[type] || "0";
                const totalWei = BigInt(summary?.totalRevenue || "1");
                const typeWei = BigInt(amount);
                const percentage = totalWei > BigInt(0) ? Number((typeWei * BigInt(10000)) / totalWei) / 100 : 0;
                return (
                  <div key={type} className="flex items-center gap-3" data-testid={`row-fee-${type}`}>
                    <div className={`p-1.5 rounded ${feeTypeBadge(type)}`}>
                      {feeTypeIcon(type)}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium">{feeTypeLabel(type)}</span>
                        <span className="text-sm text-muted-foreground">{formatBNB(amount)}</span>
                      </div>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary rounded-full transition-all duration-500"
                          style={{ width: `${Math.min(percentage, 100)}%` }}
                        />
                      </div>
                    </div>
                    <span className="text-xs text-muted-foreground w-12 text-right">{percentage.toFixed(1)}%</span>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card className="p-6" data-testid="card-fee-schedule">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Layers className="w-5 h-5" />
              Fee Schedule
            </h2>
            <div className="space-y-3">
              {feeConfig && Object.entries(feeConfig.fees).map(([key, value]) => (
                <div key={key} className="flex items-center justify-between py-2 border-b border-border/40 last:border-0" data-testid={`row-config-${key}`}>
                  <div>
                    <p className="text-sm font-medium">{key.replace(/_/g, " ")}</p>
                    <p className="text-xs text-muted-foreground">{feeConfig.descriptions[key]}</p>
                  </div>
                  <Badge variant="secondary" className="font-mono">
                    {typeof value === "number" ? `${value / 100}%` : formatBNB(String(value))}
                  </Badge>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <Card className="p-6" data-testid="card-revenue-history">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Clock className="w-5 h-5" />
            Revenue History
          </h2>
          {(!history || history.length === 0) ? (
            <div className="text-center py-12 text-muted-foreground">
              <DollarSign className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No revenue recorded yet</p>
              <p className="text-xs mt-1">Fees will appear here as agents transact</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-[500px] overflow-y-auto">
              {history.map((entry) => (
                <div key={entry.id} className="flex items-center gap-3 py-3 px-3 rounded-lg hover:bg-accent/50 transition-colors border border-transparent hover:border-border/40" data-testid={`row-history-${entry.id}`}>
                  <div className={`p-1.5 rounded ${feeTypeBadge(entry.feeType)}`}>
                    {feeTypeIcon(entry.feeType)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium truncate">{entry.description}</p>
                      {entry.txHash ? (
                        <Badge variant="outline" className="shrink-0 text-[10px] bg-emerald-500/10 text-emerald-400 border-emerald-500/30 gap-1" data-testid={`badge-verified-${entry.id}`}>
                          <ShieldCheck className="w-3 h-3" />
                          On-Chain
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="shrink-0 text-[10px] bg-amber-500/10 text-amber-400 border-amber-500/30 gap-1" data-testid={`badge-offchain-${entry.id}`}>
                          <ShieldAlert className="w-3 h-3" />
                          Off-Chain
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <p className="text-xs text-muted-foreground">
                        {new Date(entry.createdAt!).toLocaleString()}
                      </p>
                      {entry.txHash && (
                        <a
                          href={getExplorerUrl(entry.txHash, entry.chainId, explorerBases)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary hover:underline flex items-center gap-1"
                          data-testid={`link-tx-${entry.id}`}
                        >
                          <span className="font-mono">{truncateHash(entry.txHash)}</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-mono font-medium text-primary">{formatBNB(entry.amount)}</p>
                    <Badge variant="outline" className="text-[10px]">{feeTypeLabel(entry.feeType)}</Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </main>
    </div>
  );
}
