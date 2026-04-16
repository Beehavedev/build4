import { ethers } from "ethers";

const BASE_URL = "https://fapi.asterdex.com";

const EIP712_DOMAIN = {
  name: "AsterSignTransaction",
  version: "1",
  chainId: 1666,
  verifyingContract: ethers.ZeroAddress,
};

const EIP712_TYPES = {
  Message: [{ name: "msg", type: "string" }],
};

function getBrokerWallet(): ethers.Wallet {
  const pk = process.env.ASTER_BROKER_PK;
  if (!pk) throw new Error("ASTER_BROKER_PK not configured");
  let key = pk.trim();
  if (!key.startsWith("0x")) key = "0x" + key;
  return new ethers.Wallet(key);
}

function buildQueryString(params: Record<string, string | number | boolean | undefined>): string {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== "")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
}

function getNonce(): string {
  return String(Math.floor(Date.now() * 1000));
}

async function signedRequest(method: "GET" | "POST" | "DELETE", path: string, extraParams: Record<string, any> = {}): Promise<any> {
  const wallet = getBrokerWallet();
  const userAddr = process.env.ASTER_USER_ADDRESS || wallet.address;
  const signerAddr = process.env.ASTER_SIGNER_ADDRESS || userAddr;

  const params: Record<string, any> = {
    ...extraParams,
    timestamp: Date.now(),
    recvWindow: 5000,
    user: userAddr,
    signer: signerAddr,
    nonce: getNonce(),
  };

  const queryString = buildQueryString(params);
  const signature = await wallet.signTypedData(EIP712_DOMAIN, EIP712_TYPES, { msg: queryString });

  const url = `${BASE_URL}${path}?${queryString}&signature=${signature}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    "X-MBX-APIKEY": process.env.ASTER_API_KEY || "",
  };

  const fetchOpts: RequestInit = { method, headers };
  if (method === "POST" || method === "DELETE") {
    fetchOpts.body = `${queryString}&signature=${signature}`;
  }

  const res = await fetch(url, { ...fetchOpts, signal: AbortSignal.timeout(15000) });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Aster ${method} ${path} ${res.status}: ${text.substring(0, 200)}`);
  }

  return res.json();
}

