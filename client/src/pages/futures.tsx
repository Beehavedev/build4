import { useState, useEffect, useCallback } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Terminal,
  Wallet,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  Bot,
  Shield,
  Activity,
  DollarSign,
  BarChart3,
  ArrowUpDown,
  Copy,
  Check,
  AlertTriangle,
  Zap,
  Clock,
  ExternalLink,
  X,
  Menu,
  ChevronDown,
  LogOut,
} from "lucide-react";

declare global {
  interface Window {
    ethereum?: any;
  }
}

function formatUsd(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function PnlBadge({ value, size = "sm" }: { value: number; size?: "sm" | "lg" }) {
  const positive = value >= 0;
  const cls = size === "lg" ? "text-xl font-bold" : "text-sm font-semibold";
  return (
    <span className={`font-mono ${cls} ${positive ? "text-emerald-400" : "text-red-400"}`} data-testid="text-pnl-value">
      {positive ? "+" : ""}${formatUsd(value)}
    </span>
  );
}

function useWalletAddress() {
  const [address, setAddress] = useState<string | null>(() => {
    try { return localStorage.getItem("futures_wallet") || null; } catch { return null; }
  });
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async () => {
    if (!window.ethereum) {
      setError("MetaMask or a Web3 wallet is required");
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      if (accounts && accounts.length > 0) {
        const addr = accounts[0].toLowerCase();
        setAddress(addr);
        localStorage.setItem("futures_wallet", addr);
      }
    } catch (e: any) {
      setError(e.message || "Failed to connect wallet");
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setAddress(null);
    localStorage.removeItem("futures_wallet");
  }, []);

  useEffect(() => {
    if (!window.ethereum) return;
    const handleChange = (accounts: string[]) => {
      if (accounts.length > 0) {
        const addr = accounts[0].toLowerCase();
        setAddress(addr);
        localStorage.setItem("futures_wallet", addr);
      } else {
        disconnect();
      }
    };
    window.ethereum.on("accountsChanged", handleChange);
    return () => { window.ethereum?.removeListener("accountsChanged", handleChange); };
  }, [disconnect]);

  return { address, connecting, error, connect, disconnect };
}

function useWebApi<T>(endpoint: string, walletAddress: string | null, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!walletAddress) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        headers: { "x-wallet-address": walletAddress },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Request failed" }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setData(await res.json());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [endpoint, walletAddress, ...deps]);

  useEffect(() => { refresh(); }, [refresh]);

  return { data, loading, error, refresh };
}

async function webPost(endpoint: string, walletAddress: string, body: any) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-wallet-address": walletAddress,
    },
    body: JSON.stringify(body),
  });
  return res.json();
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

const TRADING_PAIRS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "DOGEUSDT",
  "XRPUSDT", "ADAUSDT", "AVAXUSDT", "DOTUSDT", "LINKUSDT",
  "MATICUSDT", "LTCUSDT", "UNIUSDT", "APTUSDT", "ARBUSDT",
  "OPUSDT", "SUIUSDT", "NEARUSDT",
];

