// ─── Centralised market scan ─────────────────────────────────────────────────
// One LLM call per (pair, mode) per tick — shared across every agent that
// happens to be watching the same pair. Per-user preferences (Kelly size,
// leverage clamp, memory veto, drawdown mode) are applied by the agent layer
// AFTER this scan returns; nothing user-specific belongs in the LLM prompt.
//
// Why this exists:
//   With N agents all watching BTC/USDT we were burning N Claude calls per
//   minute on identical market data — Aster team's ANTHROPIC credit balance
//   was hitting zero within hours under modest user load. Centralising the
//   market read collapses that to 1 call/min/pair/mode regardless of how
//   many agents are subscribed.
//
// Cache shape:
//   key = `${pair}:${mode}` where mode ∈ {standard, momentum}
//   value = { expiresAt, promise }
//
//   Concurrent ticks for the same key share the in-flight promise (no
//   thundering herd on cache miss). Once resolved, the cached value lives
//   for SCAN_TTL_MS (default 60s — matches the cron interval).
//
// What the LLM sees:
//   - Market context for the pair (15m+1h+4h or 1m+5m for new listings)
//   - Funding rate
//   - News intelligence signal (already process-shared)
//   - 42.space prediction-market context (already process-shared)
//
// What the LLM does NOT see:
//   - Agent name, max position, max leverage, SL/TP %, max daily loss
//   - Per-agent open positions, recent trade history, today's PnL
//   - Per-agent memory or corrections
//   - Kelly position-size budget
//
// Returned MarketScan therefore carries a *generic market verdict*: regime,
// setupScore, recommended direction (LONG/SHORT/HOLD), entry zone, stop
// loss, take profit, R/R, confidence, reasoning, keyRisks. Sizing and
// leverage fields on the AgentDecision are intentionally null — agents
// fill them in deterministically post-scan.

import {
  AgentDecision,
  runDecisionLLM,
  buildMarketContext,
  buildMomentumContext,
  type RunDecisionLLMResult,
} from './tradingAgent'
import {
  calculateRSI,
  calculateADX,
  calculateEMA,
  type OHLCV,
} from './indicators'

// ─── Config ──────────────────────────────────────────────────────────────────
// 60s default matches the agent runner cron tick. Override in tests via
// _resetMarketScanCacheForTest({ ttlMs }).
const DEFAULT_SCAN_TTL_MS = 60_000
// Negative-cache cooldown: when an LLM call fails, don't allow a fresh
// retry for this many ms. Prevents retry storms after a provider outage
// (otherwise N agents racing on a hot pair each fire their own retry on
// the next tick → exactly the cost spike we built this module to prevent).
const DEFAULT_FAILURE_COOLDOWN_MS = 10_000

let SCAN_TTL_MS = DEFAULT_SCAN_TTL_MS
let FAILURE_COOLDOWN_MS = DEFAULT_FAILURE_COOLDOWN_MS

// ─── Cache ───────────────────────────────────────────────────────────────────
// Entries can be in three states:
//   in-flight:   promise pending, expiresAt = +∞ (other callers must
//                always dedupe onto it regardless of TTL — the whole point
//                of this module)
//   fresh:       promise resolved, expiresAt = resolveTime + SCAN_TTL_MS
//   negative:    promise rejected, expiresAt = failTime + FAILURE_COOLDOWN_MS
//                cachedError carries the rejection reason. Calls during this
//                window re-throw without firing a new LLM call.
//
// The in-flight invariant matters: previously expiresAt was set at launch,
// so a slow LLM call (>TTL) would let a later caller see the entry as
// expired and launch a *second* call while the first was still running —
// defeating dedupe exactly when providers were degraded and we needed it
// most.
type CacheEntry =
  | { kind: 'inflight'; promise: Promise<MarketScan> }
  | { kind: 'fresh'; expiresAt: number; promise: Promise<MarketScan> }
  | { kind: 'negative'; expiresAt: number; cachedError: Error }
