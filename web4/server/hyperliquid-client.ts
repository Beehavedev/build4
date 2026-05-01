import { ethers } from "ethers";

const MAINNET_API_URL = "https://api.hyperliquid.xyz";
const TESTNET_API_URL = "https://api.hyperliquid-testnet.xyz";

const L1_DOMAIN = {
  name: "Exchange",
  version: "1",
  chainId: 1337,
  verifyingContract: "0x0000000000000000000000000000000000000000",
};

const AGENT_TYPES = {
  Agent: [
    { name: "source", type: "string" },
    { name: "connectionId", type: "bytes32" },
  ],
};

const USER_SIGNED_DOMAIN = {
  name: "HyperliquidSignTransaction",
  version: "1",
  chainId: 421614,
  verifyingContract: "0x0000000000000000000000000000000000000000",
};

const APPROVE_AGENT_TYPES = {
  "HyperliquidTransaction:ApproveAgent": [
    { name: "hyperliquidChain", type: "string" },
    { name: "agentAddress", type: "address" },
    { name: "agentName", type: "string" },
    { name: "nonce", type: "uint64" },
  ],
};

const APPROVE_BUILDER_FEE_TYPES = {
  "HyperliquidTransaction:ApproveBuilderFee": [
    { name: "hyperliquidChain", type: "string" },
    { name: "maxFeeRate", type: "string" },
    { name: "builder", type: "address" },
    { name: "nonce", type: "uint64" },
  ],
};

function floatToWire(x: number): string {
  const rounded = x.toFixed(8);
  let normalized = parseFloat(rounded).toString();
  if (normalized === "-0") normalized = "0";
  return normalized;
}

function floatToIntForHashing(x: number): number {
  return Math.round(x * 1e8);
}

function addressToBytes(address: string): Buffer {
  const hex = address.startsWith("0x") ? address.slice(2) : address;
  return Buffer.from(hex, "hex");
}

async function actionHash(
  action: Record<string, any>,
  vaultAddress: string | null,
  nonce: number,
  expiresAfter: number | null,
): Promise<string> {
  const { encode } = await import("@msgpack/msgpack");
  const packed = encode(action);
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64BE(BigInt(nonce));

  const parts: Buffer[] = [Buffer.from(packed), nonceBuf];

  if (vaultAddress === null) {
    parts.push(Buffer.from([0x00]));
  } else {
    parts.push(Buffer.from([0x01]));
    parts.push(addressToBytes(vaultAddress));
  }

  if (expiresAfter !== null) {
    parts.push(Buffer.from([0x00]));
    const expBuf = Buffer.alloc(8);
    expBuf.writeBigUInt64BE(BigInt(expiresAfter));
    parts.push(expBuf);
  }

  const data = Buffer.concat(parts);
  return ethers.keccak256(data);
}

function constructPhantomAgent(hash: string, isMainnet: boolean) {
  return { source: isMainnet ? "a" : "b", connectionId: hash };
}

async function signL1Action(
  wallet: ethers.Wallet,
  action: Record<string, any>,
  vaultAddress: string | null,
  nonce: number,
  expiresAfter: number | null,
  isMainnet: boolean,
): Promise<{ r: string; s: string; v: number }> {
  const hash = await actionHash(action, vaultAddress, nonce, expiresAfter);
  const phantomAgent = constructPhantomAgent(hash, isMainnet);
  const sig = await wallet.signTypedData(L1_DOMAIN, AGENT_TYPES, phantomAgent);
  const { r, s, v } = ethers.Signature.from(sig);
  return { r, s, v };
}

function signUserSignedAction(
  wallet: ethers.Wallet,
  action: Record<string, any>,
  types: Record<string, { name: string; type: string }[]>,
  primaryType: string,
  isMainnet: boolean,
): Promise<{ r: string; s: string; v: number }> {
  const message = {
    ...action,
    hyperliquidChain: isMainnet ? "Mainnet" : "Testnet",
    signatureChainId: "0x66eee",
  };
  return (async () => {
    const sig = await wallet.signTypedData(USER_SIGNED_DOMAIN, types, message);
    const { r, s, v } = ethers.Signature.from(sig);
    return { r, s, v };
  })();
}

