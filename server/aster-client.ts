import crypto from "crypto";
import { ethers } from "ethers";

interface AsterClientConfig {
  apiKey: string;
  apiSecret: string;
  futuresBaseUrl?: string;
  spotBaseUrl?: string;
}

interface AsterV3Config {
  user: string;
  signer: string;
  signerPrivateKey: string;
  futuresBaseUrl?: string;
}

interface AsterRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  signed?: boolean;
  params?: Record<string, string | number | boolean | undefined>;
}

interface AsterTicker {
  symbol: string;
  price: string;
  volume: string;
  quoteVolume: string;
  priceChange: string;
  priceChangePercent: string;
  high: string;
  low: string;
  lastQty: string;
  time: number;
}

interface AsterOrderBookEntry {
  price: string;
  quantity: string;
}

interface AsterOrderBook {
  lastUpdateId: number;
  bids: AsterOrderBookEntry[];
  asks: AsterOrderBookEntry[];
}

interface AsterKline {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime: number;
  quoteVolume: string;
  trades: number;
}

interface AsterFundingRate {
  symbol: string;
  fundingRate: string;
  fundingTime: number;
  markPrice: string;
}

interface AsterBalance {
  asset: string;
  balance: string;
  availableBalance: string;
  crossUnPnl: string;
  crossWalletBalance: string;
}

interface AsterPosition {
  symbol: string;
  positionSide: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  marginType: string;
  isolatedMargin: string;
  notional: string;
}

interface AsterOrder {
  orderId: number;
  symbol: string;
  side: string;
  type: string;
  price: string;
  origQty: string;
  executedQty: string;
  status: string;
  timeInForce: string;
  reduceOnly: boolean;
  closePosition: boolean;
  positionSide: string;
  time: number;
  updateTime: number;
  stopPrice?: string;
  activatePrice?: string;
  priceRate?: string;
}

interface AsterNewOrderParams {
  symbol: string;
  side: "BUY" | "SELL";
  type: "LIMIT" | "MARKET" | "STOP" | "STOP_MARKET" | "TAKE_PROFIT" | "TAKE_PROFIT_MARKET" | "TRAILING_STOP_MARKET";
  quantity?: string;
  price?: string;
  stopPrice?: string;
  timeInForce?: "GTC" | "IOC" | "FOK";
  reduceOnly?: boolean;
  closePosition?: boolean;
  positionSide?: "BOTH" | "LONG" | "SHORT";
  newClientOrderId?: string;
  quoteOrderQty?: string;
  activationPrice?: string;
  callbackRate?: string;
  workingType?: "MARK_PRICE" | "CONTRACT_PRICE";
}

interface AsterSpotBalance {
  asset: string;
  free: string;
  locked: string;
}

interface AsterSpotAccount {
  balances: AsterSpotBalance[];
  canTrade: boolean;
  canWithdraw: boolean;
  canDeposit: boolean;
}

interface AsterSpotOrder {
  orderId: number;
  symbol: string;
  side: string;
  type: string;
  price: string;
  origQty: string;
  executedQty: string;
  status: string;
  timeInForce: string;
  time: number;
  updateTime: number;
}

interface AsterSpotNewOrderParams {
  symbol: string;
  side: "BUY" | "SELL";
  type: "LIMIT" | "MARKET";
  quantity?: string;
  price?: string;
  timeInForce?: "GTC" | "IOC" | "FOK";
  quoteOrderQty?: string;
  newClientOrderId?: string;
}

interface BrokerOnboardResult {
  success: boolean;
  apiKey?: string;
  apiSecret?: string;
  uid?: number;
  error?: string;
}

