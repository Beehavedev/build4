/**
 * On-chain payment verifier for subscriptions.
 *
 * Verifies a USDT-on-BSC or USDC-on-Base transfer to the configured
 * treasury wallet. Mirrors the proven x402.ts verifier pattern but is
 * decoupled (different table, different recipient envs, different
 * confirmation policy — subscriptions are higher-value so we wait for
 * deeper confirmations).
 *
 * Env config:
 *   SUBSCRIPTION_TREASURY_BSC   — BSC address receiving USDT (BEP-20).
 *                                  Falls back to BROKER_FEE_WALLET so a
 *                                  single-wallet deployment Just Works.
 *   SUBSCRIPTION_TREASURY_BASE  — Base address receiving USDC. Same fallback.
 *   BSC_RPC_URL                  — already used by bscProvider.ts.
 *   BASE_RPC_URL                 — required for Base verification; if
 *                                  unset, Base verification fail-closes
 *                                  with reason='base_rpc_unconfigured'
 *                                  and the BSC path keeps working.
 *   SUBSCRIPTION_TX_MAX_AGE_BLOCKS_BSC — defaults to 1200 (~1h on BSC).
 *   SUBSCRIPTION_TX_MAX_AGE_BLOCKS_BASE — defaults to 1800 (~1h on Base 2s blocks).
 *   SUBSCRIPTION_MIN_CONFIRMATIONS — defaults to 3 (subscription payments
 *                                    are higher value than x402 micropayments).
 */

import { ethers } from 'ethers'
import { buildBscProvider } from './bscProvider'

// BSC USDT — 18 decimals (unlike Ethereum/Polygon which use 6).
const BSC_USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955'
const BSC_USDT_DECIMALS = 18

// Base USDC (native, not bridged) — 6 decimals.
const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const BASE_USDC_DECIMALS = 6

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)')

export type PaymentChain = 'bsc' | 'base'
export type PaymentAsset = 'USDT' | 'USDC'

export interface VerifyResult {
  ok: boolean
  reason?: string
  payer?: string
  asset?: PaymentAsset
  amountUsd?: number
  treasury?: string
}

function fallbackTreasury(): string | null {
  const fb = (process.env.BROKER_FEE_WALLET || '').trim()
  return ethers.isAddress(fb) ? ethers.getAddress(fb) : null
}

export function treasuryFor(chain: PaymentChain): { ok: true; address: string } | { ok: false; reason: string } {
  const envKey = chain === 'bsc' ? 'SUBSCRIPTION_TREASURY_BSC' : 'SUBSCRIPTION_TREASURY_BASE'
  const raw = (process.env[envKey] || '').trim()
  if (raw) {
    if (!ethers.isAddress(raw)) return { ok: false, reason: `${envKey} is set but malformed` }
    return { ok: true, address: ethers.getAddress(raw) }
  }
  const fb = fallbackTreasury()
  if (!fb) return { ok: false, reason: `${envKey} unset and BROKER_FEE_WALLET fallback unavailable` }
  return { ok: true, address: fb }
}

function buildBaseProvider(): ethers.JsonRpcProvider | null {
  const rpc = (process.env.BASE_RPC_URL || '').trim()
  if (!rpc) return null
  // staticNetwork avoids ethers v6 calling eth_chainId before every read.
  return new ethers.JsonRpcProvider(rpc, { chainId: 8453, name: 'base' }, { staticNetwork: true })
}

/**
 * Verify a payment txhash on the specified chain. Returns the
 * normalised result the caller can pass into `subscriptions.recordPayment`.
 * Does NOT consume the tx — the Subscription table's unique index on
 * txHash is the single-use guard (mirrors the X402Payment pattern).
 */
/**
 * Verifier requires an EXACT-match expectedAmountSmallest (bigint) rather
 * than a >= USD float. This is the second half of the payment-claim-
 * hijack defense (the first half is amount uniquification in
 * subscriptions.generateIntentAmount): an attacker cannot claim another
 * user's tx because their own intent has a different expectedAmountSmallest
 * and the verifier will reject the tx as "amount mismatch".
 */