const scanCache = new Map<string, CacheEntry>()

// Pair canonicalisation. Phase 1B's runAgentTick calls us from many code
// paths (some pass `BTC/USDT`, some `btcusdt`, some `BTCUSDT`). Without
// normalisation those would become three separate cache entries → 3 LLM
// calls instead of 1 — silently leaking the cost savings. Mirrors the
// expandPairs() normalisation in tradingAgent.
function canonicalPair(pair: string): string {
  return (pair ?? '').replace(/[\/\s]/g, '').toUpperCase()
}

// Sentinel wrapper used to mark errors that came out of the LLM call
// (provider timeout, upstream 5xx, quota, circuit-breaker). Only these
// are eligible for the negative-cache cooldown. Local errors —
// validation, contract violations, OHLCV missing, programmer bugs —
// MUST surface immediately on every call so they can be debugged
// instead of being suppressed for 10s and obscuring the root cause.
class LLMScanError extends Error {
  readonly cause: unknown
  constructor(cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause)
    super(msg)
    this.name = 'LLMScanError'
    this.cause = cause
  }
}

// In-memory counters for observability via /scanstats admin endpoint (to be
// added). hits = served from cache, misses = LLM call actually fired,
// dedupes = concurrent caller awaited an in-flight promise instead of
// triggering its own call.
let _scanHits = 0
let _scanMisses = 0
let _scanDedupes = 0

export function getMarketScanCounters(): {
  hits: number
  misses: number
  dedupes: number
  cacheSize: number
} {
  return {
    hits: _scanHits,
    misses: _scanMisses,
    dedupes: _scanDedupes,
    cacheSize: scanCache.size,
  }
}

export function _resetMarketScanCacheForTest(opts?: {
  ttlMs?: number
  failureCooldownMs?: number
}): void {
  scanCache.clear()
  _scanHits = 0
  _scanMisses = 0
  _scanDedupes = 0
  SCAN_TTL_MS = opts?.ttlMs ?? DEFAULT_SCAN_TTL_MS
  FAILURE_COOLDOWN_MS = opts?.failureCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS
}

// ─── Public types ────────────────────────────────────────────────────────────
export type ScanMode = 'standard' | 'momentum'

export interface MarketScanInputs {
  pair: string
  mode: ScanMode
  // Pre-fetched OHLCV. Either (15m,1h,4h) for standard or (1m,5m) for
  // momentum mode. Caller fetches via the existing process-wide kline
  // cache so we don't double-pay the Aster API.
  ohlcv?: { '15m': OHLCV; '1h': OHLCV; '4h': OHLCV }
  momentumOhlcv?: { '1m': OHLCV; '5m': OHLCV }
  // Estimate of how many hours since first listing — only used for momentum
  // mode prompt context. Ignored in standard mode.
  hoursOldIfMomentum?: number
  // Funding rate as decimal (e.g. 0.0001 == 0.01% per interval). Optional;
  // if omitted the funding section is skipped from the prompt.
  fundingRate?: number
}

// The shared scan's decision is narrower than a per-agent AgentDecision:
//   action: never CLOSE (closing is a per-agent call — it depends on
//           whether *that* agent holds a position on this pair). CLOSE
//           is preserved on `sharedActionRaw` instead.
//   size/leverage: always null (filled by the agent layer from Kelly
//           tier + agent.maxLeverage clamp).
// Encoding these invariants in the type prevents the per-agent layer
// from accidentally trusting a CLOSE that the runtime would never emit,
// and stops a future contributor from silently letting a non-null
// size/leverage leak through prompt drift.
export type SharedAction = 'OPEN_LONG' | 'OPEN_SHORT' | 'HOLD'
export type SharedMarketDecision = Omit<
  AgentDecision,
  'action' | 'size' | 'leverage'
