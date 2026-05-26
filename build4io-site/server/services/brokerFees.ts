// Self-contained 30bps BNB broker fee for website four.meme trades.
//
// Mirrors src/services/brokerFees.ts (bot side) but uses the website's
// own pg.Pool (build4io-site/server/db) so the build4io-site package
// doesn't have to import from src/. Same BROKER_FEE_WALLET, same
// BROKER_FEE_BPS env, same BrokerFee table — so finance reconciliation
// across bot + website is unified.
//
// Design (matches bot):
//  - BUY:  pre-deduct. Fee transfer fires BEFORE the buy; the buy then
//          runs with the net BNB. If the fee transfer fails, the buy
//          is refused (fail-closed).
//  - SELL: post-deduct. Sell fires gross; we then fee-charge from the
//          QUOTED BNB output (bounded by slippage cap upstream so the
//          delta vs actual is bps-level — acceptable on a 30bps fee).
//          If the fee transfer fails, we throw — the trade row in the
//          response still shows the on-chain tx so the user can
//          reconcile, but the API marks the fee as failed.
//
// All trades on this page are BNB-quoted (we refuse BEP20-quoted
// four.meme tokens upstream), so a BNB-only fee module is sufficient.

import { ethers } from "ethers";
import { pool } from "../db";

// Self-instantiated BSC provider — kept independent of fourMemeTrading
// to avoid an import cycle (fourMemeTrading imports this module at
// runtime to charge fees, and brokerFees inserting itself back into
// that import graph creates fragile module init ordering).
const BSC_RPC =
  process.env.BSC_RPC_URL ||
  "https://bsc-dataseed.binance.org";
let _provider: ethers.JsonRpcProvider | null = null;
function provider(): ethers.JsonRpcProvider {
  if (!_provider) _provider = new ethers.JsonRpcProvider(BSC_RPC, 56);
  return _provider;
}

export const BROKER_FEE_BPS_DEFAULT = 30;
export const BROKER_FEE_WALLET_DEFAULT = "0x5Ff57464152c9285A8526a0665d996dA66e2def1";

export function brokerFeeBps(): number {
  const raw = process.env.BROKER_FEE_BPS;
  if (!raw) return BROKER_FEE_BPS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1000) {
    throw new Error(`BROKER_FEE_BPS out of range (0..1000): ${raw}`);
  }
  return Math.floor(n);
}

export function brokerFeeWallet(): string {
  const w = process.env.BROKER_FEE_WALLET ?? BROKER_FEE_WALLET_DEFAULT;
  if (!ethers.isAddress(w)) {
    throw new Error(`BROKER_FEE_WALLET is not a valid address: ${w}`);
  }
  return ethers.getAddress(w);
}

export function applySpreadFee(gross: bigint, bpsOverride?: number) {
  const bps = bpsOverride ?? brokerFeeBps();
  if (gross <= 0n) return { fee: 0n, net: 0n, bps };
  const fee = (gross * BigInt(bps)) / 10000n;
  return { fee, net: gross - fee, bps };
}

export interface FeeContext {
  userId: string;                       // SIWE wallet address
  venue: "fourmeme" | "pancake";
  side: "buy" | "sell";
}

export interface FeeResult {
  netWei: bigint;
  feeWei: bigint;
  feeTxHash: string | null;
  bps: number;
  skipped?: boolean;
}

async function recordFee(args: {
  ctx: FeeContext;
  asset: string;
  grossWei: bigint;
  feeWei: bigint;
  bps: number;
  feeTxHash: string | null;
}) {
  // Mirror the bot's BrokerFee table shape. agentId is null for
  // website manual trades — the competition leaderboard already
  // links these via wallet address, not agentId.
  try {
    await pool.query(
      `INSERT INTO "BrokerFee" ("userId","agentId","venue","side","asset","grossAmount","feeAmount","feeBps","feeTxHash")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        args.ctx.userId,
        null,
        args.ctx.venue,
        args.ctx.side,
        args.asset,
        args.grossWei.toString(),
        args.feeWei.toString(),
        args.bps,
        args.feeTxHash,
      ],
    );
  } catch (e: any) {
    // Logging failure must not block the trade — the on-chain
    // transfer already happened and is the source of truth.
    console.error("[brokerFees] failed to record fee row:", e?.message ?? e);
  }
}

/**
 * Charge a BNB broker fee. Returns the net amount the caller should
 * trade with. Fail-closed: throws on transfer failure.
 */
export async function chargeBnbFee(
  privateKey: string,
  grossWei: bigint,
  ctx: FeeContext,
): Promise<FeeResult> {
  const { fee, net, bps } = applySpreadFee(grossWei);
  if (fee <= 0n) {
    return { netWei: grossWei, feeWei: 0n, feeTxHash: null, bps, skipped: true };
  }
  const signer = new ethers.Wallet(privateKey, provider());
  const to = brokerFeeWallet();
  let feeTxHash: string | null = null;
  try {
    const tx = await signer.sendTransaction({ to, value: fee });
    await tx.wait(1);
    feeTxHash = tx.hash;
  } catch (e: any) {
    const msg = e?.shortMessage ?? e?.message ?? String(e);
    throw new Error(`broker_fee_transfer_failed:${msg}`);
  }
  await recordFee({ ctx, asset: "BNB", grossWei, feeWei: fee, bps, feeTxHash });
  return { netWei: net, feeWei: fee, feeTxHash, bps };
}
