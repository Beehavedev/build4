import { ethers } from "ethers";

const ASTER_V3 = "https://fapi3.asterdex.com";
const ASTER_V1 = "https://fapi.asterdex.com";

let ASTER_BASE = ASTER_V1;

function getProxyUrl(): string | null {
  return process.env.ASTER_PROXY_URL || null;
}

function getProxySecret(): string | null {
  return process.env.ASTER_PROXY_SECRET || null;
}

function buildUrl(path: string): string {
  const proxy = getProxyUrl();
  if (proxy) {
    const base = proxy.endsWith("/") ? proxy.slice(0, -1) : proxy;
    return `${base}/aster-proxy${path}`;
  }
  return `${ASTER_BASE}${path}`;
}

function getBrokerWallet(): ethers.Wallet {
  const pk = process.env.ASTER_BROKER_PK;
  if (!pk) throw new Error("ASTER_BROKER_PK not configured");
  let key = pk.trim();
  if (!key.startsWith("0x")) key = "0x" + key;
  return new ethers.Wallet(key);
}

async function asterProApiRequest(method: "GET" | "POST" | "DELETE", path: string, body?: Record<string, any>): Promise<any> {
  const wallet = getBrokerWallet();
  const nonce = (Date.now() * 1000).toString();

  const domain = { name: "AsterSignTransaction", chainId: 1666 };
  const types = {
    AsterSignTransaction: [
      { name: "method", type: "string" },
      { name: "nonce", type: "uint256" },
    ],
  };
  const value = { method: `${method} ${path}`, nonce };
  const signature = await wallet.signTypedData(domain, types, value);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "ASTER-SIGNATURE": signature,
    "ASTER-NONCE": nonce,
    "ASTER-ADDRESS": wallet.address,
  };

  const proxySecret = getProxySecret();
  if (proxySecret) {
    headers["X-PROXY-SECRET"] = proxySecret;
  }

  const url = buildUrl(path);
  const fetchOpts: RequestInit = { method, headers };
  if (body && (method === "POST" || method === "DELETE")) {
    fetchOpts.body = JSON.stringify(body);
  }

  const res = await fetch(url, fetchOpts);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Aster Pro API ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