> & {
  action: SharedAction
  size: null
  leverage: null
}

export interface MarketScan {
  pair: string
  mode: ScanMode
  scannedAt: number
  // Snapshot used for logging / live-feed rendering. Computed once per scan
  // so all subscriber agents see the exact same numbers.
  snapshot: {
    price: number
    rsi: number
    adx: number
    regime: string
  }
  // Generic market verdict from the LLM. See SharedMarketDecision above
  // for the runtime invariants the type encodes.
  decision: SharedMarketDecision
  // The action the LLM actually returned, before our CLOSE→HOLD safety
  // downgrade. The agent layer reads this when deciding whether to close
  // an existing position; e.g. if sharedActionRaw==='CLOSE' AND the agent
  // holds a position on this pair, that's an exit signal.
  sharedActionRaw: AgentDecision['action']
  rawResponse: string
  providersTelemetry:
    | import('../services/fortyTwoExecutor').ProviderTelemetry[]
    | null
}

// ─── Dependencies (injectable for tests) ─────────────────────────────────────
export interface MarketScanDeps {
  // Defaults to the real runDecisionLLM from tradingAgent. Tests can stub
  // this to skip the network entirely.
  runLLM?: (
    swarmOn: boolean,
    sysPrompt: string,
    userMessage: string,
  ) => Promise<RunDecisionLLMResult>
  // Cached fetchers — defaults to the live services. Tests can stub these
  // so news/prediction context don't trigger network calls.
  fetchNewsBlock?: () => Promise<string>
  fetchPredictionBlock?: () => Promise<string>
  // Whether to ask the swarm. Production resolves this per-user; the
  // shared scan uses swarm=true because it's the same call regardless of
  // which user triggered it (and the swarm gives us per-pair telemetry
  // that the divergence watch consumes). Override in tests.
  swarmOn?: boolean
  now?: () => number
}

