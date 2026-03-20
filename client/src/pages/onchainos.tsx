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
  Activity,
  Flame,
  Fuel,
  Search,
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
  { id: "324", name: "zkSync Era", symbol: "ETH" },
  { id: "59144", name: "Linea", symbol: "ETH" },
  { id: "534352", name: "Scroll", symbol: "ETH" },
  { id: "250", name: "Fantom", symbol: "FTM" },
  { id: "1101", name: "Polygon zkEVM", symbol: "ETH" },
  { id: "169", name: "Manta Pacific", symbol: "ETH" },
  { id: "5000", name: "Mantle", symbol: "MNT" },
  { id: "81457", name: "Blast", symbol: "ETH" },
  { id: "34443", name: "Mode", symbol: "ETH" },
  { id: "7777777", name: "Zora", symbol: "ETH" },
  { id: "100", name: "Gnosis", symbol: "xDAI" },
  { id: "1284", name: "Moonbeam", symbol: "GLMR" },
  { id: "1285", name: "Moonriver", symbol: "MOVR" },
  { id: "42220", name: "Celo", symbol: "CELO" },
  { id: "1088", name: "Metis", symbol: "METIS" },
  { id: "25", name: "Cronos", symbol: "CRO" },
  { id: "288", name: "Boba Network", symbol: "ETH" },
  { id: "1313161554", name: "Aurora", symbol: "ETH" },
  { id: "66", name: "OKT Chain", symbol: "OKT" },
  { id: "128", name: "HECO", symbol: "HT" },
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
  "324": [
    { address: NATIVE_TOKEN, symbol: "ETH", name: "Ethereum", decimals: 18 },
    { address: "0x493257fD37EDB34451f62EDf8D2a0C418852bA4C", symbol: "USDT", name: "Tether USD", decimals: 6 },
    { address: "0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4", symbol: "USDC", name: "USD Coin", decimals: 6 },
  ],
  "59144": [
    { address: NATIVE_TOKEN, symbol: "ETH", name: "Ethereum", decimals: 18 },
    { address: "0xA219439258ca9da29E9Cc4cE5596924745e12B93", symbol: "USDT", name: "Tether USD", decimals: 6 },
    { address: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff", symbol: "USDC", name: "USD Coin", decimals: 6 },
  ],
  "534352": [
    { address: NATIVE_TOKEN, symbol: "ETH", name: "Ethereum", decimals: 18 },
    { address: "0xf55BEC9cafDbE8730f096Aa55dad6D22d44099Df", symbol: "USDT", name: "Tether USD", decimals: 6 },
    { address: "0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4", symbol: "USDC", name: "USD Coin", decimals: 6 },
  ],
  "250": [
    { address: NATIVE_TOKEN, symbol: "FTM", name: "Fantom", decimals: 18 },
    { address: "0x049d68029688eAbF473097a2fC38ef61633A3C7A", symbol: "fUSDT", name: "Frapped USDT", decimals: 6 },
    { address: "0x04068DA6C83AFCFA0e13ba15A6696662335D5B75", symbol: "USDC", name: "USD Coin", decimals: 6 },
  ],
  "1101": [
    { address: NATIVE_TOKEN, symbol: "ETH", name: "Ethereum", decimals: 18 },
    { address: "0x1E4a5963aBFD975d8c9021ce480b42188849D41d", symbol: "USDT", name: "Tether USD", decimals: 6 },
    { address: "0xA8CE8aee21bC2A48a5EF670afCc9274C7bbbC035", symbol: "USDC", name: "USD Coin", decimals: 6 },
  ],
  "169": [
    { address: NATIVE_TOKEN, symbol: "ETH", name: "Ethereum", decimals: 18 },
    { address: "0xf417F5A458eC102B90352F697D6e2Ac3A3d2851f", symbol: "USDT", name: "Tether USD", decimals: 6 },
    { address: "0xb73603C5d87fA094B7314C74ACE2e64D165016fb", symbol: "USDC", name: "USD Coin", decimals: 6 },
  ],
  "5000": [
    { address: NATIVE_TOKEN, symbol: "MNT", name: "Mantle", decimals: 18 },
    { address: "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE", symbol: "USDT", name: "Tether USD", decimals: 6 },
    { address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9", symbol: "USDC", name: "USD Coin", decimals: 6 },
  ],
  "81457": [
    { address: NATIVE_TOKEN, symbol: "ETH", name: "Ethereum", decimals: 18 },
    { address: "0x4300000000000000000000000000000000000003", symbol: "USDB", name: "USDB", decimals: 18 },
  ],
  "34443": [
    { address: NATIVE_TOKEN, symbol: "ETH", name: "Ethereum", decimals: 18 },
    { address: "0xd988097fb8612cc24eeC14542bC03424c656005f", symbol: "USDC", name: "USD Coin", decimals: 6 },
  ],
  "7777777": [
    { address: NATIVE_TOKEN, symbol: "ETH", name: "Ethereum", decimals: 18 },
  ],
  "100": [
    { address: NATIVE_TOKEN, symbol: "xDAI", name: "xDAI", decimals: 18 },
    { address: "0x4ECaBa5870353805a9F068101A40E0f32ed605C6", symbol: "USDT", name: "Tether USD", decimals: 6 },
    { address: "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83", symbol: "USDC", name: "USD Coin", decimals: 6 },
  ],
  "1284": [
    { address: NATIVE_TOKEN, symbol: "GLMR", name: "Moonbeam", decimals: 18 },
    { address: "0xeFAeeE334F0Fd1712f9a8cc375f427D9Cdd40d73", symbol: "USDT", name: "Tether USD", decimals: 6 },
    { address: "0x931715FEE2d06333043d11F658C8CE934aC61D0c", symbol: "USDC", name: "USD Coin", decimals: 6 },
  ],
  "1285": [
    { address: NATIVE_TOKEN, symbol: "MOVR", name: "Moonriver", decimals: 18 },
    { address: "0xB44a9B6905aF7c801311e8F4E76932ee959c663C", symbol: "USDT", name: "Tether USD", decimals: 6 },
    { address: "0xE3F5a90F9cb311505cd691a46596599aA1A0AD7D", symbol: "USDC", name: "USD Coin", decimals: 6 },
  ],
  "42220": [
    { address: NATIVE_TOKEN, symbol: "CELO", name: "Celo", decimals: 18 },
    { address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", symbol: "USDT", name: "Tether USD", decimals: 6 },
    { address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", symbol: "USDC", name: "USD Coin", decimals: 6 },
  ],
  "1088": [
    { address: NATIVE_TOKEN, symbol: "METIS", name: "Metis", decimals: 18 },
    { address: "0xbB06DCA3AE6887fAbF931640f67cab3e3a16F4dC", symbol: "USDT", name: "Tether USD", decimals: 6 },
    { address: "0xEA32A96608495e54156Ae48931A7c20f0dcc1a21", symbol: "USDC", name: "USD Coin", decimals: 6 },
  ],
  "25": [
    { address: NATIVE_TOKEN, symbol: "CRO", name: "Cronos", decimals: 18 },
    { address: "0x66e428c3f67a68878562e79A0234c1F83c208770", symbol: "USDT", name: "Tether USD", decimals: 6 },
    { address: "0xc21223249CA28397B4B6541dfFaEcC539BfF0c59", symbol: "USDC", name: "USD Coin", decimals: 6 },
  ],
  "288": [
    { address: NATIVE_TOKEN, symbol: "ETH", name: "Ethereum", decimals: 18 },
    { address: "0x5DE1677344D3Cb0D7D465c10b72A8f60699C062d", symbol: "USDT", name: "Tether USD", decimals: 6 },
    { address: "0x66a2A913e447d6b4BF33EFbec43aAeF87890FBbc", symbol: "USDC", name: "USD Coin", decimals: 6 },
  ],
  "1313161554": [
    { address: NATIVE_TOKEN, symbol: "ETH", name: "Ethereum", decimals: 18 },
    { address: "0x4988a896b1227218e4A686fdE5EabdcAbd91571f", symbol: "USDT", name: "Tether USD", decimals: 6 },
    { address: "0xB12BFcA5A55806AaF64E99521918A4bf0fC40802", symbol: "USDC", name: "USD Coin", decimals: 6 },
  ],
  "66": [
    { address: NATIVE_TOKEN, symbol: "OKT", name: "OKT Chain", decimals: 18 },
    { address: "0x382bB369d343125BfB2117af9c149795C6C65C50", symbol: "USDT", name: "Tether USD", decimals: 18 },
    { address: "0xc946DAf81b08146B1C7A8Da2A851Ddf2B3EAaf85", symbol: "USDC", name: "USD Coin", decimals: 18 },
  ],
  "128": [
    { address: NATIVE_TOKEN, symbol: "HT", name: "Huobi Token", decimals: 18 },
    { address: "0xa71EdC38d189767582C38A3145b5873052c3e47a", symbol: "USDT", name: "Tether USD", decimals: 18 },
    { address: "0x9362Bbef4B8313A8Aa9f0c9808B80577Aa26B73B", symbol: "USDC", name: "USD Coin", decimals: 18 },
  ],
};

function getTokensForChain(chainId: string): BridgeToken[] {
  return BRIDGE_TOKENS[chainId] || [{ address: NATIVE_TOKEN, symbol: "Native", name: "Native Token", decimals: 18 }];
}

type Tab = "swap" | "market" | "bridge" | "wallet" | "signals" | "security" | "trending" | "gas";

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
            Multi-chain DEX aggregation, smart money signals, security scanning, meme token research, wallet intelligence, and gas-free payments — powered by OKX OnchainOS v2.1.0 across 60+ chains.
          </p>
        </div>

        <div className="flex items-center gap-1 mb-6 bg-muted/50 rounded-lg p-1 overflow-x-auto">
          {[
            { id: "swap" as Tab, icon: ArrowLeftRight, label: "DEX Swap" },
            { id: "market" as Tab, icon: BarChart3, label: "Market" },
            { id: "signals" as Tab, icon: Activity, label: "Signals" },
            { id: "security" as Tab, icon: Shield, label: "Security" },
            { id: "trending" as Tab, icon: Flame, label: "Trending" },
            { id: "gas" as Tab, icon: Fuel, label: "Gas" },
            { id: "bridge" as Tab, icon: Layers, label: "Bridge" },
            { id: "wallet" as Tab, icon: Wallet, label: "Wallet" },
          ].map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`flex items-center gap-2 px-3 py-2 rounded-md font-mono text-xs transition-colors whitespace-nowrap ${
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
            {activeTab === "signals" && <SignalsPanel isActive={isActive} />}
            {activeTab === "security" && <SecurityPanel isActive={isActive} />}
            {activeTab === "trending" && <TrendingPanel isActive={isActive} />}
            {activeTab === "gas" && <GasPanel isActive={isActive} />}
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
  const initTokens = getTokensForChain(chainId?.toString() || "56");
  const [toToken, setToToken] = useState(initTokens.length > 1 ? initTokens[1].address : "");
  const [customToToken, setCustomToToken] = useState("");
  const [useCustomTo, setUseCustomTo] = useState(false);
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState("0.5");
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quote, setQuote] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const tokens = getTokensForChain(selectedChain);
  const fromTokenInfo = tokens.find(t => t.address === fromToken) || tokens[0];
  const toTokenInfo = tokens.find(t => t.address === toToken);
  const resolvedToToken = useCustomTo ? customToToken : toToken;

  const isValidAmount = (v: string): boolean => /^\d+\.?\d*$/.test(v) && Number(v) > 0;
  const isValidAddress = (v: string): boolean => /^0x[a-fA-F0-9]{40}$/.test(v);

  const toWei = (value: string, decimals: number): string => {
    if (!value || !isValidAmount(value)) return "0";
    const parts = value.split(".");
    const whole = parts[0] || "0";
    const frac = (parts[1] || "").padEnd(decimals, "0").slice(0, decimals);
    const raw = whole + frac;
    return raw.replace(/^0+/, "") || "0";
  };

  const fromWei = (value: string, decimals: number): string => {
    if (!value || value === "0") return "0";
    const padded = value.padStart(decimals + 1, "0");
    const whole = padded.slice(0, padded.length - decimals) || "0";
    const frac = padded.slice(padded.length - decimals);
    const trimmed = frac.replace(/0+$/, "");
    return trimmed ? `${whole}.${trimmed}` : whole;
  };

  const handleChainChange = (newChain: string) => {
    setSelectedChain(newChain);
    const newTokens = getTokensForChain(newChain);
    setFromToken(newTokens[0]?.address || NATIVE_TOKEN);
    setToToken(newTokens.length > 1 ? newTokens[1].address : "");
    setQuote(null);
    setError(null);
  };

  const handleSwapDirection = () => {
    if (useCustomTo || !toToken || toToken === fromToken) return;
    const prev = fromToken;
    setFromToken(toToken);
    setToToken(prev);
    setQuote(null);
  };

  const handleGetQuote = async () => {
    if (!amount || !resolvedToToken) return;
    if (!isValidAmount(amount)) { setError("Enter a valid number greater than 0"); return; }
    if (useCustomTo && !isValidAddress(customToToken)) { setError("Enter a valid token address (0x + 40 hex characters)"); return; }
    if (fromToken === resolvedToToken) { setError("From and To tokens must be different"); return; }
    setQuoteLoading(true);
    setError(null);
    try {
      const weiAmount = toWei(amount, fromTokenInfo.decimals);
      if (weiAmount === "0") throw new Error("Amount must be greater than 0");
      const params = new URLSearchParams({
        chainId: selectedChain,
        fromToken,
        toToken: resolvedToToken,
        amount: weiAmount,
        slippage,
      });
      const res = await fetch(`/api/okx/dex/quote?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to get quote");
      setQuote(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setQuoteLoading(false);
    }
  };

  const quoteData = quote?.data?.[0];
  const toDecimals = toTokenInfo?.decimals || (quoteData?.toToken?.decimals ? Number(quoteData.toToken.decimals) : 18);
  const toSymbol = toTokenInfo?.symbol || quoteData?.toToken?.tokenSymbol || "Token";

  return (
    <div className="bg-card border rounded-lg p-6" data-testid="panel-swap">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="w-5 h-5 text-violet-500" />
          <h2 className="font-mono text-lg font-bold">DEX Aggregator</h2>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px]">500+ DEXs</Badge>
          <div className="flex items-center gap-1">
            <span className="font-mono text-[10px] text-muted-foreground">Slippage:</span>
            {["0.1", "0.5", "1.0"].map(s => (
              <button
                key={s}
                onClick={() => setSlippage(s)}
                className={`px-1.5 py-0.5 rounded font-mono text-[10px] transition-colors ${slippage === s ? "bg-violet-500/20 text-violet-500 border border-violet-500/30" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}
                data-testid={`button-slippage-${s}`}
              >
                {s}%
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <label className="font-mono text-[10px] text-muted-foreground block mb-1">Network</label>
          <select
            value={selectedChain}
            onChange={(e) => handleChainChange(e.target.value)}
            className="w-full bg-muted border rounded-md px-3 py-2.5 font-mono text-sm"
            data-testid="select-swap-chain"
          >
            {CHAIN_OPTIONS.map((c) => (
              <option key={c.id} value={c.id}>{c.name} ({c.symbol})</option>
            ))}
          </select>
        </div>

        <div className="bg-muted/50 rounded-lg p-4">
          <label className="font-mono text-[10px] text-muted-foreground block mb-2">You Pay</label>
          <div className="flex gap-3 items-center">
            <select
              value={fromToken}
              onChange={(e) => { setFromToken(e.target.value); setQuote(null); }}
              className="w-[140px] bg-background border rounded-md px-3 py-2.5 font-mono text-sm font-medium"
              data-testid="select-from-token"
            >
              {tokens.map((t) => (
                <option key={t.address} value={t.address}>{t.symbol}</option>
              ))}
            </select>
            <input
              type="text"
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setQuote(null); }}
              placeholder="0.00"
              className="flex-1 bg-background border rounded-md px-3 py-2.5 font-mono text-lg text-right"
              data-testid="input-swap-amount"
            />
          </div>
          <p className="font-mono text-[10px] text-muted-foreground mt-1.5">{fromTokenInfo.name}</p>
        </div>

        <div className="flex justify-center -my-1">
          <button
            onClick={handleSwapDirection}
            disabled={useCustomTo}
            className="w-9 h-9 rounded-full bg-background border-2 flex items-center justify-center hover:bg-muted transition-colors disabled:opacity-30"
            data-testid="button-swap-direction"
          >
            <ArrowDown className="w-4 h-4 text-violet-500" />
          </button>
        </div>

        <div className="bg-muted/50 rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <label className="font-mono text-[10px] text-muted-foreground">You Receive</label>
            <button
              onClick={() => { setUseCustomTo(!useCustomTo); setQuote(null); }}
              className="font-mono text-[10px] text-violet-500 hover:text-violet-400 transition-colors"
              data-testid="button-toggle-custom-token"
            >
              {useCustomTo ? "← Pick from list" : "Custom address →"}
            </button>
          </div>
          {useCustomTo ? (
            <input
              type="text"
              value={customToToken}
              onChange={(e) => { setCustomToToken(e.target.value); setQuote(null); }}
              placeholder="Paste token contract address (0x...)"
              className="w-full bg-background border rounded-md px-3 py-2.5 font-mono text-xs"
              data-testid="input-custom-to-token"
            />
          ) : (
            <select
              value={toToken}
              onChange={(e) => { setToToken(e.target.value); setQuote(null); }}
              className="w-full bg-background border rounded-md px-3 py-2.5 font-mono text-sm font-medium"
              data-testid="select-to-token"
            >
              <option value="">Select token...</option>
              {tokens.filter(t => t.address !== fromToken).map((t) => (
                <option key={t.address} value={t.address}>{t.symbol} — {t.name}</option>
              ))}
            </select>
          )}

          {quoteData && (
            <div className="mt-3 pt-3 border-t border-border/50">
              <span className="font-mono text-2xl font-bold" data-testid="text-swap-output">
                {fromWei(quoteData.toTokenAmount || "0", toDecimals)}
              </span>
              <span className="font-mono text-sm text-muted-foreground ml-2">{toSymbol}</span>
            </div>
          )}
        </div>

        <Button
          onClick={handleGetQuote}
          disabled={!isActive || !amount || !resolvedToToken || quoteLoading}
          className="w-full font-mono text-sm h-11"
          data-testid="button-get-quote"
        >
          {quoteLoading ? (
            <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Getting Best Quote...</>
          ) : (
            <><Zap className="w-4 h-4 mr-2" /> Get Quote</>
          )}
        </Button>

        {error && (
          <div className="bg-destructive/10 border border-destructive/30 rounded-md p-3">
            <p className="font-mono text-xs text-destructive">{error}</p>
          </div>
        )}

        {quoteData && (
          <div className="bg-muted/50 rounded-lg p-4 space-y-2" data-testid="swap-quote-result">
            <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider mb-2">Quote Details</div>
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs text-muted-foreground">Rate</span>
              <span className="font-mono text-xs font-medium" data-testid="text-swap-rate">
                1 {fromTokenInfo.symbol} ≈ {amount && Number(amount) > 0 ? (Number(fromWei(quoteData.toTokenAmount || "0", toDecimals)) / Number(amount)).toFixed(6) : "—"} {toSymbol}
              </span>
            </div>
            {quoteData.estimateGasFee && (
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-muted-foreground">Est. Gas</span>
                <span className="font-mono text-xs">{fromWei(quoteData.estimateGasFee, 18).slice(0, 10)} {CHAIN_OPTIONS.find(c => c.id === selectedChain)?.symbol}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs text-muted-foreground">Slippage</span>
              <span className="font-mono text-xs">{slippage}%</span>
            </div>
            {quoteData.dexRouterList && quoteData.dexRouterList.length > 0 && (
              <div className="pt-2 border-t border-border/50">
                <span className="font-mono text-[10px] text-muted-foreground">Route</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {quoteData.dexRouterList.map((r: any, i: number) => (
                    <Badge key={i} variant="secondary" className="text-[10px]">
                      {r.dexName || r.router || `DEX ${i + 1}`} {r.percent ? `(${r.percent}%)` : ""}
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

        {tokenData && tokenData.data && (() => {
          const td = Array.isArray(tokenData.data) ? tokenData.data[0] : tokenData.data;
          if (!td) return null;
          return (
            <div className="bg-muted/50 rounded-lg p-4 space-y-2" data-testid="token-data-result">
              <div className="flex items-center gap-2">
                {td.tokenLogoUrl && <img src={td.tokenLogoUrl} alt="" className="w-5 h-5 rounded-full" />}
                <h3 className="font-mono text-sm font-bold">{td.tokenSymbol || td.symbol || "Token"}</h3>
                {td.tokenName && <span className="font-mono text-[10px] text-muted-foreground">{td.tokenName}</span>}
              </div>
              {(td.price || td.tokenPrice) && (
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs text-muted-foreground">Price</span>
                  <span className="font-mono text-sm">${Number(td.price || td.tokenPrice) < 0.01 ? Number(td.price || td.tokenPrice).toPrecision(4) : Number(td.price || td.tokenPrice).toFixed(4)}</span>
                </div>
              )}
              {td.marketCap && (
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs text-muted-foreground">Market Cap</span>
                  <span className="font-mono text-xs">${Number(td.marketCap).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                </div>
              )}
              {td.liquidity && (
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs text-muted-foreground">Liquidity</span>
                  <span className="font-mono text-xs">${Number(td.liquidity).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                </div>
              )}
              {td.holders && (
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs text-muted-foreground">Holders</span>
                  <span className="font-mono text-xs">{Number(td.holders).toLocaleString()}</span>
                </div>
              )}
              {(td.volume24h || td.volume) && (
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs text-muted-foreground">24h Volume</span>
                  <span className="font-mono text-xs">${Number(td.volume24h || td.volume).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                </div>
              )}
            </div>
          );
        })()}

        {trendingData && trendingData.data && (
          <div className="space-y-2" data-testid="trending-result">
            <h3 className="font-mono text-xs font-bold text-muted-foreground">Trending Tokens</h3>
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {(trendingData.data || []).slice(0, 10).map((t: any, i: number) => (
                <div key={i} className="flex items-center justify-between bg-muted/50 rounded-md px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] text-muted-foreground w-4">{i + 1}</span>
                    {t.tokenLogoUrl && <img src={t.tokenLogoUrl} alt="" className="w-4 h-4 rounded-full" />}
                    <span className="font-mono text-xs font-medium">{t.tokenSymbol || t.symbol || `Token ${i + 1}`}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    {t.price && <span className="font-mono text-xs">${Number(t.price) < 0.01 ? Number(t.price).toPrecision(4) : Number(t.price).toFixed(4)}</span>}
                    {t.change != null && (
                      <span className={`font-mono text-[10px] ${Number(t.change) >= 0 ? "text-emerald-500" : "text-red-400"}`}>
                        {Number(t.change) >= 0 ? "+" : ""}{Number(t.change).toFixed(1)}%
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const SIGNAL_CHAINS = [
  { id: "501", name: "Solana" },
  { id: "1", name: "Ethereum" },
  { id: "56", name: "BNB Chain" },
  { id: "8453", name: "Base" },
  { id: "42161", name: "Arbitrum" },
];

function SignalsPanel({ isActive }: { isActive: boolean }) {
  const [chain, setChain] = useState("501");
  const [signalType, setSignalType] = useState<"signals" | "leaderboard">("signals");
  const [walletType, setWalletType] = useState("1");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const walletTypes = [
    { id: "1", label: "Smart Money" },
    { id: "2", label: "Whales" },
    { id: "3", label: "KOL / Influencer" },
  ];

  const handleFetch = async () => {
    setLoading(true);
    setError(null);
    try {
      const body = signalType === "signals"
        ? { skill: "okx_dex_signal", command: "signal list", params: { chain, "wallet-type": walletType } }
        : { skill: "okx_dex_signal", command: "leaderboard list", params: { chain, "time-frame": "3", "sort-by": "1" } };
      const res = await fetch("/api/okx/onchainos/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!result.success) throw new Error(result.error || "Failed to fetch");
      setData(result.data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const signals = data?.data || [];

  return (
    <div className="bg-card border rounded-lg p-6" data-testid="panel-signals">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-blue-500" />
          <h2 className="font-mono text-lg font-bold">Smart Money Signals</h2>
        </div>
        <Badge variant="outline" className="text-[10px]">Real-time</Badge>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Aggregated buy signals from smart money wallets, whales, and KOLs. Track what the best traders are buying.
      </p>

      <div className="space-y-3">
        <div className="flex gap-2">
          <button
            onClick={() => { setSignalType("signals"); setData(null); }}
            className={`flex-1 px-3 py-2 rounded-md font-mono text-xs transition-colors ${signalType === "signals" ? "bg-blue-500/20 text-blue-500 border border-blue-500/30" : "bg-muted text-muted-foreground"}`}
            data-testid="button-signal-signals"
          >
            Buy Signals
          </button>
          <button
            onClick={() => { setSignalType("leaderboard"); setData(null); }}
            className={`flex-1 px-3 py-2 rounded-md font-mono text-xs transition-colors ${signalType === "leaderboard" ? "bg-blue-500/20 text-blue-500 border border-blue-500/30" : "bg-muted text-muted-foreground"}`}
            data-testid="button-signal-leaderboard"
          >
            Leaderboard
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="font-mono text-[10px] text-muted-foreground block mb-1">Chain</label>
            <select
              value={chain}
              onChange={(e) => { setChain(e.target.value); setData(null); }}
              className="w-full bg-muted border rounded-md px-3 py-2.5 font-mono text-sm"
              data-testid="select-signal-chain"
            >
              {SIGNAL_CHAINS.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          {signalType === "signals" && (
            <div>
              <label className="font-mono text-[10px] text-muted-foreground block mb-1">Wallet Type</label>
              <select
                value={walletType}
                onChange={(e) => { setWalletType(e.target.value); setData(null); }}
                className="w-full bg-muted border rounded-md px-3 py-2.5 font-mono text-sm"
                data-testid="select-signal-wallet-type"
              >
                {walletTypes.map(w => (
                  <option key={w.id} value={w.id}>{w.label}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        <Button
          onClick={handleFetch}
          disabled={!isActive || loading}
          className="w-full font-mono text-sm h-11"
          data-testid="button-fetch-signals"
        >
          {loading ? (
            <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Loading...</>
          ) : (
            <><Activity className="w-4 h-4 mr-2" /> {signalType === "signals" ? "Get Signals" : "Get Leaderboard"}</>
          )}
        </Button>

        {error && (
          <div className="bg-destructive/10 border border-destructive/30 rounded-md p-3">
            <p className="font-mono text-xs text-destructive">{error}</p>
          </div>
        )}

        {signals.length > 0 && signalType === "signals" && (
          <div className="space-y-2 max-h-96 overflow-y-auto" data-testid="signals-results">
            {signals.slice(0, 20).map((s: any, i: number) => {
              const tok = s.token || {};
              const symbol = tok.symbol || s.tokenSymbol || s.symbol || "";
              const name = tok.name || s.name || "";
              const addr = tok.tokenAddress || s.tokenAddress || "";
              const logo = tok.logo || s.tokenLogoUrl || "";
              const amt = s.amountUsd || s.usdAmount || "";
              const mcap = tok.marketCapUsd || "";
              const wallets = s.triggerWalletCount || "";
              const sold = s.soldRatioPercent || "";
              return (
                <div key={i} className="bg-muted/50 rounded-md p-3 space-y-1.5" data-testid={`signal-item-${i}`}>
                  <div className="flex items-center gap-2">
                    {logo && <img src={logo} alt={symbol} className="w-5 h-5 rounded-full" />}
                    <span className="font-mono text-xs font-bold">{symbol || name || `#${i + 1}`}</span>
                    {name && symbol && <span className="font-mono text-[10px] text-muted-foreground">{name}</span>}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {amt && <span className="font-mono text-[11px] text-emerald-500">${Number(amt).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>}
                    {mcap && <span className="font-mono text-[10px] text-muted-foreground">MCap: ${Number(mcap).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>}
                    {wallets && <span className="font-mono text-[10px] text-muted-foreground">{wallets} wallets</span>}
                    {sold && <span className="font-mono text-[10px] text-orange-400">{sold}% sold</span>}
                  </div>
                  {addr && <p className="font-mono text-[10px] text-muted-foreground truncate">{addr}</p>}
                </div>
              );
            })}
          </div>
        )}

        {signals.length > 0 && signalType === "leaderboard" && (
          <div className="space-y-2 max-h-96 overflow-y-auto" data-testid="leaderboard-results">
            {signals.slice(0, 20).map((s: any, i: number) => (
              <div key={i} className="bg-muted/50 rounded-md p-3 space-y-1.5" data-testid={`leaderboard-item-${i}`}>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs font-bold">#{i + 1}</span>
                  <span className={`font-mono text-xs font-bold ${Number(s.realizedPnlUsd) >= 0 ? "text-emerald-500" : "text-red-400"}`}>
                    {Number(s.realizedPnlUsd) >= 0 ? "+" : ""}${Number(s.realizedPnlUsd || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {s.winRatePercent && <span className="font-mono text-[10px] text-muted-foreground">Win: {Number(s.winRatePercent).toFixed(1)}%</span>}
                  {s.txs && <span className="font-mono text-[10px] text-muted-foreground">{Number(s.txs).toLocaleString()} txs</span>}
                  {s.txVolume && <span className="font-mono text-[10px] text-muted-foreground">Vol: ${Number(s.txVolume).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>}
                </div>
                {s.walletAddress && <p className="font-mono text-[10px] text-muted-foreground truncate">{s.walletAddress}</p>}
                {s.topPnlTokenList?.length > 0 && (
                  <div className="flex gap-1 flex-wrap">
                    {s.topPnlTokenList.slice(0, 3).map((t: any, j: number) => (
                      <span key={j} className="font-mono text-[9px] bg-muted px-1.5 py-0.5 rounded text-emerald-400">
                        {t.tokenSymbol} +${Number(t.tokenPnLUsd || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SecurityPanel({ isActive }: { isActive: boolean }) {
  const [chain, setChain] = useState("56");
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [scanResult, setScanResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const handleScan = async () => {
    if (!address) return;
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      setError("Enter a valid token address (0x + 40 hex characters)");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/okx/onchainos/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skill: "okx_security",
          command: "security token-scan",
          params: { address, chain },
        }),
      });
      const result = await res.json();
      if (!result.success) throw new Error(result.error || "Scan failed");
      setScanResult(result.data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const riskData = scanResult?.data || (Array.isArray(scanResult) ? scanResult[0] : scanResult);
  const riskLevel = riskData?.riskControlLevel;
  const riskLevelLabel = riskLevel === "1" ? "Low" : riskLevel === "2" ? "Medium" : riskLevel === "3" ? "High" : riskLevel || "Unknown";

  return (
    <div className="bg-card border rounded-lg p-6" data-testid="panel-security">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-red-400" />
          <h2 className="font-mono text-lg font-bold">Security Scanner</h2>
        </div>
        <Badge variant="outline" className="text-[10px]">Honeypot Detection</Badge>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Scan any token for honeypot risks, hidden taxes, proxy contracts, and mint functions before buying.
      </p>

      <div className="space-y-3">
        <div>
          <label className="font-mono text-[10px] text-muted-foreground block mb-1">Chain</label>
          <select
            value={chain}
            onChange={(e) => { setChain(e.target.value); setScanResult(null); }}
            className="w-full bg-muted border rounded-md px-3 py-2.5 font-mono text-sm"
            data-testid="select-security-chain"
          >
            {CHAIN_OPTIONS.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="font-mono text-[10px] text-muted-foreground block mb-1">Token Address</label>
          <input
            type="text"
            value={address}
            onChange={(e) => { setAddress(e.target.value); setScanResult(null); setError(null); }}
            placeholder="0x... token contract address"
            className="w-full bg-muted border rounded-md px-3 py-2.5 font-mono text-xs"
            data-testid="input-security-address"
          />
        </div>

        <Button
          onClick={handleScan}
          disabled={!isActive || !address || loading}
          className="w-full font-mono text-sm h-11"
          data-testid="button-scan-token"
        >
          {loading ? (
            <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Scanning...</>
          ) : (
            <><Search className="w-4 h-4 mr-2" /> Scan Token</>
          )}
        </Button>

        {error && (
          <div className="bg-destructive/10 border border-destructive/30 rounded-md p-3">
            <p className="font-mono text-xs text-destructive">{error}</p>
          </div>
        )}

        {riskData && (
          <div className="bg-muted/50 rounded-lg p-4 space-y-3" data-testid="security-result">
            <div className="flex items-center justify-between">
              <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Scan Results</div>
              <Badge variant={riskLevel === "3" ? "destructive" : riskLevel === "2" ? "secondary" : "outline"} className="text-[10px]">
                Risk: {riskLevelLabel}
              </Badge>
            </div>
            {riskData.tokenContractAddress && (
              <p className="font-mono text-[10px] text-muted-foreground truncate">{riskData.tokenContractAddress}</p>
            )}
            <div className="grid grid-cols-2 gap-2">
              {riskData.devHoldingPercent && (
                <div className="flex items-center justify-between p-2 rounded-md bg-background">
                  <span className="font-mono text-[10px] text-muted-foreground">Dev Holding</span>
                  <span className={`font-mono text-xs font-medium ${Number(riskData.devHoldingPercent) > 10 ? "text-red-400" : "text-emerald-500"}`}>{riskData.devHoldingPercent}%</span>
                </div>
              )}
              {riskData.top10HoldPercent && (
                <div className="flex items-center justify-between p-2 rounded-md bg-background">
                  <span className="font-mono text-[10px] text-muted-foreground">Top 10 Hold</span>
                  <span className={`font-mono text-xs font-medium ${Number(riskData.top10HoldPercent) > 50 ? "text-orange-400" : "text-foreground"}`}>{riskData.top10HoldPercent}%</span>
                </div>
              )}
              {riskData.bundleHoldingPercent && (
                <div className="flex items-center justify-between p-2 rounded-md bg-background">
                  <span className="font-mono text-[10px] text-muted-foreground">Bundle Hold</span>
                  <span className={`font-mono text-xs font-medium ${Number(riskData.bundleHoldingPercent) > 10 ? "text-red-400" : "text-foreground"}`}>{riskData.bundleHoldingPercent}%</span>
                </div>
              )}
              {riskData.sniperHoldingPercent && (
                <div className="flex items-center justify-between p-2 rounded-md bg-background">
                  <span className="font-mono text-[10px] text-muted-foreground">Sniper Hold</span>
                  <span className={`font-mono text-xs font-medium ${Number(riskData.sniperHoldingPercent) > 10 ? "text-red-400" : "text-foreground"}`}>{riskData.sniperHoldingPercent}%</span>
                </div>
              )}
              {riskData.suspiciousHoldingPercent && (
                <div className="flex items-center justify-between p-2 rounded-md bg-background">
                  <span className="font-mono text-[10px] text-muted-foreground">Suspicious</span>
                  <span className={`font-mono text-xs font-medium ${Number(riskData.suspiciousHoldingPercent) > 5 ? "text-red-400" : "text-foreground"}`}>{riskData.suspiciousHoldingPercent}%</span>
                </div>
              )}
              {riskData.lpBurnedPercent && (
                <div className="flex items-center justify-between p-2 rounded-md bg-background">
                  <span className="font-mono text-[10px] text-muted-foreground">LP Burned</span>
                  <span className={`font-mono text-xs font-medium ${Number(riskData.lpBurnedPercent) > 50 ? "text-emerald-500" : "text-orange-400"}`}>{riskData.lpBurnedPercent}%</span>
                </div>
              )}
              {riskData.totalFee && (
                <div className="flex items-center justify-between p-2 rounded-md bg-background">
                  <span className="font-mono text-[10px] text-muted-foreground">Total Fee</span>
                  <span className={`font-mono text-xs font-medium ${Number(riskData.totalFee) > 5 ? "text-red-400" : "text-foreground"}`}>{riskData.totalFee}%</span>
                </div>
              )}
              {riskData.devLaunchedTokenCount && (
                <div className="flex items-center justify-between p-2 rounded-md bg-background">
                  <span className="font-mono text-[10px] text-muted-foreground">Dev Launches</span>
                  <span className="font-mono text-xs font-medium">{riskData.devLaunchedTokenCount}</span>
                </div>
              )}
            </div>
            {riskData.tokenTags?.length > 0 && (
              <div className="flex gap-1 flex-wrap pt-2 border-t border-border/50">
                {riskData.tokenTags.map((tag: string, j: number) => (
                  <Badge key={j} variant="secondary" className="text-[9px]">{tag.replace(/([A-Z])/g, ' $1').trim()}</Badge>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TrendingPanel({ isActive }: { isActive: boolean }) {
  const [chain, setChain] = useState("501");
  const [view, setView] = useState<"trending" | "hot">("trending");
  const [sortBy, setSortBy] = useState("5");
  const [loading, setLoading] = useState(false);
  const [tokens, setTokens] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  const sortOptions = [
    { id: "5", label: "Volume" },
    { id: "2", label: "Price Change" },
    { id: "6", label: "Market Cap" },
  ];

  const hotTypes = [
    { id: "5", label: "Most Active" },
    { id: "2", label: "Gainers" },
    { id: "6", label: "Market Cap" },
  ];

  const handleFetch = async () => {
    setLoading(true);
    setError(null);
    try {
      const body = view === "trending"
        ? { skill: "okx_dex_token", command: "token trending", params: { chains: chain, "sort-by": sortBy, "time-frame": "4" } }
        : { skill: "okx_dex_token", command: "token hot-tokens", params: { "ranking-type": sortBy, chain } };
      const res = await fetch("/api/okx/onchainos/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!result.success) throw new Error(result.error || "Failed to fetch");
      setTokens(result.data?.data || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-card border rounded-lg p-6" data-testid="panel-trending">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Flame className="w-5 h-5 text-orange-500" />
          <h2 className="font-mono text-lg font-bold">Trending Tokens</h2>
        </div>
        <Badge variant="outline" className="text-[10px]">Live</Badge>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Discover trending, hot, and newly listed tokens across chains. Sorted by volume, price change, or market cap.
      </p>

      <div className="space-y-3">
        <div className="flex gap-2">
          <button
            onClick={() => { setView("trending"); setTokens([]); setSortBy("5"); }}
            className={`flex-1 px-3 py-2 rounded-md font-mono text-xs transition-colors ${view === "trending" ? "bg-orange-500/20 text-orange-500 border border-orange-500/30" : "bg-muted text-muted-foreground"}`}
            data-testid="button-view-trending"
          >
            Trending
          </button>
          <button
            onClick={() => { setView("hot"); setTokens([]); setSortBy("4"); }}
            className={`flex-1 px-3 py-2 rounded-md font-mono text-xs transition-colors ${view === "hot" ? "bg-orange-500/20 text-orange-500 border border-orange-500/30" : "bg-muted text-muted-foreground"}`}
            data-testid="button-view-hot"
          >
            Hot Tokens
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="font-mono text-[10px] text-muted-foreground block mb-1">Chain</label>
            <select
              value={chain}
              onChange={(e) => { setChain(e.target.value); setTokens([]); }}
              className="w-full bg-muted border rounded-md px-3 py-2.5 font-mono text-sm"
              data-testid="select-trending-chain"
            >
              {SIGNAL_CHAINS.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="font-mono text-[10px] text-muted-foreground block mb-1">Sort By</label>
            <select
              value={sortBy}
              onChange={(e) => { setSortBy(e.target.value); setTokens([]); }}
              className="w-full bg-muted border rounded-md px-3 py-2.5 font-mono text-sm"
              data-testid="select-trending-sort"
            >
              {(view === "trending" ? sortOptions : hotTypes).map(s => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </div>
        </div>

        <Button
          onClick={handleFetch}
          disabled={!isActive || loading}
          className="w-full font-mono text-sm h-11"
          data-testid="button-fetch-trending"
        >
          {loading ? (
            <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Loading...</>
          ) : (
            <><TrendingUp className="w-4 h-4 mr-2" /> {view === "trending" ? "Get Trending" : "Get Hot Tokens"}</>
          )}
        </Button>

        {error && (
          <div className="bg-destructive/10 border border-destructive/30 rounded-md p-3">
            <p className="font-mono text-xs text-destructive">{error}</p>
          </div>
        )}

        {tokens.length > 0 && (
          <div className="space-y-1.5 max-h-96 overflow-y-auto" data-testid="trending-results">
            {tokens.slice(0, 20).map((t: any, i: number) => {
              const symbol = t.tokenSymbol || t.symbol || t.name || `Token ${i + 1}`;
              const logo = t.tokenLogoUrl || "";
              const pChange = t.change ?? t.priceChange;
              const vol = t.volume || t.volume24h || "";
              const mcap = t.marketCap || "";
              return (
                <div key={i} className="flex items-center justify-between bg-muted/50 rounded-md px-3 py-2.5" data-testid={`trending-item-${i}`}>
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono text-[10px] text-muted-foreground w-5 shrink-0">{i + 1}</span>
                    {logo && <img src={logo} alt={symbol} className="w-5 h-5 rounded-full shrink-0" />}
                    <div className="min-w-0">
                      <p className="font-mono text-xs font-medium truncate">{symbol}</p>
                      {t.tokenContractAddress && (
                        <p className="font-mono text-[10px] text-muted-foreground truncate">{t.tokenContractAddress.slice(0, 10)}...{t.tokenContractAddress.slice(-6)}</p>
                      )}
                    </div>
                  </div>
                  <div className="text-right shrink-0 ml-2">
                    {t.price && <p className="font-mono text-xs">${Number(t.price) < 0.01 ? Number(t.price).toPrecision(4) : Number(t.price).toFixed(4)}</p>}
                    {pChange != null && (
                      <p className={`font-mono text-[10px] ${Number(pChange) >= 0 ? "text-emerald-500" : "text-red-400"}`}>
                        {Number(pChange) >= 0 ? "+" : ""}{Number(pChange).toFixed(2)}%
                      </p>
                    )}
                    {vol && <p className="font-mono text-[10px] text-muted-foreground">Vol: ${Number(vol).toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const GAS_CHAINS = [
  { id: "1", name: "Ethereum", symbol: "ETH" },
  { id: "56", name: "BNB Chain", symbol: "BNB" },
  { id: "196", name: "XLayer", symbol: "OKB" },
  { id: "137", name: "Polygon", symbol: "POL" },
  { id: "42161", name: "Arbitrum", symbol: "ETH" },
  { id: "8453", name: "Base", symbol: "ETH" },
  { id: "43114", name: "Avalanche", symbol: "AVAX" },
  { id: "10", name: "Optimism", symbol: "ETH" },
];

function GasPanel({ isActive }: { isActive: boolean }) {
  const [chain, setChain] = useState("1");
  const [loading, setLoading] = useState(false);
  const [gasData, setGasData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFetch = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/okx/onchainos/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skill: "okx_onchain_gateway",
          command: "gateway gas",
          params: { chain },
        }),
      });
      const result = await res.json();
      if (!result.success) throw new Error(result.error || "Failed to fetch gas");
      setGasData(result.data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const gas = gasData?.data?.[0] || gasData;
  const chainInfo = GAS_CHAINS.find(c => c.id === chain);

  const formatGwei = (val: string | number | undefined): string => {
    if (!val) return "—";
    const n = Number(val);
    if (isNaN(n)) return String(val);
    if (n > 1e9) return (n / 1e9).toFixed(2) + " Gwei";
    if (n > 1e6) return (n / 1e6).toFixed(2) + " Mwei";
    return n.toFixed(2) + " wei";
  };

  return (
    <div className="bg-card border rounded-lg p-6" data-testid="panel-gas">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Fuel className="w-5 h-5 text-yellow-500" />
          <h2 className="font-mono text-lg font-bold">Gas Tracker</h2>
        </div>
        <Badge variant="outline" className="text-[10px]">Real-time</Badge>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Live gas prices across chains. Check before sending transactions to save on fees.
      </p>

      <div className="space-y-3">
        <div>
          <label className="font-mono text-[10px] text-muted-foreground block mb-1">Chain</label>
          <select
            value={chain}
            onChange={(e) => { setChain(e.target.value); setGasData(null); }}
            className="w-full bg-muted border rounded-md px-3 py-2.5 font-mono text-sm"
            data-testid="select-gas-chain"
          >
            {GAS_CHAINS.map(c => (
              <option key={c.id} value={c.id}>{c.name} ({c.symbol})</option>
            ))}
          </select>
        </div>

        <Button
          onClick={handleFetch}
          disabled={!isActive || loading}
          className="w-full font-mono text-sm h-11"
          data-testid="button-fetch-gas"
        >
          {loading ? (
            <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Loading...</>
          ) : (
            <><Fuel className="w-4 h-4 mr-2" /> Get Gas Prices</>
          )}
        </Button>

        {error && (
          <div className="bg-destructive/10 border border-destructive/30 rounded-md p-3">
            <p className="font-mono text-xs text-destructive">{error}</p>
          </div>
        )}

        {gas && (
          <div className="space-y-3" data-testid="gas-result">
            <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">Gas Prices — {chainInfo?.name}</div>
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: "Slow", key: "low", alt: "safeLow", color: "text-emerald-500" },
                { label: "Standard", key: "normal", alt: "average", color: "text-yellow-500" },
                { label: "Fast", key: "high", alt: "fast", color: "text-red-400" },
              ].map(tier => {
                const val = gas[tier.key] || gas[tier.alt] || gas.gasPrice;
                return (
                  <div key={tier.key} className="bg-muted/50 rounded-lg p-3 text-center">
                    <p className="font-mono text-[10px] text-muted-foreground mb-1">{tier.label}</p>
                    <p className={`font-mono text-sm font-bold ${tier.color}`}>{formatGwei(val)}</p>
                  </div>
                );
              })}
            </div>
            {gas.baseFee && (
              <div className="flex items-center justify-between bg-muted/50 rounded-md px-3 py-2">
                <span className="font-mono text-xs text-muted-foreground">Base Fee</span>
                <span className="font-mono text-xs font-medium">{formatGwei(gas.baseFee)}</span>
              </div>
            )}
            {gas.maxPriorityFeePerGas && (
              <div className="flex items-center justify-between bg-muted/50 rounded-md px-3 py-2">
                <span className="font-mono text-xs text-muted-foreground">Priority Fee</span>
                <span className="font-mono text-xs font-medium">{formatGwei(gas.maxPriorityFeePerGas)}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function BridgePanel({ isActive, address }: { isActive: boolean; address: string | null }) {
  const [fromChain, setFromChain] = useState("196");
  const [toChain, setToChain] = useState("56");
  const [fromToken, setFromToken] = useState(NATIVE_TOKEN);
  const [toToken, setToToken] = useState(NATIVE_TOKEN);
  const [amount, setAmount] = useState("");
  const [receiverAddress, setReceiverAddress] = useState(address || "");
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [bridgeQuote, setBridgeQuote] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: bridgeChains } = useQuery<any>({
    queryKey: ["/api/okx/bridge/chains"],
    staleTime: 60000,
  });

  const fromTokens = getTokensForChain(fromChain);
  const toTokens = getTokensForChain(toChain);

  const selectedFromToken = fromTokens.find(t => t.address === fromToken) || fromTokens[0];
  const selectedToToken = toTokens.find(t => t.address === toToken) || toTokens[0];

  const handleFromChainChange = (newChain: string) => {
    setFromChain(newChain);
    if (newChain === toChain) {
      const alt = CHAIN_OPTIONS.find(c => c.id !== newChain);
      if (alt) {
        setToChain(alt.id);
        const tokens = getTokensForChain(alt.id);
        setToToken(tokens[0].address);
      }
    }
    const tokens = getTokensForChain(newChain);
    setFromToken(tokens[0].address);
    setBridgeQuote(null);
    setError(null);
  };

  const handleToChainChange = (newChain: string) => {
    if (newChain === fromChain) {
      setError("Source and destination chains must be different");
      return;
    }
    setToChain(newChain);
    const tokens = getTokensForChain(newChain);
    setToToken(tokens[0].address);
    setBridgeQuote(null);
    setError(null);
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
    setError(null);
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
    if (fromChain === toChain) {
      setError("Source and destination chains must be different. Please select a different destination chain.");
      return;
    }
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
        slippage: "0.01",
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

  const bridgeServiceDown = true;

  return (
    <div className="bg-card border rounded-lg p-6" data-testid="panel-bridge">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Layers className="w-5 h-5 text-blue-500" />
          <h2 className="font-mono text-lg font-bold">Cross-Chain Bridge</h2>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="destructive" className="text-[10px]" data-testid="badge-bridge-status">Temporarily Unavailable</Badge>
          <Badge variant="outline" className="text-[10px]">0.5% fee</Badge>
          <Badge variant="outline" className="text-[10px]">{CHAIN_OPTIONS.length} Chains</Badge>
        </div>
      </div>
      <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-md p-4 mb-4" data-testid="alert-bridge-unavailable">
        <p className="font-mono text-sm text-yellow-600 dark:text-yellow-400 font-medium mb-1">
          <Shield className="w-4 h-4 inline mr-1.5" />
          Cross-chain bridge is temporarily unavailable
        </p>
        <p className="font-mono text-xs text-yellow-600/80 dark:text-yellow-400/80">
          OKX cross-chain bridge API is down. Please try again later or use DEX Swap to trade tokens on a single chain.
        </p>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Bridge assets between BNB Chain, XLayer, and 60+ chains. Aggregates 18 bridge protocols for best rates.
      </p>

      <div className={`space-y-4 ${bridgeServiceDown ? "opacity-40 pointer-events-none select-none" : ""}`}>
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
              {CHAIN_OPTIONS.filter((c) => c.id !== fromChain).map((c) => (
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
              {(() => {
                const tokens = balances.data?.[0]?.tokenAssets || balances.data || [];
                return tokens.map((token: any, i: number) => (
                  <div key={i} className="flex items-center justify-between bg-muted/50 rounded-md px-3 py-2">
                    <div>
                      <span className="font-mono text-xs font-medium">{token.symbol || token.tokenSymbol || "?"}</span>
                    </div>
                    <div className="text-right">
                      <span className="font-mono text-xs">{token.balance || token.holdingAmount || "0"}</span>
                      {token.tokenPrice && Number(token.tokenPrice) > 0 && (
                        <span className="font-mono text-[10px] text-muted-foreground ml-2">
                          ${(Number(token.balance || token.holdingAmount || 0) * Number(token.tokenPrice)).toFixed(2)}
                        </span>
                      )}
                    </div>
                  </div>
                ));
              })()}
              {(!balances.data || balances.data.length === 0 || (balances.data[0]?.tokenAssets && balances.data[0].tokenAssets.length === 0)) && (
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
  const { data: skillsData, isLoading: skillsLoading, isError: skillsError } = useQuery<{
    installed: boolean;
    version: string;
    skills: { id: string; name: string; icon: string; category: string; commands: { name: string; description: string }[] }[];
  }>({
    queryKey: ["/api/okx/onchainos/skills"],
  });

  const categoryColors: Record<string, string> = {
    "onchain-swap": "text-violet-500",
    "onchain-market": "text-emerald-500",
    "onchain-signal": "text-blue-500",
    "onchain-security": "text-red-400",
    "onchain-wallet": "text-orange-500",
    "onchain-infra": "text-yellow-500",
  };

  const categoryLabels: Record<string, string> = {
    "onchain-swap": "Swap",
    "onchain-market": "Market",
    "onchain-signal": "Signal",
    "onchain-security": "Security",
    "onchain-wallet": "Wallet",
    "onchain-infra": "Infra",
  };

  return (
    <div className="bg-card border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-mono text-sm font-bold">OnchainOS Skills</h3>
        {skillsData?.installed && (
          <Badge variant="secondary" className="text-[10px]" data-testid="badge-onchainos-version">{skillsData.version}</Badge>
        )}
      </div>
      {skillsLoading ? (
        <div className="space-y-2 animate-pulse">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2 p-2">
              <div className="w-5 h-5 bg-muted rounded" />
              <div className="flex-1 space-y-1">
                <div className="h-3 bg-muted rounded w-24" />
                <div className="h-2 bg-muted rounded w-16" />
              </div>
            </div>
          ))}
        </div>
      ) : skillsError ? (
        <div className="p-3 rounded-md bg-red-500/10 border border-red-500/20">
          <p className="font-mono text-xs text-red-400" data-testid="text-skills-error">Failed to load OnchainOS skills</p>
        </div>
      ) : skillsData?.skills ? (
        <div className="space-y-1.5">
          {skillsData.skills.map((s) => (
            <div key={s.id} className="flex items-center justify-between p-2 rounded-md hover:bg-muted/50 transition-colors" data-testid={`skill-${s.id}`}>
              <div className="flex items-center gap-2">
                <span className="text-sm">{s.icon}</span>
                <div>
                  <p className="font-mono text-xs font-medium">{s.name}</p>
                  <p className="font-mono text-[10px] text-muted-foreground">{s.commands.length} commands</p>
                </div>
              </div>
              <Badge variant="outline" className={`text-[9px] ${categoryColors[s.category] || ""}`}>
                {categoryLabels[s.category] || s.category}
              </Badge>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {[
            { icon: ArrowLeftRight, title: "DEX Aggregator", desc: "500+ DEXs, best routing, 60+ chains", color: "text-violet-500" },
            { icon: BarChart3, title: "Market Data", desc: "Real-time prices, trending, holder data", color: "text-emerald-500" },
            { icon: Layers, title: "Cross-Chain Bridge", desc: "18 bridge aggregators, seamless transfers", color: "text-blue-500" },
            { icon: Wallet, title: "Wallet API", desc: "Multi-chain balances and tx history", color: "text-orange-500" },
            { icon: Shield, title: "AI Agent Ready", desc: "MCP Server + AI Skills for agent trading", color: "text-pink-500" },
            { icon: Zap, title: "Sub-100ms", desc: "Ultra-fast API response times", color: "text-yellow-500" },
          ].map((f, i) => (
            <div key={i} className="flex items-start gap-3 p-2 rounded-md hover:bg-muted/50 transition-colors">
              <f.icon className={`w-4 h-4 mt-0.5 ${f.color}`} />
              <div>
                <p className="font-mono text-xs font-medium">{f.title}</p>
                <p className="font-mono text-[10px] text-muted-foreground">{f.desc}</p>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="mt-4 pt-3 border-t flex items-center justify-between">
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
        <a
          href="https://github.com/okx/onchainos-skills"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 font-mono text-xs text-muted-foreground hover:text-foreground transition-colors"
          data-testid="link-onchainos-github"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          GitHub
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