async function publicRequest(path: string, params: Record<string, any> = {}): Promise<any> {
  const qs = buildQueryString(params);
  const url = qs ? `${BASE_URL}${path}?${qs}` : `${BASE_URL}${path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Aster GET ${path} ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

export interface AsterBalance {
  accountValue: number;
  availableBalance: number;
  marginUsed: number;
  unrealizedPnl: number;
  coin: string;
}

export interface AsterPosition {
  pair: string;
  side: string;
  size: number;
  entryPrice: number;
  markPrice: number;
  leverage: number;
  pnl: number;
  liquidationPrice: number;
}

function parseAccountData(data: any): AsterBalance {
  if (data && data.assets) {
    const usdAsset = data.assets.find((a: any) =>
      a.asset === "USDF" || a.asset === "USDT" || a.asset === "USD"
    );
    return {
      accountValue: parseFloat(usdAsset?.walletBalance || data.totalWalletBalance || "0"),
      availableBalance: parseFloat(usdAsset?.availableBalance || data.availableBalance || "0"),
      marginUsed: parseFloat(usdAsset?.initialMargin || data.totalInitialMargin || "0"),
      unrealizedPnl: parseFloat(usdAsset?.unrealizedProfit || data.totalUnrealizedProfit || "0"),
      coin: usdAsset?.asset || "USDF",
    };
  }
  return {
    accountValue: parseFloat(data?.totalWalletBalance || "0"),
    availableBalance: parseFloat(data?.availableBalance || "0"),
    marginUsed: parseFloat(data?.totalInitialMargin || "0"),
    unrealizedPnl: parseFloat(data?.totalUnrealizedProfit || "0"),
    coin: "USDF",
  };
}

export async function getBrokerAccountBalance(): Promise<AsterBalance> {
  const data = await signedRequest("GET", "/fapi/v3/account");
  return parseAccountData(data);
}

export async function getAsterBalances(): Promise<any[]> {
  return signedRequest("GET", "/fapi/v3/balance");
}

export async function getAsterPositions(): Promise<AsterPosition[]> {
  const data = await signedRequest("GET", "/fapi/v3/positionRisk");
  if (!Array.isArray(data)) return [];
  return data
    .filter((p: any) => parseFloat(p.positionAmt) !== 0)
    .map((p: any) => ({
      pair: p.symbol,
      side: parseFloat(p.positionAmt) > 0 ? "LONG" : "SHORT",
      size: Math.abs(parseFloat(p.positionAmt)),
      entryPrice: parseFloat(p.entryPrice),
      markPrice: parseFloat(p.markPrice),
      leverage: parseInt(p.leverage || "1"),
      pnl: parseFloat(p.unRealizedProfit || "0"),
      liquidationPrice: parseFloat(p.liquidationPrice || "0"),
    }));
}

export async function openAsterPosition(params: {
  pair: string;
  side: "LONG" | "SHORT";
  size: number;
  leverage: number;
}): Promise<{ success: boolean; orderId?: string; error?: string }> {
  try {
    const data = await signedRequest("POST", "/fapi/v3/order", {
      symbol: params.pair.replace("/", ""),
      side: params.side === "LONG" ? "BUY" : "SELL",
      type: "MARKET",
      quantity: String(params.size),
    });
    return { success: true, orderId: data.orderId?.toString() || data.clientOrderId };
  } catch (err: any) {
    console.error("[ASTER] Order failed:", err.message);
    return { success: false, error: err.message };
  }
}

export async function closeAsterPosition(params: {
  pair: string;
  side: "LONG" | "SHORT";
  size: number;
}): Promise<{ success: boolean; orderId?: string; error?: string }> {
  try {
    const data = await signedRequest("POST", "/fapi/v3/order", {
      symbol: params.pair.replace("/", ""),
      side: params.side === "LONG" ? "SELL" : "BUY",
      type: "MARKET",
      quantity: String(params.size),
      reduceOnly: "true",
    });
    return { success: true, orderId: data.orderId?.toString() || data.clientOrderId };
  } catch (err: any) {
    console.error("[ASTER] Close failed:", err.message);
    return { success: false, error: err.message };
  }
}

export async function getTickerPrice(symbol?: string): Promise<any> {
  const params: Record<string, any> = {};
  if (symbol) params.symbol = symbol;
  return publicRequest("/fapi/v3/ticker/price", params);
}

export async function getKlines(symbol: string, interval: string = "1h", limit: number = 100): Promise<any[]> {
  return publicRequest("/fapi/v3/klines", { symbol, interval, limit });
}

export async function getOpenOrders(symbol?: string): Promise<any[]> {
  const params: Record<string, any> = {};
  if (symbol) params.symbol = symbol;
  return signedRequest("GET", "/fapi/v3/openOrders", params);
}

export async function cancelOrder(symbol: string, orderId?: string): Promise<any> {
  const params: Record<string, any> = { symbol };
  if (orderId) params.orderId = orderId;
  return signedRequest("DELETE", "/fapi/v3/order", params);
}

export async function detectWorkingEndpoint(): Promise<string> {
  const wallet = getBrokerWallet();
  console.log(`[ASTER] Broker wallet: ${wallet.address}`);
  try {
    const data = await getBrokerAccountBalance();
    console.log(`[ASTER] Connected — balance: $${data.accountValue.toFixed(2)} (${data.coin})`);
    return BASE_URL;
  } catch (err: any) {
    console.error(`[ASTER] Connection failed: ${err.message?.substring(0, 150)}`);
    return BASE_URL;
  }
}