// ─── Prompt construction ─────────────────────────────────────────────────────
// User-agnostic. The agent layer applies size/leverage/memory/risk gates
// AFTER the LLM responds.
const MARKET_SCAN_SYSTEM_PROMPT = `You are BUILD4 MARKET SCAN — a pure technical/market analyst for crypto perpetual futures. Your job is to read the data and produce a generic market verdict for a single pair. You are NOT trading on behalf of any specific user; downstream code applies user risk preferences, position sizing, and leverage caps.

OUTPUT CONSTRAINTS:
- size MUST be null (the agent layer sets size from each user's Kelly tier).
- leverage MUST be null (clamped per-agent to that user's max).
- action MUST be one of: OPEN_LONG | OPEN_SHORT | HOLD. Never CLOSE — closing is per-agent and depends on whether THAT agent holds a position.
- All other fields (entryZone, stopLoss, takeProfit, riskRewardRatio, confidence, reasoning, keyRisks, regime, setupScore, timeframeAlignment) are mandatory when action ≠ HOLD.

DECISION FRAMEWORK (apply in order):

1. REGIME IDENTIFICATION
   - ADX > 25 + higher highs/lows = UPTREND → only consider LONG setups
   - ADX > 25 + lower highs/lows = DOWNTREND → only consider SHORT setups
   - ADX < 20 = RANGING → mean-reversion only, mark setupScore lower
   - ADX 20-25 = TRANSITIONING → prefer HOLD until confirmation

2. TIMEFRAME ALIGNMENT (need ≥2 of 4 agreeing):
   - 4h trend (EMA200), 1h trend (EMA50), 15m momentum (MACD+RSI), volume confirmation

3. ENTRY QUALITY SCORE (0-10):
   - Trend alignment across all timeframes: +3
   - At key support/resistance: +2
   - RSI not extreme against direction: +1
   - Volume above average: +1
   - Bollinger context favorable: +1
   - MACD cross in direction within 3 bars: +1
   - Clean recent candle structure: +1
   Score 7-10 = high confidence | 5-6 = moderate | 4 = marginal | 0-3 = HOLD

4. RISK STRUCTURE
   - Stop loss: just beyond nearest swing low/high, NOT an arbitrary %
   - R/R after proper SL/TP placement < 1.5 → action = HOLD
   - Confidence < 0.55 → action = HOLD

5. NEWS / FUNDING CONTEXT
   - Strong negative news with NEWS OVERRIDE flag → bias toward HOLD or SHORT
   - Funding > 0.02% (longs paying shorts) → favours SHORT bias on tops
   - Funding < -0.02% (shorts paying longs) → favours LONG bias on bottoms

PREDICTION-MARKET SIDECAR (predictionTrade field, optional):
- Set ONLY when your independent conviction beats implied probability by ≥5pp.
- Use exact marketAddress + tokenId from the prompt block.
- Reasoning MUST quote: market name, implied %, your %, edge in pp, sizing ("≤$2 USDT").
- Never CLOSE_PREDICTION here — closing is per-agent.

RESPOND WITH VALID JSON ONLY. No preamble, no markdown fences. Schema:
{
  "regime": "UPTREND" | "DOWNTREND" | "RANGING" | "TRANSITIONING",
  "setupScore": 0-10,
  "timeframeAlignment": { "4h": "BULLISH"|"BEARISH"|"NEUTRAL", "1h": "...", "15m": "...", "volume": "CONFIRMING"|"DIVERGING"|"NEUTRAL" },
  "action": "OPEN_LONG" | "OPEN_SHORT" | "HOLD",
  "pair": "<echo>",
  "entryZone": { "low": <price>, "high": <price> } | null,
  "stopLoss": <price> | null,
  "takeProfit": <price> | null,
  "size": null,
  "leverage": null,
  "riskRewardRatio": <number> | null,
  "confidence": 0..1,
  "reasoning": "3-5 sentences: regime, signals, why R/R favourable, what would invalidate.",
  "keyRisks": ["risk 1", "risk 2"],
  "memoryUpdate": null,
  "drawdownMode": false,
  "holdReason": <string for HOLD, null otherwise>,
  "predictionTrade": null | { ... }
}`

const MARKET_SCAN_MOMENTUM_PROMPT = `You are BUILD4 MARKET SCAN — NEW LISTING MOMENTUM mode. The pair was onboarded on Aster within the last 48 hours, so multi-timeframe TA is impossible (no EMA200 history). Read raw 1m+5m volume and price action and produce a generic market verdict. You are NOT trading for any specific user — sizing and leverage are filled in downstream.

OUTPUT CONSTRAINTS:
- size MUST be null. leverage MUST be null. action ∈ {OPEN_LONG, OPEN_SHORT, HOLD} only (no CLOSE).
- Acceptable R/R: ≥1.5 (this is a momentum scalp, not a swing).
- timeframeAlignment fields may be "INSUFFICIENT_DATA".
- regime should describe the listing phase: "DISCOVERY" | "PUMP" | "EXHAUSTION" | "CONSOLIDATION" | "DUMP".

DECISION RULES:

1. DIRECTION
   - Strong upward expansion candles + rising volume → LONG
   - Vertical pump >100% from listing → SHORT first sign of exhaustion (long upper wick, declining volume on green)
   - Sideways consolidation → wait for breakout direction
   - Unclear → HOLD

2. STOPS
   - Stop loss: 2-4% from entry (NOT swing low — too little history)
   - Take profit: 5-15% (asymmetric R/R)

3. CONFIDENCE
   - Only need 2 confirming signals to enter (vs 3-4 in standard mode)
   - confidence ≥ 0.55 still required
   - setupScore ≥ 4 to act

4. NO-CHASE
   - If price moved >5% in last 5 minutes → HOLD (don't chase the candle)

RESPOND WITH VALID JSON ONLY (same schema as standard mode). For HOLD set entry/stop/take/RR to null and provide holdReason.`

