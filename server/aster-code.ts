import { Wallet } from "ethers";

const DEFAULT_FAPI_URL = "https://fapi.asterdex.com";
const REQUEST_TIMEOUT_MS = 20000;

const BUILD4_BUILDER_ADDRESS = "0x06d6227e499f10fe0a9f8c8b80b3c98f964474a4";
const BUILD4_BUILDER_NAME = "BUILD4";
const BUILD4_MAX_FEE_RATE = "0.00001";
const BUILD4_FEE_RATE = "0.00001";

export function getDefaultAsterCodeConfig(): AsterCodeConfig {
  return {
    builderAddress: BUILD4_BUILDER_ADDRESS,
    builderName: BUILD4_BUILDER_NAME,
    maxFeeRate: BUILD4_MAX_FEE_RATE,
    feeRate: BUILD4_FEE_RATE,
  };
}

export interface AsterCodeConfig {
  builderAddress: string;
  builderName: string;
  maxFeeRate: string;
  feeRate: string;
  fApiUrl?: string;
}

export interface AsterCodeUserConfig {
  userAddress: string;
  userPrivateKey: string;
  signerAddress: string;
  signerPrivateKey: string;
}

export interface ApproveAgentParams {
  agentName: string;
  agentAddress: string;
  ipWhitelist?: string;
  expired?: number;
  canSpotTrade?: boolean;
  canPerpTrade?: boolean;
  canWithdraw?: boolean;
  builder?: string;
  maxFeeRate?: string;
  builderName?: string;
}

export interface ApproveBuilderParams {
  builder: string;
  maxFeeRate: string;
  builderName?: string;
}

export interface AsterCodeOnboardResult {
  success: boolean;
  signerAddress?: string;
  signerPrivateKey?: string;
  agentApproved?: boolean;
  builderApproved?: boolean;
  error?: string;
  debug?: string;
}

const EIP712_DOMAIN_MAIN = {
  name: "AsterSignTransaction",
  version: "1",
  chainId: 56,
  verifyingContract: "0x0000000000000000000000000000000000000000",
};

const EIP712_DOMAIN_TRADING = {
  name: "AsterSignTransaction",
  version: "1",
  chainId: 1666,
  verifyingContract: "0x0000000000000000000000000000000000000000",
};

let _lastNonceSec = 0;
let _nonceCounter = 0;

function getNonce(): number {
  const nowSec = Math.trunc(Date.now() / 1000);
  if (nowSec === _lastNonceSec) {
    _nonceCounter++;
  } else {
    _lastNonceSec = nowSec;
    _nonceCounter = 0;
  }
  return nowSec * 1_000_000 + _nonceCounter;
}

