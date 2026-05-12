// ─────────────────────────────────────────────────────────────────────────
// BUILD4 × 42.space "Agent vs Community" 48h campaign — brain + scheduler hooks
// ─────────────────────────────────────────────────────────────────────────
//
// Scope: 12 rounds of BTC 8h Price Markets, one round per 4h UTC boundary
// (00/04/08/12/16/20). Each round, this module:
//   1. Resolves the current-round market via fortyTwo.getCurrentRoundBtcPriceMarket
//   2. Builds a TA packet from Aster BTCUSDT 5m candles
//   3. Builds a bucket-grid prompt with indicators + crowd consensus
//   4. Runs all 4 LLMs in parallel (anthropic / xai / hyperbolic / akash)
//   5. Aggregates with the always-trade tie-break rule
//   6. Opens a $50 position via the existing executor (campaign caps lifted)
//
// What is NOT in this file (planned for next session, see session_plan.md):
//   - DOUBLE_DOWN / SPREAD follow-up actions (T009)
//   - Public thesis broadcast to TG channel + brain feed (T010)
//   - Campaign state recap API (T011)
// REASSESS_1 / REASSESS_2 / FINAL ticks are scheduled and persist a planning
// row, but currently log "not yet implemented" instead of placing follow-up
// trades. The ENTRY tick (the one we promised 42 will always fire) is fully
// wired end-to-end.

import { db } from '../db';
import {
  getCurrentRoundBtcPriceMarket,
  currentRoundBoundaryMs,
  type Market42,
} from './fortyTwo';
import { readMarketOnchain, type OnchainMarketState, type OnchainOutcome } from './fortyTwoOnchain';
import { getKlines } from './aster';
import {
  calculateRSI,
  calculateMACD,
  calculateATR,
  calculateADX,
  calculateBollingerBands,
  type OHLCV,
} from '../agents/indicators';
import { callLLM, type Provider } from './inference';
import { openPredictionPosition, isCampaignAgent } from './fortyTwoExecutor';
import { getBot } from '../agents/runner';

// ── Tick taxonomy ─────────────────────────────────────────────────────────

export type TickKind = 'ENTRY' | 'REASSESS_1' | 'REASSESS_2' | 'FINAL';

/** Cumulative follow-up budget cap per round, in USDT. ENTRY tick is fixed
 *  $50 on top; total round cap is $50 + this = $100. */
export const CAMPAIGN_FOLLOWUP_BUDGET_USDT = 50;

/** Fixed entry size — every ENTRY tick deploys exactly this much. */
export const CAMPAIGN_ENTRY_USDT = 50;

const SWARM_PROVIDERS: Provider[] = ['anthropic', 'xai', 'hyperbolic', 'akash'];

// ── Public entry point: run one tick of the campaign agent ────────────────

export interface CampaignTickResult {
  ok: boolean;
  reason?: string;
  tick: TickKind;
  roundBoundaryMs: number;
  marketAddress?: string;
  bucketIndex?: number;
  bucketLabel?: string;
  positionId?: string;
  swarm?: SwarmVote[];
  thesis?: string;
}

/**
 * Run a single tick for the campaign agent. Resolves the current-round
 * market, runs the 4-model swarm, and (for ENTRY) opens a $50 position.
 *
 * Designed to be called by the cron block in src/agents/runner.ts. Returns
 * a structured result so the caller can log, persist a planning row, and
 * (in later phases) broadcast the thesis publicly.
 */