// ─── Context block builder ───────────────────────────────────────────────────
// Picks standard or momentum context based on mode. Throws if the matching
// OHLCV bundle wasn't supplied — runtime contract: caller must pre-fetch.
function buildContextForScan(inputs: MarketScanInputs): string {
  if (inputs.mode === 'momentum') {
    if (!inputs.momentumOhlcv) {
      throw new Error('marketScan: momentum mode requires momentumOhlcv')
    }
    return buildMomentumContext(
      inputs.momentumOhlcv['1m'],
      inputs.momentumOhlcv['5m'],
      inputs.pair,
      inputs.hoursOldIfMomentum ?? 0,
    )
  }
  if (!inputs.ohlcv) {
    throw new Error('marketScan: standard mode requires ohlcv (15m,1h,4h)')
  }
  return buildMarketContext(
    inputs.ohlcv['15m'],
    inputs.ohlcv['1h'],
    inputs.ohlcv['4h'],
    inputs.pair,
  )
}

// ─── Indicator snapshot — used both for the live "Agent Brain" feed and
// for downstream display. Computed once per scan so every subscriber agent
// sees identical numbers (no per-agent drift from re-computing on slightly
// different candles).
function buildSnapshot(inputs: MarketScanInputs): MarketScan['snapshot'] {
  if (inputs.mode === 'momentum' && inputs.momentumOhlcv) {
    const closes = inputs.momentumOhlcv['1m'].close
    return {
      price: closes[closes.length - 1] ?? 0,
      rsi: 0,
      adx: 0,
      regime: 'NEW_LISTING',
    }
  }
  if (inputs.ohlcv) {
    const tf15 = inputs.ohlcv['15m']
    const tf1h = inputs.ohlcv['1h']
    const tf4h = inputs.ohlcv['4h']
    const price = tf15.close[tf15.close.length - 1] ?? 0
    const rsi = calculateRSI(tf15.close, 14)
    const adx = calculateADX(tf1h, 14)
    const regime =
      adx > 25
        ? calculateEMA(tf15.close, 9) > calculateEMA(tf4h.close, 200)
          ? 'TRENDING UP'
          : 'TRENDING DOWN'
        : 'RANGING'
    return { price, rsi, adx, regime }
  }
  return { price: 0, rsi: 0, adx: 0, regime: 'UNKNOWN' }
}

