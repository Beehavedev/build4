import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";

const OKX_BASE_URL = "https://web3.okx.com/api/v5";

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

async function okxRequest(
  method: string,
  path: string,
  params?: Record<string, string>,
  body?: any
): Promise<any> {
  let fullPath = path;
  let queryString = "";

  if (params && method === "GET") {
    queryString = "?" + new URLSearchParams(params).toString();
    fullPath = path + queryString;
  }

  const bodyStr = body ? JSON.stringify(body) : "";
  const headers = getHeaders(method, fullPath, bodyStr);
  const url = `${OKX_BASE_URL}${fullPath}`;

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

export async function getSwapQuote(params: {
  chainId: string;
  fromTokenAddress: string;
  toTokenAddress: string;
  amount: string;
  slippage?: string;
}): Promise<any> {
  const queryParams: Record<string, string> = {
    chainId: params.chainId,
    fromTokenAddress: params.fromTokenAddress,
    toTokenAddress: params.toTokenAddress,
    amount: params.amount,
    slippage: params.slippage || "0.5",
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
    chainId: params.chainId,
    fromTokenAddress: params.fromTokenAddress,
    toTokenAddress: params.toTokenAddress,
    amount: params.amount,
    slippage: params.slippage || "0.5",
    userWalletAddress: params.userWalletAddress,
  };

  return okxRequest("GET", "/dex/aggregator/swap", queryParams);
}

export async function getApproveTransaction(params: {
  chainId: string;
  tokenContractAddress: string;
  approveAmount: string;
}): Promise<any> {
  return okxRequest("GET", "/dex/aggregator/approve-transaction", {
    chainId: params.chainId,
    tokenContractAddress: params.tokenContractAddress,
    approveAmount: params.approveAmount,
  });
}

export async function getSupportedTokens(chainId: string): Promise<any> {
  return okxRequest("GET", "/dex/aggregator/all-tokens", { chainId });
}

export async function getLiquidity(chainId: string): Promise<any> {
  return okxRequest("GET", "/dex/aggregator/get-liquidity", { chainId });
}

export async function getTokenPrice(params: {
  chainId: string;
  tokenAddress: string;
}): Promise<any> {
  return okxRequest("GET", "/market/token/detail", {
    chainId: params.chainId,
    tokenContractAddress: params.tokenAddress,
  });
}

export async function getTokenMarketData(params: {
  chainId: string;
  tokenAddress: string;
}): Promise<any> {
  return okxRequest("GET", "/market/token/trading-data", {
    chainId: params.chainId,
    tokenContractAddress: params.tokenAddress,
  });
}

export async function getTopTokens(chainId: string): Promise<any> {
  return okxRequest("GET", "/market/token/top-tokens", { chainId });
}

export async function getTrendingTokens(chainId: string): Promise<any> {
  return okxRequest("GET", "/market/token/trending-tokens", { chainId });
}

export async function getTokenHolders(params: {
  chainId: string;
  tokenAddress: string;
}): Promise<any> {
  return okxRequest("GET", "/market/token/holder-distribution", {
    chainId: params.chainId,
    tokenContractAddress: params.tokenAddress,
  });
}

export async function getCrossChainQuote(params: {
  fromChainId: string;
  toChainId: string;
  fromTokenAddress: string;
  toTokenAddress: string;
  amount: string;
  slippage?: string;
}): Promise<any> {
  return okxRequest("GET", "/dex/cross-chain/quote", {
    fromChainId: params.fromChainId,
    toChainId: params.toChainId,
    fromTokenAddress: params.fromTokenAddress,
    toTokenAddress: params.toTokenAddress,
    amount: params.amount,
    slippage: params.slippage || "1",
  });
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
  return okxRequest("GET", "/dex/cross-chain/build-tx", {
    fromChainId: params.fromChainId,
    toChainId: params.toChainId,
    fromTokenAddress: params.fromTokenAddress,
    toTokenAddress: params.toTokenAddress,
    amount: params.amount,
    userWalletAddress: params.userWalletAddress,
    slippage: params.slippage || "1",
  });
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
  return okxRequest("GET", "/dex/cross-chain/supported/chain");
}

export async function getWalletTokenBalances(params: {
  address: string;
  chainId: string;
}): Promise<any> {
  return okxRequest("GET", "/wallet/asset/token-balances", {
    address: params.address,
    chainIndex: params.chainId,
  });
}

export async function getWalletTransactionHistory(params: {
  address: string;
  chainId: string;
  limit?: string;
}): Promise<any> {
  return okxRequest("GET", "/wallet/transaction/get-transactions", {
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
