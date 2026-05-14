import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Wallet,
  ArrowUpDown,
  Bot,
  Copy,
  Check,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Zap,
  Shield,
  Activity,
  DollarSign,
  BarChart3,
  Clock,
  ExternalLink,
} from "lucide-react";

const VAULT_ADDR = "0x128463A60784c4D3f46c23Af3f65Ed859Ba87974";

function getChatId(): string {
  try {
    const params = new URLSearchParams(window.location.search);
    const chatId = params.get("chatId");
    if (chatId) return chatId;
    if ((window as any).Telegram?.WebApp?.initDataUnsafe?.user?.id) {
      return String((window as any).Telegram?.WebApp?.initDataUnsafe?.user?.id);
    }
  } catch {}
  return "";
}

function useMiniAppApi<T>(endpoint: string, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const chatId = getChatId();
      const res = await fetch(endpoint, {
        headers: { "x-telegram-chat-id": chatId },
      });
      if (!res.ok) throw new Error(await res.text());
      setData(await res.json());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [endpoint, ...deps]);

  useEffect(() => { refresh(); }, [refresh]);

  return { data, loading, error, refresh };
}

interface AccountData {
  connected: boolean;
  walletBalance: number;
  availableMargin: number;
  bscBalance: number;
  unrealizedPnl: number;
  realizedPnl: number;
  wins: number;
  losses: number;
  positions: Position[];
  recentIncome: IncomeEntry[];
}

interface Position {
  symbol: string;
  side: string;
  size: number;
  entryPrice: number;
  markPrice: number;
  leverage: string;
  unrealizedPnl: number;
  notional: number;
}

interface IncomeEntry {
  symbol: string;
  amount: number;
  type: string;
  time: number;
}

interface AgentData {
  running: boolean;
  config: {
    riskPercent: number;
    maxLeverage: number;
    symbol: string;
    interval: number;
  };
  stats: {
    tradeCount: number;
    winCount: number;
    lossCount: number;
    totalPnl: number;
    lastAction: string | null;
    lastReason: string | null;
  } | null;
}

interface MarketData {
  markets: { symbol: string; price: number }[];
}

