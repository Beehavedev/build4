// =====================================================================
// Polymarket Phase 2/3 — manual + autonomous trading on the Polygon CLOB.
//
// Architecture
// ─────────────
// The user's BUILD4 custodial wallet is a single secp256k1 keypair. The
// same EOA address that holds USDT on BSC also exists on Polygon, so we
// can sign Polymarket orders with the exact same PK that drives 42.space
// trades. No new wallet, no bridge, no Safe contract needed.
//
// signature_type
// ──────────────
// We use `EOA` (signature type 0) for every order. POLY_PROXY (1) and
// POLY_GNOSIS_SAFE (2) are aimed at users coming from polymarket.com's
// magic.link onboarding (proxy contracts) — we don't have or need those.
// EOA orders carry the builder code on the same path and qualify for
// the Builder Program leaderboard exactly the same way; this is the
// model used by virtually every third-party Polymarket integration.
//
// Builder attribution
// ───────────────────
// Two pieces of identity:
//   1. POLY_BUILDER_CODE — bytes32 set on every order's `builder` field.
//      This is what ties on-chain volume back to BUILD4 for grant scoring.
//   2. POLY_BUILDER_API_KEY/SECRET/PASSPHRASE — HMAC creds the SDK uses
//      to add `POLY_BUILDER_*` headers on order POSTs. Optional but
//      recommended; without them orders still carry the on-chain code.
//
// Both are read lazily so the module loads without env vars being set
// (Phase 1 deploys don't have these yet) and the file imports cleanly
// in tests.
// =====================================================================

import { ethers } from 'ethers'
import {
  ClobClient,
  Chain,
  Side,
  OrderType,
  SignatureType,
  type ApiKeyCreds,
} from '@polymarket/clob-client'
import { BuilderConfig } from '@polymarket/builder-signing-sdk'
import { db } from '../db'
import { decryptPrivateKey, encryptPrivateKey } from './wallet'
import { polymarketConfig } from './polymarket'

const CLOB_HOST = 'https://clob.polymarket.com'
const POLYGON_CHAIN_ID = 137 as const
const POLYGON_RPC = (process.env.POLYGON_RPC ?? '').trim() || 'https://polygon-rpc.com'

const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' // bridged USDC.e — Polymarket collateral
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a'

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]

// Cap any single approval at MAX_UINT256 — standard one-time pattern.
const MAX_UINT256 = (1n << 256n) - 1n

// ── Builder credentials (env-driven, lazy) ──────────────────────────────
function getBuilderConfig(): BuilderConfig | undefined {
  const key        = (process.env.POLY_BUILDER_API_KEY ?? '').trim()
  const secret     = (process.env.POLY_BUILDER_SECRET ?? '').trim()
  const passphrase = (process.env.POLY_BUILDER_PASSPHRASE ?? '').trim()
  if (!key || !secret || !passphrase) return undefined
  return new BuilderConfig({ localBuilderCreds: { key, secret, passphrase } })
}

export function getBuilderCode(): string | null {
  return polymarketConfig.builderCode
}

// Strict guard so we never send an order without builder attribution when
// we *think* we're attributing. Call sites use this to fail-closed: if
// POLY_BUILDER_CODE is configured but the API creds are missing, refuse
// the trade rather than silently miss the leaderboard credit. Without
// this, a misconfigured deploy would happily generate volume that doesn't
// count toward the grant — which is the entire reason this code exists.
export function getBuilderAttribution(): {
  ok: boolean
  builderConfig?: BuilderConfig
  builderCode: string | null
  reason?: string
} {
  const code = getBuilderCode()
  const cfg  = getBuilderConfig()

  // Dev / unattributed mode — no code configured at all. Trade is allowed
  // but won't carry attribution. Useful for local testing and the very
  // first wallet-setup flow where the user just wants to see balances.
  if (!code) return { ok: true, builderCode: null }

  // Attribution intent without HMAC creds = misconfiguration. Fail closed.
  if (!cfg) {
    return {
      ok: false,
      builderCode: code,
      reason: 'POLY_BUILDER_CODE is set but POLY_BUILDER_API_KEY/SECRET/PASSPHRASE are missing — refusing to trade without attribution',
    }
  }
  return { ok: true, builderConfig: cfg, builderCode: code }
}

