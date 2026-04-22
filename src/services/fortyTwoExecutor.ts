import { ethers } from 'ethers';
import { db } from '../db';
import { decryptPrivateKey } from './wallet';
import { FortyTwoTrader, type DryRunReceipt } from './fortyTwoTrader';
import { readMarketOnchain, isWinningTokenId } from './fortyTwoOnchain';
import type { Market42 } from './fortyTwo';
import { getMarketByAddress } from './fortyTwo';

const BSC_RPC = process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org';

// ── Sizing rules — outcome-token positions are explicitly smaller than the
// agent's perp budget. Bonding-curve markets are illiquid; oversizing causes
// massive slippage and resolution risk is binary, so we cap aggressively.
export const PRED_PER_POSITION_USDT_CAP = 2;       // hard ceiling per market
export const PRED_AGENT_BUDGET_PCT = 0.10;         // ≤10% of agent.maxPositionSize
export const PRED_MAX_OPEN_PER_AGENT = 5;          // simultaneous open positions
export const PRED_MAX_NEW_PER_AGENT_PER_DAY = 3;   // bound velocity / cost

export interface PredictionTradeIntent {
  action: 'OPEN_PREDICTION' | 'CLOSE_PREDICTION';
  marketAddress: string;
  tokenId: number;
  outcomeLabel?: string;
  /** Agent's own probability estimate, 0..1 — must beat implied price by ≥0.10. */
  conviction?: number;
  /** Optional position id when closing a known position. */
  positionId?: string;
  reasoning?: string;
}

export interface ExecutorContext {
  agentId: string;
  agentMaxPositionSize: number;
  userId: string;
}

interface UserWalletPK {
  address: string;
  privateKey: string;
}

async function loadUserWalletPK(userId: string): Promise<UserWalletPK | null> {
  const wallet = await db.wallet.findFirst({
    where: { userId, chain: 'BSC', isActive: true },
  });
  if (!wallet?.encryptedPK) return null;
  try {
    const pk = decryptPrivateKey(wallet.encryptedPK, userId);
    if (!pk?.startsWith('0x')) return null;
    return { address: wallet.address, privateKey: pk };
  } catch {
    return null;
  }
}

/**
 * Returns a configured trader.
 *
 * - For a NEW open, pass `forcePaperTrade=undefined` so we read the current
 *   user opt-in toggle (toggle controls new opens only).
 * - For closing/settling an EXISTING position, pass the position's stored
 *   `paperTrade` flag so a position opened live always closes live, even if
 *   the user later flipped their toggle to paper. Without this, a paper-mode
 *   close on a live position would leave real on-chain exposure while marking
 *   the DB row "closed".
 */
async function buildTrader(
  userId: string,
  forcePaperTrade?: boolean,
): Promise<{ trader: FortyTwoTrader; paperTrade: boolean } | null> {
  const wallet = await loadUserWalletPK(userId);
  if (!wallet) return null;
  let paperTrade: boolean;
  if (typeof forcePaperTrade === 'boolean') {
    paperTrade = forcePaperTrade;
  } else {
    // Resolve opt-in via raw query so we don't depend on a regenerated Prisma client.
    const rows = await db.$queryRawUnsafe<Array<{ fortyTwoLiveTrade: boolean }>>(
      `SELECT "fortyTwoLiveTrade" FROM "User" WHERE id = $1 LIMIT 1`,
      userId,
    );
    const liveOptIn = rows[0]?.fortyTwoLiveTrade === true;
    paperTrade = !liveOptIn;
  }
  const trader = new FortyTwoTrader(wallet.privateKey, BSC_RPC, { dryRun: paperTrade });
  return { trader, paperTrade };
}

interface SizingResult {
  allowed: boolean;
  reason?: string;
  usdtIn?: number;
}

