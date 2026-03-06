import crypto from "crypto";

interface AsterClientConfig {
  apiKey: string;
  apiSecret: string;
  futuresBaseUrl?: string;
  spotBaseUrl?: string;
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
}

interface AsterNewOrderParams {
  symbol: string;
  side: "BUY" | "SELL";
  type: "LIMIT" | "MARKET" | "STOP" | "STOP_MARKET" | "TAKE_PROFIT" | "TAKE_PROFIT_MARKET";
  quantity?: string;
  price?: string;
  stopPrice?: string;
  timeInForce?: "GTC" | "IOC" | "FOK";
  reduceOnly?: boolean;
  closePosition?: boolean;
  positionSide?: "BOTH" | "LONG" | "SHORT";
  newClientOrderId?: string;
  quoteOrderQty?: string;
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

const DEFAULT_FUTURES_BASE_URL = "https://fapi.asterdex.com";
const DEFAULT_SPOT_BASE_URL = "https://sapi.asterdex.com";
const REQUEST_TIMEOUT_MS = 15000;

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

export function createAsterClient(config: AsterClientConfig) {
  return {
    futures: createAsterFuturesClient(config),
    spot: createAsterSpotClient(config),
  };
}

export type AsterFuturesClient = ReturnType<typeof createAsterFuturesClient>;
export type AsterSpotClient = ReturnType<typeof createAsterSpotClient>;
export type AsterClient = ReturnType<typeof createAsterClient>;

export type {
  AsterClientConfig,
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
};
