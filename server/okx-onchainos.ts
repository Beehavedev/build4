import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";

const OKX_BASE_URL = "https://web3.okx.com";

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;

export function okxRateLimit(req: Request, res: Response, next: NextFunction) {
  const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0] || req.ip || "unknown";
  const now = Date.now();
  let entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitMap.set(ip, entry);
  }

  entry.count++;

  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "Rate limit exceeded. Max 30 requests per minute." });
  }

  next();
}

interface OKXConfig {
  apiKey: string;
  secretKey: string;
  passphrase: string;
  projectId: string;
}

function getConfig(): OKXConfig | null {
  const apiKey = process.env.OKX_API_KEY;
  const secretKey = process.env.OKX_SECRET_KEY;
  const passphrase = process.env.OKX_API_PASSPHRASE;
  const projectId = process.env.OKX_PROJECT_ID;
  if (!apiKey || !secretKey || !passphrase || !projectId) return null;
  return { apiKey, secretKey, passphrase, projectId };
}

function generateSignature(
  timestamp: string,
  method: string,
  requestPath: string,
  body: string,
  secretKey: string
): string {
  const preHash = timestamp + method.toUpperCase() + requestPath + body;
  return crypto
    .createHmac("sha256", secretKey)
    .update(preHash)
    .digest("base64");
}

function getHeaders(
  method: string,
  requestPath: string,
  body: string = ""
): Record<string, string> {
  const config = getConfig();
  if (!config) throw new Error("OKX API not configured");

  const timestamp = new Date().toISOString();
  const sign = generateSignature(
    timestamp,
    method,
    requestPath,
    body,
    config.secretKey
  );

  return {
    "Content-Type": "application/json",
    "OK-ACCESS-KEY": config.apiKey,
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": config.passphrase,
    "OK-ACCESS-PROJECT": config.projectId,
  };
}

function getApiVersion(path: string): string {
  if (path.startsWith("/dex/aggregator")) return "/api/v6";
  if (path.startsWith("/dex/market")) return "/api/v6";
  if (path.startsWith("/dex/pre-transaction")) return "/api/v6";
  if (path.startsWith("/dex/post-transaction")) return "/api/v6";
  if (path.startsWith("/dex/cross-chain")) return "/api/v5";
  if (path.startsWith("/wallet")) return "/api/v5";
  return "/api/v5";
}