// ─── Main entry point ────────────────────────────────────────────────────────
// Returns a cached MarketScan if one is fresh, dedupes onto the in-flight
// promise if a call is already running, surfaces the cached error during
// the negative-cooldown window, otherwise fires a new LLM call.
//
// NOTE: this function does NOT fetch klines itself. The caller (runAgentTick)
// already does that via the process-wide aster.getKlines cache, so passing
// the OHLCV in keeps a single source of truth. We only build the *prompt
// context* and call the LLM here.
export async function getSharedMarketScan(
  inputs: MarketScanInputs,
  deps: MarketScanDeps = {},
): Promise<MarketScan> {
  const now = deps.now ?? Date.now
  const pair = canonicalPair(inputs.pair)
  // Cache key includes swarmOn because the LLM call path differs (swarm
  // multi-provider quorum vs single-provider Anthropic). Without this,
  // the first caller's swarm preference would silently determine the
  // verdict for every other agent on this pair within the TTL — a
  // cross-user consistency bug. With it, dedupe still works perfectly
  // within each (pair, mode, swarmOn) bucket, which is the right
  // granularity (at most 2x cache entries per pair).
  const swarmOn = deps.swarmOn ?? true
  const key = `${pair}:${inputs.mode}:${swarmOn ? 'swarm' : 'solo'}`

  const existing = scanCache.get(key)
  if (existing) {
    if (existing.kind === 'inflight') {
      // First-class dedupe: a call is already in flight for this key.
      // Counts as a hit for stats (it spared us a network call).
      _scanHits += 1
      return existing.promise
    }
    if (existing.kind === 'fresh' && existing.expiresAt > now()) {
      _scanHits += 1
      return existing.promise
    }
    if (existing.kind === 'negative' && existing.expiresAt > now()) {
      _scanHits += 1
      // Re-throw the cached error rather than re-firing the LLM —
      // protects providers from a retry storm during outages.
      throw existing.cachedError
    }
    // stale (fresh expired or negative cooldown elapsed) → fall through
  }

  _scanMisses += 1
  const launchedAt = now()
  const promise = runMarketScan({ ...inputs, pair }, deps).then(
    (scan) => {
      // Promote in-flight → fresh. TTL counted from completion time, not
      // launch time, so a slow LLM call doesn't immediately expire on
      // resolve.
      scanCache.set(key, {
        kind: 'fresh',
        expiresAt: now() + SCAN_TTL_MS,
        promise: Promise.resolve(scan),
      })
      void launchedAt // kept for future latency telemetry
      return scan
    },
    (err: unknown) => {
      // Only LLM/provider failures earn a negative-cache cooldown.
      // Local failures (validation, missing OHLCV, programmer bugs)
      // simply evict the in-flight entry so the next call re-runs and
      // either reproduces the bug for debugging or recovers if the
      // caller fixed its inputs. Without this guard, a bad input on a
      // hot pair would suppress all scans for that pair for 10s and
      // hide the root cause.
      const isLLMError = err instanceof LLMScanError
      const underlying = isLLMError
        ? (err as LLMScanError).cause instanceof Error
          ? ((err as LLMScanError).cause as Error)
          : new Error(String((err as LLMScanError).cause))
        : err instanceof Error
          ? err
          : new Error(String(err))
      if (isLLMError) {
        scanCache.set(key, {
          kind: 'negative',
          expiresAt: now() + FAILURE_COOLDOWN_MS,
          cachedError: underlying,
        })
      } else {
        // Local error: evict so the next call retries immediately.
        scanCache.delete(key)
      }
      throw underlying
    },
  )
  scanCache.set(key, { kind: 'inflight', promise })
  return promise
}

// Concurrent-caller helper exposed for the runner to dedupe the prefetch
// pass. Same as getSharedMarketScan but counts cache reuse as a "dedupe"
// in the stats — useful for distinguishing the prefetch path from
// per-agent reads when reading /scanstats.
export function peekOrLaunchScan(
  inputs: MarketScanInputs,
  deps: MarketScanDeps = {},
): Promise<MarketScan> {
  const now = deps.now ?? Date.now
  const pair = canonicalPair(inputs.pair)
  // Same cache key shape as getSharedMarketScan — see comment there.
  const swarmOn = deps.swarmOn ?? true
  const key = `${pair}:${inputs.mode}:${swarmOn ? 'swarm' : 'solo'}`
  const existing = scanCache.get(key)
  if (existing) {
    if (
      existing.kind === 'inflight' ||
      (existing.kind === 'fresh' && existing.expiresAt > now())
    ) {
      _scanDedupes += 1
      return existing.promise
    }
    if (existing.kind === 'negative' && existing.expiresAt > now()) {
      _scanDedupes += 1
      return Promise.reject(existing.cachedError)
    }
  }
  return getSharedMarketScan(inputs, deps)
}

