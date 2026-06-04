/**
 * Broker spread fees — flat 0.30% (configurable via env) charged on the
 * 4 venues that don't have a native builder/affiliate program (42.space,
 * four.meme, PancakeSwap, Topaz). Aster and Hyperliquid are already
 * monetized via their respective builder programs.
 *
 * Design choices:
 *  - Pre-deduct on BUYS (input asset known up-front): fee is sent from
 *    the user's wallet to BROKER_FEE_WALLET, and the trade is then
 *    executed with `gross - fee` as the net input.
 *  - Post-deduct on SELLS (output asset arrives after the swap): trade
 *    is executed gross; then a fee transfer is sent from the user's
 *    wallet using the quoted output as the basis. The quoted vs actual
 *    delta is bounded by slippage caps already enforced upstream
 *    (Pancake 500bps, four.meme 2000bps), so the worst-case error is
 *    bps-level — acceptable for a 30bps fee.
 *  - Fail-CLOSED: if the fee transfer reverts (e.g. insufficient gas,
 *    RPC outage), the trade is refused. We never want to silently waive
 *    fees — that's how broker margin gets eaten by bugs.
 *  - Every fee write is logged to BrokerFee for reconciliation against
 *    the recipient wallet's on-chain history.
 *
 * NOTE on USDT: BSC USDT is 18-decimal (not 6 like Ethereum/Polygon
 * USDT). Helpers here assume 18 decimals; callers passing differently-
 * scaled bigints will compute the wrong fee.
 */
import { ethers } from 'ethers'
import { db } from '../db'
import { buildBscProvider } from './bscProvider'

export const BROKER_FEE_BPS_DEFAULT = 30
export const BROKER_FEE_WALLET_DEFAULT = '0x5Ff57464152c9285A8526a0665d996dA66e2def1'
export const BSC_USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955'

const USDT_ERC20_ABI = [
  'function transfer(address to, uint256 value) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
] as const

export function brokerFeeBps(): number {
  const raw = process.env.BROKER_FEE_BPS
  if (!raw) return BROKER_FEE_BPS_DEFAULT
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 1000) {
    // Hard cap at 10% to prevent a typo from destroying user funds.
    throw new Error(`BROKER_FEE_BPS out of range (0..1000): ${raw}`)
  }
  return Math.floor(n)
}

export function brokerFeeWallet(): string {
  const w = process.env.BROKER_FEE_WALLET ?? BROKER_FEE_WALLET_DEFAULT
  if (!ethers.isAddress(w)) {
    throw new Error(`BROKER_FEE_WALLET is not a valid address: ${w}`)
  }
  return ethers.getAddress(w)
}

/** Pure-math: split gross into {fee, net} at the configured bps. */
export function applySpreadFee(gross: bigint, bpsOverride?: number): { fee: bigint; net: bigint; bps: number } {
  const bps = bpsOverride ?? brokerFeeBps()
  if (gross <= 0n) return { fee: 0n, net: 0n, bps }
  const fee = (gross * BigInt(bps)) / 10000n
  return { fee, net: gross - fee, bps }
}

export interface FeeContext {
  userId: string
  venue: 'pancake' | 'fourmeme' | 'topaz' | '42space'
  side: 'buy' | 'sell' | 'swap'
  agentId?: string | null
}

export interface FeeResult {
  netWei: bigint
  feeWei: bigint
  feeTxHash: string | null
  bps: number
  skipped?: boolean
}

async function recordFee(args: {
  ctx: FeeContext
  asset: string
  grossWei: bigint
  feeWei: bigint
  bps: number
  feeTxHash: string | null
}) {
  try {
    await db.$executeRawUnsafe(
      `INSERT INTO "BrokerFee" ("userId","agentId","venue","side","asset","grossAmount","feeAmount","feeBps","feeTxHash")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      args.ctx.userId,
      args.ctx.agentId ?? null,
      args.ctx.venue,
      args.ctx.side,
      args.asset,
      args.grossWei.toString(),
      args.feeWei.toString(),
      args.bps,
      args.feeTxHash,
    )
  } catch (e) {
    // Logging failure must not block the trade — the on-chain transfer
    // already happened and is the source of truth. We log to console
    // so operators can reconcile manually.
    console.error('[brokerFees] failed to record fee row:', (e as Error)?.message ?? e)
  }
}

/**
 * Charge a BNB-denominated spread fee. Returns the net amount the
 * caller should trade with. Fail-closed: throws on transfer failure.
 */
export async function chargeBnbFee(
  privateKey: string,
  grossWei: bigint,
  ctx: FeeContext,
): Promise<FeeResult> {
  const { fee, net, bps } = applySpreadFee(grossWei)
  if (fee <= 0n) {
    return { netWei: grossWei, feeWei: 0n, feeTxHash: null, bps, skipped: true }
  }
  const provider = buildBscProvider(process.env.BSC_RPC_URL)
  const signer = new ethers.Wallet(privateKey, provider)
  const to = brokerFeeWallet()
  let feeTxHash: string | null = null
  try {
    const tx = await signer.sendTransaction({ to, value: fee })
    await tx.wait(1)
    feeTxHash = tx.hash
  } catch (e: any) {
    const msg = e?.shortMessage ?? e?.message ?? String(e)
    throw new Error(`broker_fee_transfer_failed:${msg}`)
  }
  await recordFee({ ctx, asset: 'BNB', grossWei, feeWei: fee, bps, feeTxHash })
  return { netWei: net, feeWei: fee, feeTxHash, bps }
}

/**
 * Charge an ERC20-denominated spread fee (USDT, WBNB, any BEP20).
 * Fail-closed.
 */
export async function chargeErc20Fee(
  privateKey: string,
  tokenAddress: string,
  grossWei: bigint,
  ctx: FeeContext,
  assetLabel?: string,
): Promise<FeeResult> {
  const { fee, net, bps } = applySpreadFee(grossWei)
  if (fee <= 0n) {
    return { netWei: grossWei, feeWei: 0n, feeTxHash: null, bps, skipped: true }
  }
  const provider = buildBscProvider(process.env.BSC_RPC_URL)
  const signer = new ethers.Wallet(privateKey, provider)
  const to = brokerFeeWallet()
  const token = new ethers.Contract(ethers.getAddress(tokenAddress), USDT_ERC20_ABI, signer)
  let feeTxHash: string | null = null
  try {
    const tx = await token.transfer(to, fee)
    await tx.wait(1)
    feeTxHash = tx.hash
  } catch (e: any) {
    const msg = e?.shortMessage ?? e?.message ?? String(e)
    throw new Error(`broker_fee_transfer_failed:${msg}`)
  }
  const asset = assetLabel ?? ethers.getAddress(tokenAddress)
  await recordFee({ ctx, asset, grossWei, feeWei: fee, bps, feeTxHash })
  return { netWei: net, feeWei: fee, feeTxHash, bps }
}

/** Convenience wrapper for BSC USDT (18-decimal). */
export async function chargeUsdtFee(
  privateKey: string,
  grossWei: bigint,
  ctx: FeeContext,
): Promise<FeeResult> {
  return chargeErc20Fee(privateKey, BSC_USDT_ADDRESS, grossWei, ctx, 'USDT')
}