export async function detectWorkingEndpoint(): Promise<string> {
  const wallet = getBrokerWallet();
  console.log(`[ASTER] Broker wallet address: ${wallet.address}`);

  const proxy = getProxyUrl();
  if (proxy) {
    console.log(`[ASTER] Proxy configured: ${proxy}`);
    try {
      const data = await asterProApiRequest("GET", "/fapi/v3/account");
      console.log(`[ASTER] ✅ Proxy working! Account keys: ${Object.keys(data)}`);
      return proxy;
    } catch (err: any) {
      console.log(`[ASTER] Proxy test failed: ${err.message?.substring(0, 150)}`);
      console.log(`[ASTER] Falling back to direct connections...`);
    }
  }

  const tests = [
    { base: ASTER_V3, path: "/fapi/v3/account", label: "V3 fapi3" },
    { base: ASTER_V3, path: "/fapi/v1/account", label: "V1 on fapi3" },
    { base: ASTER_V1, path: "/fapi/v3/account", label: "V3 on fapi1" },
    { base: ASTER_V1, path: "/fapi/v1/account", label: "V1 on fapi1" },
  ];

  for (const { base, path, label } of tests) {
    try {
      const nonce = (Date.now() * 1000).toString();
      const domain = { name: "AsterSignTransaction", chainId: 1666 };
      const types = {
        AsterSignTransaction: [
          { name: "method", type: "string" },
          { name: "nonce", type: "uint256" },
        ],
      };
      const sig = await wallet.signTypedData(domain, types, { method: `GET ${path}`, nonce });

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "ASTER-SIGNATURE": sig,
        "ASTER-NONCE": nonce,
        "ASTER-ADDRESS": wallet.address,
      };

      const res = await fetch(`${base}${path}`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10000),
      });

      const body = await res.text();
      console.log(`[ASTER] ${label} (${base}${path}) → ${res.status}: ${body.substring(0, 150)}`);

      if (res.ok) {
        ASTER_BASE = base;
        console.log(`[ASTER] ✅ Working endpoint: ${base} with ${path}`);
        return base;
      }
    } catch (err: any) {
      console.log(`[ASTER] ${label} → error: ${err.message?.substring(0, 100)}`);
    }
  }

  console.log(`[ASTER] No working endpoint found, defaulting to ${ASTER_V3}`);
  ASTER_BASE = ASTER_V3;
  return ASTER_V3;
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
  try {
    const data = await asterProApiRequest("GET", "/fapi/v1/account");
    console.log("[ASTER] Broker account keys:", Object.keys(data));
    return parseAccountData(data);
  } catch (err: any) {
    console.log("[ASTER] Account failed:", err.message?.substring(0, 150));
  }

  try {
    const data = await asterProApiRequest("GET", "/fapi/v1/balance");
    console.log("[ASTER] Balance response:", JSON.stringify(data)?.substring(0, 200));
    if (Array.isArray(data)) {
      const usd = data.find((a: any) => a.asset === "USDF" || a.asset === "USDT" || a.asset === "USD");
      if (usd) {
        return {
          accountValue: parseFloat(usd.balance || usd.walletBalance || "0"),
          availableBalance: parseFloat(usd.availableBalance || usd.crossWalletBalance || "0"),
          marginUsed: parseFloat(usd.initialMargin || "0"),
          unrealizedPnl: parseFloat(usd.crossUnPnl || usd.unrealizedProfit || "0"),
          coin: usd.asset || "USDF",
        };
      }
    }
  } catch (err: any) {
    console.log("[ASTER] Balance failed:", err.message?.substring(0, 150));
  }

  try {
    const data = await asterProApiRequest("GET", "/fapi/v3/account");
    console.log("[ASTER] V3 Account response keys:", Object.keys(data));
    return parseAccountData(data);
  } catch (err: any) {
    console.log("[ASTER] V3 Account failed:", err.message?.substring(0, 150));
  }

  console.error("[ASTER] All auth methods failed — check ASTER_BROKER_PK");
  return { accountValue: 0, availableBalance: 0, marginUsed: 0, unrealizedPnl: 0, coin: "USDF" };
}

export async function getAsterPositions(): Promise<AsterPosition[]> {
  for (const path of ["/fapi/v1/positionRisk", "/fapi/v3/positionRisk"]) {
    try {
      const data = await asterProApiRequest("GET", path);
      if (!Array.isArray(data)) continue;

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
    } catch (err: any) {
      console.log(`[ASTER] Positions ${path} failed:`, err.message?.substring(0, 100));
    }
  }
  return [];
}

export async function openAsterPosition(params: {
  pair: string;
  side: "LONG" | "SHORT";
  size: number;
  leverage: number;
}): Promise<{ success: boolean; orderId?: string; error?: string }> {
  try {
    const asterSide = params.side === "LONG" ? "BUY" : "SELL";
    const data = await asterProApiRequest("POST", "/fapi/v1/order", {
      symbol: params.pair.replace("/", ""),
      side: asterSide,
      type: "MARKET",
      quantity: params.size,
      leverage: params.leverage,
    });
    console.log("[ASTER] Order placed:", JSON.stringify(data)?.substring(0, 200));
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
    const closeSide = params.side === "LONG" ? "SELL" : "BUY";
    const data = await asterProApiRequest("POST", "/fapi/v1/order", {
      symbol: params.pair.replace("/", ""),
      side: closeSide,
      type: "MARKET",
      quantity: params.size,
      reduceOnly: true,
    });
    console.log("[ASTER] Close order:", JSON.stringify(data)?.substring(0, 200));
    return { success: true, orderId: data.orderId?.toString() || data.clientOrderId };
  } catch (err: any) {
    console.error("[ASTER] Close failed:", err.message);
    return { success: false, error: err.message };
  }
}