// ── Provider (singleton) ────────────────────────────────────────────────
let _provider: ethers.JsonRpcProvider | null = null
function getProvider() {
  if (!_provider) _provider = new ethers.JsonRpcProvider(POLYGON_RPC)
  return _provider
}

// ── Custodial PK retrieval ──────────────────────────────────────────────
// The user's existing BSC wallet PK works on Polygon (same secp256k1).
// We never decrypt agent-keys for Polymarket — Polymarket trades come out
// of the user's master custodial wallet, just like 42.space does today.
async function getUserPolygonSigner(userId: string): Promise<{
  wallet: ethers.Wallet
  address: string
}> {
  const w = await db.wallet.findFirst({
    where: { userId, isActive: true, chain: 'BSC' },
  })
  if (!w?.encryptedPK) {
    throw new Error('No active custodial wallet for user; activate a BSC wallet first')
  }
  const pk = decryptPrivateKey(w.encryptedPK, userId)
  if (!pk?.startsWith('0x')) throw new Error('Failed to decrypt custodial PK')
  const wallet = new ethers.Wallet(pk, getProvider())
  return { wallet, address: wallet.address }
}

// ── L2 API credentials (HMAC) ───────────────────────────────────────────
// Polymarket's CLOB needs HMAC-signed headers on most endpoints. The
// creds are derived from an L1 EIP-712 signature, so once derived they
// are stable for the lifetime of the wallet — we cache them per-user.
export async function getOrCreateCreds(userId: string): Promise<{
  creds: ApiKeyCreds
  walletAddress: string
}> {
  const existing = await db.polymarketCreds.findUnique({ where: { userId } })
  if (existing) {
    return {
      creds: {
        key:        existing.apiKey,
        secret:     decryptPrivateKey(existing.encryptedApiSecret, userId),
        passphrase: decryptPrivateKey(existing.encryptedPassphrase, userId),
      },
      walletAddress: existing.walletAddress,
    }
  }

  const { wallet, address } = await getUserPolygonSigner(userId)

  // Bootstrap client without creds — only L1 endpoints (createOrDeriveApiKey)
  // need to work here.
  const bootstrap = new ClobClient(CLOB_HOST, POLYGON_CHAIN_ID, wallet as any)
  const fresh = await bootstrap.createOrDeriveApiKey()

  await db.polymarketCreds.create({
    data: {
      userId,
      walletAddress:       address,
      apiKey:              fresh.key,
      encryptedApiSecret:  encryptPrivateKey(fresh.secret, userId),
      encryptedPassphrase: encryptPrivateKey(fresh.passphrase, userId),
    },
  })

  return { creds: fresh, walletAddress: address }
}

// ── Authenticated client ────────────────────────────────────────────────
async function getAuthedClient(userId: string, opts?: { requireAttribution?: boolean }): Promise<{
  client: ClobClient
  walletAddress: string
  builderCode: string | null
  attributionOk: boolean
}> {
  const { wallet, address } = await getUserPolygonSigner(userId)
  const { creds }           = await getOrCreateCreds(userId)
  const attribution         = getBuilderAttribution()

  // requireAttribution = true on the trade path. We refuse to construct a
  // trading client when attribution is misconfigured so the order POST
  // never goes out unattributed.
  if (opts?.requireAttribution && !attribution.ok) {
    throw new Error(attribution.reason ?? 'Builder attribution unavailable')
  }

  const client = new ClobClient(
    CLOB_HOST,
    POLYGON_CHAIN_ID,
    wallet as any,
    creds,
    SignatureType.EOA,
    address,
    undefined,
    undefined,
    attribution.builderConfig,
  )
  return {
    client,
    walletAddress: address,
    builderCode:   attribution.builderCode,
    attributionOk: attribution.ok,
  }
}

