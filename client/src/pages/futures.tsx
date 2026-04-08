import { useState, useEffect, useCallback, useRef, useMemo, Component } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

import {
  Terminal,
  Wallet,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  Bot,
  Activity,
  DollarSign,
  BarChart3,
  ArrowUpDown,
  Check,
  AlertTriangle,
  Zap,
  Clock,
  X,
  ChevronDown,
  LogOut,
  Search,
  Star,
  Maximize2,
  Minimize2,
  Percent,
} from "lucide-react";
import { createChart, ColorType, CrosshairMode, LineStyle, CandlestickData, Time } from "lightweight-charts";

declare global {
  interface Window {
    ethereum?: any;
  }
}

function formatUsd(n: number | undefined | null): string {
  if (n == null || isNaN(n)) return "0.00";
  if (Math.abs(n) >= 100) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (Math.abs(n) >= 1) return n.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  if (Math.abs(n) >= 0.01) return n.toLocaleString("en-US", { minimumFractionDigits: 6, maximumFractionDigits: 6 });
  return n.toLocaleString("en-US", { minimumFractionDigits: 8, maximumFractionDigits: 8 });
}

function formatCompact(n: number | undefined | null): string {
  if (n == null || isNaN(n)) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toFixed(2);
}

function PnlBadge({ value, size = "sm" }: { value: number | undefined | null; size?: "sm" | "lg" }) {
  const v = value ?? 0;
  const positive = v >= 0;
  const cls = size === "lg" ? "text-lg font-bold" : "text-xs font-semibold";
  return (
    <span className={`font-mono ${cls} ${positive ? "text-emerald-400" : "text-red-400"}`} data-testid="text-pnl-value">
      {positive ? "+" : ""}${formatUsd(v)}
    </span>
  );
}

class FuturesErrorBoundary extends Component<
  { children: any },
  { hasError: boolean; error: string }
> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: "" };
  }
  static getDerivedStateFromError(error: any) {
    return { hasError: true, error: error?.message || "Unknown error" };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen flex items-center justify-center bg-[hsl(160,10%,3%)] text-white">
          <div className="text-center space-y-3">
            <AlertTriangle className="w-8 h-8 text-yellow-400 mx-auto" />
            <p className="text-sm font-semibold">Something went wrong</p>
            <p className="text-xs text-gray-400 max-w-xs">{this.state.error}</p>
            <button
              onClick={() => { this.setState({ hasError: false, error: "" }); window.location.reload(); }}
              className="px-4 py-2 text-xs bg-emerald-500/20 border border-emerald-500/30 rounded hover:bg-emerald-500/30 transition-colors"
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
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

function usePublicApi<T>(endpoint: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(endpoint);
      if (res.ok) setData(await res.json());
    } catch {} finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => { refresh(); }, [refresh]);

  return { data, loading, refresh };
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

interface TickerData {
  symbol: string;
  priceChange: string;
  priceChangePercent: string;
  lastPrice: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume: string;
}

interface OrderBookData {
  bids: [string, string][];
  asks: [string, string][];
}

const TRADING_PAIRS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "DOGEUSDT",
  "XRPUSDT", "ADAUSDT", "AVAXUSDT", "DOTUSDT", "LINKUSDT",
  "MATICUSDT", "LTCUSDT", "UNIUSDT", "APTUSDT", "ARBUSDT",
  "OPUSDT", "SUIUSDT", "NEARUSDT",
];

const TIMEFRAMES = [
  { label: "1m", value: "1m" },
  { label: "5m", value: "5m" },
  { label: "15m", value: "15m" },
  { label: "1H", value: "1h" },
  { label: "4H", value: "4h" },
  { label: "1D", value: "1d" },
  { label: "1W", value: "1w" },
];

function TradingChart({
  symbol,
  interval,
  positions,
}: {
  symbol: string;
  interval: string;
  positions?: Position[];
}) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const candleSeriesRef = useRef<any>(null);
  const volumeSeriesRef = useRef<any>(null);
  const priceLinesRef = useRef<any[]>([]);
  const [chartData, setChartData] = useState<any[]>([]);

  useEffect(() => {
    const fetchKlines = async () => {
      try {
        const res = await fetch(`/api/public/klines?symbol=${symbol}&interval=${interval}&limit=300`);
        if (res.ok) {
          const data = await res.json();
          setChartData(data);
        }
      } catch {}
    };
    fetchKlines();
    const iv = setInterval(fetchKlines, 10000);
    return () => clearInterval(iv);
  }, [symbol, interval]);

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const container = chartContainerRef.current;

    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "rgba(255,255,255,0.5)",
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.03)" },
        horzLines: { color: "rgba(255,255,255,0.03)" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(255,255,255,0.15)", style: LineStyle.Dashed, width: 1, labelBackgroundColor: "rgba(16,185,129,0.9)" },
        horzLine: { color: "rgba(255,255,255,0.15)", style: LineStyle.Dashed, width: 1, labelBackgroundColor: "rgba(16,185,129,0.9)" },
      },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.06)",
        scaleMargins: { top: 0.1, bottom: 0.25 },
      },
      timeScale: {
        borderColor: "rgba(255,255,255,0.06)",
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: { vertTouchDrag: false },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#10b981",
      downColor: "#ef4444",
      borderUpColor: "#10b981",
      borderDownColor: "#ef4444",
      wickUpColor: "#10b981",
      wickDownColor: "#ef4444",
    });

    const volumeSeries = chart.addHistogramSeries({
      color: "rgba(16,185,129,0.15)",
      priceFormat: { type: "volume" },
      priceScaleId: "",
    });

    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    const handleResize = () => {
      if (container && chart) {
        chart.applyOptions({
          width: container.clientWidth,
          height: container.clientHeight,
        });
      }
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current || !chartData.length) return;

    const candles: CandlestickData<Time>[] = chartData.map((k: any) => ({
      time: (k[0] || k.openTime) / 1000 as Time,
      open: parseFloat(k[1] || k.open),
      high: parseFloat(k[2] || k.high),
      low: parseFloat(k[3] || k.low),
      close: parseFloat(k[4] || k.close),
    }));

    const volumes = chartData.map((k: any) => ({
      time: (k[0] || k.openTime) / 1000 as Time,
      value: parseFloat(k[5] || k.volume || "0"),
      color: parseFloat(k[4] || k.close) >= parseFloat(k[1] || k.open)
        ? "rgba(16,185,129,0.2)"
        : "rgba(239,68,68,0.2)",
    }));

    candleSeriesRef.current.setData(candles);
    volumeSeriesRef.current.setData(volumes);

    priceLinesRef.current.forEach(line => {
      try { candleSeriesRef.current.removePriceLine(line); } catch {}
    });
    priceLinesRef.current = [];

    if (positions && positions.length > 0 && chartRef.current) {
      positions.forEach((pos) => {
        if (pos.symbol === symbol) {
          const line = candleSeriesRef.current.createPriceLine({
            price: pos.entryPrice,
            color: pos.side === "LONG" ? "#10b981" : "#ef4444",
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: `${pos.side} Entry`,
          });
          priceLinesRef.current.push(line);
        }
      });
    }

    chartRef.current?.timeScale().fitContent();
  }, [chartData, symbol, positions]);

  return (
    <div ref={chartContainerRef} className="w-full h-full" data-testid="trading-chart" />
  );
}

