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

// Aster /fapi/v1/klines accepts only this exact set of intervals — anything
// else (e.g. "1H", "60m", "5min") returns 400.
const VALID_KLINE_INTERVALS = new Set([
  '1m', '3m', '5m', '15m', '30m',
  '1h', '2h', '4h', '6h', '8h', '12h',
  '1d', '3d', '1w', '1M'
])

// Defensive guard — any caller (agent runner, /price command, mini-app
// charts, future code) that hands us an obviously-bad symbol gets caught
// here instead of producing a 400 + mock-data fallback. The agent runner
// already expands 'ALL' upstream via expandPairs(); this is belt-and-
// suspenders for everything else.
const REJECTED_SYMBOLS = new Set(['ALL', 'UNDEFINED', 'NULL', 'NONE', ''])

// Process-wide klines cache. With 9k+ agents trading the same 7 pairs, the
// per-tick fan-out was 9,449 × 21 = ~200k requests/min to fapi.asterdex.com,
// guaranteed to get rate-limited. With 60s TTL and 7 pairs × 3 timeframes,
// we serve ≤21 unique upstream calls per minute regardless of agent count.
// In-flight de-duplication via inflightKlines prevents thundering-herd on
// cache miss when 9k agents tick simultaneously.
const KLINES_CACHE_TTL_MS = 60_000
const klinesCache = new Map<string, { data: OHLCV; ts: number }>()
const inflightKlines = new Map<string, Promise<OHLCV>>()

