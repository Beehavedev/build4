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
// guaranteed to get rate-limited. With interval-aware TTL and 7 pairs × 3
// timeframes we serve ≤21 unique upstream calls per cache window regardless
// of agent count. In-flight de-duplication via inflightKlines prevents the
// thundering-herd on cache miss when many agents tick simultaneously.
//
// Interval-aware TTL: a 4h candle doesn't move for hours, so caching it for
// only 60s caused the same kline to be re-fetched ~240× per candle lifetime
// (visible in production logs as repeat "cache miss" lines for 4h pairs).
// Rule of thumb: cache for ~25% of the candle period, capped at 5 minutes
// so even 1d candles get refreshed often enough to catch corrections.
const KLINES_TTL_BY_INTERVAL_MS: Record<string, number> = {
  '1m': 10_000,
  '3m': 20_000,
  '5m': 30_000,
  '15m': 60_000,
  '30m': 120_000,
  '1h':  180_000,
  '2h':  300_000,
  '4h':  300_000,
  '6h':  300_000,
  '8h':  300_000,
  '12h': 300_000,
  '1d':  300_000,
  '3d':  300_000,
  '1w':  300_000,
  '1M':  300_000,
}
const KLINES_CACHE_TTL_DEFAULT_MS = 60_000
function ttlForInterval(interval: string): number {
  return KLINES_TTL_BY_INTERVAL_MS[interval] ?? KLINES_CACHE_TTL_DEFAULT_MS
}
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

  // ── Cache check (interval-aware TTL, dedupes in-flight requests) ──
  const cacheKey = `${symbol}:${intervalNormalized}:${safeLimit}`
  const cached = klinesCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < ttlForInterval(intervalNormalized)) {
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

// ─────────────────────────────────────────────────────────────────────────────
// Symbol filters — tickSize / stepSize / precisions used to round price + qty
// before submitting orders. Aster rejects any order whose decimals exceed the
// per-symbol filter ("Precision is over the maximum defined for this asset"),
// so we MUST snap values down to the allowed grid before signing.
//
// Cached in-process for 5 minutes; exchangeInfo rarely changes intraday.
// ─────────────────────────────────────────────────────────────────────────────
export interface SymbolFilters {
  symbol:             string
  tickSize:           number   // PRICE_FILTER.tickSize  — price granularity
  stepSize:           number   // LOT_SIZE.stepSize       — qty granularity
  minQty:             number   // LOT_SIZE.minQty
  minNotional:        number   // MIN_NOTIONAL.notional   — minimum order value
  pricePrecision:     number   // decimals for price string
  quantityPrecision:  number   // decimals for qty string
}

let _symbolFiltersCache: { fetchedAt: number; map: Map<string, SymbolFilters> } | null = null
const SYMBOL_FILTERS_TTL_MS = 5 * 60 * 1000

async function loadAllSymbolFilters(): Promise<Map<string, SymbolFilters>> {
  const now = Date.now()
  if (_symbolFiltersCache && now - _symbolFiltersCache.fetchedAt < SYMBOL_FILTERS_TTL_MS) {
    return _symbolFiltersCache.map
  }
  // Use the shared client wrapper — it sets a Mozilla UA so Cloudflare on
  // fapi.asterdex.com doesn't HTML-403 us. Raw axios.get() is intermittently
  // blocked at the edge with the default node UA.
  const res = await client(BASE_PUBLIC).get('/fapi/v1/exchangeInfo', { timeout: 8000 })
  const map = new Map<string, SymbolFilters>()
  for (const s of res.data?.symbols ?? []) {
    const filters = s.filters ?? []
    const priceFilter   = filters.find((f: any) => f.filterType === 'PRICE_FILTER')
    const lotFilter     = filters.find((f: any) => f.filterType === 'LOT_SIZE')
    const notionalFilt  = filters.find((f: any) => f.filterType === 'MIN_NOTIONAL')
    map.set(s.symbol, {
      symbol:            s.symbol,
      tickSize:          parseFloat(priceFilter?.tickSize ?? '0.01'),
      stepSize:          parseFloat(lotFilter?.stepSize  ?? '0.001'),
      minQty:            parseFloat(lotFilter?.minQty    ?? '0'),
      minNotional:       parseFloat(notionalFilt?.notional ?? '0'),
      pricePrecision:    Number.isFinite(s.pricePrecision)    ? s.pricePrecision    : 2,
      quantityPrecision: Number.isFinite(s.quantityPrecision) ? s.quantityPrecision : 3,
    })
  }
  _symbolFiltersCache = { fetchedAt: now, map }
  return map
}

export async function getSymbolFilters(symbol: string): Promise<SymbolFilters | null> {
  const sym = symbol.replace(/[\/\s]/g, '').toUpperCase()
  try {
    const map = await loadAllSymbolFilters()
    return map.get(sym) ?? null
  } catch (err: any) {
    console.warn('[Aster] getSymbolFilters fetch failed:', err?.message ?? err)
    return null
  }
}

// Floor `value` to the nearest multiple of `step`, then format with at most
// `precision` decimals. Trailing zeros are trimmed so the API receives the
// canonical representation Aster expects (e.g. 0.001 not 0.00100).
//   roundDownToStep(0.0001284, 0.001, 3)  → "0"            // too small to fill
//   roundDownToStep(0.000128, 0.00001, 5) → "0.00012"
//   roundDownToStep(77930.18,  0.1,    1) → "77930.1"
export function roundDownToStep(value: number, step: number, precision: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (!Number.isFinite(step) || step <= 0)   return value.toFixed(Math.min(precision, 12))
  const snapped = Math.floor(value / step) * step
  // Use precision derived from step itself so we never emit MORE decimals
  // than the step grid supports (e.g. step=0.1 → 1 decimal, never 0.10000).
  const stepDecimals = (step.toString().split('.')[1] ?? '').length
  const decimals = Math.min(precision, stepDecimals || precision)
  const out = snapped.toFixed(decimals)
  // Trim trailing zeros after the decimal point but keep integers intact.
  return out.includes('.') ? out.replace(/\.?0+$/, '') || '0' : out
}

// Aster perps fund every 8h. Returns the funding payments (rate + time) that
// settled inside [startTime, endTime]. Empty array on failure (callers treat
// missing funding as zero — same conservative default as midpoint fills).
export async function getFundingRateHistory(
  pair: string,
  startTime: number,
  endTime: number
): Promise<{ fundingTime: number; fundingRate: number }[]> {
  const symbol = pair.replace('/', '')
  try {
    const res = await client(BASE_PUBLIC).get('/fapi/v1/fundingRate', {
      params: { symbol, startTime, endTime, limit: 1000 }
    })
    const rows = res.data as any[]
    return rows.map((r) => ({
      fundingTime: Number(r.fundingTime),
      fundingRate: parseFloat(r.fundingRate ?? '0')
    }))
  } catch (err: any) {
    console.warn(
      '[Aster] getFundingRateHistory failed:',
      'symbol=', symbol,
      'msg=', err?.message,
      'status=', err?.response?.status
    )
    return []
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
// User-facing error translator
//
// Aster's API returns a mix of axios errors ("Request failed with status code
// 401"), Cloudflare HTML, and Binance-style JSON errors ({code, msg}). Surfaced
// raw, none of these mean anything to a trader — "401" is especially confusing
// because the user has no concept of HTTP status codes.
//
// This helper inspects whatever the underlying call threw and produces a single
// short, plain-English sentence that explains what actually happened and what
// the user can do about it. EVERY route that touches Aster on the user's behalf
// must pipe its catch through this so the UI never displays raw axios output.
//
// Order of preference:
//   1. Aster's own JSON `msg` field (their server-rendered explanation, in
//      English) — usually the most accurate.
//   2. Known HTTP status codes mapped to actionable copy (401, 403, 429, 5xx).
//   3. A safe generic fallback for transport-level failures (network down,
//      timeout, DNS) so we never say "Request failed with status code…".
// ─────────────────────────────────────────────────────────────────────────────

export function friendlyAsterError(err: any): string {
  const status = err?.response?.status
  const data   = err?.response?.data

  // 1. Aster's own message (Binance-compat shape: { code, msg })
  if (data && typeof data === 'object' && typeof data.msg === 'string' && data.msg.trim()) {
    // Strip leading "Error: " or punctuation noise that Aster sometimes prepends.
    const msg = data.msg.replace(/^error[:\s]+/i, '').trim()
    if (data.code === -2014 || data.code === -2015) {
      return 'Trading agent rejected by Aster — please re-activate your account from the Wallet tab.'
    }
    if (data.code === -1021) {
      return 'Aster timing check failed — please retry in a few seconds.'
    }
    if (data.code === -1022) {
      return 'Aster signature check failed — please re-activate your account from the Wallet tab.'
    }
    if (data.code === -2010 || data.code === -2011) {
      // Order rejected (insufficient margin, reduce-only conflict, etc.) —
      // Aster's msg is already user-readable here ("Insufficient balance",
      // "Order would immediately trigger", etc.). Pass through as-is.
      return msg
    }
    return msg
  }

  // 2. Known HTTP statuses
  if (status === 401) {
    return 'Aster did not accept your trading agent — please re-activate your account from the Wallet tab.'
  }
  if (status === 403) {
    return 'Aster blocked the request (geo or rate). Please try again in a moment.'
  }
  if (status === 429) {
    return 'Too many requests to Aster — please wait a few seconds and retry.'
  }
  if (status === 418) {
    return 'Aster temporarily banned this device for too many requests — wait a minute and retry.'
  }
  if (typeof status === 'number' && status >= 500) {
    return 'Aster is temporarily unavailable — please retry shortly.'
  }

  // 3. Transport-level fallbacks
  const code = err?.code
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
    return 'Aster took too long to respond — please retry.'
  }
  if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ENETUNREACH') {
    return 'Could not reach Aster — please check your connection and retry.'
  }

  // Last-resort: never leak axios's "Request failed with status code…" string.
  return 'Could not complete the request to Aster — please retry.'
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

export interface AsterUserTrade {
  symbol: string
  side: 'BUY' | 'SELL'
  positionSide: 'LONG' | 'SHORT' | 'BOTH'
  price: number
  qty: number
  quoteQty: number
  realizedPnl: number
  commission: number
  commissionAsset: string
  time: number
  orderId: number
}

export async function getUserTrades(
  creds: AsterCredentials,
  opts: { symbol?: string; limit?: number; startTime?: number } = {}
): Promise<AsterUserTrade[]> {
  try {
    const params: any = { limit: opts.limit ?? 100 }
    if (opts.symbol) params.symbol = opts.symbol.replace('/', '')
    if (opts.startTime) params.startTime = opts.startTime
    const res = await signedGET('/fapi/v3/userTrades', params, creds)
    if (!Array.isArray(res.data)) return []
    // Aster's /userTrades returns oldest-first. Every consumer wants
    // newest-first ("Recent fills" with the latest fill on top), so we
    // sort DESC at the source — single fix versus repeating it in every
    // mini-app + API caller.
    const mapped = (res.data as any[]).map((t: any) => ({
      symbol: t.symbol,
      side: t.side,
      positionSide: t.positionSide ?? 'BOTH',
      price: parseFloat(t.price),
      qty: parseFloat(t.qty),
      quoteQty: parseFloat(t.quoteQty),
      realizedPnl: parseFloat(t.realizedPnl ?? '0'),
      commission: parseFloat(t.commission ?? '0'),
      commissionAsset: t.commissionAsset ?? 'USDT',
      time: Number(t.time),
      orderId: Number(t.orderId)
    }))
    return mapped.sort((a, b) => b.time - a.time)
  } catch (e) {
    console.warn('[Aster] getUserTrades failed:', (e as Error).message)
    return []
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Open orders — resting LIMIT/STOP orders that haven't filled yet
//
// Returns every working order (NEW / PARTIALLY_FILLED) for the account. We
// need this because a resting LIMIT lives in a third state — it's not a
// position yet (so /positionRisk doesn't show it) and it has no fills yet
// (so /userTrades doesn't show it). Without this endpoint, users who place a
// limit order would think it vanished even though it's correctly resting.
//
// IMPORTANT: Aster's agent-signed scheme is only exposed under /fapi/v3/*.
// The first version of this used /fapi/v1/openOrders (Binance-compat path)
// and Aster rejected it with 401 Unauthorized. /fapi/v3/openOrders accepts
// the same EIP-712 signature as the rest of our trading calls.
//
// Throws on any underlying error so callers can surface "Could not load open
// orders" distinctly from "no working orders" — same pattern we used for HL
// fills after the architect review.
// ─────────────────────────────────────────────────────────────────────────────

export interface AsterOpenOrder {
  orderId:      number
  symbol:       string
  side:         'BUY' | 'SELL'
  positionSide: string
  type:         string         // LIMIT, STOP_MARKET, TAKE_PROFIT_MARKET, ...
  price:        number         // limit price (0 for market-style stops)
  stopPrice:    number         // trigger for stop/TP variants
  origQty:      number         // requested size
  executedQty:  number         // partial-fill progress
  status:       string         // NEW / PARTIALLY_FILLED
  reduceOnly:   boolean
  timeInForce:  string         // GTC / IOC / FOK
  time:         number         // ms epoch when placed
}

export async function getOpenOrders(
  creds:   AsterCredentials,
  symbol?: string
): Promise<AsterOpenOrder[]> {
  const params: any = {}
  if (symbol) params.symbol = symbol.replace('/', '')
  const res = await signedGET('/fapi/v3/openOrders', params, creds)
  return (res.data as any[]).map((o: any) => ({
    orderId:      Number(o.orderId ?? 0),
    symbol:       String(o.symbol ?? ''),
    side:         o.side === 'SELL' ? 'SELL' : 'BUY',
    positionSide: String(o.positionSide ?? 'BOTH'),
    type:         String(o.type ?? 'LIMIT'),
    price:        parseFloat(o.price ?? '0') || 0,
    stopPrice:    parseFloat(o.stopPrice ?? '0') || 0,
    origQty:      parseFloat(o.origQty ?? '0') || 0,
    executedQty:  parseFloat(o.executedQty ?? '0') || 0,
    status:       String(o.status ?? 'NEW'),
    reduceOnly:   Boolean(o.reduceOnly),
    timeInForce:  String(o.timeInForce ?? 'GTC'),
    time:         Number(o.time ?? o.updateTime ?? 0),
  }))
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

// Set leverage on Aster. Returns the leverage Aster ACTUALLY confirmed,
// not what we requested — the two diverge whenever a low-cap pair has a
// per-symbol cap below the requested value (e.g. XCNUSDT max 2x, but the
// agent asked for 3x). Without surfacing the confirmed value, the
// "🤖 opened a position" Telegram message would say "3x" while the
// position on the exchange runs at 2x — exactly the discrepancy users
// have been reporting.
//
// On a hard failure we step DOWN through {requested, 5, 2, 1} until one
// is accepted, and return whichever lands. 1x always succeeds (it's the
// account default) so this can never throw on the agent path.
export async function setLeverage(
  symbol: string,
  leverage: number,
  creds: AsterCredentials
): Promise<number> {
  const sym = symbol.replace('/', '')
  // Strict step-DOWN ladder: start at requested, then try strictly lower
  // common rungs, then 1x as the always-safe floor. Critically we must
  // never try a value HIGHER than requested — that would silently open
  // the position at MORE leverage than the agent asked for, the exact
  // failure mode this function exists to prevent.
  const requested = Math.max(1, Math.floor(leverage))
  const ladder = Array.from(new Set(
    [requested, 5, 2, 1]
      .filter((n) => n >= 1 && n <= requested)
      .sort((a, b) => b - a)
  ))
  for (const lev of ladder) {
    try {
      const res: any = await signedPOST('/fapi/v3/leverage', { symbol: sym, leverage: lev }, creds)
      // Aster (Binance-shaped) returns { leverage, maxNotionalValue, symbol }.
      // Trust the server echo when present — it sometimes clamps internally
      // and reports a different value than the request.
      const echoed = Number(res?.data?.leverage ?? res?.data?.data?.leverage)
      const confirmed = Number.isFinite(echoed) && echoed > 0 ? echoed : lev
      if (confirmed !== leverage) {
        console.warn(`[Aster] setLeverage ${sym}: requested ${leverage}x → confirmed ${confirmed}x`)
      }
      return confirmed
    } catch (err: any) {
      const detail = err?.response?.data ?? err?.message
      console.warn(`[Aster] setLeverage ${sym} ${lev}x rejected:`, detail)
      // Fall through to next rung. If everything fails (extremely unlikely
      // — 1x is the account default) we return 1 below.
    }
  }
  console.error(`[Aster] setLeverage ${sym}: all ladder steps failed, defaulting to 1x`)
  return 1
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
  // Leverage Aster actually applied to this order — populated when the
  // caller asked us to set leverage as part of placement (placeOrder
  // path). The builder-code path doesn't run setLeverage internally so
  // it leaves this undefined; in that case the caller should call
  // setLeverage explicitly first and surface the returned value itself.
  actualLeverage?: number
}

// Internal helper — returns API-ready (qty, price) strings rounded to the
// symbol's exchangeInfo grid. If filters can't be fetched (network/CF), falls
// back to safer-than-default truncation (toFixed) so we don't BLOCK orders
// just because the public endpoint hiccupped. Every order placement path
// MUST go through this — without it Aster rejects with "Precision is over
// the maximum defined for this asset", a confusing error users hit on every
// small-notional ($5–25) order against a tight-stepSize symbol like BTCUSDT.
async function formatOrderParams(
  symbol:    string,
  quantity:  number,
  price?:    number,
): Promise<{ qty: string; px?: string }> {
  const filters = await getSymbolFilters(symbol)
  const qty = filters
    ? roundDownToStep(quantity, filters.stepSize, filters.quantityPrecision)
    : quantity.toFixed(6).replace(/\.?0+$/, '') || '0'
  let px: string | undefined
  if (price !== undefined && price > 0) {
    px = filters
      ? roundDownToStep(price, filters.tickSize, filters.pricePrecision)
      : price.toString()
  }
  return { qty, px }
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

  // Track what Aster actually agreed to apply. setLeverage step-walks
  // down on rejection and returns the rung that landed; we propagate
  // that up via OrderResult so notifiers/db rows reflect reality
  // instead of the request.
  //
  // Critically we call setLeverage even when the request is exactly 1x.
  // Without it, an account whose previous trade on this symbol ran at
  // (say) 5x would silently inherit 5x for a 1x agent, breaking the
  // very risk constraint the user dialed down to enforce.
  let actualLeverage: number | undefined
  if (leverage && leverage >= 1) {
    actualLeverage = await setLeverage(symbol, leverage, creds)
  }

  const { qty, px } = await formatOrderParams(symbol, rest.quantity, rest.price)
  const body: Record<string, any> = {
    symbol,
    side:         rest.side,
    type:         rest.type,
    quantity:     qty,
    positionSide: rest.positionSide ?? 'BOTH'
  }
  if (rest.type === 'LIMIT' && px) {
    body.price       = px
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
    clientOrderId: res.data.clientOrderId ?? '',
    actualLeverage,
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
  // Optional: when provided, we call setLeverage BEFORE the order so the
  // position opens at the agent's intended leverage. Without this the
  // builder-code path silently inherits whatever leverage the account
  // had previously set on this symbol (often 2x default for low-cap
  // pairs), creating the "Telegram says 3x, exchange shows 2x" drift
  // users have seen on new-listing trades.
  leverage?:      number
  builderAddress: string
  feeRate:        string
  creds:          AsterCredentials
}): Promise<OrderResult> {
  const { creds, builderAddress, feeRate, leverage, ...rest } = params
  const symbol = rest.symbol.replace('/', '')

  // Same rationale as placeOrder: enforce leverage even at 1x so a stale
  // higher symbol-leverage on the account can't override the agent's
  // intent. See placeOrder() above for the full reasoning.
  let actualLeverage: number | undefined
  if (leverage && leverage >= 1) {
    actualLeverage = await setLeverage(symbol, leverage, creds)
  }

  const { qty, px } = await formatOrderParams(symbol, rest.quantity, rest.price)
  const body: Record<string, any> = {
    symbol,
    side:    rest.side,
    type:    rest.type,
    quantity: qty,
    builder: builderAddress,
    feeRate
  }
  if (rest.type === 'LIMIT' && px) {
    body.price       = px
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
    clientOrderId: '',
    actualLeverage,
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
  /**
   * Optional. If omitted (or 0), the SL leg is skipped. Lets callers (e.g.
   * the manual /api/aster/order route) attach just a stop-loss without a
   * paired take-profit — the AI agent still passes both.
   */
  stopLoss?:   number
  /** Optional, see stopLoss above. */
  takeProfit?: number
  quantity:   number
  creds:      AsterCredentials
  /**
   * Optional builder-fee attribution. When supplied, both SL and TP closing
   * orders include `builder` + `feeRate` in the v3 body so the BUILD4
   * treasury earns the broker kickback on the closing fill — same path
   * already used by entries via placeOrderWithBuilderCode. Without this,
   * SL/TP fills bypass the builder and we lose ~50% of fee revenue per
   * trade (entry collected, exit not).
   */
  builderAddress?: string
  feeRate?:        string
}): Promise<void> {
  const closeSide = params.side === 'LONG' ? 'SELL' : 'BUY'
  const symbol    = params.symbol.replace('/', '')

  // Round both stopPrices to the symbol's tickSize. closePosition='true'
  // means we don't need a quantity, but stopPrice MUST still match the
  // tickSize grid or Aster rejects with the same precision error.
  const filters = await getSymbolFilters(symbol)
  const fmtPx = (p: number): string =>
    filters ? roundDownToStep(p, filters.tickSize, filters.pricePrecision) : p.toString()

  const builderFields: Record<string, any> =
    params.builderAddress && params.feeRate
      ? { builder: params.builderAddress, feeRate: params.feeRate }
      : {}

  // Stop loss
  if (params.stopLoss && params.stopLoss > 0) {
    try {
      await signedPOST('/fapi/v3/order', {
        symbol,
        side:          closeSide,
        type:          'STOP_MARKET',
        stopPrice:     fmtPx(params.stopLoss),
        closePosition: 'true',
        workingType:   'MARK_PRICE',
        ...builderFields,
      }, params.creds)
    } catch (err: any) {
      console.error('[Aster] SL order failed:', err?.response?.data ?? err.message)
    }
  }

  // Take profit
  if (params.takeProfit && params.takeProfit > 0) {
    try {
      await signedPOST('/fapi/v3/order', {
        symbol,
        side:          closeSide,
        type:          'TAKE_PROFIT_MARKET',
        stopPrice:     fmtPx(params.takeProfit),
        closePosition: 'true',
        workingType:   'MARK_PRICE',
        ...builderFields,
      }, params.creds)
    } catch (err: any) {
      console.error('[Aster] TP order failed:', err?.response?.data ?? err.message)
    }
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

// Aster's "management endpoint" EIP-712 domain. Confirmed against the official
// asterdex/API-demo/aster-code-demo (utils.js EIP712_DOMAIN, main=True ops).
const ASTER_MGMT_DOMAIN = {
  name:              'AsterSignTransaction',
  version:           '1',
  chainId:           56,
  verifyingContract: '0x0000000000000000000000000000000000000000'
} as const

// ASTER_CHAIN — required field on every v3 management endpoint. 'Mainnet' for
// production. Demo defaults to 'Testnet' but real mainnet calls need 'Mainnet'.
const ASTER_CHAIN = process.env.ASTER_CHAIN ?? 'Mainnet'

// ─────────────────────────────────────────────────────────────────────────────
// Shared signer for v3 management endpoints (approveAgent / approveBuilder /
// updateAgent / etc). Mirrors aster-code-demo/utils.js#signEIP712Main exactly:
//   1. PascalCase every param key (agentName -> AgentName)
//   2. Infer EIP-712 type per field (boolean → bool; integer Number → uint256;
//      everything else → string)
//   3. Sign with chainId 56 domain + dynamic primaryType
//   4. POST to URL?<rawQuerystring>&signature=…&signatureChainId=56 with empty
//      body. Querystring values are NOT URL-encoded (Aster signs raw bytes).
// ─────────────────────────────────────────────────────────────────────────────
function pascalCaseKeys(o: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(o)) {
    out[k.charAt(0).toUpperCase() + k.slice(1)] = v
  }
  return out
}

function inferEip712Types(o: Record<string, any>) {
  const types: { name: string; type: string }[] = []
  for (const [k, v] of Object.entries(o)) {
    let type = 'string'
    if (typeof v === 'boolean')                                 type = 'bool'
    else if (typeof v === 'number' && Number.isInteger(v))      type = 'uint256'
    types.push({ name: k, type })
  }
  return types
}

// Build querystring with raw (un-encoded) values, in object insertion order.
// Aster's signature verification reconstructs the typed data from these exact
// strings — URL-encoding would change the digest and trip "Signature check
// failed".
function buildRawQueryString(o: Record<string, any>): string {
  return Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('&')
}

async function signMgmtTypedData(
  signerPrivateKey: string,
  params: Record<string, any>,
  primaryType: string
): Promise<string> {
  const message = pascalCaseKeys(params)
  const types   = { [primaryType]: inferEip712Types(message) }
  const wallet  = new ethers.Wallet(signerPrivateKey)
  return wallet.signTypedData(ASTER_MGMT_DOMAIN, types, message)
}

async function postMgmtEndpoint(
  path: string,
  signerPrivateKey: string,
  params: Record<string, any>,
  primaryType: string
): Promise<any> {
  const sig = await signMgmtTypedData(signerPrivateKey, params, primaryType)

  // Self-check: the address recovered from the typed-data signature must match
  // params.user. If it doesn't, our wallet decryption is producing a different
  // key than the one the user's main wallet was created with — surface this
  // explicitly instead of letting Aster bounce us with the generic "Signature
  // check failed" string. Recovery uses the same domain/types we just signed.
  try {
    const message = pascalCaseKeys(params)
    const types   = { [primaryType]: inferEip712Types(message) }
    const recovered = ethers.verifyTypedData(ASTER_MGMT_DOMAIN as any, types, message, sig)
    if (params.user && recovered.toLowerCase() !== String(params.user).toLowerCase()) {
      console.error('[Aster MGMT] SIGNER MISMATCH', {
        path, primaryType,
        expectedUser: params.user,
        recovered,
      })
      throw new Error(`Signer mismatch: signed as ${recovered} but params.user=${params.user}. Wallet decryption may be wrong.`)
    }
  } catch (verifyErr: any) {
    if (String(verifyErr?.message ?? '').startsWith('Signer mismatch')) throw verifyErr
    // If verifyTypedData itself blows up, log but proceed — the API will tell us.
    console.warn('[Aster MGMT] verify self-check threw:', verifyErr?.message)
  }

  const finalParams = { ...params, signature: sig, signatureChainId: ASTER_MGMT_DOMAIN.chainId }
  const url = `${path}?${buildRawQueryString(finalParams)}`

  console.log('[Aster MGMT] POST', primaryType, {
    url:    BASE_SIGNED + url,
    paramsOrder: Object.keys(params),
    user:   params.user,
    nonce:  params.nonce,
  })

  // Aster expects POST with empty body and all params in the URL.
  return client(BASE_SIGNED).post(url, '', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  })
}

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
  builderAddress?:   string
  maxFeeRate?:       string  // e.g. '0.0001' = 0.01%
  builderName?:      string
}): Promise<{ success: boolean; error?: string }> {
  const expired      = Date.now() + (params.expiredDays ?? 365) * 86_400_000
  const ipWhitelist  = params.ipWhitelist ?? ''
  const canSpotTrade = params.canSpotTrade ?? false
  const canPerpTrade = params.canPerpTrade ?? true
  const canWithdraw  = params.canWithdraw  ?? false
  const builder      = params.builderAddress ?? ''
  const maxFeeRate   = params.maxFeeRate     ?? '0'
  const builderName  = params.builderName    ?? 'BUILD4'

  const wallet   = new ethers.Wallet(params.userPrivateKey)
  const userAddr = params.userAddress ?? wallet.address

  // Param order MUST match the demo (01_approveAgent.js) — Aster's verifier
  // is order-sensitive because EIP-712 type derivation is order-sensitive.
  // Booleans stay booleans, integers stay numbers — type inference handles it.
  const callParams: Record<string, any> = {
    agentName:    params.agentName,
    agentAddress: params.agentAddress,
    ipWhitelist,
    expired,
    canSpotTrade,
    canPerpTrade,
    canWithdraw,
    builder,
    maxFeeRate,
    builderName,
    asterChain:   ASTER_CHAIN,
    user:         userAddr,
    nonce:        getNonce()
  }

  try {
    const resp = await postMgmtEndpoint(
      '/fapi/v3/approveAgent',
      params.userPrivateKey,
      callParams,
      'ApproveAgent'
    )
    console.log('[Aster] approveAgent ok:', userAddr, '→', resp.status, resp.data)
    return { success: true }
  } catch (err: any) {
    console.error('[Aster] approveAgent FAILED', {
      user:           userAddr,
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
// Mirrors aster-code-demo/05_approveBuilder.js exactly.
// ─────────────────────────────────────────────────────────────────────────────
export async function approveBuilder(params: {
  userAddress?:    string  // for logging only
  userPrivateKey:  string
  builderAddress:  string
  maxFeeRate:      string  // e.g. '0.0001' = 0.01%
  builderName?:    string
}): Promise<{ success: boolean; error?: string }> {
  const builderName = params.builderName ?? 'BUILD4'
  const wallet      = new ethers.Wallet(params.userPrivateKey)
  const userAddr    = params.userAddress ?? wallet.address

  const callParams: Record<string, any> = {
    builder:     params.builderAddress,
    maxFeeRate:  params.maxFeeRate,
    builderName,
    asterChain:  ASTER_CHAIN,
    user:        userAddr,
    nonce:       getNonce()
  }

  try {
    const resp = await postMgmtEndpoint(
      '/fapi/v3/approveBuilder',
      params.userPrivateKey,
      callParams,
      'ApproveBuilder'
    )
    console.log('[Aster] approveBuilder ok:', userAddr, '→', resp.status, resp.data)
    return { success: true }
  } catch (err: any) {
    console.error('[Aster] approveBuilder FAILED', {
      user:           userAddr,
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
  // Accept either env-var name. Render production uses ASTER_BROKER_PK;
  // Replit uses ASTER_AGENT_PRIVATE_KEY. Both are the platform-wide
  // signing keypair for legacy users without a per-user agent.
  const key  = agentPrivKey
    ?? process.env.ASTER_AGENT_PRIVATE_KEY
    ?? process.env.ASTER_BROKER_PK

  if (!addr || !key || !userAddress) return null

  return {
    userAddress,
    signerAddress: addr,
    signerPrivKey: key
  }
}

// Resolves the agent private key for a given user, preferring the per-user
// agent keypair stored in `asterAgentEncryptedPK` (generated at activation
// time). Falls back to the platform-wide ASTER_AGENT_PRIVATE_KEY for legacy
// users onboarded before the per-user-agent migration. Returns null if no
// agent address is on file at all.
export async function resolveAgentCreds(user: {
  id: string
  telegramId?: bigint | number | string | null
  asterAgentAddress?: string | null
  asterAgentEncryptedPK?: string | null
}, userAddress: string): Promise<AsterCredentials | null> {
  if (!userAddress) return null

  let agentPk: string | null = null
  let decryptionFailed = false

  // Preferred path: per-user encrypted agent (set during /activate flow).
  // Aster has the agent's address registered as the authorised signer for
  // this user — if we can't decrypt it, signing with anything else
  // (notably the env-var platform agent) WILL trip "Signature check
  // failed" because the recovered signer won't match what Aster has on
  // file for this user.
  //
  // Try every plausible decryption password. Different code paths in the
  // codebase have historically encrypted with `user.id` (Prisma cuid) or
  // with the bare telegramId string (legacy migrated users) — so we
  // mirror the deposit flow and try both before giving up.
  if (user.asterAgentEncryptedPK) {
    const idCandidates = [user.id, user.telegramId?.toString()]
      .filter((v): v is string => Boolean(v))
    const { decryptPrivateKey } = await import('./wallet')
    let lastErr: any = null
    for (const candidate of idCandidates) {
      try {
        const decrypted = decryptPrivateKey(user.asterAgentEncryptedPK, candidate)
        if (decrypted?.startsWith('0x')) { agentPk = decrypted; break }
      } catch (e) { lastErr = e }
    }
    if (!agentPk) {
      decryptionFailed = true
      console.error(
        `[Aster] resolveAgentCreds: per-user agent PK decryption failed user=${user.id} tg=${user.telegramId} ` +
        `triedCandidates=${idCandidates.length} err=${lastErr?.message ?? 'unknown'} — refusing env fallback ` +
        `because Aster has the per-user agent address registered as the authorised signer`
      )
      // Refuse to fall back. Returning null surfaces a clear "agent not
      // configured" error to the caller; falling back to the env PK
      // would silently produce signature mismatches against Aster.
      return null
    }
  }

  // Legacy fallback: migrated users who have asterAgentEncryptedPK=NULL
  // share the env-var platform agent. Both the PK and the address come
  // from the env so they're always consistent.
  if (!agentPk) {
    agentPk = process.env.ASTER_AGENT_PRIVATE_KEY
      ?? process.env.ASTER_BROKER_PK
      ?? null
    if (!agentPk) return null
  }

  // Single source of truth for signerAddress: the address derived from
  // the PK we will actually sign with. If the user has a different
  // asterAgentAddress on file, that's a data inconsistency — log it so
  // we can investigate, but use the derived address (the only one whose
  // signatures will verify).
  let derivedAddress: string
  try {
    derivedAddress = new ethers.Wallet(agentPk).address
  } catch {
    return null
  }
  if (
    user.asterAgentAddress &&
    user.asterAgentAddress.toLowerCase() !== derivedAddress.toLowerCase() &&
    !decryptionFailed // already logged above
  ) {
    console.warn(
      `[Aster] resolveAgentCreds: stored asterAgentAddress (${user.asterAgentAddress}) ` +
      `differs from address derived from PK (${derivedAddress}) for user=${user.id} tg=${user.telegramId} — ` +
      `using derived address (signing source of truth)`
    )
  }

  return {
    userAddress,
    signerAddress: derivedAddress,
    signerPrivKey: agentPk
  }
}