export async function runCampaignTick(tick: TickKind): Promise<CampaignTickResult> {
  const roundBoundaryMs = currentRoundBoundaryMs();
  const baseResult: CampaignTickResult = { ok: false, tick, roundBoundaryMs };

  // 1. Locate the campaign agent + its owning user.
  const ctx = await loadCampaignContext();
  if (!ctx) {
    return { ...baseResult, reason: 'campaign agent not configured (set FT_CAMPAIGN_AGENT_ID)' };
  }

  // 2. Find the current-round BTC Price Market.
  let market: Market42 | null;
  try {
    market = await getCurrentRoundBtcPriceMarket();
  } catch (err) {
    return { ...baseResult, reason: `market lookup failed: ${(err as Error).message}` };
  }
  if (!market) {
    return { ...baseResult, reason: 'no live BTC 8h Price Market found for current round' };
  }

  // 3. Read the on-chain bucket state.
  let state: OnchainMarketState;
  try {
    state = await readMarketOnchain(market);
  } catch (err) {
    return { ...baseResult, reason: `on-chain read failed: ${(err as Error).message}` };
  }
  if (!state.outcomes.length) {
    return { ...baseResult, reason: 'market has no outcomes' };
  }

  // 4. Build TA packet from Aster BTCUSDT 5m candles.
  let ta: TAPacket;
  try {
    ta = await buildTAPacket();
  } catch (err) {
    return { ...baseResult, reason: `TA fetch failed: ${(err as Error).message}` };
  }

  // 5. REASSESS_1 / REASSESS_2 / FINAL — runs the reassess swarm, picks
  //    HOLD / DOUBLE_DOWN / SPREAD, applies conviction → size mapping
  //    ($0/$20/$30) and per-round $50 follow-up cap.
  if (tick !== 'ENTRY') {
    return runReassessTick(ctx, market, state, ta, tick, roundBoundaryMs);
  }

  // 6. ENTRY path — run the 4-model swarm.
  const prompt = buildEntryPrompt(market, state, ta, roundBoundaryMs);
  const votes = await runSwarm(prompt);

  // 7. Aggregate with always-trade tie-break.
  const decision = aggregateForEntry(votes, state, ta.btcSpot);
  console.log(
    `[fortyTwoCampaign] ENTRY round=${roundBoundaryMs} bucket=${decision.bucketIndex} ` +
      `(${state.outcomes[decision.bucketIndex]?.label}) thesis="${decision.thesis.slice(0, 120)}"`,
  );

  // 8. Open the position via the existing executor. Conviction is forced
  //    high enough to clear the edge gate and hit the $50 per-position
  //    campaign cap (see comment on `forcedConviction`).
  const outcome = state.outcomes[decision.bucketIndex];
  if (!outcome) {
    return { ...baseResult, reason: `bucket index ${decision.bucketIndex} out of range` };
  }
  const forcedConviction = Math.min(0.99, outcome.impliedProbability + 0.40);

  const trade = await openPredictionPosition(
    {
      agentId: ctx.agentId,
      agentMaxPositionSize: ctx.agentMaxPositionSize,
      userId: ctx.userId,
    },
    {
      action: 'OPEN_PREDICTION',
      marketAddress: market.address,
      tokenId: outcome.tokenId,
      outcomeLabel: outcome.label,
      conviction: forcedConviction,
      reasoning: `[CAMPAIGN ENTRY round=${roundBoundaryMs}] ${decision.thesis}`.slice(0, 500),
    },
    votes.map((v) => ({
      provider: v.provider,
      model: v.model,
      action: v.parsed ? 'ENTER' : null,
      predictionTrade: v.parsed ? { bucketIndex: v.bucketIndex, conviction: v.conviction } : undefined,
      reasoning: v.thesis.slice(0, 300),
      latencyMs: v.latencyMs,
      inputTokens: v.inputTokens,
      outputTokens: v.outputTokens,
      tokensUsed: v.inputTokens + v.outputTokens,
    })),
  );

  if (!trade.ok) {
    return {
      ...baseResult,
      reason: `executor rejected trade: ${trade.reason}`,
      marketAddress: market.address,
      bucketIndex: decision.bucketIndex,
      bucketLabel: outcome.label,
      swarm: votes,
      thesis: decision.thesis,
    };
  }

  // 9. Broadcast — TG channel + brain feed (best-effort, never blocks the trade).
  await broadcastCampaignTrade({
    tick,
    roundBoundaryMs,
    market,
    bucketLabel: outcome.label,
    bucketIndex: decision.bucketIndex,
    usdtIn: CAMPAIGN_ENTRY_USDT,
    impliedProbability: outcome.impliedProbability,
    thesis: decision.thesis,
    agentId: ctx.agentId,
    userId: ctx.userId,
    swarm: votes,
  }).catch((err) => console.warn('[fortyTwoCampaign] broadcast failed:', (err as Error).message));

  return {
    ok: true,
    tick,
    roundBoundaryMs,
    marketAddress: market.address,
    bucketIndex: decision.bucketIndex,
    bucketLabel: outcome.label,
    positionId: trade.positionId,
    swarm: votes,
    thesis: decision.thesis,
  };
}

// ── REASSESS / FINAL tick ─────────────────────────────────────────────────

/**
 * Run a REASSESS_1 / REASSESS_2 / FINAL tick. Loads existing campaign
 * positions for this round, queries the swarm for HOLD / DOUBLE_DOWN /
 * SPREAD, and applies conviction → size ($0 / $20 / $30) capped by the
 * remaining round-level follow-up budget ($50 - already spent on follow-ups).
 *
 * Never sells. The 42 contracts settle at expiry; we ride.
 */
