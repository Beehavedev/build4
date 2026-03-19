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
    throw new Error(`OKX API error ${response.status}: ${text}`);
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
      slippage: params.slippage || "1",
      feePercent: BUILD4_FEE_PERCENT,
    });
  } catch (err: any) {
    if (err.message?.includes("50050")) {
      throw new Error("Cross-chain bridge is temporarily unavailable on OKX. Please try again later or use the DEX swap on a single chain.");
    }
    throw err;
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
      slippage: params.slippage || "1",
      feePercent: BUILD4_FEE_PERCENT,
      referrerAddress: BUILD4_TREASURY,
    });
  } catch (err: any) {
    if (err.message?.includes("50050")) {
      throw new Error("Cross-chain bridge is temporarily unavailable on OKX. Please try again later or use the DEX swap on a single chain.");
    }
    throw err;
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