// ── Balances ────────────────────────────────────────────────────────────
export async function getPolygonBalances(address: string): Promise<{
  matic: number
  usdc:  number
  usdcRaw: string
  allowanceCtf: number
  allowanceNeg: number
}> {
  const provider = getProvider()
  const usdc     = new ethers.Contract(USDC_E, ERC20_ABI, provider)
  const [maticWei, usdcRaw, allowCtfRaw, allowNegRaw] = await Promise.all([
    provider.getBalance(address),
    usdc.balanceOf(address),
    usdc.allowance(address, CTF_EXCHANGE),
    usdc.allowance(address, NEG_RISK_EXCHANGE),
  ])
  return {
    matic:        parseFloat(ethers.formatEther(maticWei)),
    usdc:         parseFloat(ethers.formatUnits(usdcRaw, 6)),
    usdcRaw:      usdcRaw.toString(),
    allowanceCtf: parseFloat(ethers.formatUnits(allowCtfRaw, 6)),
    allowanceNeg: parseFloat(ethers.formatUnits(allowNegRaw, 6)),
  }
}

// ── One-time USDC approval ──────────────────────────────────────────────
// Polymarket requires the user to approve USDC.e to BOTH the standard
// CTF Exchange and the neg-risk exchange (used for "or" / multi-outcome
// markets). We send both approvals in sequence and persist the second
// tx hash as the canonical allowance marker.
export async function ensureUsdcAllowance(userId: string): Promise<{
  alreadyApproved: boolean
  txHashes: string[]
}> {
  const { wallet, address } = await getUserPolygonSigner(userId)
  const usdc = new ethers.Contract(USDC_E, ERC20_ABI, wallet)

  const [allowCtf, allowNeg] = await Promise.all([
    usdc.allowance(address, CTF_EXCHANGE),
    usdc.allowance(address, NEG_RISK_EXCHANGE),
  ])
  const minNeeded = ethers.parseUnits('1000000', 6) // require ≥1M USDC allowance to skip

  if (allowCtf >= minNeeded && allowNeg >= minNeeded) {
    await db.polymarketCreds.updateMany({
      where: { userId },
      data:  { allowanceVerifiedAt: new Date() },
    })
    return { alreadyApproved: true, txHashes: [] }
  }

  const txHashes: string[] = []
  if (allowCtf < minNeeded) {
    const tx = await (usdc as any).approve(CTF_EXCHANGE, MAX_UINT256)
    const receipt = await tx.wait()
    txHashes.push(receipt.hash)
  }
  if (allowNeg < minNeeded) {
    const tx = await (usdc as any).approve(NEG_RISK_EXCHANGE, MAX_UINT256)
    const receipt = await tx.wait()
    txHashes.push(receipt.hash)
  }

  await db.polymarketCreds.updateMany({
    where: { userId },
    data:  {
      allowanceTxHash:     txHashes[txHashes.length - 1] ?? null,
      allowanceVerifiedAt: new Date(),
    },
  })

  return { alreadyApproved: false, txHashes }
}

// ── Place a market order (buy or sell) ─────────────────────────────────
export interface PlaceOrderArgs {
  userId:     string
  agentId?:   string
  tokenId:    string
  side:       'BUY' | 'SELL'
  // BUY: USDC notional to spend. SELL: outcome-token quantity to sell.
  amount:     number
  marketCtx: {
    conditionId:  string
    marketTitle:  string
    marketSlug?:  string
    outcomeLabel: string
  }
  reasoning?: string
  providers?: any
  // Slippage protection. expectedPrice is the orderbook price the user (or
  // agent) saw at decision time; maxSlippageBps is how far we'll let it
  // drift before refusing. Both optional — if expectedPrice is omitted we
  // fall back to "best available" market semantics. Set both for a true
  // slippage-protected market order.
  expectedPrice?:  number
  maxSlippageBps?: number
  // Skip the on-chain allowance pre-check (used when caller has already
  // verified the allowance, e.g. fresh from setup).
  skipAllowanceCheck?: boolean
}

