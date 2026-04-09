import { useState, useEffect, useCallback, useRef, useMemo, Component } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TrendingUp, TrendingDown, RefreshCw, Activity, BarChart3, X, ChevronDown,
  LogOut, AlertTriangle, Wallet, Zap, Search, Bot, Settings, Play, Square,
  ChevronUp, Minus, Plus, Star, StarOff, Eye, EyeOff, Maximize2, LayoutGrid,
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
      if (accts?.length) { const a = accts[0].toLowerCase(); setAddress(a); localStorage.setItem("futures_wallet", a); localStorage.setItem("futures_wallet_type", "metamask"); }
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
    window.ethereum.on("accountsChanged", h); return () => { window.ethereum?.removeListener("accountsChanged", h); };
  }, [disconnect]);
  useEffect(() => {
    const t = (() => { try { return localStorage.getItem("futures_wallet_type"); } catch { return null; } })();
    if (t === "metamask" && window.ethereum) window.ethereum.request({ method: "eth_accounts" }).then((a: string[]) => { if (a.length) { setAddress(a[0].toLowerCase()); } }).catch(() => {});
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

function usePub<T>(url: string, interval?: number) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try { const r = await fetch(url); if (r.ok) setData(await r.json()); } catch {} finally { setLoading(false); }
  }, [url]);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!interval) return;
    const iv = window.setInterval(refresh, interval);
    return () => clearInterval(iv);
  }, [refresh, interval]);
  return { data, loading, refresh };
}

async function post(url: string, wallet: string, body: any) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-wallet-address": wallet }, body: JSON.stringify(body) });
  return r.json();
}

interface Pos { symbol: string; side: string; size: number; entryPrice: number; markPrice: number; leverage: string; unrealizedPnl: number; notional: number; }
interface AcctData { connected: boolean; walletBalance: number; availableMargin: number; bscBalance: number; unrealizedPnl: number; realizedPnl: number; positions: Pos[]; }
interface MktItem { symbol: string; price: number; change24h: number; volume24h: number; high24h: number; low24h: number; }
interface TickerData { symbol: string; price: number; change24h: number; volume24h: number; high24h: number; low24h: number; markPrice?: number; indexPrice?: number; fundingRate?: number; openInterest?: number; }
interface OrderData { orderId: string; symbol: string; side: string; type: string; price: number; origQty: number; executedQty: number; status: string; time: number; }
interface TradeData { symbol: string; side: string; qty: number; price: number; realizedPnl: number; time: number; }
interface AgentData {
  running: boolean;
  config: { name: string; riskPercent: number; maxLeverage: number; maxOpenPositions: number; interval: number; takeProfitPct: number; stopLossPct: number; trailingStopPct: number; fundingRateFilter: boolean; orderbookImbalanceThreshold: number; useConfidenceFilter: boolean; minConfidence: number; };
  stats: { tradeCount: number; scanCount: number; winCount: number; lossCount: number; totalPnl: number; lastAction: string | null; lastReason: string | null; openPositions: string[]; };
}

const PAIRS = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","DOGEUSDT","XRPUSDT","AVAXUSDT","LINKUSDT","ADAUSDT","DOTUSDT","LTCUSDT","MATICUSDT","UNIUSDT","APTUSDT","ARBUSDT","OPUSDT","SUIUSDT","NEARUSDT"];
const TF = ["1m","3m","5m","15m","30m","1h","2h","4h","1d","1w"];

function computeEMA(data: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [];
  let prev = data[0];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { prev = data[i]; result.push(NaN); continue; }
    if (i === period - 1) {
      let sum = 0; for (let j = 0; j < period; j++) sum += data[j]; prev = sum / period; result.push(prev); continue;
    }
    prev = data[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

function computeSMA(data: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(NaN); continue; }
    let sum = 0; for (let j = i - period + 1; j <= i; j++) sum += data[j];
    result.push(sum / period);
  }
  return result;
}

function computeBB(data: number[], period: number, mult: number): { upper: number[]; middle: number[]; lower: number[] } {
  const middle = computeSMA(data, period);
  const upper: number[] = []; const lower: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (isNaN(middle[i])) { upper.push(NaN); lower.push(NaN); continue; }
    let sum = 0; for (let j = i - period + 1; j <= i; j++) sum += (data[j] - middle[i]) ** 2;
    const std = Math.sqrt(sum / period);
    upper.push(middle[i] + mult * std);
    lower.push(middle[i] - mult * std);
  }
  return { upper, middle, lower };
}

function computeRSI(data: number[], period: number): number[] {
  const result: number[] = [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < data.length; i++) {
    if (i === 0) { result.push(NaN); continue; }
    const change = data[i] - data[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    if (i < period) { avgGain += gain; avgLoss += loss; result.push(NaN); continue; }
    if (i === period) { avgGain = (avgGain + gain) / period; avgLoss = (avgLoss + loss) / period; }
    else { avgGain = (avgGain * (period - 1) + gain) / period; avgLoss = (avgLoss * (period - 1) + loss) / period; }
    if (avgLoss === 0) { result.push(100); continue; }
    const rs = avgGain / avgLoss;
    result.push(100 - (100 / (1 + rs)));
  }
  return result;
}

function computeMACD(data: number[], fast = 12, slow = 26, signal = 9): { macd: number[]; signal: number[]; histogram: number[] } {
  const emaFast = computeEMA(data, fast);
  const emaSlow = computeEMA(data, slow);
  const macdLine: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (isNaN(emaFast[i]) || isNaN(emaSlow[i])) { macdLine.push(NaN); continue; }
    macdLine.push(emaFast[i] - emaSlow[i]);
  }
  const validMacd = macdLine.filter(v => !isNaN(v));
  const signalLine = computeEMA(validMacd, signal);
  const fullSignal: number[] = [];
  let si = 0;
  for (let i = 0; i < macdLine.length; i++) {
    if (isNaN(macdLine[i])) { fullSignal.push(NaN); continue; }
    fullSignal.push(si < signalLine.length ? signalLine[si] : NaN);
    si++;
  }
  const histogram: number[] = [];
  for (let i = 0; i < macdLine.length; i++) {
    if (isNaN(macdLine[i]) || isNaN(fullSignal[i])) { histogram.push(NaN); continue; }
    histogram.push(macdLine[i] - fullSignal[i]);
  }
  return { macd: macdLine, signal: fullSignal, histogram };
}

type IndicatorType = "ema9" | "ema21" | "ema50" | "sma20" | "sma50" | "bb20" | "rsi14" | "macd";
const INDICATOR_LABELS: Record<IndicatorType, string> = { ema9: "EMA 9", ema21: "EMA 21", ema50: "EMA 50", sma20: "SMA 20", sma50: "SMA 50", bb20: "BB 20", rsi14: "RSI 14", macd: "MACD" };
const INDICATOR_COLORS: Record<IndicatorType, string> = { ema9: "#f59e0b", ema21: "#3b82f6", ema50: "#a855f7", sma20: "#06b6d4", sma50: "#ec4899", bb20: "#6366f1", rsi14: "#22d3ee", macd: "#f472b6" };

