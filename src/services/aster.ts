import axios, { AxiosInstance } from 'axios'
import { ethers } from 'ethers'
import { OHLCV } from '../agents/indicators'

// ─────────────────────────────────────────────────────────────────────────────
// Aster DEX Pro API (v3) — EIP-712 Web3-native authentication
//
// ALL signed calls use EIP-712. No HMAC API keys. No X-MBX-APIKEY header.
// Every request is signed by the SIGNER (agent wallet) on behalf of USER.
//
// Base URLs:
//   REST (public market data): https://fapi.asterdex.com  (no auth)
//   REST (signed):             https://fapi3.asterdex.com (EIP-712)
//   WebSocket:                 wss://fstream.asterdex.com
//
// Docs: https://asterdex.github.io/aster-api-website/futures-v3/general-info/
// ─────────────────────────────────────────────────────────────────────────────

const BASE_PUBLIC  = 'https://fapi.asterdex.com'   // public market data
// Signed v3 endpoints live on the SAME host as public market data.
// The legacy `fapi3.asterdex.com` host is Cloudflare-blocking our egress
// (every request → HTML 403 even for /ping), while fapi.asterdex.com
// returns proper JSON for /fapi/v3/* signed endpoints.
const BASE_SIGNED  = 'https://fapi.asterdex.com'

// EIP-712 domain — same for all calls
const EIP712_DOMAIN = {
  name:              'AsterSignTransaction',
  version:           '1',
  chainId:           1666,
  verifyingContract: '0x0000000000000000000000000000000000000000'
}

const EIP712_TYPES = {
  Message: [{ name: 'msg', type: 'string' }]
}

// ─────────────────────────────────────────────────────────────────────────────
// Nonce — microsecond precision, monotonically increasing
// ─────────────────────────────────────────────────────────────────────────────
let _lastSec = 0
let _seq = 0

function getNonce(): number {
  const nowSec = Math.floor(Date.now() / 1000)
  if (nowSec === _lastSec) {
    _seq++
  } else {
    _lastSec = nowSec
    _seq = 0
  }
  return nowSec * 1_000_000 + _seq
}