function capitalizeKey(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function inferEIP712Type(value: any): string {
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number" && Number.isInteger(value)) return "uint256";
  return "string";
}

function buildQueryString(params: Record<string, any>): string {
  return Object.entries(params)
    .filter(([_, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("&");
}

async function signEIP712Main(
  privateKey: string,
  params: Record<string, any>,
  primaryType: string,
): Promise<string> {
  const capitalizedParams: Record<string, any> = {};
  const typeFields: { name: string; type: string }[] = [];

  for (const [key, value] of Object.entries(params)) {
    const capKey = capitalizeKey(key);
    capitalizedParams[capKey] = value;
    typeFields.push({ name: capKey, type: inferEIP712Type(value) });
  }

  const types: Record<string, { name: string; type: string }[]> = {
    [primaryType]: typeFields,
  };

  const wallet = new Wallet(privateKey);

  console.log(`[AsterCode] signMain primaryType=${primaryType} user=${wallet.address.substring(0, 10)}...`);
  console.log(`[AsterCode] signMain fields=${typeFields.map(f => `${f.name}:${f.type}`).join(",")}`);

  const signature = await wallet.signTypedData(
    EIP712_DOMAIN_MAIN,
    types,
    capitalizedParams,
  );

  return signature;
}

async function signEIP712Trading(
  privateKey: string,
  message: string,
): Promise<string> {
  const types = {
    Message: [{ name: "msg", type: "string" }],
  };

  const wallet = new Wallet(privateKey);

  const signature = await wallet.signTypedData(
    EIP712_DOMAIN_TRADING,
    types,
    { msg: message },
  );

  return signature;
}

async function makeMainRequest(
  baseUrl: string,
  path: string,
  userPrivateKey: string,
  params: Record<string, any>,
  primaryType: string,
  method: "POST" | "DELETE" = "POST",
): Promise<any> {
  const allParams = { ...params };
  allParams.asterChain = "Mainnet";

  const wallet = new Wallet(userPrivateKey);
  allParams.user = wallet.address;
  allParams.nonce = getNonce();

  const signature = await signEIP712Main(userPrivateKey, allParams, primaryType);

  allParams.signature = signature;
  allParams.signatureChainId = 56;

  const queryString = buildQueryString(allParams);
  const url = `${baseUrl}${path}?${queryString}`;

  console.log(`[AsterCode] ${method} ${path} url=${url.substring(0, 400)}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "BUILD4/1.0",
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const text = await response.text();
    console.log(`[AsterCode] ${method} ${path} status=${response.status} body=${text.substring(0, 500)}`);

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response from ${path}: ${text.substring(0, 300)}`);
    }

    if (!response.ok) {
      throw new Error(`AsterCode API error ${data?.code || response.status}: ${data?.msg || data?.message || text.substring(0, 200)}`);
    }

    return data?.data !== undefined ? data.data : data;
  } catch (e: any) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") {
      throw new Error(`AsterCode API timeout: ${method} ${path}`);
    }
    throw e;
  }
}

async function makeTradingRequest(
  baseUrl: string,
  path: string,
  userAddress: string,
  signerAddress: string,
  signerPrivateKey: string,
  params: Record<string, any>,
  method: "GET" | "POST" | "DELETE" = "GET",
): Promise<any> {
  const allParams = { ...params };
  allParams.asterChain = "Mainnet";
  allParams.user = userAddress;
  allParams.signer = signerAddress;
  allParams.nonce = getNonce();

  const queryString = buildQueryString(allParams);
  const signature = await signEIP712Trading(signerPrivateKey, queryString);

  const url = `${baseUrl}${path}?${queryString}&signature=${signature}`;

  console.log(`[AsterCode] trading ${method} ${path} url=${url.substring(0, 400)}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "BUILD4/1.0",
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const text = await response.text();
    console.log(`[AsterCode] trading ${method} ${path} status=${response.status} body=${text.substring(0, 500)}`);

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response from ${path}: ${text.substring(0, 300)}`);
    }

    if (!response.ok) {
      throw new Error(`AsterCode API error ${data?.code || response.status}: ${data?.msg || data?.message || text.substring(0, 200)}`);
    }

    if (data && data.data && !Array.isArray(data)) {
      return data.data;
    }
    return data;
  } catch (e: any) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") {
      throw new Error(`AsterCode API timeout: ${method} ${path}`);
    }
    throw e;
  }
}

export async function asterCodeApproveAgent(
  baseUrl: string,
  userPrivateKey: string,
  params: ApproveAgentParams,
): Promise<any> {
  const reqParams: Record<string, any> = {
    agentName: params.agentName,
    agentAddress: params.agentAddress,
    ipWhitelist: params.ipWhitelist || "",
    expired: params.expired || Math.trunc(Date.now() / 1000 + 365 * 24 * 3600) * 1000,
    canSpotTrade: params.canSpotTrade ?? false,
    canPerpTrade: params.canPerpTrade ?? true,
    canWithdraw: params.canWithdraw ?? false,
  };

  if (params.builder) {
    reqParams.builder = params.builder;
    reqParams.maxFeeRate = params.maxFeeRate || "0.00001";
    if (params.builderName) reqParams.builderName = params.builderName;
  }

  return makeMainRequest(baseUrl, "/fapi/v3/approveAgent", userPrivateKey, reqParams, "ApproveAgent");
}