async function runReassessTick(
  ctx: CampaignContext,
  market: Market42,
  state: OnchainMarketState,
  ta: TAPacket,
  tick: TickKind,
  roundBoundaryMs: number,
): Promise<CampaignTickResult> {
  const baseResult: CampaignTickResult = {
    ok: false,
    tick,
    roundBoundaryMs,
    marketAddress: market.address,
  };

  // 1. Load this round's existing campaign positions (entry + any prior follow-ups).
  const existingPositions = await loadRoundPositions(ctx.agentId, roundBoundaryMs);
  if (!existingPositions.length) {
    // No entry position — agent missed the ENTRY tick (e.g. boot mid-round).
    // We don't open a "late entry" here; reassess is for adjusting an
    // existing position, not for substituting the missed entry.
    return { ...baseResult, ok: true, reason: 'no entry position for this round — skipping reassess' };
  }
  const entryPos = existingPositions[0];
  const followupSpent = existingPositions.slice(1).reduce((s, p) => s + p.usdtIn, 0);
  const followupRemaining = Math.max(0, CAMPAIGN_FOLLOWUP_BUDGET_USDT - followupSpent);

  if (followupRemaining < 1) {
    return { ...baseResult, ok: true, reason: `round follow-up budget exhausted ($${followupSpent.toFixed(2)})` };
  }

  // 2. Build the reassess prompt + run swarm.
  const minutesIntoRound = Math.floor((Date.now() - roundBoundaryMs) / 60_000);
  const minutesRemaining = Math.max(0, 4 * 60 - minutesIntoRound);
  const prompt = buildReassessPrompt(market, state, ta, roundBoundaryMs, {
    heldBucketIndex: entryPos.bucketIndexFromTokenId(state),
    heldBucketLabel: entryPos.outcomeLabel,
    heldUsdtIn: entryPos.usdtIn + followupSpent,
    followupRemaining,
    minutesRemaining,
    isFinal: tick === 'FINAL',
  });
  const votes = await runReassessSwarm(prompt);

  // 3. Aggregate.
  const decision = aggregateForReassess(votes, state, entryPos.bucketIndexFromTokenId(state), ta.btcSpot);
  console.log(
    `[fortyTwoCampaign] ${tick} round=${roundBoundaryMs} action=${decision.action} ` +
      `bucket=${decision.bucketIndex ?? '-'} sizeUsdt=$${decision.sizeUsdt.toFixed(2)} ` +
      `(followupRemaining=$${followupRemaining.toFixed(2)}) thesis="${decision.thesis.slice(0, 100)}"`,
  );

  // 4. HOLD = no trade, just record reasoning in the brain feed for transparency.
  if (decision.action === 'HOLD' || decision.sizeUsdt < 1 || decision.bucketIndex === null) {
    await writeBrainFeedHold(ctx, market, decision.thesis, tick, roundBoundaryMs).catch(() => {});
    return {
      ok: true,
      tick,
      roundBoundaryMs,
      marketAddress: market.address,
      reason: `HOLD — ${decision.thesis.slice(0, 80)}`,
    };
  }

  // 5. Cap size by remaining round budget.
  const sizeUsdt = Math.min(decision.sizeUsdt, followupRemaining);
  const outcome = state.outcomes[decision.bucketIndex];
  if (!outcome) {
    return { ...baseResult, reason: `bucket index ${decision.bucketIndex} out of range` };
  }
  const forcedConviction = Math.min(0.99, outcome.impliedProbability + sizedConvictionEdge(sizeUsdt));

  const trade = await openPredictionPosition(
    {
      agentId: ctx.agentId,
      agentMaxPositionSize: ctx.agentMaxPositionSize,
      userId: ctx.userId,
    },
    {
      action: 'OPEN_PREDICTION',
      marketAddress: market.address,
      tokenId: outcome.tokenId,
      outcomeLabel: outcome.label,
      conviction: forcedConviction,
      reasoning: `[CAMPAIGN ${decision.action} round=${roundBoundaryMs} tick=${tick}] ${decision.thesis}`.slice(0, 500),
    },
    votes.map((v) => ({
      provider: v.provider,
      model: v.model,
      action: v.parsed ? v.action : null,
      predictionTrade: v.parsed ? { bucketIndex: v.bucketIndex, conviction: v.conviction } : undefined,
      reasoning: v.thesis.slice(0, 300),
      latencyMs: v.latencyMs,
      inputTokens: v.inputTokens,
      outputTokens: v.outputTokens,
      tokensUsed: v.inputTokens + v.outputTokens,
    })),
  );

  if (!trade.ok) {
    return {
      ...baseResult,
      reason: `executor rejected ${decision.action}: ${trade.reason}`,
      bucketIndex: decision.bucketIndex,
      bucketLabel: outcome.label,
      swarm: votes,
      thesis: decision.thesis,
    };
  }

  await broadcastCampaignTrade({
    tick,
    roundBoundaryMs,
    market,
    bucketLabel: outcome.label,
    bucketIndex: decision.bucketIndex,
    usdtIn: trade.usdtIn,
    impliedProbability: outcome.impliedProbability,
    thesis: decision.thesis,
    agentId: ctx.agentId,
    userId: ctx.userId,
    swarm: votes,
    action: decision.action,
  }).catch((err) => console.warn('[fortyTwoCampaign] broadcast failed:', (err as Error).message));

  return {
    ok: true,
    tick,
    roundBoundaryMs,
    marketAddress: market.address,
    bucketIndex: decision.bucketIndex,
    bucketLabel: outcome.label,
    positionId: trade.positionId,
    swarm: votes,
    thesis: decision.thesis,
  };
}

/** Conviction → size mapping: low(60-69)=$0, med(70-84)=$20, high(85+)=$30. */
function convictionToSize(conviction: number): number {
  if (conviction >= 85) return 30;
  if (conviction >= 70) return 20;
  return 0;
}

/** Reverse-engineer a conviction value that lands `sizeUsdt` on the executor. */
function sizedConvictionEdge(sizeUsdt: number): number {
  // edgeScaled = min(1, edge/0.30) * cap. We want edgeScaled = sizeUsdt
  // with cap=$50, so edge = (sizeUsdt/$50) * 0.30. Add a tiny pad to defeat
  // FP rounding losing the last cent.
  return Math.min(0.40, (sizeUsdt / 50) * 0.30 + 0.005);
}

interface RoundPosition {
  positionId: string;
  tokenId: number;
  outcomeLabel: string;
  usdtIn: number;
  bucketIndexFromTokenId: (state: OnchainMarketState) => number;
}

/** Load all campaign positions tagged with this round (via reasoning prefix). */
async function loadRoundPositions(agentId: string, roundBoundaryMs: number): Promise<RoundPosition[]> {
  const tag = `%round=${roundBoundaryMs}%`;
  const rows = await db.$queryRawUnsafe<
    Array<{ id: string; tokenId: number; outcomeLabel: string; usdtIn: number; openedAt: Date }>
  >(
    `SELECT id, "tokenId", "outcomeLabel", "usdtIn", "openedAt"
     FROM "OutcomePosition"
     WHERE "agentId" = $1 AND reasoning LIKE $2
     ORDER BY "openedAt" ASC`,
    agentId,
    tag,
  );
  return rows.map((r) => ({
    positionId: r.id,
    tokenId: Number(r.tokenId),
    outcomeLabel: r.outcomeLabel,
    usdtIn: Number(r.usdtIn),
    bucketIndexFromTokenId: (state) =>
      state.outcomes.findIndex((o) => o.tokenId === Number(r.tokenId)),
  }));
}

// ── Reassess prompt + swarm ───────────────────────────────────────────────

interface ReassessContext {
  heldBucketIndex: number;
  heldBucketLabel: string;
  heldUsdtIn: number;
  followupRemaining: number;
  minutesRemaining: number;
  isFinal: boolean;
}