const DEFAULT_FUTURES_BASE_URL = "https://fapi.asterdex.com";
const DEFAULT_FUTURES_V3_BASE_URL = "https://fapi3.asterdex.com";
const DEFAULT_SPOT_BASE_URL = "https://sapi.asterdex.com";
const BROKER_BASE_URL = "https://www.asterdex.com/bapi/futures/v1";
const WS_BASE_URL = "wss://fstream.asterdex.com";
const REQUEST_TIMEOUT_MS = 15000;
const BUILD4_AGENT_CODE = "BUILD4";

function buildQueryString(params: Record<string, string | number | boolean | undefined>): string {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      filtered[key] = String(value);
    }
  }
  return new URLSearchParams(filtered).toString();
}

function hmacSign(queryString: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(queryString).digest("hex");
}

async function makeRequest(
  baseUrl: string,
  path: string,
  apiKey: string,
  apiSecret: string,
  options: AsterRequestOptions = {},
): Promise<any> {
  const { method = "GET", signed = false, params = {} } = options;

  const queryParams = { ...params } as Record<string, string | number | boolean | undefined>;

  if (signed) {
    queryParams.timestamp = Date.now();
    const qs = buildQueryString(queryParams);
    queryParams.signature = hmacSign(qs, apiSecret);
  }

  const queryString = buildQueryString(queryParams);
  const url = queryString ? `${baseUrl}${path}?${queryString}` : `${baseUrl}${path}`;

  const headers: Record<string, string> = {
    "X-MBX-APIKEY": apiKey,
    "Content-Type": "application/json",
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const text = await response.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON response: ${text.substring(0, 200)}`);
    }

    if (!response.ok) {
      const code = data?.code || response.status;
      const msg = data?.msg || data?.message || text.substring(0, 200);
      throw new Error(`Aster API error ${code}: ${msg}`);
    }

    return data;
  } catch (e: any) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") {
      throw new Error(`Aster API request timeout after ${REQUEST_TIMEOUT_MS}ms: ${method} ${path}`);
    }
    throw e;
  }
}

const EIP712_TYPED_DATA = {
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Message: [
      { name: "msg", type: "string" },
    ],
  },
  primaryType: "Message" as const,
  domain: {
    name: "AsterSignTransaction",
    version: "1",
    chainId: 1666,
    verifyingContract: "0x0000000000000000000000000000000000000000",
  },
};

let _lastNonceSec = 0;
let _nonceCounter = 0;

function getV3Nonce(): string {
  const nowSec = Math.trunc(Date.now() / 1000);
  if (nowSec === _lastNonceSec) {
    _nonceCounter++;
  } else {
    _lastNonceSec = nowSec;
    _nonceCounter = 0;
  }
  return String(nowSec * 1_000_000 + _nonceCounter);
}

async function signV3Params(
  params: Record<string, string | number | boolean | undefined>,
  user: string,
  signer: string,
  signerPrivateKey: string,
): Promise<Record<string, string | number | boolean | undefined>> {
  const signedParams = { ...params };
  signedParams.nonce = getV3Nonce();
  signedParams.user = user;
  signedParams.signer = signer;

  const queryString = buildQueryString(signedParams);

  const typedData = {
    ...EIP712_TYPED_DATA,
    message: { msg: queryString },
  };

  const wallet = new ethers.Wallet(signerPrivateKey);
  const signature = await wallet.signTypedData(
    typedData.domain,
    { Message: typedData.types.Message },
    typedData.message,
  );

  signedParams.signature = signature;
  return signedParams;
}

async function makeV3Request(
  baseUrl: string,
  path: string,
  user: string,
  signer: string,
  signerPrivateKey: string,
  options: AsterRequestOptions = {},
): Promise<any> {
  const { method = "GET", params = {} } = options;

  const signedParams = await signV3Params(params, user, signer, signerPrivateKey);
  const queryString = buildQueryString(signedParams);
  const url = `${baseUrl}${path}?${queryString}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": "BUILD4/1.0",
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const text = await response.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON response: ${text.substring(0, 200)}`);
    }

    if (!response.ok) {
      const code = data?.code || response.status;
      const msg = data?.msg || data?.message || text.substring(0, 200);
      throw new Error(`Aster V3 API error ${code}: ${msg}`);
    }

    return data;
  } catch (e: any) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") {
      throw new Error(`Aster V3 API timeout after ${REQUEST_TIMEOUT_MS}ms: ${method} ${path}`);
    }
    throw e;
  }
}

export async function asterBrokerOnboard(walletPrivateKey: string, agentCode?: string): Promise<BrokerOnboardResult> {
  const wallet = new ethers.Wallet(walletPrivateKey);
  const address = wallet.address;

  try {
    const nonceRes = await fetch(`${BROKER_BASE_URL}/public/future/web3/get-nonce`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "clientType": "web" },
      body: JSON.stringify({ type: "LOGIN", sourceAddr: address }),
    });
    const nonceData = await nonceRes.json();
    if (!nonceData?.data?.nonce) {
      return { success: false, error: "Failed to get login nonce from Aster" };
    }
    const loginNonce = nonceData.data.nonce;

    const loginMessage = `You are signing into Astherus ${loginNonce}`;
    const loginSignature = await wallet.signMessage(loginMessage);

    const loginRes = await fetch(`${BROKER_BASE_URL}/public/future/web3/ae/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "clientType": "web" },
      body: JSON.stringify({
        signature: loginSignature,
        sourceAddr: address,
        chainId: 56,
        agentCode: agentCode || BUILD4_AGENT_CODE,
      }),
    });
    const loginData = await loginRes.json();
    if (loginData?.code !== "000000" || !loginData?.data?.uid) {
      return { success: false, error: `Aster login failed: ${loginData?.message || "Unknown error"}` };
    }
    const uid = loginData.data.uid;

    const akNonceRes = await fetch(`${BROKER_BASE_URL}/public/future/web3/get-nonce`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "clientType": "web" },
      body: JSON.stringify({ type: "CREATE_API_KEY", sourceAddr: address }),
    });
    const akNonceData = await akNonceRes.json();
    if (!akNonceData?.data?.nonce) {
      return { success: false, error: "Failed to get API key nonce" };
    }
    const akNonce = akNonceData.data.nonce;

    const akMessage = `You are signing into Astherus ${akNonce}`;
    const akSignature = await wallet.signMessage(akMessage);

    const desc = `build4_${Date.now()}`;
    const createRes = await fetch(`${BROKER_BASE_URL}/public/future/web3/broker-create-api-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "clientType": "web" },
      body: JSON.stringify({
        signature: akSignature,
        sourceAddr: address,
        desc,
        ip: "",
        network: "56",
        type: "CREATE_API_KEY",
        sourceCode: "BUILD4",
      }),
    });
    const createData = await createRes.json();
    if (createData?.code !== "000000" || !createData?.data?.apiKey) {
      return { success: false, error: `API key creation failed: ${createData?.message || JSON.stringify(createData)}` };
    }

    console.log(`[Aster] Broker onboard success for ${address.substring(0, 10)}... uid=${uid}`);
    return {
      success: true,
      apiKey: createData.data.apiKey,
      apiSecret: createData.data.apiSecret,
      uid,
    };
  } catch (e: any) {
    console.error(`[Aster] Broker onboard error:`, e.message);
    return { success: false, error: e.message };
  }
}

export function createAsterFuturesClient(config: AsterClientConfig) {
  const baseUrl = config.futuresBaseUrl || DEFAULT_FUTURES_BASE_URL;
  const { apiKey, apiSecret } = config;

  async function request(path: string, options: AsterRequestOptions = {}) {
    return makeRequest(baseUrl, path, apiKey, apiSecret, options);
  }

  return {
    async ping(): Promise<boolean> {
      try {
        await request("/fapi/v1/ping");
        return true;
      } catch {
        return false;
      }
    },

    async ticker(symbol?: string): Promise<AsterTicker | AsterTicker[]> {
      const params: Record<string, string | number | boolean | undefined> = {};
      if (symbol) params.symbol = symbol;
      return request("/fapi/v1/ticker/24hr", { params });
    },

    async tickerPrice(symbol?: string): Promise<any> {
      const params: Record<string, string | number | boolean | undefined> = {};
      if (symbol) params.symbol = symbol;
      return request("/fapi/v1/ticker/price", { params });
    },

    async orderBook(symbol: string, limit: number = 20): Promise<AsterOrderBook> {
      return request("/fapi/v1/depth", { params: { symbol, limit } });
    },

    async klines(symbol: string, interval: string = "1h", limit: number = 100): Promise<AsterKline[]> {
      const raw = await request("/fapi/v1/klines", { params: { symbol, interval, limit } });
      if (!Array.isArray(raw)) return [];
      return raw.map((k: any[]) => ({
        openTime: k[0],
        open: String(k[1]),
        high: String(k[2]),
        low: String(k[3]),
        close: String(k[4]),
        volume: String(k[5]),
        closeTime: k[6],
        quoteVolume: String(k[7]),
        trades: k[8] || 0,
      }));
    },

    async fundingRate(symbol?: string, limit: number = 20): Promise<AsterFundingRate[]> {
      const params: Record<string, string | number | boolean | undefined> = { limit };
      if (symbol) params.symbol = symbol;
      return request("/fapi/v1/fundingRate", { params });
    },

    async premiumIndex(symbol?: string): Promise<any> {
      const params: Record<string, string | number | boolean | undefined> = {};
      if (symbol) params.symbol = symbol;
      return request("/fapi/v1/premiumIndex", { params });
    },

    async balance(): Promise<AsterBalance[]> {
      return request("/fapi/v2/balance", { signed: true });
    },

    async account(): Promise<any> {
      return request("/fapi/v2/account", { signed: true });
    },

    async positions(): Promise<AsterPosition[]> {
      const data = await request("/fapi/v2/positionRisk", { signed: true });
      if (Array.isArray(data)) return data;
      return [];
    },

    async createOrder(orderParams: AsterNewOrderParams): Promise<AsterOrder> {
      const params: Record<string, string | number | boolean | undefined> = {
        symbol: orderParams.symbol,
        side: orderParams.side,
        type: orderParams.type,
      };
      if (orderParams.quantity) params.quantity = orderParams.quantity;
      if (orderParams.price) params.price = orderParams.price;
      if (orderParams.stopPrice) params.stopPrice = orderParams.stopPrice;
      if (orderParams.timeInForce) params.timeInForce = orderParams.timeInForce;
      if (orderParams.reduceOnly !== undefined) params.reduceOnly = orderParams.reduceOnly;
      if (orderParams.closePosition !== undefined) params.closePosition = orderParams.closePosition;
      if (orderParams.positionSide) params.positionSide = orderParams.positionSide;
      if (orderParams.newClientOrderId) params.newClientOrderId = orderParams.newClientOrderId;
      if (orderParams.quoteOrderQty) params.quoteOrderQty = orderParams.quoteOrderQty;
      if (orderParams.activationPrice) params.activationPrice = orderParams.activationPrice;
      if (orderParams.callbackRate) params.callbackRate = orderParams.callbackRate;
      if (orderParams.workingType) params.workingType = orderParams.workingType;
      if (orderParams.type === "LIMIT" && !params.timeInForce) {
        params.timeInForce = "GTC";
      }
      return request("/fapi/v1/order", { method: "POST", signed: true, params });
    },

    async cancelOrder(symbol: string, orderId: number): Promise<AsterOrder> {
      return request("/fapi/v1/order", {
        method: "DELETE",
        signed: true,
        params: { symbol, orderId },
      });
    },

    async cancelAllOrders(symbol: string): Promise<any> {
      return request("/fapi/v1/allOpenOrders", {
        method: "DELETE",
        signed: true,
        params: { symbol },
      });
    },

    async openOrders(symbol?: string): Promise<AsterOrder[]> {
      const params: Record<string, string | number | boolean | undefined> = {};
      if (symbol) params.symbol = symbol;
      return request("/fapi/v1/openOrders", { signed: true, params });
    },

    async allOrders(symbol: string, limit: number = 50): Promise<AsterOrder[]> {
      return request("/fapi/v1/allOrders", { signed: true, params: { symbol, limit } });
    },

    async userTrades(symbol: string, limit: number = 50): Promise<any[]> {
      return request("/fapi/v1/userTrades", { signed: true, params: { symbol, limit } });
    },

    async setLeverage(symbol: string, leverage: number): Promise<any> {
      return request("/fapi/v1/leverage", {
        method: "POST",
        signed: true,
        params: { symbol, leverage },
      });
    },

    async setMarginType(symbol: string, marginType: "ISOLATED" | "CROSSED"): Promise<any> {
      return request("/fapi/v1/marginType", {
        method: "POST",
        signed: true,
        params: { symbol, marginType },
      });
    },

    async exchangeInfo(): Promise<any> {
      return request("/fapi/v1/exchangeInfo");
    },

    async income(incomeType?: string, limit: number = 50): Promise<any[]> {
      const params: Record<string, string | number | boolean | undefined> = { limit };
      if (incomeType) params.incomeType = incomeType;
      return request("/fapi/v1/income", { signed: true, params });
    },
  };
}

export function createAsterV3FuturesClient(config: AsterV3Config) {
  const baseUrl = config.futuresBaseUrl || DEFAULT_FUTURES_V3_BASE_URL;
  const { user, signer, signerPrivateKey } = config;

  async function request(path: string, options: AsterRequestOptions = {}) {
    const { method = "GET", params = {} } = options;
    if (options.signed !== false && method !== "GET") {
      return makeV3Request(baseUrl, path, user, signer, signerPrivateKey, options);
    }
    const queryString = buildQueryString(params);
    const url = queryString ? `${baseUrl}${path}?${queryString}` : `${baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { method, signal: controller.signal });
      clearTimeout(timeoutId);
      const text = await response.text();
      try { return JSON.parse(text); } catch { throw new Error(`Invalid JSON: ${text.substring(0, 200)}`); }
    } catch (e: any) {
      clearTimeout(timeoutId);
      throw e;
    }
  }

  return {
    async noop(): Promise<any> {
      return makeV3Request(baseUrl, "/fapi/v3/noop", user, signer, signerPrivateKey, { method: "POST" });
    },

    async ping(): Promise<boolean> {
      try {
        await request("/fapi/v3/ping", { signed: false });
        return true;
      } catch {
        return false;
      }
    },

    async exchangeInfo(): Promise<any> {
      return request("/fapi/v3/exchangeInfo", { signed: false });
    },

    async ticker(symbol?: string): Promise<AsterTicker | AsterTicker[]> {
      const params: Record<string, string | number | boolean | undefined> = {};
      if (symbol) params.symbol = symbol;
      return request("/fapi/v3/ticker/24hr", { params, signed: false });
    },

    async tickerPrice(symbol?: string): Promise<any> {
      const params: Record<string, string | number | boolean | undefined> = {};
      if (symbol) params.symbol = symbol;
      return request("/fapi/v3/ticker/price", { params, signed: false });
    },

    async orderBook(symbol: string, limit: number = 20): Promise<AsterOrderBook> {
      return request("/fapi/v3/depth", { params: { symbol, limit }, signed: false });
    },

    async klines(symbol: string, interval: string = "1h", limit: number = 100): Promise<AsterKline[]> {
      const raw = await request("/fapi/v3/klines", { params: { symbol, interval, limit }, signed: false });
      if (!Array.isArray(raw)) return [];
      return raw.map((k: any[]) => ({
        openTime: k[0], open: String(k[1]), high: String(k[2]), low: String(k[3]),
        close: String(k[4]), volume: String(k[5]), closeTime: k[6],
        quoteVolume: String(k[7]), trades: k[8] || 0,
      }));
    },

    async fundingRate(symbol?: string, limit: number = 20): Promise<AsterFundingRate[]> {
      const params: Record<string, string | number | boolean | undefined> = { limit };
      if (symbol) params.symbol = symbol;
      return request("/fapi/v3/fundingRate", { params, signed: false });
    },

    async premiumIndex(symbol?: string): Promise<any> {
      const params: Record<string, string | number | boolean | undefined> = {};
      if (symbol) params.symbol = symbol;
      return request("/fapi/v3/premiumIndex", { params, signed: false });
    },

    async balance(): Promise<AsterBalance[]> {
      return makeV3Request(baseUrl, "/fapi/v3/balance", user, signer, signerPrivateKey, { method: "GET" });
    },

    async account(): Promise<any> {
      return makeV3Request(baseUrl, "/fapi/v3/account", user, signer, signerPrivateKey, { method: "GET" });
    },

    async positions(): Promise<AsterPosition[]> {
      const data = await makeV3Request(baseUrl, "/fapi/v3/positionRisk", user, signer, signerPrivateKey, { method: "GET" });
      if (Array.isArray(data)) return data;
      return [];
    },

    async createOrder(orderParams: AsterNewOrderParams): Promise<AsterOrder> {
      const params: Record<string, string | number | boolean | undefined> = {
        symbol: orderParams.symbol,
        side: orderParams.side,
        type: orderParams.type,
      };
      if (orderParams.quantity) params.quantity = orderParams.quantity;
      if (orderParams.price) params.price = orderParams.price;
      if (orderParams.stopPrice) params.stopPrice = orderParams.stopPrice;
      if (orderParams.timeInForce) params.timeInForce = orderParams.timeInForce;
      if (orderParams.reduceOnly !== undefined) params.reduceOnly = orderParams.reduceOnly;
      if (orderParams.closePosition !== undefined) params.closePosition = orderParams.closePosition;
      if (orderParams.positionSide) params.positionSide = orderParams.positionSide;
      if (orderParams.newClientOrderId) params.newClientOrderId = orderParams.newClientOrderId;
      if (orderParams.quoteOrderQty) params.quoteOrderQty = orderParams.quoteOrderQty;
      if (orderParams.activationPrice) params.activationPrice = orderParams.activationPrice;
      if (orderParams.callbackRate) params.callbackRate = orderParams.callbackRate;
      if (orderParams.workingType) params.workingType = orderParams.workingType;
      if (orderParams.type === "LIMIT" && !params.timeInForce) params.timeInForce = "GTC";
      return makeV3Request(baseUrl, "/fapi/v3/order", user, signer, signerPrivateKey, { method: "POST", params });
    },

    async cancelOrder(symbol: string, orderId: number): Promise<AsterOrder> {
      return makeV3Request(baseUrl, "/fapi/v3/order", user, signer, signerPrivateKey, {
        method: "DELETE", params: { symbol, orderId },
      });
    },

    async cancelAllOrders(symbol: string): Promise<any> {
      return makeV3Request(baseUrl, "/fapi/v3/allOpenOrders", user, signer, signerPrivateKey, {
        method: "DELETE", params: { symbol },
      });
    },

    async openOrders(symbol?: string): Promise<AsterOrder[]> {
      const params: Record<string, string | number | boolean | undefined> = {};
      if (symbol) params.symbol = symbol;
      return makeV3Request(baseUrl, "/fapi/v3/openOrders", user, signer, signerPrivateKey, { method: "GET", params });
    },

    async allOrders(symbol: string, limit: number = 50): Promise<AsterOrder[]> {
      return makeV3Request(baseUrl, "/fapi/v3/allOrders", user, signer, signerPrivateKey, { method: "GET", params: { symbol, limit } });
    },

    async userTrades(symbol: string, limit: number = 50): Promise<any[]> {
      return makeV3Request(baseUrl, "/fapi/v3/userTrades", user, signer, signerPrivateKey, { method: "GET", params: { symbol, limit } });
    },

    async setLeverage(symbol: string, leverage: number): Promise<any> {
      return makeV3Request(baseUrl, "/fapi/v3/leverage", user, signer, signerPrivateKey, {
        method: "POST", params: { symbol, leverage },
      });
    },

    async setMarginType(symbol: string, marginType: "ISOLATED" | "CROSSED"): Promise<any> {
      return makeV3Request(baseUrl, "/fapi/v3/marginType", user, signer, signerPrivateKey, {
        method: "POST", params: { symbol, marginType },
      });
    },

    async setPositionMode(dualSidePosition: boolean): Promise<any> {
      return makeV3Request(baseUrl, "/fapi/v3/positionSide/dual", user, signer, signerPrivateKey, {
        method: "POST", params: { dualSidePosition },
      });
    },

    async income(incomeType?: string, limit: number = 50): Promise<any[]> {
      const params: Record<string, string | number | boolean | undefined> = { limit };
      if (incomeType) params.incomeType = incomeType;
      return makeV3Request(baseUrl, "/fapi/v3/income", user, signer, signerPrivateKey, { method: "GET", params });
    },
  };
}