function getTimestampMs(): number {
  return Date.now();
}

export interface HyperliquidConfig {
  baseUrl: string;
  isMainnet: boolean;
}

export function getMainnetConfig(): HyperliquidConfig {
  return { baseUrl: MAINNET_API_URL, isMainnet: true };
}

export function getTestnetConfig(): HyperliquidConfig {
  return { baseUrl: TESTNET_API_URL, isMainnet: false };
}

async function postInfo(baseUrl: string, body: Record<string, any>): Promise<any> {
  const res = await fetch(`${baseUrl}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Hyperliquid info error ${res.status}: ${text}`);
  }
  return res.json();
}

async function postExchange(
  baseUrl: string,
  action: Record<string, any>,
  signature: { r: string; s: string; v: number },
  nonce: number,
  vaultAddress: string | null = null,
  expiresAfter: number | null = null,
): Promise<any> {
  const payload: Record<string, any> = {
    action,
    nonce,
    signature,
    vaultAddress: vaultAddress || null,
  };
  if (expiresAfter !== null) {
    payload.expiresAfter = expiresAfter;
  }
  const res = await fetch(`${baseUrl}/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Hyperliquid exchange error ${res.status}: ${text}`);
  }
  return res.json();
}

export interface OrderRequest {
  coin: string;
  isBuy: boolean;
  sz: number;
  limitPx: number;
  orderType: { limit: { tif: "Alo" | "Ioc" | "Gtc" } } | { trigger: { isMarket: boolean; triggerPx: number; tpsl: "tp" | "sl" } };
  reduceOnly?: boolean;
  cloid?: string;
}

function orderToWire(order: OrderRequest, asset: number): Record<string, any> {
  const wire: Record<string, any> = {
    a: asset,
    b: order.isBuy,
    p: floatToWire(order.limitPx),
    s: floatToWire(order.sz),
    r: order.reduceOnly || false,
    t: "limit" in order.orderType
      ? { limit: order.orderType.limit }
      : { trigger: { isMarket: (order.orderType as any).trigger.isMarket, triggerPx: floatToWire((order.orderType as any).trigger.triggerPx), tpsl: (order.orderType as any).trigger.tpsl } },
  };
  if (order.cloid) {
    wire.c = order.cloid;
  }
  return wire;
}

