import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWallet } from "@/hooks/use-wallet";
import { WalletConnector } from "@/components/wallet-connector";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import {
  ArrowLeftRight,
  BarChart3,
  Layers,
  Wallet,
  ArrowLeft,
  RefreshCw,
  ExternalLink,
  ArrowDown,
  Globe,
  TrendingUp,
  Shield,
  Zap,
  AlertTriangle,
  ChevronDown,
} from "lucide-react";

const CHAIN_OPTIONS = [
  { id: "56", name: "BNB Chain", symbol: "BNB" },
  { id: "196", name: "XLayer", symbol: "OKB" },
  { id: "1", name: "Ethereum", symbol: "ETH" },
  { id: "137", name: "Polygon", symbol: "POL" },
  { id: "42161", name: "Arbitrum", symbol: "ETH" },
  { id: "8453", name: "Base", symbol: "ETH" },
  { id: "43114", name: "Avalanche", symbol: "AVAX" },
  { id: "10", name: "Optimism", symbol: "ETH" },
];

const NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

type Tab = "swap" | "market" | "bridge" | "wallet";

export default function OnchainOS() {
  const { connected, address, chainId } = useWallet();
  const [activeTab, setActiveTab] = useState<Tab>("swap");

  const { data: okxStatus } = useQuery<{
    configured: boolean;
    supportedChains: Record<string, string>;
    features: Record<string, boolean>;
  }>({
    queryKey: ["/api/okx/status"],
  });

  const isConfigured = okxStatus?.configured ?? false;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/">
              <button className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors" data-testid="link-back-home">
                <ArrowLeft className="w-4 h-4" />
                <span className="font-mono text-xs">BUILD4</span>
              </button>
            </Link>
            <span className="text-muted-foreground">/</span>
            <div className="flex items-center gap-2">
              <Globe className="w-4 h-4 text-violet-500" />
              <span className="font-mono text-sm font-bold">OnchainOS</span>
              <Badge variant="secondary" className="text-[10px]">Powered by OKX</Badge>
            </div>
          </div>
          <WalletConnector />
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="mb-6">
          <h1 className="font-mono text-2xl font-bold mb-2" data-testid="text-onchainos-title">
            OKX OnchainOS Integration
          </h1>
          <p className="text-sm text-muted-foreground max-w-2xl">
            Multi-chain DEX aggregation, real-time market data, cross-chain bridges, and wallet intelligence — powered by OKX OnchainOS across 60+ chains.
          </p>
        </div>

        {!isConfigured && (
          <div className="mb-6 bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-yellow-500 mt-0.5 shrink-0" />
            <div>
              <p className="font-mono text-sm font-medium text-yellow-500">API Keys Required</p>
              <p className="text-xs text-muted-foreground mt-1">
                OKX OnchainOS requires API credentials. Add <code className="bg-muted px-1 rounded">OKX_API_KEY</code>, <code className="bg-muted px-1 rounded">OKX_SECRET_KEY</code>, <code className="bg-muted px-1 rounded">OKX_API_PASSPHRASE</code>, and <code className="bg-muted px-1 rounded">OKX_PROJECT_ID</code> to your environment variables.
                Create keys at <a href="https://web3.okx.com/onchainos" target="_blank" rel="noopener" className="text-violet-400 hover:underline">web3.okx.com/onchainos</a>.
              </p>
            </div>
          </div>
        )}

        <div className="flex items-center gap-1 mb-6 bg-muted/50 rounded-lg p-1 w-fit">
          {[
            { id: "swap" as Tab, icon: ArrowLeftRight, label: "DEX Swap" },
            { id: "market" as Tab, icon: BarChart3, label: "Market Data" },
            { id: "bridge" as Tab, icon: Layers, label: "Bridge" },
            { id: "wallet" as Tab, icon: Wallet, label: "Wallet" },
          ].map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-md font-mono text-xs transition-colors ${
                activeTab === id
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              data-testid={`tab-${id}`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            {activeTab === "swap" && <SwapPanel isConfigured={isConfigured} address={address} chainId={chainId} />}
            {activeTab === "market" && <MarketPanel isConfigured={isConfigured} />}
            {activeTab === "bridge" && <BridgePanel isConfigured={isConfigured} address={address} />}
            {activeTab === "wallet" && <WalletPanel isConfigured={isConfigured} address={address} connected={connected} />}
          </div>
          <div className="space-y-4">
            <FeatureCard />
            <ChainStatusCard chains={okxStatus?.supportedChains} />
          </div>
        </div>
      </div>
    </div>
  );
}

function SwapPanel({ isConfigured, address, chainId }: { isConfigured: boolean; address: string | null; chainId: number | null }) {
  const [selectedChain, setSelectedChain] = useState(chainId?.toString() || "56");
  const [fromToken, setFromToken] = useState(NATIVE_TOKEN);
  const [toToken, setToToken] = useState("");
  const [amount, setAmount] = useState("");
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quote, setQuote] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const handleGetQuote = async () => {
    if (!amount || !toToken) return;
    setQuoteLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        chainId: selectedChain,
        fromToken,
        toToken,
        amount,
        slippage: "0.5",
      });
      const res = await fetch(`/api/okx/dex/quote?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setQuote(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setQuoteLoading(false);
    }
  };

  return (
    <div className="bg-card border rounded-lg p-6" data-testid="panel-swap">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="w-5 h-5 text-violet-500" />
          <h2 className="font-mono text-lg font-bold">DEX Aggregator</h2>
        </div>
        <Badge variant="outline" className="text-[10px]">500+ DEXs</Badge>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Smart routing across 500+ decentralized exchanges. Best price, lowest slippage, optimized gas.
      </p>

      <div className="space-y-4">
        <div>
          <label className="font-mono text-xs text-muted-foreground block mb-1">Chain</label>
          <select
            value={selectedChain}
            onChange={(e) => setSelectedChain(e.target.value)}
            className="w-full bg-muted border rounded-md px-3 py-2 font-mono text-sm"
            data-testid="select-swap-chain"
          >
            {CHAIN_OPTIONS.map((c) => (
              <option key={c.id} value={c.id}>{c.name} ({c.symbol})</option>
            ))}
          </select>
        </div>

        <div className="bg-muted/50 rounded-lg p-4 space-y-3">
          <div>
            <label className="font-mono text-[10px] text-muted-foreground block mb-1">From Token (address)</label>
            <input
              type="text"
              value={fromToken}
              onChange={(e) => setFromToken(e.target.value)}
              placeholder="0xEee... (native token)"
              className="w-full bg-background border rounded-md px-3 py-2 font-mono text-xs"
              data-testid="input-from-token"
            />
          </div>
          <div className="flex justify-center">
            <div className="w-8 h-8 rounded-full bg-background border flex items-center justify-center">
              <ArrowDown className="w-4 h-4 text-muted-foreground" />
            </div>
          </div>
          <div>
            <label className="font-mono text-[10px] text-muted-foreground block mb-1">To Token (address)</label>
            <input
              type="text"
              value={toToken}
              onChange={(e) => setToToken(e.target.value)}
              placeholder="Paste token contract address"
              className="w-full bg-background border rounded-md px-3 py-2 font-mono text-xs"
              data-testid="input-to-token"
            />
          </div>
          <div>
            <label className="font-mono text-[10px] text-muted-foreground block mb-1">Amount (in smallest unit)</label>
            <input
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 1000000000000000000 for 1 token"
              className="w-full bg-background border rounded-md px-3 py-2 font-mono text-xs"
              data-testid="input-swap-amount"
            />
          </div>
        </div>

        <Button
          onClick={handleGetQuote}
          disabled={!isConfigured || !amount || !toToken || quoteLoading}
          className="w-full font-mono text-xs"
          data-testid="button-get-quote"
        >
          {quoteLoading ? (
            <><RefreshCw className="w-3.5 h-3.5 mr-2 animate-spin" /> Getting Quote...</>
          ) : (
            <><Zap className="w-3.5 h-3.5 mr-2" /> Get Best Quote</>
          )}
        </Button>

        {error && (
          <div className="bg-destructive/10 border border-destructive/30 rounded-md p-3">
            <p className="font-mono text-xs text-destructive">{error}</p>
          </div>
        )}

        {quote && quote.data && (
          <div className="bg-muted/50 rounded-lg p-4 space-y-2" data-testid="swap-quote-result">
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs text-muted-foreground">Est. Output</span>
              <span className="font-mono text-sm font-bold">{quote.data[0]?.toTokenAmount || "—"}</span>
            </div>
            {quote.data[0]?.estimateGasFee && (
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-muted-foreground">Gas Estimate</span>
                <span className="font-mono text-xs">{quote.data[0].estimateGasFee}</span>
              </div>
            )}
            {quote.data[0]?.dexRouterList && (
              <div className="mt-2">
                <span className="font-mono text-[10px] text-muted-foreground">Route</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {quote.data[0].dexRouterList.map((r: any, i: number) => (
                    <Badge key={i} variant="secondary" className="text-[10px]">
                      {r.dexName || `DEX ${i + 1}`}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MarketPanel({ isConfigured }: { isConfigured: boolean }) {
  const [selectedChain, setSelectedChain] = useState("56");
  const [tokenAddress, setTokenAddress] = useState("");
  const [tokenData, setTokenData] = useState<any>(null);
  const [trendingData, setTrendingData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [trendingLoading, setTrendingLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLookup = async () => {
    if (!tokenAddress) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ chainId: selectedChain, tokenAddress });
      const res = await fetch(`/api/okx/market/token?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTokenData(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleTrending = async () => {
    setTrendingLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/okx/market/trending?chainId=${selectedChain}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTrendingData(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setTrendingLoading(false);
    }
  };

  return (
    <div className="bg-card border rounded-lg p-6" data-testid="panel-market">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-emerald-500" />
          <h2 className="font-mono text-lg font-bold">Market Intelligence</h2>
        </div>
        <Badge variant="outline" className="text-[10px]">Real-time</Badge>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        On-chain token data, trending tokens, holder distribution, and trading analytics.
      </p>

      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="font-mono text-xs text-muted-foreground block mb-1">Chain</label>
            <select
              value={selectedChain}
              onChange={(e) => setSelectedChain(e.target.value)}
              className="w-full bg-muted border rounded-md px-3 py-2 font-mono text-sm"
              data-testid="select-market-chain"
            >
              {CHAIN_OPTIONS.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <Button
              variant="outline"
              size="sm"
              onClick={handleTrending}
              disabled={!isConfigured || trendingLoading}
              className="w-full font-mono text-xs"
              data-testid="button-trending"
            >
              {trendingLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <TrendingUp className="w-3.5 h-3.5 mr-1" />}
              Trending
            </Button>
          </div>
        </div>

        <div className="flex gap-2">
          <input
            type="text"
            value={tokenAddress}
            onChange={(e) => setTokenAddress(e.target.value)}
            placeholder="Token contract address"
            className="flex-1 bg-muted border rounded-md px-3 py-2 font-mono text-xs"
            data-testid="input-market-token"
          />
          <Button
            onClick={handleLookup}
            disabled={!isConfigured || !tokenAddress || loading}
            size="sm"
            className="font-mono text-xs"
            data-testid="button-lookup-token"
          >
            {loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : "Lookup"}
          </Button>
        </div>

        {error && (
          <div className="bg-destructive/10 border border-destructive/30 rounded-md p-3">
            <p className="font-mono text-xs text-destructive">{error}</p>
          </div>
        )}

        {tokenData && tokenData.data && (
          <div className="bg-muted/50 rounded-lg p-4 space-y-2" data-testid="token-data-result">
            <h3 className="font-mono text-sm font-bold">{tokenData.data[0]?.tokenSymbol || "Token"}</h3>
            {tokenData.data[0]?.price && (
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-muted-foreground">Price</span>
                <span className="font-mono text-sm">${tokenData.data[0].price}</span>
              </div>
            )}
            {tokenData.data[0]?.marketCap && (
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-muted-foreground">Market Cap</span>
                <span className="font-mono text-xs">${Number(tokenData.data[0].marketCap).toLocaleString()}</span>
              </div>
            )}
            {tokenData.data[0]?.volume24h && (
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-muted-foreground">24h Volume</span>
                <span className="font-mono text-xs">${Number(tokenData.data[0].volume24h).toLocaleString()}</span>
              </div>
            )}
          </div>
        )}

        {trendingData && trendingData.data && (
          <div className="space-y-2" data-testid="trending-result">
            <h3 className="font-mono text-xs font-bold text-muted-foreground">Trending Tokens</h3>
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {(trendingData.data || []).slice(0, 10).map((t: any, i: number) => (
                <div key={i} className="flex items-center justify-between bg-muted/50 rounded-md px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] text-muted-foreground w-4">{i + 1}</span>
                    <span className="font-mono text-xs font-medium">{t.tokenSymbol || t.symbol || `Token ${i + 1}`}</span>
                  </div>
                  {t.price && <span className="font-mono text-xs">${Number(t.price).toFixed(6)}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function BridgePanel({ isConfigured, address }: { isConfigured: boolean; address: string | null }) {
  const [fromChain, setFromChain] = useState("56");
  const [toChain, setToChain] = useState("196");
  const [fromToken, setFromToken] = useState(NATIVE_TOKEN);
  const [toToken, setToToken] = useState(NATIVE_TOKEN);
  const [amount, setAmount] = useState("");
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [bridgeQuote, setBridgeQuote] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const handleBridgeQuote = async () => {
    if (!amount) return;
    setQuoteLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        fromChainId: fromChain,
        toChainId: toChain,
        fromToken,
        toToken,
        amount,
        slippage: "1",
      });
      const res = await fetch(`/api/okx/bridge/quote?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setBridgeQuote(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setQuoteLoading(false);
    }
  };

  const fromChainName = CHAIN_OPTIONS.find(c => c.id === fromChain)?.name || fromChain;
  const toChainName = CHAIN_OPTIONS.find(c => c.id === toChain)?.name || toChain;

  return (
    <div className="bg-card border rounded-lg p-6" data-testid="panel-bridge">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Layers className="w-5 h-5 text-blue-500" />
          <h2 className="font-mono text-lg font-bold">Cross-Chain Bridge</h2>
        </div>
        <Badge variant="outline" className="text-[10px]">18 Bridges</Badge>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Bridge assets between BNB Chain, XLayer, and 60+ chains. Aggregates 18 bridge protocols for best rates.
      </p>

      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="font-mono text-xs text-muted-foreground block mb-1">From Chain</label>
            <select
              value={fromChain}
              onChange={(e) => setFromChain(e.target.value)}
              className="w-full bg-muted border rounded-md px-3 py-2 font-mono text-sm"
              data-testid="select-bridge-from-chain"
            >
              {CHAIN_OPTIONS.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="font-mono text-xs text-muted-foreground block mb-1">To Chain</label>
            <select
              value={toChain}
              onChange={(e) => setToChain(e.target.value)}
              className="w-full bg-muted border rounded-md px-3 py-2 font-mono text-sm"
              data-testid="select-bridge-to-chain"
            >
              {CHAIN_OPTIONS.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="bg-muted/50 rounded-lg p-4 space-y-3">
          <div>
            <label className="font-mono text-[10px] text-muted-foreground block mb-1">From Token</label>
            <input
              type="text"
              value={fromToken}
              onChange={(e) => setFromToken(e.target.value)}
              placeholder="Token address"
              className="w-full bg-background border rounded-md px-3 py-2 font-mono text-xs"
              data-testid="input-bridge-from-token"
            />
          </div>
          <div className="flex justify-center">
            <div className="w-8 h-8 rounded-full bg-background border flex items-center justify-center">
              <Layers className="w-4 h-4 text-blue-500" />
            </div>
          </div>
          <div>
            <label className="font-mono text-[10px] text-muted-foreground block mb-1">To Token</label>
            <input
              type="text"
              value={toToken}
              onChange={(e) => setToToken(e.target.value)}
              placeholder="Token address"
              className="w-full bg-background border rounded-md px-3 py-2 font-mono text-xs"
              data-testid="input-bridge-to-token"
            />
          </div>
          <div>
            <label className="font-mono text-[10px] text-muted-foreground block mb-1">Amount (smallest unit)</label>
            <input
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 1000000000000000000"
              className="w-full bg-background border rounded-md px-3 py-2 font-mono text-xs"
              data-testid="input-bridge-amount"
            />
          </div>
        </div>

        <Button
          onClick={handleBridgeQuote}
          disabled={!isConfigured || !amount || quoteLoading}
          className="w-full font-mono text-xs"
          data-testid="button-bridge-quote"
        >
          {quoteLoading ? (
            <><RefreshCw className="w-3.5 h-3.5 mr-2 animate-spin" /> Getting Bridge Quote...</>
          ) : (
            <><Layers className="w-3.5 h-3.5 mr-2" /> Quote {fromChainName} → {toChainName}</>
          )}
        </Button>

        {error && (
          <div className="bg-destructive/10 border border-destructive/30 rounded-md p-3">
            <p className="font-mono text-xs text-destructive">{error}</p>
          </div>
        )}

        {bridgeQuote && bridgeQuote.data && (
          <div className="bg-muted/50 rounded-lg p-4 space-y-2" data-testid="bridge-quote-result">
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs text-muted-foreground">Est. Receive</span>
              <span className="font-mono text-sm font-bold">{bridgeQuote.data[0]?.toTokenAmount || "—"}</span>
            </div>
            {bridgeQuote.data[0]?.estimatedTime && (
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-muted-foreground">Est. Time</span>
                <span className="font-mono text-xs">{bridgeQuote.data[0].estimatedTime}s</span>
              </div>
            )}
            {bridgeQuote.data[0]?.bridgeName && (
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-muted-foreground">Bridge</span>
                <Badge variant="secondary" className="text-[10px]">{bridgeQuote.data[0].bridgeName}</Badge>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function WalletPanel({ isConfigured, address, connected }: { isConfigured: boolean; address: string | null; connected: boolean }) {
  const [selectedChain, setSelectedChain] = useState("56");
  const [lookupAddress, setLookupAddress] = useState(address || "");
  const [balances, setBalances] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLookup = async () => {
    const addr = lookupAddress || address;
    if (!addr) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ address: addr, chainId: selectedChain });
      const res = await fetch(`/api/okx/wallet/balances?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setBalances(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-card border rounded-lg p-6" data-testid="panel-wallet">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Wallet className="w-5 h-5 text-orange-500" />
          <h2 className="font-mono text-lg font-bold">Wallet Intelligence</h2>
        </div>
        <Badge variant="outline" className="text-[10px]">Multi-chain</Badge>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Query token balances across any chain. Track wallet holdings and activity.
      </p>

      <div className="space-y-4">
        <div>
          <label className="font-mono text-xs text-muted-foreground block mb-1">Chain</label>
          <select
            value={selectedChain}
            onChange={(e) => setSelectedChain(e.target.value)}
            className="w-full bg-muted border rounded-md px-3 py-2 font-mono text-sm"
            data-testid="select-wallet-chain"
          >
            {CHAIN_OPTIONS.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        <div className="flex gap-2">
          <input
            type="text"
            value={lookupAddress}
            onChange={(e) => setLookupAddress(e.target.value)}
            placeholder={address || "Wallet address (0x...)"}
            className="flex-1 bg-muted border rounded-md px-3 py-2 font-mono text-xs"
            data-testid="input-wallet-address"
          />
          <Button
            onClick={handleLookup}
            disabled={!isConfigured || (!lookupAddress && !address) || loading}
            size="sm"
            className="font-mono text-xs"
            data-testid="button-lookup-balances"
          >
            {loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : "Lookup"}
          </Button>
        </div>

        {!connected && (
          <div className="bg-muted/50 rounded-md p-3 text-center">
            <p className="font-mono text-xs text-muted-foreground">Connect your wallet to auto-fill your address</p>
          </div>
        )}

        {error && (
          <div className="bg-destructive/10 border border-destructive/30 rounded-md p-3">
            <p className="font-mono text-xs text-destructive">{error}</p>
          </div>
        )}

        {balances && balances.data && (
          <div className="space-y-2" data-testid="wallet-balances-result">
            <h3 className="font-mono text-xs font-bold text-muted-foreground">Token Balances</h3>
            <div className="space-y-1 max-h-72 overflow-y-auto">
              {(balances.data || []).map((token: any, i: number) => (
                <div key={i} className="flex items-center justify-between bg-muted/50 rounded-md px-3 py-2">
                  <div>
                    <span className="font-mono text-xs font-medium">{token.tokenSymbol || token.symbol || "?"}</span>
                    {token.tokenName && (
                      <span className="font-mono text-[10px] text-muted-foreground ml-2">{token.tokenName}</span>
                    )}
                  </div>
                  <div className="text-right">
                    <span className="font-mono text-xs">{token.balance || token.holdingAmount || "0"}</span>
                    {token.tokenPrice && (
                      <span className="font-mono text-[10px] text-muted-foreground ml-2">
                        ${(Number(token.balance || token.holdingAmount || 0) * Number(token.tokenPrice)).toFixed(2)}
                      </span>
                    )}
                  </div>
                </div>
              ))}
              {(!balances.data || balances.data.length === 0) && (
                <p className="font-mono text-xs text-muted-foreground text-center py-4">No tokens found</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function FeatureCard() {
  const features = [
    { icon: ArrowLeftRight, title: "DEX Aggregator", desc: "500+ DEXs, best routing, 60+ chains", color: "text-violet-500" },
    { icon: BarChart3, title: "Market Data", desc: "Real-time prices, trending, holder data", color: "text-emerald-500" },
    { icon: Layers, title: "Cross-Chain Bridge", desc: "18 bridge aggregators, seamless transfers", color: "text-blue-500" },
    { icon: Wallet, title: "Wallet API", desc: "Multi-chain balances and tx history", color: "text-orange-500" },
    { icon: Shield, title: "AI Agent Ready", desc: "MCP Server + AI Skills for agent trading", color: "text-pink-500" },
    { icon: Zap, title: "Sub-100ms", desc: "Ultra-fast API response times", color: "text-yellow-500" },
  ];

  return (
    <div className="bg-card border rounded-lg p-4">
      <h3 className="font-mono text-sm font-bold mb-3">OnchainOS Features</h3>
      <div className="space-y-2">
        {features.map((f, i) => (
          <div key={i} className="flex items-start gap-3 p-2 rounded-md hover:bg-muted/50 transition-colors">
            <f.icon className={`w-4 h-4 mt-0.5 ${f.color}`} />
            <div>
              <p className="font-mono text-xs font-medium">{f.title}</p>
              <p className="font-mono text-[10px] text-muted-foreground">{f.desc}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 pt-3 border-t">
        <a
          href="https://web3.okx.com/onchainos"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 font-mono text-xs text-violet-400 hover:text-violet-300 transition-colors"
          data-testid="link-okx-docs"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          OKX OnchainOS Docs
        </a>
      </div>
    </div>
  );
}

function ChainStatusCard({ chains }: { chains?: Record<string, string> }) {
  const chainList = chains ? Object.entries(chains) : [];

  return (
    <div className="bg-card border rounded-lg p-4">
      <h3 className="font-mono text-sm font-bold mb-3">Supported Chains</h3>
      {chainList.length > 0 ? (
        <div className="space-y-1">
          {chainList.map(([id, name]) => (
            <div key={id} className="flex items-center justify-between py-1">
              <span className="font-mono text-xs">{name}</span>
              <Badge variant="secondary" className="text-[10px]">ID: {id}</Badge>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-1">
          {CHAIN_OPTIONS.map((c) => (
            <div key={c.id} className="flex items-center justify-between py-1">
              <span className="font-mono text-xs">{c.name}</span>
              <Badge variant="secondary" className="text-[10px]">{c.symbol}</Badge>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
