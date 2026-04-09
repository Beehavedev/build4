import { useState, useEffect, useCallback, useRef, useMemo, Component } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TrendingUp, TrendingDown, RefreshCw, Activity, X, ChevronDown,
  AlertTriangle, Wallet, Zap, Search, Settings, ChevronUp,
  Minus, Plus, Star, Maximize2, Shield, Target, Clock,
  DollarSign, LineChart, ExternalLink, Link2, Key, Check, Copy,
} from "lucide-react";
import { createChart, ColorType, CrosshairMode, LineStyle } from "lightweight-charts";

declare global { interface Window { ethereum?: any; } }

function fmt(n: number | undefined | null, d = 2): string {
  if (n == null || isNaN(n)) return "0.00";
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtK(n: number | undefined | null): string {
  if (n == null || isNaN(n)) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toFixed(2);
}
function fmtPrice(n: number | undefined | null): string {
  if (n == null || isNaN(n)) return "0.00";
  if (Math.abs(n) >= 100) return fmt(n, 2);
  if (Math.abs(n) >= 1) return fmt(n, 4);
  return fmt(n, 6);
}
function cn(...classes: (string | false | undefined | null)[]) { return classes.filter(Boolean).join(" "); }

const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d", "1w"] as const;
const TF_MS: Record<string, number> = {
  "1m": 60000, "5m": 300000, "15m": 900000, "1h": 3600000,
  "4h": 14400000, "1d": 86400000, "1w": 604800000,
};

class ErrorBoundary extends Component<{ children: any }, { hasError: boolean; error: string }> {
  constructor(props: any) { super(props); this.state = { hasError: false, error: "" }; }
  static getDerivedStateFromError(error: any) { return { hasError: true, error: error?.message || "Unknown error" }; }
  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen flex items-center justify-center bg-[#0a0b0d] text-white">
          <div className="text-center space-y-3">
            <AlertTriangle className="w-8 h-8 text-yellow-400 mx-auto" />
            <p className="text-sm font-semibold">Something went wrong</p>
            <p className="text-xs text-zinc-500 max-w-xs">{this.state.error}</p>
            <button onClick={() => window.location.reload()} className="px-4 py-2 text-xs bg-zinc-800 border border-zinc-700 rounded hover:bg-zinc-700" data-testid="button-reload">Reload</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function useHLWallet() {
  const [address, setAddress] = useState<string | null>(() => {
    try { return localStorage.getItem("hl_wallet") || null; } catch { return null; }
  });
  const [connecting, setConnecting] = useState(false);

  const connect = useCallback(async () => {
    if (!window.ethereum) return;
    setConnecting(true);
    try {
      const accts = await window.ethereum.request({ method: "eth_requestAccounts" });
      if (accts?.length) {
        const a = accts[0].toLowerCase();
        setAddress(a);
        localStorage.setItem("hl_wallet", a);
      }
    } catch {} finally { setConnecting(false); }
  }, []);

  const disconnect = useCallback(() => {
    setAddress(null);
    localStorage.removeItem("hl_wallet");
  }, []);

  return { address, connecting, connect, disconnect };
}

function hlHeaders(addr?: string | null) {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (addr) {
    h["x-wallet-address"] = addr;
    const chatId = localStorage.getItem("hl_chatid");
    if (chatId) h["x-telegram-chat-id"] = chatId;
  }
  return h;
}

export default function HyperliquidPage() {
  return (
    <ErrorBoundary>
      <HyperliquidTerminal />
    </ErrorBoundary>
  );
}

function HyperliquidTerminal() {
  const wallet = useHLWallet();
  const [selectedCoin, setSelectedCoin] = useState("BTC");
  const [markets, setMarkets] = useState<any[]>([]);
  const [mids, setMids] = useState<Record<string, string>>({});
  const [tf, setTf] = useState<string>("1h");
  const [showSetup, setShowSetup] = useState(false);
  const [hlStatus, setHlStatus] = useState<any>(null);
  const [positions, setPositions] = useState<any[]>([]);
  const [openOrders, setOpenOrders] = useState<any[]>([]);
  const [account, setAccount] = useState<any>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [mobilePanel, setMobilePanel] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/hl/meta").then(r => r.json()).then(d => {
      if (d?.universe) setMarkets(d.universe);
    }).catch(() => {});
    fetch("/api/hl/mids").then(r => r.json()).then(setMids).catch(() => {});
    const iv = setInterval(() => {
      fetch("/api/hl/mids").then(r => r.json()).then(setMids).catch(() => {});
    }, 5000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (!wallet.address) return;
    const load = () => {
      fetch("/api/hl/status", { headers: hlHeaders(wallet.address) }).then(r => r.json()).then(setHlStatus).catch(() => {});
      fetch("/api/hl/account", { headers: hlHeaders(wallet.address) }).then(r => r.json()).then(d => {
        setAccount(d);
        if (d?.assetPositions) setPositions(d.assetPositions.filter((p: any) => parseFloat(p?.position?.szi || "0") !== 0));
      }).catch(() => {});
      fetch("/api/hl/open-orders", { headers: hlHeaders(wallet.address) }).then(r => r.json()).then(d => {
        if (Array.isArray(d)) setOpenOrders(d);
      }).catch(() => {});
    };
    load();
    const iv = setInterval(load, 10000);
    return () => clearInterval(iv);
  }, [wallet.address]);

  const mid = mids[selectedCoin] ? parseFloat(mids[selectedCoin]) : 0;
  const filteredMarkets = markets.filter(m =>
    !searchQ || m.name.toLowerCase().includes(searchQ.toLowerCase())
  );

  const equity = account?.marginSummary?.accountValue ? parseFloat(account.marginSummary.accountValue) : 0;
  const totalUnrealizedPnl = positions.reduce((s: number, p: any) => s + parseFloat(p?.position?.unrealizedPnl || "0"), 0);

  return (
    <div className="h-screen flex flex-col bg-[#0a0b0d] text-white overflow-hidden select-none" data-testid="hl-terminal">
      <header className="h-12 border-b border-zinc-800 flex items-center px-3 gap-3 flex-shrink-0">
        <div className="flex items-center gap-2 cursor-pointer" onClick={() => setShowSearch(!showSearch)} data-testid="hl-pair-selector">
          <span className="text-base font-bold text-emerald-400">HL</span>
          <span className="text-sm font-semibold">{selectedCoin}-PERP</span>
          <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
        </div>

        <div className="flex items-center gap-4 text-xs">
          <div>
            <span className={cn("font-mono font-bold text-sm", mid > 0 ? "text-emerald-400" : "text-zinc-400")}>
              ${fmtPrice(mid)}
            </span>
          </div>
          <div className="hidden md:flex items-center gap-4 text-zinc-500">
            <span>24h Vol: {fmtK(parseFloat(mids[selectedCoin] || "0") * 1000)}</span>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {wallet.address ? (
            <div className="flex items-center gap-2">
              {hlStatus?.linked && (
                <Badge variant="outline" className="text-emerald-400 border-emerald-800 text-[10px]" data-testid="badge-hl-linked">
                  <Check className="w-3 h-3 mr-1" />
                  {hlStatus.hasAgent ? "API Wallet Active" : "Linked"}
                </Badge>
              )}
              <div className="text-xs text-zinc-400 hidden md:block" data-testid="text-equity">
                Equity: <span className="text-white font-mono">${fmt(equity)}</span>
              </div>
              <Button size="sm" variant="ghost" className="h-7 text-xs text-zinc-400" onClick={() => setShowSetup(true)} data-testid="button-hl-settings">
                <Settings className="w-3.5 h-3.5" />
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs text-zinc-400" onClick={wallet.disconnect} data-testid="button-disconnect">
                {wallet.address.slice(0, 6)}...{wallet.address.slice(-4)}
              </Button>
            </div>
          ) : (
            <Button size="sm" className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700" onClick={wallet.connect} data-testid="button-connect-wallet">
              <Wallet className="w-3.5 h-3.5 mr-1" />Connect Wallet
            </Button>
          )}
        </div>
      </header>

      {showSearch && (
        <div className="absolute top-12 left-0 z-50 bg-zinc-900 border border-zinc-700 rounded-b-lg shadow-2xl w-80 max-h-96 overflow-hidden" data-testid="market-search-panel">
          <div className="p-2 border-b border-zinc-800">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2 top-2 text-zinc-500" />
              <Input
                value={searchQ} onChange={e => setSearchQ(e.target.value)}
                placeholder="Search markets..."
                className="h-7 pl-7 text-xs bg-zinc-800 border-zinc-700"
                autoFocus
                data-testid="input-market-search"
              />
            </div>
          </div>
          <div className="overflow-y-auto max-h-72">
            {filteredMarkets.slice(0, 50).map(m => (
              <div
                key={m.name}
                className={cn("px-3 py-2 flex items-center justify-between cursor-pointer hover:bg-zinc-800 text-xs", m.name === selectedCoin && "bg-zinc-800")}
                onClick={() => { setSelectedCoin(m.name); setShowSearch(false); setSearchQ(""); }}
                data-testid={`market-item-${m.name}`}
              >
                <span className="font-semibold">{m.name}-PERP</span>
                <span className="font-mono text-zinc-400">${fmtPrice(parseFloat(mids[m.name] || "0"))}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {showSetup && <SetupModal wallet={wallet} hlStatus={hlStatus} onClose={() => setShowSetup(false)} onRefresh={() => {
        fetch("/api/hl/status", { headers: hlHeaders(wallet.address) }).then(r => r.json()).then(setHlStatus).catch(() => {});
      }} />}

      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center gap-1 px-2 py-1 border-b border-zinc-800 bg-zinc-900/50">
            {TIMEFRAMES.map(t => (
              <button
                key={t}
                className={cn("px-2 py-1 text-[10px] rounded", tf === t ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-300")}
                onClick={() => setTf(t)}
                data-testid={`tf-${t}`}
              >{t}</button>
            ))}
          </div>
          <div className="flex-1 min-h-0">
            <ChartPanel coin={selectedCoin} timeframe={tf} />
          </div>
        </div>

        <div className="hidden md:flex flex-col w-72 border-l border-zinc-800 flex-shrink-0">
          <OrderBook coin={selectedCoin} />
        </div>

        <div className="hidden md:flex flex-col w-80 border-l border-zinc-800 flex-shrink-0 overflow-y-auto">
          <TradeTicket
            coin={selectedCoin}
            mid={mid}
            wallet={wallet}
            hlStatus={hlStatus}
            onShowSetup={() => setShowSetup(true)}
          />
        </div>
      </div>

      <div className="hidden md:block border-t border-zinc-800 max-h-48 overflow-y-auto flex-shrink-0">
        <PositionsPanel
          positions={positions}
          openOrders={openOrders}
          wallet={wallet}
          totalPnl={totalUnrealizedPnl}
        />
      </div>

      <div className="md:hidden border-t border-zinc-800 flex h-12 flex-shrink-0">
        {["Trade", "Book", "Positions", "Account"].map(p => (
          <button
            key={p}
            className={cn("flex-1 text-xs font-medium", mobilePanel === p ? "text-emerald-400 bg-zinc-900" : "text-zinc-500")}
            onClick={() => setMobilePanel(mobilePanel === p ? null : p)}
            data-testid={`mobile-tab-${p.toLowerCase()}`}
          >{p}</button>
        ))}
      </div>

      {mobilePanel && (
        <div className="md:hidden fixed inset-x-0 bottom-12 bg-zinc-900 border-t border-zinc-700 z-40 max-h-[60vh] overflow-y-auto">
          <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
            <span className="text-xs font-semibold">{mobilePanel}</span>
            <button onClick={() => setMobilePanel(null)}><X className="w-4 h-4 text-zinc-500" /></button>
          </div>
          {mobilePanel === "Trade" && <TradeTicket coin={selectedCoin} mid={mid} wallet={wallet} hlStatus={hlStatus} onShowSetup={() => setShowSetup(true)} />}
          {mobilePanel === "Book" && <OrderBook coin={selectedCoin} />}
          {mobilePanel === "Positions" && <PositionsPanel positions={positions} openOrders={openOrders} wallet={wallet} totalPnl={totalUnrealizedPnl} />}
          {mobilePanel === "Account" && (
            <div className="p-3 space-y-2 text-xs">
              <div className="flex justify-between"><span className="text-zinc-500">Equity</span><span className="font-mono">${fmt(equity)}</span></div>
              <div className="flex justify-between"><span className="text-zinc-500">Unrealized PnL</span><span className={cn("font-mono", totalUnrealizedPnl >= 0 ? "text-emerald-400" : "text-red-400")}>${fmt(totalUnrealizedPnl)}</span></div>
              <div className="flex justify-between"><span className="text-zinc-500">Positions</span><span className="font-mono">{positions.length}</span></div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChartPanel({ coin, timeframe }: { coin: string; timeframe: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const seriesRef = useRef<any>(null);
  const volRef = useRef<any>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const c = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: "#0a0b0d" }, textColor: "#71717a" },
      grid: { vertLines: { color: "#1c1c22" }, horzLines: { color: "#1c1c22" } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: "#555", style: LineStyle.Dashed }, horzLine: { color: "#555", style: LineStyle.Dashed } },
      timeScale: { borderColor: "#27272a", timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: "#27272a" },
    });
    chartRef.current = c;
    seriesRef.current = c.addCandlestickSeries({
      upColor: "#10b981", downColor: "#ef4444", borderUpColor: "#10b981", borderDownColor: "#ef4444",
      wickUpColor: "#10b981", wickDownColor: "#ef4444",
    });
    volRef.current = c.addHistogramSeries({
      priceFormat: { type: "volume" }, priceScaleId: "vol",
    });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    const ro = new ResizeObserver(([entry]) => {
      c.applyOptions({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    ro.observe(containerRef.current);
    return () => { ro.disconnect(); c.remove(); };
  }, []);

  useEffect(() => {
    const tfMs = TF_MS[timeframe] || 3600000;
    const startTime = Date.now() - tfMs * 300;
    fetch(`/api/hl/candles/${coin}?interval=${timeframe}&startTime=${startTime}`)
      .then(r => r.json())
      .then(data => {
        if (!Array.isArray(data) || !seriesRef.current) return;
        const candles = data.map((c: any) => ({
          time: Math.floor(c.t / 1000) as any,
          open: parseFloat(c.o), high: parseFloat(c.h), low: parseFloat(c.l), close: parseFloat(c.c),
        }));
        const vols = data.map((c: any) => ({
          time: Math.floor(c.t / 1000) as any,
          value: parseFloat(c.v),
          color: parseFloat(c.c) >= parseFloat(c.o) ? "#10b98133" : "#ef444433",
        }));
        seriesRef.current.setData(candles);
        if (volRef.current) volRef.current.setData(vols);
        chartRef.current?.timeScale().fitContent();
      })
      .catch(() => {});
  }, [coin, timeframe]);

  return <div ref={containerRef} className="w-full h-full" data-testid="chart-container" />;
}

function OrderBook({ coin }: { coin: string }) {
  const [book, setBook] = useState<{ bids: [string, string][]; asks: [string, string][] }>({ bids: [], asks: [] });

  useEffect(() => {
    const load = () => {
      fetch(`/api/hl/l2book/${coin}?nSigFigs=5`)
        .then(r => r.json())
        .then(d => {
          if (d?.levels) {
            setBook({
              bids: (d.levels[0] || []).slice(0, 15).map((l: any) => [l.px, l.sz]),
              asks: (d.levels[1] || []).slice(0, 15).map((l: any) => [l.px, l.sz]).reverse(),
            });
          }
        }).catch(() => {});
    };
    load();
    const iv = setInterval(load, 3000);
    return () => clearInterval(iv);
  }, [coin]);

  const maxQty = Math.max(
    ...book.bids.map(b => parseFloat(b[1])),
    ...book.asks.map(a => parseFloat(a[1])),
    1,
  );

  return (
    <div className="flex flex-col h-full" data-testid="orderbook">
      <div className="px-2 py-1.5 text-[10px] font-semibold text-zinc-500 uppercase border-b border-zinc-800 flex items-center gap-1">
        <Activity className="w-3 h-3" />Order Book
      </div>
      <div className="grid grid-cols-2 px-2 py-1 text-[9px] text-zinc-600 border-b border-zinc-800">
        <span>Price</span>
        <span className="text-right">Size</span>
      </div>
      <div className="flex-1 overflow-y-auto text-[11px] font-mono">
        {book.asks.map(([px, sz], i) => {
          const pct = (parseFloat(sz) / maxQty) * 100;
          return (
            <div key={`a${i}`} className="relative flex justify-between px-2 py-[2px] hover:bg-zinc-800/50">
              <div className="absolute right-0 top-0 bottom-0 bg-red-500/10" style={{ width: `${pct}%` }} />
              <span className="text-red-400 z-10">{fmtPrice(parseFloat(px))}</span>
              <span className="text-zinc-400 z-10">{parseFloat(sz).toFixed(4)}</span>
            </div>
          );
        })}
        <div className="px-2 py-1.5 border-y border-zinc-800 text-center">
          <span className="text-emerald-400 font-bold text-xs">{fmtPrice(parseFloat(book.bids[0]?.[0] || "0"))}</span>
        </div>
        {book.bids.map(([px, sz], i) => {
          const pct = (parseFloat(sz) / maxQty) * 100;
          return (
            <div key={`b${i}`} className="relative flex justify-between px-2 py-[2px] hover:bg-zinc-800/50">
              <div className="absolute right-0 top-0 bottom-0 bg-emerald-500/10" style={{ width: `${pct}%` }} />
              <span className="text-emerald-400 z-10">{fmtPrice(parseFloat(px))}</span>
              <span className="text-zinc-400 z-10">{parseFloat(sz).toFixed(4)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TradeTicket({ coin, mid, wallet, hlStatus, onShowSetup }: {
  coin: string; mid: number; wallet: any; hlStatus: any; onShowSetup: () => void;
}) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [size, setSize] = useState("");
  const [price, setPrice] = useState("");
  const [leverage, setLeverage] = useState(5);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (orderType === "limit" && mid > 0 && !price) setPrice(fmtPrice(mid));
  }, [orderType, mid]);

  const notional = (parseFloat(size) || 0) * (orderType === "market" ? mid : (parseFloat(price) || mid));
  const margin = notional / leverage;

  const submit = async () => {
    if (!wallet.address || !hlStatus?.hasAgent) return;
    setSubmitting(true);
    setResult(null);
    try {
      const headers = hlHeaders(wallet.address);
      if (orderType === "market") {
        const res = await fetch("/api/hl/market-order", {
          method: "POST", headers,
          body: JSON.stringify({ coin, isBuy: side === "buy", sz: size }),
        });
        const data = await res.json();
        if (data.status === "ok") {
          const st = data.response?.data?.statuses?.[0];
          setResult(st?.filled ? `Filled ${st.filled.totalSz} @ $${st.filled.avgPx}` : st?.resting ? `Order resting #${st.resting.oid}` : st?.error || "Order placed");
          setSize("");
        } else {
          setResult(data.error || JSON.stringify(data));
        }
      } else {
        const res = await fetch("/api/hl/order", {
          method: "POST", headers,
          body: JSON.stringify({
            coin, isBuy: side === "buy", sz: size, limitPx: price,
            orderType: { limit: { tif: "Gtc" } },
          }),
        });
        const data = await res.json();
        if (data.status === "ok") {
          const st = data.response?.data?.statuses?.[0];
          setResult(st?.resting ? `Resting #${st.resting.oid}` : st?.filled ? `Filled ${st.filled.totalSz} @ $${st.filled.avgPx}` : st?.error || "Order placed");
          setSize(""); setPrice("");
        } else {
          setResult(data.error || JSON.stringify(data));
        }
      }
    } catch (e: any) {
      setResult(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!wallet.address) {
    return (
      <div className="p-4 flex flex-col items-center justify-center h-full gap-3">
        <Wallet className="w-8 h-8 text-zinc-600" />
        <p className="text-xs text-zinc-500 text-center">Connect wallet to start trading</p>
        <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-xs" onClick={wallet.connect} data-testid="button-connect-trade">
          Connect Wallet
        </Button>
      </div>
    );
  }

  if (!hlStatus?.linked || !hlStatus?.hasAgent) {
    return (
      <div className="p-4 flex flex-col items-center justify-center h-full gap-3">
        <Key className="w-8 h-8 text-zinc-600" />
        <p className="text-xs text-zinc-500 text-center">
          {!hlStatus?.linked ? "Link your Hyperliquid wallet to trade" : "Create an API wallet to enable trading"}
        </p>
        <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-xs" onClick={onShowSetup} data-testid="button-setup-hl">
          <Settings className="w-3.5 h-3.5 mr-1" />Setup Hyperliquid
        </Button>
      </div>
    );
  }

  return (
    <div className="p-3 space-y-3" data-testid="trade-ticket">
      <div className="px-2 py-1.5 text-[10px] font-semibold text-zinc-500 uppercase flex items-center gap-1">
        <Target className="w-3 h-3" />Trade {coin}-PERP
      </div>

      <div className="grid grid-cols-2 gap-1">
        <button
          className={cn("py-2 text-xs font-semibold rounded", side === "buy" ? "bg-emerald-600 text-white" : "bg-zinc-800 text-zinc-400")}
          onClick={() => setSide("buy")}
          data-testid="button-buy"
        >Long</button>
        <button
          className={cn("py-2 text-xs font-semibold rounded", side === "sell" ? "bg-red-600 text-white" : "bg-zinc-800 text-zinc-400")}
          onClick={() => setSide("sell")}
          data-testid="button-sell"
        >Short</button>
      </div>

      <div className="flex gap-2 text-[10px]">
        <button className={cn("px-2 py-1 rounded", orderType === "market" ? "bg-zinc-700 text-white" : "text-zinc-500")} onClick={() => setOrderType("market")} data-testid="button-market">Market</button>
        <button className={cn("px-2 py-1 rounded", orderType === "limit" ? "bg-zinc-700 text-white" : "text-zinc-500")} onClick={() => setOrderType("limit")} data-testid="button-limit">Limit</button>
      </div>

      {orderType === "limit" && (
        <div>
          <label className="text-[10px] text-zinc-500 mb-1 block">Price</label>
          <Input value={price} onChange={e => setPrice(e.target.value)} className="h-8 text-xs bg-zinc-800 border-zinc-700" placeholder="0.00" data-testid="input-price" />
        </div>
      )}

      <div>
        <label className="text-[10px] text-zinc-500 mb-1 block">Size ({coin})</label>
        <Input value={size} onChange={e => setSize(e.target.value)} className="h-8 text-xs bg-zinc-800 border-zinc-700" placeholder="0.00" data-testid="input-size" />
      </div>

      <div>
        <div className="flex justify-between text-[10px] text-zinc-500 mb-1">
          <span>Leverage</span>
          <span className="text-white font-mono">{leverage}x</span>
        </div>
        <Slider value={[leverage]} min={1} max={50} step={1} onValueChange={([v]) => setLeverage(v)} data-testid="slider-leverage" />
      </div>

      <div className="space-y-1 text-[10px] text-zinc-500">
        <div className="flex justify-between"><span>Notional</span><span className="text-white font-mono">${fmt(notional)}</span></div>
        <div className="flex justify-between"><span>Margin Required</span><span className="text-white font-mono">${fmt(margin)}</span></div>
      </div>

      <Button
        className={cn("w-full h-9 text-xs font-bold", side === "buy" ? "bg-emerald-600 hover:bg-emerald-700" : "bg-red-600 hover:bg-red-700")}
        disabled={submitting || !size || parseFloat(size) <= 0}
        onClick={submit}
        data-testid="button-submit-order"
      >
        {submitting ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : side === "buy" ? "Long" : "Short"} {coin}
      </Button>

      {result && (
        <div className={cn("text-[10px] p-2 rounded", result.includes("Filled") || result.includes("resting") || result.includes("Resting") ? "bg-emerald-900/30 text-emerald-400" : "bg-red-900/30 text-red-400")} data-testid="text-order-result">
          {result}
        </div>
      )}
    </div>
  );
}

function PositionsPanel({ positions, openOrders, wallet, totalPnl }: {
  positions: any[]; openOrders: any[]; wallet: any; totalPnl: number;
}) {
  const [tab, setTab] = useState<"positions" | "orders">("positions");
  const [closing, setClosing] = useState<number | null>(null);

  const cancelOrder = async (coin: string, oid: number) => {
    if (!wallet.address) return;
    try {
      await fetch("/api/hl/cancel-order", {
        method: "POST",
        headers: hlHeaders(wallet.address),
        body: JSON.stringify({ coin, oid }),
      });
    } catch {}
  };

  return (
    <div data-testid="positions-panel">
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-zinc-800">
        <button className={cn("text-[10px] font-semibold", tab === "positions" ? "text-white" : "text-zinc-500")} onClick={() => setTab("positions")} data-testid="tab-positions">
          Positions ({positions.length})
        </button>
        <button className={cn("text-[10px] font-semibold", tab === "orders" ? "text-white" : "text-zinc-500")} onClick={() => setTab("orders")} data-testid="tab-orders">
          Open Orders ({openOrders.length})
        </button>
        <div className="ml-auto text-[10px]">
          <span className="text-zinc-500">Unrealized PnL: </span>
          <span className={cn("font-mono font-bold", totalPnl >= 0 ? "text-emerald-400" : "text-red-400")}>${fmt(totalPnl)}</span>
        </div>
      </div>

      {tab === "positions" && (
        <div className="overflow-x-auto">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="text-zinc-600 border-b border-zinc-800">
                <th className="text-left px-3 py-1.5 font-medium">Symbol</th>
                <th className="text-right px-3 py-1.5 font-medium">Size</th>
                <th className="text-right px-3 py-1.5 font-medium">Entry</th>
                <th className="text-right px-3 py-1.5 font-medium">Mark</th>
                <th className="text-right px-3 py-1.5 font-medium">PnL</th>
                <th className="text-right px-3 py-1.5 font-medium">Liq.</th>
                <th className="text-right px-3 py-1.5 font-medium">Leverage</th>
              </tr>
            </thead>
            <tbody>
              {positions.length === 0 && (
                <tr><td colSpan={7} className="text-center py-4 text-zinc-600">No open positions</td></tr>
              )}
              {positions.map((p, i) => {
                const pos = p.position;
                const sz = parseFloat(pos.szi);
                const entry = parseFloat(pos.entryPx || "0");
                const pnl = parseFloat(pos.unrealizedPnl || "0");
                const liq = parseFloat(pos.liquidationPx || "0");
                return (
                  <tr key={i} className="border-b border-zinc-800/50 hover:bg-zinc-800/30" data-testid={`position-row-${i}`}>
                    <td className="px-3 py-1.5">
                      <span className="font-semibold">{pos.coin}</span>
                      <span className={cn("ml-1 text-[9px]", sz > 0 ? "text-emerald-400" : "text-red-400")}>{sz > 0 ? "LONG" : "SHORT"}</span>
                    </td>
                    <td className="text-right px-3 py-1.5 font-mono">{Math.abs(sz).toFixed(4)}</td>
                    <td className="text-right px-3 py-1.5 font-mono">${fmtPrice(entry)}</td>
                    <td className="text-right px-3 py-1.5 font-mono">-</td>
                    <td className={cn("text-right px-3 py-1.5 font-mono font-bold", pnl >= 0 ? "text-emerald-400" : "text-red-400")}>${fmt(pnl)}</td>
                    <td className="text-right px-3 py-1.5 font-mono text-yellow-500">{liq > 0 ? `$${fmtPrice(liq)}` : "-"}</td>
                    <td className="text-right px-3 py-1.5 font-mono">{pos.leverage?.value || "-"}x</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {tab === "orders" && (
        <div className="overflow-x-auto">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="text-zinc-600 border-b border-zinc-800">
                <th className="text-left px-3 py-1.5 font-medium">Symbol</th>
                <th className="text-right px-3 py-1.5 font-medium">Side</th>
                <th className="text-right px-3 py-1.5 font-medium">Price</th>
                <th className="text-right px-3 py-1.5 font-medium">Size</th>
                <th className="text-right px-3 py-1.5 font-medium">Type</th>
                <th className="text-right px-3 py-1.5 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {openOrders.length === 0 && (
                <tr><td colSpan={6} className="text-center py-4 text-zinc-600">No open orders</td></tr>
              )}
              {openOrders.map((o, i) => (
                <tr key={i} className="border-b border-zinc-800/50 hover:bg-zinc-800/30" data-testid={`order-row-${i}`}>
                  <td className="px-3 py-1.5 font-semibold">{o.coin}</td>
                  <td className={cn("text-right px-3 py-1.5", o.side === "B" ? "text-emerald-400" : "text-red-400")}>{o.side === "B" ? "Buy" : "Sell"}</td>
                  <td className="text-right px-3 py-1.5 font-mono">${fmtPrice(parseFloat(o.limitPx || "0"))}</td>
                  <td className="text-right px-3 py-1.5 font-mono">{o.sz}</td>
                  <td className="text-right px-3 py-1.5">{o.orderType || "Limit"}</td>
                  <td className="text-right px-3 py-1.5">
                    <button
                      className="text-red-400 hover:text-red-300 text-[9px]"
                      onClick={() => cancelOrder(o.coin, o.oid)}
                      data-testid={`cancel-order-${i}`}
                    >Cancel</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SetupModal({ wallet, hlStatus, onClose, onRefresh }: {
  wallet: any; hlStatus: any; onClose: () => void; onRefresh: () => void;
}) {
  const [step, setStep] = useState<"link" | "agent" | "done">(
    !hlStatus?.linked ? "link" : !hlStatus?.hasAgent ? "agent" : "done"
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentKey, setAgentKey] = useState("");
  const [copied, setCopied] = useState(false);
  const [newAgentKey, setNewAgentKey] = useState<string | null>(null);

  const linkWallet = async () => {
    if (!wallet.address) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/hl/link-wallet", {
        method: "POST",
        headers: hlHeaders(wallet.address),
        body: JSON.stringify({ userAddress: wallet.address }),
      });
      const data = await res.json();
      if (data.success) {
        onRefresh();
        setStep("agent");
      } else {
        setError(data.error || "Failed to link");
      }
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  const linkExistingAgent = async () => {
    if (!agentKey || !wallet.address) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/hl/link-agent", {
        method: "POST",
        headers: hlHeaders(wallet.address),
        body: JSON.stringify({ agentPrivateKey: agentKey, userAddress: wallet.address }),
      });
      const data = await res.json();
      if (data.success) {
        onRefresh();
        setStep("done");
      } else {
        setError(data.error || "Failed to link agent");
      }
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  const createNewAgent = async () => {
    if (!wallet.address) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/hl/create-agent", {
        method: "POST",
        headers: hlHeaders(wallet.address),
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (data.success) {
        setNewAgentKey(data.agentKey);
        onRefresh();
        setStep("done");
      } else {
        setError(data.error || "Failed to create agent");
      }
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  const prepareAndSignAgent = async () => {
    if (!wallet.address || !window.ethereum) return;
    setLoading(true);
    setError(null);
    try {
      const prepRes = await fetch("/api/hl/prepare-agent-approval", {
        method: "POST",
        headers: hlHeaders(wallet.address),
        body: JSON.stringify({}),
      });
      const prepData = await prepRes.json();
      if (!prepData.typedData) throw new Error(prepData.error || "Failed to prepare");

      const { domain, types, primaryType, message } = prepData.typedData;
      const msgParam = JSON.stringify({ domain, types: { ...types, EIP712Domain: undefined }, primaryType, message });

      const sig = await window.ethereum.request({
        method: "eth_signTypedData_v4",
        params: [wallet.address, msgParam],
      });

      const { ethers } = await import("ethers");
      const { r, s, v } = ethers.Signature.from(sig);

      const submitRes = await fetch("/api/hl/submit-agent-approval", {
        method: "POST",
        headers: hlHeaders(wallet.address),
        body: JSON.stringify({
          signature: { r, s, v },
          agentKey: prepData.agentKey,
          agentAddress: prepData.agentAddress,
          nonce: prepData.nonce,
        }),
      });
      const submitData = await submitRes.json();
      if (submitData.success) {
        setNewAgentKey(prepData.agentKey);
        onRefresh();
        setStep("done");
      } else {
        setError(submitData.error || "Approval failed");
      }
    } catch (e: any) {
      if (e.code === 4001) setError("Signature rejected");
      else setError(e.message);
    } finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" data-testid="setup-modal">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <span className="text-emerald-400 font-bold">HL</span>
            <span className="text-sm font-semibold">Hyperliquid Setup</span>
          </div>
          <button onClick={onClose}><X className="w-4 h-4 text-zinc-500" /></button>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex items-center gap-3">
            {["link", "agent", "done"].map((s, i) => (
              <div key={s} className="flex items-center gap-2">
                <div className={cn(
                  "w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold",
                  step === s ? "bg-emerald-600 text-white" :
                  ["link", "agent", "done"].indexOf(step) > i ? "bg-emerald-800 text-emerald-400" :
                  "bg-zinc-800 text-zinc-500"
                )}>{i + 1}</div>
                {i < 2 && <div className={cn("w-8 h-px", ["link", "agent", "done"].indexOf(step) > i ? "bg-emerald-800" : "bg-zinc-700")} />}
              </div>
            ))}
          </div>

          {step === "link" && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">Link Your Wallet</h3>
              <p className="text-xs text-zinc-400">Connect your Arbitrum wallet address to start trading on Hyperliquid.</p>
              <div className="p-3 bg-zinc-800 rounded-lg text-xs font-mono break-all" data-testid="text-wallet-address">
                {wallet.address}
              </div>
              <Button className="w-full bg-emerald-600 hover:bg-emerald-700 text-xs" onClick={linkWallet} disabled={loading} data-testid="button-link-wallet">
                {loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin mr-1" /> : <Link2 className="w-3.5 h-3.5 mr-1" />}
                Link This Wallet
              </Button>
            </div>
          )}

          {step === "agent" && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">Create API Wallet</h3>
              <p className="text-xs text-zinc-400">An API wallet lets our platform trade on your behalf without withdrawal permissions.</p>

              <div className="space-y-2">
                <Button className="w-full bg-emerald-600 hover:bg-emerald-700 text-xs" onClick={prepareAndSignAgent} disabled={loading} data-testid="button-create-agent-metamask">
                  {loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin mr-1" /> : <Zap className="w-3.5 h-3.5 mr-1" />}
                  Sign with MetaMask (Recommended)
                </Button>

                <div className="relative py-2">
                  <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-zinc-700" /></div>
                  <div className="relative flex justify-center"><span className="bg-zinc-900 px-2 text-[10px] text-zinc-500">or paste existing</span></div>
                </div>

                <Input
                  value={agentKey}
                  onChange={e => setAgentKey(e.target.value)}
                  placeholder="0x... (API wallet private key)"
                  className="h-8 text-xs bg-zinc-800 border-zinc-700 font-mono"
                  type="password"
                  data-testid="input-agent-key"
                />
                <Button variant="outline" className="w-full text-xs border-zinc-700" onClick={linkExistingAgent} disabled={loading || !agentKey} data-testid="button-link-existing-agent">
                  <Key className="w-3.5 h-3.5 mr-1" />Link Existing API Wallet
                </Button>
              </div>
            </div>
          )}

          {step === "done" && (
            <div className="space-y-3 text-center">
              <div className="w-12 h-12 rounded-full bg-emerald-900/50 flex items-center justify-center mx-auto">
                <Check className="w-6 h-6 text-emerald-400" />
              </div>
              <h3 className="text-sm font-semibold">You're All Set!</h3>
              <p className="text-xs text-zinc-400">Your Hyperliquid account is linked and ready to trade.</p>
              {hlStatus?.agentAddress && (
                <div className="text-[10px] text-zinc-500">
                  API Wallet: <span className="font-mono text-zinc-400">{hlStatus.agentAddress}</span>
                </div>
              )}
              {newAgentKey && (
                <div className="p-3 bg-yellow-900/20 border border-yellow-800 rounded-lg text-left">
                  <p className="text-[10px] text-yellow-400 font-semibold mb-1">Save your API wallet key:</p>
                  <div className="flex items-center gap-2">
                    <code className="text-[9px] text-yellow-300 break-all flex-1">{newAgentKey}</code>
                    <button onClick={() => { navigator.clipboard.writeText(newAgentKey); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
                      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-zinc-400" />}
                    </button>
                  </div>
                </div>
              )}
              <Button className="w-full bg-emerald-600 hover:bg-emerald-700 text-xs" onClick={onClose} data-testid="button-start-trading">
                Start Trading
              </Button>
            </div>
          )}

          {error && (
            <div className="p-2 bg-red-900/30 border border-red-800 rounded text-xs text-red-400" data-testid="text-setup-error">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