// Minimum order size — bonding-curve markets reject dust below this. If the
// agent's budget cap can't fund this, the trade is rejected outright instead
// of silently exceeding the cap.
const PRED_MIN_USDT_IN = 0.5;

async function checkAndSize(
  ctx: ExecutorContext,
  conviction: number,
  impliedProb: number,
  marketAddress: string,
  tokenId: number,
): Promise<SizingResult> {
  if (!Number.isFinite(conviction) || conviction <= 0 || conviction >= 1) {
    return { allowed: false, reason: 'invalid conviction' };
  }
  const edge = conviction - impliedProb;
  if (edge < 0.10) {
    return { allowed: false, reason: `edge ${(edge * 100).toFixed(1)}% < 10% threshold` };
  }

  // ── Per-market exposure guard ───────────────────────────────────────────
  // Reject if this agent already holds an open position on the same market+
  // outcome. Without this, the every-tick sidecar can stack the same trade
  // repeatedly until the agent-wide / daily caps fire, breaking the spec's
  // "capped per market" rule. We key on (marketAddress, tokenId) so that
  // genuine arb plays on opposing outcomes within the same market still work.
  const sameMarket = await db.$queryRawUnsafe<Array<{ c: bigint }>>(
    `SELECT count(*)::bigint AS c FROM "OutcomePosition"
     WHERE "agentId" = $1 AND "marketAddress" = $2 AND "tokenId" = $3
       AND status = 'open'`,
    ctx.agentId,
    marketAddress,
    tokenId,
  );
  if (Number(sameMarket[0]?.c ?? 0) > 0) {
    return { allowed: false, reason: 'already holding an open position on this market+outcome' };
  }

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const opensToday = await db.$queryRawUnsafe<Array<{ c: bigint }>>(
    `SELECT count(*)::bigint AS c FROM "OutcomePosition"
     WHERE "agentId" = $1 AND "openedAt" > $2`,
    ctx.agentId,
    dayAgo,
  );
  if (Number(opensToday[0]?.c ?? 0) >= PRED_MAX_NEW_PER_AGENT_PER_DAY) {
    return { allowed: false, reason: 'daily prediction-trade quota reached' };
  }

  const openCount = await db.$queryRawUnsafe<Array<{ c: bigint }>>(
    `SELECT count(*)::bigint AS c FROM "OutcomePosition"
     WHERE "agentId" = $1 AND status = 'open'`,
    ctx.agentId,
  );
  if (Number(openCount[0]?.c ?? 0) >= PRED_MAX_OPEN_PER_AGENT) {
    return { allowed: false, reason: 'max simultaneous prediction positions reached' };
  }

  // Position size scales with edge, capped by both per-position and per-agent
  // rules. agentCap is a HARD ceiling: if it can't even fund the minimum
  // order, the trade is rejected (we never silently exceed the budget cap).
  const edgeScaled = Math.min(1, edge / 0.30) * PRED_PER_POSITION_USDT_CAP; // 30% edge = full cap
  const agentCap = ctx.agentMaxPositionSize * PRED_AGENT_BUDGET_PCT;
  const sized = Math.min(edgeScaled, PRED_PER_POSITION_USDT_CAP, agentCap);
  if (sized < PRED_MIN_USDT_IN) {
    return {
      allowed: false,
      reason: `sized $${sized.toFixed(2)} below minimum $${PRED_MIN_USDT_IN} (agent budget too small)`,
    };
  }
  const usdtIn = sized;
  return { allowed: true, usdtIn: Number(usdtIn.toFixed(2)) };
}

/**
 * Stored row shape — typed alias used by every helper in this file. Keeps the
 * raw-SQL query path strongly typed without leaking `any` into trade logic.
 */
/**
 * Per-provider swarm telemetry persisted alongside a swarm-driven trade.
 *
 * The shape matches the Task #18 spec exactly: `provider`, `model`, `action`,
 * optional `predictionTrade`, `reasoning`, `latencyMs`, `tokensUsed`.
 */
