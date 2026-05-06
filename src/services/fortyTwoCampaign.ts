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

  // 5. REASSESS / FINAL not yet wired — scheduler still fires them so we
  //    can persist a planning row, but no trade is placed. Filled in v2.
  if (tick !== 'ENTRY') {
    console.log(
      `[fortyTwoCampaign] ${tick} tick fired for round ${roundBoundaryMs} on ${market.address} ` +
        `— DOUBLE_DOWN/SPREAD logic not yet implemented (see session_plan.md T009)`,
    );
    return {
      ok: true,
      tick,
      roundBoundaryMs,
      marketAddress: market.address,
      reason: 'reassess/final ticks pending T009 implementation',
    };
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
  const minutesRemaining = Math.max(0, 4 * 60 - minutesIntoRound);

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
    'Your job: pick ONE price bucket for the next 4-hour round on a 42.space',
    'BTC 8-hour Price Market. Buckets are mutually exclusive. The bucket whose',
    'price range contains BTC at round-end wins; all other buckets pay $0.',
    'You MUST pick a bucket — abstaining is not allowed (always-trade rule).',
    'Reply with strict JSON only, no prose, no code fences.',
  ].join(' ');

  const user = [
    `Market: ${market.question}`,
    `Round opened: ${new Date(roundBoundaryMs).toISOString()} UTC`,
    `Time elapsed: ${minutesIntoRound} min  |  remaining: ${minutesRemaining} min`,
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
