/**
 * Phase 3 of BNBAgent SDK integration: x402 Payment middleware.
 *
 * Implements the HTTP 402 Payment Required protocol (Coinbase x402 spec)
 * for gating paid resources behind a BSC USDT micropayment. Returns 402
 * with a JSON body describing the payment requirements; clients retry
 * with `X-PAYMENT: <txHash>` after sending the USDT transfer; the
 * server verifies on-chain (recipient, amount, recency, single-use)
 * before serving the protected resource.
 *
 * STATUS (2026-05-19): scaffolding shipped, kill switch OFF.
 *   - Wiring + verification logic is complete.
 *   - Disabled unless X402_ENABLED='true' AND X402_TREASURY_ADDRESS is set.
 *   - While disabled, gated endpoints return 503 "x402 disabled" so a
 *     misconfigured production env can't accidentally serve paid content
 *     for free.
 *
 * NOTE ON PAYMENT SCHEME: standard x402 uses EIP-3009
 * `transferWithAuthorization` for gasless USDC pulls. BSC USDT
 * (`0x55d398326f99059fF775485246999027B3197955`) does NOT implement
 * EIP-3009, so we use the simpler "tx-hash verification" scheme:
 * the client first sends a USDT transfer to the treasury, then retries
 * the request with the resulting txHash as the X-PAYMENT header. The
 * server checks the tx exists, has the right recipient + amount + token,
 * is recent (within X402_TX_MAX_AGE_BLOCKS), and hasn't been used before.
 *
 * Single-use enforcement uses the `X402Payment` table (created in
 * ensureTables.ts) which records every accepted txHash. A second request
 * with the same hash returns 402 "payment already consumed".
 */

import type { Request, Response, NextFunction } from 'express'
import { ethers } from 'ethers'
import { db } from '../db'
import { buildBscProvider } from './bscProvider'

// BSC USDT (Tether) — 18 decimals on BSC (unlike Ethereum/Polygon which use 6).
const BSC_USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955'
const BSC_USDT_DECIMALS = 18

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)')

interface PaymentRequirement {
  /** Amount in human units (e.g. 0.01 means 0.01 USDT). */
  amountUsdt: number
  /** Free-text description of what is being paid for. */
  description: string
  /** Public URL of the resource being purchased — echoed back to the client. */
  resource: string
}

function isEnabled(): { ok: true; treasury: string } | { ok: false; reason: string } {
  if ((process.env.X402_ENABLED || '').trim() !== 'true') {
    return { ok: false, reason: 'X402_ENABLED is not "true"' }
  }
  const treasury = (process.env.X402_TREASURY_ADDRESS || '').trim()
  if (!ethers.isAddress(treasury)) {
    return { ok: false, reason: 'X402_TREASURY_ADDRESS missing or invalid' }
  }
  return { ok: true, treasury: ethers.getAddress(treasury) }
}

/**
 * Build the JSON body returned with the 402 status. Shape follows the
 * coinbase/x402 spec so off-the-shelf x402 clients can parse it.
 */
function buildPaymentRequiredBody(req: PaymentRequirement, treasury: string) {
  const amountSmallestUnit = ethers.parseUnits(req.amountUsdt.toString(), BSC_USDT_DECIMALS).toString()
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'txhash',
        network: 'bsc',
        maxAmountRequired: amountSmallestUnit,
        resource: req.resource,
        description: req.description,
        mimeType: 'application/json',
        payTo: treasury,
        maxTimeoutSeconds: 60,
        asset: BSC_USDT_ADDRESS,
        extra: { name: 'Tether USD (BSC)', version: '1', decimals: BSC_USDT_DECIMALS },
      },
    ],
    error: 'X-PAYMENT header required (send USDT to payTo, then retry with txHash as header value)',
  }
}

/**
 * Verify a payment tx on BSC.
 *
 * Returns `{ ok: true, payer }` if and only if:
 *   1. The tx exists and is confirmed (>=1 block).
 *   2. The tx contains a Transfer(token=USDT, to=treasury, value>=required).
 *   3. The tx is recent (within `X402_TX_MAX_AGE_BLOCKS`, default ~5min on BSC).
 *   4. The tx hash has NOT been recorded as consumed in the X402Payment table.
 *
 * Returns `{ ok: false, reason }` otherwise. Reason is human-readable and
 * safe to surface to the client.
 */