function buildReassessPrompt(
  market: Market42,
  state: OnchainMarketState,
  ta: TAPacket,
  roundBoundaryMs: number,
  rctx: ReassessContext,
): { system: string; user: string } {
  const buckets = state.outcomes
    .map(
      (o) =>
        `  ${o.index.toString().padStart(2)}  ${o.label.padEnd(28)}  ` +
        `prob=${(o.impliedProbability * 100).toFixed(1).padStart(5)}%  ` +
        `mult=${o.impliedProbability > 0 ? (1 / o.impliedProbability).toFixed(2) : '∞'}x` +
        (o.index === rctx.heldBucketIndex ? '  ◀ HELD' : ''),
    )
    .join('\n');

  const system = [
    'You are a senior BTC quant trader managing an OPEN position on a 42.space',
    'BTC 8-hour Price Market. Lifecycle: 4h live-trading phase, then 4h',
    'settlement phase — resolution = round_open + 8h. You may HOLD, DOUBLE_DOWN',
    'on the held bucket, or SPREAD into one adjacent bucket. You CANNOT sell.',
    'The position pays out at the +8h resolution if BTC settles in the bucket',
    'you hold. Your TA target is BTC at the resolution timestamp, NOT at the',
    'trading-close timestamp. Conviction maps to size: low(60-69)=$0=HOLD,',
    'med(70-84)=$20, high(85+)=$30. Reply with strict JSON.',
  ].join(' ');

  const user = [
    `Market: ${market.question}`,
    `Round opened:        ${new Date(roundBoundaryMs).toISOString()}`,
    `RESOLUTION TARGET:   ${new Date(roundBoundaryMs + 8 * 60 * 60 * 1000).toISOString()}  (round_open + 8h — your prediction horizon)`,
    `Trading window remaining: ${rctx.minutesRemaining} min` + (rctx.isFinal ? '  (FINAL CALL — last chance to adjust before trading closes)' : ''),
    '',
    `BTC spot now: $${ta.btcSpot.toFixed(2)}`,
    `RSI(14): ${ta.rsi14.toFixed(1)}   ADX(14): ${ta.adx14.toFixed(1)}   ATR(14): $${ta.atr14.toFixed(2)}`,
    `MACD: line=${ta.macd.macdLine.toFixed(2)} signal=${ta.macd.signalLine.toFixed(2)} hist=${ta.macd.histogram.toFixed(2)}${ta.macd.recentCross ? ` (${ta.macd.recentCross})` : ''}`,
    `Bollinger(20,2): upper=$${ta.bb20.upper.toFixed(2)} mid=$${ta.bb20.mid.toFixed(2)} lower=$${ta.bb20.lower.toFixed(2)}`,
    '',
    'Recent 5-min closes (most recent last):',
    ta.recentCandles.map((c) => `  ${new Date(c.t).toISOString().slice(11, 16)}  $${c.c.toFixed(2)}`).join('\n'),
    '',
    `Bucket grid (${state.outcomes.length} buckets):`,
    buckets,
    '',
    `CURRENT POSITION: bucket ${rctx.heldBucketIndex} (${rctx.heldBucketLabel}), $${rctx.heldUsdtIn.toFixed(2)} deployed`,
    `Round follow-up budget remaining: $${rctx.followupRemaining.toFixed(2)} (max $${CAMPAIGN_FOLLOWUP_BUDGET_USDT}/round)`,
    '',
    'Reply with JSON exactly:',
    '{"action":"HOLD"|"DOUBLE_DOWN"|"SPREAD","bucketIndex":<int|null>,"conviction":<int 0..100>,"thesis":"<<= 240 chars>"}',
    'Rules:',
    '- HOLD → bucketIndex MUST be null',
    '- DOUBLE_DOWN → bucketIndex MUST equal currently-held bucket',
    '- SPREAD → bucketIndex MUST be a different bucket (adjacent preferred)',
  ].join('\n');

  return { system, user };
}

interface ReassessVote extends SwarmVote {
  action: 'HOLD' | 'DOUBLE_DOWN' | 'SPREAD' | null;
}

async function runReassessSwarm(prompt: { system: string; user: string }): Promise<ReassessVote[]> {
  const calls = SWARM_PROVIDERS.map(async (provider): Promise<ReassessVote> => {
    try {
      const r = await callLLM({
        provider,
        system: prompt.system,
        user: prompt.user,
        jsonMode: true,
        maxTokens: 400,
        temperature: 0.3,
        timeoutMs: 45_000,
      });
      const parsed = parseReassessReply(r.text);
      return {
        provider,
        model: r.model,
        action: parsed?.action ?? null,
        bucketIndex: parsed?.bucketIndex ?? null,
        conviction: parsed?.conviction ?? 0,
        thesis: parsed?.thesis ?? '',
        parsed: !!parsed,
        raw: r.text.slice(0, 600),
        latencyMs: r.latencyMs,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
      };
    } catch (err) {
      console.warn(`[fortyTwoCampaign] reassess provider ${provider} failed:`, (err as Error).message);
      return {
        provider, model: '<error>', action: null, bucketIndex: null, conviction: 0,
        thesis: `[${provider} error]`, parsed: false, raw: '',
        latencyMs: 0, inputTokens: 0, outputTokens: 0,
      };
    }
  });
  return Promise.all(calls);
}

function parseReassessReply(raw: string): { action: 'HOLD' | 'DOUBLE_DOWN' | 'SPREAD'; bucketIndex: number | null; conviction: number; thesis: string } | null {
  if (!raw) return null;
  const stripped = raw.replace(/```json\s*|\s*```/g, '').trim();
  try {
    const j = JSON.parse(stripped);
    const action = String(j.action ?? '').toUpperCase();
    if (!['HOLD', 'DOUBLE_DOWN', 'SPREAD'].includes(action)) return null;
    const conviction = Number(j.conviction);
    if (!Number.isFinite(conviction) || conviction < 0 || conviction > 100) return null;
    const thesis = String(j.thesis ?? '').slice(0, 240);
    let bucketIndex: number | null = null;
    if (action !== 'HOLD') {
      const bi = Number(j.bucketIndex);
      if (!Number.isInteger(bi) || bi < 0) return null;
      bucketIndex = bi;
    }
    return { action: action as any, bucketIndex, conviction, thesis };
  } catch {
    return null;
  }
}

