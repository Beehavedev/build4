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

interface BridgeToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

const BRIDGE_TOKENS: Record<string, BridgeToken[]> = {
  "1": [
    { address: NATIVE_TOKEN, symbol: "ETH", name: "Ethereum", decimals: 18 },
    { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", name: "Tether USD", decimals: 6 },
    { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", name: "USD Coin", decimals: 6 },
    { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", symbol: "DAI", name: "Dai Stablecoin", decimals: 18 },
    { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", symbol: "WBTC", name: "Wrapped Bitcoin", decimals: 8 },
  ],
  "56": [
    { address: NATIVE_TOKEN, symbol: "BNB", name: "BNB", decimals: 18 },
    { address: "0x55d398326f99059fF775485246999027B3197955", symbol: "USDT", name: "Tether USD", decimals: 18 },
    { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", symbol: "USDC", name: "USD Coin", decimals: 18 },
    { address: "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3", symbol: "DAI", name: "Dai Stablecoin", decimals: 18 },
    { address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", symbol: "ETH", name: "Ethereum", decimals: 18 },
    { address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", symbol: "BTCB", name: "Bitcoin BEP20", decimals: 18 },
    { address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", symbol: "WBNB", name: "Wrapped BNB", decimals: 18 },
  ],
  "196": [
    { address: NATIVE_TOKEN, symbol: "OKB", name: "OKB", decimals: 18 },
    { address: "0x1E4a5963aBFD975d8c9021ce480b42188849D41d", symbol: "USDT", name: "Tether USD", decimals: 6 },
    { address: "0x74b7F16337b8972027F6196A17a631aC6dE26d22", symbol: "USDC", name: "USD Coin", decimals: 6 },
    { address: "0x5A77f1443D16ee5761d310e38b62f77f726bC71c", symbol: "WETH", name: "Wrapped ETH", decimals: 18 },
  ],
  "137": [
    { address: NATIVE_TOKEN, symbol: "POL", name: "Polygon", decimals: 18 },
    { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", symbol: "USDT", name: "Tether USD", decimals: 6 },
    { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", symbol: "USDC", name: "USD Coin", decimals: 6 },
    { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", symbol: "WETH", name: "Wrapped ETH", decimals: 18 },
  ],
  "42161": [
    { address: NATIVE_TOKEN, symbol: "ETH", name: "Ethereum", decimals: 18 },
    { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", symbol: "USDT", name: "Tether USD", decimals: 6 },
    { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", symbol: "USDC", name: "USD Coin", decimals: 6 },
    { address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", symbol: "WBTC", name: "Wrapped Bitcoin", decimals: 8 },
  ],
  "8453": [
    { address: NATIVE_TOKEN, symbol: "ETH", name: "Ethereum", decimals: 18 },
    { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", name: "USD Coin", decimals: 6 },
    { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", symbol: "DAI", name: "Dai Stablecoin", decimals: 18 },
  ],
  "43114": [
    { address: NATIVE_TOKEN, symbol: "AVAX", name: "Avalanche", decimals: 18 },
    { address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", symbol: "USDT", name: "Tether USD", decimals: 6 },
    { address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", symbol: "USDC", name: "USD Coin", decimals: 6 },
  ],
  "10": [
    { address: NATIVE_TOKEN, symbol: "ETH", name: "Ethereum", decimals: 18 },
    { address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", symbol: "USDT", name: "Tether USD", decimals: 6 },
    { address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", symbol: "USDC", name: "USD Coin", decimals: 6 },
  ],
};

function getTokensForChain(chainId: string): BridgeToken[] {
  return BRIDGE_TOKENS[chainId] || [{ address: NATIVE_TOKEN, symbol: "Native", name: "Native Token", decimals: 18 }];
}

type Tab = "swap" | "market" | "bridge" | "wallet";

export default function OnchainOS() {
  const { connected, address, chainId } = useWallet();
  const [activeTab, setActiveTab] = useState<Tab>("swap");

  const { data: okxStatus } = useQuery<{
    active: boolean;
    supportedChains: Record<string, string>;
    features: Record<string, boolean>;
  }>({
    queryKey: ["/api/okx/status"],
  });

  const isActive = okxStatus?.active ?? false;

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
            {activeTab === "swap" && <SwapPanel isActive={isActive} address={address} chainId={chainId} />}
            {activeTab === "market" && <MarketPanel isActive={isActive} />}
            {activeTab === "bridge" && <BridgePanel isActive={isActive} address={address} />}
            {activeTab === "wallet" && <WalletPanel isActive={isActive} address={address} connected={connected} />}
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

function SwapPanel({ isActive, address, chainId }: { isActive: boolean; address: string | null; chainId: number | null }) {
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
          disabled={!isActive || !amount || !toToken || quoteLoading}
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

function MarketPanel({ isActive }: { isActive: boolean }) {
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
              disabled={!isActive || trendingLoading}
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
            disabled={!isActive || !tokenAddress || loading}
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

function BridgePanel({ isActive, address }: { isActive: boolean; address: string | null }) {
  const [fromChain, setFromChain] = useState("56");
  const [toChain, setToChain] = useState("196");
  const [fromToken, setFromToken] = useState(NATIVE_TOKEN);
  const [toToken, setToToken] = useState(NATIVE_TOKEN);
  const [amount, setAmount] = useState("");
  const [receiverAddress, setReceiverAddress] = useState(address || "");
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [bridgeQuote, setBridgeQuote] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const fromTokens = getTokensForChain(fromChain);
  const toTokens = getTokensForChain(toChain);

  const selectedFromToken = fromTokens.find(t => t.address === fromToken) || fromTokens[0];
  const selectedToToken = toTokens.find(t => t.address === toToken) || toTokens[0];

  const handleFromChainChange = (newChain: string) => {
    setFromChain(newChain);
    const tokens = getTokensForChain(newChain);
    setFromToken(tokens[0].address);
    setBridgeQuote(null);
  };

  const handleToChainChange = (newChain: string) => {
    setToChain(newChain);
    const tokens = getTokensForChain(newChain);
    setToToken(tokens[0].address);
    setBridgeQuote(null);
  };

  const swapChains = () => {
    const prevFrom = fromChain;
    const prevTo = toChain;
    setFromChain(prevTo);
    setToChain(prevFrom);
    const newFromTokens = getTokensForChain(prevTo);
    const newToTokens = getTokensForChain(prevFrom);
    setFromToken(newFromTokens[0].address);
    setToToken(newToTokens[0].address);
    setBridgeQuote(null);
  };

  const parseHumanAmount = (humanAmount: string, decimals: number): string => {
    if (!humanAmount || isNaN(Number(humanAmount))) return "0";
    const parts = humanAmount.split(".");
    const whole = parts[0] || "0";
    let frac = parts[1] || "";
    frac = frac.padEnd(decimals, "0").slice(0, decimals);
    const raw = whole + frac;
    return raw.replace(/^0+/, "") || "0";
  };

  const handleBridgeQuote = async () => {
    if (!amount) return;
    setQuoteLoading(true);
    setError(null);
    try {
      const rawAmount = parseHumanAmount(amount, selectedFromToken.decimals);
      const params = new URLSearchParams({
        fromChainId: fromChain,
        toChainId: toChain,
        fromToken,
        toToken,
        amount: rawAmount,
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

  const fromChainInfo = CHAIN_OPTIONS.find(c => c.id === fromChain);
  const toChainInfo = CHAIN_OPTIONS.find(c => c.id === toChain);

  const formatReceiveAmount = (raw: string, decimals: number): string => {
    if (!raw) return "—";
    const num = Number(raw) / Math.pow(10, decimals);
    if (num < 0.000001) return raw;
    return num.toLocaleString(undefined, { maximumFractionDigits: 6 });
  };

  return (
    <div className="bg-card border rounded-lg p-6" data-testid="panel-bridge">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Layers className="w-5 h-5 text-blue-500" />
          <h2 className="font-mono text-lg font-bold">Cross-Chain Bridge</h2>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px]">0.5% fee</Badge>
          <Badge variant="outline" className="text-[10px]">18 Bridges</Badge>
        </div>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Bridge assets between BNB Chain, XLayer, and 60+ chains. Aggregates 18 bridge protocols for best rates.
      </p>

      <div className="space-y-4">
        <div className="bg-muted/50 rounded-lg p-4 space-y-1">
          <label className="font-mono text-[10px] text-muted-foreground">From</label>
          <div className="flex gap-2">
            <select
              value={fromChain}
              onChange={(e) => handleFromChainChange(e.target.value)}
              className="w-1/2 bg-background border rounded-md px-3 py-2.5 font-mono text-sm"
              data-testid="select-bridge-from-chain"
            >
              {CHAIN_OPTIONS.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <select
              value={fromToken}
              onChange={(e) => { setFromToken(e.target.value); setBridgeQuote(null); }}
              className="w-1/2 bg-background border rounded-md px-3 py-2.5 font-mono text-sm"
              data-testid="select-bridge-from-token"
            >
              {fromTokens.map((t) => (
                <option key={t.address} value={t.address}>{t.symbol} — {t.name}</option>
              ))}
            </select>
          </div>
          <div className="pt-2">
            <input
              type="text"
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setBridgeQuote(null); }}
              placeholder={`Amount in ${selectedFromToken.symbol}`}
              className="w-full bg-background border rounded-md px-3 py-2.5 font-mono text-lg"
              data-testid="input-bridge-amount"
            />
          </div>
        </div>

        <div className="flex justify-center">
          <button
            onClick={swapChains}
            className="w-9 h-9 rounded-full bg-background border-2 flex items-center justify-center hover:bg-muted transition-colors"
            data-testid="button-swap-chains"
          >
            <ArrowDown className="w-4 h-4 text-blue-500" />
          </button>
        </div>

        <div className="bg-muted/50 rounded-lg p-4 space-y-1">
          <label className="font-mono text-[10px] text-muted-foreground">To</label>
          <div className="flex gap-2">
            <select
              value={toChain}
              onChange={(e) => handleToChainChange(e.target.value)}
              className="w-1/2 bg-background border rounded-md px-3 py-2.5 font-mono text-sm"
              data-testid="select-bridge-to-chain"
            >
              {CHAIN_OPTIONS.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <select
              value={toToken}
              onChange={(e) => { setToToken(e.target.value); setBridgeQuote(null); }}
              className="w-1/2 bg-background border rounded-md px-3 py-2.5 font-mono text-sm"
              data-testid="select-bridge-to-token"
            >
              {toTokens.map((t) => (
                <option key={t.address} value={t.address}>{t.symbol} — {t.name}</option>
              ))}
            </select>
          </div>
          {bridgeQuote && bridgeQuote.data && bridgeQuote.data[0] && (
            <div className="pt-2 px-1">
              <span className="font-mono text-lg text-foreground" data-testid="text-bridge-receive">
                {formatReceiveAmount(bridgeQuote.data[0].toTokenAmount, selectedToToken.decimals)} {selectedToToken.symbol}
              </span>
            </div>
          )}
          <div className="pt-2">
            <label className="font-mono text-[10px] text-muted-foreground block mb-1">Receiving Wallet Address</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={receiverAddress}
                onChange={(e) => setReceiverAddress(e.target.value)}
                placeholder="0x... wallet address to receive tokens"
                className="w-full bg-background border rounded-md px-3 py-2.5 font-mono text-xs"
                data-testid="input-bridge-receiver"
              />
              {address && receiverAddress !== address && (
                <button
                  onClick={() => setReceiverAddress(address)}
                  className="shrink-0 px-3 py-2 bg-background border rounded-md font-mono text-[10px] text-muted-foreground hover:bg-muted transition-colors"
                  data-testid="button-use-connected-wallet"
                >
                  Use Mine
                </button>
              )}
            </div>
            {receiverAddress && !/^0x[a-fA-F0-9]{40}$/.test(receiverAddress) && (
              <p className="font-mono text-[10px] text-destructive mt-1">Invalid wallet address</p>
            )}
          </div>
        </div>

        <Button
          onClick={handleBridgeQuote}
          disabled={!isActive || !amount || !receiverAddress || !/^0x[a-fA-F0-9]{40}$/.test(receiverAddress) || quoteLoading}
          className="w-full font-mono text-sm h-11"
          data-testid="button-bridge-quote"
        >
          {quoteLoading ? (
            <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Getting Quote...</>
          ) : (
            <><Layers className="w-4 h-4 mr-2" /> Bridge {fromChainInfo?.name} → {toChainInfo?.name}</>
          )}
        </Button>

        {error && (
          <div className="bg-destructive/10 border border-destructive/30 rounded-md p-3">
            <p className="font-mono text-xs text-destructive">{error}</p>
          </div>
        )}

        {bridgeQuote && bridgeQuote.data && bridgeQuote.data[0] && (
          <div className="bg-muted/50 rounded-lg p-4 space-y-2" data-testid="bridge-quote-result">
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs text-muted-foreground">You Send</span>
              <span className="font-mono text-sm">{amount} {selectedFromToken.symbol}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs text-muted-foreground">You Receive</span>
              <span className="font-mono text-sm font-bold text-emerald-500">
                {formatReceiveAmount(bridgeQuote.data[0].toTokenAmount, selectedToToken.decimals)} {selectedToToken.symbol}
              </span>
            </div>
            {bridgeQuote.data[0]?.estimatedTime && (
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-muted-foreground">Est. Time</span>
                <span className="font-mono text-xs">
                  {Number(bridgeQuote.data[0].estimatedTime) < 60
                    ? `${bridgeQuote.data[0].estimatedTime}s`
                    : `~${Math.ceil(Number(bridgeQuote.data[0].estimatedTime) / 60)} min`}
                </span>
              </div>
            )}
            {bridgeQuote.data[0]?.bridgeName && (
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-muted-foreground">Via</span>
                <Badge variant="secondary" className="text-[10px]">{bridgeQuote.data[0].bridgeName}</Badge>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs text-muted-foreground">Route</span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {fromChainInfo?.name} ({selectedFromToken.symbol}) → {toChainInfo?.name} ({selectedToToken.symbol})
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs text-muted-foreground">Deliver To</span>
              <span className="font-mono text-[10px] text-muted-foreground" data-testid="text-bridge-deliver-to">
                {receiverAddress.slice(0, 6)}...{receiverAddress.slice(-4)}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function WalletPanel({ isActive, address, connected }: { isActive: boolean; address: string | null; connected: boolean }) {
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
            disabled={!isActive || (!lookupAddress && !address) || loading}
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
