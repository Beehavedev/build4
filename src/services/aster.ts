import { ethers } from "ethers";
import crypto from "crypto";

const ASTER_BASE = "https://fapi.asterdex.com";

function makeTimestamp(): string {
  return Date.now().toString();
}

function createSignature(queryString: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(queryString).digest("hex");
}

async function asterAuthGet(apiKey: string, apiSecret: string, path: string, params: Record<string, string> = {}): Promise<any> {
  const timestamp = makeTimestamp();
  const allParams = { ...params, timestamp, recvWindow: "5000" };
  const queryString = Object.entries(allParams).map(([k, v]) => `${k}=${v}`).join("&");
  const signature = createSignature(queryString, apiSecret);
  const fullQuery = `${queryString}&signature=${signature}`;

  const url = `${ASTER_BASE}${path}?${fullQuery}`;
  const res = await fetch(url, {
    method: "GET",
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

async function asterWalletAuthGet(wallet: ethers.Wallet, path: string): Promise<any> {
  const domain = { name: "AsterSignTransaction", chainId: 1666 };
  const types = { AsterSignTransaction: [{ name: "method", type: "string" }, { name: "nonce", type: "uint256" }] };
  const nonce = (Date.now() * 1000).toString();
  const value = { method: `GET ${path}`, nonce };
  const signature = await wallet.signTypedData(domain, types, value);

  const url = `${ASTER_BASE}${path}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "ASTER-SIGNATURE": signature,
      "ASTER-NONCE": nonce,
      "ASTER-ADDRESS": wallet.address,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Aster EIP712 ${res.status}: ${text}`);
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

export async function getAsterAccountBalance(apiKey: string, apiSecret: string): Promise<AsterBalance> {
  try {
    const data = await asterAuthGet(apiKey, apiSecret, "/fapi/v1/account");
    console.log("[ASTER] Account response keys:", Object.keys(data));
    return parseAccountData(data);
  } catch (err: any) {
    console.log("[ASTER] Account failed:", err.message?.substring(0, 120));
  }

  try {
    const data = await asterAuthGet(apiKey, apiSecret, "/fapi/v1/balance");
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

  console.error("[ASTER] Auth failed — check API key/secret");
  return { accountValue: 0, availableBalance: 0, marginUsed: 0, unrealizedPnl: 0, coin: "USDF" };
}

export async function getAsterPositions(privateKey: string): Promise<AsterPosition[]> {
  try {
    const wallet = new ethers.Wallet(privateKey);
    const data = await asterGet(wallet, "/fapi/v3/positionRisk");

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
}): Promise<{ success: boolean; txHash?: string; error?: string }> {
  console.log(`[ASTER] Mock open: ${params.side} ${params.pair} $${params.size} ${params.leverage}x`);
  return {
    success: true,
    txHash: "0x" + Math.random().toString(16).slice(2, 18),
  };
}

export async function closeAsterPosition(params: {
  pair: string;
}): Promise<{ success: boolean; txHash?: string }> {
  console.log(`[ASTER] Mock close: ${params.pair}`);
  return {
    success: true,
    txHash: "0x" + Math.random().toString(16).slice(2, 18),
  };
}