interface ReassessDecision {
  action: 'HOLD' | 'DOUBLE_DOWN' | 'SPREAD';
  bucketIndex: number | null;
  sizeUsdt: number;
  thesis: string;
}

/**
 * Aggregator for REASSESS / FINAL ticks. Strategy:
 *   1. If majority (≥3) of parsed votes say HOLD → HOLD.
 *   2. If majority say DOUBLE_DOWN → DOUBLE_DOWN on held bucket, size = avg
 *      conviction of those votes mapped to $0/$20/$30.
 *   3. If majority say SPREAD → SPREAD into the most-voted spread bucket
 *      (tie-break: nearest to spot), size from avg conviction.
 *   4. Plurality fallback uses the same logic with the top action.
 *   5. All-failed-to-parse → HOLD (conservative default).
 */
function aggregateForReassess(
  votes: ReassessVote[],
  state: OnchainMarketState,
  heldBucketIndex: number,
  btcSpot: number,
): ReassessDecision {
  const parsed = votes.filter((v) => v.parsed && v.action);
  if (parsed.length === 0) {
    return { action: 'HOLD', bucketIndex: null, sizeUsdt: 0, thesis: 'all swarm providers failed to parse — defaulting HOLD' };
  }

  const tally = new Map<string, number>();
  for (const v of parsed) tally.set(v.action!, (tally.get(v.action!) ?? 0) + 1);
  const winning = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0] as 'HOLD' | 'DOUBLE_DOWN' | 'SPREAD';

  if (winning === 'HOLD') {
    const supporters = parsed.filter((v) => v.action === 'HOLD');
    const champ = supporters.sort((a, b) => b.conviction - a.conviction)[0];
    return { action: 'HOLD', bucketIndex: null, sizeUsdt: 0, thesis: champ?.thesis ?? 'swarm consensus: HOLD' };
  }

  if (winning === 'DOUBLE_DOWN') {
    const supporters = parsed.filter((v) => v.action === 'DOUBLE_DOWN');
    const avgConv = supporters.reduce((s, v) => s + v.conviction, 0) / supporters.length;
    const sizeUsdt = convictionToSize(avgConv);
    const champ = supporters.sort((a, b) => b.conviction - a.conviction)[0];
    return {
      action: 'DOUBLE_DOWN',
      bucketIndex: heldBucketIndex,
      sizeUsdt,
      thesis: champ?.thesis ?? `swarm DOUBLE_DOWN at avg conv ${avgConv.toFixed(0)}`,
    };
  }

  // SPREAD — pick the most-voted spread bucket, tie-break by spot proximity.
  const spreadVotes = parsed.filter((v) => v.action === 'SPREAD' && v.bucketIndex !== null && v.bucketIndex !== heldBucketIndex);
  if (spreadVotes.length === 0) {
    return { action: 'HOLD', bucketIndex: null, sizeUsdt: 0, thesis: 'SPREAD voted but no valid alt bucket — defaulting HOLD' };
  }
  const spreadTally = new Map<number, number>();
  for (const v of spreadVotes) spreadTally.set(v.bucketIndex!, (spreadTally.get(v.bucketIndex!) ?? 0) + 1);
  const sortedSpread = [...spreadTally.entries()].sort((a, b) => b[1] - a[1]);
  let pickedBucket = sortedSpread[0][0];
  if (sortedSpread.length > 1 && sortedSpread[1][1] === sortedSpread[0][1]) {
    const tied = sortedSpread.filter(([, c]) => c === sortedSpread[0][1]).map(([i]) => i);
    pickedBucket = pickClosestToSpot(tied, state.outcomes, btcSpot);
  }
  const supporters = spreadVotes.filter((v) => v.bucketIndex === pickedBucket);
  const avgConv = supporters.reduce((s, v) => s + v.conviction, 0) / supporters.length;
  const sizeUsdt = convictionToSize(avgConv);
  const champ = supporters.sort((a, b) => b.conviction - a.conviction)[0];
  return {
    action: 'SPREAD',
    bucketIndex: pickedBucket,
    sizeUsdt,
    thesis: champ?.thesis ?? `swarm SPREAD into bucket ${pickedBucket} at avg conv ${avgConv.toFixed(0)}`,
  };
}

// ── Broadcast: TG channel + brain feed ────────────────────────────────────

interface BroadcastInput {
  tick: TickKind;
  roundBoundaryMs: number;
  market: Market42;
  bucketLabel: string;
  bucketIndex: number;
  usdtIn: number;
  impliedProbability: number;
  thesis: string;
  agentId: string;
  userId: string;
  swarm: SwarmVote[];
  action?: 'HOLD' | 'DOUBLE_DOWN' | 'SPREAD' | 'ENTER';
}

/**
 * After each campaign trade, post the thesis to:
 *   1. The mini-app brain feed (AgentLog row tagged exchange='42')
 *   2. A designated Telegram channel (env: FT_CAMPAIGN_TG_CHANNEL)
 * Both are best-effort — neither failure aborts the trade.
 */
