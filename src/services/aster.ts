import { ethers } from "ethers";

const ASTER_BASE = "https://fapi3.asterdex.com";
const ASTER_DOMAIN = {
  name: "AsterSignTransaction",
  chainId: 1666,
};

const AUTH_TYPES = {
  AsterSignTransaction: [
    { name: "method", type: "string" },
    { name: "nonce", type: "uint256" },
  ],
};

function makeNonce(): string {
  return (Date.now() * 1000).toString();
}

async function signRequest(wallet: ethers.Wallet, method: string): Promise<{ signature: string; nonce: string; address: string }> {
  const nonce = makeNonce();
  const value = { method, nonce };
  const signature = await wallet.signTypedData(ASTER_DOMAIN, AUTH_TYPES, value);
  return { signature, nonce, address: wallet.address };
}

async function asterGet(wallet: ethers.Wallet, path: string): Promise<any> {
  const method = "GET " + path;
  const { signature, nonce, address } = await signRequest(wallet, method);

  const url = `${ASTER_BASE}${path}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "ASTER-SIGNATURE": signature,
      "ASTER-NONCE": nonce,
      "ASTER-ADDRESS": address,
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

export async function getAsterAccountBalance(privateKey: string): Promise<AsterBalance> {
  try {
    const wallet = new ethers.Wallet(privateKey);
    const data = await asterGet(wallet, "/fapi/v3/account");

    if (data && data.assets) {
      const usdAsset = data.assets.find((a: any) => a.asset === "USDF" || a.asset === "USDT" || a.asset === "USD");
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
  } catch (err: any) {
    console.error("[ASTER] Balance fetch error:", err.message);
    return { accountValue: 0, availableBalance: 0, marginUsed: 0, unrealizedPnl: 0, coin: "USDF" };
  }
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
