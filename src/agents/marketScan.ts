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

let SCAN_TTL_MS = DEFAULT_SCAN_TTL_MS

// ─── Cache ───────────────────────────────────────────────────────────────────
type CacheEntry = {
  expiresAt: number
  promise: Promise<MarketScan>
}
const scanCache = new Map<string, CacheEntry>()

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

export function _resetMarketScanCacheForTest(opts?: { ttlMs?: number }): void {
  scanCache.clear()
  _scanHits = 0
  _scanMisses = 0
  _scanDedupes = 0
  SCAN_TTL_MS = opts?.ttlMs ?? DEFAULT_SCAN_TTL_MS
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
  // Generic market verdict from the LLM. size/leverage are intentionally
  // null — the agent layer fills them from the user's Kelly tier and the
  // agent's maxLeverage. action ∈ {OPEN_LONG, OPEN_SHORT, HOLD}; CLOSE is
  // a per-agent decision (depends on whether *that* agent holds a position).
  decision: AgentDecision
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
// Returns a cached MarketScan if one is fresh, otherwise fires the LLM call
// once and shares the in-flight promise with concurrent callers.
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
  const key = `${inputs.pair}:${inputs.mode}`

  const existing = scanCache.get(key)
  if (existing && existing.expiresAt > now()) {
    _scanHits += 1
    // If multiple callers race here while the underlying promise hasn't
    // resolved yet, every one after the first counts as a dedupe — a hit
    // that didn't have a fully-resolved value to copy.
    return existing.promise
  }

  _scanMisses += 1
  const promise = runMarketScan(inputs, deps).catch((err) => {
    // On failure, evict so the next tick retries instead of serving the
    // rejected promise for the next 60s.
    scanCache.delete(key)
    throw err
  })
  scanCache.set(key, {
    expiresAt: now() + SCAN_TTL_MS,
    promise,
  })
  return promise
}

// Concurrent-caller helper exposed for the runner to dedupe the prefetch
// pass. If a scan is already in-flight or fresh, returns the existing
// promise; otherwise fires it. Counts as a dedupe (not a hit) for stats
// when it serves an in-flight value.
export function peekOrLaunchScan(
  inputs: MarketScanInputs,
  deps: MarketScanDeps = {},
): Promise<MarketScan> {
  const now = deps.now ?? Date.now
  const key = `${inputs.pair}:${inputs.mode}`
  const existing = scanCache.get(key)
  if (existing && existing.expiresAt > now()) {
    _scanDedupes += 1
    return existing.promise
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
  const llmResult = await runLLM(swarmOn, sysPrompt, userMessage)

  // Defensive: enforce the size/leverage = null contract regardless of
  // what the model returned. Cheap insurance against prompt drift.
  const decision: AgentDecision = {
    ...llmResult.decision,
    pair: inputs.pair,
    size: null,
    leverage: null,
    // The shared scan never emits CLOSE — that's a per-agent decision
    // because it depends on whether this specific agent holds a position
    // on this pair. If the model produced CLOSE, downgrade to HOLD with
    // a clear reason so the agent layer still gets a usable snapshot.
    ...(llmResult.decision.action === 'CLOSE'
      ? {
          action: 'HOLD' as const,
          holdReason:
            llmResult.decision.holdReason ??
            'Shared scan downgraded CLOSE → HOLD; per-agent layer decides exits.',
        }
      : {}),
  }

  return {
    pair: inputs.pair,
    mode: inputs.mode,
    scannedAt: (deps.now ?? Date.now)(),
    snapshot,
    decision,
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
