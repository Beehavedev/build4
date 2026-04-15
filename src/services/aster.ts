import crypto from "crypto";

const ASTER_BASE = "https://fapi.asterdex.com";

function getBrokerKeys(): { apiKey: string; apiSecret: string } {
  const apiKey = process.env.ASTER_API_KEY;
  const apiSecret = process.env.ASTER_API_SECRET;
  if (!apiKey || !apiSecret) throw new Error("ASTER_API_KEY / ASTER_API_SECRET not configured");
  return { apiKey, apiSecret };
}

function createSignature(queryString: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(queryString).digest("hex");
}

async function asterRequest(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, string> = {}): Promise<any> {
  const { apiKey, apiSecret } = getBrokerKeys();
  const timestamp = Date.now().toString();
  const allParams = { ...params, timestamp, recvWindow: "5000" };
  const queryString = Object.entries(allParams).map(([k, v]) => `${k}=${v}`).join("&");
  const signature = createSignature(queryString, apiSecret);
  const fullQuery = `${queryString}&signature=${signature}`;

  const url = `${ASTER_BASE}${path}?${fullQuery}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-ASTER-APIKEY": apiKey,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Aster API ${res.status}: ${text}`);
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
  try {
    const data = await asterRequest("GET", "/fapi/v1/account");
    console.log("[ASTER] Broker account keys:", Object.keys(data));
    return parseAccountData(data);
  } catch (err: any) {
    console.log("[ASTER] Account failed:", err.message?.substring(0, 120));
  }

  try {
    const data = await asterRequest("GET", "/fapi/v1/balance");
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
    console.log("[ASTER] Balance failed:", err.message?.substring(0, 120));
  }

  console.error("[ASTER] Broker auth failed — check ASTER_API_KEY/ASTER_API_SECRET");
  return { accountValue: 0, availableBalance: 0, marginUsed: 0, unrealizedPnl: 0, coin: "USDF" };
}

export async function getAsterPositions(): Promise<AsterPosition[]> {
  try {
    const data = await asterRequest("GET", "/fapi/v1/positionRisk");
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
  } catch (err: any) {
    console.error("[ASTER] Positions fetch error:", err.message);
    return [];
  }
}

export async function openAsterPosition(params: {
  pair: string;
  side: "LONG" | "SHORT";
  size: number;
  leverage: number;
}): Promise<{ success: boolean; orderId?: string; error?: string }> {
  try {
    const asterSide = params.side === "LONG" ? "BUY" : "SELL";
    const data = await asterRequest("POST", "/fapi/v1/order", {
      symbol: params.pair.replace("/", ""),
      side: asterSide,
      type: "MARKET",
      quantity: params.size.toString(),
      leverage: params.leverage.toString(),
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
    const data = await asterRequest("POST", "/fapi/v1/order", {
      symbol: params.pair.replace("/", ""),
      side: closeSide,
      type: "MARKET",
      quantity: params.size.toString(),
      reduceOnly: "true",
    });
    console.log("[ASTER] Close order:", JSON.stringify(data)?.substring(0, 200));
    return { success: true, orderId: data.orderId?.toString() || data.clientOrderId };
  } catch (err: any) {
    console.error("[ASTER] Close failed:", err.message);
    return { success: false, error: err.message };
  }
}