async function broadcastCampaignTrade(input: BroadcastInput): Promise<void> {
  const action = input.action ?? (input.tick === 'ENTRY' ? 'ENTER' : 'TRADE');
  const roundIdx = roundIndexForBoundary(input.roundBoundaryMs);
  const mult = input.impliedProbability > 0 ? (1 / input.impliedProbability).toFixed(2) : '∞';
  const headline =
    `Round ${roundIdx}/12 — ${action} bucket ${input.bucketLabel} ` +
    `with $${input.usdtIn.toFixed(2)} (${mult}x multiplier)`;
  const fullText = `${headline}\nThesis: ${input.thesis}`;

  // 1. Brain feed (AgentLog).
  try {
    await db.$executeRawUnsafe(
      `INSERT INTO "AgentLog" ("id","agentId","userId","action","parsedAction","reason","providers","exchange","createdAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6::jsonb, '42', NOW())`,
      input.agentId,
      input.userId,
      `CAMPAIGN_${action}`,
      action,
      fullText.slice(0, 1000),
      JSON.stringify(
        input.swarm.map((v) => ({
          provider: v.provider,
          model: v.model,
          action: v.parsed ? action : null,
          predictionTrade: v.parsed ? { bucketIndex: v.bucketIndex, conviction: v.conviction } : undefined,
          reasoning: v.thesis.slice(0, 300),
          latencyMs: v.latencyMs,
          inputTokens: v.inputTokens,
          outputTokens: v.outputTokens,
          tokensUsed: v.inputTokens + v.outputTokens,
        })),
      ),
    );
  } catch (err) {
    console.warn('[fortyTwoCampaign] brain-feed insert failed:', (err as Error).message);
  }

  // 2. TG channel — public broadcast with one-tap CTA into the mini-app.
  // The whole point of the channel is to funnel viewers into BUILD4, so
  // every post carries two URL buttons: (a) launch the mini-app directly
  // via Telegram's t.me/<bot>/app deep link, and (b) DM the bot via
  // t.me/<bot>?start=campaign for users who'd rather chat first.
  // Channels can only carry url buttons — web_app and callback buttons
  // are silently dropped by Telegram outside private chats.
  const channel = process.env.FT_CAMPAIGN_TG_CHANNEL;
  if (channel) {
    try {
      const bot = getBot();
      if (bot) {
        const username = bot.botInfo?.username;
        const swarmLine = input.swarm.length
          ? `\n\n🧠 *Swarm verdict (${input.swarm.length} models):* ` +
            input.swarm
              .map((v) => `${v.provider}=${v.bucketIndex >= 0 ? 'bucket' + v.bucketIndex : 'err'}`)
              .join(' · ')
          : '';
        const text = `🤖 *${headline}*\n\n${input.thesis}${swarmLine}`;
        const reply_markup = username
          ? {
              inline_keyboard: [
                [
                  { text: '⚡ Open BUILD4 mini-app', url: `https://t.me/${username}/app?startapp=campaign` },
                ],
                [
                  { text: '💬 Start bot', url: `https://t.me/${username}?start=campaign` },
                  { text: '📊 42.space', url: 'https://42.space' },
                ],
              ],
            }
          : undefined;
        await bot.api.sendMessage(channel, text, { parse_mode: 'Markdown', reply_markup });
      }
    } catch (err) {
      console.warn('[fortyTwoCampaign] TG channel post failed:', (err as Error).message);
    }
  }
}

async function writeBrainFeedHold(
  ctx: CampaignContext,
  market: Market42,
  thesis: string,
  tick: TickKind,
  roundBoundaryMs: number,
): Promise<void> {
  const roundIdx = roundIndexForBoundary(roundBoundaryMs);
  await db.$executeRawUnsafe(
    `INSERT INTO "AgentLog" ("id","agentId","userId","action","parsedAction","reason","exchange","createdAt")
     VALUES (gen_random_uuid()::text, $1, $2, 'CAMPAIGN_HOLD', 'HOLD', $3, '42', NOW())`,
    ctx.agentId,
    ctx.userId,
    `Round ${roundIdx}/12 ${tick}: HOLD — ${thesis}`.slice(0, 1000),
  );
}

/**
 * Map a UTC round boundary timestamp to a 1..12 sprint round index.
 * The campaign starts at FT_CAMPAIGN_START_MS (env, ms since epoch). If
 * unset, we report 0 — the broadcast still works, just labelled "Round 0/12".
 */
function roundIndexForBoundary(roundBoundaryMs: number): number {
  const startStr = process.env.FT_CAMPAIGN_START_MS;
  if (!startStr) return 0;
  const start = Number(startStr);
  if (!Number.isFinite(start) || start <= 0) return 0;
  const idx = Math.floor((roundBoundaryMs - start) / (4 * 60 * 60 * 1000)) + 1;
  return Math.max(1, Math.min(12, idx));
}

// ── Campaign context loader ───────────────────────────────────────────────

interface CampaignContext {
  agentId: string;
  userId: string;
  agentMaxPositionSize: number;
}

async function loadCampaignContext(): Promise<CampaignContext | null> {
  const agentId = process.env.FT_CAMPAIGN_AGENT_ID;
  if (process.env.FT_CAMPAIGN_MODE !== 'true' || !agentId) return null;
  if (!isCampaignAgent(agentId)) return null;
  const rows = await db.$queryRawUnsafe<
    Array<{ id: string; userId: string; maxPositionSize: number }>
  >(
    `SELECT id, "userId", "maxPositionSize" FROM "Agent" WHERE id = $1 LIMIT 1`,
    agentId,
  );
  if (!rows.length) return null;
  return {
    agentId: rows[0].id,
    userId: rows[0].userId,
    agentMaxPositionSize: Number(rows[0].maxPositionSize ?? 100),
  };
}

// ── TA packet ─────────────────────────────────────────────────────────────

interface TAPacket {
  btcSpot: number;
  rsi14: number;
  macd: { macdLine: number; signalLine: number; histogram: number; recentCross: string | null };
  atr14: number;
  adx14: number;
  bb20: { upper: number; mid: number; lower: number };
  recentCandles: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>;
}