export async function getKlines(
  pair: string,
  interval: string = '15m',
  limit: number = 200
): Promise<OHLCV> {
  // Aster requires UPPERCASE symbol with no separator (e.g. "BTCUSDT").
  // Lowercase, slashed, or whitespace-padded inputs all 400.
  let symbol = (pair ?? '').replace(/[\/\s]/g, '').toUpperCase()
  if (!symbol || REJECTED_SYMBOLS.has(symbol) || symbol.length < 5) {
    console.error(`[Aster] getKlines: invalid symbol "${pair}" (normalized="${symbol}") — defaulting to BTCUSDT`)
    symbol = 'BTCUSDT'
  }
  // Coerce interval to its canonical form (preserve case for the only
  // case-sensitive value, "1M" = 1 month vs "1m" = 1 minute).
  const intervalNormalized = VALID_KLINE_INTERVALS.has(interval)
    ? interval
    : (VALID_KLINE_INTERVALS.has(interval.toLowerCase()) ? interval.toLowerCase() : '15m')
  const safeLimit = Math.max(1, Math.min(1500, Math.floor(limit)))

  // ── Cache check (60s TTL, dedupes in-flight requests) ──
  const cacheKey = `${symbol}:${intervalNormalized}:${safeLimit}`
  const cached = klinesCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < KLINES_CACHE_TTL_MS) {
    return cached.data
  }
  const inflight = inflightKlines.get(cacheKey)
  if (inflight) return inflight

  const fetchPromise = (async (): Promise<OHLCV> => {
    console.log('[Aster] klines fetch (cache miss):', { symbol, interval: intervalNormalized, limit: safeLimit })
    try {
      const res = await client(BASE_PUBLIC).get('/fapi/v1/klines', {
        params: { symbol, interval: intervalNormalized, limit: safeLimit }
      })
      const candles = res.data as any[][]
      const result: OHLCV = {
        open:       candles.map((c) => parseFloat(c[1])),
        high:       candles.map((c) => parseFloat(c[2])),
        low:        candles.map((c) => parseFloat(c[3])),
        close:      candles.map((c) => parseFloat(c[4])),
        volume:     candles.map((c) => parseFloat(c[5])),
        timestamps: candles.map((c) => c[0] as number)
      }
      klinesCache.set(cacheKey, { data: result, ts: Date.now() })
      return result
    } finally {
      inflightKlines.delete(cacheKey)
    }
  })()
  inflightKlines.set(cacheKey, fetchPromise)

  try {
    return await fetchPromise
  } catch (err: any) {
    console.error(
      '[Aster] getKlines failed:',
      'msg=', err?.message,
      'status=', err?.response?.status,
      'detail=', JSON.stringify(err?.response?.data ?? null),
      'url=', err?.config?.url,
      'params=', JSON.stringify(err?.config?.params ?? null)
    )
    console.error('[Aster] FALLING BACK TO MOCK DATA — agents trading on simulated candles!')
    const { generateMockOHLCV } = await import('../agents/indicators')
    const bases: Record<string, number> = {
      BTCUSDT: 65000, ETHUSDT: 3500, BNBUSDT: 580, SOLUSDT: 170, ARBUSDT: 1.2
    }
    return generateMockOHLCV(bases[symbol] ?? 100, safeLimit, 0.002)
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
// Account balance — via Aster's public RPC (no signing required)
//
// Endpoint: POST https://tapi.asterdex.com/info
// Method:   aster_getBalance(address, "latest")
//
// Returns { perpAssets: [{asset, walletBalance, availableBalance, ...}],
//           positions: [...] } for any address that has an Aster futures
// account. For addresses that have never opened a futures account, the JSON
// payload contains a JSON-RPC error with msg "The account does not exist,
// please open a futures account." — the strict variant surfaces that so the
// caller can show the right UI.
// ─────────────────────────────────────────────────────────────────────────────
const ASTER_RPC = 'https://tapi.asterdex.com/info'

async function rpcGetBalance(walletAddress: string): Promise<{
  perpAssets: any[]; positions: any[]; error?: string
}> {
  const res = await axios.post(ASTER_RPC, {
    id: 1, jsonrpc: '2.0', method: 'aster_getBalance',
    params: [walletAddress, 'latest']
  }, {
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    timeout: 8_000, validateStatus: () => true
  })
  const body: any = res.data ?? {}
  if (body.error) {
    // RPC returns 200 OK with an `error` field even for "account does not exist"
    return { perpAssets: [], positions: [], error: String(body.error.message ?? 'rpc_error') }
  }
  if (res.status !== 200) {
    return { perpAssets: [], positions: [], error: `http_${res.status}` }
  }
  const result = body.result ?? {}
  const perpAssets = Array.isArray(result.perpAssets) ? result.perpAssets : []
  const positions  = Array.isArray(result.positions)  ? result.positions  : []
  // TEMP diagnostic — dump full raw shape so we can see USD-valuation fields
  // for non-stable assets (ASTER, ASBNB, BNB). Remove once balance fix lands.
  if (perpAssets.length > 1 || perpAssets.some((a: any) => a.asset && a.asset !== 'USDT' && a.asset !== 'USD')) {
    console.log('[Aster RPC] aster_getBalance multi-asset response for', walletAddress, ':',
      JSON.stringify({ perpAssets, topLevelKeys: Object.keys(result) }, null, 2))
  }
  return { perpAssets, positions }
}

export async function getAccountBalance(creds: AsterCredentials): Promise<{
  usdt: number; availableMargin: number
}> {
  try {
    const { perpAssets, error } = await rpcGetBalance(creds.userAddress)
    if (error) {
      console.error('[Aster RPC] getAccountBalance:', creds.userAddress, '→', error)
      return { usdt: 0, availableMargin: 0 }
    }
    const usdt = perpAssets.find(
      (a: any) => a.asset === 'USDT' || a.asset === 'USD'
    )
    return {
      usdt:            parseFloat(usdt?.walletBalance ?? '0'),
      availableMargin: parseFloat(usdt?.availableBalance ?? usdt?.walletBalance ?? '0')
    }
  } catch (err: any) {
    console.error('[Aster RPC] getAccountBalance failed:', err?.message)
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
// to the user (e.g. "account does not exist, please open a futures account").
//
// Strategy:
//   1. Try the SIGNED /fapi/v3/balance endpoint first when we have agent
//      credentials — this returns the exact same number Aster's web UI shows
//      (canonical per-asset balance + crossUnPnl), eliminating the public-RPC
//      vs web-UI mismatch users have been reporting.
//   2. Fall back to the public JSON-RPC if signed call fails for any reason
//      (no agent creds, network error, etc.) — degraded but better than 0.
export async function getAccountBalanceStrict(creds: AsterCredentials): Promise<{
  usdt: number; availableMargin: number; raw: any[]
}> {
  // ── Path 1: signed /fapi/v3/balance (matches asterdex.com exactly) ──
  if (creds.signerAddress && creds.signerPrivKey) {
    try {
      const res = await signedGET('/fapi/v3/balance', {}, creds)
      const assets = Array.isArray(res.data) ? res.data : []
      const usdtAsset = assets.find((a: any) => a.asset === 'USDT' || a.asset === 'USD')
      if (usdtAsset) {
        // crossWalletBalance + crossUnPnl == marginBalance (what web shows).
        const crossWallet = parseFloat(usdtAsset.crossWalletBalance ?? usdtAsset.balance ?? '0')
        const crossUnPnl  = parseFloat(usdtAsset.crossUnPnl ?? '0')
        const marginBalance = crossWallet + crossUnPnl
        const available     = parseFloat(usdtAsset.availableBalance ?? usdtAsset.maxWithdrawAmount ?? String(marginBalance))
        console.log('[Aster] /fapi/v3/balance USDT for', creds.userAddress,
          '→ marginBalance=', marginBalance.toFixed(4),
          'crossWallet=', crossWallet.toFixed(4), 'crossUnPnl=', crossUnPnl.toFixed(4),
          'available=', available.toFixed(4))
        return { usdt: marginBalance, availableMargin: available, raw: assets }
      }
    } catch (e: any) {
      console.error('[Aster] signed /fapi/v3/balance failed for', creds.userAddress,
        '→', e?.response?.status, e?.response?.data ?? e?.message,
        '— falling back to JSON-RPC')
    }
  }

  // ── Path 2: public JSON-RPC fallback ──
  const { perpAssets, error } = await rpcGetBalance(creds.userAddress)
  if (error) throw new Error(error)
  const usdt = perpAssets.find((a: any) => a.asset === 'USDT' || a.asset === 'USD')
  return {
    usdt:            parseFloat(usdt?.walletBalance ?? '0'),
    availableMargin: parseFloat(usdt?.availableBalance ?? usdt?.walletBalance ?? '0'),
    raw:             perpAssets
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

// Aster's "management endpoint" EIP-712 domain. Note chainId is 56 (BSC),
// NOT 1666 — confirmed against asterdex/api-docs/demo/aster-code.py.
const ASTER_MGMT_DOMAIN = {
  name:              'AsterSignTransaction',
  version:           '1',
  chainId:           56,
  verifyingContract: '0x0000000000000000000000000000000000000000'
} as const

export async function approveAgent(params: {
  userAddress?:      string  // for logging only — Aster ecrecovers from sig
  userPrivateKey:    string  // user's wallet key — only used to sign this one tx
  agentAddress:      string  // your platform's agent wallet address
  agentName:         string
  expiredDays?:      number
  ipWhitelist?:      string  // empty string is fine
  canSpotTrade?:     boolean
  canPerpTrade?:     boolean
  canWithdraw?:      boolean
  // Accepted but ignored (kept for call-site backwards compat — builder/fee
  // are configured via approveBuilder, a separate Aster API call).
  builderAddress?:   string
  maxFeeRate?:       string
}): Promise<{ success: boolean; error?: string }> {
  const expired      = Date.now() + (params.expiredDays ?? 365) * 86_400_000
  const ipWhitelist  = params.ipWhitelist ?? ''
  const canSpotTrade = params.canSpotTrade ?? false
  const canPerpTrade = params.canPerpTrade ?? true
  const canWithdraw  = params.canWithdraw  ?? false

  // EIP-712 message — field names are PascalCase (Aster auto-uppercases the
  // first letter of every body param). Field ORDER must match the body order.
  const types = {
    ApproveAgent: [
      { name: 'AgentName',    type: 'string'  },
      { name: 'AgentAddress', type: 'string'  },
      { name: 'IpWhitelist',  type: 'string'  },
      { name: 'Expired',      type: 'uint256' },
      { name: 'CanSpotTrade', type: 'bool'    },
      { name: 'CanPerpTrade', type: 'bool'    },
      { name: 'CanWithdraw',  type: 'bool'    }
    ]
  }
  const message = {
    AgentName:    params.agentName,
    AgentAddress: params.agentAddress,
    IpWhitelist:  ipWhitelist,
    Expired:      expired,
    CanSpotTrade: canSpotTrade,
    CanPerpTrade: canPerpTrade,
    CanWithdraw:  canWithdraw
  }

  try {
    const wallet = new ethers.Wallet(params.userPrivateKey)
    const sig = await wallet.signTypedData(ASTER_MGMT_DOMAIN, types, message)

    // Body fields use camelCase. signatureChainId MUST equal domain.chainId.
    const body = new URLSearchParams({
      agentName:        params.agentName,
      agentAddress:     params.agentAddress,
      ipWhitelist:      ipWhitelist,
      expired:          String(expired),
      canSpotTrade:     String(canSpotTrade),
      canPerpTrade:     String(canPerpTrade),
      canWithdraw:      String(canWithdraw),
      signature:        sig,
      signatureChainId: '56'
    }).toString()

    const resp = await client(BASE_SIGNED).post(
      '/fapi/v3/approveAgent',
      body,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    )
    console.log('[Aster] approveAgent ok:', params.userAddress ?? wallet.address, '→', resp.status, resp.data)
    return { success: true }
  } catch (err: any) {
    console.error('[Aster] approveAgent FAILED', {
      user:           params.userAddress,
      agent:          params.agentAddress,
      expired,
      httpStatus:     err?.response?.status,
      httpStatusText: err?.response?.statusText,
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
// Aster Code — Approve Builder (user signs to enroll a builder/broker for fees)
// Called once per user during onboarding, after approveAgent. Without this,
// trades won't carry our broker fee. Safe to call repeatedly (Aster upserts).
// ─────────────────────────────────────────────────────────────────────────────
export async function approveBuilder(params: {
  userAddress?:    string  // for logging only
  userPrivateKey:  string
  builderAddress:  string
  maxFeeRate:      string  // e.g. '0.0001' = 0.01%
  builderName?:    string
}): Promise<{ success: boolean; error?: string }> {
  const builderName = params.builderName ?? 'BUILD4'

  const types = {
    ApproveBuilder: [
      { name: 'Builder',     type: 'string' },
      { name: 'MaxFeeRate',  type: 'string' },
      { name: 'BuilderName', type: 'string' }
    ]
  }
  const message = {
    Builder:     params.builderAddress,
    MaxFeeRate:  params.maxFeeRate,
    BuilderName: builderName
  }

  try {
    const wallet = new ethers.Wallet(params.userPrivateKey)
    const sig = await wallet.signTypedData(ASTER_MGMT_DOMAIN, types, message)

    const body = new URLSearchParams({
      builder:          params.builderAddress,
      maxFeeRate:       params.maxFeeRate,
      builderName:      builderName,
      signature:        sig,
      signatureChainId: '56'
    }).toString()

    const resp = await client(BASE_SIGNED).post(
      '/fapi/v3/approveBuilder',
      body,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    )
    console.log('[Aster] approveBuilder ok:', params.userAddress ?? wallet.address, '→', resp.status, resp.data)
    return { success: true }
  } catch (err: any) {
    console.error('[Aster] approveBuilder FAILED', {
      user:           params.userAddress,
      builder:        params.builderAddress,
      maxFeeRate:     params.maxFeeRate,
      httpStatus:     err?.response?.status,
      httpStatusText: err?.response?.statusText,
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