async function verifyPayment(
  txHash: string,
  requiredAmountSmallestUnit: bigint,
  treasury: string
): Promise<{ ok: true; payer: string } | { ok: false; reason: string }> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { ok: false, reason: 'malformed X-PAYMENT header (expected 0x… txhash)' }
  }

  // Single-use check happens FIRST so we don't even hit the RPC on
  // replay attempts.
  const existing = await db.$queryRawUnsafe<{ tx_hash: string }[]>(
    'SELECT tx_hash FROM "X402Payment" WHERE tx_hash = $1 LIMIT 1',
    txHash.toLowerCase()
  ).catch(() => [] as { tx_hash: string }[])
  if (existing.length > 0) {
    return { ok: false, reason: 'payment already consumed (each txHash is single-use)' }
  }

  let provider
  try {
    provider = buildBscProvider()
  } catch (err: any) {
    return { ok: false, reason: `RPC unavailable: ${err?.message ?? 'unknown'}` }
  }

  const receipt = await provider.getTransactionReceipt(txHash).catch(() => null)
  if (!receipt) return { ok: false, reason: 'tx not found or not yet confirmed' }
  if (receipt.status !== 1) return { ok: false, reason: 'tx reverted on chain' }

  const headBlock = await provider.getBlockNumber().catch(() => receipt.blockNumber)
  // Require at least `minConfirmations` blocks of depth before accepting.
  // BSC reorgs are rare but possible; 1 block of separation between the
  // tx and head is the minimum safety margin.
  const minConfirmations = parseInt(process.env.X402_MIN_CONFIRMATIONS ?? '1', 10)
  if (headBlock - receipt.blockNumber < minConfirmations) {
    return {
      ok: false,
      reason: `tx not yet confirmed to depth ${minConfirmations} (current depth ${headBlock - receipt.blockNumber})`,
    }
  }
  const maxAge = parseInt(process.env.X402_TX_MAX_AGE_BLOCKS ?? '100', 10) // ~5min on BSC (3s blocks)
  if (headBlock - receipt.blockNumber > maxAge) {
    return { ok: false, reason: `tx older than ${maxAge} blocks (~5min); request a fresh payment` }
  }

  // Scan logs for a USDT Transfer(any → treasury, value >= required).
  const treasuryTopic = ethers.zeroPadValue(treasury.toLowerCase(), 32)
  let payer: string | null = null
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== BSC_USDT_ADDRESS.toLowerCase()) continue
    if (log.topics[0] !== TRANSFER_TOPIC) continue
    if (log.topics[2].toLowerCase() !== treasuryTopic.toLowerCase()) continue
    const value = BigInt(log.data)
    if (value < requiredAmountSmallestUnit) continue
    payer = ethers.getAddress('0x' + log.topics[1].slice(26))
    break
  }
  if (!payer) {
    return {
      ok: false,
      reason: `no USDT Transfer to treasury ${treasury} with sufficient amount in this tx`,
    }
  }

  return { ok: true, payer }
}

/**
 * Atomically claim a txHash for the current request.
 *
 * Race-condition fix (was a HIGH-severity finding): two concurrent
 * requests with the same txHash both pass the read-side existence
 * check in `verifyPayment`. To prevent both from being honored, we
 * use INSERT ... ON CONFLICT DO NOTHING and inspect the affected
 * row count. Only the caller whose INSERT actually wrote a row "wins"
 * the claim; the loser sees `claimed: false` and is rejected with
 * "already consumed". This makes the primary-key constraint on
 * `tx_hash` the single source of truth for single-use enforcement.
 */
async function claimPayment(args: {
  txHash: string
  payer: string
  resource: string
  amountSmallestUnit: string
}): Promise<{ claimed: boolean }> {
  try {
    const affected = await db.$executeRawUnsafe(
      `INSERT INTO "X402Payment" (tx_hash, payer, resource, amount, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (tx_hash) DO NOTHING`,
      args.txHash.toLowerCase(),
      args.payer.toLowerCase(),
      args.resource,
      args.amountSmallestUnit
    )
    // $executeRawUnsafe returns the number of rows affected. 0 means
    // ON CONFLICT fired — another request already claimed this hash.
    return { claimed: Number(affected) > 0 }
  } catch (err: any) {
    console.error('[x402] claimPayment failed:', err?.message ?? err)
    return { claimed: false }
  }
}

/**
 * Express middleware factory. Use like:
 *
 *   app.get('/api/x402/premium-signal',
 *     requireX402Payment({ amountUsdt: 0.10, description: 'Premium trading signal', resource: '/api/x402/premium-signal' }),
 *     (req, res) => { res.json({ ... }) })
 *
 * On success, `req.x402` is populated with `{ payer, txHash }` so the
 * handler can attribute the request.
 */
export function requireX402Payment(req: PaymentRequirement) {
  return async (httpReq: Request & { x402?: { payer: string; txHash: string } }, res: Response, next: NextFunction) => {
    const status = isEnabled()
    if (!status.ok) {
      // Fail-closed: never serve paid content for free if x402 isn't on.
      return res.status(503).json({ error: 'x402 disabled', detail: status.reason })
    }

    const xPayment = (httpReq.header('X-PAYMENT') || '').trim()
    if (!xPayment) {
      return res.status(402).json(buildPaymentRequiredBody(req, status.treasury))
    }

    const requiredSmallest = ethers.parseUnits(req.amountUsdt.toString(), BSC_USDT_DECIMALS)
    const verdict = await verifyPayment(xPayment, requiredSmallest, status.treasury)
    if (!verdict.ok) {
      return res.status(402).json({
        ...buildPaymentRequiredBody(req, status.treasury),
        error: verdict.reason,
      })
    }

    // Atomic claim — only one concurrent caller wins. Loser gets 402.
    const claim = await claimPayment({
      txHash: xPayment,
      payer: verdict.payer,
      resource: req.resource,
      amountSmallestUnit: requiredSmallest.toString(),
    })
    if (!claim.claimed) {
      return res.status(402).json({
        ...buildPaymentRequiredBody(req, status.treasury),
        error: 'payment already consumed (race lost or replay)',
      })
    }

    httpReq.x402 = { payer: verdict.payer, txHash: xPayment }
    next()
  }
}

/**
 * For diagnostics / admin endpoints.
 */
export function x402Status(): { enabled: boolean; treasury?: string; reason?: string } {
  const status = isEnabled()
  if (status.ok) return { enabled: true, treasury: status.treasury }
  return { enabled: false, reason: status.reason }
}