export async function asterCodeApproveBuilder(
  baseUrl: string,
  userPrivateKey: string,
  params: ApproveBuilderParams,
): Promise<any> {
  const reqParams: Record<string, any> = {
    builder: params.builder,
    maxFeeRate: params.maxFeeRate,
  };
  if (params.builderName) reqParams.builderName = params.builderName;

  return makeMainRequest(baseUrl, "/fapi/v3/approveBuilder", userPrivateKey, reqParams, "ApproveBuilder");
}

export async function asterCodeUpdateAgent(
  baseUrl: string,
  userPrivateKey: string,
  agentAddress: string,
  updates: { ipWhitelist?: string; canSpotTrade?: boolean; canPerpTrade?: boolean; canWithdraw?: boolean },
): Promise<any> {
  const reqParams: Record<string, any> = {
    agentAddress,
    ...updates,
  };
  return makeMainRequest(baseUrl, "/fapi/v3/updateAgent", userPrivateKey, reqParams, "UpdateAgent");
}

export async function asterCodeDeleteAgent(
  baseUrl: string,
  userPrivateKey: string,
  agentAddress: string,
): Promise<any> {
  return makeMainRequest(baseUrl, "/fapi/v3/agent", userPrivateKey, { agentAddress }, "DelAgent", "DELETE");
}

export async function asterCodeGetAgents(
  baseUrl: string,
  userAddress: string,
  signerAddress: string,
  signerPrivateKey: string,
): Promise<any> {
  return makeTradingRequest(baseUrl, "/fapi/v3/agent", userAddress, signerAddress, signerPrivateKey, {}, "GET");
}

export async function asterCodeGetBuilders(
  baseUrl: string,
  userAddress: string,
  signerAddress: string,
  signerPrivateKey: string,
): Promise<any> {
  return makeTradingRequest(baseUrl, "/fapi/v3/builder", userAddress, signerAddress, signerPrivateKey, {}, "GET");
}

export async function asterCodeOnboard(
  userPrivateKey: string,
  codeConfig: AsterCodeConfig,
): Promise<AsterCodeOnboardResult> {
  const baseUrl = codeConfig.fApiUrl || DEFAULT_FAPI_URL;
  const debugParts: string[] = [];

  try {
    const userWallet = new Wallet(userPrivateKey);
    const userAddress = userWallet.address;
    console.log(`[AsterCode] Onboarding user=${userAddress.substring(0, 10)}... builder=${codeConfig.builderAddress.substring(0, 10)}...`);

    const signerWallet = Wallet.createRandom();
    const signerAddress = signerWallet.address;
    const signerPrivKey = signerWallet.privateKey;
    console.log(`[AsterCode] Generated signer=${signerAddress.substring(0, 10)}...`);
    debugParts.push(`signer=${signerAddress.substring(0, 10)}`);

    const agentName = `build4_${Date.now()}`;
    const expiry = Math.trunc(Date.now() / 1000 + 2 * 365 * 24 * 3600) * 1000;

    try {
      const agentResult = await asterCodeApproveAgent(baseUrl, userPrivateKey, {
        agentName,
        agentAddress: signerAddress,
        ipWhitelist: "",
        expired: expiry,
        canSpotTrade: false,
        canPerpTrade: true,
        canWithdraw: false,
        builder: codeConfig.builderAddress,
        maxFeeRate: codeConfig.maxFeeRate,
        builderName: codeConfig.builderName,
      });
      console.log(`[AsterCode] approveAgent result:`, JSON.stringify(agentResult).substring(0, 300));
      debugParts.push(`agent=OK`);
    } catch (agentErr: any) {
      console.error(`[AsterCode] approveAgent failed:`, agentErr.message);
      debugParts.push(`agent=FAIL:${agentErr.message.substring(0, 80)}`);
      return {
        success: false,
        error: `Agent approval failed: ${agentErr.message}`,
        debug: debugParts.join(" | "),
      };
    }

    await new Promise(r => setTimeout(r, 500));

    let builderApproved = true;
    try {
      const builderResult = await asterCodeApproveBuilder(baseUrl, userPrivateKey, {
        builder: codeConfig.builderAddress,
        maxFeeRate: codeConfig.maxFeeRate,
        builderName: codeConfig.builderName,
      });
      console.log(`[AsterCode] approveBuilder result:`, JSON.stringify(builderResult).substring(0, 300));
      debugParts.push(`builder=OK`);
    } catch (builderErr: any) {
      console.log(`[AsterCode] approveBuilder failed (may already be approved via agent call):`, builderErr.message);
      debugParts.push(`builder=FAIL:${builderErr.message.substring(0, 80)}`);
      builderApproved = false;
    }

    console.log(`[AsterCode] Onboard success for ${userAddress.substring(0, 10)}...`);
    return {
      success: true,
      signerAddress,
      signerPrivateKey: signerPrivKey,
      agentApproved: true,
      builderApproved,
      debug: debugParts.join(" | "),
    };
  } catch (e: any) {
    console.error(`[AsterCode] Onboard error:`, e.message);
    return {
      success: false,
      error: e.message,
      debug: debugParts.join(" | "),
    };
  }
}