async function okxRequest(
  method: string,
  path: string,
  params?: Record<string, string>,
  body?: any
): Promise<any> {
  const apiPrefix = getApiVersion(path);
  let signPath = apiPrefix + path;
  let urlPath = apiPrefix + path;

  if (params && method === "GET") {
    const queryString = "?" + new URLSearchParams(params).toString();
    signPath = apiPrefix + path + queryString;
    urlPath = apiPrefix + path + queryString;
  }

  const bodyStr = body ? JSON.stringify(body) : "";
  const headers = getHeaders(method, signPath, bodyStr);
  const url = `${OKX_BASE_URL}${urlPath}`;

  const response = await fetch(url, {
    method,
    headers,
    body: method !== "GET" ? bodyStr : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OKX API error ${response.status}: ${text.slice(0, 200)}`);
  }

  const result = await response.json();

  if (result.code && result.code !== "0") {
    throw new Error(`OKX API business error [${result.code}]: ${result.msg || result.detailMsg || "Unknown error"}`);
  }

  return result;
}

export function isOKXConfigured(): boolean {
  return getConfig() !== null;
}

const BUILD4_TREASURY = "0x5Ff57464152c9285A8526a0665d996dA66e2def1";
const BUILD4_FEE_PERCENT = "0.5";

export async function getSwapQuote(params: {
  chainId: string;
  fromTokenAddress: string;
  toTokenAddress: string;
  amount: string;
  slippage?: string;
}): Promise<any> {
  const queryParams: Record<string, string> = {
    chainIndex: params.chainId,
    fromTokenAddress: params.fromTokenAddress,
    toTokenAddress: params.toTokenAddress,
    amount: params.amount,
    slippagePercent: params.slippage || "0.5",
    feePercent: BUILD4_FEE_PERCENT,
    toTokenReferrerWalletAddress: BUILD4_TREASURY,
  };

  return okxRequest("GET", "/dex/aggregator/quote", queryParams);
}

export async function getSwapData(params: {
  chainId: string;
  fromTokenAddress: string;
  toTokenAddress: string;
  amount: string;
  slippage?: string;
  userWalletAddress: string;
}): Promise<any> {
  const queryParams: Record<string, string> = {
    chainIndex: params.chainId,
    fromTokenAddress: params.fromTokenAddress,
    toTokenAddress: params.toTokenAddress,
    amount: params.amount,
    slippagePercent: params.slippage || "0.5",
    userWalletAddress: params.userWalletAddress,
    feePercent: BUILD4_FEE_PERCENT,
    toTokenReferrerWalletAddress: BUILD4_TREASURY,
  };

  return okxRequest("GET", "/dex/aggregator/swap", queryParams);
}

export async function getApproveTransaction(params: {
  chainId: string;
  tokenContractAddress: string;
  approveAmount: string;
}): Promise<any> {
  return okxRequest("GET", "/dex/aggregator/approve-transaction", {
    chainIndex: params.chainId,
    tokenContractAddress: params.tokenContractAddress,
    approveAmount: params.approveAmount,
  });
}

export async function getSupportedTokens(chainId: string): Promise<any> {
  return okxRequest("GET", "/dex/aggregator/all-tokens", { chainIndex: chainId });
}

export async function getLiquidity(chainId: string): Promise<any> {
  return okxRequest("GET", "/dex/aggregator/get-liquidity", { chainIndex: chainId });
}

export async function getTokenPrice(params: {
  chainId: string;
  tokenAddress: string;
}): Promise<any> {
  const allTokens = await getSupportedTokens(params.chainId);
  if (allTokens?.data) {
    const token = allTokens.data.find(
      (t: any) => t.tokenContractAddress?.toLowerCase() === params.tokenAddress.toLowerCase()
    );
    if (token) {
      return {
        code: "0",
        data: [{
          tokenName: token.tokenName,
          tokenSymbol: token.tokenSymbol,
          tokenContractAddress: token.tokenContractAddress,
          decimals: token.decimals,
          logoUrl: token.tokenLogoUrl,
          chainId: params.chainId,
        }],
      };
    }
  }
  return { code: "0", data: [] };
}

export async function getTokenMarketData(params: {
  chainId: string;
  tokenAddress: string;
}): Promise<any> {
  return getTokenPrice(params);
}

export async function getTopTokens(chainId: string): Promise<any> {
  const allTokens = await getSupportedTokens(chainId);
  if (allTokens?.data) {
    return {
      code: "0",
      data: allTokens.data.slice(0, 20),
    };
  }
  return { code: "0", data: [] };
}

export async function getTrendingTokens(chainId: string): Promise<any> {
  return getTopTokens(chainId);
}

export async function getTokenHolders(params: {
  chainId: string;
  tokenAddress: string;
}): Promise<any> {
  return { code: "0", data: [], msg: "Holder data not available in current API version" };
}

const LIFI_BASE_URL = "https://li.quest/v1";
const LIFI_NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";

function normalizeLifiTokenAddress(addr: string, chainId?: string): string {
  if (chainId === "501") return addr;
  if (addr.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") return LIFI_NATIVE_TOKEN;
  return addr;
}

function normalizeLifiChainId(chainId: string): string {
  if (chainId === "501") return "SOL";
  return chainId;
}

async function getLifiQuote(params: {
  fromChainId: string;
  toChainId: string;
  fromTokenAddress: string;
  toTokenAddress: string;
  amount: string;
  fromAddress?: string;
  toAddress?: string;
}): Promise<any> {
  const url = new URL(`${LIFI_BASE_URL}/quote`);
  url.searchParams.set("fromChain", normalizeLifiChainId(params.fromChainId));
  url.searchParams.set("toChain", normalizeLifiChainId(params.toChainId));
  url.searchParams.set("fromToken", normalizeLifiTokenAddress(params.fromTokenAddress, params.fromChainId));
  url.searchParams.set("toToken", normalizeLifiTokenAddress(params.toTokenAddress, params.toChainId));
  url.searchParams.set("fromAmount", params.amount);
  url.searchParams.set("fromAddress", params.fromAddress || BUILD4_TREASURY);
  url.searchParams.set("integrator", "build4");
  if (params.toAddress) url.searchParams.set("toAddress", params.toAddress);

  const resp = await fetch(url.toString(), { headers: { "Accept": "application/json" } });
  if (!resp.ok) throw new Error(`Li.Fi API error: ${resp.status}`);
  return resp.json();
}

async function getLifiBuildTx(params: {
  fromChainId: string;
  toChainId: string;
  fromTokenAddress: string;
  toTokenAddress: string;
  amount: string;
  fromAddress: string;
  toAddress?: string;
}): Promise<any> {
  const url = new URL(`${LIFI_BASE_URL}/quote`);
  url.searchParams.set("fromChain", normalizeLifiChainId(params.fromChainId));
  url.searchParams.set("toChain", normalizeLifiChainId(params.toChainId));
  url.searchParams.set("fromToken", normalizeLifiTokenAddress(params.fromTokenAddress, params.fromChainId));
  url.searchParams.set("toToken", normalizeLifiTokenAddress(params.toTokenAddress, params.toChainId));
  url.searchParams.set("fromAmount", params.amount);
  url.searchParams.set("fromAddress", params.fromAddress);
  url.searchParams.set("integrator", "build4");
  if (params.toAddress) url.searchParams.set("toAddress", params.toAddress);

  const resp = await fetch(url.toString(), { headers: { "Accept": "application/json" } });
  if (!resp.ok) throw new Error(`Li.Fi API error: ${resp.status}`);
  const data = await resp.json();
  return data;
}

export async function getCrossChainQuote(params: {
  fromChainId: string;
  toChainId: string;
  fromTokenAddress: string;
  toTokenAddress: string;
  amount: string;
  slippage?: string;
}): Promise<any> {
  try {
    return await okxRequest("GET", "/dex/cross-chain/quote", {
      fromChainId: params.fromChainId,
      toChainId: params.toChainId,
      fromTokenAddress: params.fromTokenAddress,
      toTokenAddress: params.toTokenAddress,
      amount: params.amount,
      slippage: params.slippage || "0.01",
      feePercent: BUILD4_FEE_PERCENT,
    });
  } catch (err: any) {
    console.log("[OKX Bridge] OKX cross-chain failed, trying Li.Fi fallback...");
    try {
      const lifiQuote = await getLifiQuote({
        fromChainId: params.fromChainId,
        toChainId: params.toChainId,
        fromTokenAddress: params.fromTokenAddress,
        toTokenAddress: params.toTokenAddress,
        amount: params.amount,
      });

      if (lifiQuote?.estimate?.toAmount) {
        return {
          code: "0",
          data: [{
            toTokenAmount: lifiQuote.estimate.toAmount,
            fromTokenAmount: params.amount,
            bridgeName: lifiQuote.tool || "Li.Fi",
            bridgeProvider: lifiQuote.toolDetails?.name || lifiQuote.tool || "Li.Fi",
            estimatedTime: lifiQuote.estimate?.executionDuration || 0,
            _lifiQuote: lifiQuote,
            _provider: "lifi",
          }],
          msg: "",
        };
      }
      throw new Error("No Li.Fi quote available");
    } catch (lifiErr: any) {
      console.log("[OKX Bridge] Li.Fi fallback also failed:", lifiErr.message);
      throw new Error("Cross-chain bridge temporarily unavailable. Please try again later.");
    }
  }
}

export async function getCrossChainSwap(params: {
  fromChainId: string;
  toChainId: string;
  fromTokenAddress: string;
  toTokenAddress: string;
  amount: string;
  userWalletAddress: string;
  slippage?: string;
}): Promise<any> {
  try {
    return await okxRequest("GET", "/dex/cross-chain/build-tx", {
      fromChainId: params.fromChainId,
      toChainId: params.toChainId,
      fromTokenAddress: params.fromTokenAddress,
      toTokenAddress: params.toTokenAddress,
      amount: params.amount,
      userWalletAddress: params.userWalletAddress,
      slippage: params.slippage || "0.01",
      feePercent: BUILD4_FEE_PERCENT,
      referrerAddress: BUILD4_TREASURY,
    });
  } catch (err: any) {
    console.log("[OKX Bridge] OKX build-tx failed, trying Li.Fi fallback...");
    try {
      const lifiData = await getLifiBuildTx({
        fromChainId: params.fromChainId,
        toChainId: params.toChainId,
        fromTokenAddress: params.fromTokenAddress,
        toTokenAddress: params.toTokenAddress,
        amount: params.amount,
        fromAddress: params.userWalletAddress,
      });

      if (lifiData?.transactionRequest) {
        return {
          code: "0",
          data: [{
            tx: {
              to: lifiData.transactionRequest.to,
              data: lifiData.transactionRequest.data,
              value: lifiData.transactionRequest.value || "0",
              gasLimit: lifiData.transactionRequest.gasLimit || "300000",
              chainId: parseInt(params.fromChainId),
            },
            toTokenAmount: lifiData.estimate?.toAmount || "0",
            _provider: "lifi",
          }],
          msg: "",
        };
      }
      throw new Error("No Li.Fi transaction data available");
    } catch (lifiErr: any) {
      console.log("[OKX Bridge] Li.Fi build-tx fallback also failed:", lifiErr.message);
      throw new Error("Cross-chain bridge temporarily unavailable. Please try again later.");
    }
  }
}

export async function getCrossChainStatus(params: {
  chainId: string;
  txHash: string;
}): Promise<any> {
  return okxRequest("GET", "/dex/cross-chain/status", {
    chainId: params.chainId,
    hash: params.txHash,
  });
}

export async function getSupportedBridgeChains(): Promise<any> {
  try {
    return await okxRequest("GET", "/dex/cross-chain/supported/chain");
  } catch (err: any) {
    if (err.message?.includes("50050")) {
      return {
        code: "0",
        data: Object.entries(SUPPORTED_CHAIN_IDS).map(([id, name]) => ({
          chainId: id,
          chainName: name,
        })),
        msg: "Using local chain list (OKX cross-chain API temporarily unavailable)",
      };
    }
    throw err;
  }
}

export async function getWalletTokenBalances(params: {
  address: string;
  chainId: string;
}): Promise<any> {
  return okxRequest("GET", "/wallet/asset/all-token-balances-by-address", {
    address: params.address,
    chains: params.chainId,
  });
}

export async function getWalletTransactionHistory(params: {
  address: string;
  chainId: string;
  limit?: string;
}): Promise<any> {
  return okxRequest("GET", "/wallet/post-transaction/transactions-by-address", {
    address: params.address,
    chainIndex: params.chainId,
    limit: params.limit || "20",
  });
}

export async function getSmartMoneySignalsAPI(chain: string, walletType?: string): Promise<any> {
  const body: Record<string, string> = { chainIndex: chain };
  if (walletType) body.walletType = walletType;
  return await okxRequest("POST", "/dex/market/signal/list", undefined, body);
}

export async function getLeaderboardAPI(chain: string, timeFrame?: string, sortBy?: string): Promise<any> {
  const params: Record<string, string> = { chainIndex: chain, timeFrame: timeFrame || "3", sortBy: sortBy || "1" };
  return await okxRequest("GET", "/dex/market/leaderboard/list", params);
}

export async function securityTokenScanAPI(address: string, chainId: string): Promise<any> {
  const chainMap: Record<string, string> = {
    "56": "56", "1": "1", "137": "137", "42161": "42161",
    "8453": "8453", "196": "196", "43114": "43114", "10": "10",
    "501": "solana",
  };
  const gpChain = chainMap[chainId] || chainId;

  try {
    const isSolana = chainId === "501" || gpChain === "solana";
    const gpUrl = isSolana
      ? `https://api.gopluslabs.com/api/v1/solana/token_security?contract_addresses=${address}`
      : `https://api.gopluslabs.com/api/v1/token_security/${gpChain}?contract_addresses=${address}`;
    const gpRes = await fetch(gpUrl, { signal: AbortSignal.timeout(8000) });
    if (gpRes.ok) {
      const gpJson = await gpRes.json() as any;
      const resultKey = Object.keys(gpJson?.result || {})[0];
      const d = gpJson?.result?.[resultKey];
      if (d) {
        const risks: string[] = [];
        if (d.is_mintable === "1") risks.push("Owner can mint new tokens");
        if (d.can_take_back_ownership === "1") risks.push("Owner can reclaim ownership");
        if (d.owner_change_balance === "1") risks.push("Owner can modify balances");
        if (d.hidden_owner === "1") risks.push("Hidden owner detected");
        if (d.selfdestruct === "1") risks.push("Contract can self-destruct");
        if (d.external_call === "1") risks.push("External call risk");
        if (d.is_blacklisted === "1") risks.push("Has blacklist function");
        if (d.is_whitelisted === "1") risks.push("Has whitelist function");
        if (d.trading_cooldown === "1") risks.push("Trading cooldown enabled");
        if (d.transfer_pausable === "1") risks.push("Transfers can be paused");
        if (d.cannot_sell_all === "1") risks.push("Cannot sell all tokens");
        if (d.personal_slippage_modifiable === "1") risks.push("Per-address slippage modification");

        const buyTax = d.buy_tax ? (parseFloat(d.buy_tax) * 100).toFixed(1) : undefined;
        const sellTax = d.sell_tax ? (parseFloat(d.sell_tax) * 100).toFixed(1) : undefined;
        const isHoneypot = d.is_honeypot === "1";
        const highTax = (parseFloat(buyTax || "0") > 10 || parseFloat(sellTax || "0") > 10);
        const riskLevel = isHoneypot ? "high" : (risks.length > 3 || highTax) ? "medium" : "low";

        return {
          success: true,
          data: {
            isHoneypot,
            riskLevel,
            buyTax,
            sellTax,
            isOpenSource: d.is_open_source === "1",
            isProxy: d.is_proxy === "1",
            ownerCanMint: d.is_mintable === "1",
            canTakeBackOwnership: d.can_take_back_ownership === "1",
            ownerChangeBalance: d.owner_change_balance === "1",
            holderCount: d.holder_count ? parseInt(d.holder_count) : undefined,
            lpHolderCount: d.lp_holder_count ? parseInt(d.lp_holder_count) : undefined,
            totalSupply: d.total_supply,
            tokenName: d.token_name,
            tokenSymbol: d.token_symbol,
            risks,
            source: "GoPlus",
          },
        };
      }
    }
  } catch {}

  if (chainId === "501" || gpChain === "solana") {
    try {
      const rcUrl = `https://api.rugcheck.xyz/v1/tokens/${address}/report/summary`;
      const rcRes = await fetch(rcUrl, { signal: AbortSignal.timeout(8000) });
      if (rcRes.ok) {
        const rc = await rcRes.json() as any;
        const risks: string[] = [];
        if (rc.risks && Array.isArray(rc.risks)) {
          rc.risks.forEach((r: any) => {
            if (r.name || r.description) risks.push(r.description || r.name);
          });
        }
        if (rc.mintAuthority) risks.push("Mint authority is active — new tokens can be minted");
        if (rc.freezeAuthority) risks.push("Freeze authority is active — tokens can be frozen");

        const score = rc.score_normalised || rc.score || 0;
        const isHoneypot = rc.rugged === true;
        const riskLevel = isHoneypot ? "high" : score >= 50000 ? "high" : score >= 10000 ? "medium" : "low";

        return {
          success: true,
          data: {
            isHoneypot,
            riskLevel,
            isOpenSource: true,
            isProxy: false,
            ownerCanMint: !!rc.mintAuthority,
            freezeAuthority: !!rc.freezeAuthority,
            holderCount: rc.totalHolders || undefined,
            tokenName: rc.tokenMeta?.name || undefined,
            tokenSymbol: rc.tokenMeta?.symbol || undefined,
            liquidity: rc.totalMarketLiquidity || undefined,
            rugScore: score,
            risks,
            source: "RugCheck",
          },
        };
      }
    } catch {}
  }

  const honeypotChainMap: Record<string, string> = {
    "56": "56", "1": "1", "8453": "8453", "42161": "42161", "137": "137", "43114": "43114", "10": "10",
  };
  const hpChainId = honeypotChainMap[chainId];
  if (hpChainId) {
    try {
      const hpUrl = `https://api.honeypot.is/v2/IsHoneypot?address=${address}&chainID=${hpChainId}`;
      const hpRes = await fetch(hpUrl, { signal: AbortSignal.timeout(8000) });
      if (hpRes.ok) {
        const hp = await hpRes.json() as any;
        if (hp.simulationSuccess !== undefined) {
          const risks: string[] = [];
          if (hp.flags) hp.flags.forEach((f: any) => risks.push(f.description || f));
          if (hp.contractCode?.isProxy) risks.push("Proxy contract detected");
          if (hp.contractCode?.hasProxyCalls) risks.push("Has proxy calls");

          const buyTax = hp.simulationResult?.buyTax !== undefined ? (hp.simulationResult.buyTax * 100).toFixed(1) : undefined;
          const sellTax = hp.simulationResult?.sellTax !== undefined ? (hp.simulationResult.sellTax * 100).toFixed(1) : undefined;
          const isHoneypot = hp.honeypotResult?.isHoneypot === true;
          const riskStr = hp.summary?.risk || (isHoneypot ? "high" : "low");

          return {
            success: true,
            data: {
              isHoneypot,
              riskLevel: riskStr,
              buyTax,
              sellTax,
              isOpenSource: hp.contractCode?.openSource || false,
              isProxy: hp.contractCode?.isProxy || false,
              holderCount: hp.token?.totalHolders,
              tokenName: hp.token?.name,
              tokenSymbol: hp.token?.symbol,
              risks,
              source: "Honeypot.is",
            },
          };
        }
      }
    } catch {}
  }

  try {
    const okxResult = await okxRequest("GET", "/dex/market/token/advanced-info", {
      chainIndex: chainId,
      tokenContractAddress: address,
    });
    if (okxResult?.data) {
      const d = Array.isArray(okxResult.data) ? okxResult.data[0] : okxResult.data;
      return {
        success: true,
        data: {
          riskLevel: "unknown",
          tokenName: d?.tokenName || d?.name,
          tokenSymbol: d?.tokenSymbol || d?.symbol,
          price: d?.price,
          marketCap: d?.marketCap,
          volume24h: d?.volume24h,
          liquidity: d?.liquidity,
          source: "OKX",
        },
      };
    }
  } catch {}

  return { success: false, error: "Could not scan token" };
}

export async function getGasPriceAPI(chainId: string): Promise<any> {
  return await okxRequest("GET", "/dex/pre-transaction/gas-price", {
    chainIndex: chainId,
  });
}

export async function getTrendingTokensAPI(chainId?: string): Promise<any> {
  const params: Record<string, string> = { chains: chainId || "56", sortBy: "5", timeFrame: "4" };
  return await okxRequest("GET", "/dex/market/token/toplist", params);
}

export async function getHotTokensAPI(rankingType: string, chainId?: string): Promise<any> {
  const sortBy = ["2", "5", "6"].includes(rankingType) ? rankingType : "5";
  const params: Record<string, string> = { chains: chainId || "56", sortBy, timeFrame: "4" };
  return await okxRequest("GET", "/dex/market/token/toplist", params);
}

export async function getMemeTokensAPI(chain: string, stage?: string): Promise<any> {
  const params: Record<string, string> = { chainIndex: chain, stage: stage || "NEW" };
  return await okxRequest("GET", "/dex/market/memepump/tokenList", params);
}

export async function getTokenPriceAPI(address: string, chainId: string): Promise<any> {
  try {
    return await okxRequest("POST", "/dex/market/price-info", undefined, [
      { chainIndex: chainId, tokenContractAddress: address },
    ]);
  } catch {
    try {
      return await okxRequest("GET", "/dex/aggregator/quote", {
        chainIndex: chainId,
        fromTokenAddress: address,
        toTokenAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        amount: "1000000000000000000",
        slippagePercent: "1",
      });
    } catch {
      return { code: "0", data: [], msg: "Price unavailable" };
    }
  }
}

export const SUPPORTED_CHAIN_IDS: Record<string, string> = {
  "1": "Ethereum",
  "56": "BNB Chain",
  "137": "Polygon",
  "196": "XLayer",
  "42161": "Arbitrum",
  "8453": "Base",
  "43114": "Avalanche",
  "10": "Optimism",
  "324": "zkSync Era",
  "59144": "Linea",
  "534352": "Scroll",
};

export const NATIVE_TOKEN_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