export function createAsterSpotClient(config: AsterClientConfig) {
  const baseUrl = config.spotBaseUrl || DEFAULT_SPOT_BASE_URL;
  const { apiKey, apiSecret } = config;

  async function request(path: string, options: AsterRequestOptions = {}) {
    return makeRequest(baseUrl, path, apiKey, apiSecret, options);
  }

  return {
    async ping(): Promise<boolean> {
      try {
        await request("/sapi/v1/ping");
        return true;
      } catch {
        return false;
      }
    },

    async ticker(symbol?: string): Promise<AsterTicker | AsterTicker[]> {
      const params: Record<string, string | number | boolean | undefined> = {};
      if (symbol) params.symbol = symbol;
      return request("/sapi/v1/ticker/24hr", { params });
    },

    async tickerPrice(symbol?: string): Promise<any> {
      const params: Record<string, string | number | boolean | undefined> = {};
      if (symbol) params.symbol = symbol;
      return request("/sapi/v1/ticker/price", { params });
    },

    async orderBook(symbol: string, limit: number = 20): Promise<AsterOrderBook> {
      return request("/sapi/v1/depth", { params: { symbol, limit } });
    },

    async account(): Promise<AsterSpotAccount> {
      return request("/sapi/v1/account", { signed: true });
    },

    async createOrder(orderParams: AsterSpotNewOrderParams): Promise<AsterSpotOrder> {
      const params: Record<string, string | number | boolean | undefined> = {
        symbol: orderParams.symbol,
        side: orderParams.side,
        type: orderParams.type,
      };
      if (orderParams.quantity) params.quantity = orderParams.quantity;
      if (orderParams.price) params.price = orderParams.price;
      if (orderParams.timeInForce) params.timeInForce = orderParams.timeInForce;
      if (orderParams.quoteOrderQty) params.quoteOrderQty = orderParams.quoteOrderQty;
      if (orderParams.newClientOrderId) params.newClientOrderId = orderParams.newClientOrderId;
      if (orderParams.type === "LIMIT" && !params.timeInForce) {
        params.timeInForce = "GTC";
      }
      return request("/sapi/v1/order", { method: "POST", signed: true, params });
    },

    async cancelOrder(symbol: string, orderId: number): Promise<AsterSpotOrder> {
      return request("/sapi/v1/order", {
        method: "DELETE",
        signed: true,
        params: { symbol, orderId },
      });
    },

    async openOrders(symbol?: string): Promise<AsterSpotOrder[]> {
      const params: Record<string, string | number | boolean | undefined> = {};
      if (symbol) params.symbol = symbol;
      return request("/sapi/v1/openOrders", { signed: true, params });
    },
  };
}

