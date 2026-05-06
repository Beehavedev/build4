import { ethers } from 'ethers';
import { db } from '../db';
import { decryptPrivateKey } from './wallet';
import { FortyTwoTrader, type DryRunReceipt } from './fortyTwoTrader';
import { readMarketOnchain, isWinningTokenId, quoteRedeemValue } from './fortyTwoOnchain';
import type { Market42 } from './fortyTwo';
import { getMarketByAddress } from './fortyTwo';

/**
 * The narrow trader surface the executor actually invokes. Defined as a
 * structural interface (not a class) so the test seam below can accept any
 * implementation that satisfies these three methods — no class inheritance
 * or type-escape casts required.
 */
/**
 * Translate raw ethers/RPC errors from a buyOutcome / sellOutcome call into
 * a message that's safe to surface in the mini-app trade panel.
 *
 * The most common opaque failure we see in production is
 *   "cannot slice beyond data bounds (buffer=0x, length=0, offset=4,
 *    code=BUFFER_OVERRUN, version=6.16.0)"
 * which is ethers v6 trying to decode revert data from an empty `0x`
 * eth_call response. In practice that means either (a) the public BSC RPC
 * dropped the call under load, or (b) the contract reverted silently with
 * no revert string. Either way the raw text is gibberish to a non-dev user.
 *
 * Keep the original message available for server logs (we still console.log
 * the full err in callers); the return value is just for the API response.
 */
function friendlyTraderError(err: unknown, op: 'buyOutcome' | 'sellOutcome' | 'claimAllResolved'): string {
  const raw = (err as Error)?.message || String(err);
  if (raw.includes('BUFFER_OVERRUN') || raw.includes('cannot slice beyond data bounds')) {
    return `${op} failed: BSC RPC returned no data (likely public-RPC throttling or a silent contract revert). Try again in a moment; if it persists, set BSC_RPC_URL to a paid endpoint.`;
  }
  if (raw.includes('insufficient funds')) {
    return `${op} failed: not enough BNB for gas in your trading wallet.`;
  }
  if (raw.includes('CALL_EXCEPTION') || raw.includes('execution reverted')) {
    // Surface the actual revert reason — the generic "slippage / market closed
    // / allowance" hint was masking real diagnostics in production. Trim to
    // ~240 chars so the message stays UI-readable.
    const trimmed = raw.length > 240 ? raw.slice(0, 240) + '…' : raw;
    return `${op} failed: on-chain call reverted — ${trimmed}`;
  }
  return `${op} failed: ${raw}`;
}

/**
 * Map a raw sellOutcome failure (already passed through extractRevertReason)
 * into a one-line user-facing message + an actionable hint. Matches against
 * the friendly suffixes embedded by KNOWN_CUSTOM_ERRORS in fortyTwoTrader.ts
 * so we never depend on selector hex.
 *
 * Returned `code` is a stable identifier the UI can switch on (e.g. to
 * disable the Sell button and offer Claim instead once the market ends).
 */
export function friendlySellError(raw: string): { code: string; message: string; hint?: string } {
  const r = (raw || '').toLowerCase();

  // Trading window closed — most common case for stuck positions. The user
  // can no longer sell; they wait for resolution then Claim.
  if (r.includes('marketended') || r.includes('marketclosed') || r.includes('marketfinalised')) {
    return {
      code: 'market_ended',
      message: "This market has stopped trading.",
      hint: "It will settle automatically once the result is final. If your prediction wins, the payout will appear in your wallet.",
    };
  }
  if (r.includes('marketresolved')) {
    return {
      code: 'market_resolved',
      message: "This market has settled.",
      hint: "Tap Claim to collect any winnings.",
    };
  }
  if (r.includes('slippageexceeded')) {
    return {
      code: 'slippage',
      message: "The price moved while we were preparing your order.",
      hint: "Please try again — markets like this one can re-price within seconds.",
    };
  }
  if (r.includes('insufficientliquidity')) {
    return {
      code: 'no_liquidity',
      message: "There isn't enough depth to fill this size right now.",
      hint: "Try a smaller amount, or wait for the market to settle and use Claim.",
    };
  }
  if (r.includes('insufficientbalance')) {
    return {
      code: 'no_balance',
      message: "This position can't be closed right now.",
      hint: "Pull down to refresh. If it stays here after refreshing, please contact support and we'll take a look.",
    };
  }
  if (r.includes('safe6909transfer') || r.includes('notoperator')) {
    return {
      code: 'router_approval',
      message: "Setting up your wallet for selling — please try again.",
      hint: "First-time sells need a quick one-time setup. Tap Sell again in about 15 seconds.",
    };
  }
  if (r.includes('paused')) {
    return {
      code: 'paused',
      message: "Trading is paused on this market.",
      hint: "Please try again later. If the market settles while paused, you'll still be able to claim.",
    };
  }
  if (r.includes('insufficient funds') || r.includes('insufficient_funds')) {
    return {
      code: 'no_gas',
      message: "Your trading wallet needs a small amount of BNB to cover network fees.",
      hint: "Send around 0.001 BNB to your wallet address shown on the Wallet tab, then try again.",
    };
  }
  if (r.includes('buffer_overrun') || r.includes('cannot slice beyond data bounds')) {
    return {
      code: 'rpc_flake',
      message: "The network is busy right now.",
      hint: "Please try again in about 10 seconds.",
    };
  }

  // Fallback: don't leak raw chain errors to users. Log details server-side
  // (already happens upstream via console.error in the caller) and show a
  // calm, actionable message.
  return {
    code: 'unknown',
    message: "We couldn't close this position.",
    hint: "Please try again in a moment. If this keeps happening, contact support and we'll investigate.",
  };
}

export interface ExecutorTrader {
  buyOutcome(
    marketAddress: string,
    tokenId: number,
    usdtAmountIn: string,
    minOtOut?: bigint,
  ): Promise<ethers.TransactionReceipt | DryRunReceipt | null>;
  sellOutcome(
    marketAddress: string,
    tokenId: number,
    tokenAmountIn: bigint,
    minUsdtOut?: bigint,
  ): Promise<ethers.TransactionReceipt | DryRunReceipt | null>;
  balanceOfOutcome(marketAddress: string, tokenId: number): Promise<bigint>;
  // Used by user-initiated claim flow (claimUserResolvedForMarket).
  // Optional only because some unit-test stubs predate the claim methods —
  // production callers always go through FortyTwoTrader which implements it.
  claimAllResolved?(marketAddress: string): Promise<ethers.TransactionReceipt | null>;
}

export type ExecutorTraderCtor = new (
  pk: string,
  rpc: string,
  opts: { dryRun: boolean },
) => ExecutorTrader;

export interface ExecutorDeps {
  getMarketByAddress: typeof getMarketByAddress;
  readMarketOnchain: typeof readMarketOnchain;
  isWinningTokenId: typeof isWinningTokenId;
  decryptPrivateKey: typeof decryptPrivateKey;
  FortyTwoTraderCtor: ExecutorTraderCtor;
}

/**
 * Dependency seam for unit tests. Production code goes through this object
 * so the SQL-shape tests in __tests__/fortyTwoExecutorSql.test.ts can swap
 * out market/wallet/trader access without round-tripping to the BSC RPC or
 * needing a real encrypted PK on disk. Do NOT use from production callers —
 * import the underlying functions directly instead.
 *
 * `FortyTwoTrader` structurally satisfies `ExecutorTraderCtor` — the three
 * methods on `ExecutorTrader` are a subset of the class's public API.
 */
export const __testDeps: ExecutorDeps = {
  getMarketByAddress,
  readMarketOnchain,
  isWinningTokenId,
  decryptPrivateKey,
  FortyTwoTraderCtor: FortyTwoTrader,
};

const BSC_RPC = process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org';