export interface PlaceOrderResult {
  ok:         boolean
  positionId?: string
  orderId?:   string
  orderHash?: string
  fillPrice?: number
  error?:     string
}

export async function placeMarketOrder(args: PlaceOrderArgs): Promise<PlaceOrderResult> {
  const {
    userId, agentId, tokenId, side, amount, marketCtx, reasoning, providers,
    expectedPrice, maxSlippageBps, skipAllowanceCheck,
  } = args

  let positionId: string | undefined
  try {
    // 1. Build authed client; this REQUIRES builder attribution to be
    //    valid (or absent in dev). A misconfigured deploy throws here
    //    before any USDC moves.
    const { client, builderCode, attributionOk } = await getAuthedClient(userId, {
      requireAttribution: true,
    })

    // 2. Allowance pre-check. Without USDC approval the CLOB will reject
    //    the order (or worse, silently quote a fill that can't settle).
    //    The agent path used to skip this — it now opts in by default.
    if (!skipAllowanceCheck) {
      await ensureUsdcAllowance(userId)
    }

    // 3. Read the current best price for slippage check + telemetry.
    //    Polymarket "market" orders are FAK orders — by passing `price`
    //    we cap the worst fill we'll accept. With no price, the SDK
    //    walks the entire book up to 1.0 (BUY) or down to 0.0 (SELL),
    //    which is fine for tiny size but disastrous on a thin book.
    let entryEstimate = 0.5
    try {
      const mid = await client.getMidpoint(tokenId)
      const v = parseFloat(String((mid as any)?.mid ?? mid))
      if (Number.isFinite(v) && v > 0 && v < 1) entryEstimate = v
    } catch {}

    // Slippage gate — refuse if the book has moved away from what the
    // caller saw. bps is the standard unit: 500 bps = 5% drift.
    if (
      expectedPrice && Number.isFinite(expectedPrice) &&
      maxSlippageBps && maxSlippageBps > 0
    ) {
      const driftBps = Math.abs(entryEstimate - expectedPrice) / expectedPrice * 10_000
      if (driftBps > maxSlippageBps) {
        return {
          ok: false,
          error: `Price moved ${driftBps.toFixed(0)}bps (cap ${maxSlippageBps}bps): saw ${expectedPrice.toFixed(3)}, now ${entryEstimate.toFixed(3)}`,
        }
      }
    }

    // The price we'll cap fills at. For BUY we accept at-or-below
    // (expectedPrice * (1 + slippage)); for SELL at-or-above
    // (expectedPrice * (1 - slippage)). Falls through to mid +/- band
    // if no expected price was supplied.
    const slipMul = maxSlippageBps ? maxSlippageBps / 10_000 : 0.05
    const ref     = expectedPrice && Number.isFinite(expectedPrice) ? expectedPrice : entryEstimate
    const capPrice = side === 'BUY'
      ? Math.min(0.999, ref * (1 + slipMul))
      : Math.max(0.001, ref * (1 - slipMul))

    // 4. Persist the position FIRST in 'placed' state so we have an
    //    audit trail even if the CLOB POST hangs / network blips.
    const position = await db.polymarketPosition.create({
      data: {
        userId,
        agentId:      agentId ?? null,
        conditionId:  marketCtx.conditionId,
        tokenId,
        marketSlug:   marketCtx.marketSlug ?? null,
        marketTitle:  marketCtx.marketTitle,
        outcomeLabel: marketCtx.outcomeLabel,
        side,
        sizeUsdc:     side === 'BUY' ? amount : amount * entryEstimate,
        entryPrice:   entryEstimate,
        status:       'placed',
        builderCode,
        reasoning:    reasoning ?? null,
        providers:    providers ?? null,
      },
    })
    positionId = position.id

    // 5. Build + sign the order. createMarketOrder with `price` enforces
    //    a limit-priced FAK — partial fill ok, anything worse than `price`
    //    is left unfilled. This is our slippage protection at the SDK level.
    if (!attributionOk) {
      // Belt-and-braces: getAuthedClient with requireAttribution should
      // have already thrown, but if anyone ever flips that flag this
      // is the second guard.
      throw new Error('Refusing to place order without verified builder attribution')
    }
    const signed = await client.createMarketOrder({
      tokenID:  tokenId,
      side:     side === 'BUY' ? Side.BUY : Side.SELL,
      amount,
      price:    capPrice,
      orderType: OrderType.FAK,
    })

    const resp = await client.postOrder(signed, OrderType.FAK)

    if (!resp || resp.success === false) {
      const errMsg = (resp && (resp.errorMsg || resp.error || resp.message)) || 'CLOB rejected order'
      await db.polymarketPosition.update({
        where: { id: position.id },
        data:  { status: 'failed', errorMessage: String(errMsg).slice(0, 500) },
      })
      return { ok: false, positionId, error: String(errMsg) }
    }

    const orderId   = resp.orderID || resp.orderId || null
    const orderHash = resp.orderHash || (signed as any)?.hash || null
    const status    = (resp.status === 'matched' || resp.status === 'filled') ? resp.status : 'placed'

    // Authoritative fill quantities from the CLOB response. These come back
    // as decimal strings:
    //   makingAmount = what we gave (USDC for BUY; outcome shares for SELL)
    //   takingAmount = what we got  (outcome shares for BUY; USDC for SELL)
    // Falling back to the estimate is OK for the very first ms before the
    // CLOB confirms a fill, but using it as the *persisted* truth (as the
    // old code did) means a 50% partial fill on BUY would record 100% of
    // shares — and the SELL UI would then submit an oversized exit that
    // the CLOB would reject. Always prefer real fills when present.
    const makingAmount = parseFloat(String((resp as any).makingAmount ?? '0'))
    const takingAmount = parseFloat(String((resp as any).takingAmount ?? '0'))
    const realShares =
      side === 'BUY'
        ? (Number.isFinite(takingAmount) && takingAmount > 0 ? takingAmount : amount / entryEstimate)
        : (Number.isFinite(makingAmount) && makingAmount > 0 ? makingAmount : amount)
    // Average fill price from the CLOB-reported amounts when both legs are
    // present. Falls back to the midpoint estimate otherwise.
    const realFillPrice =
      side === 'BUY' && Number.isFinite(makingAmount) && makingAmount > 0 && Number.isFinite(takingAmount) && takingAmount > 0
        ? makingAmount / takingAmount
        : side === 'SELL' && Number.isFinite(takingAmount) && takingAmount > 0 && Number.isFinite(makingAmount) && makingAmount > 0
          ? takingAmount / makingAmount
          : entryEstimate

    await db.polymarketPosition.update({
      where: { id: position.id },
      data:  {
        orderId,
        orderHash,
        status,
        fillSize:   realShares,
        entryPrice: realFillPrice,
        sizeUsdc:   side === 'BUY'
          ? (Number.isFinite(makingAmount) && makingAmount > 0 ? makingAmount : amount)
          : (Number.isFinite(takingAmount) && takingAmount > 0 ? takingAmount : amount * entryEstimate),
      },
    })

    return { ok: true, positionId, orderId: orderId ?? undefined, orderHash: orderHash ?? undefined, fillPrice: realFillPrice }
  } catch (err: any) {
    const msg = err?.message ?? String(err)
    if (positionId) {
      await db.polymarketPosition.update({
        where: { id: positionId },
        data:  { status: 'failed', errorMessage: msg.slice(0, 500) },
      }).catch(() => {})
    }
    return { ok: false, positionId, error: msg }
  }
}

// ── Read user's positions ───────────────────────────────────────────────
// Polymarket's Data API (independent host) is the source-of-truth for
// realized positions; for now we surface our own DB records (which are
// always 1:1 with the orders BUILD4 placed) and let the agent reconciler
// hydrate fill data from the Data API in a follow-up.
export async function getUserPositions(userId: string) {
  return db.polymarketPosition.findMany({
    where:   { userId },
    orderBy: { openedAt: 'desc' },
    take:    200,
  })
}