async function buildTAPacket(): Promise<TAPacket> {
  // 5m × 200 ≈ 16h of context — enough to span the full round window plus a
  // priming buffer for indicators that warm up over ~30 candles.
  const ohlcv: OHLCV = await getKlines('BTCUSDT', '5m', 200);
  const closes = ohlcv.close;
  const btcSpot = closes[closes.length - 1] ?? 0;
  const recent = closes.slice(-12);
  const recentCandles = ohlcv.timestamps.slice(-12).map((t, i) => {
    const offset = ohlcv.timestamps.length - 12;
    return {
      t,
      o: ohlcv.open[offset + i],
      h: ohlcv.high[offset + i],
      l: ohlcv.low[offset + i],
      c: ohlcv.close[offset + i],
      v: ohlcv.volume[offset + i],
    };
  });
  return {
    btcSpot,
    rsi14: calculateRSI(closes, 14),
    macd: calculateMACD(closes),
    atr14: calculateATR(ohlcv, 14),
    adx14: calculateADX(ohlcv, 14),
    bb20: calculateBollingerBands(closes, 20, 2),
    recentCandles,
  };
}

// ── Prompt builder ────────────────────────────────────────────────────────

function buildEntryPrompt(
  market: Market42,
  state: OnchainMarketState,
  ta: TAPacket,
  roundBoundaryMs: number,
): { system: string; user: string } {
  const minutesIntoRound = Math.floor((Date.now() - roundBoundaryMs) / 60_000);
  // 42.space BTC 8h Price Markets: 4h LIVE-TRADING phase, then a separate
  // 4h SETTLEMENT phase. Trading closes at round_open + 4h; the market
  // resolves (and pays out) at round_open + 8h. The agent must predict
  // the bucket containing BTC at the +8h resolution timestamp, NOT at the
  // +4h trading-close — those are different prices and a 2× horizon error.
  const minutesRemaining = Math.max(0, 4 * 60 - minutesIntoRound);
  const tradingCloseIso = new Date(roundBoundaryMs + 4 * 60 * 60 * 1000).toISOString();
  const resolutionIso = new Date(roundBoundaryMs + 8 * 60 * 60 * 1000).toISOString();

  // Bucket grid — index, label, marginal price (= implied probability),
  // approximate multiplier (1 / impliedProb at this snapshot).
  const buckets = state.outcomes
    .map(
      (o) =>
        `  ${o.index.toString().padStart(2)}  ${o.label.padEnd(28)}  ` +
        `prob=${(o.impliedProbability * 100).toFixed(1).padStart(5)}%  ` +
        `mult=${o.impliedProbability > 0 ? (1 / o.impliedProbability).toFixed(2) : '∞'}x`,
    )
    .join('\n');

  // Crowd-consensus bucket = highest implied probability.
  const crowdConsensus = state.outcomes.reduce((best, o) =>
    o.impliedProbability > best.impliedProbability ? o : best,
  );

  const system = [
    'You are a senior BTC quant trader on the BUILD4 campaign agent.',
    'Your job: predict where BTC will SETTLE at the resolution timestamp on a',
    '42.space BTC 8-hour Price Market and pick the bucket that contains that price.',
    'Market lifecycle: 4h live-trading phase, then 4h settlement phase — total',
    '8h from round-open to resolution. You are entering during the trading phase,',
    'but your TA target is BTC price 8 HOURS AFTER round-open (NOT 4h).',
    'Buckets are mutually exclusive. The bucket containing BTC at resolution wins;',
    'all others pay $0. You MUST pick a bucket — abstaining is not allowed',
    '(always-trade rule). Reply with strict JSON only, no prose, no code fences.',
  ].join(' ');

  const user = [
    `Market: ${market.question}`,
    `Round opened:        ${new Date(roundBoundaryMs).toISOString()}`,
    `Trading closes:      ${tradingCloseIso}  (round_open + 4h)`,
    `RESOLUTION TARGET:   ${resolutionIso}  (round_open + 8h — your prediction horizon)`,
    `Trading window remaining: ${minutesRemaining} min  (elapsed ${minutesIntoRound} min)`,
    '',
    `BTC spot now: $${ta.btcSpot.toFixed(2)}`,
    `RSI(14): ${ta.rsi14.toFixed(1)}   ADX(14): ${ta.adx14.toFixed(1)}   ATR(14): $${ta.atr14.toFixed(2)}`,
    `MACD: line=${ta.macd.macdLine.toFixed(2)} signal=${ta.macd.signalLine.toFixed(2)} hist=${ta.macd.histogram.toFixed(2)}${ta.macd.recentCross ? ` (${ta.macd.recentCross})` : ''}`,
    `Bollinger(20,2): upper=$${ta.bb20.upper.toFixed(2)} mid=$${ta.bb20.mid.toFixed(2)} lower=$${ta.bb20.lower.toFixed(2)}`,
    '',
    'Recent 5-min closes (most recent last):',
    ta.recentCandles.map((c) => `  ${new Date(c.t).toISOString().slice(11, 16)}  $${c.c.toFixed(2)}`).join('\n'),
    '',
    `Bucket grid (${state.outcomes.length} buckets):`,
    buckets,
    '',
    `Crowd consensus: bucket ${crowdConsensus.index} (${crowdConsensus.label}) at ${(crowdConsensus.impliedProbability * 100).toFixed(1)}%`,
    '',
    'Reply with JSON exactly:',
    '{"bucketIndex": <int 0..N-1>, "conviction": <int 0..100>, "thesis": "<<= 240 chars>"}',
  ].join('\n');

  return { system, user };
}

// ── Swarm runner ──────────────────────────────────────────────────────────

