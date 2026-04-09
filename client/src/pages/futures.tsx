import { useState, useEffect, useCallback, useRef, useMemo, Component } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TrendingUp,
  TrendingDown,
  RefreshCw,
  Activity,
  DollarSign,
  BarChart3,
  X,
  ChevronDown,
  LogOut,
  Maximize2,
  AlertTriangle,
  Wallet,
  Zap,
  ArrowUpDown,
  Bot,
  Search,
} from "lucide-react";
import { createChart, ColorType, CrosshairMode, LineStyle } from "lightweight-charts";

declare global {
  interface Window { ethereum?: any; }
}

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
            <button onClick={() => window.location.reload()} className="px-4 py-2 text-xs bg-zinc-800 border border-zinc-700 rounded hover:bg-zinc-700">Reload</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function useWallet() {
  const [address, setAddress] = useState<string | null>(() => {
    try { return localStorage.getItem("futures_wallet") || null; } catch { return null; }
  });
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const wcRef = useRef<any>(null);

  const connectMM = useCallback(async () => {
    if (!window.ethereum) { setError("No browser wallet detected."); return; }
    setConnecting(true); setError(null);
    try {
      const accts = await window.ethereum.request({ method: "eth_requestAccounts" });
      if (accts?.length) {
        const a = accts[0].toLowerCase();
        setAddress(a); localStorage.setItem("futures_wallet", a); localStorage.setItem("futures_wallet_type", "metamask");
      }
    } catch (e: any) { setError(e.message || "Failed"); } finally { setConnecting(false); }
  }, []);

  const connectWC = useCallback(async () => {
    setConnecting(true); setError(null);
    try {
      let projectId = "";
      try { const r = await fetch("/api/web4/walletconnect-config"); const c = await r.json(); projectId = c.projectId || ""; } catch {}
      if (!projectId) { setError("WalletConnect not configured."); setConnecting(false); return; }
      const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
      if (wcRef.current) { try { await wcRef.current.disconnect(); } catch {} wcRef.current = null; }
      const wc = await EthereumProvider.init({
        projectId, chains: [56], optionalChains: [1, 56, 97], showQrModal: true,
        metadata: { name: "BUILD4", description: "BUILD4 Trading", url: window.location.origin, icons: [`${window.location.origin}/favicon.ico`] },
        rpcMap: { 1: "https://eth.drpc.org", 56: "https://bsc-dataseed1.binance.org", 97: "https://data-seed-prebsc-1-s1.binance.org:8545" },
      });
      wcRef.current = wc;
      wc.on("disconnect", () => { setAddress(null); localStorage.removeItem("futures_wallet"); localStorage.removeItem("futures_wallet_type"); });
      wc.on("accountsChanged", (a: string[]) => { if (a.length) { const x = a[0].toLowerCase(); setAddress(x); localStorage.setItem("futures_wallet", x); } else { setAddress(null); } });
      await Promise.race([wc.enable(), new Promise<never>((_, r) => setTimeout(() => r(new Error("Timeout")), 120000))]);
      if (wc.accounts?.length) { const a = wc.accounts[0].toLowerCase(); setAddress(a); localStorage.setItem("futures_wallet", a); localStorage.setItem("futures_wallet_type", "walletconnect"); }
    } catch (e: any) { if (!e.message?.includes("closed") && !e.message?.includes("rejected")) setError(e.message || "Failed"); } finally { setConnecting(false); }
  }, []);

  const connect = useCallback(() => { if (window.ethereum) setShowPicker(true); else connectWC(); }, [connectWC]);
  const disconnect = useCallback(() => { setAddress(null); localStorage.removeItem("futures_wallet"); localStorage.removeItem("futures_wallet_type"); if (wcRef.current) { try { wcRef.current.disconnect(); } catch {} } }, []);

  useEffect(() => {
    if (!window.ethereum) return;
    const h = (a: string[]) => { if (a.length) { const x = a[0].toLowerCase(); setAddress(x); localStorage.setItem("futures_wallet", x); } else disconnect(); };
    window.ethereum.on("accountsChanged", h);
    return () => { window.ethereum?.removeListener("accountsChanged", h); };
  }, [disconnect]);

  useEffect(() => {
    const t = (() => { try { return localStorage.getItem("futures_wallet_type"); } catch { return null; } })();
    if (t === "metamask" && window.ethereum) window.ethereum.request({ method: "eth_accounts" }).then((a: string[]) => { if (a.length) { const x = a[0].toLowerCase(); setAddress(x); } }).catch(() => {});
  }, []);

  return { address, connecting, error, connect, disconnect, showPicker, setShowPicker, connectMM, connectWC };
}

function useApi<T>(url: string, wallet: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    if (!wallet) { setLoading(false); return; }
    setLoading(true);
    try { const r = await fetch(url, { headers: { "x-wallet-address": wallet } }); if (r.ok) setData(await r.json()); } catch {} finally { setLoading(false); }
  }, [url, wallet]);
  useEffect(() => { refresh(); }, [refresh]);
  return { data, loading, refresh };
}