export async function verifySubscriptionPayment(args: {
  chain: PaymentChain
  txHash: string
  expectedAmountSmallest: bigint
}): Promise<VerifyResult> {
  const { chain, txHash, expectedAmountSmallest } = args

  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { ok: false, reason: 'malformed txhash (expected 0x…64 hex)' }
  }

  const t = treasuryFor(chain)
  if (!t.ok) return { ok: false, reason: t.reason }

  let provider: ethers.AbstractProvider
  let tokenAddress: string
  let tokenDecimals: number
  let asset: PaymentAsset
  let maxAgeBlocks: number

  if (chain === 'bsc') {
    try {
      provider = buildBscProvider()
    } catch (err: any) {
      return { ok: false, reason: `BSC RPC unavailable: ${err?.message ?? 'unknown'}` }
    }
    tokenAddress = BSC_USDT_ADDRESS
    tokenDecimals = BSC_USDT_DECIMALS
    asset = 'USDT'
    maxAgeBlocks = parseInt(process.env.SUBSCRIPTION_TX_MAX_AGE_BLOCKS_BSC ?? '1200', 10)
  } else {
    const p = buildBaseProvider()
    if (!p) return { ok: false, reason: 'base_rpc_unconfigured (set BASE_RPC_URL)' }
    provider = p
    tokenAddress = BASE_USDC_ADDRESS
    tokenDecimals = BASE_USDC_DECIMALS
    asset = 'USDC'
    maxAgeBlocks = parseInt(process.env.SUBSCRIPTION_TX_MAX_AGE_BLOCKS_BASE ?? '1800', 10)
  }

  const minConfirmations = parseInt(process.env.SUBSCRIPTION_MIN_CONFIRMATIONS ?? '3', 10)

  const receipt = await provider.getTransactionReceipt(txHash).catch(() => null)
  if (!receipt) return { ok: false, reason: 'tx not found or not yet confirmed' }
  if (receipt.status !== 1) return { ok: false, reason: 'tx reverted on chain' }

  const headBlock = await provider.getBlockNumber().catch(() => receipt.blockNumber)
  const depth = headBlock - receipt.blockNumber
  if (depth < minConfirmations) {
    return { ok: false, reason: `tx not yet confirmed to depth ${minConfirmations} (current ${depth})` }
  }
  if (depth > maxAgeBlocks) {
    return { ok: false, reason: `tx older than ${maxAgeBlocks} blocks; request a fresh payment` }
  }

  const treasuryTopic = ethers.zeroPadValue(t.address.toLowerCase(), 32)
  let payer: string | null = null
  let receivedSmallest = 0n
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== tokenAddress.toLowerCase()) continue
    if (log.topics[0] !== TRANSFER_TOPIC) continue
    if (log.topics[2].toLowerCase() !== treasuryTopic.toLowerCase()) continue
    const value = BigInt(log.data)
    // EXACT match. Underpay → reject. Overpay → also reject (an attacker
    // could otherwise claim a victim's overpaid round-number tx by
    // creating their own intent for $19.99 base). The user is shown the
    // exact uniquified amount; if they send the wrong amount the bot
    // tells them to /subscribe again to get a fresh intent.
    if (value !== expectedAmountSmallest) continue
    payer = ethers.getAddress('0x' + log.topics[1].slice(26))
    receivedSmallest = value
    break
  }

  if (!payer) {
    const expectedHuman = Number(ethers.formatUnits(expectedAmountSmallest, tokenDecimals))
    return {
      ok: false,
      reason: `no ${asset} Transfer to treasury ${t.address} for the exact amount ${expectedHuman} ${asset} in this tx — make sure you sent the EXACT amount shown (not rounded)`,
    }
  }

  const amountUsd = Number(ethers.formatUnits(receivedSmallest, tokenDecimals))
  return { ok: true, payer, asset, amountUsd, treasury: t.address }
}