// ─────────────────────────────────────────────────────────────────────────────
// EIP-712 signer — signs the querystring as the `msg` field
// signerPrivateKey = the AGENT wallet private key (not the user's key)
// ─────────────────────────────────────────────────────────────────────────────
async function signRequest(
  params: Record<string, string | number | boolean>,
  signerPrivateKey: string
): Promise<string> {
  const queryString = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ).toString()

  const wallet  = new ethers.Wallet(signerPrivateKey)
  const message = { msg: queryString }
  const sig     = await wallet.signTypedData(EIP712_DOMAIN, EIP712_TYPES, message)

  return queryString + '&signature=' + sig
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP client
// ─────────────────────────────────────────────────────────────────────────────
function client(base: string): AxiosInstance {
  return axios.create({
    baseURL: base,
    timeout: 10_000,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // Aster sits behind Cloudflare. The default axios UA ("axios/1.x.x")
      // gets edge-blocked with an HTML 403, so we send a normal browser UA.
      'User-Agent':   'Mozilla/5.0 (compatible; BUILD4-Bot/1.0)',
      'Accept':       'application/json'
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC MARKET DATA — no auth needed, uses fapi.asterdex.com
// ─────────────────────────────────────────────────────────────────────────────

export async function getKlines(
  pair: string,
  interval: string = '15m',
  limit: number = 200
): Promise<OHLCV> {
  const symbol = pair.replace('/', '')
  try {
    const res = await client(BASE_PUBLIC).get('/fapi/v1/klines', {
      params: { symbol, interval, limit }
    })
    const candles = res.data as any[][]
    return {
      open:       candles.map((c) => parseFloat(c[1])),
      high:       candles.map((c) => parseFloat(c[2])),
      low:        candles.map((c) => parseFloat(c[3])),
      close:      candles.map((c) => parseFloat(c[4])),
      volume:     candles.map((c) => parseFloat(c[5])),
      timestamps: candles.map((c) => c[0] as number)
    }
  } catch (err) {
    console.error('[Aster] getKlines failed, using mock:', (err as any).message)
    const { generateMockOHLCV } = await import('../agents/indicators')
    const bases: Record<string, number> = {
      BTCUSDT: 65000, ETHUSDT: 3500, BNBUSDT: 580, SOLUSDT: 170, ARBUSDT: 1.2
    }
    return generateMockOHLCV(bases[symbol] ?? 100, limit, 0.002)
  }
}

export async function getMarkPrice(pair: string): Promise<{
  markPrice: number; indexPrice: number; lastFundingRate: number
}> {
  const symbol = pair.replace('/', '')
  try {
    const res = await client(BASE_PUBLIC).get('/fapi/v1/premiumIndex', {
      params: { symbol }
    })
    return {
      markPrice:       parseFloat(res.data.markPrice),
      indexPrice:      parseFloat(res.data.indexPrice),
      lastFundingRate: parseFloat(res.data.lastFundingRate ?? '0')
    }
  } catch {
    const { getPrice } = await import('./price')
    const data = await getPrice(pair.split('/')[0])
    return { markPrice: data.price, indexPrice: data.price, lastFundingRate: 0 }
  }
}

export async function ping(): Promise<boolean> {
  try {
    await client(BASE_PUBLIC).get('/fapi/v1/ping')
    return true
  } catch {
    return false
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNED ACCOUNT ENDPOINTS — use fapi3.asterdex.com + EIP-712
//
// Every signed call needs:
//   user   = user's main wallet address
//   signer = agent wallet address  (your platform's agent)
//   nonce  = current microsecond timestamp
//   + EIP-712 signature of the full querystring
// ─────────────────────────────────────────────────────────────────────────────

export interface AsterCredentials {
  userAddress:    string   // user's main wallet address
  signerAddress:  string   // agent wallet address
  signerPrivKey:  string   // agent wallet private key (NEVER the user's)
}

async function signedGET(path: string, params: Record<string, any>, creds: AsterCredentials) {
  const nonce = getNonce()
  const full  = { user: creds.userAddress, signer: creds.signerAddress, nonce, ...params }
  const qs    = await signRequest(full, creds.signerPrivKey)

  // TEMP DEBUG — remove after 403 root cause is confirmed
  if (process.env.ASTER_DEBUG === '1') {
    const derived = new ethers.Wallet(creds.signerPrivKey).address
    console.log('[Aster DEBUG]', path, {
      user:               creds.userAddress,
      signer:             creds.signerAddress,
      derivedFromPK:      derived,
      signerMatchesPK:    derived.toLowerCase() === creds.signerAddress.toLowerCase(),
      signerMatchesEnv:   creds.signerAddress.toLowerCase() === (process.env.ASTER_AGENT_ADDRESS ?? '').toLowerCase(),
      nonce,
      baseUrl:            BASE_SIGNED
    })
  }

  try {
    return await client(BASE_SIGNED).get(path + '?' + qs)
  } catch (err: any) {
    if (process.env.ASTER_DEBUG === '1') {
      console.log('[Aster DEBUG] error', path, {
        status:  err?.response?.status,
        data:    err?.response?.data,
        message: err?.message
      })
    }
    throw err
  }
}

async function signedPOST(path: string, params: Record<string, any>, creds: AsterCredentials) {
  const nonce = getNonce()
  const full  = { user: creds.userAddress, signer: creds.signerAddress, nonce, ...params }
  const qs    = await signRequest(full, creds.signerPrivKey)
  return client(BASE_SIGNED).post(path + '?' + qs)
}

async function signedDELETE(path: string, params: Record<string, any>, creds: AsterCredentials) {
  const nonce = getNonce()
  const full  = { user: creds.userAddress, signer: creds.signerAddress, nonce, ...params }
  const qs    = await signRequest(full, creds.signerPrivKey)
  return client(BASE_SIGNED).delete(path + '?' + qs)
}

// ─────────────────────────────────────────────────────────────────────────────
// Account balance
// ─────────────────────────────────────────────────────────────────────────────

export async function getAccountBalance(creds: AsterCredentials): Promise<{
  usdt: number; availableMargin: number
}> {
  try {
    const res = await signedGET('/fapi/v3/balance', {}, creds)
    const usdt = (res.data as any[]).find(
      (a: any) => a.asset === 'USDT' || a.asset === 'USD'
    )
    return {
      usdt:            parseFloat(usdt?.balance ?? '0'),
      availableMargin: parseFloat(usdt?.availableBalance ?? '0')
    }
  } catch (err: any) {
    console.error('[Aster] getAccountBalance failed:', err?.response?.data ?? err.message)
    return { usdt: 0, availableMargin: 0 }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Asset transfer between BSC wallet (SPOT side of Aster) and Futures account.
//
// kindType:
//   'SPOT_FUTURE' = move USDT from your BSC wallet INTO your Aster futures account
//   'FUTURE_SPOT' = move USDT from your Aster futures account BACK to your BSC wallet
//
// Signed by the platform agent on behalf of the user (same broker model as
// every other v3 endpoint). Returns Aster's tranId so the caller can show
// it to the user / poll for confirmation.
// ─────────────────────────────────────────────────────────────────────────────
export async function transferAsset(
  creds:    AsterCredentials,
  amount:   string,
  kindType: 'SPOT_FUTURE' | 'FUTURE_SPOT'
): Promise<{ success: boolean; tranId?: string; error?: string }> {
  try {
    const res = await signedPOST('/fapi/v3/asset/wallet/transfer', {
      amount,
      asset:        'USDT',
      kindType,
      clientTranId: Date.now().toString()
    }, creds)
    return { success: true, tranId: String(res.data?.tranId ?? '') }
  } catch (err: any) {
    const msg = err?.response?.data?.msg ?? err?.response?.data?.message ?? err?.message ?? 'transfer_failed'
    console.error('[Aster] transferAsset failed:', creds.userAddress, kindType, amount, '→',
      err?.response?.status, err?.response?.data ?? msg)
    return { success: false, error: String(msg) }
  }
}

// Strict variant — throws on error so callers can surface the real reason
// to the user (e.g. "signer not approved", "user not registered on Aster").
export async function getAccountBalanceStrict(creds: AsterCredentials): Promise<{
  usdt: number; availableMargin: number; raw: any[]
}> {
  const res = await signedGET('/fapi/v3/balance', {}, creds)
  const all = res.data as any[]
  const usdt = all.find((a: any) => a.asset === 'USDT' || a.asset === 'USD')
  return {
    usdt:            parseFloat(usdt?.balance ?? '0'),
    availableMargin: parseFloat(usdt?.availableBalance ?? '0'),
    raw:             all
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Open positions
// ─────────────────────────────────────────────────────────────────────────────

export interface AsterPosition {
  symbol:           string
  side:             'LONG' | 'SHORT'
  size:             number
  entryPrice:       number
  markPrice:        number
  unrealizedPnl:    number
  leverage:         number
  liquidationPrice: number
  marginType:       string
}

export async function getPositions(
  creds: AsterCredentials,
  symbol?: string
): Promise<AsterPosition[]> {
  try {
    const params: any = {}
    if (symbol) params.symbol = symbol.replace('/', '')
    const res = await signedGET('/fapi/v3/positionRisk', params, creds)
    return (res.data as any[])
      .filter((p: any) => parseFloat(p.positionAmt) !== 0)
      .map((p: any) => ({
        symbol:           p.symbol,
        side:             parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
        size:             Math.abs(parseFloat(p.positionAmt)),
        entryPrice:       parseFloat(p.entryPrice),
        markPrice:        parseFloat(p.markPrice),
        unrealizedPnl:    parseFloat(p.unRealizedProfit),
        leverage:         parseFloat(p.leverage),
        liquidationPrice: parseFloat(p.liquidationPrice),
        marginType:       p.marginType
      }))
  } catch (err: any) {
    console.error('[Aster] getPositions failed:', err?.response?.data ?? err.message)
    return []
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Set leverage
// ─────────────────────────────────────────────────────────────────────────────

export async function setLeverage(
  symbol: string,
  leverage: number,
  creds: AsterCredentials
): Promise<void> {
  try {
    await signedPOST('/fapi/v3/leverage',
      { symbol: symbol.replace('/', ''), leverage },
      creds
    )
  } catch (err: any) {
    console.error('[Aster] setLeverage failed:', err?.response?.data ?? err.message)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Place order — standard (non-builder) v3 route
// ─────────────────────────────────────────────────────────────────────────────

export interface OrderResult {
  orderId:       number | string
  symbol:        string
  side:          string
  type:          string
  status:        string
  avgPrice:      number
  executedQty:   number
  clientOrderId: string
}

export async function placeOrder(params: {
  symbol:        string
  side:          'BUY' | 'SELL'
  type:          'MARKET' | 'LIMIT'
  quantity:      number
  price?:        number
  reduceOnly?:   boolean
  positionSide?: 'BOTH' | 'LONG' | 'SHORT'
  leverage?:     number
  creds:         AsterCredentials
}): Promise<OrderResult> {
  const { creds, leverage, ...rest } = params
  const symbol = rest.symbol.replace('/', '')

  if (leverage && leverage > 1) {
    await setLeverage(symbol, leverage, creds)
  }

  const body: Record<string, any> = {
    symbol,
    side:         rest.side,
    type:         rest.type,
    quantity:     rest.quantity.toString(),
    positionSide: rest.positionSide ?? 'BOTH'
  }
  if (rest.type === 'LIMIT' && rest.price) {
    body.price       = rest.price.toString()
    body.timeInForce = 'GTC'
  }
  if (rest.reduceOnly) body.reduceOnly = 'true'

  const res = await signedPOST('/fapi/v3/order', body, creds)
  return {
    orderId:       res.data.orderId,
    symbol:        res.data.symbol,
    side:          res.data.side,
    type:          res.data.type,
    status:        res.data.status,
    avgPrice:      parseFloat(res.data.avgPrice ?? '0'),
    executedQty:   parseFloat(res.data.executedQty ?? '0'),
    clientOrderId: res.data.clientOrderId ?? ''
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Place order — Builder (Aster Code) route
// Attaches builder address + feeRate for fee attribution
// ─────────────────────────────────────────────────────────────────────────────

export async function placeOrderWithBuilderCode(params: {
  symbol:         string
  side:           'BUY' | 'SELL'
  type:           'MARKET' | 'LIMIT'
  quantity:       number
  price?:         number
  builderAddress: string
  feeRate:        string
  creds:          AsterCredentials
}): Promise<OrderResult> {
  const { creds, builderAddress, feeRate, ...rest } = params
  const symbol = rest.symbol.replace('/', '')

  const body: Record<string, any> = {
    symbol,
    side:    rest.side,
    type:    rest.type,
    quantity: rest.quantity.toString(),
    builder: builderAddress,
    feeRate
  }
  if (rest.type === 'LIMIT' && rest.price) {
    body.price       = rest.price.toString()
    body.timeInForce = 'GTC'
  }

  const res = await signedPOST('/fapi/v3/order', body, creds)
  return {
    orderId:       res.data.data?.orderId ?? res.data.orderId ?? 0,
    symbol,
    side:          rest.side,
    type:          rest.type,
    status:        res.data.data?.status ?? res.data.status ?? 'NEW',
    avgPrice:      parseFloat(res.data.avgPrice ?? '0'),
    executedQty:   rest.quantity,
    clientOrderId: ''
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Close a position (market reduce-only)
// ─────────────────────────────────────────────────────────────────────────────

export async function closePosition(
  symbol:   string,
  side:     'LONG' | 'SHORT',
  size:     number,
  creds:    AsterCredentials
): Promise<OrderResult> {
  return placeOrder({
    symbol,
    side:        side === 'LONG' ? 'SELL' : 'BUY',
    type:        'MARKET',
    quantity:    size,
    reduceOnly:  true,
    creds
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// SL + TP bracket orders
// ─────────────────────────────────────────────────────────────────────────────

export async function placeBracketOrders(params: {
  symbol:     string
  side:       'LONG' | 'SHORT'
  stopLoss:   number
  takeProfit: number
  quantity:   number
  creds:      AsterCredentials
}): Promise<void> {
  const closeSide = params.side === 'LONG' ? 'SELL' : 'BUY'
  const symbol    = params.symbol.replace('/', '')

  // Stop loss
  try {
    await signedPOST('/fapi/v3/order', {
      symbol,
      side:          closeSide,
      type:          'STOP_MARKET',
      stopPrice:     params.stopLoss.toString(),
      closePosition: 'true',
      workingType:   'MARK_PRICE'
    }, params.creds)
  } catch (err: any) {
    console.error('[Aster] SL order failed:', err?.response?.data ?? err.message)
  }

  // Take profit
  try {
    await signedPOST('/fapi/v3/order', {
      symbol,
      side:          closeSide,
      type:          'TAKE_PROFIT_MARKET',
      stopPrice:     params.takeProfit.toString(),
      closePosition: 'true',
      workingType:   'MARK_PRICE'
    }, params.creds)
  } catch (err: any) {
    console.error('[Aster] TP order failed:', err?.response?.data ?? err.message)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancel an order
// ─────────────────────────────────────────────────────────────────────────────

export async function cancelOrder(
  symbol:  string,
  orderId: number | string,
  creds:   AsterCredentials
): Promise<void> {
  try {
    await signedDELETE('/fapi/v3/order',
      { symbol: symbol.replace('/', ''), orderId },
      creds
    )
  } catch (err: any) {
    console.error('[Aster] cancelOrder failed:', err?.response?.data ?? err.message)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Aster Code — Approve Agent (user signs to allow your agent to trade)
// This is called ONCE per user during onboarding
// The user's wallet signs this — pass their decrypted private key temporarily
// ─────────────────────────────────────────────────────────────────────────────

export async function approveAgent(params: {
  userAddress:       string
  userPrivateKey:    string  // user's wallet key — only used to sign this one tx
  agentAddress:      string  // your platform's agent wallet address
  agentName:         string
  builderAddress:    string
  maxFeeRate:        string
  expiredDays?:      number
}): Promise<{ success: boolean; error?: string }> {
  const expired  = Date.now() + (params.expiredDays ?? 365) * 86_400_000
  const nonce    = getNonce()

  // Management endpoints use a different EIP-712 primaryType
  // The field names are PascalCase (see auth docs: "field names are uppercased for first letter")
  const typedData = {
    types: {
      EIP712Domain: [
        { name: 'name',             type: 'string'  },
        { name: 'version',          type: 'string'  },
        { name: 'chainId',          type: 'uint256' },
        { name: 'verifyingContract', type: 'address' }
      ],
      ApproveAgent: [
        { name: 'User',           type: 'string'  },
        { name: 'Nonce',          type: 'uint256' },
        { name: 'AgentName',      type: 'string'  },
        { name: 'AgentAddress',   type: 'string'  },
        { name: 'Expired',        type: 'uint256' },
        { name: 'CanSpotTrade',   type: 'bool'    },
        { name: 'CanPerpTrade',   type: 'bool'    },
        { name: 'CanWithdraw',    type: 'bool'    },
        { name: 'Builder',        type: 'string'  },
        { name: 'MaxFeeRate',     type: 'string'  },
        { name: 'BuilderName',    type: 'string'  }
      ]
    },
    primaryType: 'ApproveAgent' as const,
    domain:      EIP712_DOMAIN,
    message: {
      User:         params.userAddress,
      Nonce:        nonce,
      AgentName:    params.agentName,
      AgentAddress: params.agentAddress,
      Expired:      expired,
      CanSpotTrade: false,
      CanPerpTrade: true,
      CanWithdraw:  false,
      Builder:      params.builderAddress,
      MaxFeeRate:   params.maxFeeRate,
      BuilderName:  'BUILD4'
    }
  }

  try {
    const wallet = new ethers.Wallet(params.userPrivateKey)
    const sig = await wallet.signTypedData(
      typedData.domain,
      { ApproveAgent: typedData.types.ApproveAgent },
      typedData.message
    )

    const body = new URLSearchParams({
      user:         params.userAddress,
      nonce:        String(nonce),
      signature:    sig,
      agentName:    params.agentName,
      agentAddress: params.agentAddress,
      expired:      String(expired),
      canSpotTrade: 'false',
      canPerpTrade: 'true',
      canWithdraw:  'false',
      builder:      params.builderAddress,
      maxFeeRate:   params.maxFeeRate,
      builderName:  'BUILD4'
    }).toString()

    // POST with form-encoded body (NOT querystring — Aster's edge 403s
    // when the body is empty on a form-urlencoded POST).
    const resp = await client(BASE_SIGNED).post(
      '/fapi/v3/approveAgent',
      body,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    )
    console.log('[Aster] approveAgent ok:', params.userAddress, '→', resp.status, resp.data)
    return { success: true }
  } catch (err: any) {
    // Always log the full failure so we can diagnose 403s without needing
    // a debug flag — this only fires on the rare onboarding path.
    console.error('[Aster] approveAgent FAILED', {
      user:           params.userAddress,
      agent:          params.agentAddress,
      builder:        params.builderAddress,
      maxFeeRate:     params.maxFeeRate,
      nonce,
      expired,
      httpStatus:     err?.response?.status,
      httpStatusText: err?.response?.statusText,
      respHeaders:    err?.response?.headers,
      respData:       err?.response?.data,
      message:        err?.message
    })
    const msg = err?.response?.data?.msg
              ?? err?.response?.data?.message
              ?? err?.response?.data
              ?? err.message
    return { success: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg) }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Deposit address
// ─────────────────────────────────────────────────────────────────────────────

export async function getDepositAddress(creds: AsterCredentials): Promise<{
  address: string; network: string
} | null> {
  try {
    const res = await signedGET('/fapi/v3/capital/deposit/address',
      { coin: 'USDT', network: 'BSC' },
      creds
    )
    return { address: res.data.address, network: res.data.network ?? 'BSC' }
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket helpers
// ─────────────────────────────────────────────────────────────────────────────

export function getKlineStreamUrl(symbol: string, interval: string): string {
  return `wss://fstream.asterdex.com/stream?streams=${symbol.replace('/', '').toLowerCase()}@kline_${interval}`
}

export async function createListenKey(creds: AsterCredentials): Promise<string> {
  try {
    const res = await signedPOST('/fapi/v3/listenKey', {}, creds)
    return res.data.listenKey ?? ''
  } catch {
    return ''
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Build AsterCredentials from environment + user DB record
// ─────────────────────────────────────────────────────────────────────────────

export function buildCreds(
  userAddress:   string,
  agentAddress?: string | null,
  agentPrivKey?: string | null
): AsterCredentials | null {
  const addr = agentAddress ?? process.env.ASTER_AGENT_ADDRESS
  const key  = agentPrivKey ?? process.env.ASTER_AGENT_PRIVATE_KEY

  if (!addr || !key || !userAddress) return null

  return {
    userAddress,
    signerAddress: addr,
    signerPrivKey: key
  }
}