export interface ProviderTelemetry {
  provider: string;
  model: string;
  action: string | null;
  /** Mirrors the LLM-emitted predictionTrade sidecar (or null when none). */
  predictionTrade?: unknown;
  reasoning: string | null;
  latencyMs: number;
  tokensUsed: number;
}

export interface OutcomePositionRow {
  id: string;
  userId: string;
  agentId: string | null;
  marketAddress: string;
  marketTitle: string;
  tokenId: number;
  outcomeLabel: string;
  usdtIn: number;
  entryPrice: number;
  exitPrice: number | null;
  payoutUsdt: number | null;
  pnl: number | null;
  status: string;
  paperTrade: boolean;
  txHashOpen: string | null;
  txHashClose: string | null;
  reasoning: string | null;
  openedAt: Date;
  closedAt: Date | null;
  outcomeTokenAmount: number | null;
  providers: ProviderTelemetry[] | null;
}

/** Narrow type for what this module reads off a transaction receipt. */
type TxReceiptLike = ethers.TransactionReceipt | DryRunReceipt | null;
function receiptHash(r: TxReceiptLike): string | null {
  if (!r) return null;
  if ('hash' in r && typeof r.hash === 'string') return r.hash;
  return null;
}

/** Open an outcome-token position. Records the position regardless of paper/live mode.
 *  When `providers` is supplied (swarm path), the per-provider telemetry is
 *  persisted on the OutcomePosition row so /predictions and /showcase can
 *  surface each model's individual reasoning quote. */
export async function openPredictionPosition(
  ctx: ExecutorContext,
  intent: PredictionTradeIntent,
  providers: ProviderTelemetry[] | null = null,
): Promise<{ ok: true; positionId: string; paperTrade: boolean; usdtIn: number } | { ok: false; reason: string }> {
  if (intent.action !== 'OPEN_PREDICTION') return { ok: false, reason: 'wrong action' };

  let market: Market42;
  try {
    market = await getMarketByAddress(intent.marketAddress);
  } catch (err) {
    return { ok: false, reason: `market lookup failed: ${(err as Error).message}` };
  }
  if (market.status !== 'live') return { ok: false, reason: `market not live (${market.status})` };

  let state;
  try {
    state = await readMarketOnchain(market);
  } catch (err) {
    return { ok: false, reason: `on-chain read failed: ${(err as Error).message}` };
  }
  const outcome = state.outcomes.find((o) => o.tokenId === intent.tokenId);
  if (!outcome) return { ok: false, reason: `tokenId ${intent.tokenId} not in market` };

  const sizing = await checkAndSize(
    ctx,
    intent.conviction ?? 0,
    outcome.impliedProbability,
    intent.marketAddress,
    intent.tokenId,
  );
  if (!sizing.allowed || !sizing.usdtIn) return { ok: false, reason: sizing.reason ?? 'sizing rejected' };

  const built = await buildTrader(ctx.userId);
  if (!built) return { ok: false, reason: 'no usable BSC wallet for user' };
  const { trader, paperTrade } = built;

  // For live trades, snapshot the wallet's outcome-token balance before the buy
  // so we can compute the *actual* amount received from on-chain state instead
  // of an estimate. Paper-trade mode skips the read (balance is always 0n).
  let balanceBefore = 0n;
  if (!paperTrade) {
    try {
      balanceBefore = await trader.balanceOfOutcome(intent.marketAddress, intent.tokenId);
    } catch (err) {
      console.warn('[fortyTwoExecutor] balanceOfOutcome(before) failed:', (err as Error).message);
    }
  }

  // Slippage: require at least (usdtIn / entryPrice) * (1 - SLIPPAGE) tokens.
  // Paper-trade ignores the bound; live mode enforces it.
  const SLIPPAGE_BPS = 500; // 5%
  const expectedTokensFloat = sizing.usdtIn / outcome.impliedProbability;
  const minOtOut = paperTrade
    ? 0n
    : ethers.parseUnits(
        (expectedTokensFloat * (1 - SLIPPAGE_BPS / 10_000)).toFixed(6),
        18,
      );

  let receipt: TxReceiptLike = null;
  try {
    receipt = await trader.buyOutcome(
      intent.marketAddress,
      intent.tokenId,
      sizing.usdtIn.toString(),
      minOtOut,
    );
  } catch (err) {
    return { ok: false, reason: `buyOutcome failed: ${(err as Error).message}` };
  }
  const txHash = receiptHash(receipt);

  // Capture actual amount received in live mode via balance delta. In paper
  // mode we leave it null and downstream code falls back to usdtIn/entryPrice.
  let outcomeTokenAmountFloat: number | null = null;
  if (!paperTrade) {
    try {
      const balanceAfter = await trader.balanceOfOutcome(intent.marketAddress, intent.tokenId);
      const delta = balanceAfter - balanceBefore;
      if (delta > 0n) {
        outcomeTokenAmountFloat = Number(ethers.formatUnits(delta, 18));
      }
    } catch (err) {
      console.warn('[fortyTwoExecutor] balanceOfOutcome(after) failed:', (err as Error).message);
    }
  }

  const id = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `INSERT INTO "OutcomePosition"
       ("userId","agentId","marketAddress","marketTitle","tokenId","outcomeLabel",
        "usdtIn","entryPrice","status","paperTrade","txHashOpen","reasoning",
        "outcomeTokenAmount","providers")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10,$11,$12,$13::jsonb)
     RETURNING id`,
    ctx.userId,
    ctx.agentId,
    intent.marketAddress,
    market.question,
    intent.tokenId,
    outcome.label,
    sizing.usdtIn,
    outcome.impliedProbability,
    paperTrade,
    txHash,
    (intent.reasoning ?? '').slice(0, 500),
    outcomeTokenAmountFloat,
    providers ? JSON.stringify(providers) : null,
  );
  return { ok: true, positionId: id[0].id, paperTrade, usdtIn: sizing.usdtIn };
}