// ── Sizing rules — outcome-token positions are explicitly smaller than the
// agent's perp budget. Bonding-curve markets are illiquid; oversizing causes
// massive slippage and resolution risk is binary, so we cap aggressively.
export const PRED_PER_POSITION_USDT_CAP = 2;       // hard ceiling per market
export const PRED_AGENT_BUDGET_PCT = 0.10;         // ≤10% of agent.maxPositionSize
export const PRED_MAX_OPEN_PER_AGENT = 5;          // simultaneous open positions
export const PRED_MAX_NEW_PER_AGENT_PER_DAY = 3;   // bound velocity / cost

// ── Campaign-mode caps (BUILD4 × 42.space "Agent vs Community" 48h sprint) ──
// Lifted ONLY for the dedicated campaign agent identified by env
// FT_CAMPAIGN_AGENT_ID. Every other agent in the system continues to trade
// under the conservative defaults above. The split is intentional: campaign
// rules need $50 entries and 4 ticks/round, but the broker-mode default for
// regular users must stay defensive ($2 cap, 3/day, 5 open) so a stray
// signal can never drain a normal user's wallet.
export const PRED_CAMPAIGN_PER_POSITION_USDT_CAP = 50;
export const PRED_CAMPAIGN_AGENT_BUDGET_PCT = 0.50;
export const PRED_CAMPAIGN_MAX_OPEN_PER_AGENT = 12;
export const PRED_CAMPAIGN_MAX_NEW_PER_AGENT_PER_DAY = 8;

interface PredictionCaps {
  perPositionUsdtCap: number;
  agentBudgetPct: number;
  maxOpenPerAgent: number;
  maxNewPerAgentPerDay: number;
  isCampaign: boolean;
}

/** True when the given agentId is the dedicated 42.space campaign agent. */
export function isCampaignAgent(agentId: string | null | undefined): boolean {
  if (process.env.FT_CAMPAIGN_MODE !== 'true') return false;
  const id = process.env.FT_CAMPAIGN_AGENT_ID;
  return !!id && !!agentId && agentId === id;
}

/** Returns the sizing caps appropriate for the given agent. Campaign agent
 *  gets the lifted caps; everyone else gets the default broker-mode caps. */
export function capsFor(agentId: string | null | undefined): PredictionCaps {
  if (isCampaignAgent(agentId)) {
    return {
      perPositionUsdtCap: PRED_CAMPAIGN_PER_POSITION_USDT_CAP,
      agentBudgetPct: PRED_CAMPAIGN_AGENT_BUDGET_PCT,
      maxOpenPerAgent: PRED_CAMPAIGN_MAX_OPEN_PER_AGENT,
      maxNewPerAgentPerDay: PRED_CAMPAIGN_MAX_NEW_PER_AGENT_PER_DAY,
      isCampaign: true,
    };
  }
  return {
    perPositionUsdtCap: PRED_PER_POSITION_USDT_CAP,
    agentBudgetPct: PRED_AGENT_BUDGET_PCT,
    maxOpenPerAgent: PRED_MAX_OPEN_PER_AGENT,
    maxNewPerAgentPerDay: PRED_MAX_NEW_PER_AGENT_PER_DAY,
    isCampaign: false,
  };
}