export function createAsterCodeFuturesClient(
  userAddress: string,
  signerAddress: string,
  signerPrivateKey: string,
  codeConfig: AsterCodeConfig,
) {
  const baseUrl = codeConfig.fApiUrl || DEFAULT_FAPI_URL;
  const builderAddress = codeConfig.builderAddress;
  const feeRate = codeConfig.feeRate;

  return {
    async noop(): Promise<any> {
      return makeTradingRequest(baseUrl, "/fapi/v3/noop", userAddress, signerAddress, signerPrivateKey, {}, "POST");
    },

    async ping(): Promise<boolean> {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        const res = await fetch(`${baseUrl}/fapi/v3/ping`, { signal: controller.signal });
        clearTimeout(timeoutId);
        return res.ok;
      } catch {
        return false;
      }
    },

    async exchangeInfo(): Promise<any> {
      const res = await fetch(`${baseUrl}/fapi/v3/exchangeInfo`);
      return res.json();
    },

    async ticker(symbol?: string): Promise<any> {
      const params: Record<string, any> = {};
      if (symbol) params.symbol = symbol;
      const qs = buildQueryString(params);
      const url = qs ? `${baseUrl}/fapi/v3/ticker/24hr?${qs}` : `${baseUrl}/fapi/v3/ticker/24hr`;
      const res = await fetch(url);
      return res.json();
    },

    async tickerPrice(symbol?: string): Promise<any> {
      const params: Record<string, any> = {};
      if (symbol) params.symbol = symbol;
      const qs = buildQueryString(params);
      const url = qs ? `${baseUrl}/fapi/v3/ticker/price?${qs}` : `${baseUrl}/fapi/v3/ticker/price`;
      const res = await fetch(url);
      return res.json();
    },

    async orderBook(symbol: string, limit: number = 20): Promise<any> {
      const res = await fetch(`${baseUrl}/fapi/v3/depth?symbol=${symbol}&limit=${limit}`);
      return res.json();
    },

    async klines(symbol: string, interval: string = "1h", limit: number = 100): Promise<any[]> {
      const res = await fetch(`${baseUrl}/fapi/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
      const raw = await res.json();
      if (!Array.isArray(raw)) return [];
      return raw.map((k: any[]) => ({
        openTime: k[0], open: String(k[1]), high: String(k[2]), low: String(k[3]),
        close: String(k[4]), volume: String(k[5]), closeTime: k[6],
        quoteVolume: String(k[7]), trades: k[8] || 0,
      }));
    },

    async fundingRate(symbol?: string, limit: number = 20): Promise<any[]> {
      const params: Record<string, any> = { limit };
      if (symbol) params.symbol = symbol;
      const qs = buildQueryString(params);
      const res = await fetch(`${baseUrl}/fapi/v3/fundingRate?${qs}`);
      return res.json();
    },

    async premiumIndex(symbol?: string): Promise<any> {
      const params: Record<string, any> = {};
      if (symbol) params.symbol = symbol;
      const qs = buildQueryString(params);
      const url = qs ? `${baseUrl}/fapi/v3/premiumIndex?${qs}` : `${baseUrl}/fapi/v3/premiumIndex`;
      const res = await fetch(url);
      return res.json();
    },

    async balance(): Promise<any[]> {
      return makeTradingRequest(baseUrl, "/fapi/v3/balance", userAddress, signerAddress, signerPrivateKey, {}, "GET");
    },

    async account(): Promise<any> {
      return makeTradingRequest(baseUrl, "/fapi/v3/account", userAddress, signerAddress, signerPrivateKey, {}, "GET");
    },

    async positionRisk(): Promise<any[]> {
      const data = await makeTradingRequest(baseUrl, "/fapi/v3/positionRisk", userAddress, signerAddress, signerPrivateKey, {}, "GET");
      if (Array.isArray(data)) return data;
      return [];
    },

    async positions(): Promise<any[]> {
      return this.positionRisk();
    },

    async testConnection(): Promise<{ success: boolean; data?: any; error?: string }> {
      try {
        const acct = await this.account();
        return { success: true, data: acct };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    },

    async createOrder(orderParams: {
      symbol: string;
      side: "BUY" | "SELL";
      type: string;
      quantity?: string;
      price?: string;
      stopPrice?: string;
      timeInForce?: string;
      reduceOnly?: boolean;
      closePosition?: boolean;
      positionSide?: string;
      newClientOrderId?: string;
      quoteOrderQty?: string;
      activationPrice?: string;
      callbackRate?: string;
      workingType?: string;
    }): Promise<any> {
      const params: Record<string, any> = {
        symbol: orderParams.symbol,
        side: orderParams.side,
        type: orderParams.type,
        builder: builderAddress,
        feeRate,
      };
      if (orderParams.quantity) params.quantity = orderParams.quantity;
      if (orderParams.price) params.price = orderParams.price;
      if (orderParams.stopPrice) params.stopPrice = orderParams.stopPrice;
      if (orderParams.timeInForce) params.timeInForce = orderParams.timeInForce;
      if (orderParams.reduceOnly !== undefined) params.reduceOnly = orderParams.reduceOnly;
      if (orderParams.closePosition !== undefined) params.closePosition = orderParams.closePosition;
      if (orderParams.positionSide) params.positionSide = orderParams.positionSide;
      if (orderParams.quoteOrderQty) params.quoteOrderQty = orderParams.quoteOrderQty;
      if (orderParams.activationPrice) params.activationPrice = orderParams.activationPrice;
      if (orderParams.callbackRate) params.callbackRate = orderParams.callbackRate;
      if (orderParams.workingType) params.workingType = orderParams.workingType;
      if (orderParams.type === "LIMIT" && !params.timeInForce) params.timeInForce = "GTC";
      if (orderParams.newClientOrderId) params.newClientOrderId = orderParams.newClientOrderId;
      return makeTradingRequest(baseUrl, "/fapi/v3/order", userAddress, signerAddress, signerPrivateKey, params, "POST");
    },

    async cancelOrder(symbol: string, orderId: number): Promise<any> {
      return makeTradingRequest(baseUrl, "/fapi/v3/order", userAddress, signerAddress, signerPrivateKey, { symbol, orderId }, "DELETE");
    },

    async cancelAllOrders(symbol: string): Promise<any> {
      return makeTradingRequest(baseUrl, "/fapi/v3/allOpenOrders", userAddress, signerAddress, signerPrivateKey, { symbol }, "DELETE");
    },

    async openOrders(symbol?: string): Promise<any[]> {
      const params: Record<string, any> = {};
      if (symbol) params.symbol = symbol;
      return makeTradingRequest(baseUrl, "/fapi/v3/openOrders", userAddress, signerAddress, signerPrivateKey, params, "GET");
    },

    async allOrders(symbol: string, limit: number = 50): Promise<any[]> {
      return makeTradingRequest(baseUrl, "/fapi/v3/allOrders", userAddress, signerAddress, signerPrivateKey, { symbol, limit }, "GET");
    },

    async userTrades(symbol: string, limit: number = 50): Promise<any[]> {
      try {
        const r = await makeTradingRequest(baseUrl, "/fapi/v3/userTrades", userAddress, signerAddress, signerPrivateKey, { symbol, limit }, "GET");
        if (Array.isArray(r)) return r;
      } catch {}
      try {
        const r2 = await makeTradingRequest(baseUrl, "/fapi/v3/userTrades", userAddress, signerAddress, signerPrivateKey, { symbol, limit }, "POST");
        if (Array.isArray(r2)) return r2;
      } catch {}
      return [];
    },

    async setLeverage(symbol: string, leverage: number): Promise<any> {
      return makeTradingRequest(baseUrl, "/fapi/v3/leverage", userAddress, signerAddress, signerPrivateKey, { symbol, leverage }, "POST");
    },

    async setMarginType(symbol: string, marginType: "ISOLATED" | "CROSSED"): Promise<any> {
      return makeTradingRequest(baseUrl, "/fapi/v3/marginType", userAddress, signerAddress, signerPrivateKey, { symbol, marginType }, "POST");
    },

    async income(incomeType?: string, limit: number = 50): Promise<any[]> {
      const params: Record<string, any> = { limit };
      if (incomeType) params.incomeType = incomeType;
      try {
        const result = await makeTradingRequest(baseUrl, "/fapi/v3/income", userAddress, signerAddress, signerPrivateKey, params, "POST");
        if (Array.isArray(result) && result.length > 0) return result;
      } catch {}
      try {
        const result2 = await makeTradingRequest(baseUrl, "/fapi/v3/income", userAddress, signerAddress, signerPrivateKey, params, "GET");
        if (Array.isArray(result2)) return result2;
      } catch {}
      return [];
    },

    async listenKey(): Promise<any> {
      return makeTradingRequest(baseUrl, "/fapi/v3/listenKey", userAddress, signerAddress, signerPrivateKey, {}, "POST");
    },

    async spotBalance(): Promise<{ asset: string; free: string; locked: string }[]> {
      try {
        const result = await makeTradingRequest(baseUrl, "/sapi/v3/account", userAddress, signerAddress, signerPrivateKey, {}, "GET");
        if (result?.balances) return result.balances;
      } catch {}
      try {
        const result2 = await makeTradingRequest(baseUrl, "/sapi/v1/account", userAddress, signerAddress, signerPrivateKey, {}, "GET");
        if (result2?.balances) return result2.balances;
      } catch {}
      return [];
    },

    async spotToFutures(asset: string, amount: string): Promise<any> {
      try {
        return await makeTradingRequest(baseUrl, "/fapi/v3/asset/wallet/transfer", userAddress, signerAddress, signerPrivateKey, { asset, amount, kindType: "SPOT_FUTURE" }, "POST");
      } catch (e: any) {
        console.log(`[AsterCode] spotToFutures v3 failed: ${e.message?.substring(0, 100)}`);
        return makeTradingRequest(baseUrl, "/sapi/v1/asset/transfer", userAddress, signerAddress, signerPrivateKey, { asset, amount, type: 1 }, "POST");
      }
    },

    async futuresToSpot(asset: string, amount: string): Promise<any> {
      return makeTradingRequest(baseUrl, "/fapi/v3/asset/wallet/transfer", userAddress, signerAddress, signerPrivateKey, { asset, amount, kindType: "FUTURE_SPOT" }, "POST");
    },

    async withdrawOnChain(coin: string, amount: string, toAddress: string, network: string = "BSC"): Promise<any> {
      return makeTradingRequest(baseUrl, "/sapi/v1/capital/withdraw/apply", userAddress, signerAddress, signerPrivateKey, { coin, amount, address: toAddress, network }, "POST");
    },

    getBuilderAddress(): string {
      return builderAddress;
    },

    getFeeRate(): string {
      return feeRate;
    },
  };
}

export type AsterCodeFuturesClient = ReturnType<typeof createAsterCodeFuturesClient>;