function SubChart({ type, rawData }: { type: "rsi14" | "macd"; rawData: any[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);

  useEffect(() => {
    if (!ref.current || !rawData.length) return;
    const chart = createChart(ref.current, {
      layout: { background: { type: ColorType.Solid, color: "#08090b" }, textColor: "#3f3f46", fontFamily: "'Inter', sans-serif", fontSize: 9 },
      grid: { vertLines: { color: "#18181b" }, horzLines: { color: "#18181b" } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { visible: false }, horzLine: { color: "#3f3f46", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#27272a" } },
      rightPriceScale: { borderColor: "#18181b", scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { visible: false },
      handleScroll: true, handleScale: true,
    });
    chartRef.current = chart;
    const closes = rawData.map((k: any) => parseFloat(k.close || k[4]));
    const times = rawData.map((k: any) => (k.openTime || k[0]) / 1000);

    if (type === "rsi14") {
      const rsi = computeRSI(closes, 14);
      const s = chart.addLineSeries({ color: "#22d3ee", lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true });
      s.setData(rsi.map((v, i) => isNaN(v) ? null : { time: times[i], value: v }).filter(Boolean));
      const ob = chart.addLineSeries({ color: "#ef444440", lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      ob.setData(times.map(t => ({ time: t, value: 70 })));
      const os = chart.addLineSeries({ color: "#22c55e40", lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      os.setData(times.map(t => ({ time: t, value: 30 })));
    } else {
      const macd = computeMACD(closes);
      const ml = chart.addLineSeries({ color: "#f472b6", lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false });
      ml.setData(macd.macd.map((v, i) => isNaN(v) ? null : { time: times[i], value: v }).filter(Boolean));
      const sl = chart.addLineSeries({ color: "#fb923c", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      sl.setData(macd.signal.map((v, i) => isNaN(v) ? null : { time: times[i], value: v }).filter(Boolean));
      const hist = chart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
      hist.setData(macd.histogram.map((v, i) => isNaN(v) ? null : { time: times[i], value: v, color: v >= 0 ? "rgba(34,197,94,0.4)" : "rgba(239,68,68,0.4)" }).filter(Boolean));
    }
    chart.timeScale().fitContent();
    const ro = new ResizeObserver(entries => { const { width, height } = entries[0].contentRect; chart.applyOptions({ width, height }); });
    ro.observe(ref.current);
    return () => { ro.disconnect(); chart.remove(); };
  }, [rawData, type]);

  return (
    <div className="border-t border-zinc-800/40">
      <div className="flex items-center gap-2 px-2 py-0.5 bg-[#08090b]">
        <span className="text-[9px] font-medium" style={{ color: type === "rsi14" ? "#22d3ee" : "#f472b6" }}>{type === "rsi14" ? "RSI 14" : "MACD 12,26,9"}</span>
        {type === "rsi14" && <span className="text-[8px] text-zinc-600">70/30</span>}
      </div>
      <div ref={ref} className="w-full h-[80px]" />
    </div>
  );
}

function TradingChart({ symbol, interval, indicators, positions }: { symbol: string; interval: string; indicators: IndicatorType[]; positions: Pos[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const seriesRef = useRef<any>(null);
  const volRef = useRef<any>(null);
  const overlayRef = useRef<any[]>([]);
  const rawRef = useRef<any[]>([]);
  const [rawData, setRawData] = useState<any[]>([]);

  const hasRSI = indicators.includes("rsi14");
  const hasMACD = indicators.includes("macd");
  const overlayIndicators = useMemo(() => indicators.filter(i => i !== "rsi14" && i !== "macd"), [indicators]);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: "#0a0b0d" }, textColor: "#52525b", fontFamily: "'Inter', -apple-system, sans-serif" },
      grid: { vertLines: { color: "#18181b" }, horzLines: { color: "#18181b" } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: "#3f3f46", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#27272a" }, horzLine: { color: "#3f3f46", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#27272a" } },
      rightPriceScale: { borderColor: "#27272a", scaleMargins: { top: 0.05, bottom: 0.2 }, entireTextOnly: true },
      timeScale: { borderColor: "#27272a", timeVisible: true, secondsVisible: false, barSpacing: 8 },
      handleScroll: true, handleScale: true,
    });
    const cs = chart.addCandlestickSeries({
      upColor: "#22c55e", downColor: "#ef4444", borderUpColor: "#22c55e", borderDownColor: "#ef4444",
      wickUpColor: "#16a34a", wickDownColor: "#dc2626",
    });
    const vs = chart.addHistogramSeries({ color: "#374151", priceFormat: { type: "volume" }, priceScaleId: "vol" });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    chartRef.current = chart; seriesRef.current = cs; volRef.current = vs;
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
        rawRef.current = raw;
        setRawData(raw);
        const candles = raw.map((k: any) => ({ time: (k.openTime || k[0]) / 1000, open: parseFloat(k.open || k[1]), high: parseFloat(k.high || k[2]), low: parseFloat(k.low || k[3]), close: parseFloat(k.close || k[4]) })).filter((c: any) => c.time > 0 && !isNaN(c.open));
        const vols = raw.map((k: any) => ({ time: (k.openTime || k[0]) / 1000, value: parseFloat(k.volume || k[5] || "0"), color: parseFloat(k.close || k[4]) >= parseFloat(k.open || k[1]) ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)" }));
        if (!cancelled && seriesRef.current) { seriesRef.current.setData(candles); volRef.current?.setData(vols); chartRef.current?.timeScale().fitContent(); }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [symbol, interval]);

  useEffect(() => {
    if (!chartRef.current || !seriesRef.current) return;
    overlayRef.current.forEach(s => { try { chartRef.current.removeSeries(s); } catch {} });
    overlayRef.current = [];
    const raw = rawRef.current;
    if (!raw.length) return;
    const closes = raw.map((k: any) => parseFloat(k.close || k[4]));
    const times = raw.map((k: any) => (k.openTime || k[0]) / 1000);

    for (const ind of overlayIndicators) {
      if (ind === "bb20") {
        const bb = computeBB(closes, 20, 2);
        const colors = ["#6366f1", "#6366f180", "#6366f1"];
        [bb.upper, bb.middle, bb.lower].forEach((arr, ci) => {
          const s = chartRef.current.addLineSeries({ color: colors[ci], lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
          s.setData(arr.map((v, i) => isNaN(v) ? null : { time: times[i], value: v }).filter(Boolean));
          overlayRef.current.push(s);
        });
      } else {
        const period = parseInt(ind.replace(/\D/g, ""));
        const vals = ind.startsWith("ema") ? computeEMA(closes, period) : computeSMA(closes, period);
        const s = chartRef.current.addLineSeries({ color: INDICATOR_COLORS[ind], lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        s.setData(vals.map((v, i) => isNaN(v) ? null : { time: times[i], value: v }).filter(Boolean));
        overlayRef.current.push(s);
      }
    }
  }, [overlayIndicators, symbol, interval]);

  useEffect(() => {
    if (!seriesRef.current || !positions.length) return;
    const markers = positions.filter(p => p.symbol === symbol).map(p => ({
      price: p.entryPrice,
      color: p.side === "BUY" ? "#22c55e" : "#ef4444",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: `${p.side === "BUY" ? "L" : "S"} ${fmtPrice(p.entryPrice)}`,
    }));
    const lines: any[] = [];
    markers.forEach(m => {
      const line = seriesRef.current.createPriceLine(m);
      lines.push(line);
    });
    return () => { lines.forEach(l => { try { seriesRef.current.removePriceLine(l); } catch {} }); };
  }, [positions, symbol]);

  return (
    <div className="w-full h-full flex flex-col">
      <div ref={containerRef} className="flex-1 min-h-0" data-testid="chart-container" />
      {hasRSI && rawData.length > 0 && <SubChart type="rsi14" rawData={rawData} />}
      {hasMACD && rawData.length > 0 && <SubChart type="macd" rawData={rawData} />}
    </div>
  );
}

function OrderBook({ symbol }: { symbol: string }) {
  const [book, setBook] = useState<{ bids: [string, string][]; asks: [string, string][] } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => { try { const r = await fetch(`/api/public/depth?symbol=${symbol}&limit=20`); if (r.ok && !cancelled) setBook(await r.json()); } catch {} };
    load(); const iv = setInterval(load, 2000); return () => { cancelled = true; clearInterval(iv); };
  }, [symbol]);

  if (!book) return <div className="flex-1 flex items-center justify-center"><Skeleton className="w-full h-32 bg-zinc-900" /></div>;

  const asks = [...(book.asks || [])].slice(0, 12).reverse();
  const bids = (book.bids || []).slice(0, 12);
  const maxQty = Math.max(...[...asks, ...bids].map(([_, q]) => parseFloat(q) || 0), 0.001);
  let cumAsk = 0; let cumBid = 0;
  const asksCum = asks.map(([p, q]) => { cumAsk += parseFloat(q); return { p, q, cum: cumAsk }; });
  const bidsCum = bids.map(([p, q]) => { cumBid += parseFloat(q); return { p, q, cum: cumBid }; });
  const maxCum = Math.max(cumAsk, cumBid, 0.001);

  return (
    <div className="text-[10px] font-mono select-none" data-testid="orderbook">
      <div className="grid grid-cols-3 px-2 py-1 text-zinc-600 border-b border-zinc-800/40 text-[9px] uppercase tracking-wider">
        <span>Price</span><span className="text-right">Size</span><span className="text-right">Total</span>
      </div>
      {asksCum.map((a, i) => (
        <div key={"a" + i} className="grid grid-cols-3 px-2 py-[1.5px] relative group cursor-pointer">
          <div className="absolute right-0 top-0 bottom-0 bg-red-500/[0.06] transition-all" style={{ width: `${(a.cum / maxCum) * 100}%` }} />
          <span className="text-red-400 relative z-10">{fmtPrice(parseFloat(a.p))}</span>
          <span className="text-right text-zinc-500 relative z-10">{parseFloat(a.q).toFixed(3)}</span>
          <span className="text-right text-zinc-600 relative z-10">{a.cum.toFixed(3)}</span>
        </div>
      ))}
      <div className="px-2 py-1.5 border-y border-zinc-800/40 flex items-center justify-center gap-2">
        <span className="text-sm font-bold text-white" data-testid="text-spread-price">{bids[0] ? fmtPrice(parseFloat(bids[0][0])) : "—"}</span>
        {bids[0] && asks[asks.length - 1] && (
          <span className="text-[9px] text-zinc-600">Spread {fmt(parseFloat(asks[asks.length - 1][0]) - parseFloat(bids[0][0]), 2)}</span>
        )}
      </div>
      {bidsCum.map((b, i) => (
        <div key={"b" + i} className="grid grid-cols-3 px-2 py-[1.5px] relative group cursor-pointer">
          <div className="absolute right-0 top-0 bottom-0 bg-emerald-500/[0.06] transition-all" style={{ width: `${(b.cum / maxCum) * 100}%` }} />
          <span className="text-emerald-400 relative z-10">{fmtPrice(parseFloat(b.p))}</span>
          <span className="text-right text-zinc-500 relative z-10">{parseFloat(b.q).toFixed(3)}</span>
          <span className="text-right text-zinc-600 relative z-10">{b.cum.toFixed(3)}</span>
        </div>
      ))}
    </div>
  );
}

function TradeTicket({ symbol, wallet, price, availableMargin, onSuccess }: { symbol: string; wallet: string; price: number; availableMargin: number; onSuccess: () => void }) {
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT" | "STOP">("MARKET");
  const [amount, setAmount] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [leverage, setLeverage] = useState(10);
  const [riskMode, setRiskMode] = useState(false);
  const [riskPct, setRiskPct] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const margin = useMemo(() => {
    if (riskMode && availableMargin > 0) return availableMargin * (riskPct / 100);
    return parseFloat(amount) || 0;
  }, [amount, riskMode, riskPct, availableMargin]);

  const notional = margin * leverage;
  const qty = price > 0 ? notional / price : 0;
  const fee = notional * 0.0005;
  const liqPrice = useMemo(() => {
    if (!price || !margin) return 0;
    const dir = side === "BUY" ? 1 : -1;
    return price * (1 - dir * 0.95 / leverage);
  }, [price, margin, leverage, side]);
  const breakeven = price > 0 ? price * (1 + (side === "BUY" ? 1 : -1) * fee / notional) : 0;

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
        setTimeout(() => setResult(null), 4000);
      } else {
        setResult({ ok: false, msg: data.error || "Order failed" });
      }
    } catch (e: any) {
      setResult({ ok: false, msg: e.message || "Network error" });
    } finally { setSubmitting(false); }
  };

  const isBuy = side === "BUY";
  const pctButtons = [25, 50, 75, 100];

  return (
    <div className="p-3 space-y-2.5" data-testid="trade-ticket">
      <div className="flex gap-1">
        <button onClick={() => setSide("BUY")} data-testid="button-buy"
          className={cn("flex-1 py-2.5 text-xs font-bold rounded-md transition-all duration-200", isBuy ? "bg-emerald-500 text-white shadow-[0_0_20px_rgba(34,197,94,0.15)]" : "bg-zinc-800/60 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300")}>LONG</button>
        <button onClick={() => setSide("SELL")} data-testid="button-sell"
          className={cn("flex-1 py-2.5 text-xs font-bold rounded-md transition-all duration-200", !isBuy ? "bg-red-500 text-white shadow-[0_0_20px_rgba(239,68,68,0.15)]" : "bg-zinc-800/60 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300")}>SHORT</button>
      </div>

      <div className="flex gap-0.5 bg-zinc-900/50 rounded-md p-0.5">
        {(["MARKET", "LIMIT", "STOP"] as const).map(t => (
          <button key={t} onClick={() => setOrderType(t)}
            className={cn("flex-1 py-1 text-[10px] rounded transition-all", orderType === t ? "bg-zinc-700/80 text-white shadow-sm" : "text-zinc-500 hover:text-zinc-300")}>{t === "STOP" ? "Stop" : t.charAt(0) + t.slice(1).toLowerCase()}</button>
        ))}
      </div>

      {orderType !== "MARKET" && (
        <div>
          <label className="text-[9px] text-zinc-500 uppercase tracking-wider mb-1 block">{orderType === "STOP" ? "Stop Price" : "Limit Price"}</label>
          <Input value={orderType === "STOP" ? stopPrice : limitPrice} onChange={e => orderType === "STOP" ? setStopPrice(e.target.value) : setLimitPrice(e.target.value)}
            placeholder={fmtPrice(price)} className="h-7 bg-zinc-900/80 border-zinc-800/60 text-xs font-mono focus:border-zinc-600 transition-colors" data-testid="input-limit-price" />
        </div>
      )}

      <div>
        <div className="flex justify-between items-center mb-1">
          <label className="text-[9px] text-zinc-500 uppercase tracking-wider">Margin (USDT)</label>
          <button onClick={() => setRiskMode(!riskMode)} className={cn("text-[9px] px-1.5 py-0.5 rounded transition-all", riskMode ? "bg-amber-500/20 text-amber-400" : "text-zinc-600 hover:text-zinc-400")} data-testid="button-risk-mode">
            Risk %
          </button>
        </div>
        {riskMode ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Slider value={[riskPct]} onValueChange={v => setRiskPct(v[0])} min={0.5} max={10} step={0.5} className="flex-1" data-testid="slider-risk" />
              <span className="text-xs font-mono text-amber-400 w-10 text-right">{riskPct}%</span>
            </div>
            <div className="text-[9px] text-zinc-500">= ${fmt(margin)} of ${fmt(availableMargin)} available</div>
          </div>
        ) : (
          <>
            <Input value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" className="h-7 bg-zinc-900/80 border-zinc-800/60 text-xs font-mono focus:border-zinc-600 transition-colors" data-testid="input-margin" />
            <div className="flex gap-1 mt-1">
              {pctButtons.map(pct => (
                <button key={pct} onClick={() => setAmount(fmt(availableMargin * pct / 100, 2))} data-testid={`button-pct-${pct}`}
                  className="flex-1 py-0.5 text-[9px] bg-zinc-800/40 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/80 transition-colors">{pct}%</button>
              ))}
            </div>
          </>
        )}
      </div>

      <div>
        <div className="flex justify-between text-[9px] text-zinc-500 mb-1 uppercase tracking-wider">
          <span>Leverage</span><span className="text-white font-bold normal-case text-[11px]">{leverage}x</span>
        </div>
        <Slider value={[leverage]} onValueChange={v => setLeverage(v[0])} min={1} max={125} step={1} className="py-0.5" data-testid="slider-leverage" />
        <div className="flex gap-0.5 mt-1">
          {[1, 2, 5, 10, 20, 50, 75, 125].map(l => (
            <button key={l} onClick={() => setLeverage(l)}
              className={cn("flex-1 py-0.5 text-[8px] rounded transition-all", leverage === l ? "bg-zinc-700 text-white" : "bg-zinc-800/30 text-zinc-600 hover:text-zinc-400")}>{l}x</button>
          ))}
        </div>
      </div>

      {margin > 0 && (
        <div className="bg-zinc-900/40 rounded-md p-2 space-y-1 text-[9px] border border-zinc-800/30">
          <div className="flex justify-between"><span className="text-zinc-600">Size</span><span className="text-zinc-300 font-mono">{qty.toFixed(4)} {symbol.replace("USDT","")}</span></div>
          <div className="flex justify-between"><span className="text-zinc-600">Notional</span><span className="text-zinc-300 font-mono">${fmtK(notional)}</span></div>
          <div className="flex justify-between"><span className="text-zinc-600">Liq. Price</span><span className={cn("font-mono", isBuy ? "text-red-400" : "text-emerald-400")}>${fmtPrice(liqPrice)}</span></div>
          <div className="flex justify-between"><span className="text-zinc-600">Breakeven</span><span className="text-zinc-400 font-mono">${fmtPrice(breakeven)}</span></div>
          <div className="flex justify-between"><span className="text-zinc-600">Fee (est.)</span><span className="text-zinc-500 font-mono">${fmt(fee, 4)}</span></div>
        </div>
      )}

      <Button onClick={submit} disabled={submitting || !margin} data-testid="button-submit-order"
        className={cn("w-full h-10 font-bold text-sm rounded-md transition-all duration-200",
          isBuy ? "bg-emerald-500 hover:bg-emerald-400 shadow-[0_0_30px_rgba(34,197,94,0.12)]" : "bg-red-500 hover:bg-red-400 shadow-[0_0_30px_rgba(239,68,68,0.12)]",
          "text-white border-0 disabled:opacity-40")}>
        {submitting ? <RefreshCw className="w-4 h-4 animate-spin" /> : `${isBuy ? "Long" : "Short"} ${symbol.replace("USDT", "")}`}
      </Button>

      {result && (
        <div className={cn("text-[10px] p-2 rounded-md animate-in fade-in duration-300",
          result.ok ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" : "bg-red-500/10 text-red-400 border border-red-500/20")} data-testid="text-order-result">
          {result.msg}
        </div>
      )}
    </div>
  );
}

function PositionsPanel({ positions, wallet, onRefresh }: { positions: Pos[]; wallet: string; onRefresh: () => void }) {
  const [closing, setClosing] = useState<string | null>(null);
  const handleClose = async (sym: string) => { setClosing(sym); try { await post("/api/miniapp/close", wallet, { symbol: sym }); onRefresh(); } catch {} finally { setClosing(null); } };
  const totalPnl = positions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);

  if (!positions.length) return <div className="p-6 text-center text-zinc-600 text-xs">No open positions</div>;

  return (
    <div data-testid="positions-panel">
      <div className="grid grid-cols-[1fr_80px_80px_80px_90px_60px] gap-2 px-3 py-1.5 text-[9px] text-zinc-600 uppercase tracking-wider border-b border-zinc-800/30">
        <span>Symbol</span><span className="text-right">Size</span><span className="text-right">Entry</span><span className="text-right">Mark</span><span className="text-right">PnL</span><span className="text-right">Action</span>
      </div>
      {positions.map((p, i) => {
        const pnlPct = p.entryPrice > 0 ? ((p.markPrice - p.entryPrice) / p.entryPrice * 100 * (p.side === "BUY" ? 1 : -1)) : 0;
        return (
          <div key={i} className="grid grid-cols-[1fr_80px_80px_80px_90px_60px] gap-2 px-3 py-2 items-center border-b border-zinc-800/20 hover:bg-zinc-800/10 transition-colors" data-testid={`position-${p.symbol}`}>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-bold text-white">{p.symbol.replace("USDT", "")}</span>
              <Badge variant="outline" className={cn("text-[8px] px-1 py-0 border-0 font-medium", p.side === "BUY" ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400")}>
                {p.side === "BUY" ? "LONG" : "SHORT"} {p.leverage}x
              </Badge>
            </div>
            <span className="text-right text-[10px] text-zinc-300 font-mono">{Math.abs(p.size).toFixed(4)}</span>
            <span className="text-right text-[10px] text-zinc-400 font-mono">{fmtPrice(p.entryPrice)}</span>
            <span className="text-right text-[10px] text-zinc-300 font-mono">{fmtPrice(p.markPrice)}</span>
            <div className="text-right">
              <span className={cn("text-[10px] font-mono font-bold", p.unrealizedPnl >= 0 ? "text-emerald-400" : "text-red-400")}>
                {p.unrealizedPnl >= 0 ? "+" : ""}{fmt(p.unrealizedPnl)}
              </span>
              <span className={cn("text-[8px] ml-1 font-mono", pnlPct >= 0 ? "text-emerald-500/60" : "text-red-500/60")}>
                ({pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%)
              </span>
            </div>
            <div className="text-right">
              <button onClick={() => handleClose(p.symbol)} disabled={closing === p.symbol} data-testid={`button-close-${p.symbol}`}
                className="text-[9px] px-2 py-0.5 bg-zinc-800/80 rounded text-zinc-400 hover:text-red-400 hover:bg-red-500/10 transition-all">
                {closing === p.symbol ? "..." : "Close"}
              </button>
            </div>
          </div>
        );
      })}
      <div className="px-3 py-2 flex justify-between items-center">
        <span className="text-[10px] text-zinc-500">{positions.length} position{positions.length !== 1 ? "s" : ""}</span>
        <span className={cn("text-[11px] font-bold font-mono", totalPnl >= 0 ? "text-emerald-400" : "text-red-400")}>
          Total: {totalPnl >= 0 ? "+" : ""}{fmt(totalPnl)} USDT
        </span>
      </div>
    </div>
  );
}

function OrdersPanel({ wallet }: { wallet: string }) {
  const { data, loading, refresh } = useApi<{ openOrders: OrderData[] }>("/api/miniapp/orders", wallet);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const cancelOrder = async (orderId: string, symbol: string) => {
    setCancelling(orderId);
    try { await post("/api/miniapp/cancel-order", wallet, { orderId, symbol }); refresh(); } catch {} finally { setCancelling(null); }
  };

  if (loading) return <div className="p-4"><Skeleton className="w-full h-8 bg-zinc-900" /></div>;
  const orders = data?.openOrders || [];
  if (!orders.length) return <div className="p-6 text-center text-zinc-600 text-xs">No open orders</div>;

  return (
    <div>
      <div className="grid grid-cols-[1fr_60px_60px_80px_80px_60px] gap-2 px-3 py-1.5 text-[9px] text-zinc-600 uppercase tracking-wider border-b border-zinc-800/30">
        <span>Symbol</span><span>Side</span><span>Type</span><span className="text-right">Price</span><span className="text-right">Qty</span><span className="text-right">Action</span>
      </div>
      {orders.map((o, i) => (
        <div key={i} className="grid grid-cols-[1fr_60px_60px_80px_80px_60px] gap-2 px-3 py-2 items-center border-b border-zinc-800/20 hover:bg-zinc-800/10 text-[10px]">
          <span className="font-bold text-white">{o.symbol.replace("USDT", "")}</span>
          <Badge variant="outline" className={cn("text-[8px] px-1 py-0 border-0 w-fit", o.side === "BUY" ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400")}>{o.side}</Badge>
          <span className="text-zinc-500">{o.type}</span>
          <span className="text-right font-mono text-zinc-300">{fmtPrice(o.price)}</span>
          <span className="text-right font-mono text-zinc-400">{o.origQty}</span>
          <div className="text-right">
            <button onClick={() => cancelOrder(o.orderId, o.symbol)} disabled={cancelling === o.orderId}
              className="text-[9px] px-2 py-0.5 bg-zinc-800/80 rounded text-zinc-400 hover:text-red-400 hover:bg-red-500/10 transition-all">
              {cancelling === o.orderId ? "..." : "Cancel"}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function TradesPanel({ wallet, symbol }: { wallet: string; symbol: string }) {
  const { data, loading } = useApi<{ trades: TradeData[]; income: any[] }>(`/api/miniapp/trades?symbol=${symbol}`, wallet);
  if (loading) return <div className="p-4"><Skeleton className="w-full h-8 bg-zinc-900" /></div>;
  const trades = data?.trades || [];
  if (!trades.length) return <div className="p-6 text-center text-zinc-600 text-xs">No recent trades</div>;

  return (
    <div>
      <div className="grid grid-cols-[1fr_50px_80px_80px_80px] gap-2 px-3 py-1.5 text-[9px] text-zinc-600 uppercase tracking-wider border-b border-zinc-800/30">
        <span>Symbol</span><span>Side</span><span className="text-right">Price</span><span className="text-right">Qty</span><span className="text-right">PnL</span>
      </div>
      {trades.slice(0, 20).map((t, i) => (
        <div key={i} className="grid grid-cols-[1fr_50px_80px_80px_80px] gap-2 px-3 py-1.5 items-center border-b border-zinc-800/20 text-[10px]">
          <span className="text-white font-medium">{t.symbol.replace("USDT", "")}</span>
          <span className={t.side === "BUY" ? "text-emerald-400" : "text-red-400"}>{t.side}</span>
          <span className="text-right font-mono text-zinc-400">{fmtPrice(t.price)}</span>
          <span className="text-right font-mono text-zinc-400">{t.qty.toFixed(4)}</span>
          <span className={cn("text-right font-mono", t.realizedPnl >= 0 ? "text-emerald-400" : "text-red-400")}>
            {t.realizedPnl !== 0 ? `${t.realizedPnl >= 0 ? "+" : ""}${fmt(t.realizedPnl)}` : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

function AgentPanel({ wallet }: { wallet: string }) {
  const { data: agent, loading, refresh } = useApi<AgentData>("/api/miniapp/agent", wallet);
  const [toggling, setToggling] = useState(false);

  useEffect(() => { if (!wallet) return; const iv = setInterval(refresh, 10000); return () => clearInterval(iv); }, [wallet, refresh]);

  const toggle = async () => {
    setToggling(true);
    try { await post("/api/miniapp/agent/toggle", wallet, {}); refresh(); } catch {} finally { setToggling(false); }
  };

  if (loading) return <div className="p-3 space-y-2"><Skeleton className="w-full h-6 bg-zinc-900" /><Skeleton className="w-full h-4 bg-zinc-900" /><Skeleton className="w-3/4 h-4 bg-zinc-900" /></div>;
  if (!agent) return <div className="p-4 text-center text-xs text-zinc-600">Agent not available</div>;

  const totalTrades = agent.stats.winCount + agent.stats.lossCount;
  const winRate = totalTrades > 0 ? (agent.stats.winCount / totalTrades) * 100 : 0;
  const winRateStr = totalTrades > 0 ? winRate.toFixed(0) + "%" : "—";
  const confidence = totalTrades > 0 ? Math.min(Math.max(winRate, 10), 95) : 50;
  const confColor = confidence >= 65 ? "#22c55e" : confidence >= 45 ? "#f59e0b" : "#ef4444";

  return (
    <div className="p-3 space-y-3" data-testid="agent-panel">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="relative">
            <Bot className={cn("w-4 h-4", agent.running ? "text-emerald-400" : "text-zinc-600")} />
            {agent.running && <div className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_6px_rgba(34,197,94,0.5)]" />}
          </div>
          <div>
            <span className="text-xs font-bold text-white">{agent.config.name}</span>
            <span className={cn("ml-2 text-[9px]", agent.running ? "text-emerald-400" : "text-zinc-600")}>{agent.running ? "LIVE" : "IDLE"}</span>
          </div>
        </div>
        <button onClick={toggle} disabled={toggling} data-testid="button-agent-toggle"
          className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-semibold transition-all",
            agent.running ? "bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20 shadow-[0_0_10px_rgba(239,68,68,0.05)]" : "bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/20 shadow-[0_0_10px_rgba(34,197,94,0.05)]")}>
          {toggling ? <RefreshCw className="w-3 h-3 animate-spin" /> : agent.running ? <><Square className="w-3 h-3" /> Stop</> : <><Play className="w-3 h-3" /> Start</>}
        </button>
      </div>

      {totalTrades > 0 && (
        <div className="bg-zinc-900/30 rounded-lg p-2.5 border border-zinc-800/20">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[8px] text-zinc-600 uppercase tracking-wider">Confidence</span>
            <span className="text-[11px] font-bold font-mono" style={{ color: confColor }}>{confidence.toFixed(0)}%</span>
          </div>
          <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all duration-700" style={{ width: `${confidence}%`, background: `linear-gradient(90deg, ${confColor}80, ${confColor})` }} />
          </div>
        </div>
      )}

      <div className="grid grid-cols-4 gap-1.5">
        {[
          { label: "Trades", value: String(agent.stats.tradeCount), color: "text-white" },
          { label: "Win", value: winRateStr, color: "text-emerald-400" },
          { label: "PnL", value: (agent.stats.totalPnl >= 0 ? "+" : "") + fmt(agent.stats.totalPnl), color: agent.stats.totalPnl >= 0 ? "text-emerald-400" : "text-red-400" },
          { label: "Scans", value: String(agent.stats.scanCount), color: "text-zinc-300" },
        ].map(s => (
          <div key={s.label} className="bg-zinc-900/40 rounded-md p-1.5 text-center border border-zinc-800/15">
            <div className="text-[7px] text-zinc-600 uppercase tracking-wider mb-0.5">{s.label}</div>
            <div className={cn("text-[10px] font-bold font-mono", s.color)}>{s.value}</div>
          </div>
        ))}
      </div>

      {agent.stats.lastReason && (
        <div className="bg-gradient-to-br from-zinc-900/50 to-zinc-900/20 rounded-lg p-2.5 border border-zinc-800/20 backdrop-blur-sm">
          <div className="flex items-center gap-1.5 mb-1.5">
            <Activity className="w-3 h-3 text-cyan-400" />
            <span className="text-[8px] text-cyan-400/80 uppercase tracking-wider font-semibold">AI Reasoning</span>
          </div>
          <div className="text-[10px] text-zinc-300 leading-relaxed">{agent.stats.lastReason}</div>
          {agent.stats.lastAction && (
            <div className="mt-1.5 flex items-center gap-1.5">
              <Zap className="w-2.5 h-2.5 text-amber-400" />
              <span className="text-[9px] text-amber-400/80 font-medium">{agent.stats.lastAction}</span>
            </div>
          )}
        </div>
      )}

      {agent.stats.openPositions.length > 0 && (
        <div>
          <div className="text-[8px] text-zinc-600 uppercase tracking-wider mb-1">Active Positions</div>
          <div className="flex flex-wrap gap-1">
            {agent.stats.openPositions.map((pos, i) => (
              <Badge key={i} variant="outline" className={cn("text-[8px] border-0 font-medium", pos.startsWith("BUY") ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400")}>{pos}</Badge>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[9px] bg-zinc-900/20 rounded-md p-2 border border-zinc-800/10">
        <div className="flex justify-between text-zinc-500"><span>Risk</span><span className="text-zinc-300">{agent.config.riskPercent}%</span></div>
        <div className="flex justify-between text-zinc-500"><span>Max Lev</span><span className="text-zinc-300">{agent.config.maxLeverage}x</span></div>
        <div className="flex justify-between text-zinc-500"><span>TP</span><span className="text-emerald-400/80">{agent.config.takeProfitPct}%</span></div>
        <div className="flex justify-between text-zinc-500"><span>SL</span><span className="text-red-400/80">{agent.config.stopLossPct}%</span></div>
      </div>
    </div>
  );
}

function PairSelector({ selected, onSelect, onClose, favorites, toggleFav }: { selected: string; onSelect: (s: string) => void; onClose: () => void; favorites: Set<string>; toggleFav: (s: string) => void }) {
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "volume" | "change">("name");
  const { data: marketsResp } = usePub<{ markets: MktItem[] }>("/api/public/markets");
  const filtered = useMemo(() => {
    let list = marketsResp?.markets || PAIRS.map(s => ({ symbol: s, price: 0, change24h: 0, volume24h: 0, high24h: 0, low24h: 0 }));
    if (search) list = list.filter(m => m.symbol.toLowerCase().includes(search.toLowerCase()));
    const favList = list.filter(m => favorites.has(m.symbol));
    const rest = list.filter(m => !favorites.has(m.symbol));
    if (sortBy === "volume") rest.sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0));
    else if (sortBy === "change") rest.sort((a, b) => Math.abs(b.change24h || 0) - Math.abs(a.change24h || 0));
    return [...favList, ...rest];
  }, [marketsResp, search, sortBy, favorites]);

  return (
    <div className="absolute top-0 left-0 z-50 bg-[#0d0e10] border border-zinc-800/60 rounded-lg shadow-2xl w-[320px] max-h-[420px] overflow-hidden backdrop-blur-xl" data-testid="pair-selector">
      <div className="p-2 border-b border-zinc-800/40 flex items-center gap-2">
        <Search className="w-3.5 h-3.5 text-zinc-600" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search pairs..." className="flex-1 bg-transparent text-xs text-white outline-none placeholder:text-zinc-600" autoFocus data-testid="input-search-pair" />
        <button onClick={onClose} className="text-zinc-600 hover:text-white transition-colors"><X className="w-3.5 h-3.5" /></button>
      </div>
      <div className="flex gap-2 px-2 py-1.5 border-b border-zinc-800/30">
        {(["name", "volume", "change"] as const).map(s => (
          <button key={s} onClick={() => setSortBy(s)} className={cn("text-[9px] px-1.5 py-0.5 rounded transition-all", sortBy === s ? "bg-zinc-700/60 text-white" : "text-zinc-600 hover:text-zinc-400")}>
            {s === "name" ? "Name" : s === "volume" ? "Volume" : "Change"}
          </button>
        ))}
      </div>
      <div className="max-h-[340px] overflow-y-auto">
        {filtered.map(m => (
          <div key={m.symbol} className={cn("px-3 py-2 flex items-center hover:bg-zinc-800/30 transition-colors", m.symbol === selected && "bg-zinc-800/40")}>
            <button onClick={() => toggleFav(m.symbol)} className="mr-2 text-zinc-600 hover:text-amber-400 transition-colors" data-testid={`fav-${m.symbol}`}>
              {favorites.has(m.symbol) ? <Star className="w-3 h-3 text-amber-400 fill-amber-400" /> : <StarOff className="w-3 h-3" />}
            </button>
            <button onClick={() => { onSelect(m.symbol); onClose(); }} className="flex-1 flex justify-between items-center text-xs" data-testid={`pair-${m.symbol}`}>
              <div className="flex items-center gap-1.5">
                <span className="font-bold text-white">{m.symbol.replace("USDT", "")}</span>
                <span className="text-zinc-600 text-[9px]">/USDT</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-mono text-zinc-300">{fmtPrice(m.price)}</span>
                <span className={cn("font-mono w-16 text-right", m.change24h >= 0 ? "text-emerald-400" : "text-red-400")}>{m.change24h >= 0 ? "+" : ""}{m.change24h?.toFixed(2)}%</span>
              </div>
            </button>
          </div>
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
      const regRes = await fetch("/api/miniapp/web-register", { method: "POST", headers: { "Content-Type": "application/json", "x-wallet-address": wallet }, body: JSON.stringify({ walletAddress: wallet }) });
      const regData = await regRes.json();
      if (regData.error && !regData.error.includes("already")) { setError(regData.error); setWorking(false); return; }
      setStep(2);
      const actRes = await fetch("/api/miniapp/activate-trading", { method: "POST", headers: { "Content-Type": "application/json", "x-wallet-address": wallet }, body: JSON.stringify({ walletAddress: wallet }) });
      const actData = await actRes.json();
      if (actData.error) { setError(actData.error); setWorking(false); return; }
      if (actData.alreadyActive) { setStep(5); onDone(); return; }
      const sessionId = actData.sessionId;
      const tradingAddress = actData.tradingWalletAddress;
      if (!tradingAddress) { setError("No trading address returned"); setWorking(false); return; }
      setStep(3);
      try {
        const nonceRes = await fetch("https://www.asterdex.com/bapi/futures/v1/public/future/web3/get-nonce", { method: "POST", headers: { "Content-Type": "application/json", "clientType": "web" }, body: JSON.stringify({ type: "LOGIN", sourceAddr: tradingAddress }) });
        const nonceData = await nonceRes.json();
        if (nonceData?.data?.nonce) {
          const signRes = await fetch("/api/miniapp/sign-registration", { method: "POST", headers: { "Content-Type": "application/json", "x-wallet-address": wallet }, body: JSON.stringify({ sessionId, nonce: nonceData.data.nonce }) });
          const signData = await signRes.json();
          if (signData.signature) {
            try { await fetch("https://www.asterdex.com/bapi/futures/v1/public/future/web3/ae/login", { method: "POST", headers: { "Content-Type": "application/json", "clientType": "web" }, body: JSON.stringify({ signature: signData.signature, sourceAddr: tradingAddress, chainId: 56, agentCode: "BUILD4" }) }); } catch {}
          }
        }
      } catch { }
      setStep(4);
      const complRes = await fetch("/api/miniapp/complete-activation", { method: "POST", headers: { "Content-Type": "application/json", "x-wallet-address": wallet }, body: JSON.stringify({ sessionId }) });
      const complData = await complRes.json();
      if (complData.error) { setError(complData.error); setWorking(false); return; }
      setStep(5); onDone();
    } catch (e: any) { setError(e.message || "Activation failed"); } finally { setWorking(false); }
  };
  return (
    <div className="p-8 text-center space-y-5" data-testid="activation-flow">
      <div className="w-14 h-14 mx-auto rounded-2xl bg-gradient-to-br from-emerald-500/20 to-cyan-500/20 flex items-center justify-center border border-emerald-500/10 shadow-[0_0_40px_rgba(34,197,94,0.08)]">
        <Zap className="w-7 h-7 text-emerald-400" />
      </div>
      <div>
        <h3 className="text-base font-bold text-white mb-1">Activate Trading</h3>
        <p className="text-xs text-zinc-500 max-w-xs mx-auto">Your wallet signature is your identity. Activate once to start trading perpetual futures with up to 125x leverage.</p>
      </div>
      {step > 0 && (
        <div className="text-xs space-y-1.5 text-left max-w-xs mx-auto">
          {["Registering wallet...", "Creating trading agent...", "Registering on Aster DEX...", "Approving agent on-chain...", "Done!"].map((label, i) => (
            <div key={i} className={cn("flex items-center gap-2 transition-all", step > i ? "text-emerald-400" : step === i + 1 ? "text-white" : "text-zinc-600")}>
              {step > i + 1 ? <div className="w-4 h-4 rounded-full bg-emerald-500/20 flex items-center justify-center text-[8px]">&#10003;</div> : step === i + 1 ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <div className="w-4 h-4 rounded-full border border-zinc-700" />}
              {i + 1}. {label}
            </div>
          ))}
        </div>
      )}
      {error && <div className="text-xs text-red-400 bg-red-500/10 p-2.5 rounded-md border border-red-500/20">{error}</div>}
      <Button onClick={activate} disabled={working} data-testid="button-activate" className="bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-400 hover:to-cyan-400 text-white border-0 shadow-lg px-8 h-10">
        {working ? <><RefreshCw className="w-4 h-4 animate-spin mr-2" />Step {step}/4...</> : "Activate Now"}
      </Button>
      <p className="text-[10px] text-zinc-600 max-w-xs mx-auto">Same wallet = same account. If you imported this wallet into the Telegram bot, your balances sync automatically.</p>
    </div>
  );
}

function WalletPicker({ onMM, onWC, onClose }: { onMM: () => void; onWC: () => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose} data-testid="wallet-picker">
      <div className="bg-[#0d0e10] border border-zinc-800/60 rounded-xl p-6 w-80 space-y-3 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center">
          <h3 className="text-sm font-bold text-white">Connect Wallet</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors"><X className="w-4 h-4" /></button>
        </div>
        <button onClick={() => { onMM(); onClose(); }} data-testid="button-metamask" className="w-full p-3.5 bg-zinc-900/60 border border-zinc-800/50 rounded-lg hover:border-zinc-600 transition-all flex items-center gap-3 group">
          <Wallet className="w-5 h-5 text-orange-400 group-hover:scale-110 transition-transform" /><span className="text-sm text-white">Browser Wallet</span>
        </button>
        <button onClick={() => { onWC(); onClose(); }} data-testid="button-walletconnect" className="w-full p-3.5 bg-zinc-900/60 border border-zinc-800/50 rounded-lg hover:border-zinc-600 transition-all flex items-center gap-3 group">
          <Activity className="w-5 h-5 text-blue-400 group-hover:scale-110 transition-transform" /><span className="text-sm text-white">WalletConnect</span>
        </button>
      </div>
    </div>
  );
}

function FuturesTerminal() {
  const { address, connecting, error: walletError, connect, disconnect, showPicker, setShowPicker, connectMM, connectWC } = useWallet();
  const [selectedPair, setSelectedPair] = useState(() => { try { return localStorage.getItem("futures_pair") || "BTCUSDT"; } catch { return "BTCUSDT"; } });
  const [interval, setTf] = useState(() => { try { return localStorage.getItem("futures_tf") || "15m"; } catch { return "15m"; } });
  const [showPairs, setShowPairs] = useState(false);
  const [bottomTab, setBottomTab] = useState<"positions" | "orders" | "trades">("positions");
  const [rightTab, setRightTab] = useState<"trade" | "agent">("trade");
  const [indicators, setIndicators] = useState<IndicatorType[]>(() => { try { const s = localStorage.getItem("futures_ind"); return s ? JSON.parse(s) : ["ema9", "ema21"]; } catch { return ["ema9", "ema21"]; } });
  const [showIndicators, setShowIndicators] = useState(false);
  const [favorites, setFavorites] = useState<Set<string>>(() => { try { const s = localStorage.getItem("futures_favs"); return s ? new Set(JSON.parse(s)) : new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT"]); } catch { return new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT"]); } });
  const [registered, setRegistered] = useState(false);
  const [showLinkDialog, setShowLinkDialog] = useState(false);

  useEffect(() => {
    if (!address) { setRegistered(false); return; }
    let cancelled = false;
    (async () => {
      try {
        await fetch("/api/miniapp/web-register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ walletAddress: address }),
        });
        if (!cancelled) setRegistered(true);
      } catch {
        if (!cancelled) setRegistered(true);
      }
    })();
    return () => { cancelled = true; };
  }, [address]);

  const toggleFav = useCallback((s: string) => {
    setFavorites(prev => { const n = new Set(prev); if (n.has(s)) n.delete(s); else n.add(s); localStorage.setItem("futures_favs", JSON.stringify([...n])); return n; });
  }, []);
  const toggleIndicator = useCallback((ind: IndicatorType) => {
    setIndicators(prev => { const n = prev.includes(ind) ? prev.filter(i => i !== ind) : [...prev, ind]; localStorage.setItem("futures_ind", JSON.stringify(n)); return n; });
  }, []);

  useEffect(() => { localStorage.setItem("futures_pair", selectedPair); }, [selectedPair]);
  useEffect(() => { localStorage.setItem("futures_tf", interval); }, [interval]);

  const effectiveWallet = registered ? address : null;
  const { data: acct, loading: acctLoading, refresh: refreshAcct } = useApi<AcctData>("/api/miniapp/account", effectiveWallet);
  const { data: rawTicker } = usePub<any>(`/api/public/ticker?symbol=${selectedPair}`, 5000);
  const { data: rawFunding } = usePub<any>(`/api/public/funding?symbol=${selectedPair}`, 30000);

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
    const iv = window.setInterval(refreshAcct, 10000);
    return () => clearInterval(iv);
  }, [address, refreshAcct]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "b" || e.key === "B") document.querySelector<HTMLButtonElement>('[data-testid="button-buy"]')?.click();
      if (e.key === "s" || e.key === "S") document.querySelector<HTMLButtonElement>('[data-testid="button-sell"]')?.click();
      if (e.key >= "1" && e.key <= "9") {
        const levMap: Record<string, number> = { "1": 1, "2": 2, "3": 5, "4": 10, "5": 20, "6": 50, "7": 75, "8": 100, "9": 125 };
        const lev = levMap[e.key];
        if (lev) {
          const slider = document.querySelector('[data-testid="slider-leverage"]');
          if (slider) {
            const event = new CustomEvent("setLeverage", { detail: lev });
            window.dispatchEvent(event);
          }
        }
      }
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
  const availableMargin = acct?.availableMargin || 0;

  if (!address) {
    return (
      <div className="h-screen bg-[#0a0b0d] flex items-center justify-center" data-testid="connect-screen">
        <div className="text-center space-y-5 max-w-sm px-6">
          <div className="w-20 h-20 mx-auto rounded-2xl bg-gradient-to-br from-emerald-500/15 to-cyan-500/15 flex items-center justify-center border border-emerald-500/10 shadow-[0_0_60px_rgba(34,197,94,0.06)]">
            <BarChart3 className="w-10 h-10 text-emerald-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white mb-2">BUILD4 Terminal</h1>
            <p className="text-sm text-zinc-500 leading-relaxed">Trade perpetual futures on Aster DEX with up to 125x leverage. Connect your wallet to begin.</p>
          </div>
          <Button onClick={connect} disabled={connecting} data-testid="button-connect-wallet" className="bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-400 hover:to-cyan-400 text-white border-0 shadow-[0_0_40px_rgba(34,197,94,0.15)] px-10 h-11 text-sm font-semibold">
            {connecting ? <RefreshCw className="w-4 h-4 animate-spin mr-2" /> : <Wallet className="w-4 h-4 mr-2" />}Connect Wallet
          </Button>
          {walletError && <p className="text-xs text-red-400">{walletError}</p>}
          <div className="flex items-center justify-center gap-4 text-[10px] text-zinc-600 pt-2">
            <span>125x Leverage</span><span className="text-zinc-800">|</span>
            <span>AI Trading Agent</span><span className="text-zinc-800">|</span>
            <span>Aster DEX V3</span>
          </div>
        </div>
        {showPicker && <WalletPicker onMM={connectMM} onWC={connectWC} onClose={() => setShowPicker(false)} />}
      </div>
    );
  }

  if (acctLoading && !acct) {
    return (
      <div className="h-screen bg-[#0a0b0d] flex items-center justify-center">
        <div className="text-center space-y-3">
          <RefreshCw className="w-6 h-6 text-zinc-500 animate-spin mx-auto" />
          <p className="text-xs text-zinc-500">Loading account...</p>
        </div>
      </div>
    );
  }

  if (acct && !acct.connected) {
    return (
      <div className="h-screen bg-[#0a0b0d] flex items-center justify-center">
        <div className="max-w-md w-full bg-[#0d0e10] border border-zinc-800/50 rounded-xl shadow-2xl">
          <ActivationFlow wallet={address} onDone={refreshAcct} />
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-[#0a0b0d] text-white flex flex-col overflow-hidden select-none" data-testid="trading-terminal">
      <div className="h-11 border-b border-zinc-800/40 flex items-center px-3 gap-3 shrink-0 bg-[#0c0d0f]">
        <div className="relative">
          <button onClick={() => setShowPairs(!showPairs)} data-testid="button-pair-selector"
            className="flex items-center gap-1.5 hover:bg-zinc-800/40 px-2.5 py-1.5 rounded-md transition-all group">
            <span className="text-sm font-bold">{selectedPair.replace("USDT", "")}</span>
            <span className="text-[10px] text-zinc-500">/USDT</span>
            <span className="text-[10px] text-zinc-700">PERP</span>
            <ChevronDown className="w-3 h-3 text-zinc-600 group-hover:text-zinc-400 transition-colors" />
          </button>
          {showPairs && <PairSelector selected={selectedPair} onSelect={setSelectedPair} onClose={() => setShowPairs(false)} favorites={favorites} toggleFav={toggleFav} />}
        </div>

        <div className="w-px h-5 bg-zinc-800/60" />

        <span className={cn("text-base font-bold font-mono tabular-nums", change >= 0 ? "text-emerald-400" : "text-red-400")} data-testid="text-price">{fmtPrice(price)}</span>
        <span className={cn("text-[11px] font-mono tabular-nums px-1.5 py-0.5 rounded", change >= 0 ? "text-emerald-400 bg-emerald-500/8" : "text-red-400 bg-red-500/8")}>{change >= 0 ? "+" : ""}{change.toFixed(2)}%</span>

        <div className="hidden lg:flex items-center gap-3 text-[10px] text-zinc-500 ml-2">
          <div><span className="text-zinc-600 mr-1">24h H</span><span className="text-zinc-300 font-mono">{fmtPrice(high)}</span></div>
          <div><span className="text-zinc-600 mr-1">24h L</span><span className="text-zinc-300 font-mono">{fmtPrice(low)}</span></div>
          <div><span className="text-zinc-600 mr-1">Vol</span><span className="text-zinc-300 font-mono">{fmtK(vol)}</span></div>
          {fr !== 0 && <div><span className="text-zinc-600 mr-1">FR</span><span className={cn("font-mono", fr >= 0 ? "text-emerald-400" : "text-red-400")}>{(fr * 100).toFixed(4)}%</span></div>}
          {oi > 0 && <div><span className="text-zinc-600 mr-1">OI</span><span className="text-zinc-300 font-mono">{fmtK(oi)}</span></div>}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {acct && (
            <div className="hidden md:flex items-center gap-3 text-[10px]">
              <div className="bg-zinc-900/40 rounded-md px-2.5 py-1 border border-zinc-800/20">
                <span className="text-zinc-600 mr-1">Balance</span>
                <span className="text-white font-mono font-medium">${fmt(acct.walletBalance)}</span>
              </div>
              <div className="bg-zinc-900/40 rounded-md px-2.5 py-1 border border-zinc-800/20">
                <span className="text-zinc-600 mr-1">Available</span>
                <span className="text-emerald-400 font-mono font-medium">${fmt(acct.availableMargin)}</span>
              </div>
              {acct.walletBalance === 0 && acct.availableMargin === 0 && (
                <button onClick={() => setShowLinkDialog(true)} className="text-amber-400/70 hover:text-amber-400 underline transition-colors" data-testid="button-link-hint">Link Telegram</button>
              )}
              {acct.unrealizedPnl !== 0 && (
                <div className={cn("bg-zinc-900/40 rounded-md px-2.5 py-1 border", acct.unrealizedPnl >= 0 ? "border-emerald-500/10" : "border-red-500/10")}>
                  <span className="text-zinc-600 mr-1">uPnL</span>
                  <span className={cn("font-mono font-medium", acct.unrealizedPnl >= 0 ? "text-emerald-400" : "text-red-400")}>
                    {acct.unrealizedPnl >= 0 ? "+" : ""}{fmt(acct.unrealizedPnl)}
                  </span>
                </div>
              )}
            </div>
          )}
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_4px_rgba(34,197,94,0.5)]" title="Connected to Aster V3" />
          <button onClick={disconnect} data-testid="button-disconnect" className="text-zinc-600 hover:text-zinc-300 transition-colors p-1.5 rounded-md hover:bg-zinc-800/40" title="Disconnect wallet">
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col min-w-0">
          <div className="h-8 border-b border-zinc-800/30 flex items-center px-2 gap-0.5 shrink-0 bg-[#0c0d0f]">
            {TF.map(tf => (
              <button key={tf} onClick={() => setTf(tf)} data-testid={`tf-${tf}`}
                className={cn("px-2 py-0.5 text-[10px] rounded transition-all", interval === tf ? "bg-zinc-700/60 text-white" : "text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800/30")}>{tf}</button>
            ))}
            <div className="w-px h-4 bg-zinc-800/40 mx-1" />
            <div className="relative">
              <button onClick={() => setShowIndicators(!showIndicators)} className={cn("px-2 py-0.5 text-[10px] rounded flex items-center gap-1 transition-all", indicators.length > 0 ? "text-amber-400 bg-amber-500/8" : "text-zinc-600 hover:text-zinc-400")} data-testid="button-indicators">
                <BarChart3 className="w-3 h-3" /> Indicators
              </button>
              {showIndicators && (
                <div className="absolute top-7 left-0 z-40 bg-[#0d0e10]/95 backdrop-blur-xl border border-zinc-800/50 rounded-lg shadow-2xl p-2 w-48">
                  <div className="text-[8px] text-zinc-600 uppercase tracking-wider px-2 py-1 font-semibold">Overlays</div>
                  {(["ema9", "ema21", "ema50", "sma20", "sma50", "bb20"] as IndicatorType[]).map(ind => (
                    <button key={ind} onClick={() => toggleIndicator(ind)}
                      className={cn("w-full text-left px-2 py-1.5 text-[10px] rounded flex items-center gap-2 transition-all",
                        indicators.includes(ind) ? "bg-zinc-800/60 text-white" : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/30")}>
                      <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: INDICATOR_COLORS[ind] }} />
                      {INDICATOR_LABELS[ind]}
                      {indicators.includes(ind) && <span className="ml-auto text-emerald-400 text-[9px]">&#10003;</span>}
                    </button>
                  ))}
                  <div className="my-1 border-t border-zinc-800/30" />
                  <div className="text-[8px] text-zinc-600 uppercase tracking-wider px-2 py-1 font-semibold">Sub-Charts</div>
                  {(["rsi14", "macd"] as IndicatorType[]).map(ind => (
                    <button key={ind} onClick={() => toggleIndicator(ind)}
                      className={cn("w-full text-left px-2 py-1.5 text-[10px] rounded flex items-center gap-2 transition-all",
                        indicators.includes(ind) ? "bg-zinc-800/60 text-white" : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/30")}>
                      <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: INDICATOR_COLORS[ind] }} />
                      {INDICATOR_LABELS[ind]}
                      {indicators.includes(ind) && <span className="ml-auto text-emerald-400 text-[9px]">&#10003;</span>}
                    </button>
                  ))}
                  <div className="mt-1 pt-1 border-t border-zinc-800/30">
                    <button onClick={() => { setIndicators([]); localStorage.setItem("futures_ind", "[]"); }} className="w-full text-left px-2 py-1 text-[9px] text-zinc-600 hover:text-zinc-400">Clear all</button>
                  </div>
                </div>
              )}
            </div>
            {indicators.length > 0 && (
              <div className="hidden lg:flex items-center gap-0.5 ml-1">
                {indicators.map(ind => (
                  <button key={ind} onClick={() => toggleIndicator(ind)} className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] bg-zinc-800/40 hover:bg-zinc-800/70 transition-all group" title={`Remove ${INDICATOR_LABELS[ind]}`}>
                    <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: INDICATOR_COLORS[ind] }} />
                    <span className="text-zinc-400 group-hover:text-zinc-200">{INDICATOR_LABELS[ind]}</span>
                    <X className="w-2.5 h-2.5 text-zinc-600 group-hover:text-zinc-300" />
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex-1 min-h-0">
            <TradingChart symbol={selectedPair} interval={interval} indicators={indicators} positions={positions} />
          </div>

          <div className="h-[200px] border-t border-zinc-800/40 bg-[#0c0d0f] shrink-0 overflow-hidden flex flex-col">
            <div className="h-7 border-b border-zinc-800/30 flex items-center px-2 gap-3 shrink-0">
              {(["positions", "orders", "trades"] as const).map(tab => (
                <button key={tab} onClick={() => setBottomTab(tab)} data-testid={`tab-${tab}`}
                  className={cn("text-[10px] pb-0.5 transition-all relative", bottomTab === tab ? "text-white" : "text-zinc-600 hover:text-zinc-400")}>
                  {tab === "positions" ? `Positions (${positions.length})` : tab.charAt(0).toUpperCase() + tab.slice(1)}
                  {bottomTab === tab && <div className="absolute bottom-0 left-0 right-0 h-[1px] bg-emerald-400" />}
                </button>
              ))}
              <button onClick={refreshAcct} className="ml-auto text-zinc-700 hover:text-zinc-500 transition-colors p-0.5 rounded" data-testid="button-refresh-positions"><RefreshCw className="w-3 h-3" /></button>
            </div>
            <div className="flex-1 overflow-y-auto overflow-x-auto">
              {bottomTab === "positions" && <PositionsPanel positions={positions} wallet={address} onRefresh={refreshAcct} />}
              {bottomTab === "orders" && <OrdersPanel wallet={address} />}
              {bottomTab === "trades" && <TradesPanel wallet={address} symbol={selectedPair} />}
            </div>
          </div>
        </div>

        <div className="w-[290px] border-l border-zinc-800/40 flex flex-col shrink-0 bg-[#0c0d0f] hidden md:flex">
          <div className="flex-1 min-h-0 overflow-hidden border-b border-zinc-800/40 flex flex-col">
            <div className="h-7 border-b border-zinc-800/30 flex items-center px-2 shrink-0">
              <span className="text-[9px] text-zinc-500 uppercase tracking-wider font-medium">Order Book</span>
            </div>
            <div className="flex-1 overflow-y-auto">
              <OrderBook symbol={selectedPair} />
            </div>
          </div>

          <div className="flex flex-col overflow-hidden" style={{ maxHeight: "55%" }}>
            <div className="h-7 border-b border-zinc-800/30 flex items-center px-2 gap-2 shrink-0">
              {(["trade", "agent"] as const).map(tab => (
                <button key={tab} onClick={() => setRightTab(tab)}
                  className={cn("text-[9px] uppercase tracking-wider font-medium transition-all relative pb-0.5",
                    rightTab === tab ? "text-white" : "text-zinc-600 hover:text-zinc-400")}>
                  {tab === "trade" ? "Trade" : "AI Agent"}
                  {rightTab === tab && <div className="absolute bottom-0 left-0 right-0 h-[1px] bg-emerald-400" />}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto">
              {rightTab === "trade" && <TradeTicket symbol={selectedPair} wallet={address} price={price} availableMargin={availableMargin} onSuccess={refreshAcct} />}
              {rightTab === "agent" && <AgentPanel wallet={address} />}
            </div>
          </div>
        </div>
      </div>

      <div className="md:hidden fixed bottom-0 left-0 right-0 bg-[#0c0d0f] border-t border-zinc-800/40 p-2 flex gap-2 safe-bottom">
        <Button className="flex-1 bg-emerald-500 text-white font-bold h-10 shadow-[0_0_20px_rgba(34,197,94,0.12)]" data-testid="button-mobile-long">Long</Button>
        <Button className="flex-1 bg-red-500 text-white font-bold h-10 shadow-[0_0_20px_rgba(239,68,68,0.12)]" data-testid="button-mobile-short">Short</Button>
      </div>

      {showPicker && <WalletPicker onMM={connectMM} onWC={connectWC} onClose={() => setShowPicker(false)} />}
      {showIndicators && <div className="fixed inset-0 z-30" onClick={() => setShowIndicators(false)} />}
      {showPairs && <div className="fixed inset-0 z-30" onClick={() => setShowPairs(false)} />}
      {showLinkDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowLinkDialog(false)}>
          <div className="bg-[#0d0e10] border border-zinc-800 rounded-xl shadow-2xl max-w-sm w-full mx-4 p-6" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-sm font-bold text-white">Link Telegram Bot Wallet</h3>
              <button onClick={() => setShowLinkDialog(false)} className="text-zinc-600 hover:text-zinc-300 transition-colors">&times;</button>
            </div>
            <LinkBotWallet wallet={address} onDone={() => { setShowLinkDialog(false); window.location.reload(); }} />
          </div>
        </div>
      )}
    </div>
  );
}

export default function FuturesPage() {
  return <ErrorBoundary><FuturesTerminal /></ErrorBoundary>;
}