export interface PredictionTradeIntent {
  action: 'OPEN_PREDICTION' | 'CLOSE_PREDICTION';
  marketAddress: string;
  tokenId: number;
  outcomeLabel?: string;
  /** Agent's own probability estimate, 0..1 — must beat implied price by ≥0.05. */
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

async function loadUserWalletPK(
  userId: string,
  agentId?: string | null,
): Promise<UserWalletPK | null> {
  // Campaign-mode (Path A): if the agent has a dedicated walletId pinned,
  // load that specific Wallet row instead of the user's primary BSC wallet.
  // Keeps the campaign agent's trade history isolated from the user's main
  // wallet — important for the 42.space leaderboard story.
  if (agentId) {
    try {
      const agentRows = await db.$queryRawUnsafe<Array<{ walletId: string | null }>>(
        `SELECT "walletId" FROM "Agent" WHERE id = $1 LIMIT 1`,
        agentId,
      );
      const pinnedWalletId = agentRows[0]?.walletId;
      if (pinnedWalletId) {
        const w = await db.wallet.findFirst({
          where: { id: pinnedWalletId, userId, chain: 'BSC' },
        });
        if (!w?.encryptedPK) return null;
        try {
          const pk = __testDeps.decryptPrivateKey(w.encryptedPK, userId);
          if (!pk?.startsWith('0x')) return null;
          return { address: w.address, privateKey: pk };
        } catch {
          return null;
        }
      }
    } catch (err) {
      // Pre-migration boot or transient DB issue — fall through to default
      // wallet so existing agents keep trading rather than going dark.
      console.warn('[fortyTwoExecutor] agent.walletId lookup failed:', (err as Error).message);
    }
  }
  const wallet = await db.wallet.findFirst({
    where: { userId, chain: 'BSC', isActive: true },
  });
  if (!wallet?.encryptedPK) return null;
  try {
    const pk = __testDeps.decryptPrivateKey(wallet.encryptedPK, userId);
    if (!pk?.startsWith('0x')) return null;
    return { address: wallet.address, privateKey: pk };
  } catch {
    return null;
  }
}

/**
 * Returns a configured trader, OR null if the user can't trade right now.
 *
 * Three paths:
 * 1. NEW open (forcePaperTrade=undefined) — also enforces the per-user
 *    enable-trading kill switch (User.fortyTwoLiveTrade). When the user
 *    has trading disabled we return null and the caller surfaces a
 *    "trading disabled" error to the UI. NO paper fallback — disabled
 *    means disabled.
 * 2. Closing/settling an EXISTING live position (forcePaperTrade=false) —
 *    bypasses the kill switch so users can always exit a live position
 *    they already opened. They just can't open new ones while disabled.
 * 3. Closing/settling an EXISTING paper position (forcePaperTrade=true) —
 *    legacy path. Returns a dry-run trader so the row settles without
 *    touching chain state.
 */
async function buildTrader(
  userId: string,
  forcePaperTrade?: boolean,
  agentId?: string | null,
): Promise<{ trader: ExecutorTrader; paperTrade: boolean } | null> {
  const wallet = await loadUserWalletPK(userId, agentId);
  if (!wallet) return null;
  let paperTrade: boolean;
  if (typeof forcePaperTrade === 'boolean') {
    paperTrade = forcePaperTrade;
  } else {
    // NEW open path — enforce per-user enable kill switch.
    const rows = await db.$queryRawUnsafe<Array<{ fortyTwoLiveTrade: boolean }>>(
      `SELECT "fortyTwoLiveTrade" FROM "User" WHERE id = $1 LIMIT 1`,
      userId,
    );
    const enabled = rows[0]?.fortyTwoLiveTrade === true;
    if (!enabled) return null; // user has 42.space trading disabled
    paperTrade = false;
  }
  const trader = new __testDeps.FortyTwoTraderCtor(wallet.privateKey, BSC_RPC, { dryRun: paperTrade });
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
  if (edge < 0.05) {
    return { allowed: false, reason: `edge ${(edge * 100).toFixed(1)}% < 5% threshold` };
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

  // Per-agent caps — campaign agent gets lifted limits ($50/pos, 8/day, 12 open,
  // 50% budget); every other agent stays on the conservative broker defaults.
  const caps = capsFor(ctx.agentId);

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const opensToday = await db.$queryRawUnsafe<Array<{ c: bigint }>>(
    `SELECT count(*)::bigint AS c FROM "OutcomePosition"
     WHERE "agentId" = $1 AND "openedAt" > $2`,
    ctx.agentId,
    dayAgo,
  );
  if (Number(opensToday[0]?.c ?? 0) >= caps.maxNewPerAgentPerDay) {
    return { allowed: false, reason: 'daily prediction-trade quota reached' };
  }

  const openCount = await db.$queryRawUnsafe<Array<{ c: bigint }>>(
    `SELECT count(*)::bigint AS c FROM "OutcomePosition"
     WHERE "agentId" = $1 AND status = 'open'`,
    ctx.agentId,
  );
  if (Number(openCount[0]?.c ?? 0) >= caps.maxOpenPerAgent) {
    return { allowed: false, reason: 'max simultaneous prediction positions reached' };
  }

  // Position size scales with edge, capped by both per-position and per-agent
  // rules. agentCap is a HARD ceiling: if it can't even fund the minimum
  // order, the trade is rejected (we never silently exceed the budget cap).
  const edgeScaled = Math.min(1, edge / 0.30) * caps.perPositionUsdtCap; // 30% edge = full cap
  const agentCap = ctx.agentMaxPositionSize * caps.agentBudgetPct;
  const sized = Math.min(edgeScaled, caps.perPositionUsdtCap, agentCap);
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
 * The shape matches the Task #18 spec plus the Task #24 input/output split:
 * `provider`, `model`, `action`, optional `predictionTrade`, `reasoning`,
 * `latencyMs`, `inputTokens`, `outputTokens`, `tokensUsed`.
 */
export interface ProviderTelemetry {
  provider: string;
  model: string;
  action: string | null;
  /** Mirrors the LLM-emitted predictionTrade sidecar (or null when none). */
  predictionTrade?: unknown;
  reasoning: string | null;
  latencyMs: number;
  /** Prompt/input tokens billed by the provider for this call. */
  inputTokens: number;
  /** Completion/output tokens billed by the provider for this call. */
  outputTokens: number;
  /** Sum of input + output. Retained so older tooling that reads `tokensUsed` still works. */
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

  // Per-user kill switch — agent-driven opens respect the same toggle as
  // manual trades. Closes/settles bypass this check via forcePaperTrade so
  // existing positions can always be exited.
  const enabled = await isUserLiveOptedIn(ctx.userId);
  if (!enabled) {
    return { ok: false, reason: '42.space trading disabled by user' };
  }

  let market: Market42;
  try {
    market = await __testDeps.getMarketByAddress(intent.marketAddress);
  } catch (err) {
    return { ok: false, reason: `market lookup failed: ${(err as Error).message}` };
  }
  if (market.status !== 'live') return { ok: false, reason: `market not live (${market.status})` };

  let state;
  try {
    state = await __testDeps.readMarketOnchain(market);
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

  // Pass agentId so campaign-mode opens use the agent's pinned wallet, not
  // the user's primary BSC wallet. Manual/non-agent paths leave it null.
  const built = await buildTrader(ctx.userId, undefined, ctx.agentId);
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
    console.error('[fortyTwoExecutor] buyOutcome (agent path) failed:', err);
    return { ok: false, reason: friendlyTraderError(err, 'buyOutcome') };
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
       ("id","userId","agentId","marketAddress","marketTitle","tokenId","outcomeLabel",
        "usdtIn","entryPrice","status","paperTrade","txHashOpen","reasoning",
        "outcomeTokenAmount","providers")
     VALUES (gen_random_uuid()::text,$1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10,$11,$12,$13::jsonb)
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

// ── Manual user-initiated trade bounds ─────────────────────────────────────
// Manual trades come from a user explicitly tapping "Place trade" in the
// mini-app on a market scanner row. They bypass the swarm/conviction gating
// (the user IS the conviction) but still need protective caps:
//   - MANUAL_MIN_USDT: same dust floor as PRED_MIN_USDT_IN — bonding-curve
//     contracts reject smaller orders.
//   - MANUAL_MAX_USDT: fat-finger guard. A user's whole BSC balance might
//     be $5–$50; we cap one click at $25 so a stray keystroke can't drain
//     the wallet on a single bad market.
//   - MANUAL_MAX_OPEN_PER_USER: total simultaneous open manual positions.
//     Keeps the dashboard readable and bounds resolution-claim work.
//   - MANUAL_MAX_NEW_PER_USER_PER_DAY: rate limit against
//     compromised-account or bot-key drain scenarios; 20 manual opens/day
//     is generous for a real user but bounds the blast radius.
export const MANUAL_MIN_USDT = PRED_MIN_USDT_IN;
export const MANUAL_MAX_USDT = 25;
export const MANUAL_MAX_OPEN_PER_USER = 10;
export const MANUAL_MAX_NEW_PER_USER_PER_DAY = 20;

export interface ManualTradeInput {
  userId: string;
  marketAddress: string;
  tokenId: number;
  usdtAmount: number;
}

export type ManualTradeResult =
  | {
      ok: true;
      positionId: string;
      paperTrade: boolean;
      txHash: string | null;
      usdtIn: number;
      outcomeLabel: string;
      entryPrice: number;
    }
  | { ok: false; reason: string };

/**
 * Open an outcome-token position from an explicit user-initiated trade
 * (e.g. tapping a "Place trade" button in the mini-app market scanner).
 *
 * This is intentionally NOT routed through `openPredictionPosition`:
 *   - That function gates on `conviction - impliedProbability ≥ 5%` —
 *     correct for autonomous agents but wrong for a user who has already
 *     decided to trade. The user's tap IS the conviction.
 *   - That function's quotas key on `agentId`. Manual trades have no agent
 *     so we apply parallel quotas keyed on `userId`.
 *
 * The on-chain mechanics (slippage, balance-delta accounting,
 * paper-vs-live opt-in toggle, OutcomePosition row insert) are the same so
 * downstream readers — /api/predictions/latest, listUserPositions,
 * settleResolvedPositions — work unchanged. The row's `agentId` is left
 * NULL and `providers` is NULL (no swarm vote drove this trade).
 */
export async function openManualPredictionPosition(
  input: ManualTradeInput,
): Promise<ManualTradeResult> {
  const { userId, marketAddress, tokenId, usdtAmount } = input;

  if (!Number.isFinite(usdtAmount)) return { ok: false, reason: 'invalid amount' };
  if (usdtAmount < MANUAL_MIN_USDT) {
    return { ok: false, reason: `amount $${usdtAmount} below minimum $${MANUAL_MIN_USDT}` };
  }
  if (usdtAmount > MANUAL_MAX_USDT) {
    return { ok: false, reason: `amount $${usdtAmount} above per-trade cap $${MANUAL_MAX_USDT}` };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(marketAddress)) {
    return { ok: false, reason: 'invalid market address' };
  }

  // Per-user kill switch — short-circuit before we burn DB cycles on quota
  // checks if the user has 42.space trading turned off entirely.
  const enabled = await isUserLiveOptedIn(userId);
  if (!enabled) {
    return { ok: false, reason: '42.space trading is disabled — enable it in the Predictions tab to start trading' };
  }

  // Per-user serialization via Postgres TRANSACTION-SCOPED advisory lock.
  //
  // Earlier we used session-scoped pg_try_advisory_lock + manual unlock in a
  // finally block. That has a brutal interaction with Prisma's connection
  // pool: the acquire and release can land on different pooled connections,
  // so the unlock becomes a no-op while the original connection keeps the
  // lock held — forever, until that connection gets recycled. Symptom in
  // production was "another manual trade is already in flight" persisting
  // indefinitely for a user after one failed trade.
  //
  // pg_try_advisory_xact_lock is automatically released when the surrounding
  // transaction ends (commit, rollback, or connection drop). Wrapping the
  // entire flow in db.$transaction pins to a single connection AND
  // guarantees lock cleanup regardless of what goes wrong inside. The 60s
  // timeout matches our typical worst-case BSC tx confirmation window;
  // anything longer indicates the chain call itself is wedged and we'd
  // rather fail loudly than hold the lock forever.
  const lockKey = hashStringToInt32(`manual-trade:${userId}`);
  return await db.$transaction(
    async (tx) => {
      const lockRows = await tx.$queryRawUnsafe<Array<{ acquired: boolean }>>(
        `SELECT pg_try_advisory_xact_lock($1)::boolean AS acquired`,
        lockKey,
      );
      if (!lockRows[0]?.acquired) {
        return { ok: false, reason: 'another manual trade is already in flight — retry in a moment' };
      }

      // Per-user simultaneous-open cap.
      const openCount = await tx.$queryRawUnsafe<Array<{ c: bigint }>>(
        `SELECT count(*)::bigint AS c FROM "OutcomePosition"
         WHERE "userId" = $1 AND "agentId" IS NULL AND status = 'open'`,
        userId,
      );
      if (Number(openCount[0]?.c ?? 0) >= MANUAL_MAX_OPEN_PER_USER) {
        return {
          ok: false,
          reason: `max ${MANUAL_MAX_OPEN_PER_USER} open manual positions reached`,
        };
      }

      // Per-user daily open-rate cap.
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const opensToday = await tx.$queryRawUnsafe<Array<{ c: bigint }>>(
        `SELECT count(*)::bigint AS c FROM "OutcomePosition"
         WHERE "userId" = $1 AND "agentId" IS NULL AND "openedAt" > $2`,
        userId,
        dayAgo,
      );
      if (Number(opensToday[0]?.c ?? 0) >= MANUAL_MAX_NEW_PER_USER_PER_DAY) {
        return { ok: false, reason: 'daily manual-trade quota reached' };
      }
      return await runManualTradeUnderLock();
    },
    { timeout: 60_000, maxWait: 5_000 },
  );

  // Inner function isolates the post-lock work so we can `return` cleanly
  // without losing the finally-block unlock. Hoisted, so the call above
  // reaches it even though it's declared further down.
  async function runManualTradeUnderLock(): Promise<ManualTradeResult> {
    // Resolve market + on-chain outcome state.
    let market: Market42;
    try {
      market = await __testDeps.getMarketByAddress(marketAddress);
    } catch (err) {
      return { ok: false, reason: `market lookup failed: ${(err as Error).message}` };
    }
    if (market.status !== 'live') {
      return { ok: false, reason: `market not live (${market.status})` };
    }

    let state;
    try {
      state = await __testDeps.readMarketOnchain(market);
    } catch (err) {
      return { ok: false, reason: `on-chain read failed: ${(err as Error).message}` };
    }
    const outcome = state.outcomes.find((o) => o.tokenId === tokenId);
    if (!outcome) return { ok: false, reason: `tokenId ${tokenId} not in market` };

    // Build the trader (paper vs live driven by user's existing opt-in toggle).
    const built = await buildTrader(userId);
    if (!built) return { ok: false, reason: 'no usable BSC wallet for user' };
    const { trader, paperTrade } = built;

    // Snapshot pre-trade balance so we can compute actual tokens received from
    // on-chain delta (same approach as openPredictionPosition).
    let balanceBefore = 0n;
    if (!paperTrade) {
      try {
        balanceBefore = await trader.balanceOfOutcome(marketAddress, tokenId);
      } catch (err) {
        console.warn('[manualPrediction] balanceOfOutcome(before) failed:', (err as Error).message);
      }
    }

    // Same 5% slippage bound as agent path.
    const SLIPPAGE_BPS = 500;
    const expectedTokensFloat = usdtAmount / outcome.impliedProbability;
    const minOtOut = paperTrade
      ? 0n
      : ethers.parseUnits(
          (expectedTokensFloat * (1 - SLIPPAGE_BPS / 10_000)).toFixed(6),
          18,
        );

    let receipt: TxReceiptLike = null;
    try {
      receipt = await trader.buyOutcome(marketAddress, tokenId, usdtAmount.toString(), minOtOut);
    } catch (err) {
      console.error('[fortyTwoExecutor] buyOutcome (manual path) failed:', err);
      return { ok: false, reason: friendlyTraderError(err, 'buyOutcome') };
    }
    const txHash = receiptHash(receipt);

    let outcomeTokenAmountFloat: number | null = null;
    if (!paperTrade) {
      try {
        const balanceAfter = await trader.balanceOfOutcome(marketAddress, tokenId);
        const delta = balanceAfter - balanceBefore;
        if (delta > 0n) outcomeTokenAmountFloat = Number(ethers.formatUnits(delta, 18));
      } catch (err) {
        console.warn('[manualPrediction] balanceOfOutcome(after) failed:', (err as Error).message);
      }
    }

    // Orphan-position safety net: if the on-chain buy succeeded but the DB
    // insert fails (e.g. transient Postgres outage), the user holds outcome
    // tokens with no row tracking them — they wouldn't appear in the
    // portfolio and settle/close paths would never fire on them. We can't
    // atomically couple a chain tx to a DB insert, but we CAN turn the
    // failure into a loud, structured log line that operators can grep for
    // and reconcile manually using the txHash.
    let idRows: Array<{ id: string }>;
    try {
      idRows = await db.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "OutcomePosition"
           ("id","userId","agentId","marketAddress","marketTitle","tokenId","outcomeLabel",
            "usdtIn","entryPrice","status","paperTrade","txHashOpen","reasoning",
            "outcomeTokenAmount","providers")
         VALUES (gen_random_uuid()::text,$1,NULL,$2,$3,$4,$5,$6,$7,'open',$8,$9,$10,$11,NULL)
         RETURNING id`,
        userId,
        marketAddress,
        market.question,
        tokenId,
        outcome.label,
        usdtAmount,
        outcome.impliedProbability,
        paperTrade,
        txHash,
        'Manual trade from mini-app',
        outcomeTokenAmountFloat,
      );
    } catch (err) {
      console.error(
        '[manualPrediction][ORPHAN_POSITION] DB insert failed AFTER on-chain buy succeeded.',
        'Manual reconciliation required.',
        JSON.stringify({
          userId, marketAddress, tokenId, outcomeLabel: outcome.label,
          usdtIn: usdtAmount, paperTrade, txHash,
          outcomeTokenAmount: outcomeTokenAmountFloat,
          insertError: (err as Error).message,
        }),
      );
      return {
        ok: false,
        reason: paperTrade
          ? `failed to record paper trade: ${(err as Error).message}`
          : `trade sent on-chain (tx ${txHash ?? 'unknown'}) but DB insert failed — contact support`,
      };
    }

    return {
      ok: true,
      positionId: idRows[0].id,
      paperTrade,
      txHash,
      usdtIn: usdtAmount,
      outcomeLabel: outcome.label,
      entryPrice: outcome.impliedProbability,
    };
  }
}

// Stable 32-bit signed-integer hash of a string for pg_advisory_lock keys.
// Uses the same FNV-1a variant we already rely on elsewhere; output fits
// in int4 which is what pg_advisory_lock expects when called with one arg.
function hashStringToInt32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

/**
 * Pull the most recent live (real on-chain) open prediction position.
 * Used to populate the Predictions hero card / showcase.
 *
 * Originally this required `providers IS NOT NULL` so we'd only ever surface
 * swarm-driven trades. In practice the agents produce OPEN_PREDICTION
 * extremely rarely (HOLD dominates), so the hero card was almost always
 * empty even though plenty of live (non-paper) trades existed via the manual
 * buy path. We relax the filter to ANY live open position; rows with swarm
 * telemetry render full per-provider verdicts, rows without render with
 * agentCount=0 (the API mapper already handles both cases).
 *
 * Preference order so swarm rows still win when they exist:
 *   1. Most recent live open with providers attached (real swarm trade)
 *   2. Most recent live open of any kind (manual buy)
 */
export async function getMostRecentLiveSwarmPrediction(): Promise<OutcomePositionRow | null> {
  const swarmFirst = await db.$queryRawUnsafe<OutcomePositionRow[]>(
    `SELECT * FROM "OutcomePosition"
     WHERE "providers" IS NOT NULL
       AND "paperTrade" = false
       AND "txHashOpen" IS NOT NULL
       AND status = 'open'
     ORDER BY "openedAt" DESC
     LIMIT 1`,
  );
  if (swarmFirst[0]) return swarmFirst[0];

  const anyLive = await db.$queryRawUnsafe<OutcomePositionRow[]>(
    `SELECT * FROM "OutcomePosition"
     WHERE "paperTrade" = false
       AND "txHashOpen" IS NOT NULL
       AND status = 'open'
     ORDER BY "openedAt" DESC
     LIMIT 1`,
  );
  return anyLive[0] ?? null;
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
    market = await __testDeps.getMarketByAddress(pos.marketAddress);
  } catch (err) {
    return { ok: false, reason: `market lookup failed: ${(err as Error).message}` };
  }

  const state = await __testDeps.readMarketOnchain(market);
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
  const sellAmt = await resolveSellAmount({
    pos,
    paperTrade,
    trader,
    isAgentPath: true,
  });
  if (!sellAmt.ok) return sellAmt;
  const tokenAmt = sellAmt.tokenAmt;

  const sellQuote = await computeSellMinOut({
    paperTrade,
    marketAddress: pos.marketAddress,
    curveAddress: market.curve,
    tokenId: pos.tokenId,
    tokenAmt,
    impliedProbability: outcome.impliedProbability,
  });
  const { minUsdtOut, expectedPayoutFloat, exitPriceFloat } = sellQuote;

  let receipt: TxReceiptLike = null;
  try {
    receipt = await trader.sellOutcome(pos.marketAddress, pos.tokenId, tokenAmt, minUsdtOut);
  } catch (err) {
    const friendly = friendlySellError((err as Error).message);
    return {
      ok: false,
      reason: friendly.message,
      hint: friendly.hint,
      code: friendly.code,
    } as { ok: false; reason: string; hint?: string; code?: string };
  }
  const txHash = receiptHash(receipt);

  // Source of truth for what the user actually received: the receipt's
  // USDT Transfer to the user's wallet. The curve quote is only the
  // pre-trade promise (used for slippage). Falls back to the quote in
  // paper-trade mode (no real receipt) or if log parsing fails.
  const recipient = (trader as any)?.wallet?.address as string | undefined;
  const onchainPayout = paperTrade ? null : parseUsdtInflowFromReceipt(receipt, recipient);
  const realisedPayout = onchainPayout ?? expectedPayoutFloat;
  const pnl = realisedPayout - pos.usdtIn;
  await db.$executeRawUnsafe(
    `UPDATE "OutcomePosition"
     SET status='closed', "exitPrice"=$1, "payoutUsdt"=$2, pnl=$3,
         "txHashClose"=$4, "closedAt"=NOW(), "paperTrade"=$5
     WHERE id=$6`,
    exitPriceFloat,
    realisedPayout,
    pnl,
    txHash,
    paperTrade,
    pos.id,
  );
  return { ok: true, pnl };
}

/**
 * Compute the minUsdtOut to pass to `sellOutcome` plus the float values we
 * record on the closed position row.
 *
 * Strategy: ask the bonding curve directly for the exact post-fee USDT
 * payout via `quoteRedeemValue` (staticCall on
 * `IFTCurve.calRedeemValueByOtDelta`). When the quote succeeds we apply a
 * tight 5% slippage tolerance on that exact number — enough to absorb a
 * small price drift between staticCall and the broadcast tx, without
 * giving sandwich-MEV a useful margin.
 *
 * When the quote fails (RPC down, exotic curve, market closed mid-quote)
 * we fall back to the previous behaviour: marginal-price * tokens with a
 * generous 30% buffer. The marginal-price estimate over-states actual
 * payout on partial exits because price walks down the curve as you sell,
 * so the wider buffer is needed to keep the close from reverting.
 *
 * Paper-trade mode always returns minUsdtOut=0n — there's no on-chain
 * settlement to protect against.
 */
async function computeSellMinOut(args: {
  paperTrade: boolean;
  marketAddress: string;
  curveAddress: string;
  tokenId: number;
  tokenAmt: bigint;
  impliedProbability: number;
}): Promise<{ minUsdtOut: bigint; expectedPayoutFloat: number; exitPriceFloat: number }> {
  const { paperTrade, marketAddress, curveAddress, tokenId, tokenAmt, impliedProbability } = args;

  if (paperTrade) {
    const tokensFloat = Number(ethers.formatUnits(tokenAmt, 18));
    return {
      minUsdtOut: 0n,
      expectedPayoutFloat: tokensFloat * impliedProbability,
      exitPriceFloat: impliedProbability,
    };
  }

  // Tight 5% slippage on the exact curve quote — covers small price drift
  // between staticCall and broadcast. Anything more would just leak value
  // to sandwichers without unblocking real reverts.
  const SLIPPAGE_BPS_QUOTE = 500;
  // Wide 30% slippage on the legacy marginal-price estimate. The estimate
  // overstates payout on partial exits because price walks down the curve;
  // 30% is what we used to ship before the exact-quote path landed and is
  // empirically wide enough for thin pools.
  const SLIPPAGE_BPS_FALLBACK = 3000;

  const quoted = await quoteRedeemValue(marketAddress, tokenId, tokenAmt, curveAddress);

  // Authoritative path: quote returned (even if 0n). A 0 quote means the
  // curve says these tokens currently redeem for nothing — the sell would
  // legitimately produce zero USDT (e.g. ultra-drained pool). Setting
  // minUsdtOut=0n lets the close go through; falling back to the marginal
  // estimate here would invent a positive floor and revert the exit, which
  // is the exact bug we shipped this commit to kill.
  if (quoted !== null) {
    const tokensFloat = Number(ethers.formatUnits(tokenAmt, 18));
    if (quoted === 0n) {
      return { minUsdtOut: 0n, expectedPayoutFloat: 0, exitPriceFloat: 0 };
    }
    // Apply slippage in bigint space to avoid float-rounding drift on the
    // 18-decimal value. (quoted * (10000 - 500)) / 10000.
    const minUsdtOut = (quoted * BigInt(10_000 - SLIPPAGE_BPS_QUOTE)) / 10_000n;
    const expectedPayoutFloat = Number(ethers.formatUnits(quoted, 18));
    const exitPriceFloat = tokensFloat > 0 ? expectedPayoutFloat / tokensFloat : impliedProbability;
    return { minUsdtOut, expectedPayoutFloat, exitPriceFloat };
  }

  // Quote reverted (RPC down, exotic curve, market closed mid-quote) — fall
  // back to the previous marginal-price estimate with the wide 30% buffer.
  const tokensFloat = Number(ethers.formatUnits(tokenAmt, 18));
  const expectedFloat = tokensFloat * impliedProbability;
  const minUsdtOut = ethers.parseUnits(
    (expectedFloat * (1 - SLIPPAGE_BPS_FALLBACK / 10_000)).toFixed(6),
    18,
  );
  return {
    minUsdtOut,
    expectedPayoutFloat: expectedFloat,
    exitPriceFloat: impliedProbability,
  };
}

/**
 * Resolve the bigint amount of outcome tokens to sell for `pos`.
 *
 * Normal path: the buy stored `outcomeTokenAmount` (from the on-chain
 * balance delta), so we sell exactly that, capped by current wallet
 * balance in case some were redeemed/transferred externally.
 *
 * Fallback path (Issue: "live position has no recorded outcomeTokenAmount"):
 * older rows opened before we tracked outcomeTokenAmount have it null.
 * Rather than refuse to close, we look up how many other open positions
 * the same user has on this exact (market, tokenId) and:
 *   - If this is the only open lot → sell the entire wallet balance.
 *     The user has nothing to over-sell because there's nothing else.
 *   - If there are other open lots → sell `usdtIn / entryPrice` (the
 *     classic "what you should have gotten at entry" estimate), capped
 *     by `walletBal / openLotCount` so we never dip below an even share.
 *
 * Returns { ok: true, tokenAmt } or a failure compatible with the
 * caller's return shape.
 */
async function resolveSellAmount(args: {
  pos: { id: string; userId: string; marketAddress: string; tokenId: number; outcomeTokenAmount: number | null; usdtIn: number; entryPrice: number };
  paperTrade: boolean;
  trader: ExecutorTrader;
  isAgentPath: boolean;
}): Promise<{ ok: true; tokenAmt: bigint } | { ok: false; reason: string; hint?: string; code?: string }> {
  const { pos, paperTrade, trader } = args;

  // Paper-trade path needs no on-chain balance — use recorded amount or the
  // entry-price estimate. Same as before.
  if (paperTrade) {
    const estimateFloat = pos.outcomeTokenAmount ?? pos.usdtIn / pos.entryPrice;
    return { ok: true, tokenAmt: ethers.parseUnits(estimateFloat.toFixed(6), 18) };
  }

  let walletBal: bigint;
  try {
    walletBal = await trader.balanceOfOutcome(pos.marketAddress, pos.tokenId);
  } catch (err) {
    return { ok: false, reason: `balanceOfOutcome failed: ${(err as Error).message}` };
  }

  // Recorded-amount path (the common case post-tracking-rollout).
  if (pos.outcomeTokenAmount && pos.outcomeTokenAmount > 0) {
    const recorded = ethers.parseUnits(pos.outcomeTokenAmount.toFixed(6), 18);
    const tokenAmt = recorded < walletBal ? recorded : walletBal;
    if (tokenAmt === 0n) {
      return {
        ok: false,
        reason: "This position can't be closed right now.",
        code: 'no_balance',
        hint: "Pull down to refresh. If it stays here after refreshing, please contact support and we'll take a look.",
      };
    }
    return { ok: true, tokenAmt };
  }

  // ── Fallback for older rows missing outcomeTokenAmount ──
  // Count this user's *other* open lots on the same (market, tokenId) so we
  // can decide whether selling the wallet balance is safe.
  const otherLots = await db.$queryRawUnsafe<Array<{ c: bigint; sumIn: number | null }>>(
    `SELECT COUNT(*)::bigint AS c, COALESCE(SUM("usdtIn"), 0)::float8 AS "sumIn"
     FROM "OutcomePosition"
     WHERE "userId" = $1
       AND LOWER("marketAddress") = LOWER($2)
       AND "tokenId" = $3
       AND status = 'open'
       AND id <> $4`,
    pos.userId, pos.marketAddress, pos.tokenId, pos.id,
  );
  const otherCount = Number(otherLots[0]?.c ?? 0);

  if (walletBal === 0n) {
    return {
      ok: false,
      reason: "This position can't be closed right now.",
      code: 'no_balance',
      hint: "Pull down to refresh. If it stays here after refreshing, please contact support and we'll take a look.",
    };
  }

  if (otherCount === 0) {
    // Sole holder of this token — selling the whole wallet balance is safe.
    console.warn(
      `[fortyTwoExecutor] position ${pos.id} has no recorded outcomeTokenAmount; falling back to wallet balance ${ethers.formatUnits(walletBal, 18)} (sole open lot)`,
    );
    return { ok: true, tokenAmt: walletBal };
  }

  // Multiple open lots — split the wallet balance proportionally to usdtIn so
  // we sell at most this lot's fair share. Use entry-price estimate as a
  // ceiling so we never sell more than this position theoretically minted.
  const myShare = pos.usdtIn / (pos.usdtIn + Number(otherLots[0]?.sumIn ?? 0));
  const fairShare = (walletBal * BigInt(Math.max(1, Math.floor(myShare * 1_000_000)))) / 1_000_000n;
  const entryEstimate = ethers.parseUnits((pos.usdtIn / pos.entryPrice).toFixed(6), 18);
  const tokenAmt = fairShare < entryEstimate ? fairShare : entryEstimate;
  if (tokenAmt === 0n) {
    return {
      ok: false,
      reason: "This position can't be closed right now.",
      code: 'no_balance',
      hint: "You have other open positions on the same outcome — try closing the larger one first.",
    };
  }
  console.warn(
    `[fortyTwoExecutor] position ${pos.id} has no recorded outcomeTokenAmount and ${otherCount} other open lot(s); selling fair share ${ethers.formatUnits(tokenAmt, 18)} of wallet ${ethers.formatUnits(walletBal, 18)}`,
  );
  return { ok: true, tokenAmt };
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
      market = await __testDeps.getMarketByAddress(addr);
    } catch {
      continue;
    }
    let state;
    try {
      state = await __testDeps.readMarketOnchain(market);
    } catch {
      continue;
    }
    if (!state.isFinalised) continue;
    // Guard against the contract briefly reporting isFinalised=true while
    // the resolvedAnswer is still 0n (unanswered). Without this, every
    // open position on the market silently flips to resolved_loss because
    // (0n & anyTokenId) === 0n. The next runner tick will re-check and
    // settle correctly once the answer is populated.
    if (state.resolvedAnswer === 0n) continue;

    for (const pos of positions) {
      const win = __testDeps.isWinningTokenId(state.resolvedAnswer, pos.tokenId);
      // For losses: payout=0, pnl=-stake (definitive). For wins: leave
      // payoutUsdt and pnl NULL — the actual amount is only known when
      // claimUserResolvedForMarket reads it from the on-chain receipt.
      // We previously wrote a 1:1 token→USDT estimate here, but 42.space
      // outcome tokens redeem at the curve-implied resolution price (not
      // 1:1), which produced wildly inflated "you won $X" displays.
      const status = win ? 'resolved_win' : 'resolved_loss';
      const payout = win ? null : 0;
      const pnl = win ? null : -pos.usdtIn;
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

// ──────────────────────────────────────────────────────────────────────────
// User-initiated position management (mini-app sell + claim flows)
//
// These mirror the agent-only `closePredictionPosition` and
// `settleResolvedPositions` but gate by `userId` instead of `agentId`, so a
// user can manage *any* of their positions (manual + agent-opened) from the
// Predictions tab. The on-chain mechanics are unchanged — we reuse the same
// `trader.sellOutcome` / `trader.claimAllResolved` paths that production
// already runs through.
// ──────────────────────────────────────────────────────────────────────────

/**
 * User-scoped sell. Functionally identical to closePredictionPosition but
 * the WHERE clause is keyed on userId so it covers manual positions
 * (agentId IS NULL) too. Closing a live position bypasses the kill switch
 * so users can always exit.
 */
export async function closeUserPredictionPosition(
  userId: string,
  positionId: string,
): Promise<{ ok: true; pnl: number; txHash: string | null } | { ok: false; reason: string }> {
  const rows = await db.$queryRawUnsafe<OutcomePositionRow[]>(
    `SELECT * FROM "OutcomePosition" WHERE id = $1 AND "userId" = $2 AND status = 'open' LIMIT 1`,
    positionId,
    userId,
  );
  const pos = rows[0];
  if (!pos) return { ok: false, reason: 'position not found or not open' };

  let market: Market42;
  try {
    market = await __testDeps.getMarketByAddress(pos.marketAddress);
  } catch (err) {
    return { ok: false, reason: `market lookup failed: ${(err as Error).message}` };
  }

  const state = await __testDeps.readMarketOnchain(market);
  const outcome = state.outcomes.find((o) => o.tokenId === pos.tokenId);
  if (!outcome) return { ok: false, reason: 'outcome missing on chain' };

  // Honor the position's recorded mode (paper vs live) — see
  // closePredictionPosition for the rationale.
  const built = await buildTrader(userId, pos.paperTrade);
  if (!built) return { ok: false, reason: 'no wallet' };
  const { trader, paperTrade } = built;

  const sellAmt = await resolveSellAmount({
    pos,
    paperTrade,
    trader,
    isAgentPath: false,
  });
  if (!sellAmt.ok) return sellAmt;
  const tokenAmt = sellAmt.tokenAmt;

  const sellQuote = await computeSellMinOut({
    paperTrade,
    marketAddress: pos.marketAddress,
    curveAddress: market.curve,
    tokenId: pos.tokenId,
    tokenAmt,
    impliedProbability: outcome.impliedProbability,
  });
  const { minUsdtOut, expectedPayoutFloat, exitPriceFloat } = sellQuote;

  let receipt: TxReceiptLike = null;
  try {
    receipt = await trader.sellOutcome(pos.marketAddress, pos.tokenId, tokenAmt, minUsdtOut);
  } catch (err) {
    // User-initiated path — surface the friendly mapper output (with code +
    // hint) so Predictions.tsx can swap the Sell button for a more useful
    // CTA. The agent's closePredictionPosition uses friendlyTraderError
    // instead because no user is watching that response.
    const friendly = friendlySellError((err as Error).message);
    return {
      ok: false,
      reason: friendly.message,
      hint: friendly.hint,
      code: friendly.code,
    } as { ok: false; reason: string; hint?: string; code?: string };
  }
  const txHash = receiptHash(receipt);

  // Prefer the actual on-chain USDT inflow over the curve quote estimate.
  // The quote is what the curve PROMISED at the slippage check; the
  // receipt is what the wallet ACTUALLY received after fees + impact.
  // Falls back to the quote when the receipt can't be parsed (paper-trade
  // dry runs, malformed logs).
  const recipient = (trader as any)?.wallet?.address as string | undefined;
  const onchainPayout = paperTrade ? null : parseUsdtInflowFromReceipt(receipt, recipient);
  const realisedPayout = onchainPayout ?? expectedPayoutFloat;
  const pnl = realisedPayout - pos.usdtIn;
  await db.$executeRawUnsafe(
    `UPDATE "OutcomePosition"
     SET status='closed', "exitPrice"=$1, "payoutUsdt"=$2, pnl=$3,
         "txHashClose"=$4, "closedAt"=NOW(), "paperTrade"=$5
     WHERE id=$6`,
    exitPriceFloat,
    realisedPayout,
    pnl,
    txHash,
    paperTrade,
    pos.id,
  );
  return { ok: true, pnl, txHash };
}

/**
 * Claim every winning outcome the user holds for a single resolved market
 * in one tx via `claimAllSimple`. Marks all matching `resolved_win` rows as
 * `'claimed'` and stamps the claim tx hash into `txHashClose` (the row
 * already has `payoutUsdt`/`pnl` set by settleResolvedPositions).
 *
 * Single-position claims collapse to this — the contract claims the
 * wallet's full holding for the market either way, so we always batch.
 */
export async function claimUserResolvedForMarket(
  userId: string,
  marketAddress: string,
): Promise<
  | { ok: true; claimedPositions: number; payoutUsdt: number; txHash: string | null }
  | { ok: false; reason: string }
> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(marketAddress)) {
    return { ok: false, reason: 'invalid market address' };
  }

  const wins = await db.$queryRawUnsafe<OutcomePositionRow[]>(
    `SELECT * FROM "OutcomePosition"
     WHERE "userId" = $1 AND "marketAddress" = $2 AND status = 'resolved_win'`,
    userId,
    marketAddress,
  );
  if (wins.length === 0) {
    return { ok: false, reason: 'no claimable wins on this market' };
  }

  // All rows for the same market share paperTrade mode in practice (a user's
  // wallet either is or isn't on-chain). If they happen to mix, prefer the
  // live path so the on-chain claim actually fires; paper rows still get
  // their DB status flipped below.
  const anyLive = wins.some((p) => !p.paperTrade);
  const built = await buildTrader(userId, !anyLive);
  if (!built) return { ok: false, reason: 'no wallet' };
  const { trader } = built;

  if (typeof trader.claimAllResolved !== 'function') {
    return { ok: false, reason: 'trader does not implement claimAllResolved' };
  }
  let receipt: TxReceiptLike = null;
  try {
    receipt = await trader.claimAllResolved(marketAddress);
  } catch (err) {
    return { ok: false, reason: friendlyTraderError(err, 'claimAllResolved') };
  }
  const txHash = receiptHash(receipt);

  // Reverted / dropped tx safety net.
  //
  // ethers v6 throws on a confirmed revert, but `tx.wait()` returns null when
  // the tx is dropped/replaced and an empty-status receipt is technically
  // possible on some BSC RPCs during reorgs. Either way: don't lie to the
  // user that the position is claimed if the chain didn't pay out. We keep
  // status='resolved_win' so they (or the agent) can retry.
  //
  // Skip this check for paper-trade dry-run receipts (they carry dryRun:true).
  const r = receipt as any;
  const isDryRun = r && r.dryRun === true;
  const isLiveSuccess = r && typeof r.status === 'number' && r.status === 1;
  if (!isDryRun && !isLiveSuccess) {
    console.warn(
      `[fortyTwo] claimAllResolved tx not confirmed for market=${marketAddress} ` +
      `userId=${userId} hash=${txHash ?? '<none>'} status=${r?.status ?? '<null>'}`,
    );
    return {
      ok: false,
      reason: txHash
        ? `claim transaction did not confirm on-chain (hash ${txHash}). Try again in a moment.`
        : 'claim transaction was dropped before confirmation. Try again in a moment.',
    };
  }

  // Read the ACTUAL on-chain payout from the receipt's USDT Transfer event
  // and write that as the truth (overriding any pre-claim 1:1 estimate the
  // settle path may have stored). 42.space outcome tokens do NOT redeem
  // 1:1 with USDT — they redeem at the curve-implied resolution price,
  // which can be 100×+ less than (token_count × $1). Trusting the
  // 1:1 estimate produced bug reports like "$1 stake → $297 claim" when
  // the wallet really received $1.14. Source of truth is the receipt.
  let payoutUsdt = wins.reduce((s, p) => s + (p.payoutUsdt ?? 0), 0); // pre-claim estimate, kept only for the drift log
  let onchainPayout: number | null = null;
  if (!isDryRun) {
    try {
      onchainPayout = parseClaimPayoutFromReceipt(r, marketAddress);
      if (onchainPayout !== null) {
        const drift = Math.abs(onchainPayout - payoutUsdt);
        const log = drift > Math.max(0.01, payoutUsdt * 0.02) ? console.warn : console.log;
        log(
          `[fortyTwo] claim payout market=${marketAddress} userId=${userId} ` +
          `dbEstimate=${payoutUsdt.toFixed(4)} onchain=${onchainPayout.toFixed(4)} ` +
          `drift=${drift.toFixed(4)} hash=${txHash}`,
        );
      }
    } catch (e) {
      // best-effort — never fail the claim because the receipt parse threw
      console.warn('[fortyTwo] claim payout parse failed:', (e as Error)?.message);
    }
  }

  if (onchainPayout !== null) {
    // Allocate the single on-chain payout across the N rows we're claiming
    // for this market. Allocation is proportional to each row's recorded
    // outcomeTokenAmount (each token contributes equally to the redemption);
    // fall back to usdtIn for legacy rows missing tokenAmount; equal split
    // if neither is available. This makes per-position pnl sane even when
    // claimAllSimple settles multiple positions in one tx.
    const weights = wins.map((p) => {
      if (p.outcomeTokenAmount && p.outcomeTokenAmount > 0) return p.outcomeTokenAmount;
      if (p.usdtIn && p.usdtIn > 0) return p.usdtIn;
      return 1;
    });
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < wins.length; i++) {
      const pos = wins[i];
      const share = (weights[i] / totalWeight) * onchainPayout;
      const pnl = share - pos.usdtIn;
      await db.$executeRawUnsafe(
        `UPDATE "OutcomePosition"
         SET status='claimed', "txHashClose"=COALESCE("txHashClose", $1),
             "payoutUsdt"=$2, pnl=$3, "closedAt"=NOW()
         WHERE id=$4`,
        txHash,
        share,
        pnl,
        pos.id,
      );
    }
    payoutUsdt = onchainPayout;
  } else {
    // Dry-run (paper) or unparseable receipt — keep the previous behaviour
    // of stamping status/txHash without rewriting the per-row payout.
    await db.$executeRawUnsafe(
      `UPDATE "OutcomePosition"
       SET status='claimed', "txHashClose"=COALESCE("txHashClose", $1), "closedAt"=NOW()
       WHERE "userId" = $2 AND "marketAddress" = $3 AND status = 'resolved_win'`,
      txHash,
      userId,
      marketAddress,
    );
  }
  return { ok: true, claimedPositions: wins.length, payoutUsdt, txHash };
}

// USDT (BSC) ERC-20 Transfer event topic. Used to recover the actual USDT
// flow from a receipt's logs — the only source of truth for what the user
// actually received from a claim or sell. We do NOT trust quote-time
// estimates (curve quotes, 1:1 redemption assumptions) anymore: a real
// claim on 42.space's bonding-curve markets paid $1.14 on a position the
// system had estimated at $297, because outcome tokens redeem at the
// curve-implied price at resolution, NOT 1 token = 1 USDT.
const USDT_BSC_ADDRESS = '0x55d398326f99059fF775485246999027B3197955';
const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * Sum every USDT inflow to `recipient` (a user wallet) inside the receipt.
 * Pass recipient=undefined to sum all USDT Transfers (legacy behaviour;
 * fine for `claimSimple` where the only USDT movement is the payout).
 *
 * The `recipient` filter is required for sell receipts that may include
 * intermediate hop transfers (router → market → router → user) so we
 * count only what actually landed in the user's wallet.
 */
function parseUsdtInflowFromReceipt(
  receipt: any,
  recipient?: string,
): number | null {
  if (!receipt?.logs || !Array.isArray(receipt.logs)) return null;
  const recipientLower = recipient ? recipient.toLowerCase() : null;
  let totalRaw = 0n;
  for (const log of receipt.logs) {
    if (!log?.address || !log?.topics || log.topics.length < 3) continue;
    if (log.address.toLowerCase() !== USDT_BSC_ADDRESS.toLowerCase()) continue;
    if (log.topics[0] !== ERC20_TRANSFER_TOPIC) continue;
    if (recipientLower) {
      // topics[2] = `to` padded to 32 bytes (left-padded address)
      const to = '0x' + log.topics[2].slice(26).toLowerCase();
      if (to !== recipientLower) continue;
    }
    try {
      totalRaw += BigInt(log.data);
    } catch { /* malformed log, skip */ }
  }
  if (totalRaw === 0n) return null;
  return Number(totalRaw) / 1e18; // USDT BSC has 18 decimals
}

// Back-compat alias — old callsite name. Same semantics: sum all USDT
// transfers in the receipt (claim flows have exactly one, to the user).
function parseClaimPayoutFromReceipt(
  receipt: any,
  _marketAddress: string,
): number | null {
  return parseUsdtInflowFromReceipt(receipt);
}

/**
 * Backfill payoutUsdt + pnl on historical rows that were settled before
 * we started reading the on-chain truth. Called in the background from
 * /api/me/positions so a user opening the Predictions tab gets their
 * stale numbers corrected without blocking the response.
 *
 * Targets:
 *   1. status='claimed' rows with txHashClose set — read the claim tx
 *      receipt's USDT Transfer to the user wallet, write the truth.
 *   2. status='closed' rows with txHashClose set — same, for sells.
 *   3. status='resolved_win' rows with non-null payoutUsdt — these were
 *      stamped with the broken 1:1 estimate by the old settle path; null
 *      them out so the UI shows "Won — claim to see payout" until the
 *      user actually claims.
 *
 * Idempotent: only updates a row when the parsed truth differs by >$0.01
 * from what's stored, or to clear the bad pre-claim estimate.
 *
 * Bounded: at most `maxRows` per call, prioritising the rows with the
 * largest absolute drift (most likely to be confusing the user).
 */
export async function backfillReceiptPayoutsForUser(
  userId: string,
  maxRows = 25,
): Promise<{ checked: number; rewritten: number; cleared: number }> {
  // 1+2: rows that have a close tx hash whose USDT inflow we can re-read
  const settled = await db.$queryRawUnsafe<Array<{
    id: string;
    status: string;
    usdtIn: number;
    payoutUsdt: number | null;
    txHashClose: string;
    paperTrade: boolean;
  }>>(
    `SELECT id, status, "usdtIn", "payoutUsdt", "txHashClose", "paperTrade"
     FROM "OutcomePosition"
     WHERE "userId" = $1
       AND status IN ('claimed', 'closed')
       AND "txHashClose" IS NOT NULL
       AND "paperTrade" = false
     ORDER BY "closedAt" DESC NULLS LAST
     LIMIT $2`,
    userId,
    maxRows,
  );

  // 3: resolved_win rows with the broken pre-claim 1:1 estimate still on them
  const staleEstimates = await db.$executeRawUnsafe(
    `UPDATE "OutcomePosition"
     SET "payoutUsdt" = NULL, pnl = NULL
     WHERE "userId" = $1
       AND status = 'resolved_win'
       AND "payoutUsdt" IS NOT NULL`,
    userId,
  );

  let rewritten = 0;
  if (settled.length > 0) {
    const wallet = await db.$queryRawUnsafe<Array<{ address: string }>>(
      `SELECT address FROM "Wallet" WHERE "userId" = $1 LIMIT 1`,
      userId,
    );
    const walletAddr = wallet[0]?.address;
    if (walletAddr) {
      // Reuse the prediction module's BSC provider (same fallback list the
      // rest of the executor uses). Lazy import keeps the module graph tidy.
      const { buildBscProvider } = await import('./bscProvider');
      const rpc = buildBscProvider(process.env.BSC_RPC_URL);
      for (const row of settled) {
        try {
          const receipt = await rpc.getTransactionReceipt(row.txHashClose);
          if (!receipt || receipt.status !== 1) continue;
          const onchain = parseUsdtInflowFromReceipt(receipt, walletAddr);
          if (onchain === null) continue;
          const stored = row.payoutUsdt ?? 0;
          const drift = Math.abs(onchain - stored);
          if (drift < 0.01) continue;
          const pnl = onchain - row.usdtIn;
          await db.$executeRawUnsafe(
            `UPDATE "OutcomePosition"
             SET "payoutUsdt" = $1, pnl = $2
             WHERE id = $3`,
            onchain,
            pnl,
            row.id,
          );
          rewritten++;
          console.log(
            `[backfill] rewrote position ${row.id} status=${row.status} ` +
            `stored=${stored.toFixed(4)} onchain=${onchain.toFixed(4)} ` +
            `tx=${row.txHashClose}`,
          );
        } catch (err) {
          console.warn(`[backfill] receipt fetch failed for ${row.txHashClose}:`, (err as Error).message);
        }
      }
    }
  }

  return {
    checked: settled.length,
    rewritten,
    cleared: typeof staleEstimates === 'number' ? staleEstimates : 0,
  };
}

/**
 * Claim every winning outcome the user holds across every resolved market.
 * One on-chain tx per market with at least one win.
 */
export async function claimAllUserResolved(
  userId: string,
): Promise<{
  ok: true;
  marketsClaimed: number;
  claimedPositions: number;
  payoutUsdt: number;
  errors: Array<{ marketAddress: string; reason: string }>;
}> {
  // First refresh resolution state so any newly-finalised markets get
  // flipped to resolved_win/_loss before we try to claim.
  try {
    await settleResolvedPositions({ userId });
  } catch {
    // best-effort refresh; claim-loop below filters by status anyway
  }

  const winRows = await db.$queryRawUnsafe<Array<{ marketAddress: string }>>(
    `SELECT DISTINCT "marketAddress" FROM "OutcomePosition"
     WHERE "userId" = $1 AND status = 'resolved_win'`,
    userId,
  );

  let marketsClaimed = 0;
  let claimedPositions = 0;
  let payoutUsdt = 0;
  const errors: Array<{ marketAddress: string; reason: string }> = [];
  for (const { marketAddress } of winRows) {
    const r = await claimUserResolvedForMarket(userId, marketAddress);
    if (r.ok) {
      marketsClaimed++;
      claimedPositions += r.claimedPositions;
      payoutUsdt += r.payoutUsdt;
    } else {
      errors.push({ marketAddress, reason: r.reason });
    }
  }
  return { ok: true, marketsClaimed, claimedPositions, payoutUsdt, errors };
}