export function createHyperliquidInfoClient(config: HyperliquidConfig) {
  const { baseUrl } = config;

  return {
    async getMeta(): Promise<any> {
      return postInfo(baseUrl, { type: "meta" });
    },

    async getSpotMeta(): Promise<any> {
      return postInfo(baseUrl, { type: "spotMeta" });
    },

    async getAllMids(): Promise<Record<string, string>> {
      return postInfo(baseUrl, { type: "allMids" });
    },

    async getUserState(userAddress: string): Promise<any> {
      return postInfo(baseUrl, { type: "clearinghouseState", user: userAddress });
    },

    async getSpotUserState(userAddress: string): Promise<any> {
      return postInfo(baseUrl, { type: "spotClearinghouseState", user: userAddress });
    },

    async getOpenOrders(userAddress: string): Promise<any[]> {
      return postInfo(baseUrl, { type: "openOrders", user: userAddress });
    },

    async getFrontendOpenOrders(userAddress: string): Promise<any[]> {
      return postInfo(baseUrl, { type: "frontendOpenOrders", user: userAddress });
    },

    async getUserFills(userAddress: string, aggregateByTime?: boolean): Promise<any[]> {
      const body: Record<string, any> = { type: "userFills", user: userAddress };
      if (aggregateByTime !== undefined) body.aggregateByTime = aggregateByTime;
      return postInfo(baseUrl, body);
    },

    async getL2Book(coin: string, nSigFigs?: number): Promise<any> {
      const body: Record<string, any> = { type: "l2Book", coin };
      if (nSigFigs) body.nSigFigs = nSigFigs;
      return postInfo(baseUrl, body);
    },

    async getCandleSnapshot(coin: string, interval: string, startTime: number, endTime?: number): Promise<any[]> {
      const body: Record<string, any> = { type: "candleSnapshot", req: { coin, interval, startTime } };
      if (endTime) body.req.endTime = endTime;
      return postInfo(baseUrl, body);
    },

    async getFundingHistory(coin: string, startTime: number, endTime?: number): Promise<any[]> {
      const body: Record<string, any> = { type: "fundingHistory", coin, startTime };
      if (endTime) body.endTime = endTime;
      return postInfo(baseUrl, body);
    },

    async getMetaAndAssetCtxs(): Promise<any> {
      return postInfo(baseUrl, { type: "metaAndAssetCtxs" });
    },

    async getUserFunding(userAddress: string, startTime: number, endTime?: number): Promise<any[]> {
      const body: Record<string, any> = { type: "userFunding", user: userAddress, startTime };
      if (endTime) body.endTime = endTime;
      return postInfo(baseUrl, body);
    },

    async getOrderStatus(userAddress: string, oid: number): Promise<any> {
      return postInfo(baseUrl, { type: "orderStatus", user: userAddress, oid });
    },

    async getSubAccounts(userAddress: string): Promise<any[]> {
      return postInfo(baseUrl, { type: "subAccounts", user: userAddress });
    },
  };
}