function formatUsd(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function PnlBadge({ value }: { value: number }) {
  const positive = value >= 0;
  return (
    <span className={`font-mono font-semibold ${positive ? "text-emerald-400" : "text-red-400"}`}>
      {positive ? "+" : ""}${formatUsd(value)}
    </span>
  );
}

function DashboardTab() {
  const { data: account, loading, refresh } = useMiniAppApi<AccountData>("/api/miniapp/account");
  const { data: markets } = useMiniAppApi<MarketData>("/api/miniapp/markets");

  if (loading && !account) {
    return (
      <div className="space-y-4 p-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!account?.connected) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center space-y-4 min-h-[60vh]">
        <div className="w-16 h-16 rounded-full bg-yellow-500/10 flex items-center justify-center">
          <AlertTriangle className="w-8 h-8 text-yellow-500" />
        </div>
        <h3 className="text-lg font-semibold text-white">Not Connected</h3>
        <p className="text-muted-foreground text-sm max-w-[280px]">
          Connect your Aster account in the bot first using the Aster Menu, then reopen this app.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 pb-24">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-white" data-testid="text-dashboard-title">Dashboard</h2>
        <Button variant="ghost" size="sm" onClick={refresh} data-testid="button-refresh-dashboard">
          <RefreshCw className="w-4 h-4" />
        </Button>
      </div>

      <Card className="bg-gradient-to-br from-emerald-500/10 to-emerald-600/5 border-emerald-500/20">
        <CardContent className="p-5">
          <div className="text-sm text-emerald-300/70 mb-1">Available Futures Margin</div>
          <div className="text-3xl font-bold text-white font-mono" data-testid="text-available-margin">
            ${formatUsd(account.availableMargin)}
          </div>
          <div className="flex items-center gap-4 mt-3 text-sm">
            <div className="flex items-center gap-1.5">
              <Wallet className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">BSC:</span>
              <span className="text-white font-mono" data-testid="text-bsc-balance">${formatUsd(account.bscBalance)}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <DollarSign className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">Wallet:</span>
              <span className="text-white font-mono">${formatUsd(account.walletBalance)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3">
        <Card className="border-border/50">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground mb-1">Unrealized PnL</div>
            <div className="text-lg font-mono" data-testid="text-unrealized-pnl">
              <PnlBadge value={account.unrealizedPnl} />
            </div>
          </CardContent>
        </Card>
        <Card className="border-border/50">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground mb-1">Realized PnL</div>
            <div className="text-lg font-mono" data-testid="text-realized-pnl">
              <PnlBadge value={account.realizedPnl} />
            </div>
            {(account.wins + account.losses) > 0 && (
              <div className="text-xs text-muted-foreground mt-1">
                {account.wins}W / {account.losses}L ({Math.round(account.wins / (account.wins + account.losses) * 100)}%)
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {account.positions.length > 0 && (
        <Card className="border-border/50">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm font-semibold text-white flex items-center gap-2">
              <Activity className="w-4 h-4 text-emerald-400" />
              Open Positions ({account.positions.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-3">
            {account.positions.map((pos, i) => (
              <div key={i} className="flex items-center justify-between py-2 border-b border-border/30 last:border-0" data-testid={`position-row-${i}`}>
                <div>
                  <div className="flex items-center gap-2">
                    <Badge variant={pos.side === "LONG" ? "default" : "destructive"} className="text-xs px-1.5 py-0">
                      {pos.side}
                    </Badge>
                    <span className="text-white font-semibold text-sm">{pos.symbol}</span>
                    <span className="text-muted-foreground text-xs">{pos.leverage}x</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {pos.size} @ ${formatUsd(pos.entryPrice)} → ${formatUsd(pos.markPrice)}
                  </div>
                </div>
                <PnlBadge value={pos.unrealizedPnl} />
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {markets?.markets && markets.markets.length > 0 && (
        <Card className="border-border/50">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm font-semibold text-white flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-blue-400" />
              Markets
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="grid grid-cols-2 gap-2">
              {markets.markets.map((m) => (
                <div key={m.symbol} className="flex items-center justify-between py-1.5 px-2 rounded bg-card/50" data-testid={`market-${m.symbol}`}>
                  <span className="text-xs text-muted-foreground">{m.symbol.replace("USDT", "")}</span>
                  <span className="text-xs text-white font-mono">${formatUsd(m.price)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {account.recentIncome.length > 0 && (
        <Card className="border-border/50">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm font-semibold text-white flex items-center gap-2">
              <Clock className="w-4 h-4 text-orange-400" />
              Recent PnL
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 space-y-1">
            {account.recentIncome.slice(0, 5).map((inc, i) => (
              <div key={i} className="flex items-center justify-between text-xs py-1">
                <span className="text-muted-foreground">{inc.symbol}</span>
                <PnlBadge value={inc.amount} />
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function DepositTab() {
  const { data: account, refresh } = useMiniAppApi<AccountData>("/api/miniapp/account");
  const [amount, setAmount] = useState("");
  const [depositing, setDepositing] = useState(false);
  const [result, setResult] = useState<{ success: boolean; txHash?: string; error?: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const handleDeposit = async (depositAmount: number) => {
    setDepositing(true);
    setResult(null);
    try {
      const chatId = getChatId();
      const res = await fetch("/api/miniapp/deposit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-telegram-chat-id": chatId,
        },
        body: JSON.stringify({ amount: depositAmount }),
      });
      const data = await res.json();
      setResult(data);
      if (data.success) {
        setTimeout(refresh, 3000);
      }
    } catch (e: any) {
      setResult({ success: false, error: e.message });
    } finally {
      setDepositing(false);
    }
  };

  const copyVault = () => {
    navigator.clipboard.writeText(VAULT_ADDR);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const presets = [10, 25, 50, 100];

  return (
    <div className="space-y-4 p-4 pb-24">
      <h2 className="text-lg font-bold text-white" data-testid="text-deposit-title">Deposit USDT</h2>

      <Card className="border-border/50">
        <CardContent className="p-4 space-y-3">
          <div className="text-sm text-muted-foreground">Current Balances</div>
          <div className="grid grid-cols-3 gap-2">
            <div className="text-center p-2 rounded bg-card/80">
              <div className="text-[10px] text-muted-foreground">BSC Wallet</div>
              <div className="text-sm font-mono text-white" data-testid="text-deposit-bsc-bal">${formatUsd(account?.bscBalance || 0)}</div>
            </div>
            <div className="text-center p-2 rounded bg-card/80">
              <div className="text-[10px] text-muted-foreground">Spot</div>
              <div className="text-sm font-mono text-white">${formatUsd(account?.walletBalance || 0)}</div>
            </div>
            <div className="text-center p-2 rounded bg-emerald-500/10">
              <div className="text-[10px] text-emerald-300/70">Futures</div>
              <div className="text-sm font-mono text-white">${formatUsd(account?.availableMargin || 0)}</div>
            </div>
          </div>

          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <ArrowUpDown className="w-3 h-3" />
            BSC Wallet → Aster Vault → Spot → Futures
          </div>
        </CardContent>
      </Card>

      <Card className="border-emerald-500/20 bg-gradient-to-br from-emerald-500/5 to-transparent">
        <CardContent className="p-4 space-y-4">
          <div className="text-sm font-semibold text-white">Quick Deposit (Auto)</div>
          <div className="text-xs text-muted-foreground">
            The bot signs the BSC transaction, deposits to Aster vault, and transfers to Futures — all automatically.
          </div>

          <div className="grid grid-cols-4 gap-2">
            {presets.map((v) => (
              <Button
                key={v}
                variant="outline"
                size="sm"
                disabled={depositing}
                onClick={() => handleDeposit(v)}
                className="font-mono"
                data-testid={`button-deposit-${v}`}
              >
                ${v}
              </Button>
            ))}
          </div>

          <div className="flex gap-2">
            <Input
              type="number"
              placeholder="Custom amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="font-mono"
              data-testid="input-deposit-custom"
            />
            <Button
              disabled={depositing || !amount || parseFloat(amount) < 1}
              onClick={() => handleDeposit(parseFloat(amount))}
              className="shrink-0"
              data-testid="button-deposit-custom"
            >
              {depositing ? <RefreshCw className="w-4 h-4 animate-spin" /> : "Deposit"}
            </Button>
          </div>

          {depositing && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
              <RefreshCw className="w-4 h-4 animate-spin text-blue-400" />
              <span className="text-sm text-blue-300">Signing and sending BSC transaction...</span>
            </div>
          )}

          {result && (
            <div className={`p-3 rounded-lg border ${result.success ? "bg-emerald-500/10 border-emerald-500/20" : "bg-red-500/10 border-red-500/20"}`}>
              {result.success ? (
                <div className="space-y-1">
                  <div className="text-sm text-emerald-300 font-semibold">Deposit Successful!</div>
                  {result.txHash && (
                    <a
                      href={`https://bscscan.com/tx/${result.txHash}`}
                      target="_blank"
                      rel="noopener"
                      className="text-xs text-emerald-400/70 underline flex items-center gap-1"
                      data-testid="link-tx-bscscan"
                    >
                      View on BscScan <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
              ) : (
                <div className="text-sm text-red-300">{result.error}</div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-border/50">
        <CardContent className="p-4 space-y-3">
          <div className="text-sm font-semibold text-white">Manual Deposit</div>
          <div className="text-xs text-muted-foreground">
            Send USDT (BEP-20) on BSC to the vault address:
          </div>
          <div
            className="flex items-center gap-2 p-3 rounded-lg bg-card/80 border border-border/50 cursor-pointer hover:border-emerald-500/30 transition-colors"
            onClick={copyVault}
            data-testid="button-copy-vault"
          >
            <code className="text-[11px] text-emerald-300 font-mono flex-1 break-all">{VAULT_ADDR}</code>
            {copied ? <Check className="w-4 h-4 text-emerald-400 shrink-0" /> : <Copy className="w-4 h-4 text-muted-foreground shrink-0" />}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-yellow-500/80">
            <AlertTriangle className="w-3 h-3" />
            Only USDT on BSC. Wrong network = lost funds.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function AgentTab() {
  const { data: agent, loading, refresh } = useMiniAppApi<AgentData>("/api/miniapp/agent");
  const [toggling, setToggling] = useState(false);
  const [riskPercent, setRiskPercent] = useState(1.0);

  useEffect(() => {
    if (agent?.config?.riskPercent) setRiskPercent(agent.config.riskPercent);
  }, [agent?.config?.riskPercent]);

  const toggleAgent = async () => {
    setToggling(true);
    try {
      const chatId = getChatId();
      await fetch("/api/miniapp/agent/toggle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-telegram-chat-id": chatId,
        },
      });
      await refresh();
    } catch {} finally {
      setToggling(false);
    }
  };

  if (loading && !agent) {
    return (
      <div className="space-y-4 p-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const isRunning = agent?.running || false;
  const stats = agent?.stats;
  const winRate = stats && (stats.winCount + stats.lossCount) > 0
    ? Math.round(stats.winCount / (stats.winCount + stats.lossCount) * 100)
    : 0;

  return (
    <div className="space-y-4 p-4 pb-24">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-white" data-testid="text-agent-title">AI Trading Agent</h2>
        <Button variant="ghost" size="sm" onClick={refresh} data-testid="button-refresh-agent">
          <RefreshCw className="w-4 h-4" />
        </Button>
      </div>

      <Card className={`border-2 transition-all ${isRunning ? "border-emerald-500/40 bg-emerald-500/5" : "border-border/50"}`}>
        <CardContent className="p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${isRunning ? "bg-emerald-500/20" : "bg-muted"}`}>
                <Bot className={`w-6 h-6 ${isRunning ? "text-emerald-400" : "text-muted-foreground"}`} />
              </div>
              <div>
                <div className="text-white font-semibold">Autonomous Agent</div>
                <div className="flex items-center gap-1.5">
                  <div className={`w-2 h-2 rounded-full ${isRunning ? "bg-emerald-400 animate-pulse" : "bg-muted-foreground"}`} />
                  <span className={`text-xs ${isRunning ? "text-emerald-400" : "text-muted-foreground"}`}>
                    {isRunning ? "Running" : "Stopped"}
                  </span>
                </div>
              </div>
            </div>
            <Switch
              checked={isRunning}
              onCheckedChange={toggleAgent}
              disabled={toggling}
              data-testid="switch-agent-toggle"
            />
          </div>

          {isRunning && agent?.config && (
            <div className="mt-4 flex flex-wrap gap-2">
              <Badge variant="outline" className="text-xs">{agent.config.symbol}</Badge>
              <Badge variant="outline" className="text-xs">{agent.config.maxLeverage}x max</Badge>
              <Badge variant="outline" className="text-xs">{agent.config.riskPercent}% risk</Badge>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-border/50">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm font-semibold text-white flex items-center gap-2">
            <Shield className="w-4 h-4 text-blue-400" />
            Risk Settings
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-2 space-y-4">
          <div>
            <div className="flex items-center justify-between text-sm mb-2">
              <span className="text-muted-foreground">Risk per Trade</span>
              <span className="text-white font-mono">{riskPercent.toFixed(1)}%</span>
            </div>
            <Slider
              value={[riskPercent]}
              onValueChange={([v]) => setRiskPercent(v)}
              min={0.5}
              max={3}
              step={0.1}
              className="w-full"
              data-testid="slider-risk-percent"
            />
            <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
              <span>Conservative (0.5%)</span>
              <span>Aggressive (3%)</span>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between text-sm mb-2">
              <span className="text-muted-foreground">Max Leverage</span>
              <span className="text-white font-mono">{agent?.config?.maxLeverage || 10}x</span>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Trading Pair</span>
              <span className="text-white">{agent?.config?.symbol || "BTCUSDT"}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {stats && (
        <Card className="border-border/50">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm font-semibold text-white flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-purple-400" />
              Performance
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-lg bg-card/50">
                <div className="text-[10px] text-muted-foreground">Total Trades</div>
                <div className="text-lg font-mono text-white" data-testid="text-agent-trades">{stats.tradeCount}</div>
              </div>
              <div className="p-3 rounded-lg bg-card/50">
                <div className="text-[10px] text-muted-foreground">Win Rate</div>
                <div className="text-lg font-mono text-white">{winRate}%</div>
              </div>
              <div className="p-3 rounded-lg bg-card/50">
                <div className="text-[10px] text-muted-foreground">Total PnL</div>
                <div className="text-lg font-mono"><PnlBadge value={stats.totalPnl} /></div>
              </div>
              <div className="p-3 rounded-lg bg-card/50">
                <div className="text-[10px] text-muted-foreground">W / L</div>
                <div className="text-lg font-mono text-white">
                  <span className="text-emerald-400">{stats.winCount}</span>
                  {" / "}
                  <span className="text-red-400">{stats.lossCount}</span>
                </div>
              </div>
            </div>

            {stats.lastAction && (
              <div className="mt-3 p-3 rounded-lg bg-blue-500/5 border border-blue-500/10">
                <div className="text-[10px] text-blue-300/70 mb-1">Last Action</div>
                <div className="text-sm text-white">{stats.lastAction}</div>
                {stats.lastReason && (
                  <div className="text-xs text-muted-foreground mt-1">{stats.lastReason}</div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function TradeTab() {
  const { data: account } = useMiniAppApi<AccountData>("/api/miniapp/account");
  const { data: markets } = useMiniAppApi<MarketData>("/api/miniapp/markets");
  const [selectedPair, setSelectedPair] = useState("BTCUSDT");
  const [leverage, setLeverage] = useState(10);
  const [tradeAmount, setTradeAmount] = useState("");

  const currentPrice = markets?.markets?.find((m) => m.symbol === selectedPair)?.price || 0;
  const pairs = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "DOGEUSDT"];

  return (
    <div className="space-y-4 p-4 pb-24">
      <h2 className="text-lg font-bold text-white" data-testid="text-trade-title">Quick Trade</h2>

      <Card className="border-border/50">
        <CardContent className="p-4 space-y-4">
          <div>
            <div className="text-xs text-muted-foreground mb-2">Trading Pair</div>
            <div className="grid grid-cols-5 gap-1.5">
              {pairs.map((p) => (
                <Button
                  key={p}
                  variant={selectedPair === p ? "default" : "outline"}
                  size="sm"
                  onClick={() => setSelectedPair(p)}
                  className="text-[11px] px-1"
                  data-testid={`button-pair-${p}`}
                >
                  {p.replace("USDT", "")}
                </Button>
              ))}
            </div>
          </div>

          {currentPrice > 0 && (
            <div className="text-center py-3">
              <div className="text-xs text-muted-foreground">{selectedPair}</div>
              <div className="text-2xl font-bold text-white font-mono" data-testid="text-current-price">
                ${formatUsd(currentPrice)}
              </div>
            </div>
          )}

          <Separator />

          <div>
            <div className="flex items-center justify-between text-sm mb-2">
              <span className="text-muted-foreground">Leverage</span>
              <span className="text-white font-mono font-semibold">{leverage}x</span>
            </div>
            <Slider
              value={[leverage]}
              onValueChange={([v]) => setLeverage(v)}
              min={1}
              max={50}
              step={1}
              data-testid="slider-leverage"
            />
            <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
              <span>1x</span>
              <span>50x</span>
            </div>
          </div>

          <div>
            <div className="text-xs text-muted-foreground mb-2">Amount (USDT)</div>
            <Input
              type="number"
              placeholder="Enter amount"
              value={tradeAmount}
              onChange={(e) => setTradeAmount(e.target.value)}
              className="font-mono"
              data-testid="input-trade-amount"
            />
            {account?.availableMargin && (
              <div className="text-[10px] text-muted-foreground mt-1">
                Available: ${formatUsd(account.availableMargin)}
              </div>
            )}
          </div>

          {tradeAmount && currentPrice > 0 && (
            <div className="p-3 rounded-lg bg-card/80 border border-border/30 space-y-1.5">
              <div className="text-xs text-muted-foreground">Order Preview</div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Margin Required</span>
                <span className="text-white font-mono">${formatUsd(parseFloat(tradeAmount))}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Position Size</span>
                <span className="text-white font-mono">${formatUsd(parseFloat(tradeAmount) * leverage)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Est. Liq. Price</span>
                <span className="text-yellow-400 font-mono">
                  ~${formatUsd(currentPrice * (1 - 1 / leverage))}
                </span>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Button
              className="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold h-12"
              disabled={!tradeAmount || parseFloat(tradeAmount) < 1}
              data-testid="button-buy"
            >
              <TrendingUp className="w-4 h-4 mr-1.5" />
              Long / Buy
            </Button>
            <Button
              className="bg-red-600 hover:bg-red-700 text-white font-semibold h-12"
              disabled={!tradeAmount || parseFloat(tradeAmount) < 1}
              data-testid="button-sell"
            >
              <TrendingDown className="w-4 h-4 mr-1.5" />
              Short / Sell
            </Button>
          </div>

          <div className="text-center text-[10px] text-muted-foreground">
            Trades execute via Aster DEX V3 Pro API
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function MiniApp() {
  const [activeTab, setActiveTab] = useState("dashboard");

  useEffect(() => {
    try {
      const tg = (window as any).Telegram?.WebApp;
      if (tg) {
        tg.ready();
        tg.expand();
        tg.setHeaderColor("#0a0f0d");
        tg.setBackgroundColor("#0a0f0d");
      }
    } catch {}
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground max-w-md mx-auto" data-testid="miniapp-container">
      <div className="sticky top-0 z-50 bg-background/95 backdrop-blur-lg border-b border-border/50">
        <div className="px-4 py-3 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/20 flex items-center justify-center">
            <Zap className="w-5 h-5 text-emerald-400" />
          </div>
          <div>
            <div className="text-sm font-bold text-white">Aster Agent AI</div>
            <div className="text-[10px] text-muted-foreground">Autonomous Trading</div>
          </div>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsContent value="dashboard" className="mt-0 focus-visible:ring-0 focus-visible:ring-offset-0">
          <DashboardTab />
        </TabsContent>
        <TabsContent value="deposit" className="mt-0 focus-visible:ring-0 focus-visible:ring-offset-0">
          <DepositTab />
        </TabsContent>
        <TabsContent value="agent" className="mt-0 focus-visible:ring-0 focus-visible:ring-offset-0">
          <AgentTab />
        </TabsContent>
        <TabsContent value="trade" className="mt-0 focus-visible:ring-0 focus-visible:ring-offset-0">
          <TradeTab />
        </TabsContent>

        <div className="fixed bottom-0 left-0 right-0 z-50 bg-background/95 backdrop-blur-lg border-t border-border/50">
          <TabsList className="w-full max-w-md mx-auto h-14 bg-transparent rounded-none grid grid-cols-4 gap-0">
            <TabsTrigger
              value="dashboard"
              className="flex flex-col items-center gap-0.5 text-[10px] data-[state=active]:text-emerald-400 data-[state=active]:bg-transparent rounded-none h-full"
              data-testid="tab-dashboard"
            >
              <BarChart3 className="w-5 h-5" />
              Dashboard
            </TabsTrigger>
            <TabsTrigger
              value="deposit"
              className="flex flex-col items-center gap-0.5 text-[10px] data-[state=active]:text-emerald-400 data-[state=active]:bg-transparent rounded-none h-full"
              data-testid="tab-deposit"
            >
              <Wallet className="w-5 h-5" />
              Deposit
            </TabsTrigger>
            <TabsTrigger
              value="agent"
              className="flex flex-col items-center gap-0.5 text-[10px] data-[state=active]:text-emerald-400 data-[state=active]:bg-transparent rounded-none h-full"
              data-testid="tab-agent"
            >
              <Bot className="w-5 h-5" />
              Agent
            </TabsTrigger>
            <TabsTrigger
              value="trade"
              className="flex flex-col items-center gap-0.5 text-[10px] data-[state=active]:text-emerald-400 data-[state=active]:bg-transparent rounded-none h-full"
              data-testid="tab-trade"
            >
              <ArrowUpDown className="w-5 h-5" />
              Trade
            </TabsTrigger>
          </TabsList>
        </div>
      </Tabs>
    </div>
  );
}