/**
 * Pull the most recent live (real on-chain) OPEN_PREDICTION position that has
 * per-provider swarm telemetry attached. This is the row /showcase renders
 * for the partnership demo. Falls back across users — the demo cares about
 * the swarm verdict + tx, not which user's wallet.
 */
export async function getMostRecentLiveSwarmPrediction(): Promise<OutcomePositionRow | null> {
  const rows = await db.$queryRawUnsafe<OutcomePositionRow[]>(
    `SELECT * FROM "OutcomePosition"
     WHERE "providers" IS NOT NULL
       AND "paperTrade" = false
       AND "txHashOpen" IS NOT NULL
       AND status = 'open'
     ORDER BY "openedAt" DESC
     LIMIT 1`,
  );
  return rows[0] ?? null;
}

/** Manually close (sell back to USDT). Settlement-by-resolution uses settleResolvedPositions instead. */
export async function closePredictionPosition(
  ctx: ExecutorContext,
  positionId: string,
): Promise<{ ok: true; pnl: number } | { ok: false; reason: string }> {
  const rows = await db.$queryRawUnsafe<OutcomePositionRow[]>(
    `SELECT * FROM "OutcomePosition" WHERE id = $1 AND "agentId" = $2 AND status = 'open' LIMIT 1`,
    positionId,
    ctx.agentId,
  );
  const pos = rows[0];
  if (!pos) return { ok: false, reason: 'position not found or not open' };

  let market: Market42;
  try {
    market = await getMarketByAddress(pos.marketAddress);
  } catch (err) {
    return { ok: false, reason: `market lookup failed: ${(err as Error).message}` };
  }

  const state = await readMarketOnchain(market);
  const outcome = state.outcomes.find((o) => o.tokenId === pos.tokenId);
  if (!outcome) return { ok: false, reason: 'outcome missing on chain' };

  // Honor the position's ORIGINAL execution mode — never let a current
  // user-toggle change cause a live position to close as paper (or vice versa).
  // The /predictions toggle gates *new* opens only.
  const built = await buildTrader(ctx.userId, pos.paperTrade);
  if (!built) return { ok: false, reason: 'no wallet' };
  const { trader, paperTrade } = built;

  // Sell amount: this position's *recorded* outcome-token amount (lot-based
  // accounting). Critically we do NOT sell the wallet's full balance for this
  // tokenId — that balance may include tokens from other open positions
  // (multiple agents per user, manual buys, etc) and selling it would
  // liquidate them too while only this DB row gets marked closed.
  //
  // In live mode we still cap by the on-chain balance (in case some tokens
  // were already redeemed/transferred out) so the sell can't revert with
  // insufficient balance. Paper-trade mode skips the on-chain read.
  let tokenAmt: bigint;
  if (paperTrade) {
    const estimateFloat = pos.outcomeTokenAmount ?? pos.usdtIn / pos.entryPrice;
    tokenAmt = ethers.parseUnits(estimateFloat.toFixed(6), 18);
  } else {
    if (!pos.outcomeTokenAmount || pos.outcomeTokenAmount <= 0) {
      // Live position with no recorded token amount → can't safely lot-account.
      // Bail rather than risk over-selling other positions' inventory.
      return {
        ok: false,
        reason: 'live position has no recorded outcomeTokenAmount; cannot safely close',
      };
    }
    const recorded = ethers.parseUnits(pos.outcomeTokenAmount.toFixed(6), 18);
    let walletBal: bigint;
    try {
      walletBal = await trader.balanceOfOutcome(pos.marketAddress, pos.tokenId);
    } catch (err) {
      return { ok: false, reason: `balanceOfOutcome failed: ${(err as Error).message}` };
    }
    tokenAmt = recorded < walletBal ? recorded : walletBal;
    if (tokenAmt === 0n) {
      return { ok: false, reason: 'wallet holds zero of this outcome token' };
    }
  }

  // Slippage: 5% below the marginal-price-implied USDT payout for live sells.
  const SLIPPAGE_BPS_SELL = 500;
  const tokensSoldFloat = Number(ethers.formatUnits(tokenAmt, 18));
  const expectedUsdtOut = tokensSoldFloat * outcome.impliedProbability;
  const minUsdtOut = paperTrade
    ? 0n
    : ethers.parseUnits(
        (expectedUsdtOut * (1 - SLIPPAGE_BPS_SELL / 10_000)).toFixed(6),
        18,
      );

  let receipt: TxReceiptLike = null;
  try {
    receipt = await trader.sellOutcome(pos.marketAddress, pos.tokenId, tokenAmt, minUsdtOut);
  } catch (err) {
    return { ok: false, reason: `sellOutcome failed: ${(err as Error).message}` };
  }
  const txHash = receiptHash(receipt);

  // Payout estimate: real implementation would read USDT balance delta. For
  // now, marginal price * tokens sold is the closest cheap approximation and
  // is consistent with how the bonding curve prices small fills.
  const payout = tokensSoldFloat * outcome.impliedProbability;
  const pnl = payout - pos.usdtIn;
  await db.$executeRawUnsafe(
    `UPDATE "OutcomePosition"
     SET status='closed', "exitPrice"=$1, "payoutUsdt"=$2, pnl=$3,
         "txHashClose"=$4, "closedAt"=NOW(), "paperTrade"=$5
     WHERE id=$6`,
    outcome.impliedProbability,
    payout,
    pnl,
    txHash,
    paperTrade,
    pos.id,
  );
  return { ok: true, pnl };
}