export type AsterWsCallback = (data: any) => void;

export interface AsterWsStream {
  subscribe(streams: string[]): void;
  unsubscribe(streams: string[]): void;
  close(): void;
  isConnected(): boolean;
}

export function createAsterWsStream(onMessage: AsterWsCallback, onError?: (err: Error) => void): AsterWsStream {
  let ws: any = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let subscribedStreams: string[] = [];
  let msgId = 1;
  let closed = false;

  function connect() {
    if (closed) return;
    try {
      const WebSocket = require("ws");
      ws = new WebSocket(`${WS_BASE_URL}/ws`);

      ws.on("open", () => {
        console.log("[AsterWS] Connected");
        if (subscribedStreams.length > 0) {
          ws.send(JSON.stringify({ method: "SUBSCRIBE", params: subscribedStreams, id: msgId++ }));
        }
        pingTimer = setInterval(() => {
          if (ws?.readyState === 1) ws.pong();
        }, 60000);
      });

      ws.on("message", (raw: any) => {
        try {
          const data = JSON.parse(raw.toString());
          onMessage(data);
        } catch {}
      });

      ws.on("close", () => {
        console.log("[AsterWS] Disconnected");
        cleanup();
        if (!closed) {
          reconnectTimer = setTimeout(connect, 5000);
        }
      });

      ws.on("error", (err: Error) => {
        console.error("[AsterWS] Error:", err.message);
        if (onError) onError(err);
      });

      ws.on("ping", () => {
        if (ws?.readyState === 1) ws.pong();
      });
    } catch (e: any) {
      console.error("[AsterWS] Connection failed:", e.message);
      if (!closed) {
        reconnectTimer = setTimeout(connect, 10000);
      }
    }
  }

  function cleanup() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }

  connect();

  return {
    subscribe(streams: string[]) {
      for (const s of streams) {
        if (!subscribedStreams.includes(s)) subscribedStreams.push(s);
      }
      if (ws?.readyState === 1) {
        ws.send(JSON.stringify({ method: "SUBSCRIBE", params: streams, id: msgId++ }));
      }
    },

    unsubscribe(streams: string[]) {
      subscribedStreams = subscribedStreams.filter(s => !streams.includes(s));
      if (ws?.readyState === 1) {
        ws.send(JSON.stringify({ method: "UNSUBSCRIBE", params: streams, id: msgId++ }));
      }
    },

    close() {
      closed = true;
      cleanup();
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ws) { try { ws.close(); } catch {} ws = null; }
    },

    isConnected() {
      return ws?.readyState === 1;
    },
  };
}

export function createAsterClient(config: AsterClientConfig) {
  return {
    futures: createAsterFuturesClient(config),
    spot: createAsterSpotClient(config),
  };
}

export type AsterFuturesClient = ReturnType<typeof createAsterFuturesClient>;
export type AsterV3FuturesClient = ReturnType<typeof createAsterV3FuturesClient>;
export type AsterSpotClient = ReturnType<typeof createAsterSpotClient>;
export type AsterClient = ReturnType<typeof createAsterClient>;

export type {
  AsterClientConfig,
  AsterV3Config,
  AsterTicker,
  AsterOrderBook,
  AsterOrderBookEntry,
  AsterKline,
  AsterFundingRate,
  AsterBalance,
  AsterPosition,
  AsterOrder,
  AsterNewOrderParams,
  AsterSpotBalance,
  AsterSpotAccount,
  AsterSpotOrder,
  AsterSpotNewOrderParams,
  BrokerOnboardResult,
};