export function createHyperliquidExchangeClient(
  privateKey: string,
  config: HyperliquidConfig,
  vaultAddress: string | null = null,
) {
  const wallet = new ethers.Wallet(privateKey);
  const userAddress = wallet.address;
  const { baseUrl, isMainnet } = config;

  let assetMap: Record<string, number> = {};
  let metaLoaded = false;

  async function ensureMeta() {
    if (metaLoaded) return;
    try {
      const meta = await postInfo(baseUrl, { type: "meta" });
      if (meta?.universe) {
        meta.universe.forEach((u: any, i: number) => {
          assetMap[u.name] = i;
        });
      }
      metaLoaded = true;
    } catch (e) {
      console.error("[HL] Failed to load meta:", e);
    }
  }

  function getAssetIndex(coin: string): number {
    if (coin in assetMap) return assetMap[coin];
    throw new Error(`Unknown coin: ${coin}. Call ensureMeta first or use asset index directly.`);
  }

  return {
    userAddress,

    async placeOrder(
      orders: OrderRequest[],
      grouping: "na" | "normalTpsl" | "positionTpsl" = "na",
      builder?: { b: string; f: number },
    ): Promise<any> {
      await ensureMeta();
      const orderWires = orders.map((o) => orderToWire(o, getAssetIndex(o.coin)));
      const action: Record<string, any> = {
        type: "order",
        orders: orderWires,
        grouping,
      };
      if (builder) {
        action.builder = { b: builder.b.toLowerCase(), f: builder.f };
      }
      const nonce = getTimestampMs();
      const signature = await signL1Action(wallet, action, vaultAddress, nonce, null, isMainnet);
      return postExchange(baseUrl, action, signature, nonce, vaultAddress);
    },

    async marketOrder(
      coin: string,
      isBuy: boolean,
      sz: number,
      slippage: number = 0.05,
      builder?: { b: string; f: number },
    ): Promise<any> {
      await ensureMeta();
      const mids = await postInfo(baseUrl, { type: "allMids" });
      const mid = parseFloat(mids[coin]);
      if (!mid) throw new Error(`No mid price for ${coin}`);
      const px = isBuy ? mid * (1 + slippage) : mid * (1 - slippage);
      const sigFigs = getSigFigs(mid);
      const roundedPx = roundToSigFigs(px, sigFigs);
      return this.placeOrder(
        [{ coin, isBuy, sz, limitPx: roundedPx, orderType: { limit: { tif: "Ioc" } }, reduceOnly: false }],
        "na",
        builder,
      );
    },

    async cancelOrder(coin: string, oid: number): Promise<any> {
      await ensureMeta();
      const action = {
        type: "cancel",
        cancels: [{ a: getAssetIndex(coin), o: oid }],
      };
      const nonce = getTimestampMs();
      const signature = await signL1Action(wallet, action, vaultAddress, nonce, null, isMainnet);
      return postExchange(baseUrl, action, signature, nonce, vaultAddress);
    },

    async cancelAllOrders(coin: string): Promise<any> {
      await ensureMeta();
      const orders = await postInfo(baseUrl, { type: "openOrders", user: userAddress });
      const coinOrders = orders.filter((o: any) => o.coin === coin);
      if (coinOrders.length === 0) return { status: "ok", message: "No orders to cancel" };
      const cancels = coinOrders.map((o: any) => ({ a: getAssetIndex(coin), o: o.oid }));
      const action = { type: "cancel", cancels };
      const nonce = getTimestampMs();
      const signature = await signL1Action(wallet, action, vaultAddress, nonce, null, isMainnet);
      return postExchange(baseUrl, action, signature, nonce, vaultAddress);
    },

    async updateLeverage(coin: string, leverage: number, isCross: boolean = true): Promise<any> {
      await ensureMeta();
      const action = {
        type: "updateLeverage",
        asset: getAssetIndex(coin),
        isCross,
        leverage,
      };
      const nonce = getTimestampMs();
      const signature = await signL1Action(wallet, action, vaultAddress, nonce, null, isMainnet);
      return postExchange(baseUrl, action, signature, nonce, vaultAddress);
    },

    async updateIsolatedMargin(coin: string, amount: number): Promise<any> {
      await ensureMeta();
      const action = {
        type: "updateIsolatedMargin",
        asset: getAssetIndex(coin),
        isBuy: true,
        ntli: amount,
      };
      const nonce = getTimestampMs();
      const signature = await signL1Action(wallet, action, vaultAddress, nonce, null, isMainnet);
      return postExchange(baseUrl, action, signature, nonce, vaultAddress);
    },

    async approveAgent(agentName?: string): Promise<{ response: any; agentKey: string }> {
      const agentKey = "0x" + Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const agentWallet = new ethers.Wallet(agentKey);
      const nonce = getTimestampMs();
      const action: Record<string, any> = {
        type: "approveAgent",
        agentAddress: agentWallet.address,
        agentName: agentName || "",
        nonce,
      };
      const signature = await signUserSignedAction(
        wallet,
        action,
        APPROVE_AGENT_TYPES,
        "HyperliquidTransaction:ApproveAgent",
        isMainnet,
      );
      if (!agentName) {
        delete action.agentName;
      }
      const response = await postExchange(baseUrl, action, signature, nonce);
      return { response, agentKey };
    },

    async approveBuilderFee(builderAddress: string, maxFeeRate: string): Promise<any> {
      const nonce = getTimestampMs();
      const action: Record<string, any> = {
        type: "approveBuilderFee",
        maxFeeRate,
        builder: builderAddress,
        nonce,
      };
      const signature = await signUserSignedAction(
        wallet,
        action,
        APPROVE_BUILDER_FEE_TYPES,
        "HyperliquidTransaction:ApproveBuilderFee",
        isMainnet,
      );
      return postExchange(baseUrl, action, signature, nonce);
    },

    getAssetIndex,
    ensureMeta,
  };
}

export async function approveAgentFromPrivateKey(
  userPrivateKey: string,
  config: HyperliquidConfig,
  agentName?: string,
): Promise<{ agentAddress: string; agentPrivateKey: string; response: any }> {
  const client = createHyperliquidExchangeClient(userPrivateKey, config);
  const { response, agentKey } = await client.approveAgent(agentName);
  const agentWallet = new ethers.Wallet(agentKey);
  return { agentAddress: agentWallet.address, agentPrivateKey: agentKey, response };
}