function ConnectWalletScreen({ onConnect, connecting, error }: { onConnect: () => void; connecting: boolean; error: string | null }) {
  return (
    <div className="min-h-[80vh] flex items-center justify-center">
      <Card className="max-w-md w-full border-border/50 bg-card/50 backdrop-blur-sm">
        <CardContent className="p-8 text-center space-y-6">
          <div className="w-20 h-20 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto">
            <Wallet className="w-10 h-10 text-emerald-400" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-foreground mb-2" data-testid="text-connect-title">Connect Wallet</h2>
            <p className="text-muted-foreground text-sm">
              Connect your BSC wallet to access Aster DEX futures trading.
              Use the same wallet you linked in the Telegram bot.
            </p>
          </div>
          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {error}
            </div>
          )}
          <Button
            size="lg"
            className="w-full h-12 font-semibold"
            onClick={onConnect}
            disabled={connecting}
            data-testid="button-connect-wallet"
          >
            {connecting ? (
              <RefreshCw className="w-4 h-4 animate-spin mr-2" />
            ) : (
              <Wallet className="w-4 h-4 mr-2" />
            )}
            {connecting ? "Connecting..." : "Connect MetaMask"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Supports MetaMask, OKX Wallet, and other EVM wallets
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function AccountOverview({ account, onRefresh }: { account: AccountData; onRefresh: () => void }) {
  return (
    <div className="space-y-4" data-testid="account-overview">
      <Card className="bg-gradient-to-br from-emerald-500/10 to-emerald-600/5 border-emerald-500/20">
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm text-emerald-300/70">Available Futures Margin</div>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onRefresh} data-testid="button-refresh-account">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
          <div className="text-3xl font-bold text-foreground font-mono" data-testid="text-available-margin">
            ${formatUsd(account.availableMargin)}
          </div>
          <div className="flex items-center gap-6 mt-3 text-sm">
            <div className="flex items-center gap-1.5">
              <Wallet className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">BSC:</span>
              <span className="text-foreground font-mono" data-testid="text-bsc-balance">${formatUsd(account.bscBalance)}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <DollarSign className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">Spot:</span>
              <span className="text-foreground font-mono">${formatUsd(account.walletBalance)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3">
        <Card className="border-border/50">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground mb-1">Unrealized PnL</div>
            <PnlBadge value={account.unrealizedPnl} />
          </CardContent>
        </Card>
        <Card className="border-border/50">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground mb-1">Realized PnL</div>
            <PnlBadge value={account.realizedPnl} />
            {(account.wins + account.losses) > 0 && (
              <div className="text-xs text-muted-foreground mt-1">
                {account.wins}W / {account.losses}L ({Math.round(account.wins / (account.wins + account.losses) * 100)}%)
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function PositionsPanel({ positions, walletAddress, onRefresh }: { positions: Position[]; walletAddress: string; onRefresh: () => void }) {
  const [closing, setClosing] = useState<string | null>(null);

  const closePosition = async (symbol: string) => {
    setClosing(symbol);
    try {
      await webPost("/api/miniapp/close", walletAddress, { symbol });
      setTimeout(onRefresh, 1000);
    } catch {} finally {
      setClosing(null);
    }
  };

  if (positions.length === 0) {
    return (
      <Card className="border-border/50">
        <CardContent className="p-6 text-center">
          <Activity className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No open positions</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border/50">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Activity className="w-4 h-4 text-emerald-400" />
          Open Positions ({positions.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground border-b border-border/30">
                <th className="text-left py-2 font-medium">Pair</th>
                <th className="text-left py-2 font-medium">Side</th>
                <th className="text-right py-2 font-medium">Size</th>
                <th className="text-right py-2 font-medium">Entry</th>
                <th className="text-right py-2 font-medium">Mark</th>
                <th className="text-right py-2 font-medium">Lev.</th>
                <th className="text-right py-2 font-medium">PnL</th>
                <th className="text-right py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {positions.map((pos, i) => (
                <tr key={i} className="border-b border-border/20 last:border-0" data-testid={`position-row-${i}`}>
                  <td className="py-2.5 font-semibold text-foreground">{pos.symbol.replace("USDT", "")}</td>
                  <td className="py-2.5">
                    <Badge variant={pos.side === "LONG" ? "default" : "destructive"} className="text-xs px-1.5 py-0">
                      {pos.side}
                    </Badge>
                  </td>
                  <td className="py-2.5 text-right font-mono text-foreground">{pos.size}</td>
                  <td className="py-2.5 text-right font-mono text-muted-foreground">${formatUsd(pos.entryPrice)}</td>
                  <td className="py-2.5 text-right font-mono text-foreground">${formatUsd(pos.markPrice)}</td>
                  <td className="py-2.5 text-right font-mono text-muted-foreground">{pos.leverage}x</td>
                  <td className="py-2.5 text-right"><PnlBadge value={pos.unrealizedPnl} /></td>
                  <td className="py-2.5 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10"
                      onClick={() => closePosition(pos.symbol)}
                      disabled={closing === pos.symbol}
                      data-testid={`button-close-${pos.symbol}`}
                    >
                      {closing === pos.symbol ? <RefreshCw className="w-3 h-3 animate-spin" /> : "Close"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function MarketsPanel({ markets, selectedPair, onSelect }: { markets: { symbol: string; price: number }[]; selectedPair: string; onSelect: (s: string) => void }) {
  return (
    <Card className="border-border/50">
      <CardHeader className="p-3 pb-2">
        <CardTitle className="text-xs font-semibold flex items-center gap-2">
          <BarChart3 className="w-3.5 h-3.5 text-blue-400" />
          Markets
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-0 space-y-0.5">
        {markets.map((m) => (
          <button
            key={m.symbol}
            onClick={() => onSelect(m.symbol)}
            className={`w-full flex items-center justify-between py-2 px-2.5 rounded text-sm transition-colors ${
              selectedPair === m.symbol
                ? "bg-emerald-500/10 border border-emerald-500/20"
                : "hover:bg-card/80"
            }`}
            data-testid={`market-${m.symbol}`}
          >
            <span className={`font-medium ${selectedPair === m.symbol ? "text-emerald-400" : "text-foreground"}`}>
              {m.symbol.replace("USDT", "")}
            </span>
            <span className="font-mono text-xs text-muted-foreground">${formatUsd(m.price)}</span>
          </button>
        ))}
      </CardContent>
    </Card>
  );
}

function TradingPanel({
  walletAddress,
  selectedPair,
  currentPrice,
  availableMargin,
  onTradeComplete,
}: {
  walletAddress: string;
  selectedPair: string;
  currentPrice: number;
  availableMargin: number;
  onTradeComplete: () => void;
}) {
  const [leverage, setLeverage] = useState(10);
  const [tradeAmount, setTradeAmount] = useState("");
  const [submitting, setSubmitting] = useState<"BUY" | "SELL" | null>(null);
  const [result, setResult] = useState<{ success: boolean; error?: string } | null>(null);

  const handleTrade = async (side: "BUY" | "SELL") => {
    const amount = parseFloat(tradeAmount);
    if (!amount || amount < 1) return;
    setSubmitting(side);
    setResult(null);
    try {
      const data = await webPost("/api/miniapp/trade", walletAddress, {
        symbol: selectedPair,
        side,
        amount,
        leverage,
      });
      if (data.success) {
        setResult({ success: true });
        setTradeAmount("");
        setTimeout(onTradeComplete, 1500);
      } else {
        setResult({ success: false, error: data.error || "Trade failed" });
      }
    } catch (e: any) {
      setResult({ success: false, error: e.message });
    } finally {
      setSubmitting(null);
    }
  };

  const amount = parseFloat(tradeAmount) || 0;
  const presets = [10, 25, 50, 100];

  return (
    <Card className="border-border/50">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <ArrowUpDown className="w-4 h-4 text-emerald-400" />
          Trade {selectedPair.replace("USDT", "/USDT")}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-2 space-y-4">
        {currentPrice > 0 && (
          <div className="text-center py-2">
            <div className="text-xs text-muted-foreground">Market Price</div>
            <div className="text-2xl font-bold text-foreground font-mono" data-testid="text-current-price">
              ${formatUsd(currentPrice)}
            </div>
          </div>
        )}

        <div>
          <div className="flex items-center justify-between text-sm mb-2">
            <span className="text-muted-foreground">Leverage</span>
            <span className="text-foreground font-mono font-semibold">{leverage}x</span>
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
            <span>25x</span>
            <span>50x</span>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
            <span>Amount (USDT margin)</span>
            <span>Avail: ${formatUsd(availableMargin)}</span>
          </div>
          <Input
            type="number"
            placeholder="Enter margin amount"
            value={tradeAmount}
            onChange={(e) => setTradeAmount(e.target.value)}
            className="font-mono"
            data-testid="input-trade-amount"
          />
          <div className="grid grid-cols-4 gap-1.5 mt-2">
            {presets.map((v) => (
              <Button
                key={v}
                variant="outline"
                size="sm"
                className="text-xs font-mono"
                onClick={() => setTradeAmount(String(v))}
                data-testid={`button-amount-${v}`}
              >
                ${v}
              </Button>
            ))}
          </div>
        </div>

        {amount > 0 && currentPrice > 0 && (
          <div className="p-3 rounded-lg bg-card/80 border border-border/30 space-y-1.5">
            <div className="text-xs text-muted-foreground font-medium">Order Preview</div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Margin</span>
              <span className="text-foreground font-mono">${formatUsd(amount)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Position Size</span>
              <span className="text-foreground font-mono">${formatUsd(amount * leverage)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Est. Liq. (Long)</span>
              <span className="text-yellow-400 font-mono">~${formatUsd(currentPrice * (1 - 1 / leverage))}</span>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Button
            className="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold h-11"
            disabled={!amount || amount < 1 || !!submitting}
            onClick={() => handleTrade("BUY")}
            data-testid="button-long"
          >
            {submitting === "BUY" ? (
              <RefreshCw className="w-4 h-4 animate-spin mr-1.5" />
            ) : (
              <TrendingUp className="w-4 h-4 mr-1.5" />
            )}
            Long
          </Button>
          <Button
            className="bg-red-600 hover:bg-red-700 text-white font-semibold h-11"
            disabled={!amount || amount < 1 || !!submitting}
            onClick={() => handleTrade("SELL")}
            data-testid="button-short"
          >
            {submitting === "SELL" ? (
              <RefreshCw className="w-4 h-4 animate-spin mr-1.5" />
            ) : (
              <TrendingDown className="w-4 h-4 mr-1.5" />
            )}
            Short
          </Button>
        </div>

        {result && (
          <div className={`p-3 rounded-lg border text-sm ${
            result.success
              ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-300"
              : "bg-red-500/10 border-red-500/20 text-red-300"
          }`}>
            {result.success ? "Order submitted successfully!" : result.error}
          </div>
        )}

        <div className="text-center text-[10px] text-muted-foreground">
          Trades execute on Aster DEX via BUILD4 Broker
        </div>
      </CardContent>
    </Card>
  );
}

function AgentPanel({ walletAddress }: { walletAddress: string }) {
  const { data: agent, loading, refresh } = useWebApi<AgentData>("/api/miniapp/agent", walletAddress);
  const [toggling, setToggling] = useState(false);
  const [riskPercent, setRiskPercent] = useState(1.0);

  useEffect(() => {
    if (agent?.config?.riskPercent) setRiskPercent(agent.config.riskPercent);
  }, [agent?.config?.riskPercent]);

  const toggleAgent = async () => {
    setToggling(true);
    try {
      await webPost("/api/miniapp/agent/toggle", walletAddress, {});
      await refresh();
    } catch {} finally {
      setToggling(false);
    }
  };

  if (loading && !agent) {
    return <Skeleton className="h-48 w-full" />;
  }

  const isRunning = agent?.running || false;
  const stats = agent?.stats;
  const winRate = stats && (stats.winCount + stats.lossCount) > 0
    ? Math.round(stats.winCount / (stats.winCount + stats.lossCount) * 100)
    : 0;

  return (
    <div className="space-y-4">
      <Card className={`border-2 transition-all ${isRunning ? "border-emerald-500/40 bg-emerald-500/5" : "border-border/50"}`}>
        <CardContent className="p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${isRunning ? "bg-emerald-500/20" : "bg-muted"}`}>
                <Bot className={`w-5 h-5 ${isRunning ? "text-emerald-400" : "text-muted-foreground"}`} />
              </div>
              <div>
                <div className="text-foreground font-semibold text-sm">AI Trading Agent</div>
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
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge variant="outline" className="text-xs">{agent.config.symbol}</Badge>
              <Badge variant="outline" className="text-xs">{agent.config.maxLeverage}x max</Badge>
              <Badge variant="outline" className="text-xs">{agent.config.riskPercent}% risk</Badge>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-border/50">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Shield className="w-4 h-4 text-blue-400" />
            Risk Settings
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-2 space-y-3">
          <div>
            <div className="flex items-center justify-between text-sm mb-2">
              <span className="text-muted-foreground">Risk per Trade</span>
              <span className="text-foreground font-mono">{riskPercent.toFixed(1)}%</span>
            </div>
            <Slider
              value={[riskPercent]}
              onValueChange={([v]) => setRiskPercent(v)}
              min={0.5}
              max={3}
              step={0.1}
              data-testid="slider-risk"
            />
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Max Leverage</span>
            <span className="text-foreground font-mono">{agent?.config?.maxLeverage || 10}x</span>
          </div>
        </CardContent>
      </Card>

      {stats && (
        <Card className="border-border/50">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-purple-400" />
              Agent Performance
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-lg bg-card/50">
                <div className="text-[10px] text-muted-foreground">Total Trades</div>
                <div className="text-lg font-mono text-foreground" data-testid="text-agent-trades">{stats.tradeCount}</div>
              </div>
              <div className="p-3 rounded-lg bg-card/50">
                <div className="text-[10px] text-muted-foreground">Win Rate</div>
                <div className="text-lg font-mono text-foreground">{winRate}%</div>
              </div>
              <div className="p-3 rounded-lg bg-card/50">
                <div className="text-[10px] text-muted-foreground">Total PnL</div>
                <PnlBadge value={stats.totalPnl} />
              </div>
              <div className="p-3 rounded-lg bg-card/50">
                <div className="text-[10px] text-muted-foreground">W / L</div>
                <div className="text-lg font-mono">
                  <span className="text-emerald-400">{stats.winCount}</span>
                  {" / "}
                  <span className="text-red-400">{stats.lossCount}</span>
                </div>
              </div>
            </div>
            {stats.lastAction && (
              <div className="mt-3 p-3 rounded-lg bg-blue-500/5 border border-blue-500/10">
                <div className="text-[10px] text-blue-300/70 mb-1">Last Action</div>
                <div className="text-sm text-foreground">{stats.lastAction}</div>
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

function RecentIncomePanel({ income }: { income: IncomeEntry[] }) {
  if (income.length === 0) return null;
  return (
    <Card className="border-border/50">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Clock className="w-4 h-4 text-orange-400" />
          Recent PnL
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0 space-y-1">
        {income.slice(0, 8).map((inc, i) => (
          <div key={i} className="flex items-center justify-between text-xs py-1.5 border-b border-border/20 last:border-0">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">{inc.symbol.replace("USDT", "")}</span>
              <Badge variant="outline" className="text-[10px] px-1 py-0">{inc.type}</Badge>
            </div>
            <PnlBadge value={inc.amount} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function RegisterOrErrorScreen({
  error,
  walletAddress,
  onRegistered,
  onRetry,
}: {
  error: string;
  walletAddress: string;
  onRegistered: () => void;
  onRetry: () => void;
}) {
  const [registering, setRegistering] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);
  const [regResult, setRegResult] = useState<{ success: boolean; asterLinked: boolean; botWalletAddress?: string } | null>(null);

  const isNotLinked = error.includes("not linked") || error.includes("not found") || error.includes("404");

  const handleRegister = async () => {
    setRegistering(true);
    setRegError(null);
    try {
      const res = await fetch("/api/miniapp/web-register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress }),
      });
      const data = await res.json();
      if (data.success) {
        setRegResult(data);
        setTimeout(onRegistered, 1500);
      } else {
        setRegError(data.error || "Registration failed");
      }
    } catch (e: any) {
      setRegError(e.message);
    } finally {
      setRegistering(false);
    }
  };

  if (regResult?.success) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <div className="w-16 h-16 rounded-full bg-emerald-500/10 flex items-center justify-center">
          <Check className="w-8 h-8 text-emerald-400" />
        </div>
        <h3 className="text-lg font-semibold text-foreground" data-testid="text-register-success">Account Created!</h3>
        <p className="text-muted-foreground text-sm text-center max-w-md">
          {regResult.asterLinked
            ? "Your account is set up and connected to Aster DEX. Loading your dashboard..."
            : "Your account is created. Aster DEX connection will be completed shortly. Loading..."}
        </p>
        <RefreshCw className="w-5 h-5 text-emerald-400 animate-spin" />
      </div>
    );
  }

  if (isNotLinked) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <div className="w-20 h-20 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
          <Zap className="w-10 h-10 text-emerald-400" />
        </div>
        <h3 className="text-xl font-bold text-foreground" data-testid="text-register-title">Welcome to BUILD4 Futures</h3>
        <p className="text-muted-foreground text-sm text-center max-w-md">
          Trade perpetual futures on Aster DEX with AI-powered autonomous agents.
          Create your account in one click to get started.
        </p>

        <Card className="max-w-md w-full border-border/50">
          <CardContent className="p-6 space-y-4">
            <div className="flex items-center gap-3 p-3 rounded-lg bg-card/80 border border-border/30">
              <Wallet className="w-5 h-5 text-emerald-400 shrink-0" />
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">Your Wallet</div>
                <div className="text-sm font-mono text-foreground truncate" data-testid="text-register-wallet">
                  {walletAddress}
                </div>
              </div>
            </div>

            <div className="space-y-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-2">
                <Shield className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                <span>A secure trading wallet is generated server-side for your account</span>
              </div>
              <div className="flex items-center gap-2">
                <Bot className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                <span>AI trading agent included — enable it anytime</span>
              </div>
              <div className="flex items-center gap-2">
                <ArrowUpDown className="w-3.5 h-3.5 text-orange-400 shrink-0" />
                <span>18 trading pairs with up to 50x leverage on Aster DEX</span>
              </div>
            </div>

            {regError && (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                {regError}
              </div>
            )}

            <Button
              size="lg"
              className="w-full h-12 font-semibold"
              onClick={handleRegister}
              disabled={registering}
              data-testid="button-register"
            >
              {registering ? (
                <RefreshCw className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <Zap className="w-4 h-4 mr-2" />
              )}
              {registering ? "Creating Account..." : "Create Account"}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
      <div className="w-16 h-16 rounded-full bg-yellow-500/10 flex items-center justify-center">
        <AlertTriangle className="w-8 h-8 text-yellow-500" />
      </div>
      <h3 className="text-lg font-semibold text-foreground">Connection Issue</h3>
      <p className="text-muted-foreground text-sm text-center max-w-md" data-testid="text-error-message">
        {error}
      </p>
      <Button variant="outline" onClick={onRetry} data-testid="button-retry">
        <RefreshCw className="w-4 h-4 mr-1.5" />
        Retry
      </Button>
    </div>
  );
}

function NotConnectedScreen({ walletAddress, onConnected }: { walletAddress: string; onConnected: () => void }) {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConnect = async () => {
    setConnecting(true);
    setError(null);
    try {
      const res = await fetch("/api/miniapp/link-aster", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-wallet-address": walletAddress,
        },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (data.success) {
        setTimeout(onConnected, 1500);
      } else {
        setError(data.error || "Connection failed");
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
      <div className="w-16 h-16 rounded-full bg-blue-500/10 flex items-center justify-center">
        <Activity className="w-8 h-8 text-blue-400" />
      </div>
      <h3 className="text-lg font-semibold text-foreground" data-testid="text-connect-aster-title">Connect to Aster DEX</h3>
      <p className="text-muted-foreground text-sm text-center max-w-md">
        Your account is set up. Connect to Aster DEX to start trading futures.
      </p>
      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm max-w-md text-center">
          {error}
        </div>
      )}
      <Button
        size="lg"
        className="h-12 font-semibold px-8"
        onClick={handleConnect}
        disabled={connecting}
        data-testid="button-connect-aster"
      >
        {connecting ? (
          <RefreshCw className="w-4 h-4 animate-spin mr-2" />
        ) : (
          <Zap className="w-4 h-4 mr-2" />
        )}
        {connecting ? "Connecting..." : "Connect to Aster DEX"}
      </Button>
    </div>
  );
}

export default function FuturesPage() {
  const { address, connecting, error: walletError, connect, disconnect } = useWalletAddress();
  const [selectedPair, setSelectedPair] = useState("BTCUSDT");
  const [activeTab, setActiveTab] = useState("trade");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const { data: account, loading: accountLoading, error: accountError, refresh: refreshAccount } =
    useWebApi<AccountData>("/api/miniapp/account", address);
  const { data: markets, refresh: refreshMarkets } =
    useWebApi<MarketData>("/api/miniapp/markets", address);

  useEffect(() => {
    if (!address) return;
    const interval = setInterval(() => {
      refreshAccount();
      refreshMarkets();
    }, 30000);
    return () => clearInterval(interval);
  }, [address, refreshAccount, refreshMarkets]);

  const currentPrice = markets?.markets?.find((m) => m.symbol === selectedPair)?.price || 0;

  return (
    <div className="min-h-screen bg-background text-foreground" data-testid="futures-page">
      <nav className="sticky top-0 z-50 bg-background/90 backdrop-blur-xl border-b">
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Link href="/">
              <div className="flex items-center gap-2 cursor-pointer">
                <div className="w-7 h-7 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center">
                  <Terminal className="w-4 h-4 text-primary" />
                </div>
                <span className="font-mono font-bold text-sm tracking-wide" data-testid="text-logo">
                  BUILD<span className="text-primary">4</span>
                </span>
              </div>
            </Link>
            <Separator orientation="vertical" className="h-5 mx-2 hidden sm:block" />
            <div className="hidden sm:flex items-center gap-1.5">
              <Zap className="w-4 h-4 text-emerald-400" />
              <span className="font-mono text-sm text-emerald-400 font-semibold tracking-wide">Futures</span>
            </div>
          </div>

          <div className="hidden md:flex items-center gap-4">
            <Link href="/" className="text-xs text-muted-foreground font-mono tracking-wide hover:text-foreground transition-colors" data-testid="link-home">Home</Link>
            <Link href="/autonomous-economy" className="text-xs text-muted-foreground font-mono tracking-wide hover:text-foreground transition-colors" data-testid="link-economy">Economy</Link>
            <Link href="/agentic_bot" className="text-xs text-muted-foreground font-mono tracking-wide hover:text-foreground transition-colors" data-testid="link-bot">Telegram Bot</Link>

            {address ? (
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                  <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-xs font-mono text-emerald-400" data-testid="text-wallet-address">
                    {address.slice(0, 6)}...{address.slice(-4)}
                  </span>
                </div>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={disconnect} data-testid="button-disconnect">
                  <LogOut className="w-3.5 h-3.5" />
                </Button>
              </div>
            ) : (
              <Button size="sm" onClick={connect} disabled={connecting} data-testid="button-nav-connect">
                <Wallet className="w-3.5 h-3.5 mr-1.5" />
                Connect
              </Button>
            )}
          </div>

          <div className="flex md:hidden items-center gap-2">
            {address && (
              <span className="text-xs font-mono text-emerald-400">
                {address.slice(0, 6)}...{address.slice(-4)}
              </span>
            )}
            <Button variant="ghost" size="icon" onClick={() => setMobileMenuOpen(!mobileMenuOpen)} data-testid="button-mobile-menu">
              {mobileMenuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
            </Button>
          </div>
        </div>
        {mobileMenuOpen && (
          <div className="md:hidden border-t bg-background/95 backdrop-blur-xl px-4 py-3 space-y-2">
            <Link href="/" className="block py-2 text-sm text-muted-foreground font-mono">Home</Link>
            <Link href="/autonomous-economy" className="block py-2 text-sm text-muted-foreground font-mono">Economy</Link>
            {address ? (
              <Button variant="outline" size="sm" className="w-full" onClick={disconnect}>
                <LogOut className="w-3.5 h-3.5 mr-1.5" />
                Disconnect
              </Button>
            ) : (
              <Button size="sm" className="w-full" onClick={connect} disabled={connecting}>
                <Wallet className="w-3.5 h-3.5 mr-1.5" />
                Connect Wallet
              </Button>
            )}
          </div>
        )}
      </nav>

      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-6">
        {!address ? (
          <ConnectWalletScreen onConnect={connect} connecting={connecting} error={walletError} />
        ) : accountLoading && !account ? (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-3 space-y-4">
              <Skeleton className="h-48 w-full" />
              <Skeleton className="h-96 w-full" />
            </div>
            <div className="lg:col-span-6 space-y-4">
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-64 w-full" />
            </div>
            <div className="lg:col-span-3 space-y-4">
              <Skeleton className="h-48 w-full" />
              <Skeleton className="h-64 w-full" />
            </div>
          </div>
        ) : accountError ? (
          <RegisterOrErrorScreen
            error={accountError}
            walletAddress={address}
            onRegistered={refreshAccount}
            onRetry={refreshAccount}
          />
        ) : !account?.connected ? (
          <NotConnectedScreen walletAddress={address} onConnected={refreshAccount} />
        ) : (
          <>
            <div className="hidden lg:grid grid-cols-12 gap-6">
              <div className="col-span-3 space-y-4">
                {markets?.markets && (
                  <MarketsPanel
                    markets={markets.markets}
                    selectedPair={selectedPair}
                    onSelect={setSelectedPair}
                  />
                )}
              </div>

              <div className="col-span-6 space-y-4">
                <AccountOverview account={account} onRefresh={refreshAccount} />
                <PositionsPanel
                  positions={account.positions}
                  walletAddress={address}
                  onRefresh={refreshAccount}
                />
                <RecentIncomePanel income={account.recentIncome} />
              </div>

              <div className="col-span-3 space-y-4">
                <TradingPanel
                  walletAddress={address}
                  selectedPair={selectedPair}
                  currentPrice={currentPrice}
                  availableMargin={account.availableMargin}
                  onTradeComplete={refreshAccount}
                />
                <AgentPanel walletAddress={address} />
              </div>
            </div>

            <div className="lg:hidden">
              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="w-full grid grid-cols-4 mb-4">
                  <TabsTrigger value="trade" className="text-xs" data-testid="tab-trade">
                    <ArrowUpDown className="w-3.5 h-3.5 mr-1" />
                    Trade
                  </TabsTrigger>
                  <TabsTrigger value="account" className="text-xs" data-testid="tab-account">
                    <Wallet className="w-3.5 h-3.5 mr-1" />
                    Account
                  </TabsTrigger>
                  <TabsTrigger value="markets" className="text-xs" data-testid="tab-markets">
                    <BarChart3 className="w-3.5 h-3.5 mr-1" />
                    Markets
                  </TabsTrigger>
                  <TabsTrigger value="agent" className="text-xs" data-testid="tab-agent">
                    <Bot className="w-3.5 h-3.5 mr-1" />
                    Agent
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="trade" className="space-y-4 mt-0">
                  <TradingPanel
                    walletAddress={address}
                    selectedPair={selectedPair}
                    currentPrice={currentPrice}
                    availableMargin={account.availableMargin}
                    onTradeComplete={refreshAccount}
                  />
                </TabsContent>

                <TabsContent value="account" className="space-y-4 mt-0">
                  <AccountOverview account={account} onRefresh={refreshAccount} />
                  <PositionsPanel
                    positions={account.positions}
                    walletAddress={address}
                    onRefresh={refreshAccount}
                  />
                  <RecentIncomePanel income={account.recentIncome} />
                </TabsContent>

                <TabsContent value="markets" className="mt-0">
                  {markets?.markets && (
                    <MarketsPanel
                      markets={markets.markets}
                      selectedPair={selectedPair}
                      onSelect={(s) => { setSelectedPair(s); setActiveTab("trade"); }}
                    />
                  )}
                </TabsContent>

                <TabsContent value="agent" className="mt-0">
                  <AgentPanel walletAddress={address} />
                </TabsContent>
              </Tabs>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