/**
 * Sweep open positions, settle any whose underlying market has finalised.
 * Winners get 1 USDT per outcome token (the bonding-curve invariant); losers
 * get 0. Called periodically by the agent runner — cheap because it only
 * fetches markets that have at least one open position.
 */
export async function settleResolvedPositions(opts: { agentId?: string; userId?: string } = {}): Promise<number> {
  const where: string[] = [`status = 'open'`];
  const args: unknown[] = [];
  if (opts.agentId) {
    args.push(opts.agentId);
    where.push(`"agentId" = $${args.length}`);
  }
  if (opts.userId) {
    args.push(opts.userId);
    where.push(`"userId" = $${args.length}`);
  }
  const open = await db.$queryRawUnsafe<OutcomePositionRow[]>(
    `SELECT * FROM "OutcomePosition" WHERE ${where.join(' AND ')}`,
    ...args,
  );
  if (open.length === 0) return 0;

  // Group by market to amortise the on-chain read.
  const byMarket = new Map<string, OutcomePositionRow[]>();
  for (const p of open) {
    if (!byMarket.has(p.marketAddress)) byMarket.set(p.marketAddress, []);
    byMarket.get(p.marketAddress)!.push(p);
  }

  let settled = 0;
  for (const [addr, positions] of byMarket) {
    let market: Market42;
    try {
      market = await getMarketByAddress(addr);
    } catch {
      continue;
    }
    let state;
    try {
      state = await readMarketOnchain(market);
    } catch {
      continue;
    }
    if (!state.isFinalised) continue;

    for (const pos of positions) {
      const win = isWinningTokenId(state.resolvedAnswer, pos.tokenId);
      // Token amount: use stored on-chain value if we captured it at open,
      // otherwise the entry-price estimate. Winners redeem 1:1 for USDT.
      const tokens = pos.outcomeTokenAmount ?? pos.usdtIn / pos.entryPrice;
      const payout = win ? tokens : 0;
      const pnl = payout - pos.usdtIn;
      const status = win ? 'resolved_win' : 'resolved_loss';
      await db.$executeRawUnsafe(
        `UPDATE "OutcomePosition"
         SET status=$1, "exitPrice"=$2, "payoutUsdt"=$3, pnl=$4, "closedAt"=NOW()
         WHERE id=$5`,
        status,
        win ? 1 : 0,
        payout,
        pnl,
        pos.id,
      );
      settled++;
    }
  }
  return settled;
}