export function createAgentExchangeClient(
  agentPrivateKey: string,
  userAddress: string,
  config: HyperliquidConfig,
) {
  const agentWallet = new ethers.Wallet(agentPrivateKey);
  const { baseUrl, isMainnet } = config;

  let assetMap: Record<string, number> = {};
  let metaLoaded = false;

  async function ensureMeta() {
    if (metaLoaded) return;
    try {
      const meta = await postInfo(baseUrl, { type: "meta" });
      if (meta?.universe) {
        meta.universe.forEach((u: any, i: number) => {
          assetMap[u.name] = i;
        });
      }
      metaLoaded = true;
    } catch (e) {
      console.error("[HL] Failed to load meta:", e);
    }
  }

  function getAssetIndex(coin: string): number {
    if (coin in assetMap) return assetMap[coin];
    throw new Error(`Unknown coin: ${coin}. Call ensureMeta first.`);
  }

  return {
    userAddress,
    agentAddress: agentWallet.address,

    async placeOrder(
      orders: OrderRequest[],
      grouping: "na" | "normalTpsl" | "positionTpsl" = "na",
      builder?: { b: string; f: number },
    ): Promise<any> {
      await ensureMeta();
      const orderWires = orders.map((o) => orderToWire(o, getAssetIndex(o.coin)));
      const action: Record<string, any> = {
        type: "order",
        orders: orderWires,
        grouping,
      };
      if (builder) {
        action.builder = { b: builder.b.toLowerCase(), f: builder.f };
      }
      const nonce = getTimestampMs();
      const signature = await signL1Action(agentWallet, action, null, nonce, null, isMainnet);
      return postExchange(baseUrl, action, signature, nonce);
    },

    async marketOrder(
      coin: string,
      isBuy: boolean,
      sz: number,
      slippage: number = 0.05,
      builder?: { b: string; f: number },
    ): Promise<any> {
      await ensureMeta();
      const mids = await postInfo(baseUrl, { type: "allMids" });
      const mid = parseFloat(mids[coin]);
      if (!mid) throw new Error(`No mid price for ${coin}`);
      const px = isBuy ? mid * (1 + slippage) : mid * (1 - slippage);
      const sigFigs = getSigFigs(mid);
      const roundedPx = roundToSigFigs(px, sigFigs);
      return this.placeOrder(
        [{ coin, isBuy, sz, limitPx: roundedPx, orderType: { limit: { tif: "Ioc" } }, reduceOnly: false }],
        "na",
        builder,
      );
    },

    async cancelOrder(coin: string, oid: number): Promise<any> {
      await ensureMeta();
      const action = {
        type: "cancel",
        cancels: [{ a: getAssetIndex(coin), o: oid }],
      };
      const nonce = getTimestampMs();
      const signature = await signL1Action(agentWallet, action, null, nonce, null, isMainnet);
      return postExchange(baseUrl, action, signature, nonce);
    },

    async updateLeverage(coin: string, leverage: number, isCross: boolean = true): Promise<any> {
      await ensureMeta();
      const action = {
        type: "updateLeverage",
        asset: getAssetIndex(coin),
        isCross,
        leverage,
      };
      const nonce = getTimestampMs();
      const signature = await signL1Action(agentWallet, action, null, nonce, null, isMainnet);
      return postExchange(baseUrl, action, signature, nonce);
    },

    getAssetIndex,
    ensureMeta,
  };
}

function getSigFigs(price: number): number {
  if (price >= 10000) return 6;
  if (price >= 1000) return 5;
  if (price >= 100) return 5;
  if (price >= 10) return 4;
  if (price >= 1) return 4;
  return 5;
}

function roundToSigFigs(num: number, sigFigs: number): number {
  if (num === 0) return 0;
  const d = Math.ceil(Math.log10(Math.abs(num)));
  const power = sigFigs - d;
  const magnitude = Math.pow(10, power);
  return Math.round(num * magnitude) / magnitude;
}