// ─── Internals ───────────────────────────────────────────────────────────────
async function runMarketScan(
  inputs: MarketScanInputs,
  deps: MarketScanDeps,
): Promise<MarketScan> {
  const snapshot = buildSnapshot(inputs)

  const sysPrompt =
    inputs.mode === 'momentum'
      ? MARKET_SCAN_MOMENTUM_PROMPT
      : MARKET_SCAN_SYSTEM_PROMPT

  const marketContextBlock = buildContextForScan(inputs)

  const fundingBlock = formatFundingBlock(inputs.fundingRate)
  const newsBlock = deps.fetchNewsBlock ? await deps.fetchNewsBlock().catch(() => '') : ''
  const predBlock = deps.fetchPredictionBlock
    ? await deps.fetchPredictionBlock().catch(() => '')
    : ''

  const userMessage = [
    '=== MARKET DATA ===',
    marketContextBlock,
    fundingBlock,
    newsBlock,
    predBlock,
    '',
    '=== YOUR TASK ===',
    `Analyze the market data above for ${inputs.pair}.`,
    'Apply your decision framework: regime → alignment → setup score → risk management.',
    'Return your decision as JSON. size and leverage MUST be null — the agent layer fills them in.',
    'If you would not put real money in this trade right now, action = HOLD.',
  ]
    .filter((s) => s !== '')
    .join('\n')

  const swarmOn = deps.swarmOn ?? true
  const runLLM = deps.runLLM ?? runDecisionLLM
  // Wrap the LLM call only — local validation/contract errors above and
  // the response-shaping below are NOT eligible for the negative-cache
  // cooldown. Anything thrown out of the provider call is a candidate
  // for retry-storm protection; anything else surfaces immediately.
  let llmResult: Awaited<ReturnType<typeof runDecisionLLM>>
  try {
    llmResult = await runLLM(swarmOn, sysPrompt, userMessage)
  } catch (e) {
    throw new LLMScanError(e)
  }

  // Capture the raw action BEFORE any downgrade, so the per-agent layer
  // can act on a CLOSE signal when that agent actually holds a position
  // on this pair. Without this, a swarm consensus of "exit now" would
  // disappear into the HOLD bucket and every position-holder would just
  // sit through a breakdown.
  const sharedActionRaw: AgentDecision['action'] = llmResult.decision.action

  // Defensive: enforce the size/leverage = null AND no-CLOSE contract
  // regardless of what the model returned. Cheap insurance against prompt
  // drift; the SharedMarketDecision type encodes the same invariants at
  // compile time so per-agent code can pattern-match safely.
  const baseAction: SharedAction =
    llmResult.decision.action === 'CLOSE' ? 'HOLD' : llmResult.decision.action
  const decision: SharedMarketDecision = {
    ...llmResult.decision,
    pair: inputs.pair,
    action: baseAction,
    size: null,
    leverage: null,
    holdReason:
      llmResult.decision.action === 'CLOSE'
        ? (llmResult.decision.holdReason ??
          'Shared scan downgraded CLOSE → HOLD; per-agent layer decides exits via sharedActionRaw.')
        : llmResult.decision.holdReason,
  }

  return {
    pair: inputs.pair,
    mode: inputs.mode,
    scannedAt: (deps.now ?? Date.now)(),
    snapshot,
    decision,
    sharedActionRaw,
    rawResponse: llmResult.rawResponse,
    providersTelemetry: llmResult.providersTelemetry,
  }
}

function formatFundingBlock(fundingRate?: number): string {
  if (typeof fundingRate !== 'number' || !Number.isFinite(fundingRate)) return ''
  const fundingPct = fundingRate * 100
  const interp =
    fundingRate > 0
      ? 'market overleveraged LONG — shorts have statistical edge this period'
      : fundingRate < 0
        ? 'market overleveraged SHORT — longs have statistical edge this period'
        : 'neutral'
  return `\n=== FUNDING RATE ===\nCurrent funding rate: ${
    fundingPct >= 0 ? '+' : ''
  }${fundingPct.toFixed(4)}% (${interp})`
}

// This module's public surface is intentionally minimal: getSharedMarketScan,
// peekOrLaunchScan, getMarketScanCounters, and the test-only reset helper.
// runDecisionLLM (imported from tradingAgent) owns the actual Anthropic /
// swarm client wiring, so we don't re-instantiate anything here.