/** True if user has explicitly opted in to live (non-paper) outcome trading. */
export async function isUserLiveOptedIn(userId: string): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<Array<{ fortyTwoLiveTrade: boolean }>>(
    `SELECT "fortyTwoLiveTrade" FROM "User" WHERE id = $1 LIMIT 1`,
    userId,
  );
  return rows[0]?.fortyTwoLiveTrade === true;
}

export async function setUserLiveOptIn(userId: string, enabled: boolean): Promise<void> {
  await db.$executeRawUnsafe(
    `UPDATE "User" SET "fortyTwoLiveTrade" = $1 WHERE id = $2`,
    enabled,
    userId,
  );
}

export async function listUserPositions(userId: string, limit = 25): Promise<OutcomePositionRow[]> {
  return db.$queryRawUnsafe<OutcomePositionRow[]>(
    `SELECT * FROM "OutcomePosition" WHERE "userId" = $1
     ORDER BY "openedAt" DESC LIMIT $2`,
    userId,
    limit,
  );
}

/**
 * List open positions for an agent. Used by the trading prompt builder so
 * Claude can issue grounded `CLOSE_PREDICTION` decisions referencing real
 * position IDs (not hallucinated ones).
 */
export async function listOpenAgentPositions(agentId: string): Promise<OutcomePositionRow[]> {
  return db.$queryRawUnsafe<OutcomePositionRow[]>(
    `SELECT * FROM "OutcomePosition"
     WHERE "agentId" = $1 AND status = 'open'
     ORDER BY "openedAt" DESC`,
    agentId,
  );
}