interface SwarmVote {
  provider: Provider;
  model: string;
  bucketIndex: number | null;
  conviction: number;
  thesis: string;
  parsed: boolean;
  raw: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

async function runSwarm(prompt: { system: string; user: string }): Promise<SwarmVote[]> {
  const calls = SWARM_PROVIDERS.map(async (provider): Promise<SwarmVote> => {
    try {
      const r = await callLLM({
        provider,
        system: prompt.system,
        user: prompt.user,
        jsonMode: true,
        maxTokens: 400,
        temperature: 0.3,
        timeoutMs: 45_000,
      });
      const parsed = parseSwarmReply(r.text);
      return {
        provider,
        model: r.model,
        bucketIndex: parsed?.bucketIndex ?? null,
        conviction: parsed?.conviction ?? 0,
        thesis: parsed?.thesis ?? '',
        parsed: !!parsed,
        raw: r.text.slice(0, 600),
        latencyMs: r.latencyMs,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
      };
    } catch (err) {
      console.warn(`[fortyTwoCampaign] swarm provider ${provider} failed:`, (err as Error).message);
      return {
        provider,
        model: '<error>',
        bucketIndex: null,
        conviction: 0,
        thesis: `[${provider} error: ${(err as Error).message.slice(0, 200)}]`,
        parsed: false,
        raw: '',
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
    }
  });
  return Promise.all(calls);
}

function parseSwarmReply(raw: string): { bucketIndex: number; conviction: number; thesis: string } | null {
  if (!raw) return null;
  // Some providers wrap JSON in code fences even with jsonMode set.
  const stripped = raw.replace(/```json\s*|\s*```/g, '').trim();
  try {
    const j = JSON.parse(stripped);
    const bucketIndex = Number(j.bucketIndex);
    const conviction = Number(j.conviction);
    const thesis = String(j.thesis ?? '').slice(0, 240);
    if (!Number.isInteger(bucketIndex) || bucketIndex < 0) return null;
    if (!Number.isFinite(conviction) || conviction < 0 || conviction > 100) return null;
    return { bucketIndex, conviction, thesis };
  } catch {
    return null;
  }
}

// ── Aggregator (always-trade tie-break) ───────────────────────────────────

interface SwarmDecision {
  bucketIndex: number;
  thesis: string;
}

/**
 * Always-trade aggregator for ENTRY ticks. Tie-break order:
 *   1. Unanimous parsed picks → that bucket
 *   2. Strict majority (≥3 of 4) → that bucket
 *   3. Plurality among parsed picks → that bucket
 *   4. Two-way tie → bucket nearest to BTC spot
 *   5. All-failed-to-parse → crowd-consensus bucket (highest impliedProb)
 */
function aggregateForEntry(
  votes: SwarmVote[],
  state: OnchainMarketState,
  btcSpot: number,
): SwarmDecision {
  const parsedVotes = votes.filter((v) => v.parsed && v.bucketIndex !== null);

  // Tally bucket picks across parsed votes.
  const tally = new Map<number, number>();
  for (const v of parsedVotes) {
    if (v.bucketIndex === null) continue;
    tally.set(v.bucketIndex, (tally.get(v.bucketIndex) ?? 0) + 1);
  }

  const sortedTally = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  let pickedBucket: number;

  if (sortedTally.length === 0) {
    // All providers failed → crowd-consensus fallback.
    pickedBucket = state.outcomes.reduce((best, o) =>
      o.impliedProbability > best.impliedProbability ? o : best,
    ).index;
  } else if (sortedTally[0][1] >= 3) {
    // Unanimous (4) or strict majority (3) → take it.
    pickedBucket = sortedTally[0][0];
  } else if (sortedTally.length === 1 || sortedTally[0][1] > sortedTally[1][1]) {
    // Clear plurality (2-1-1 or 2-1).
    pickedBucket = sortedTally[0][0];
  } else {
    // 2-2 tie → nearest-to-spot wins.
    const top = sortedTally
      .filter(([, c]) => c === sortedTally[0][1])
      .map(([idx]) => idx);
    pickedBucket = pickClosestToSpot(top, state.outcomes, btcSpot);
  }

  // Compose a thesis: prefer the highest-conviction parsed vote that picked
  // the winning bucket. Fall back to a neutral one-liner.
  const supporters = parsedVotes.filter((v) => v.bucketIndex === pickedBucket);
  const champion = supporters.sort((a, b) => b.conviction - a.conviction)[0];
  const thesis =
    champion?.thesis ||
    `Swarm aggregated to bucket ${pickedBucket} from ${parsedVotes.length}/${votes.length} parsed votes`;

  return { bucketIndex: pickedBucket, thesis };
}

/** Parse "$96k-$98k" / "98000-100000" / "<= 95000" style labels and pick the
 *  bucket whose midpoint is closest to spot. Falls back to first candidate
 *  when labels can't be parsed. */
function pickClosestToSpot(
  candidates: number[],
  outcomes: OnchainOutcome[],
  spot: number,
): number {
  let best = candidates[0];
  let bestDelta = Infinity;
  for (const idx of candidates) {
    const o = outcomes.find((x) => x.index === idx);
    if (!o) continue;
    const mid = parseLabelMidpoint(o.label);
    if (mid === null) continue;
    const delta = Math.abs(mid - spot);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = idx;
    }
  }
  return best;
}

function parseLabelMidpoint(label: string): number | null {
  const cleaned = label.replace(/,/g, '').replace(/\$/g, '');
  // Range form: "96000-98000" or "96k-98k"
  const range = cleaned.match(/(\d+(?:\.\d+)?)(k)?\s*[-–]\s*(\d+(?:\.\d+)?)(k)?/i);
  if (range) {
    const a = parseFloat(range[1]) * (range[2] ? 1000 : 1);
    const b = parseFloat(range[3]) * (range[4] ? 1000 : 1);
    if (Number.isFinite(a) && Number.isFinite(b)) return (a + b) / 2;
  }
  // Open-ended: "<= 95000" / ">= 100000"
  const openEnded = cleaned.match(/(?:<=?|>=?)\s*(\d+(?:\.\d+)?)(k)?/i);
  if (openEnded) {
    const v = parseFloat(openEnded[1]) * (openEnded[2] ? 1000 : 1);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

// ── Test seam ─────────────────────────────────────────────────────────────

export const __testInternals = {
  parseSwarmReply,
  parseLabelMidpoint,
  pickClosestToSpot,
  aggregateForEntry,
  buildEntryPrompt,
};