function usePub<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try { const r = await fetch(url); if (r.ok) setData(await r.json()); } catch {} finally { setLoading(false); }
  }, [url]);
  useEffect(() => { refresh(); }, [refresh]);
  return { data, loading, refresh };
}

async function post(url: string, wallet: string, body: any) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-wallet-address": wallet }, body: JSON.stringify(body) });
  return r.json();
}

interface Pos { symbol: string; side: string; size: number; entryPrice: number; markPrice: number; leverage: string; unrealizedPnl: number; notional: number; }
interface AcctData { connected: boolean; walletBalance: number; availableMargin: number; bscBalance: number; unrealizedPnl: number; realizedPnl: number; positions: Pos[]; }
interface MktItem { symbol: string; price: number; change24h: number; volume24h: number; high24h: number; low24h: number; }
interface TickerData { symbol: string; price: number; change24h: number; volume24h: number; high24h: number; low24h: number; markPrice?: number; indexPrice?: number; fundingRate?: number; openInterest?: number; nextFundingTime?: number; }

const PAIRS = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","DOGEUSDT","XRPUSDT","AVAXUSDT","LINKUSDT","ADAUSDT","DOTUSDT","LTCUSDT","MATICUSDT"];
const INTERVALS = ["1m","5m","15m","1h","4h","1d"];