function OrderBook({
  symbol,
}: {
  symbol: string;
}) {
  const [book, setBook] = useState<OrderBookData | null>(null);
  const [spread, setSpread] = useState(0);

  useEffect(() => {
    const fetchBook = async () => {
      try {
        const res = await fetch(`/api/public/depth?symbol=${symbol}&limit=20`);
        if (res.ok) {
          const data = await res.json();
          setBook(data);
          if (data.asks?.[0] && data.bids?.[0]) {
            setSpread(parseFloat(data.asks[0][0]) - parseFloat(data.bids[0][0]));
          }
        }
      } catch {}
    };
    fetchBook();
    const iv = setInterval(fetchBook, 3000);
    return () => clearInterval(iv);
  }, [symbol]);

  if (!book) {
    return (
      <div className="p-4 space-y-1">
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </div>
    );
  }

  const asks = [...(book.asks || [])].slice(0, 10).reverse();
  const bids = (book.bids || []).slice(0, 10);
  const maxAskQty = Math.max(...asks.map(a => parseFloat(a[1])), 0.001);
  const maxBidQty = Math.max(...bids.map(b => parseFloat(b[1])), 0.001);

  return (
    <div className="text-[11px] font-mono" data-testid="order-book">
      <div className="grid grid-cols-3 text-[10px] text-muted-foreground/60 px-2 py-1.5 border-b border-white/5">
        <span>Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Total</span>
      </div>

      <div className="space-y-px">
        {asks.map(([price, qty], i) => {
          const pct = (parseFloat(qty) / maxAskQty) * 100;
          return (
            <div key={`a-${i}`} className="relative grid grid-cols-3 px-2 py-[3px] hover:bg-white/[0.02] group">
              <div className="absolute inset-y-0 right-0 bg-red-500/[0.06]" style={{ width: `${pct}%` }} />
              <span className="relative text-red-400">{formatUsd(parseFloat(price))}</span>
              <span className="relative text-right text-muted-foreground">{parseFloat(qty).toFixed(4)}</span>
              <span className="relative text-right text-muted-foreground/60">{formatCompact(parseFloat(price) * parseFloat(qty))}</span>
            </div>
          );
        })}
      </div>

      <div className="px-2 py-2 border-y border-white/5 flex items-center justify-between">
        <span className="text-emerald-400 font-semibold text-sm">
          {bids[0] ? formatUsd(parseFloat(bids[0][0])) : "--"}
        </span>
        <span className="text-[10px] text-muted-foreground">Spread: {formatUsd(spread)}</span>
      </div>

      <div className="space-y-px">
        {bids.map(([price, qty], i) => {
          const pct = (parseFloat(qty) / maxBidQty) * 100;
          return (
            <div key={`b-${i}`} className="relative grid grid-cols-3 px-2 py-[3px] hover:bg-white/[0.02] group">
              <div className="absolute inset-y-0 right-0 bg-emerald-500/[0.06]" style={{ width: `${pct}%` }} />
              <span className="relative text-emerald-400">{formatUsd(parseFloat(price))}</span>
              <span className="relative text-right text-muted-foreground">{parseFloat(qty).toFixed(4)}</span>
              <span className="relative text-right text-muted-foreground/60">{formatCompact(parseFloat(price) * parseFloat(qty))}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PairSelector({
  markets,
  selectedPair,
  onSelect,
  onClose,
}: {
  markets: { symbol: string; price: number }[];
  selectedPair: string;
  onSelect: (s: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [favorites, setFavorites] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("fav_pairs") || "[]"); } catch { return []; }
  });

  const toggleFav = (sym: string) => {
    const next = favorites.includes(sym) ? favorites.filter(f => f !== sym) : [...favorites, sym];
    setFavorites(next);
    localStorage.setItem("fav_pairs", JSON.stringify(next));
  };

  const filtered = markets.filter(m =>
    m.symbol.toLowerCase().includes(search.toLowerCase())
  );

  const sorted = [...filtered].sort((a, b) => {
    const aFav = favorites.includes(a.symbol) ? 0 : 1;
    const bFav = favorites.includes(b.symbol) ? 0 : 1;
    return aFav - bFav;
  });

  return (
    <div className="absolute top-full left-0 mt-1 w-80 bg-[hsl(160,10%,6%)] border border-white/10 rounded-lg shadow-2xl z-50 overflow-hidden" data-testid="pair-selector">
      <div className="p-2 border-b border-white/5">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            placeholder="Search pairs..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8 text-xs bg-white/[0.03] border-white/5"
            autoFocus
            data-testid="input-search-pair"
          />
        </div>
      </div>
      <div className="max-h-80 overflow-y-auto">
        {sorted.map((m) => (
          <button
            key={m.symbol}
            onClick={() => { onSelect(m.symbol); onClose(); }}
            className={`w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-white/[0.04] transition-colors ${
              selectedPair === m.symbol ? "bg-emerald-500/10" : ""
            }`}
            data-testid={`market-${m.symbol}`}
          >
            <span
              role="button"
              onClick={(e) => { e.stopPropagation(); toggleFav(m.symbol); }}
              className="shrink-0 cursor-pointer"
            >
              <Star className={`w-3 h-3 ${favorites.includes(m.symbol) ? "text-yellow-400 fill-yellow-400" : "text-muted-foreground/30"}`} />
            </span>
            <span className="font-semibold text-foreground">{m.symbol.replace("USDT", "")}</span>
            <span className="text-muted-foreground/50">/USDT</span>
            <span className="ml-auto font-mono text-foreground">${formatUsd(m.price)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function TradeTicket({
  walletAddress,
  selectedPair,
  currentPrice,
  availableMargin,
  onTradeComplete,
  onConnect,
}: {
  walletAddress: string | null;
  selectedPair: string;
  currentPrice: number;
  availableMargin: number;
  onTradeComplete: () => void;
  onConnect?: () => void;
}) {
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT">("MARKET");
  const [leverage, setLeverage] = useState(10);
  const [tradeAmount, setTradeAmount] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [submitting, setSubmitting] = useState<"BUY" | "SELL" | null>(null);
  const [result, setResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [riskMode, setRiskMode] = useState(false);
  const [riskPercent, setRiskPercent] = useState(1);

  const amount = parseFloat(tradeAmount) || 0;
  const positionSize = amount * leverage;
  const estLiqLong = currentPrice > 0 ? currentPrice * (1 - 0.9 / leverage) : 0;
  const estLiqShort = currentPrice > 0 ? currentPrice * (1 + 0.9 / leverage) : 0;
  const estFees = positionSize * 0.0005;

  useEffect(() => {
    if (riskMode && availableMargin > 0) {
      setTradeAmount((availableMargin * riskPercent / 100).toFixed(2));
    }
  }, [riskMode, riskPercent, availableMargin]);

  const handleTrade = async (side: "BUY" | "SELL") => {
    if (!walletAddress) {
      onConnect?.();
      return;
    }
    const amt = parseFloat(tradeAmount);
    if (!amt || amt < 1) return;
    setSubmitting(side);
    setResult(null);
    try {
      const payload: any = {
        symbol: selectedPair,
        side,
        amount: amt,
        leverage,
      };
      if (orderType === "LIMIT") {
        const lp = parseFloat(limitPrice);
        if (!lp || lp <= 0) {
          setResult({ success: false, error: "Enter a valid limit price" });
          setSubmitting(null);
          return;
        }
        payload.type = "LIMIT";
        payload.price = lp;
      }
      const data = await webPost("/api/miniapp/trade", walletAddress, payload);
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

  return (
    <div className="flex flex-col h-full" data-testid="trade-ticket">
      <div className="flex gap-1 p-2 border-b border-white/5">
        {(["MARKET", "LIMIT"] as const).map(t => (
          <button
            key={t}
            onClick={() => setOrderType(t)}
            className={`flex-1 py-1.5 text-[11px] font-semibold rounded transition-colors ${
              orderType === t ? "bg-white/[0.08] text-foreground" : "text-muted-foreground hover:text-foreground/70"
            }`}
            data-testid={`button-order-${t.toLowerCase()}`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        <div>
          <div className="flex items-center justify-between text-[11px] mb-1.5">
            <span className="text-muted-foreground">Leverage</span>
            <span className="text-foreground font-mono font-bold text-emerald-400">{leverage}x</span>
          </div>
          <Slider
            value={[leverage]}
            onValueChange={([v]) => setLeverage(v)}
            min={1}
            max={50}
            step={1}
            data-testid="slider-leverage"
          />
          <div className="flex justify-between text-[9px] text-muted-foreground/50 mt-1">
            <span>1x</span><span>10x</span><span>25x</span><span>50x</span>
          </div>
        </div>

        {orderType === "LIMIT" && (
          <div>
            <label className="text-[11px] text-muted-foreground mb-1 block">Limit Price</label>
            <Input
              type="number"
              placeholder="Enter price"
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
              className="h-8 text-xs font-mono bg-white/[0.02] border-white/5"
              data-testid="input-limit-price"
            />
          </div>
        )}

        <div>
          <div className="flex items-center justify-between text-[11px] mb-1">
            <span className="text-muted-foreground">Margin (USDT)</span>
            <button
              onClick={() => setRiskMode(!riskMode)}
              className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded ${
                riskMode ? "bg-emerald-500/10 text-emerald-400" : "text-muted-foreground hover:text-foreground/70"
              }`}
              data-testid="button-risk-mode"
            >
              <Percent className="w-3 h-3" />
              Risk %
            </button>
          </div>

          {riskMode ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Slider
                  value={[riskPercent]}
                  onValueChange={([v]) => setRiskPercent(v)}
                  min={0.5}
                  max={10}
                  step={0.5}
                  className="flex-1"
                />
                <span className="text-xs font-mono text-emerald-400 w-12 text-right">{riskPercent}%</span>
              </div>
              <div className="text-[10px] text-muted-foreground">
                = ${formatUsd(availableMargin * riskPercent / 100)} of ${formatUsd(availableMargin)}
              </div>
            </div>
          ) : (
            <Input
              type="number"
              placeholder="Enter margin amount"
              value={tradeAmount}
              onChange={(e) => setTradeAmount(e.target.value)}
              className="h-8 text-xs font-mono bg-white/[0.02] border-white/5"
              data-testid="input-trade-amount"
            />
          )}

          <div className="grid grid-cols-4 gap-1 mt-1.5">
            {[10, 25, 50, 100].map((v) => (
              <button
                key={v}
                className="py-1 text-[10px] font-mono text-muted-foreground hover:text-foreground bg-white/[0.02] hover:bg-white/[0.05] rounded border border-white/5 transition-colors"
                onClick={() => setTradeAmount(String(v))}
                data-testid={`button-amount-${v}`}
              >
                ${v}
              </button>
            ))}
          </div>
        </div>

        {amount > 0 && currentPrice > 0 && (
          <div className="p-2.5 rounded-lg bg-white/[0.02] border border-white/5 space-y-1.5 text-[11px]">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Position Size</span>
              <span className="font-mono text-foreground">${formatCompact(positionSize)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Est. Fees</span>
              <span className="font-mono text-muted-foreground">${formatUsd(estFees)}</span>
            </div>
            <Separator className="bg-white/5" />
            <div className="flex justify-between">
              <span className="text-muted-foreground">Liq. Price (Long)</span>
              <span className="font-mono text-yellow-400/80">${formatUsd(estLiqLong)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Liq. Price (Short)</span>
              <span className="font-mono text-yellow-400/80">${formatUsd(estLiqShort)}</span>
            </div>
          </div>
        )}
      </div>

      <div className="p-3 border-t border-white/5 space-y-2">
        {!walletAddress ? (
          <Button
            className="w-full h-10 font-semibold text-xs"
            onClick={() => onConnect?.()}
            data-testid="button-connect-to-trade"
          >
            <Wallet className="w-3.5 h-3.5 mr-1.5" />
            Connect Wallet
          </Button>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <button
              className="h-10 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs flex items-center justify-center gap-1.5 transition-colors disabled:opacity-40"
              disabled={!amount || amount < 1 || !!submitting}
              onClick={() => handleTrade("BUY")}
              data-testid="button-long"
            >
              {submitting === "BUY" ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <TrendingUp className="w-3.5 h-3.5" />}
              Long
            </button>
            <button
              className="h-10 rounded-md bg-red-600 hover:bg-red-500 text-white font-semibold text-xs flex items-center justify-center gap-1.5 transition-colors disabled:opacity-40"
              disabled={!amount || amount < 1 || !!submitting}
              onClick={() => handleTrade("SELL")}
              data-testid="button-short"
            >
              {submitting === "SELL" ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <TrendingDown className="w-3.5 h-3.5" />}
              Short
            </button>
          </div>
        )}

        {result && (
          <div className={`p-2 rounded text-[11px] text-center ${
            result.success ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" : "bg-red-500/10 text-red-400 border border-red-500/20"
          }`}>
            {result.success ? "Order submitted!" : result.error}
          </div>
        )}
        <div className="text-center text-[9px] text-muted-foreground/30">Powered by Aster DEX</div>
      </div>
    </div>
  );
}

function PositionsTable({
  positions,
  walletAddress,
  onRefresh,
}: {
  positions: Position[];
  walletAddress: string;
  onRefresh: () => void;
}) {
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
      <div className="flex items-center justify-center py-8 text-xs text-muted-foreground/50">
        <Activity className="w-4 h-4 mr-2" />
        No open positions
      </div>
    );
  }

  return (
    <div className="overflow-x-auto" data-testid="positions-table">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-[10px] text-muted-foreground/50 border-b border-white/5">
            <th className="text-left py-2 px-2 font-medium">Symbol</th>
            <th className="text-left py-2 px-1 font-medium">Side</th>
            <th className="text-right py-2 px-1 font-medium">Size</th>
            <th className="text-right py-2 px-1 font-medium">Entry</th>
            <th className="text-right py-2 px-1 font-medium">Mark</th>
            <th className="text-right py-2 px-1 font-medium">Lev</th>
            <th className="text-right py-2 px-1 font-medium">PnL</th>
            <th className="text-right py-2 px-2 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {positions.map((pos, i) => {
            const pnlPct = pos.entryPrice > 0 ? ((pos.markPrice - pos.entryPrice) / pos.entryPrice * 100 * (pos.side === "LONG" ? 1 : -1)) : 0;
            return (
              <tr key={i} className="border-b border-white/[0.03] hover:bg-white/[0.02]" data-testid={`position-row-${i}`}>
                <td className="py-2 px-2 font-semibold text-foreground">{pos.symbol.replace("USDT", "")}</td>
                <td className="py-2 px-1">
                  <span className={`text-[10px] font-bold ${pos.side === "LONG" ? "text-emerald-400" : "text-red-400"}`}>
                    {pos.side}
                  </span>
                </td>
                <td className="py-2 px-1 text-right font-mono text-foreground">{pos.size}</td>
                <td className="py-2 px-1 text-right font-mono text-muted-foreground">{formatUsd(pos.entryPrice)}</td>
                <td className="py-2 px-1 text-right font-mono text-foreground">{formatUsd(pos.markPrice)}</td>
                <td className="py-2 px-1 text-right font-mono text-muted-foreground">{pos.leverage}x</td>
                <td className="py-2 px-1 text-right">
                  <div className="flex flex-col items-end">
                    <PnlBadge value={pos.unrealizedPnl} />
                    <span className={`text-[9px] font-mono ${pnlPct >= 0 ? "text-emerald-400/60" : "text-red-400/60"}`}>
                      {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%
                    </span>
                  </div>
                </td>
                <td className="py-2 px-2 text-right">
                  <button
                    className="px-2 py-1 text-[10px] font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded transition-colors"
                    onClick={() => closePosition(pos.symbol)}
                    disabled={closing === pos.symbol}
                    data-testid={`button-close-${pos.symbol}`}
                  >
                    {closing === pos.symbol ? <RefreshCw className="w-3 h-3 animate-spin" /> : "Close"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AgentPanel({ walletAddress }: { walletAddress: string }) {
  const { data: agent, loading, refresh } = useWebApi<AgentData>("/api/miniapp/agent", walletAddress);
  const [toggling, setToggling] = useState(false);

  const toggleAgent = async () => {
    setToggling(true);
    try {
      await webPost("/api/miniapp/agent/toggle", walletAddress, {});
      await refresh();
    } catch {} finally {
      setToggling(false);
    }
  };

  if (loading && !agent) return <Skeleton className="h-32 w-full" />;

  const isRunning = agent?.running || false;
  const stats = agent?.stats;
  const winRate = stats && (stats.winCount + stats.lossCount) > 0
    ? Math.round(stats.winCount / (stats.winCount + stats.lossCount) * 100)
    : 0;

  return (
    <div className="p-3 space-y-3" data-testid="agent-panel">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isRunning ? "bg-emerald-500/15" : "bg-white/[0.04]"}`}>
            <Bot className={`w-4 h-4 ${isRunning ? "text-emerald-400" : "text-muted-foreground"}`} />
          </div>
          <div>
            <div className="text-xs font-semibold text-foreground">AI Agent</div>
            <div className="flex items-center gap-1">
              <div className={`w-1.5 h-1.5 rounded-full ${isRunning ? "bg-emerald-400 animate-pulse" : "bg-muted-foreground/30"}`} />
              <span className={`text-[10px] ${isRunning ? "text-emerald-400" : "text-muted-foreground"}`}>
                {isRunning ? "Autonomous" : "Stopped"}
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
        <div className="flex flex-wrap gap-1">
          <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-emerald-500/20 text-emerald-400/70">{agent.config.symbol}</Badge>
          <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-white/10">{agent.config.maxLeverage}x max</Badge>
          <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-white/10">{agent.config.riskPercent}% risk</Badge>
        </div>
      )}

      {stats && (
        <div className="grid grid-cols-2 gap-2">
          <div className="p-2 rounded bg-white/[0.02] border border-white/5">
            <div className="text-[9px] text-muted-foreground/50">Trades</div>
            <div className="text-sm font-mono text-foreground">{stats.tradeCount}</div>
          </div>
          <div className="p-2 rounded bg-white/[0.02] border border-white/5">
            <div className="text-[9px] text-muted-foreground/50">Win Rate</div>
            <div className="text-sm font-mono text-foreground">{winRate}%</div>
          </div>
          <div className="p-2 rounded bg-white/[0.02] border border-white/5">
            <div className="text-[9px] text-muted-foreground/50">PnL</div>
            <PnlBadge value={stats.totalPnl} />
          </div>
          <div className="p-2 rounded bg-white/[0.02] border border-white/5">
            <div className="text-[9px] text-muted-foreground/50">W / L</div>
            <div className="text-sm font-mono">
              <span className="text-emerald-400">{stats.winCount}</span>
              <span className="text-muted-foreground/30"> / </span>
              <span className="text-red-400">{stats.lossCount}</span>
            </div>
          </div>
        </div>
      )}

      {stats?.lastReason && (
        <div className="p-2 rounded bg-blue-500/[0.03] border border-blue-500/10">
          <div className="text-[9px] text-blue-400/50 mb-0.5">Last Reasoning</div>
          <div className="text-[11px] text-foreground/80 leading-relaxed">{stats.lastReason}</div>
        </div>
      )}
    </div>
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
  const [regResult, setRegResult] = useState<{ success: boolean; asterLinked: boolean } | null>(null);

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
      <div className="flex flex-col items-center justify-center py-12 space-y-3">
        <Check className="w-8 h-8 text-emerald-400" />
        <p className="text-sm text-emerald-400 font-semibold" data-testid="text-register-success">Account Created!</p>
        <RefreshCw className="w-4 h-4 text-emerald-400 animate-spin" />
      </div>
    );
  }

  if (isNotLinked) {
    return (
      <div className="flex flex-col items-center justify-center py-12 space-y-4">
        <div className="w-14 h-14 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
          <Zap className="w-7 h-7 text-emerald-400" />
        </div>
        <div className="text-center">
          <h3 className="text-lg font-bold text-foreground" data-testid="text-register-title">Create Account</h3>
          <p className="text-xs text-muted-foreground mt-1 max-w-xs">
            One click to start trading perpetual futures with AI-powered agents
          </p>
        </div>
        <div className="text-xs font-mono text-muted-foreground bg-white/[0.03] px-3 py-1.5 rounded" data-testid="text-register-wallet">
          {walletAddress.slice(0, 8)}...{walletAddress.slice(-6)}
        </div>
        {regError && (
          <div className="p-2 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-xs max-w-xs text-center">{regError}</div>
        )}
        <Button size="sm" onClick={handleRegister} disabled={registering} data-testid="button-register">
          {registering ? <RefreshCw className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Zap className="w-3.5 h-3.5 mr-1.5" />}
          {registering ? "Creating..." : "Create Account"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center py-12 space-y-3">
      <AlertTriangle className="w-8 h-8 text-yellow-500" />
      <p className="text-sm text-foreground font-semibold">Connection Issue</p>
      <p className="text-xs text-muted-foreground text-center max-w-xs" data-testid="text-error-message">{error}</p>
      <Button variant="outline" size="sm" onClick={onRetry} data-testid="button-retry">
        <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Retry
      </Button>
    </div>
  );
}

function ActivationBanner({ walletAddress, onConnected }: { walletAddress: string; onConnected: () => void }) {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConnect = async () => {
    setConnecting(true);
    setError(null);
    try {
      const res = await fetch("/api/miniapp/link-aster", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-wallet-address": walletAddress },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (data.success) setTimeout(onConnected, 1500);
      else setError(data.error || "Activation failed");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="border-b border-yellow-500/10 bg-yellow-500/[0.03] px-4 py-2 flex items-center justify-between gap-3" data-testid="activation-banner">
      <div className="flex items-center gap-2 text-[11px]">
        <Zap className="w-3.5 h-3.5 text-yellow-400 shrink-0" />
        <span className="text-yellow-300/80">Trading not yet activated.</span>
        {error && <span className="text-red-400 ml-1">{error}</span>}
      </div>
      <button
        onClick={handleConnect}
        disabled={connecting}
        className="px-3 py-1 text-[10px] font-semibold rounded bg-yellow-500/15 text-yellow-300 hover:bg-yellow-500/25 border border-yellow-500/20 transition-colors disabled:opacity-50 shrink-0"
        data-testid="button-connect-aster"
      >
        {connecting ? "Activating..." : "Activate Now"}
      </button>
    </div>
  );
}

function FuturesPageInner() {
  const { address, connecting, error: walletError, connect, disconnect } = useWalletAddress();
  const [selectedPair, setSelectedPair] = useState("BTCUSDT");
  const [timeframe, setTimeframe] = useState("1h");
  const [pairSelectorOpen, setPairSelectorOpen] = useState(false);
  const [bottomTab, setBottomTab] = useState("positions");
  const [rightTab, setRightTab] = useState("trade");
  const [chartFullscreen, setChartFullscreen] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<string | null>(null);

  const { data: rawAccount, loading: accountLoading, error: accountError, refresh: refreshAccount } =
    useWebApi<AccountData>("/api/miniapp/account", address);

  const account = useMemo<AccountData | null>(() => {
    if (!rawAccount) return null;
    return {
      connected: rawAccount.connected ?? false,
      walletBalance: rawAccount.walletBalance ?? 0,
      availableMargin: rawAccount.availableMargin ?? 0,
      bscBalance: rawAccount.bscBalance ?? 0,
      unrealizedPnl: rawAccount.unrealizedPnl ?? 0,
      realizedPnl: rawAccount.realizedPnl ?? 0,
      wins: rawAccount.wins ?? 0,
      losses: rawAccount.losses ?? 0,
      positions: rawAccount.positions ?? [],
      recentIncome: rawAccount.recentIncome ?? [],
    };
  }, [rawAccount]);
  const { data: publicMarkets, refresh: refreshPublicMarkets } =
    usePublicApi<MarketData>("/api/public/markets");
  const { data: authMarkets, refresh: refreshAuthMarkets } =
    useWebApi<MarketData>("/api/miniapp/markets", address);
  const { data: ticker } = usePublicApi<TickerData>(`/api/public/ticker?symbol=${selectedPair}`);
  const { data: funding } = usePublicApi<any>(`/api/public/funding?symbol=${selectedPair}`);

  const markets = authMarkets || publicMarkets;
  const refreshMarkets = address ? refreshAuthMarkets : refreshPublicMarkets;

  const isNewUser = !!(accountError && (accountError.includes("not linked") || accountError.includes("not found") || accountError.includes("404")));
  const isNotActivated = !!(address && account && !account.connected);
  const isFullyConnected = !!(address && account?.connected);
  const hasAccount = !!(address && account);

  useEffect(() => {
    const interval = setInterval(() => {
      refreshPublicMarkets();
      if (address) {
        refreshAccount();
        refreshAuthMarkets();
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [address, refreshAccount, refreshPublicMarkets, refreshAuthMarkets]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "b" || e.key === "B") {
        const longBtn = document.querySelector('[data-testid="button-long"]') as HTMLButtonElement;
        longBtn?.click();
      }
      if (e.key === "s" || e.key === "S") {
        const shortBtn = document.querySelector('[data-testid="button-short"]') as HTMLButtonElement;
        shortBtn?.click();
      }
      if (e.key === "Escape") {
        setPairSelectorOpen(false);
        setChartFullscreen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const currentPrice = markets?.markets?.find((m) => m.symbol === selectedPair)?.price || 0;
  const priceChange = ticker ? parseFloat(ticker.priceChangePercent || "0") : 0;
  const volume24h = ticker ? parseFloat(ticker.quoteVolume || "0") : 0;
  const high24h = ticker ? parseFloat(ticker.highPrice || "0") : 0;
  const low24h = ticker ? parseFloat(ticker.lowPrice || "0") : 0;
  const fundingRate = funding?.[0] ? parseFloat(funding[0].fundingRate || "0") : 0;

  return (
    <div className="h-screen flex flex-col bg-[hsl(160,10%,3%)] text-foreground overflow-hidden" data-testid="futures-page">
      <header className="h-11 border-b border-white/[0.06] flex items-center px-3 gap-3 shrink-0 bg-[hsl(160,10%,4%)]/80 backdrop-blur-xl z-50">
        <Link href="/">
          <div className="flex items-center gap-1.5 cursor-pointer mr-1">
            <div className="w-6 h-6 rounded bg-emerald-500/15 flex items-center justify-center">
              <Terminal className="w-3.5 h-3.5 text-emerald-400" />
            </div>
            <span className="font-mono font-bold text-[11px] tracking-wider hidden sm:block" data-testid="text-logo">
              BUILD<span className="text-emerald-400">4</span>
              <span className="text-muted-foreground/40 ml-1 font-normal">PRO</span>
            </span>
          </div>
        </Link>

        <Separator orientation="vertical" className="h-5 bg-white/5" />

        <div className="relative">
          <button
            onClick={() => setPairSelectorOpen(!pairSelectorOpen)}
            className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-white/[0.04] transition-colors"
            data-testid="button-pair-selector"
          >
            <span className="font-bold text-sm text-foreground">{selectedPair.replace("USDT", "")}</span>
            <span className="text-muted-foreground/40 text-xs">/USDT</span>
            <ChevronDown className="w-3 h-3 text-muted-foreground/40" />
          </button>
          {pairSelectorOpen && markets?.markets && (
            <PairSelector
              markets={markets.markets}
              selectedPair={selectedPair}
              onSelect={setSelectedPair}
              onClose={() => setPairSelectorOpen(false)}
            />
          )}
        </div>

        <div className="flex items-center gap-4 ml-2">
          <div className="flex flex-col">
            <span className={`font-mono text-sm font-bold ${priceChange >= 0 ? "text-emerald-400" : "text-red-400"}`} data-testid="text-header-price">
              {currentPrice > 0 ? formatUsd(currentPrice) : "--"}
            </span>
          </div>

          <div className="hidden lg:flex items-center gap-4 text-[10px]">
            <div className="flex flex-col">
              <span className="text-muted-foreground/40">24h Change</span>
              <span className={`font-mono ${priceChange >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {priceChange >= 0 ? "+" : ""}{priceChange.toFixed(2)}%
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-muted-foreground/40">24h High</span>
              <span className="font-mono text-foreground/70">{high24h > 0 ? formatUsd(high24h) : "--"}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-muted-foreground/40">24h Low</span>
              <span className="font-mono text-foreground/70">{low24h > 0 ? formatUsd(low24h) : "--"}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-muted-foreground/40">24h Volume</span>
              <span className="font-mono text-foreground/70">${formatCompact(volume24h)}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-muted-foreground/40">Funding</span>
              <span className={`font-mono ${fundingRate >= 0 ? "text-emerald-400/70" : "text-red-400/70"}`}>
                {(fundingRate * 100).toFixed(4)}%
              </span>
            </div>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {hasAccount && account && (
            <div className="hidden md:flex items-center gap-3 text-[10px] mr-2">
              <div className="flex items-center gap-1.5">
                <DollarSign className="w-3 h-3 text-emerald-400/60" />
                <span className="text-muted-foreground/50">Margin:</span>
                <span className="font-mono text-foreground">${formatUsd(account.availableMargin)}</span>
              </div>
              <Separator orientation="vertical" className="h-3 bg-white/5" />
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground/50">PnL:</span>
                <PnlBadge value={account.unrealizedPnl} />
              </div>
            </div>
          )}

          {address ? (
            <div className="flex items-center gap-1.5">
              <div className="flex items-center gap-1 px-2 py-1 rounded bg-emerald-500/10 border border-emerald-500/15">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-[10px] font-mono text-emerald-400" data-testid="text-wallet-address">
                  {address.slice(0, 6)}...{address.slice(-4)}
                </span>
              </div>
              <button
                onClick={disconnect}
                className="p-1.5 rounded hover:bg-white/[0.04] text-muted-foreground hover:text-foreground transition-colors"
                data-testid="button-disconnect"
              >
                <LogOut className="w-3 h-3" />
              </button>
            </div>
          ) : (
            <Button size="sm" onClick={connect} disabled={connecting} className="h-7 text-[11px] px-3" data-testid="button-nav-connect">
              <Wallet className="w-3 h-3 mr-1" />
              Connect
            </Button>
          )}
        </div>
      </header>

      {(isNewUser && address) && (
        <div className="border-b border-white/[0.06] bg-[hsl(160,10%,4%)]">
          <RegisterOrErrorScreen error={accountError!} walletAddress={address} onRegistered={refreshAccount} onRetry={refreshAccount} />
        </div>
      )}
      {isNotActivated && (
        <ActivationBanner walletAddress={address!} onConnected={refreshAccount} />
      )}

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col min-w-0">
          <div className={`flex-1 min-h-0 flex flex-col border-r border-white/[0.06] ${chartFullscreen ? "fixed inset-0 z-50 bg-[hsl(160,10%,3%)]" : ""}`}>
            <div className="h-8 border-b border-white/[0.04] flex items-center px-2 gap-1 shrink-0">
              {TIMEFRAMES.map(tf => (
                <button
                  key={tf.value}
                  onClick={() => setTimeframe(tf.value)}
                  className={`px-2 py-1 text-[10px] font-mono rounded transition-colors ${
                    timeframe === tf.value
                      ? "bg-white/[0.08] text-foreground font-semibold"
                      : "text-muted-foreground/50 hover:text-foreground/70"
                  }`}
                  data-testid={`button-tf-${tf.value}`}
                >
                  {tf.label}
                </button>
              ))}
              <div className="ml-auto flex items-center gap-1">
                <button
                  onClick={() => setChartFullscreen(!chartFullscreen)}
                  className="p-1 rounded hover:bg-white/[0.04] text-muted-foreground/40 hover:text-foreground/60 transition-colors"
                  data-testid="button-fullscreen-chart"
                >
                  {chartFullscreen ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0">
              <TradingChart
                symbol={selectedPair}
                interval={timeframe}
                positions={hasAccount ? account?.positions : undefined}
              />
            </div>
          </div>

          <div className="h-[200px] border-t border-white/[0.06] flex flex-col shrink-0">
            <div className="h-7 border-b border-white/[0.04] flex items-center px-2 gap-0.5 shrink-0">
              {[
                { id: "positions", label: "Positions", icon: Activity, count: hasAccount ? account?.positions?.length : undefined },
                { id: "income", label: "Trade History", icon: Clock },
                { id: "agent", label: "AI Agent", icon: Bot },
              ].map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setBottomTab(tab.id)}
                  className={`flex items-center gap-1 px-2.5 py-1 text-[10px] rounded transition-colors ${
                    bottomTab === tab.id
                      ? "bg-white/[0.06] text-foreground font-semibold"
                      : "text-muted-foreground/50 hover:text-foreground/60"
                  }`}
                  data-testid={`tab-${tab.id}`}
                >
                  <tab.icon className="w-3 h-3" />
                  {tab.label}
                  {tab.count !== undefined && tab.count > 0 && (
                    <span className="ml-0.5 px-1 py-0 text-[9px] rounded bg-emerald-500/15 text-emerald-400">{tab.count}</span>
                  )}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto">
              {bottomTab === "positions" && (
                hasAccount && account ? (
                  <PositionsTable positions={account.positions} walletAddress={address!} onRefresh={refreshAccount} />
                ) : (
                  <div className="flex items-center justify-center h-full text-xs text-muted-foreground/40">
                    <Wallet className="w-4 h-4 mr-2" />
                    Connect wallet to view positions
                  </div>
                )
              )}
              {bottomTab === "income" && (
                hasAccount && account ? (
                  <div className="p-2">
                    {account.recentIncome.length === 0 ? (
                      <div className="flex items-center justify-center py-6 text-xs text-muted-foreground/40">No recent trades</div>
                    ) : (
                      <div className="space-y-0.5">
                        {account.recentIncome.slice(0, 20).map((inc, i) => (
                          <div key={i} className="flex items-center justify-between text-[11px] py-1.5 px-2 hover:bg-white/[0.02] rounded">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-foreground">{inc.symbol.replace("USDT", "")}</span>
                              <span className="text-[9px] text-muted-foreground/40 font-mono">{inc.type}</span>
                            </div>
                            <div className="flex items-center gap-3">
                              <PnlBadge value={inc.amount} />
                              <span className="text-[9px] text-muted-foreground/30 font-mono">
                                {new Date(inc.time).toLocaleTimeString()}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-full text-xs text-muted-foreground/40">
                    <Wallet className="w-4 h-4 mr-2" />
                    Connect wallet to view history
                  </div>
                )
              )}
              {bottomTab === "agent" && (
                hasAccount && address ? (
                  <AgentPanel walletAddress={address} />
                ) : (
                  <div className="flex items-center justify-center h-full text-xs text-muted-foreground/40">
                    <Bot className="w-4 h-4 mr-2" />
                    Connect wallet to use AI Agent
                  </div>
                )
              )}
            </div>
          </div>
        </div>

        <div className="w-[280px] xl:w-[300px] flex flex-col border-l border-white/[0.06] shrink-0 hidden md:flex">
          <div className="h-8 border-b border-white/[0.04] flex items-center px-1 gap-0.5 shrink-0">
            {[
              { id: "trade", label: "Trade" },
              { id: "book", label: "Book" },
              { id: "account", label: "Account" },
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setRightTab(tab.id)}
                className={`flex-1 py-1 text-[10px] font-semibold rounded transition-colors ${
                  rightTab === tab.id
                    ? "bg-white/[0.06] text-foreground"
                    : "text-muted-foreground/50 hover:text-foreground/60"
                }`}
                data-testid={`tab-right-${tab.id}`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto">
            {rightTab === "trade" && (
              <TradeTicket
                walletAddress={hasAccount ? address : null}
                selectedPair={selectedPair}
                currentPrice={currentPrice}
                availableMargin={hasAccount && account ? account.availableMargin : 0}
                onTradeComplete={refreshAccount}
                onConnect={connect}
              />
            )}
            {rightTab === "book" && (
              <OrderBook symbol={selectedPair} />
            )}
            {rightTab === "account" && (
              <div className="p-3 space-y-3">
                {hasAccount && account ? (
                  <>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-muted-foreground/60">Available Margin</span>
                        <span className="font-mono text-foreground font-semibold" data-testid="text-available-margin">${formatUsd(account.availableMargin)}</span>
                      </div>
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-muted-foreground/60">Wallet Balance</span>
                        <span className="font-mono text-foreground">${formatUsd(account.walletBalance)}</span>
                      </div>
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-muted-foreground/60">BSC Balance</span>
                        <span className="font-mono text-foreground" data-testid="text-bsc-balance">${formatUsd(account.bscBalance)}</span>
                      </div>
                      <Separator className="bg-white/5" />
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-muted-foreground/60">Unrealized PnL</span>
                        <PnlBadge value={account.unrealizedPnl} />
                      </div>
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-muted-foreground/60">Realized PnL</span>
                        <PnlBadge value={account.realizedPnl} />
                      </div>
                      {(account.wins + account.losses) > 0 && (
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-muted-foreground/60">Win Rate</span>
                          <span className="font-mono text-foreground">
                            {Math.round(account.wins / (account.wins + account.losses) * 100)}%
                            <span className="text-muted-foreground/40 ml-1">({account.wins}W/{account.losses}L)</span>
                          </span>
                        </div>
                      )}
                    </div>
                    <Button variant="outline" size="sm" className="w-full h-7 text-[10px]" onClick={refreshAccount} data-testid="button-refresh-account">
                      <RefreshCw className="w-3 h-3 mr-1" /> Refresh
                    </Button>
                  </>
                ) : (
                  <div className="flex flex-col items-center justify-center py-8 space-y-3">
                    <Wallet className="w-6 h-6 text-muted-foreground/30" />
                    <p className="text-xs text-muted-foreground/50 text-center">Connect wallet to view account</p>
                    <Button size="sm" className="h-7 text-[10px]" onClick={connect} data-testid="button-connect-inline">
                      <Wallet className="w-3 h-3 mr-1" /> Connect
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {mobilePanel && (
        <div className="md:hidden fixed inset-0 z-50 flex flex-col">
          <div className="flex-1 bg-black/60" onClick={() => setMobilePanel(null)} />
          <div className="bg-[hsl(160,10%,4%)] border-t border-white/[0.08] rounded-t-2xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
              <span className="text-xs font-semibold text-foreground capitalize">{mobilePanel}</span>
              <button onClick={() => setMobilePanel(null)} className="p-1 rounded hover:bg-white/[0.06]">
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {mobilePanel === "trade" && (
                <TradeTicket
                  walletAddress={hasAccount ? address : null}
                  selectedPair={selectedPair}
                  currentPrice={currentPrice}
                  availableMargin={hasAccount && account ? account.availableMargin : 0}
                  onTradeComplete={() => { refreshAccount(); setMobilePanel(null); }}
                  onConnect={() => { connect(); setMobilePanel(null); }}
                />
              )}
              {mobilePanel === "book" && <OrderBook symbol={selectedPair} />}
              {mobilePanel === "positions" && (
                hasAccount && account ? (
                  <PositionsTable positions={account.positions} walletAddress={address!} onRefresh={refreshAccount} />
                ) : (
                  <div className="flex items-center justify-center py-12 text-xs text-muted-foreground/40">
                    <Wallet className="w-4 h-4 mr-2" /> Connect wallet to view positions
                  </div>
                )
              )}
              {mobilePanel === "agent" && (
                hasAccount && address ? (
                  <AgentPanel walletAddress={address} />
                ) : (
                  <div className="flex items-center justify-center py-12 text-xs text-muted-foreground/40">
                    <Bot className="w-4 h-4 mr-2" /> Connect wallet to use AI Agent
                  </div>
                )
              )}
              {mobilePanel === "account" && (
                <div className="p-3 space-y-3">
                  {hasAccount && account ? (
                    <>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-muted-foreground/60">Available Margin</span>
                          <span className="font-mono text-foreground font-semibold">${formatUsd(account.availableMargin)}</span>
                        </div>
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-muted-foreground/60">Wallet Balance</span>
                          <span className="font-mono text-foreground">${formatUsd(account.walletBalance)}</span>
                        </div>
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-muted-foreground/60">BSC Balance</span>
                          <span className="font-mono text-foreground">${formatUsd(account.bscBalance)}</span>
                        </div>
                        <Separator className="bg-white/5" />
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-muted-foreground/60">Unrealized PnL</span>
                          <PnlBadge value={account.unrealizedPnl} />
                        </div>
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-muted-foreground/60">Realized PnL</span>
                          <PnlBadge value={account.realizedPnl} />
                        </div>
                      </div>
                      <Button variant="outline" size="sm" className="w-full h-7 text-[10px]" onClick={refreshAccount}>
                        <RefreshCw className="w-3 h-3 mr-1" /> Refresh
                      </Button>
                    </>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-8 space-y-3">
                      <Wallet className="w-6 h-6 text-muted-foreground/30" />
                      <p className="text-xs text-muted-foreground/50 text-center">Connect wallet to view account</p>
                      <Button size="sm" className="h-7 text-[10px]" onClick={() => { connect(); setMobilePanel(null); }}>
                        <Wallet className="w-3 h-3 mr-1" /> Connect
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="md:hidden fixed bottom-0 left-0 right-0 h-12 bg-[hsl(160,10%,4%)]/95 backdrop-blur-xl border-t border-white/[0.06] flex items-center justify-around px-2 z-40">
        {[
          { id: "trade", label: "Trade", icon: ArrowUpDown },
          { id: "book", label: "Book", icon: BarChart3 },
          { id: "positions", label: "Positions", icon: Activity },
          { id: "agent", label: "Agent", icon: Bot },
          { id: "account", label: "Account", icon: Wallet },
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setMobilePanel(mobilePanel === tab.id ? null : tab.id)}
            className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded transition-colors ${
              mobilePanel === tab.id ? "text-emerald-400" : "text-muted-foreground/40"
            }`}
            data-testid={`mobile-tab-${tab.id}`}
          >
            <tab.icon className="w-4 h-4" />
            <span className="text-[9px]">{tab.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function FuturesPage() {
  return (
    <FuturesErrorBoundary>
      <FuturesPageInner />
    </FuturesErrorBoundary>
  );
}