function TradingChart({ symbol, interval }: { symbol: string; interval: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const seriesRef = useRef<any>(null);
  const volRef = useRef<any>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: "#0a0b0d" }, textColor: "#6b7280" },
      grid: { vertLines: { color: "#1a1b1e" }, horzLines: { color: "#1a1b1e" } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: "#374151", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#374151" }, horzLine: { color: "#374151", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#374151" } },
      rightPriceScale: { borderColor: "#1f2937", scaleMargins: { top: 0.1, bottom: 0.25 } },
      timeScale: { borderColor: "#1f2937", timeVisible: true, secondsVisible: false },
      handleScroll: true,
      handleScale: true,
    });
    const cs = chart.addCandlestickSeries({
      upColor: "#22c55e", downColor: "#ef4444", borderUpColor: "#22c55e", borderDownColor: "#ef4444",
      wickUpColor: "#22c55e", wickDownColor: "#ef4444",
    });
    const vs = chart.addHistogramSeries({
      color: "#374151", priceFormat: { type: "volume" },
      priceScaleId: "vol",
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    chartRef.current = chart;
    seriesRef.current = cs;
    volRef.current = vs;
    const ro = new ResizeObserver(entries => { const { width, height } = entries[0].contentRect; chart.applyOptions({ width, height }); });
    ro.observe(containerRef.current);
    return () => { ro.disconnect(); chart.remove(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/public/klines?symbol=${symbol}&interval=${interval}&limit=500`);
        if (!r.ok || cancelled) return;
        const raw = await r.json();
        if (!Array.isArray(raw) || cancelled) return;
        const candles = raw.map((k: any) => ({ time: (k.openTime || k[0]) / 1000, open: parseFloat(k.open || k[1]), high: parseFloat(k.high || k[2]), low: parseFloat(k.low || k[3]), close: parseFloat(k.close || k[4]) })).filter((c: any) => c.time > 0 && !isNaN(c.open));
        const vols = raw.map((k: any) => ({ time: (k.openTime || k[0]) / 1000, value: parseFloat(k.volume || k[5] || "0"), color: parseFloat(k.close || k[4]) >= parseFloat(k.open || k[1]) ? "#22c55e33" : "#ef444433" }));
        if (!cancelled && seriesRef.current) { seriesRef.current.setData(candles); volRef.current?.setData(vols); chartRef.current?.timeScale().fitContent(); }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [symbol, interval]);

  return <div ref={containerRef} className="w-full h-full" data-testid="chart-container" />;
}

function OrderBook({ symbol }: { symbol: string }) {
  const [book, setBook] = useState<{ bids: [string, string][]; asks: [string, string][] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(`/api/public/depth?symbol=${symbol}&limit=15`);
        if (r.ok && !cancelled) setBook(await r.json());
      } catch {}
    };
    load();
    const iv = setInterval(load, 3000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [symbol]);

  if (!book) return <div className="p-3 text-xs text-zinc-600">Loading order book...</div>;

  const asks = [...(book.asks || [])].slice(0, 10).reverse();
  const bids = (book.bids || []).slice(0, 10);
  const maxQty = Math.max(...[...asks, ...bids].map(([_, q]) => parseFloat(q) || 0), 0.001);

  return (
    <div className="text-[11px] font-mono" data-testid="orderbook">
      <div className="grid grid-cols-3 px-2 py-1 text-zinc-500 border-b border-zinc-800/50">
        <span>Price</span><span className="text-right">Size</span><span className="text-right">Total</span>
      </div>
      <div className="max-h-[220px] overflow-hidden">
        {asks.map(([p, q], i) => {
          const pct = (parseFloat(q) / maxQty) * 100;
          return (
            <div key={"a" + i} className="grid grid-cols-3 px-2 py-[2px] relative hover:bg-zinc-800/30">
              <div className="absolute right-0 top-0 bottom-0 bg-red-500/8" style={{ width: `${pct}%` }} />
              <span className="text-red-400 relative z-10">{fmtPrice(parseFloat(p))}</span>
              <span className="text-right text-zinc-400 relative z-10">{parseFloat(q).toFixed(4)}</span>
              <span className="text-right text-zinc-500 relative z-10">{fmtK(parseFloat(p) * parseFloat(q))}</span>
            </div>
          );
        })}
      </div>
      <div className="px-2 py-1.5 border-y border-zinc-800/50 text-center">
        <span className="text-sm font-bold text-white">{bids[0] ? fmtPrice(parseFloat(bids[0][0])) : "—"}</span>
      </div>
      <div className="max-h-[220px] overflow-hidden">
        {bids.map(([p, q], i) => {
          const pct = (parseFloat(q) / maxQty) * 100;
          return (
            <div key={"b" + i} className="grid grid-cols-3 px-2 py-[2px] relative hover:bg-zinc-800/30">
              <div className="absolute right-0 top-0 bottom-0 bg-emerald-500/8" style={{ width: `${pct}%` }} />
              <span className="text-emerald-400 relative z-10">{fmtPrice(parseFloat(p))}</span>
              <span className="text-right text-zinc-400 relative z-10">{parseFloat(q).toFixed(4)}</span>
              <span className="text-right text-zinc-500 relative z-10">{fmtK(parseFloat(p) * parseFloat(q))}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TradeTicket({ symbol, wallet, price, onSuccess }: { symbol: string; wallet: string; price: number; onSuccess: () => void }) {
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT">("MARKET");
  const [amount, setAmount] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [leverage, setLeverage] = useState(10);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const margin = parseFloat(amount) || 0;
  const liqPrice = useMemo(() => {
    if (!price || !margin) return 0;
    const dir = side === "BUY" ? 1 : -1;
    return price * (1 - dir / leverage);
  }, [price, margin, leverage, side]);

  const submit = async () => {
    if (!margin || margin <= 0) return;
    setSubmitting(true); setResult(null);
    try {
      const payload: any = { symbol, side, amount: margin, leverage };
      if (orderType === "LIMIT" && limitPrice) payload.price = limitPrice;
      const data = await post("/api/miniapp/trade", wallet, payload);
      if (data.success || data.orderId) {
        setResult({ ok: true, msg: `${side} ${data.quantity} ${symbol} filled` });
        setAmount(""); onSuccess();
      } else {
        setResult({ ok: false, msg: data.error || "Order failed" });
      }
    } catch (e: any) {
      setResult({ ok: false, msg: e.message || "Network error" });
    } finally { setSubmitting(false); }
  };

  const isBuy = side === "BUY";

  return (
    <div className="p-3 space-y-3" data-testid="trade-ticket">
      <div className="flex gap-1">
        <button onClick={() => setSide("BUY")} data-testid="button-buy" className={`flex-1 py-2 text-xs font-bold rounded transition-all ${isBuy ? "bg-emerald-500 text-white shadow-lg shadow-emerald-500/20" : "bg-zinc-800/50 text-zinc-400 hover:bg-zinc-800"}`}>LONG</button>
        <button onClick={() => setSide("SELL")} data-testid="button-sell" className={`flex-1 py-2 text-xs font-bold rounded transition-all ${!isBuy ? "bg-red-500 text-white shadow-lg shadow-red-500/20" : "bg-zinc-800/50 text-zinc-400 hover:bg-zinc-800"}`}>SHORT</button>
      </div>

      <div className="flex gap-1">
        <button onClick={() => setOrderType("MARKET")} className={`flex-1 py-1 text-[10px] rounded ${orderType === "MARKET" ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-300"}`}>Market</button>
        <button onClick={() => setOrderType("LIMIT")} className={`flex-1 py-1 text-[10px] rounded ${orderType === "LIMIT" ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-300"}`}>Limit</button>
      </div>

      {orderType === "LIMIT" && (
        <div>
          <label className="text-[10px] text-zinc-500 mb-1 block">Limit Price</label>
          <Input value={limitPrice} onChange={e => setLimitPrice(e.target.value)} placeholder={fmtPrice(price)} className="h-8 bg-zinc-900 border-zinc-800 text-xs font-mono" data-testid="input-limit-price" />
        </div>
      )}

      <div>
        <label className="text-[10px] text-zinc-500 mb-1 block">Margin (USDT)</label>
        <Input value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" className="h-8 bg-zinc-900 border-zinc-800 text-xs font-mono" data-testid="input-margin" />
        <div className="flex gap-1 mt-1">
          {[10, 25, 50, 100].map(pct => (
            <button key={pct} onClick={() => setAmount(String(pct))} className="flex-1 py-0.5 text-[9px] bg-zinc-800/50 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800">{pct === 100 ? "Max" : `$${pct}`}</button>
          ))}
        </div>
      </div>

      <div>
        <div className="flex justify-between text-[10px] text-zinc-500 mb-1">
          <span>Leverage</span><span className="text-white font-bold">{leverage}x</span>
        </div>
        <Slider value={[leverage]} onValueChange={v => setLeverage(v[0])} min={1} max={125} step={1} className="py-1" data-testid="slider-leverage" />
        <div className="flex gap-1 mt-1">
          {[1, 5, 10, 25, 50, 100].map(l => (
            <button key={l} onClick={() => setLeverage(l)} className={`flex-1 py-0.5 text-[9px] rounded ${leverage === l ? "bg-zinc-700 text-white" : "bg-zinc-800/50 text-zinc-500 hover:text-zinc-300"}`}>{l}x</button>
          ))}
        </div>
      </div>

      {margin > 0 && (
        <div className="bg-zinc-900/50 rounded p-2 space-y-1 text-[10px]">
          <div className="flex justify-between text-zinc-500"><span>Notional</span><span className="text-zinc-300">${fmt(margin * leverage)}</span></div>
          <div className="flex justify-between text-zinc-500"><span>Est. Liq. Price</span><span className={isBuy ? "text-red-400" : "text-emerald-400"}>${fmtPrice(liqPrice)}</span></div>
          <div className="flex justify-between text-zinc-500"><span>Fee (est.)</span><span className="text-zinc-400">${fmt(margin * leverage * 0.0005)}</span></div>
        </div>
      )}

      <Button onClick={submit} disabled={submitting || !margin} data-testid="button-submit-order" className={`w-full h-9 font-bold text-sm ${isBuy ? "bg-emerald-500 hover:bg-emerald-400 shadow-lg shadow-emerald-500/20" : "bg-red-500 hover:bg-red-400 shadow-lg shadow-red-500/20"} text-white border-0`}>
        {submitting ? <RefreshCw className="w-4 h-4 animate-spin" /> : `${isBuy ? "Long" : "Short"} ${symbol.replace("USDT", "")}`}
      </Button>

      {result && (
        <div className={`text-xs p-2 rounded ${result.ok ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" : "bg-red-500/10 text-red-400 border border-red-500/20"}`} data-testid="text-order-result">
          {result.msg}
        </div>
      )}
    </div>
  );
}

function PositionsPanel({ positions, wallet, onClose }: { positions: Pos[]; wallet: string; onClose: () => void }) {
  const [closing, setClosing] = useState<string | null>(null);

  const handleClose = async (sym: string) => {
    setClosing(sym);
    try {
      await post("/api/miniapp/close", wallet, { symbol: sym });
      onClose();
    } catch {} finally { setClosing(null); }
  };

  const totalPnl = positions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);

  if (!positions.length) return (
    <div className="p-4 text-center text-zinc-600 text-xs">No open positions</div>
  );

  return (
    <div data-testid="positions-panel">
      <div className="px-3 py-2 border-b border-zinc-800/50 flex justify-between items-center">
        <span className="text-xs text-zinc-400">{positions.length} Position{positions.length > 1 ? "s" : ""}</span>
        <span className={`text-xs font-bold font-mono ${totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>{totalPnl >= 0 ? "+" : ""}{fmt(totalPnl)} USDT</span>
      </div>
      {positions.map((p, i) => {
        const pnlPct = p.entryPrice > 0 ? ((p.markPrice - p.entryPrice) / p.entryPrice * 100 * (p.side === "BUY" ? 1 : -1)) : 0;
        return (
          <div key={i} className="px-3 py-2 border-b border-zinc-800/30 hover:bg-zinc-800/20 transition-colors" data-testid={`position-${p.symbol}`}>
            <div className="flex justify-between items-center mb-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-white">{p.symbol.replace("USDT", "")}</span>
                <Badge variant="outline" className={`text-[9px] px-1 py-0 border-0 ${p.side === "BUY" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>
                  {p.side === "BUY" ? "LONG" : "SHORT"} {p.leverage}x
                </Badge>
              </div>
              <button onClick={() => handleClose(p.symbol)} disabled={closing === p.symbol} data-testid={`button-close-${p.symbol}`} className="text-[9px] px-2 py-0.5 bg-zinc-800 rounded text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors">
                {closing === p.symbol ? "..." : "Close"}
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2 text-[10px]">
              <div><span className="text-zinc-600">Size</span><br /><span className="text-zinc-300 font-mono">{Math.abs(p.size).toFixed(4)}</span></div>
              <div><span className="text-zinc-600">Entry</span><br /><span className="text-zinc-300 font-mono">{fmtPrice(p.entryPrice)}</span></div>
              <div className="text-right"><span className="text-zinc-600">PnL</span><br /><span className={`font-mono font-bold ${p.unrealizedPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>{p.unrealizedPnl >= 0 ? "+" : ""}{fmt(p.unrealizedPnl)} ({pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%)</span></div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PairSelector({ selected, onSelect, onClose }: { selected: string; onSelect: (s: string) => void; onClose: () => void }) {
  const [search, setSearch] = useState("");
  const { data: marketsResp } = usePub<{ markets: MktItem[] }>("/api/public/markets");

  const filtered = useMemo(() => {
    const list = marketsResp?.markets || PAIRS.map(s => ({ symbol: s, price: 0, change24h: 0, volume24h: 0, high24h: 0, low24h: 0 }));
    if (!search) return list;
    return list.filter(m => m.symbol.toLowerCase().includes(search.toLowerCase()));
  }, [marketsResp, search]);

  return (
    <div className="absolute top-0 left-0 right-0 z-50 bg-[#0d0e10] border border-zinc-800 rounded-lg shadow-2xl max-h-[400px] overflow-hidden" data-testid="pair-selector">
      <div className="p-2 border-b border-zinc-800/50 flex items-center gap-2">
        <Search className="w-3.5 h-3.5 text-zinc-500" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search pairs..." className="flex-1 bg-transparent text-xs text-white outline-none" autoFocus data-testid="input-search-pair" />
        <button onClick={onClose} className="text-zinc-500 hover:text-white"><X className="w-3.5 h-3.5" /></button>
      </div>
      <div className="max-h-[350px] overflow-y-auto">
        {filtered.map(m => (
          <button key={m.symbol} onClick={() => { onSelect(m.symbol); onClose(); }} data-testid={`pair-${m.symbol}`}
            className={`w-full px-3 py-2 flex justify-between items-center hover:bg-zinc-800/40 transition-colors text-xs ${m.symbol === selected ? "bg-zinc-800/60" : ""}`}>
            <div className="flex items-center gap-2">
              <span className="font-bold text-white">{m.symbol.replace("USDT", "")}</span>
              <span className="text-zinc-600 text-[10px]">/USDT</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="font-mono text-zinc-300">{fmtPrice(m.price)}</span>
              <span className={`font-mono ${m.change24h >= 0 ? "text-emerald-400" : "text-red-400"}`}>{m.change24h >= 0 ? "+" : ""}{m.change24h?.toFixed(2)}%</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function ActivationFlow({ wallet, onDone }: { wallet: string; onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const activate = async () => {
    setWorking(true); setError(null);
    try {
      setStep(1);
      const regRes = await fetch("/api/miniapp/web-register", {
        method: "POST", headers: { "Content-Type": "application/json", "x-wallet-address": wallet },
        body: JSON.stringify({ walletAddress: wallet }),
      });
      const regData = await regRes.json();
      if (regData.error && !regData.error.includes("already")) { setError(regData.error); setWorking(false); return; }

      setStep(2);
      const actRes = await fetch("/api/miniapp/activate-trading", {
        method: "POST", headers: { "Content-Type": "application/json", "x-wallet-address": wallet },
        body: JSON.stringify({ walletAddress: wallet }),
      });
      const actData = await actRes.json();
      if (actData.error) { setError(actData.error); setWorking(false); return; }
      if (actData.alreadyActive) { setStep(5); onDone(); return; }
      const sessionId = actData.sessionId;
      const tradingAddress = actData.tradingWalletAddress;
      if (!tradingAddress) { setError("No trading address returned"); setWorking(false); return; }

      setStep(3);
      const nonceRes = await fetch("https://www.asterdex.com/bapi/futures/v1/public/future/web3/get-nonce", {
        method: "POST",
        headers: { "Content-Type": "application/json", "clientType": "web" },
        body: JSON.stringify({ type: "LOGIN", sourceAddr: tradingAddress }),
      });
      const nonceData = await nonceRes.json();
      if (!nonceData?.data?.nonce) { setError("Failed to get registration nonce from Aster DEX"); setWorking(false); return; }

      const signRes = await fetch("/api/miniapp/sign-registration", {
        method: "POST", headers: { "Content-Type": "application/json", "x-wallet-address": wallet },
        body: JSON.stringify({ sessionId, nonce: nonceData.data.nonce }),
      });
      const signData = await signRes.json();
      if (!signData.signature) { setError("Failed to sign registration"); setWorking(false); return; }

      const loginRes = await fetch("https://www.asterdex.com/bapi/futures/v1/public/future/web3/ae/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "clientType": "web" },
        body: JSON.stringify({ signature: signData.signature, sourceAddr: tradingAddress, chainId: 56, agentCode: "BUILD4" }),
      });
      const loginData = await loginRes.json();
      if (loginData?.code !== "000000" && loginData?.code !== 0) {
        console.log("Aster login response:", loginData);
      }

      setStep(4);
      const complRes = await fetch("/api/miniapp/complete-activation", {
        method: "POST", headers: { "Content-Type": "application/json", "x-wallet-address": wallet },
        body: JSON.stringify({ sessionId }),
      });
      const complData = await complRes.json();
      if (complData.error) { setError(complData.error); setWorking(false); return; }

      setStep(5);
      onDone();
    } catch (e: any) {
      setError(e.message || "Activation failed");
    } finally { setWorking(false); }
  };

  return (
    <div className="p-6 text-center space-y-4" data-testid="activation-flow">
      <div className="w-12 h-12 mx-auto rounded-full bg-gradient-to-br from-emerald-500/20 to-cyan-500/20 flex items-center justify-center">
        <Zap className="w-6 h-6 text-emerald-400" />
      </div>
      <div>
        <h3 className="text-sm font-bold text-white mb-1">Activate Trading</h3>
        <p className="text-xs text-zinc-500">Set up your Aster DEX agent to start trading perpetual futures.</p>
      </div>
      {step > 0 && (
        <div className="text-xs space-y-1 text-left max-w-xs mx-auto">
          <div className={step >= 1 ? "text-emerald-400" : "text-zinc-600"}>1. Registering wallet...</div>
          <div className={step >= 2 ? "text-emerald-400" : "text-zinc-600"}>2. Creating trading wallet...</div>
          <div className={step >= 3 ? "text-emerald-400" : "text-zinc-600"}>3. Registering on Aster DEX...</div>
          <div className={step >= 4 ? "text-emerald-400" : "text-zinc-600"}>4. Approving agent on-chain...</div>
          <div className={step >= 5 ? "text-emerald-400" : "text-zinc-600"}>5. Done!</div>
        </div>
      )}
      {error && <div className="text-xs text-red-400 bg-red-500/10 p-2 rounded border border-red-500/20">{error}</div>}
      <Button onClick={activate} disabled={working} data-testid="button-activate" className="bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-400 hover:to-cyan-400 text-white border-0 shadow-lg">
        {working ? <RefreshCw className="w-4 h-4 animate-spin mr-2" /> : null}{working ? `Step ${step}/4...` : "Activate Now"}
      </Button>
    </div>
  );
}

function WalletPicker({ onMM, onWC, onClose }: { onMM: () => void; onWC: () => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose} data-testid="wallet-picker">
      <div className="bg-[#0d0e10] border border-zinc-800 rounded-xl p-5 w-80 space-y-3" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center">
          <h3 className="text-sm font-bold text-white">Connect Wallet</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <button onClick={() => { onMM(); onClose(); }} data-testid="button-metamask" className="w-full p-3 bg-zinc-900 border border-zinc-800 rounded-lg hover:border-zinc-600 transition-colors flex items-center gap-3">
          <Wallet className="w-5 h-5 text-orange-400" /><span className="text-sm text-white">Browser Wallet</span>
        </button>
        <button onClick={() => { onWC(); onClose(); }} data-testid="button-walletconnect" className="w-full p-3 bg-zinc-900 border border-zinc-800 rounded-lg hover:border-zinc-600 transition-colors flex items-center gap-3">
          <Activity className="w-5 h-5 text-blue-400" /><span className="text-sm text-white">WalletConnect</span>
        </button>
      </div>
    </div>
  );
}

function FuturesTerminal() {
  const { address, connecting, error: walletError, connect, disconnect, showPicker, setShowPicker, connectMM, connectWC } = useWallet();
  const [selectedPair, setSelectedPair] = useState("BTCUSDT");
  const [interval, setInterval] = useState("15m");
  const [showPairs, setShowPairs] = useState(false);
  const [bottomTab, setBottomTab] = useState<"positions" | "orders" | "trades">("positions");

  const { data: acct, loading: acctLoading, refresh: refreshAcct } = useApi<AcctData>("/api/miniapp/account", address);
  const { data: rawTicker } = usePub<any>(`/api/public/ticker?symbol=${selectedPair}`);
  const { data: rawFunding } = usePub<any>(`/api/public/funding?symbol=${selectedPair}`);

  const ticker: TickerData | null = useMemo(() => {
    if (!rawTicker) return null;
    return {
      symbol: rawTicker.symbol || selectedPair,
      price: parseFloat(rawTicker.lastPrice || rawTicker.price || "0"),
      change24h: parseFloat(rawTicker.priceChangePercent || rawTicker.change24h || "0"),
      volume24h: parseFloat(rawTicker.quoteVolume || rawTicker.volume24h || "0"),
      high24h: parseFloat(rawTicker.highPrice || rawTicker.high24h || "0"),
      low24h: parseFloat(rawTicker.lowPrice || rawTicker.low24h || "0"),
      markPrice: parseFloat(rawTicker.markPrice || "0"),
      indexPrice: parseFloat(rawTicker.indexPrice || "0"),
      fundingRate: parseFloat(rawTicker.fundingRate || "0"),
      openInterest: parseFloat(rawTicker.openInterest || "0"),
    };
  }, [rawTicker, selectedPair]);
  const funding = useMemo(() => {
    if (!rawFunding) return null;
    const item = Array.isArray(rawFunding) ? rawFunding[0] : rawFunding;
    return item ? { fundingRate: parseFloat(item.fundingRate || "0") } : null;
  }, [rawFunding]);

  useEffect(() => {
    if (!address) return;
    const iv = window.setInterval(refreshAcct, 15000);
    return () => clearInterval(iv);
  }, [address, refreshAcct]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "b" || e.key === "B") { document.querySelector<HTMLButtonElement>('[data-testid="button-buy"]')?.click(); }
      if (e.key === "s" || e.key === "S") { document.querySelector<HTMLButtonElement>('[data-testid="button-sell"]')?.click(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const price = ticker?.price || 0;
  const change = ticker?.change24h || 0;
  const vol = ticker?.volume24h || 0;
  const high = ticker?.high24h || 0;
  const low = ticker?.low24h || 0;
  const fr = funding?.fundingRate || ticker?.fundingRate || 0;
  const oi = ticker?.openInterest || 0;
  const positions = acct?.positions || [];

  if (!address) {
    return (
      <div className="h-screen bg-[#0a0b0d] flex items-center justify-center" data-testid="connect-screen">
        <div className="text-center space-y-4 max-w-sm">
          <div className="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-br from-emerald-500/20 to-cyan-500/20 flex items-center justify-center border border-emerald-500/10">
            <BarChart3 className="w-8 h-8 text-emerald-400" />
          </div>
          <h1 className="text-xl font-bold text-white">BUILD4 Trading Terminal</h1>
          <p className="text-sm text-zinc-500">Connect your wallet to trade perpetual futures on Aster DEX with up to 125x leverage.</p>
          <Button onClick={connect} disabled={connecting} data-testid="button-connect-wallet" className="bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-400 hover:to-cyan-400 text-white border-0 shadow-lg shadow-emerald-500/20 px-8">
            {connecting ? <RefreshCw className="w-4 h-4 animate-spin mr-2" /> : <Wallet className="w-4 h-4 mr-2" />}Connect Wallet
          </Button>
          {walletError && <p className="text-xs text-red-400">{walletError}</p>}
        </div>
        {showPicker && <WalletPicker onMM={connectMM} onWC={connectWC} onClose={() => setShowPicker(false)} />}
      </div>
    );
  }

  if (acct && !acct.connected) {
    return (
      <div className="h-screen bg-[#0a0b0d] flex items-center justify-center">
        <div className="max-w-md w-full bg-[#0d0e10] border border-zinc-800 rounded-xl p-6">
          <ActivationFlow wallet={address} onDone={refreshAcct} />
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-[#0a0b0d] text-white flex flex-col overflow-hidden" data-testid="trading-terminal">
      {/* Top Bar */}
      <div className="h-10 border-b border-zinc-800/50 flex items-center px-3 gap-4 shrink-0 bg-[#0d0e10]">
        <div className="relative">
          <button onClick={() => setShowPairs(!showPairs)} data-testid="button-pair-selector" className="flex items-center gap-1.5 hover:bg-zinc-800/50 px-2 py-1 rounded transition-colors">
            <span className="text-sm font-bold">{selectedPair.replace("USDT", "")}</span>
            <span className="text-xs text-zinc-500">/USDT</span>
            <ChevronDown className="w-3 h-3 text-zinc-500" />
          </button>
          {showPairs && <PairSelector selected={selectedPair} onSelect={setSelectedPair} onClose={() => setShowPairs(false)} />}
        </div>

        <div className="flex items-center gap-4 text-xs">
          <span className={`font-mono font-bold text-base ${change >= 0 ? "text-emerald-400" : "text-red-400"}`} data-testid="text-price">{fmtPrice(price)}</span>
          <span className={`font-mono ${change >= 0 ? "text-emerald-400" : "text-red-400"}`}>{change >= 0 ? "+" : ""}{change.toFixed(2)}%</span>
          <div className="hidden md:flex items-center gap-4 text-zinc-500">
            <span>H <span className="text-zinc-300">{fmtPrice(high)}</span></span>
            <span>L <span className="text-zinc-300">{fmtPrice(low)}</span></span>
            <span>Vol <span className="text-zinc-300">{fmtK(vol)}</span></span>
            {fr ? <span>FR <span className={`${fr >= 0 ? "text-emerald-400" : "text-red-400"}`}>{(fr * 100).toFixed(4)}%</span></span> : null}
            {oi ? <span>OI <span className="text-zinc-300">{fmtK(oi)}</span></span> : null}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-3">
          {acct && (
            <div className="hidden md:flex items-center gap-3 text-xs">
              <span className="text-zinc-500">Balance: <span className="text-white font-mono">${fmt(acct.walletBalance)}</span></span>
              <span className="text-zinc-500">Avail: <span className="text-emerald-400 font-mono">${fmt(acct.availableMargin)}</span></span>
              {acct.unrealizedPnl !== 0 && <span className={`font-mono ${acct.unrealizedPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>{acct.unrealizedPnl >= 0 ? "+" : ""}{fmt(acct.unrealizedPnl)}</span>}
            </div>
          )}
          <button onClick={disconnect} data-testid="button-disconnect" className="text-zinc-500 hover:text-white transition-colors p-1" title="Disconnect">
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Chart Area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Interval Tabs */}
          <div className="h-8 border-b border-zinc-800/30 flex items-center px-2 gap-1 shrink-0 bg-[#0d0e10]">
            {INTERVALS.map(iv => (
              <button key={iv} onClick={() => setInterval(iv)} className={`px-2 py-0.5 text-[10px] rounded transition-colors ${interval === iv ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-300"}`}>
                {iv}
              </button>
            ))}
          </div>
          {/* Chart */}
          <div className="flex-1 min-h-0">
            <TradingChart symbol={selectedPair} interval={interval} />
          </div>
          {/* Bottom Panels */}
          <div className="h-[180px] border-t border-zinc-800/50 bg-[#0d0e10] shrink-0 overflow-hidden">
            <div className="h-7 border-b border-zinc-800/30 flex items-center px-2 gap-3">
              {(["positions", "orders", "trades"] as const).map(tab => (
                <button key={tab} onClick={() => setBottomTab(tab)} className={`text-[10px] pb-0.5 transition-colors ${bottomTab === tab ? "text-white border-b border-emerald-400" : "text-zinc-500 hover:text-zinc-300"}`}>
                  {tab === "positions" ? `Positions (${positions.length})` : tab.charAt(0).toUpperCase() + tab.slice(1)}
                </button>
              ))}
              <button onClick={refreshAcct} className="ml-auto text-zinc-600 hover:text-zinc-400"><RefreshCw className="w-3 h-3" /></button>
            </div>
            <div className="overflow-y-auto" style={{ height: "calc(100% - 28px)" }}>
              {bottomTab === "positions" && <PositionsPanel positions={positions} wallet={address} onClose={refreshAcct} />}
              {bottomTab === "orders" && <div className="p-4 text-center text-zinc-600 text-xs">Open orders will appear here</div>}
              {bottomTab === "trades" && <div className="p-4 text-center text-zinc-600 text-xs">Recent trades will appear here</div>}
            </div>
          </div>
        </div>

        {/* Right Sidebar */}
        <div className="w-[280px] border-l border-zinc-800/50 flex flex-col shrink-0 bg-[#0d0e10] hidden md:flex">
          {/* Order Book */}
          <div className="flex-1 min-h-0 overflow-hidden border-b border-zinc-800/50">
            <div className="h-7 border-b border-zinc-800/30 flex items-center px-2">
              <span className="text-[10px] text-zinc-400 font-medium">Order Book</span>
            </div>
            <div className="overflow-y-auto" style={{ height: "calc(100% - 28px)" }}>
              <OrderBook symbol={selectedPair} />
            </div>
          </div>
          {/* Trade Ticket */}
          <div className="overflow-y-auto" style={{ maxHeight: "50%" }}>
            <div className="h-7 border-b border-zinc-800/30 flex items-center px-2">
              <span className="text-[10px] text-zinc-400 font-medium">Trade</span>
            </div>
            <TradeTicket symbol={selectedPair} wallet={address} price={price} onSuccess={refreshAcct} />
          </div>
        </div>
      </div>

      {/* Mobile Trade Button */}
      <div className="md:hidden fixed bottom-4 left-4 right-4 flex gap-2">
        <Button onClick={() => document.querySelector<HTMLButtonElement>('[data-testid="button-buy"]')?.click()} className="flex-1 bg-emerald-500 text-white font-bold shadow-lg">Long</Button>
        <Button onClick={() => document.querySelector<HTMLButtonElement>('[data-testid="button-sell"]')?.click()} className="flex-1 bg-red-500 text-white font-bold shadow-lg">Short</Button>
      </div>

      {showPicker && <WalletPicker onMM={connectMM} onWC={connectWC} onClose={() => setShowPicker(false)} />}
    </div>
  );
}

export default function FuturesPage() {
  return (
    <ErrorBoundary>
      <FuturesTerminal />
    </ErrorBoundary>
  );
}
