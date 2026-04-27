import Anthropic from '@anthropic-ai/sdk'
import type {
  Message as AnthropicMessage,
  MessageCreateParamsNonStreaming as AnthropicCreateParams,
} from '@anthropic-ai/sdk/resources/messages'
import { Agent } from '@prisma/client'
import { db } from '../db'
import {
  calculateEMA,
  calculateRSI,
  calculateMACD,
  calculateBollingerBands,
  calculateATR,
  calculateADX,
  calculateSMA,
  findRecentSwingHigh,
  findRecentSwingLow,
  calculateTrendAlignment,
  formatRecentCandles,
  OHLCV
} from './indicators'
import { buildMemoryContext, getRecentMemories, saveMemory } from './memory'
import { getSharedMarketScan } from './marketScan'
import { shouldVetoOnMemory, applyDrawdownSizeCut } from './perAgentOverlays'

// Wrap agentLog.create so that a stale Prisma client (one missing the new
// pair/adx/rsi/score/regime/reason/price columns, e.g. on a Render box that
// hasn't regenerated since the schema was extended) doesn't crash the whole
// tick. We retry the write with only the fields the client recognises so the
// trade decision is still recorded — newer fields just get dropped until the
// client is regenerated.
let _staleClientWarned = false
async function safeAgentLogCreate(args: { data: any; [k: string]: any }): Promise<void> {
  try {
    await db.agentLog.create(args as any)
  } catch (err: any) {
    const isValidation =
      err?.name === 'PrismaClientValidationError' ||
      /Unknown argument|Unknown field/i.test(String(err?.message ?? ''))
    if (!isValidation) throw err
    if (!_staleClientWarned) {
      console.warn('[agentLog] stale Prisma client detected — falling back to legacy fields. Run prisma generate on the server.')
      _staleClientWarned = true
    }
    const d = args.data || {}
    const summary = JSON.stringify({
      pair: d.pair, price: d.price, reason: d.reason,
      adx: d.adx, rsi: d.rsi, score: d.score, regime: d.regime,
    })
    try {
      await safeAgentLogCreate({
        data: {
          agentId: d.agentId,
          userId: d.userId,
          action: d.action,
          parsedAction: d.parsedAction ?? d.action,
          executionResult: (d.executionResult ?? '') + ' | ' + summary,
        } as any,
      })
    } catch (fallbackErr) {
      console.error('[agentLog] fallback write also failed:', fallbackErr)
    }
  }
}
import { checkRiskGuard, getTodayPnl } from './riskGuard'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export interface AgentDecision {
  regime: 'UPTREND' | 'DOWNTREND' | 'RANGING' | 'TRANSITIONING'
  setupScore: number
  timeframeAlignment: {
    '4h': 'BULLISH' | 'BEARISH' | 'NEUTRAL'
    '1h': 'BULLISH' | 'BEARISH' | 'NEUTRAL'
    '15m': 'BULLISH' | 'BEARISH' | 'NEUTRAL'
    volume: 'CONFIRMING' | 'DIVERGING' | 'NEUTRAL'
  }
  action: 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE' | 'HOLD'
  pair: string
  entryZone: { low: number; high: number } | null
  stopLoss: number | null
  takeProfit: number | null
  size: number | null
  leverage: number | null
  riskRewardRatio: number | null
  confidence: number
  reasoning: string
  keyRisks: string[]
  memoryUpdate: string | null
  drawdownMode: boolean
  holdReason: string | null
  // ─── 42.space prediction-market sidecar action ───────────────────────
  // Optional. Populated when the agent's conviction on a 42.space outcome
  // beats the implied probability by ≥10%. Executed independently from the
  // main perp action — an agent can OPEN_PREDICTION while still holding
  // (or trading) perps. Sized smaller than perp positions and capped per
  // market in fortyTwoExecutor.
  predictionTrade?: {
    action: 'OPEN_PREDICTION' | 'CLOSE_PREDICTION'
    marketAddress: string
    tokenId: number
    outcomeLabel?: string
    /** 0..1 — agent's own probability estimate. Must beat implied by ≥0.05. */
    conviction?: number
    positionId?: string
    reasoning?: string
  } | null
}

// ─── NEW LISTING MOMENTUM MODE ─────────────────────────────────────────────
// Used ONLY when the pair was onboarded on Aster within the last 48h. Fresh
// listings have no usable EMA200/MACD/ADX (need weeks of candles), so the
// standard TA framework will always say HOLD. Instead we hand the LLM a
// volume + price-action context and a momentum playbook with hard quarter
// sizing and tight stops. Win rate is lower but R/R asymmetry is huge —
// new Aster listings routinely 2-5x in the first 24h.
const NEW_LISTING_SYSTEM_PROMPT = `You are BUILD4 NEW-LISTING MOMENTUM — a specialist agent for trading freshly-listed perpetuals on Aster DEX (pair onboarded within the last 48 hours).

YOUR EDGE:
- New Aster perps frequently move 50-300% in their first 24-48h as price discovery happens
- Most retail traders are paralyzed by the lack of TA history — you are not
- You ignore EMA200/MACD/ADX (insufficient data). You read raw volume + candle structure + book pressure.

DECISION RULES (apply in order, override the standard framework):

1. DIRECTION
   - Strong upward expansion candles + rising volume = LONG
   - Vertical pump >100% from listing → SHORT the first sign of exhaustion (long upper wick, declining volume on green candle)
   - Sideways consolidation after a big move = WAIT for breakout direction
   - If unclear after 30s of analysis: HOLD

2. SIZING (NON-NEGOTIABLE)
   - Always use the EXACT size given in POSITION SIZE BUDGET — already quartered for new listings.
   - Leverage MAX 3x. Volatility is brutal; over-leverage = liquidation.

3. STOPS
   - Stop loss: 2-4% from entry (NOT swing low — recent candles are too short to be meaningful)
   - Take profit: 5-15% (asymmetric R/R: small loss, large potential win)
   - Acceptable R/R: ≥1.5 (NOT 2:1 — this is a momentum scalp, not a swing)

4. ENTRY CONFIDENCE
   - You only need 2 confirming signals to enter (vs 3-4 in normal mode)
   - confidence ≥ 0.55 still required
   - setupScore — express your conviction 4-10. Anything you'd take with real money = ≥4.

5. NO RE-ENTRIES
   - If you closed a position on this pair in the last hour: HOLD
   - If price moved >5% in last 5 minutes: wait, don't chase the candle

RESPOND WITH ONLY VALID JSON — same schema as the standard prompt, but you may set timeframeAlignment fields to "INSUFFICIENT_DATA" since multi-timeframe analysis isn't possible on a fresh listing. Use the regime field to describe the listing phase: "DISCOVERY" | "PUMP" | "EXHAUSTION" | "CONSOLIDATION" | "DUMP".

For HOLD: set entryZone/stopLoss/takeProfit/size/leverage/riskRewardRatio to null. Use holdReason to explain what you're waiting for.`

const TRADING_SYSTEM_PROMPT = `You are BUILD4 — an elite quantitative crypto trading agent with deep expertise in perpetual futures markets. You combine technical analysis, market microstructure, risk management, and behavioral finance to make high-probability trading decisions.

YOUR TRADING PHILOSOPHY:
- Capital preservation is the primary objective. A loss avoided is worth more than a gain captured.
- Only enter trades with asymmetric risk/reward (minimum 2:1, prefer 3:1 or better).
- High confidence + high conviction = full size. Low confidence = pass entirely. Never "half-heartedly" enter.
- The best trade is often no trade. HOLD is a valid and often correct action.
- You never chase price. You wait for price to come to you at defined levels.
- Trending markets: trade with momentum. Ranging markets: fade extremes.
- Volume confirms everything. A breakout without volume is a trap.

YOUR DECISION FRAMEWORK (apply in this exact order every tick):

1. REGIME IDENTIFICATION
   - ADX > 25 + higher highs/lows = UPTREND → only look for LONG setups
   - ADX > 25 + lower highs/lows = DOWNTREND → only look for SHORT setups
   - ADX < 20 = RANGING → trade mean reversion only, reduce size by 50%
   - ADX 20-25 = TRANSITIONING → wait for confirmation, prefer HOLD

2. TIMEFRAME ALIGNMENT CHECK
   Only trade when at least 2 of 4 signals agree:
   - 4h trend direction (EMA200)
   - 1h trend direction (EMA50)
   - 15m momentum (MACD + RSI)
   - Volume confirmation
   Fewer than 2 agreeing = HOLD

3. ENTRY QUALITY SCORING (0-10):
   - Trend alignment (all timeframes agree): +3
   - At key support/resistance level: +2
   - RSI not overbought/oversold against direction: +1
   - Volume above average: +1
   - Bollinger band context favorable: +1
   - MACD cross in your direction within last 3 bars: +1
   - Clean recent candle structure: +1
   Score 7-10: Full size | Score 5-6: Half size | Score 4: Quarter size | Score 0-3: HOLD

4. RISK MANAGEMENT (non-negotiable):
   - Stop loss: below/above nearest swing low/high, NOT an arbitrary percentage
   - If R/R after proper SL/TP placement is less than 1.5:1: PASS
   - Size to the stop, not to a fixed amount
   - Never move stop loss further away once set

5. BEHAVIORAL GUARDRAILS:
   - Never re-enter same pair within 15 minutes of closing
   - If price moved >1.5% in last 15 minutes: wait, do not chase
   - In drawdown mode (last 2 losses): reduce size 50%

6. MEMORY INTEGRATION:
   - If memory contains corrections about this pair: apply lessons heavily
   - If memory shows repeated losses on this setup: require score 8+ to enter
   - Adapt based on what has worked and failed

RESPOND WITH ONLY VALID JSON — no preamble, no markdown, no text outside the JSON object. Use exactly this schema:

{
  "regime": "UPTREND",
  "setupScore": 7,
  "timeframeAlignment": {
    "4h": "BULLISH",
    "1h": "BULLISH",
    "15m": "BULLISH",
    "volume": "CONFIRMING"
  },
  "action": "OPEN_LONG",
  "pair": "BTC/USDT",
  "entryZone": { "low": 43200, "high": 43400 },
  "stopLoss": 42800,
  "takeProfit": 44600,
  "size": 150,
  "leverage": 3,
  "riskRewardRatio": 3.2,
  "confidence": 0.78,
  "reasoning": "3-5 sentence explanation: what regime, which signals triggered, why R/R favorable, what would invalidate.",
  "keyRisks": ["risk 1", "risk 2"],
  "memoryUpdate": "One sentence insight for future, or null",
  "drawdownMode": false,
  "holdReason": null,
  "predictionTrade": null
}

PREDICTION-MARKET SIDECAR (optional, set predictionTrade only when justified):
- A separate "Live 42.space Prediction Markets" block may appear below. Each market lists outcomes with implied probability, marginal price, and tokenId.
- ONLY emit predictionTrade when your independent conviction on an outcome beats the implied probability by ≥5 percentage points. Otherwise leave predictionTrade=null.
- conviction is YOUR own 0..1 probability estimate, NOT the listed implied probability. Be honest — being wrong here loses real USDT.
- Use the exact marketAddress and tokenId shown in the prompt. Set outcomeLabel for human readability.
- Sizing is handled in code (small, capped per market). Don't include amount.
- The "reasoning" string on a predictionTrade is MANDATORY and MUST quote, in this order: (1) the market name, (2) the implied probability shown in the prompt as a percentage, (3) YOUR own probability estimate as a percentage, (4) the edge in percentage points, and (5) the USDT allocation you expect (sizing is in code; just say "≤$2 USDT"). If you cannot quote all five, do not emit predictionTrade.
- Example: { "action":"OPEN_PREDICTION","marketAddress":"0xabc...","tokenId":1,"outcomeLabel":"YES","conviction":0.68,"reasoning":"42.space prices 'Will BTC close above $80k on Friday' YES at 60%; my read is 68% based on funding rates + on-chain accumulation; +8pp edge; allocating ≤$2 USDT." }
- This sidecar is independent of the main action. You can OPEN_LONG perps AND OPEN_PREDICTION on the same tick.
- To CLOSE an existing position: a "Your Open 42.space Positions" block lists each open position with its positionId. Emit { "action":"CLOSE_PREDICTION","marketAddress":"<addr>","tokenId":<id>,"positionId":"<the id from the list>" } when conviction has flipped or the price has moved enough that the edge is gone. NEVER invent a positionId — only use ones shown in that block.

For HOLD: set entryZone/stopLoss/takeProfit/size/leverage/riskRewardRatio to null. Use holdReason to explain what would change your mind.`

export function buildMarketContext(
  ohlcv15m: OHLCV,
  ohlcv1h: OHLCV,
  ohlcv4h: OHLCV,
  pair: string
): string {
  const price = ohlcv15m.close[ohlcv15m.close.length - 1]

  const ema9 = calculateEMA(ohlcv15m.close, 9)
  const ema21 = calculateEMA(ohlcv15m.close, 21)
  const ema50 = calculateEMA(ohlcv1h.close, 50)
  const ema200 = calculateEMA(ohlcv4h.close, 200)

  const rsi15m = calculateRSI(ohlcv15m.close, 14)
  const rsi1h = calculateRSI(ohlcv1h.close, 14)
  const macd15m = calculateMACD(ohlcv15m.close, 12, 26, 9)

  const bb15m = calculateBollingerBands(ohlcv15m.close, 20, 2)
  const atr1h = calculateATR(ohlcv1h, 14)
  const adx = calculateADX(ohlcv1h, 14)

  const volSMA20 = calculateSMA(ohlcv1h.volume, 20)
  const volCurrent = ohlcv1h.volume[ohlcv1h.volume.length - 1]
  const volRatio = volSMA20 > 0 ? volCurrent / volSMA20 : 1

  const resistance = findRecentSwingHigh(ohlcv4h, 20)
  const support = findRecentSwingLow(ohlcv4h, 20)
  const alignScore = calculateTrendAlignment(ema9, ema21, ema50, ema200, price)
  const regime = adx > 25 ? (ema9 > ema200 ? 'TRENDING UP' : 'TRENDING DOWN') : 'RANGING'

  const bbPos =
    price > bb15m.upper
      ? 'ABOVE UPPER (extended)'
      : price < bb15m.lower
      ? 'BELOW LOWER (extended)'
      : 'INSIDE BANDS (contained)'

  const bbSqueeze = (bb15m.upper - bb15m.lower) / bb15m.mid < 0.03

  return `
PAIR: ${pair} | PRICE: $${price.toFixed(4)} | REGIME: ${regime} (ADX: ${adx.toFixed(1)})

TREND ALIGNMENT (${alignScore}/5):
- 15m: EMA9 ${ema9 > ema21 ? 'ABOVE' : 'BELOW'} EMA21 → ${ema9 > ema21 ? 'BULLISH' : 'BEARISH'} short-term
- 1h:  Price ${price > ema50 ? 'ABOVE' : 'BELOW'} EMA50 ($${ema50.toFixed(4)}) → ${price > ema50 ? 'BULLISH' : 'BEARISH'} medium-term
- 4h:  Price ${price > ema200 ? 'ABOVE' : 'BELOW'} EMA200 ($${ema200.toFixed(4)}) → ${price > ema200 ? 'BULLISH' : 'BEARISH'} macro trend

MOMENTUM:
- RSI(14) 15m: ${rsi15m.toFixed(1)} ${rsi15m > 70 ? '⚠️ OVERBOUGHT' : rsi15m < 30 ? '⚠️ OVERSOLD' : '✓ NEUTRAL'}
- RSI(14) 1h:  ${rsi1h.toFixed(1)} ${rsi1h > 70 ? '⚠️ OVERBOUGHT' : rsi1h < 30 ? '⚠️ OVERSOLD' : '✓ NEUTRAL'}
- MACD 15m: ${macd15m.histogram > 0 ? 'POSITIVE (bullish momentum)' : 'NEGATIVE (bearish momentum)'} | Histogram: ${macd15m.histogram.toFixed(6)}
- MACD Cross (last 3 bars): ${macd15m.recentCross || 'NONE'}

VOLATILITY:
- Bollinger: Price ${bbPos}${bbSqueeze ? ' ⚡ SQUEEZE — breakout likely' : ''}
- BB Width: ${(((bb15m.upper - bb15m.lower) / bb15m.mid) * 100).toFixed(2)}%
- ATR(14) 1h: $${atr1h.toFixed(4)} (${((atr1h / price) * 100).toFixed(2)}% of price)

VOLUME:
- Current vs 20-SMA: ${volRatio.toFixed(2)}x ${volRatio > 1.5 ? '⬆️ HIGH — confirms moves' : volRatio < 0.7 ? '⬇️ LOW — suspect validity' : '✓ NORMAL'}

KEY LEVELS:
- Resistance: $${resistance.toFixed(4)} (${(((resistance - price) / price) * 100).toFixed(2)}% away)
- Support:    $${support.toFixed(4)} (${(((price - support) / price) * 100).toFixed(2)}% away)

RECENT CANDLES (15m):
${formatRecentCandles(ohlcv15m, 5)}`
}

// Compact momentum context for new listings — uses 1m + 5m candles since
// fresh pairs lack enough history for hourly/daily indicators.
export function buildMomentumContext(
  ohlcv1m: OHLCV,
  ohlcv5m: OHLCV,
  pair: string,
  hoursOld: number
): string {
  const closes1m = ohlcv1m.close
  const vols1m = ohlcv1m.volume
  const price = closes1m[closes1m.length - 1]
  const listingPrice = closes1m[0] ?? price
  const pctFromListing = ((price - listingPrice) / listingPrice) * 100

  const last5mPrice = closes1m[Math.max(0, closes1m.length - 5)] ?? price
  const last15mPrice = closes1m[Math.max(0, closes1m.length - 15)] ?? price
  const pct5m = ((price - last5mPrice) / last5mPrice) * 100
  const pct15m = ((price - last15mPrice) / last15mPrice) * 100

  const recentVol = vols1m.slice(-10).reduce((a, b) => a + b, 0) / 10
  const baselineVol = vols1m.slice(0, Math.max(1, vols1m.length - 10)).reduce((a, b) => a + b, 0) /
    Math.max(1, vols1m.length - 10)
  const volRatio = baselineVol > 0 ? recentVol / baselineVol : 1

  const high24h = Math.max(...closes1m)
  const low24h = Math.min(...closes1m)
  const drawdownFromHigh = ((price - high24h) / high24h) * 100

  return `
NEW LISTING: ${pair} | AGE: ${hoursOld.toFixed(1)}h since onboard
PRICE: $${price} | FROM LISTING: ${pctFromListing >= 0 ? '+' : ''}${pctFromListing.toFixed(1)}%

MOMENTUM:
- Last 5m:  ${pct5m >= 0 ? '+' : ''}${pct5m.toFixed(2)}%
- Last 15m: ${pct15m >= 0 ? '+' : ''}${pct15m.toFixed(2)}%
- Drawdown from listing high: ${drawdownFromHigh.toFixed(2)}%

VOLUME:
- Recent 10m vs full-history avg: ${volRatio.toFixed(2)}x ${
    volRatio > 2 ? '⬆️ EXPANDING' : volRatio < 0.5 ? '⬇️ FADING' : '✓ STABLE'
  }

RANGE:
- Listing high: $${high24h}
- Listing low:  $${low24h}
- Position in range: ${(((price - low24h) / Math.max(1e-9, high24h - low24h)) * 100).toFixed(0)}%

RECENT 5m CANDLES (last ${Math.min(8, ohlcv5m.close.length)}):
${formatRecentCandles(ohlcv5m, 8)}`
}

async function getMomentumOHLCV(pair: string): Promise<{
  '1m': OHLCV
  '5m': OHLCV
}> {
  const { getKlines } = await import('../services/aster')
  const [m1, m5] = await Promise.all([
    getKlines(pair, '1m', 120),  // ~2h of 1m candles
    getKlines(pair, '5m', 100)   // ~8h of 5m candles
  ])
  return { '1m': m1, '5m': m5 }
}

async function getMultiTimeframeOHLCV(pair: string): Promise<{
  '15m': OHLCV
  '1h': OHLCV
  '4h': OHLCV
}> {
  const { getKlines } = await import('../services/aster')
  const [tf15m, tf1h, tf4h] = await Promise.all([
    getKlines(pair, '15m', 200),
    getKlines(pair, '1h', 200),
    getKlines(pair, '4h', 200)
  ])
  return { '15m': tf15m, '1h': tf1h, '4h': tf4h }
}

// Default universe used when an agent is configured with pairs:['ALL'].
// All confirmed-tradeable on Aster fapi.asterdex.com as of 2026-04.
const ALL_PAIRS_UNIVERSE = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT',
  'XRPUSDT', 'ARBUSDT', 'ASTERUSDT'
]

// AUTO-mode watchlist — scanned each tick by pickBestWatchlistPair() to
// pick the SINGLE highest-scoring pair. Cost stays at one Claude call/tick
// regardless of watchlist size, because the pre-filter is deterministic TA.
// Klines are cached process-wide for 60s, so 30 fetches/min total across
// thousands of agents (not per agent).
//
// The list itself comes from listingDetector.getActiveWatchlist() — base
// 10 pairs PLUS any new listing onboarded within the last 48h. Pairs <2h
// old skip TA scoring entirely (not enough kline history) and instead get
// a synthetic high score so they're always considered as momentum candidates.
const WATCHLIST_MIN_SCORE = 5  // out of 8 — below this, agent HOLDs everything
const NEW_LISTING_SYNTHETIC_SCORE = 6  // newly-listed pairs always make the cut
// AUTO mode now evaluates the top-N scoring pairs per tick instead of just
// the single winner. BTC and similar majors often range while alts/new
// listings have the real moves — limiting to 1/tick was systematically
// blinding agents to those opportunities. Cost is bounded because most
// alt pairs trip the cost guards (extreme RSI / volume collapse) and skip
// Claude entirely; only genuinely interesting setups burn an LLM call.
const WATCHLIST_TOP_N = 3

// Deterministic setup score in [0..8]. Higher = better trading opportunity.
//   ADX trending  : 0–3  (gates everything else; ranging markets score 0)
//   RSI sweet-spot: 0–2  (avoid extremes)
//   MACD momentum : 0–2  (histogram expanding either direction)
//   BB not squeezed: 0–1 (need volatility to capture)
function scoreSetup(ohlcv15m: OHLCV, ohlcv1h: OHLCV): number {
  const adx = calculateADX(ohlcv1h, 14)
  if (adx < 20) return 0  // ranging — skip entirely

  let score = adx > 25 ? 3 : 1

  const closes15m = ohlcv15m.close
  const rsi = calculateRSI(closes15m, 14)
  if (rsi > 40 && rsi < 60) score += 2
  else if (rsi > 30 && rsi < 70) score += 1

  const macd = calculateMACD(closes15m)
  // Momentum: histogram expanding (matches direction of macd line)
  if ((macd.histogram > 0 && macd.macdLine > macd.signalLine) ||
      (macd.histogram < 0 && macd.macdLine < macd.signalLine)) {
    score += 2
  }

  const bb = calculateBollingerBands(closes15m, 20, 2)
  const bbWidth = bb.mid > 0 ? (bb.upper - bb.lower) / bb.mid : 0
  if (bbWidth > 0.02) score += 1

  return score
}

// Scan the WATCHLIST, score each pair deterministically (no LLM), return
// the single best pair if its score clears WATCHLIST_MIN_SCORE — otherwise
// null (agent should HOLD for this tick). Klines are fetched in parallel
// and shared via the process-wide cache, so total Aster API cost is
// 30 calls/minute regardless of how many agents are scanning.
export async function pickBestWatchlistPair(): Promise<{ symbol: string; score: number } | null> {
  const top = await pickTopWatchlistPairs(1)
  return top[0] ?? null
}

// Score the entire watchlist in parallel and return the top-N pairs that
// clear WATCHLIST_MIN_SCORE, ranked best-first. Returns [] if nothing
// qualifies. Used by AUTO mode so agents evaluate multiple hot pairs per
// tick instead of being locked into the single highest-scoring one.
// Klines are cached process-wide for 60s so this stays cheap regardless
// of how many agents call it concurrently.
export async function pickTopWatchlistPairs(
  n: number
): Promise<Array<{ symbol: string; score: number }>> {
  const { getKlines } = await import('../services/aster')
  const { getActiveWatchlist, isNewlyListed } = await import('../services/listingDetector')
  const watchlist = await getActiveWatchlist()
  const results = await Promise.all(
    watchlist.map(async (symbol) => {
      // Pairs onboarded <2h ago don't have enough kline history for the
      // TA scorer to produce meaningful results. Auto-include them with a
      // synthetic high score so they're always candidates — the LLM gets
      // the actual decision.
      if (isNewlyListed(symbol)) {
        return { symbol, score: NEW_LISTING_SYNTHETIC_SCORE }
      }
      try {
        const [m15, h1] = await Promise.all([
          getKlines(symbol, '15m', 100),
          getKlines(symbol, '1h', 100)
        ])
        return { symbol, score: scoreSetup(m15, h1) }
      } catch {
        return null
      }
    })
  )
  return results
    .filter((r): r is { symbol: string; score: number } => !!r)
    .filter((r) => r.score >= WATCHLIST_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, n))
}

export function expandPairs(pairs: string[]): string[] {
  const expanded = new Set<string>()
  for (const p of pairs) {
    if (!p) continue
    const upper = p.toUpperCase()
    if (upper === 'ALL') {
      ALL_PAIRS_UNIVERSE.forEach((x) => expanded.add(x))
    } else if (upper === 'AUTO') {
      // AUTO is resolved at tick-time by pickBestWatchlistPair(), not here.
      // expandPairs is also called by the mini app for display purposes;
      // we surface 'AUTO' as itself so the caller can format appropriately.
      expanded.add('AUTO')
    } else {
      expanded.add(p.replace(/[\/\s]/g, '').toUpperCase())
    }
  }
  return Array.from(expanded)
}

// ─── Swarm-or-Anthropic decision helper ───────────────────────────────────
// Extracted from runAgentTick so the three swarm branches can be
// independently unit-tested without spinning up an entire agent tick:
//   (a) swarmOn && >=2 live providers && quorum reached → use quorum decision
//   (b) swarmOn && >=2 live providers && no quorum     → highest-confidence
//                                                         successful provider
//                                                         (prefers non-anthropic
//                                                         since anthropic is the
//                                                         provider that runs out
//                                                         of credits in prod).
//                                                         Per-provider reasoning
//                                                         preserved in
//                                                         providersTelemetry.
//   (c) swarmOn && only 1 live provider                → Anthropic fallback
//   (d) !swarmOn                                       → Anthropic-only path
// Dependencies are injectable so tests can stub them; defaults wire to the
// real swarm/inference modules and the module-scoped `anthropic` client.
export type AnthropicCreateFn = (args: AnthropicCreateParams) => Promise<AnthropicMessage>

export interface RunDecisionLLMDeps {
  runSwarmDecision?: typeof import('../swarm/swarm').runSwarmDecision
  getProviderStatus?: typeof import('../services/inference').getProviderStatus
  anthropicCreate?: AnthropicCreateFn
}

export interface RunDecisionLLMResult {
  decision: AgentDecision
  rawResponse: string
  providersTelemetry: import('../services/fortyTwoExecutor').ProviderTelemetry[] | null
}

// ─── Swarm quorum counters ────────────────────────────────────────────────
// In-memory counters for runDecisionLLM's swarm branch outcomes. Used to
// detect a regression where providers chronically disagree (model drift,
// prompt changes) and the no-quorum fallback silently routes every user
// back to a single model. Read by `getSwarmQuorumCounters()` and surfaced
// via the swarm stats admin endpoint (`/swarmstats`) alongside the per-
// provider roll-up. Persistent counts come from AgentLog (rawResponse
// tagged `[swarm-no-quorum, ...]`); these in-memory values reset on
// process restart but are useful for live debugging.
let _swarmQuorumReached = 0
let _swarmNoQuorum = 0

export function getSwarmQuorumCounters(): { quorumReached: number; noQuorum: number } {
  return { quorumReached: _swarmQuorumReached, noQuorum: _swarmNoQuorum }
}

export function _resetSwarmQuorumCountersForTest(): void {
  _swarmQuorumReached = 0
  _swarmNoQuorum = 0
}

async function callAnthropicForDecision(
  sysPrompt: string,
  userMessage: string,
  anthropicCreate: AnthropicCreateFn,
): Promise<{ decision: AgentDecision; rawResponse: string }> {
  const response = await anthropicCreate({
    model: 'claude-sonnet-4-5',
    // Bumped from 1000 → 1500: production logs showed Anthropic occasionally
    // truncating JSON mid-string at ~3.2 KB, which triggered an Unterminated
    // string SyntaxError below and lost the agent's whole tick. 1500 tokens
    // covers our verbose-reasoning agents with a comfortable margin while
    // still being a tiny cost bump (~50% of an already-cheap call).
    max_tokens: 1500,
    system: sysPrompt,
    messages: [{ role: 'user', content: userMessage }],
  })
  const first = response.content[0]
  const rawResponse = first && first.type === 'text' ? first.text : '{}'
  const cleaned = rawResponse.replace(/```json|```/g, '').trim()
  try {
    const decision = JSON.parse(cleaned) as AgentDecision
    return { decision, rawResponse }
  } catch (parseErr) {
    // The model returned malformed JSON (most often a truncated response
    // where max_tokens cut a string mid-character). Don't propagate the raw
    // SyntaxError — the upstream handler logs it as `[Agent X] LLM error:
    // SyntaxError: Unterminated string in JSON…`, which looks alarming to
    // anyone reading prod logs (e.g. partners during live testing). Convert
    // to a deterministic, safe HOLD decision so the agent simply skips this
    // tick and tries again next cycle. The structured log line below makes
    // the underlying cause greppable without scaring anyone.
    console.warn(
      '[anthropic-decision] JSON parse failed — returning safe HOLD.',
      JSON.stringify({
        error: (parseErr as Error).message,
        rawLength: cleaned.length,
        rawTail: cleaned.slice(-120),
      }),
    )
    const fallback: AgentDecision = {
      action: 'HOLD',
      confidence: 0,
      reasoning: 'LLM response unparseable (likely truncated) — holding this tick',
    } as AgentDecision
    return { decision: fallback, rawResponse: cleaned }
  }
}

export async function runDecisionLLM(
  swarmOn: boolean,
  sysPrompt: string,
  userMessage: string,
  deps: RunDecisionLLMDeps = {},
): Promise<RunDecisionLLMResult> {
  const anthropicCreate: AnthropicCreateFn =
    deps.anthropicCreate ?? ((args) => anthropic.messages.create(args))

  if (swarmOn) {
    const runSwarmDecision =
      deps.runSwarmDecision ?? (await import('../swarm/swarm')).runSwarmDecision
    const getProviderStatus =
      deps.getProviderStatus ?? (await import('../services/inference')).getProviderStatus
    const status = getProviderStatus()
    const liveProviders = (Object.keys(status) as Array<keyof typeof status>)
      .filter((p) => status[p].live)

    if (liveProviders.length >= 2) {
      const swarm = await runSwarmDecision<AgentDecision>({
        providers: liveProviders,
        system: sysPrompt,
        user: userMessage,
        jsonMode: true,
        maxTokens: 1000,
        schema: (t) => {
          // Strip markdown fences. Some providers (observed in prod with
          // Hyperbolic) occasionally emit JS-style literals like `!null` or
          // `!true` instead of valid JSON, which crashes JSON.parse and was
          // killing our only surviving provider during the credit-outage
          // window. Normalise the common cases before parsing:
          //   :!null  → :null   (model meant "no value")
          //   :!true  → :false
          //   :!false → :true
          // Trailing commas inside objects/arrays are also a frequent LLM
          // glitch — drop those too. All edits are conservative regex passes
          // that only touch JSON-syntax positions.
          const cleaned = t
            .replace(/```json|```/g, '')
            .trim()
            .replace(/:\s*!null\b/g, ':null')
            .replace(/:\s*!true\b/g, ':false')
            .replace(/:\s*!false\b/g, ':true')
            .replace(/,(\s*[}\]])/g, '$1')
          return JSON.parse(cleaned) as AgentDecision
        },
        getAction: (d) => d.action,
        getPredictionKey: (d) =>
          d.predictionTrade
            ? `${d.predictionTrade.marketAddress}:${d.predictionTrade.tokenId}:${d.predictionTrade.action}`
            : null,
        getReasoning: (d) => d.reasoning ?? d.holdReason ?? null,
      })
      const providersTelemetry: import('../services/fortyTwoExecutor').ProviderTelemetry[] =
        swarm.decisions.map((c) => ({
          provider: c.provider,
          model: c.model,
          action: c.decision?.action ?? null,
          predictionTrade: c.decision?.predictionTrade ?? null,
          reasoning: c.reasoning,
          latencyMs: c.latencyMs,
          inputTokens: c.inputTokens,
          outputTokens: c.outputTokens,
          tokensUsed: c.tokensUsed,
        }))
      if (swarm.quorumDecision) {
        _swarmQuorumReached += 1
        const decision = swarm.quorumDecision
        const rawResponse = JSON.stringify({ swarm: providersTelemetry, consensus: decision }).slice(0, 4000)
        return { decision, rawResponse, providersTelemetry }
      }
      // No quorum — instead of burning another LLM call, pick the
      // highest-confidence successful provider from the swarm we already
      // ran. Prefer non-anthropic decisions because anthropic is the
      // provider that runs out of credits in production (visible in logs as
      // repeated 400 "credit balance is too low" errors), which made the
      // old anthropic-fallback path silently HOLD on every disagreement.
      _swarmNoQuorum += 1
      const totalSwarm = _swarmQuorumReached + _swarmNoQuorum
      const noQuorumRate = totalSwarm > 0 ? (_swarmNoQuorum / totalSwarm) : 0
      // Build a per-provider status string. For failed providers, prefer the
      // actual error message (truncated) over the generic "err" tag — without
      // it we can't tell credit-exhausted vs rate-limited vs parse-failed
      // vs timeout, which means we can't fix anything. The SwarmCall carries
      // the error string even though ProviderTelemetry drops it for DB
      // storage, so pull it directly from swarm.decisions here.
      const status = swarm.decisions.map((c) => {
        if (c.ok && c.decision) {
          const action = (c.decision as AgentDecision).action ?? 'parsed-no-action'
          return `${c.provider}:${action}`
        }
        const errMsg = (c.error ?? 'err').slice(0, 80).replace(/\s+/g, ' ')
        return `${c.provider}:ERR(${errMsg})`
      })
      console.warn(
        `[swarm] no-quorum fallback — providers=${liveProviders.join(',')} ` +
        `status=${status.join(' | ')} ` +
        `noQuorumRate=${(_swarmNoQuorum)}/${totalSwarm} (${(noQuorumRate * 100).toFixed(1)}%)`
      )

      // Pick the best successful decision: ok=true && decision present.
      // Sort by (non-anthropic first, then highest confidence). Confidence
      // can be missing on some agents → treat as 0 so any non-erroring
      // provider still beats nothing.
      const successful = swarm.decisions.filter((c) => c.ok && c.decision)
      successful.sort((a, b) => {
        const aAnthro = a.provider === 'anthropic' ? 1 : 0
        const bAnthro = b.provider === 'anthropic' ? 1 : 0
        if (aAnthro !== bAnthro) return aAnthro - bAnthro
        const aConf = (a.decision as AgentDecision)?.confidence ?? 0
        const bConf = (b.decision as AgentDecision)?.confidence ?? 0
        return bConf - aConf
      })

      if (successful.length > 0) {
        const winner = successful[0]
        const decision = winner.decision as AgentDecision
        const tagged =
          '[swarm-no-quorum, best-of-swarm] ' +
          JSON.stringify({
            swarm: providersTelemetry,
            chosen: { provider: winner.provider, model: winner.model, decision },
          }).slice(0, 3500)
        return { decision, rawResponse: tagged, providersTelemetry }
      }

      // Every provider errored — return a safe HOLD with telemetry so the
      // AgentLog row still records what happened.
      const safeHold: AgentDecision = {
        action: 'HOLD',
        confidence: 0,
        reasoning: 'swarm: all providers failed this tick',
      } as AgentDecision
      const tagged =
        '[swarm-no-quorum, all-failed] ' +
        JSON.stringify({ swarm: providersTelemetry }).slice(0, 3500)
      return { decision: safeHold, rawResponse: tagged, providersTelemetry }
    }
    // swarmOn but only 1 live provider — fall through to the single-provider
    // Anthropic path. providersTelemetry stays null so the agent log doesn't
    // claim a swarm ran when only Anthropic answered.
  }

  const { decision, rawResponse } = await callAnthropicForDecision(
    sysPrompt,
    userMessage,
    anthropicCreate,
  )
  return { decision, rawResponse, providersTelemetry: null }
}

export async function runAgentTick(agent: Agent): Promise<void> {
  const startTime = Date.now()

  let pairList = expandPairs(agent.pairs)

  // ─── AUTO-mode resolution ──────────────────────────────────────────────
  // If the agent has pairs:['AUTO'], resolve it before the per-pair loop:
  //   1. Always include any pair the agent currently has an open position
  //      on (positions must be managed regardless of scan result).
  //   2. Run pickBestWatchlistPair() to score the watchlist deterministically
  //      and add the single best candidate (if any clears MIN_SCORE).
  //   3. Persist {currentPair, lastScanScore} so the mini app can render
  //      the agent's current focus.
  // Cost stays at one Claude call/tick because only the winner is added.
  if (pairList.includes('AUTO')) {
    pairList = pairList.filter((p) => p !== 'AUTO')
    const openHeld = await db.trade.findMany({
      where: { agentId: agent.id, status: 'open' },
      select: { pair: true },
      distinct: ['pair']
    })
    for (const t of openHeld) {
      const sym = t.pair.replace(/[\/\s]/g, '').toUpperCase()
      if (!pairList.includes(sym)) pairList.push(sym)
    }
    let scanResults: Array<{ symbol: string; score: number }> = []
    try {
      scanResults = await pickTopWatchlistPairs(WATCHLIST_TOP_N)
    } catch (e: any) {
      console.warn(`[Agent ${agent.name}] AUTO scan failed:`, e?.message)
    }
    for (const r of scanResults) {
      if (!pairList.includes(r.symbol)) pairList.push(r.symbol)
    }
    const scanResult = scanResults[0] ?? null

    // Fresh listings are time-critical — always evaluate every pair listed
    // in the last 48h on every AUTO tick, regardless of TA score. The
    // momentum mode in the per-pair loop has its own cheap context (1m+5m
    // candles only), so adding 3-4 extra pairs per tick is bounded cost.
    try {
      const { getRecentNewListings } = await import('../services/listingDetector')
      const fresh = await getRecentNewListings()
      for (const sym of fresh.slice(0, 5)) {
        if (!pairList.includes(sym)) pairList.push(sym)
      }
    } catch {}

    try {
      await db.agent.update({
        where: { id: agent.id },
        data: {
          currentPair: scanResult?.symbol ?? null,
          lastScanScore: scanResult?.score ?? 0
        }
      })
    } catch {}
    if (pairList.length === 0) {
      console.log(`[Agent ${agent.name}] AUTO scan: no setup ≥${WATCHLIST_MIN_SCORE}/8, no fresh listings, no open positions — HOLD`)
      return
    }
  }

  if (pairList.length === 0) {
    console.warn(`[Agent ${agent.name}] No tradeable pairs after expansion (raw=${JSON.stringify(agent.pairs)}), skipping tick`)
    return
  }

  // Lazy-import runner to avoid a circular import (runner imports tradingAgent).
  const { getBot, noteAgentTicked, shouldSendSummary, markSummarySent, notifyTradeOpened, escapeMd } =
    await import('./runner')
  noteAgentTicked(agent.id)

  // Resolve telegramId once per tick for live "Agent Brain" notifications.
  const tickUser = await db.user.findUnique({
    where: { id: agent.userId },
    select: { telegramId: true }
  })
  const telegramId = tickUser?.telegramId?.toString() ?? null

  // Per-tick decision snapshot, used to send ONE consolidated summary message
  // at the end of the tick (throttled). Per-trade OPEN messages still fire
  // immediately and separately — those are always important.
  type TickEntry = {
    pair: string
    action: string
    score: number | null
    regime: string | null
    rsi: number | null
    adx: number | null
    price: number | null
    holdReason: string | null
    reasoning: string | null
  }
  const tickDecisions: TickEntry[] = []
  let openedThisTick = 0
  let closedThisTick = 0

  for (const pair of pairList) {
    let snapshot: { price: number; rsi: number; adx: number; regime: string } = {
      price: 0, rsi: 0, adx: 0, regime: 'UNKNOWN'
    }
    try {
      // 1. Gather market data — branch on whether this is a fresh listing.
      // New listings (<48h on Aster) get a momentum-focused context built from
      // 1m+5m candles instead of the standard 15m/1h/4h, since they lack the
      // history needed for EMA200/MACD/ADX. The system prompt also changes
      // (NEW_LISTING_SYSTEM_PROMPT below) so the LLM applies a momentum
      // playbook rather than the conservative TA framework.
      const { getRecentNewListings } = await import('../services/listingDetector')
      const recentListings = await getRecentNewListings().catch(() => [] as string[])
      const isNewListingPair = recentListings.includes(pair)

      let marketContext: string
      let ohlcv: { '15m': OHLCV; '1h': OHLCV; '4h': OHLCV } | null = null
      let momentumOhlcv: { '1m': OHLCV; '5m': OHLCV } | null = null

      if (isNewListingPair) {
        momentumOhlcv = await getMomentumOHLCV(pair)
        // Estimate hours-old from the first 1m candle we got back (Aster only
        // serves candles from listing onwards, so the earliest candle ≈ listing).
        const earliestMs = (momentumOhlcv['1m'] as any).openTime?.[0]
          ?? Date.now() - momentumOhlcv['1m'].close.length * 60_000
        const hoursOld = (Date.now() - earliestMs) / (60 * 60 * 1000)
        marketContext = buildMomentumContext(momentumOhlcv['1m'], momentumOhlcv['5m'], pair, hoursOld)
      } else {
        ohlcv = await getMultiTimeframeOHLCV(pair)
        marketContext = buildMarketContext(ohlcv['15m'], ohlcv['1h'], ohlcv['4h'], pair)
      }

      // Indicator snapshot — used both for the live "Agent Brain" feed
      // (logged to AgentLog so the mini app can render it) and for the
      // per-tick Telegram summary message.
      if (ohlcv) {
        const _price = ohlcv['15m'].close[ohlcv['15m'].close.length - 1]
        const _rsi   = calculateRSI(ohlcv['15m'].close, 14)
        const _adx   = calculateADX(ohlcv['1h'], 14)
        const _regime = _adx > 25
          ? (calculateEMA(ohlcv['15m'].close, 9) > calculateEMA(ohlcv['4h'].close, 200)
              ? 'TRENDING UP'
              : 'TRENDING DOWN')
          : 'RANGING'
        snapshot = { price: _price, rsi: _rsi, adx: _adx, regime: _regime }
      } else if (momentumOhlcv) {
        // New-listing snapshot — no usable RSI/ADX, just price + regime tag.
        const closes = momentumOhlcv['1m'].close
        snapshot = {
          price: closes[closes.length - 1],
          rsi: 0,
          adx: 0,
          regime: 'NEW_LISTING'
        }
      }

      // 2. Get open positions
      const openPositions = await db.trade.findMany({
        where: { agentId: agent.id, pair, status: 'open' }
      })

      // 2a. News intelligence — shared across all agents (1 Claude call/min).
      // Fetches RSS + CryptoPanic, returns cached signal if <60s old.
      const { fetchNewsSignal, getNewsLastUpdated } = await import('../services/newsIntelligence')
      const newsSignal = await fetchNewsSignal()

      // EMERGENCY_CLOSE: major bearish breaking news. Close every open
      // position for this agent on Aster, mark them closed in DB, alert
      // the user. We close ALL pairs (not just `pair`) because one news
      // event typically dumps the whole market.
      if (newsSignal.action === 'EMERGENCY_CLOSE') {
        console.log(
          `[Agent ${agent.name}] EMERGENCY CLOSE — ${newsSignal.topHeadline}`
        )
        const allOpen = await db.trade.findMany({
          where: { agentId: agent.id, status: 'open' }
        })
        for (const pos of allOpen) {
          try {
            const { closePosition: asterClose, getMarkPrice } = await import('../services/aster')
            const dbUser = await db.user.findUnique({
              where: { id: agent.userId },
              include: { wallets: { where: { isActive: true }, take: 1 } }
            })
            const userAddr = dbUser?.wallets?.[0]?.address ?? ''
            const { resolveAgentCreds } = await import('../services/aster')
            const creds = dbUser ? await resolveAgentCreds(dbUser, userAddr) : null
            let exitPx = pos.entryPrice
            try {
              const mp = await getMarkPrice(pos.pair)
              exitPx = mp.markPrice
            } catch {}
            if (creds && agent.exchange !== 'mock') {
              const sym = pos.pair.replace('/', '')
              const contractSize = parseFloat((pos.size / pos.entryPrice).toFixed(6))
              try {
                // closePosition signature: (symbol, side, size, creds).
                // It internally inverts side ('LONG' -> SELL, 'SHORT' -> BUY)
                // and sets reduceOnly=true, so pass the position side as-is.
                await asterClose(sym, pos.side as 'LONG' | 'SHORT', contractSize, creds)
              } catch (e: any) {
                console.error(`[Agent ${agent.name}] Aster close failed in emergency:`, e?.message)
              }
            }
            const dirMult = pos.side === 'LONG' ? 1 : -1
            const pnl = ((exitPx - pos.entryPrice) / pos.entryPrice) * pos.size * pos.leverage * dirMult
            await db.trade.update({
              where: { id: pos.id },
              data: { status: 'closed', exitPrice: exitPx, pnl, closedAt: new Date() }
            })
          } catch (e: any) {
            console.error(`[Agent ${agent.name}] Emergency close error on trade ${pos.id}:`, e?.message)
          }
        }
        const _bot2 = getBot()
        if (_bot2 && telegramId) {
          _bot2.api
            .sendMessage(
              telegramId,
              `🚨 *EMERGENCY: ${escapeMd(agent.name)} closed ${allOpen.length} position(s)*\n\n` +
                `Breaking: ${newsSignal.topHeadline}\n\n` +
                `Protecting your funds from news impact.`,
              { parse_mode: 'Markdown' }
            )
            .catch(() => {})
        }
        await safeAgentLogCreate({
          data: {
            agentId: agent.id,
            userId: agent.userId,
            action: 'EMERGENCY_CLOSE',
            parsedAction: 'CLOSE',
            executionResult: `Closed ${allOpen.length} positions on news`,
            pair,
            reason: newsSignal.topHeadline.slice(0, 240),
            score: newsSignal.score
          }
        })
        return
      }

      // News context appended to Claude's prompt below.
      const newsAgeMin = Math.max(0, Math.round((Date.now() - getNewsLastUpdated()) / 60000))
      const newsContext =
        newsSignal.score !== 0
          ? `\n=== NEWS INTELLIGENCE (${newsAgeMin}min ago) ===\n` +
            `Sentiment: ${newsSignal.sentiment} (${newsSignal.score > 0 ? '+' : ''}${newsSignal.score}/10)\n` +
            `Top headline: "${newsSignal.topHeadline}"\n` +
            `Affected coins: ${newsSignal.affectedCoins.join(', ') || 'broad market'}\n` +
            `News recommendation: ${newsSignal.action}\n` +
            `Reason: ${newsSignal.reason}` +
            (newsSignal.shouldOverride ? `\n⚠️ NEWS OVERRIDE ACTIVE — prioritize news signal over technicals` : '')
          : ''

      // 2b. Funding rate signal. Aster returns `lastFundingRate` as a decimal
      // (e.g. 0.0001 == 0.01% per funding interval). Used three ways below:
      //   • added to the Claude prompt as market-context
      //   • hard-skip new entries when funding edge is below 0.01%
      //   • combined with ADX to avoid an LLM call when the market is
      //     clearly ranging with no funding edge (cost guard, ~60% savings)
      let fundingRate = 0
      try {
        const { getMarkPrice } = await import('../services/aster')
        const mp = await getMarkPrice(pair)
        fundingRate = mp.lastFundingRate || 0
      } catch {
        fundingRate = 0
      }
      const fundingPct = fundingRate * 100 // 0.0001 -> 0.01

      // Cost guard: if the market shows no regime edge AND no funding edge,
      // skip the Claude call entirely. Only safe when we have nothing to
      // manage on this pair — if we hold a position, Claude must still
      // decide whether to close it.
      // Threshold note: user spec says `Math.abs(fundingRate) < 0.02`;
      // interpreted as 0.02% (=0.0002 decimal) to stay consistent with the
      // 0.01% threshold in the funding-skip rule below.
      if (
        openPositions.length === 0 &&
        snapshot.adx > 0 &&
        snapshot.adx < 18 &&
        Math.abs(fundingRate) < 0.0002
      ) {
        await safeAgentLogCreate({
          data: {
            agentId: agent.id,
            userId: agent.userId,
            action: 'HOLD',
            parsedAction: 'HOLD',
            executionResult: 'No regime edge — LLM call skipped',
            pair,
            price: snapshot.price || null,
            reason: `No regime edge (ADX ${snapshot.adx.toFixed(1)}, funding ${fundingPct.toFixed(3)}%)`,
            adx: Number.isFinite(snapshot.adx) ? snapshot.adx : null,
            rsi: Number.isFinite(snapshot.rsi) ? snapshot.rsi : null,
            score: 0,
            regime: 'RANGING'
          }
        })
        // continue (not return): skipping the LLM call is free, so we
        // still want to evaluate every other pair this tick. Different
        // from the post-Claude HOLD branch below, which returns to cap
        // Claude spend at one call per tick per agent.
        continue
      }

      // Funding-only skip: when funding rate edge is essentially zero
      // (<0.01%), there is no statistical bias from the perp basis. Skip
      // new entries to conserve Claude budget. Existing positions still
      // need management, so don't skip if we hold one on this pair.
      if (openPositions.length === 0 && Math.abs(fundingRate) < 0.0001) {
        await safeAgentLogCreate({
          data: {
            agentId: agent.id,
            userId: agent.userId,
            action: 'HOLD',
            parsedAction: 'HOLD',
            executionResult: 'Funding edge too small — LLM call skipped',
            pair,
            price: snapshot.price || null,
            reason: `Funding rate ${fundingPct.toFixed(4)}% — no edge`,
            adx: Number.isFinite(snapshot.adx) ? snapshot.adx : null,
            rsi: Number.isFinite(snapshot.rsi) ? snapshot.rsi : null,
            score: 0,
            regime: snapshot.regime
          }
        })
        // continue (not return) — same reasoning as the regime-skip above:
        // pre-LLM skips are cheap, so let the loop check remaining pairs.
        continue
      }

      // Cost guard #3: Claude consistently HOLDs on extreme RSI and volume
      // collapse with reasons like "refusing to chase parabolic", "volume
      // 0.22x fails threshold", "extreme overbought". Replicate those rules
      // deterministically to avoid paying for the same answer every 60s.
      // Only fires when no open positions on this pair AND we have full
      // (non-new-listing) klines so RSI/volume are meaningful.
      if (openPositions.length === 0 && ohlcv) {
        const vols1h    = ohlcv['1h'].volume
        const volSMA20  = vols1h.length >= 20 ? calculateSMA(vols1h, 20) : 0
        const volCur    = vols1h[vols1h.length - 1] ?? 0
        const volRatio  = volSMA20 > 0 ? volCur / volSMA20 : NaN
        const rsi       = snapshot.rsi
        const extremeRsi    = rsi >= 80 || (rsi > 0 && rsi <= 20)
        const volumeCollapse = Number.isFinite(volRatio) && volRatio < 0.4

        if (extremeRsi || volumeCollapse) {
          const reason = extremeRsi && volumeCollapse
            ? `RSI ${rsi.toFixed(1)} extreme + volume ${volRatio.toFixed(2)}x collapse`
            : extremeRsi
              ? `RSI ${rsi.toFixed(1)} in extreme zone — refusing to chase`
              : `Volume ${volRatio.toFixed(2)}x of 20-period avg — no participation`
          await safeAgentLogCreate({
            data: {
              agentId: agent.id,
              userId: agent.userId,
              action: 'HOLD',
              parsedAction: 'HOLD',
              executionResult: 'Deterministic HOLD — LLM call skipped',
              pair,
              price: snapshot.price || null,
              reason,
              adx: Number.isFinite(snapshot.adx) ? snapshot.adx : null,
              rsi: Number.isFinite(snapshot.rsi) ? snapshot.rsi : null,
              score: 0,
              regime: snapshot.regime
            }
          })
          continue
        }
      }

      // 3. Get today's PnL
      const todayPnl = await getTodayPnl(agent.id)

      // 4. Hard stop — daily loss limit
      if (todayPnl <= -agent.maxDailyLoss) {
        await db.agent.update({
          where: { id: agent.id },
          data: { isPaused: true }
        })
        console.log(`[Agent ${agent.name}] Daily loss limit hit. Paused.`)
        return
      }

      // 5. Get recent trades + memories
      const recentTrades = await db.trade.findMany({
        where: { agentId: agent.id, status: 'closed' },
        orderBy: { closedAt: 'desc' },
        take: 5
      })

      const memoryContext = await buildMemoryContext(agent.id)
      const lastTwoLosses =
        recentTrades.length >= 2 && recentTrades.slice(0, 2).every((t) => (t.pnl ?? 0) < 0)
      const todayPnlPct = (todayPnl / agent.maxPositionSize) * 100

      // ── Dynamic position sizing (half-Kelly tier) ─────────────────────
      // Sample is the last 20 closed trades. New agents trade tiny while
      // they build a track record; only after a real edge is demonstrated
      // does the size scale up. Persistent losers get auto-paused so they
      // stop bleeding the user.
      const last20 = await db.trade.findMany({
        where: { agentId: agent.id, status: 'closed' },
        orderBy: { closedAt: 'desc' },
        take: 20
      })
      const sampleSize = last20.length
      const wins20 = last20.filter((t) => (t.pnl ?? 0) > 0).length
      const winRate20 = sampleSize > 0 ? wins20 / sampleSize : 0

      // Auto-pause: 20 trades and still <35% win rate -> agent is losing.
      if (sampleSize >= 20 && winRate20 < 0.35) {
        await db.agent.update({
          where: { id: agent.id },
          data: { isPaused: true }
        })
        const _bot = getBot()
        if (_bot && telegramId) {
          _bot.api
            .sendMessage(
              telegramId,
              `⚠️ *${escapeMd(agent.name)} paused*\n\n` +
                `Win rate over the last 20 trades: ${(winRate20 * 100).toFixed(0)}%.\n` +
                `Auto-paused to protect your capital. Review the agent's strategy and resume manually when ready.`,
              { parse_mode: 'Markdown' }
            )
            .catch(() => {})
        }
        console.log(`[Agent ${agent.name}] Auto-paused: win rate ${(winRate20 * 100).toFixed(0)}% < 35%`)
        return
      }

      // Tier mapping (USDT). Capped at agent.maxPositionSize so the user's
      // own ceiling always wins.
      let kellySize: number
      if (sampleSize < 10)         kellySize = 2
      else if (winRate20 < 0.40)   kellySize = 2
      else if (winRate20 < 0.50)   kellySize = 3
      else if (winRate20 < 0.60)   kellySize = 5
      else                         kellySize = 10
      kellySize = Math.min(kellySize, agent.maxPositionSize)

      // New-listing override: regardless of Kelly tier, force quarter-size on
      // momentum trades. Volatility kills full positions on fresh listings
      // even when the direction is right.
      if (isNewListingPair) {
        kellySize = Math.max(1, Math.min(kellySize, agent.maxPositionSize * 0.25))
      }

      // 5b. 42.space prediction-market context. Cached for ~60s inside
      //     build42MarketContext, so concurrent agent ticks share one fetch.
      //     Wrapped in try/catch + 1.5s timeout race — if the 42 stack hangs
      //     or rejects, we still trade. Trading must never block on this.
      let predictionContext = ''
      try {
        const { build42MarketContext } = await import('../services/fortyTwoPrompt')
        const block = await Promise.race<string>([
          build42MarketContext({ maxMarkets: 5, tradingRelevantOnly: true }),
          new Promise<string>((resolve) => setTimeout(() => resolve(''), 1500)),
        ])
        if (block.trim()) predictionContext = '\n' + block
      } catch (err) {
        console.warn(`[Agent ${agent.name}] 42.space context unavailable:`, (err as Error).message)
      }

      // 5c. Surface this agent's currently-open prediction positions to Claude.
      // Without this block the LLM has no grounded position IDs to reference,
      // making CLOSE_PREDICTION decisions impossible. Listed inline so the
      // model can pick a `positionId` from the visible inventory.
      try {
        const { listOpenAgentPositions } = await import('../services/fortyTwoExecutor')
        const open = await listOpenAgentPositions(agent.id)
        if (open.length > 0) {
          const lines = open
            .map((p) => {
              const ageH = Math.max(0, Math.floor((Date.now() - new Date(p.openedAt).getTime()) / 3_600_000))
              const title = p.marketTitle.length > 60 ? p.marketTitle.slice(0, 57) + '…' : p.marketTitle
              return `• positionId=${p.id} | ${p.outcomeLabel} @ ${(p.entryPrice * 100).toFixed(0)}% | $${p.usdtIn.toFixed(2)} in | ${ageH}h old | ${title}`
            })
            .join('\n')
          predictionContext +=
            `\n## Your Open 42.space Positions (use positionId for CLOSE_PREDICTION)\n${lines}\n`
        }
      } catch (err) {
        console.warn(`[Agent ${agent.name}] open prediction positions unavailable:`, (err as Error).message)
      }

      // 6. Build user message
      const userMessage = `
=== MARKET DATA ===
${marketContext}

=== AGENT STATE ===
Agent: ${agent.name} | Exchange: ${agent.exchange}
Max Position: $${agent.maxPositionSize} USDT | Max Leverage: ${agent.maxLeverage}x
SL Setting: ${agent.stopLossPct}% | TP Setting: ${agent.takeProfitPct}%
Max Daily Loss: $${agent.maxDailyLoss} USDT

Today's PnL: ${todayPnl >= 0 ? '+' : ''}$${todayPnl.toFixed(2)} USDT (${todayPnlPct.toFixed(1)}%)
Daily Loss Remaining: $${(agent.maxDailyLoss + todayPnl).toFixed(2)} USDT
Drawdown Mode: ${lastTwoLosses ? 'YES — last 2 trades were losses, apply 50% size reduction' : 'NO'}

=== FUNDING RATE ===
Current funding rate: ${fundingPct >= 0 ? '+' : ''}${fundingPct.toFixed(4)}% (${
        fundingRate > 0
          ? 'market overleveraged LONG — shorts have statistical edge this period'
          : fundingRate < 0
            ? 'market overleveraged SHORT — longs have statistical edge this period'
            : 'neutral'
      })

=== POSITION SIZE BUDGET ===
Use exactly $${kellySize} USDT for this trade's "size" field (sample n=${sampleSize}, win rate ${(winRate20 * 100).toFixed(0)}%).
${newsContext}${predictionContext}

=== OPEN POSITIONS ===
${
  openPositions.length === 0
    ? 'No open positions.'
    : openPositions
        .map(
          (p) =>
            `${p.pair} ${p.side} | Entry: $${p.entryPrice} | Size: $${p.size} | Leverage: ${p.leverage}x`
        )
        .join('\n')
}

=== RECENT TRADE HISTORY ===
${
  recentTrades.length === 0
    ? 'No recent trades.'
    : recentTrades
        .map(
          (t) =>
            `${t.pair} ${t.side} → ${(t.pnl ?? 0) >= 0 ? 'WIN' : 'LOSS'} ${(t.pnl ?? 0) >= 0 ? '+' : ''}$${(t.pnl ?? 0).toFixed(2)} USDT`
        )
        .join('\n')
}

Win rate (all time): ${agent.winRate.toFixed(1)}% over ${agent.totalTrades} trades

=== AGENT MEMORY ===
${memoryContext}

=== YOUR TASK ===
Analyze the market data above for ${pair}.
Apply your decision framework: regime → alignment → setup score → risk management.
Return your decision as JSON. Be precise and honest about confidence.
If you would not put real money in this trade right now, action = HOLD.`

      // 7. Call the LLM. Two paths:
      //    (a) swarmEnabled=true → run the prompt across every configured
      //        provider via the swarm decision layer and use the quorum
      //        verdict (falling back to the single-provider path if the
      //        swarm produced no consensus).
      //    (b) swarmEnabled=false (default) → original Anthropic-only path.
      // The single-provider path is preserved deliberately as a fallback.
      let decision: AgentDecision
      let rawResponse = ''
      // The telemetry array is built only on the swarm path; null otherwise.
      let providersTelemetry: import('../services/fortyTwoExecutor').ProviderTelemetry[] | null = null

      const swarmRows = await db.$queryRawUnsafe<Array<{ swarmEnabled: boolean }>>(
        `SELECT "swarmEnabled" FROM "User" WHERE id = $1 LIMIT 1`,
        agent.userId,
      ).catch(() => [])
      const swarmOn = swarmRows[0]?.swarmEnabled === true

      // Phase 1B: route the LLM call through the shared market scan so
      // every agent tracking this pair shares one inference per tick
      // instead of paying N times. The shared scan is intentionally
      // generic — it never sees per-agent state. Per-agent overlays
      // (CLOSE intent, memory veto, drawdown cut, leverage default)
      // are applied deterministically AFTER the scan resolves.
      try {
        const scan = await getSharedMarketScan(
          {
            pair,
            mode: isNewListingPair ? 'momentum' : 'standard',
            ...(isNewListingPair
              ? { momentumOhlcv: momentumOhlcv ?? undefined }
              : { ohlcv: ohlcv ?? undefined }),
            fundingRate,
          },
          {
            swarmOn,
            // News + prediction context are shared across every agent on
            // this pair within the cache TTL — these fetchers only fire
            // on the first cache miss for this (pair, mode, tick).
            fetchNewsBlock: async () => newsContext,
            fetchPredictionBlock: async () => predictionContext,
          },
        )
        decision = scan.decision
        rawResponse = scan.rawResponse
        providersTelemetry = scan.providersTelemetry

        // ── Per-agent overlay 1: CLOSE intent ────────────────────────
        // The shared scan downgrades CLOSE → HOLD because closing is
        // per-agent (depends on whether *this* agent holds the
        // position). Re-promote here when the LLM's true verdict was
        // "exit this market" AND we actually have a position to close.
        // The existing CLOSE handler at L1820 takes it from there.
        if (
          scan.sharedActionRaw === 'CLOSE' &&
          openPositions.some((p) => p.pair === pair)
        ) {
          decision = { ...decision, action: 'CLOSE', holdReason: null }
        }

        // ── Per-agent overlay 2: memory veto ─────────────────────────
        // The shared scan never sees agent memory. Block a fresh OPEN
        // if we lost on this exact pair + side within the lookback
        // window (default 48h). Cheap protection against repeating the
        // same mistake — and a deterministic stand-in for the memory
        // weighting the LLM used to do per-agent.
        if (decision.action === 'OPEN_LONG' || decision.action === 'OPEN_SHORT') {
          const proposedSide = decision.action === 'OPEN_LONG' ? 'LONG' : 'SHORT'
          const recentMems = await getRecentMemories(agent.id, 30).catch(() => [])
          const vetoed = shouldVetoOnMemory({
            memories: recentMems.map((m) => ({
              type: m.type,
              content: m.content,
              createdAt: m.createdAt,
            })),
            pair,
            side: proposedSide,
            nowMs: Date.now(),
          })
          if (vetoed) {
            console.log(
              `[Agent ${agent.name}] Memory veto: recent ${proposedSide} loss on ${pair} within 48h`
            )
            decision = {
              ...decision,
              action: 'HOLD',
              holdReason: `Skipping repeat ${proposedSide} on ${pair} — recent loss in last 48h.`,
            }
          }
        }

        // ── Per-agent overlay 3: drawdown size cut ───────────────────
        // The shared scan doesn't know this agent's recent PnL. Mirror
        // the previous LLM-instructed 50% cut when the last two trades
        // were losses. Mutating kellySize here flows naturally into the
        // existing sizer at L1619 (Math.min(decision.size ?? kellySize,
        // kellySize)).
        kellySize = applyDrawdownSizeCut({ kellySize, lastTwoLosses })

        // ── Per-agent overlay 4: leverage default ────────────────────
        // The shared scan returns leverage=null. The downstream clamp
        // at L1578 falls back to `?? 1` — a literal 1x for OPEN signals,
        // which would silently sandbag every shared-scan trade. Default
        // to the agent's max so the clamp behaves as a no-op for
        // shared-scan callers (matching the original LLM behaviour
        // where the LLM was told the cap and almost always picked it).
        if (
          (decision.action === 'OPEN_LONG' || decision.action === 'OPEN_SHORT') &&
          decision.leverage == null
        ) {
          decision.leverage = agent.maxLeverage
        }
      } catch (aiErr) {
        console.error(`[Agent ${agent.name}] Shared scan failed:`, aiErr)
        await safeAgentLogCreate({
          data: {
            agentId: agent.id,
            userId: agent.userId,
            action: 'TICK_ERROR',
            rawResponse: String(aiErr),
            parsedAction: 'HOLD',
            executionResult: 'AI call failed, defaulted to HOLD'
          }
        })
        return
      }

      // 8. Log the decision — full snapshot for the live "Agent Brain" feed.
      const logReason = (decision.action === 'HOLD'
        ? (decision.holdReason ?? decision.reasoning ?? '')
        : (decision.reasoning ?? '')
      ).slice(0, 240)
      await safeAgentLogCreate({
        data: {
          agentId: agent.id,
          userId: agent.userId,
          action: decision.action,
          rawResponse: rawResponse.slice(0, 2000),
          parsedAction: decision.action,
          executionResult: `confidence=${decision.confidence}, score=${decision.setupScore}`,
          pair,
          price: snapshot.price || null,
          reason: logReason,
          adx: Number.isFinite(snapshot.adx) ? snapshot.adx : null,
          rsi: Number.isFinite(snapshot.rsi) ? snapshot.rsi : null,
          score: typeof decision.setupScore === 'number' ? decision.setupScore : null,
          regime: decision.regime ?? snapshot.regime ?? null,
          providers: providersTelemetry
        }
      })

      // Snapshot for the per-tick Telegram "Agent Brain" summary.
      tickDecisions.push({
        pair,
        action: decision.action,
        score: typeof decision.setupScore === 'number' ? decision.setupScore : null,
        regime: decision.regime ?? snapshot.regime,
        rsi: snapshot.rsi,
        adx: snapshot.adx,
        price: snapshot.price,
        holdReason: decision.holdReason ?? null,
        reasoning: decision.reasoning ?? null
      })

      // ─── 42.space prediction-market sidecar ─────────────────────────────
      // Independent of the perp action above. Must run BEFORE the perp branches
      // because HOLD/OPEN/CLOSE all `return`/exit. Position sizing, edge
      // thresholds, daily quotas, and live/paper gating live in fortyTwoExecutor.
      // Failures are logged but never propagate (prediction is bonus revenue).
      if (decision.predictionTrade) {
        try {
          const pt = decision.predictionTrade
          const exec = await import('../services/fortyTwoExecutor')
          const ctxExec = {
            agentId: agent.id,
            userId: agent.userId,
            agentMaxPositionSize: agent.maxPositionSize
          }
          if (pt.action === 'OPEN_PREDICTION') {
            const res = await exec.openPredictionPosition(ctxExec, pt, providersTelemetry)
            if (res.ok) {
              const mode = res.paperTrade ? 'PAPER' : 'LIVE'
              console.log(
                `[Agent ${agent.name}] OPEN_PREDICTION (${mode}) ${pt.outcomeLabel ?? `tid=${pt.tokenId}`} @ ${pt.marketAddress.slice(0, 10)}… size=$${res.usdtIn} positionId=${res.positionId}`
              )
              await safeAgentLogCreate({
                data: {
                  agentId: agent.id,
                  userId: agent.userId,
                  action: 'OPEN_PREDICTION',
                  parsedAction: 'OPEN_PREDICTION',
                  executionResult: `${mode} | $${res.usdtIn} | ${pt.outcomeLabel ?? pt.tokenId}`,
                  reason: (pt.reasoning ?? '').slice(0, 240)
                }
              })
              const _botPred = getBot()
              if (_botPred && telegramId) {
                _botPred.api
                  .sendMessage(
                    telegramId,
                    `🎯 *${escapeMd(agent.name)}* opened prediction position\n\n` +
                      `*Market:* ${escapeMd(pt.marketAddress.slice(0, 10))}…\n` +
                      `*Outcome:* ${escapeMd(pt.outcomeLabel ?? `tokenId ${pt.tokenId}`)}\n` +
                      `*Size:* $${res.usdtIn} USDT (${res.paperTrade ? '📝 paper' : '🔴 live'})\n` +
                      `*Conviction:* ${((pt.conviction ?? 0) * 100).toFixed(0)}%`,
                    { parse_mode: 'Markdown' }
                  )
                  .catch(() => {})
              }
            } else {
              console.log(`[Agent ${agent.name}] prediction skipped: ${res.reason}`)
              await safeAgentLogCreate({
                data: {
                  agentId: agent.id,
                  userId: agent.userId,
                  action: 'PREDICTION_SKIP',
                  parsedAction: 'HOLD',
                  executionResult: res.reason
                }
              })
            }
          } else if (pt.action === 'CLOSE_PREDICTION' && pt.positionId) {
            const res = await exec.closePredictionPosition(ctxExec, pt.positionId)
            if (res.ok) {
              console.log(
                `[Agent ${agent.name}] CLOSE_PREDICTION pnl=$${res.pnl.toFixed(2)} positionId=${pt.positionId}`
              )
            }
          }
        } catch (predErr: any) {
          console.error(`[Agent ${agent.name}] prediction sidecar error:`, predErr?.message)
        }
      }

      // Send a "thinking" message to the user — throttled (verbose for the
      // first 3 ticks after activation, then only on actions or near-miss
      // setups, max once per 5 minutes when nothing is happening).
      const _bot = getBot()
      const hasAction = decision.action !== 'HOLD'
      const bestScore = decision.setupScore ?? 0
      if (_bot && telegramId && shouldSendSummary(agent.id, hasAction, bestScore)) {
        markSummarySent(agent.id)
        const actionEmoji =
          decision.action === 'HOLD' ? '⏸ HOLD'
            : decision.action === 'OPEN_LONG' ? '🚀 LONG'
            : decision.action === 'OPEN_SHORT' ? '🔻 SHORT'
            : decision.action === 'CLOSE' ? '✋ CLOSE'
            : decision.action
        const why = (decision.action === 'HOLD'
          ? (decision.holdReason ?? 'Conditions not yet aligned.')
          : (decision.reasoning ?? '')
        ).slice(0, 200)
        const adxStr = Number.isFinite(snapshot.adx) ? snapshot.adx.toFixed(1) : '—'
        const rsiStr = Number.isFinite(snapshot.rsi) ? snapshot.rsi.toFixed(1) : '—'
        const scoreStr = typeof decision.setupScore === 'number' ? `${decision.setupScore}/10` : '—'
        const summary =
          `🧠 *${escapeMd(agent.name)}* analyzed ${pair}\n\n` +
          `*Market Regime:* ${decision.regime ?? snapshot.regime} (ADX ${adxStr})\n` +
          `*Setup Score:* ${scoreStr} | RSI ${rsiStr}\n\n` +
          `*Decision:* ${actionEmoji}\n` +
          `*Reason:* ${why}\n\n` +
          `_Next scan in 60 seconds ⏰_`
        _bot.api.sendMessage(telegramId, summary, { parse_mode: 'Markdown' }).catch(() => {})
      }

      // 9. Update last tick time
      await db.agent.update({
        where: { id: agent.id },
        data: { lastTickAt: new Date() }
      })

      // 10. Process decision
      if (decision.action === 'HOLD') {
        if (decision.memoryUpdate) {
          await saveMemory(agent.id, 'observation', decision.memoryUpdate, {
            regime: decision.regime,
            setupScore: decision.setupScore,
            pair
          })
        }
        console.log(
          `[Agent ${agent.name}] HOLD on ${pair} — ${decision.holdReason?.slice(0, 80) ?? 'no specific reason'}`
        )
        // NOTE: keep `return` (not `continue`) — exiting on first HOLD bounds
        // LLM spend at 1 Claude call/tick/agent. Changing to `continue` would
        // 7× cost when pairs:['ALL']. The mini app live feed accumulates
        // across many ticks anyway, so visibility is preserved at low cost.
        return
      }

      if (decision.action === 'OPEN_LONG' || decision.action === 'OPEN_SHORT') {
        // Helper: log every reason an OPEN_LONG/OPEN_SHORT is killed before
        // it reaches the exchange. Without this, silent returns made it
        // impossible to tell from AgentLog whether agents were never
        // deciding to trade or were deciding to trade and then being
        // gated. Use action='SKIP_OPEN' so the diagnose endpoint can
        // surface the breakdown by reason.
        const logSkip = async (gate: string, reason: string) => {
          await safeAgentLogCreate({
            data: {
              agentId: agent.id,
              userId: agent.userId,
              action: 'SKIP_OPEN',
              parsedAction: decision.action,
              executionResult: gate,
              pair,
              price: snapshot.price || null,
              reason,
              adx: Number.isFinite(snapshot.adx) ? snapshot.adx : null,
              rsi: Number.isFinite(snapshot.rsi) ? snapshot.rsi : null,
              score: decision.setupScore ?? 0,
              regime: decision.regime ?? null
            }
          })
        }

        // Validate. New-listing momentum trades use a relaxed R/R floor of
        // 1.5 (matching the new-listing prompt); standard mode now uses 1.5
        // too (matches loosened standard prompt — was 2.0 historically).
        const rrFloor = isNewListingPair ? 1.5 : 1.5
        if ((decision.riskRewardRatio ?? 0) < rrFloor) {
          await saveMemory(
            agent.id,
            'observation',
            `Skipped ${pair} ${decision.action} — R/R was only ${decision.riskRewardRatio?.toFixed(1)}, below ${rrFloor} minimum`,
            null
          )
          await logSkip('rr_floor', `R/R ${decision.riskRewardRatio?.toFixed(2) ?? 'missing'} < ${rrFloor}`)
          return
        }

        if (decision.confidence < 0.55) {
          await logSkip('confidence_floor', `confidence ${decision.confidence.toFixed(2)} < 0.55`)
          return
        }

        if ((decision.setupScore ?? 0) < 4) {
          await logSkip('setup_score_floor', `setupScore ${decision.setupScore ?? 'missing'} < 4`)
          return
        }

        const side = decision.action === 'OPEN_LONG' ? 'LONG' : ('SHORT' as const)

        // Hard-clamp leverage to the agent's configured maxLeverage. The LLM
        // is told this cap in the prompt but doesn't always honour it (we've
        // seen 15x trades opened on a 5x agent), so enforce it here at the
        // last gate before the order hits the exchange.
        const requestedLev = decision.leverage ?? 1
        const clampedLev = Math.max(1, Math.min(requestedLev, agent.maxLeverage))
        if (clampedLev !== requestedLev) {
          console.warn(`[Agent ${agent.name}] Clamping leverage ${requestedLev}x → ${clampedLev}x (agent max ${agent.maxLeverage}x)`)
        }
        decision.leverage = clampedLev

        const riskCheck = await checkRiskGuard(
          agent,
          pair,
          side,
          decision.size ?? agent.maxPositionSize,
          clampedLev
        )

        if (!riskCheck.allowed) {
          console.log(`[Agent ${agent.name}] Risk guard blocked: ${riskCheck.reason}`)
          return
        }

        // Optional Trust Wallet (TWAK) pre-trade risk gate. Off by default;
        // enable with TWAK_TRADING_INTEGRATION=true. The check returns
        // allowed=true if TWAK is unconfigured or unreachable, so this can
        // never block trades because of an integration outage.
        try {
          const { checkTradeRisk } = await import('../services/trustwallet')
          const baseSymbol = pair.split('/')[0]
          const twakRisk = await checkTradeRisk(baseSymbol)
          if (!twakRisk.allowed) {
            console.log(`[Agent ${agent.name}] TWAK risk gate blocked ${pair}: ${twakRisk.reason}`)
            return
          }
          if (twakRisk.riskScore !== undefined) {
            console.log(`[Agent ${agent.name}] TWAK risk ${twakRisk.riskScore}/10 OK for ${pair}`)
          }
        } catch (e: any) {
          console.error(`[Agent ${agent.name}] TWAK risk check errored (ignored):`, e.message)
        }

        // Use the half-Kelly tier size, ignoring whatever Claude returned.
        // Claude was told to use exactly this number; capping enforces it
        // even if it didn't follow instructions.
        let finalSize = Math.min(decision.size ?? kellySize, kellySize)
        if (riskCheck.reduceSizeBy) {
          finalSize = finalSize * (1 - riskCheck.reduceSizeBy / 100)
        }

        const currentPrice = ohlcv
          ? ohlcv['15m'].close[ohlcv['15m'].close.length - 1]
          : snapshot.price

        // ── Real Aster execution ──────────────────────────────────────────
        let fillPrice = currentPrice
        let orderIdStr = 'mock_' + Date.now()

        // Build EIP-712 credentials for this user
        const dbUser = await db.user.findUnique({
          where: { id: agent.userId },
          include: { wallets: { where: { isActive: true }, take: 1 } }
        })
        const userAddress = dbUser?.wallets?.[0]?.address ?? ''
        const { resolveAgentCreds } = await import('../services/aster')
        const creds = dbUser ? await resolveAgentCreds(dbUser, userAddress) : null

        if (creds && agent.exchange !== 'mock') {
          try {
            // ── Pre-flight balance check — never open a new position with
            // a negative or zero Aster balance. Realized losses, funding,
            // or commission can drag walletBalance below 0 and any further
            // OPEN order will be rejected by Aster anyway. Closing existing
            // positions is unaffected (this branch only runs for OPEN_*).
            const { getAccountBalanceStrict } = await import('../services/aster')
            try {
              const bal = await getAccountBalanceStrict(creds)
              const asterBalance = bal.usdt
              if (asterBalance <= 0) {
                console.log(`[Agent ${agent.name}] Skipping ${pair} ${side} — negative Aster balance: ${asterBalance.toFixed(4)} USDT`)
                continue
              }
            } catch (balErr: any) {
              // If the balance check itself fails (RPC down, not onboarded
              // yet, etc.) we let the order attempt proceed — Aster will
              // reject it with a clearer error than we can synthesize here.
              console.warn(`[Agent ${agent.name}] Balance pre-check failed (${balErr?.message}), proceeding anyway`)
            }

            const { placeOrder, placeOrderWithBuilderCode, placeBracketOrders } = await import('../services/aster')
            const sym = pair.replace(/[\/\s]/g, '').toUpperCase()
            const qty = parseFloat((finalSize / currentPrice).toFixed(6))

            const builderAddress = process.env.ASTER_BUILDER_ADDRESS
            const feeRate        = process.env.ASTER_BUILDER_FEE_RATE ?? '0.0001'

            let result
            if (builderAddress && dbUser?.asterOnboarded) {
              // ── Builder route (fee attribution to your wallet) ─────────
              result = await placeOrderWithBuilderCode({
                symbol:         sym,
                side:           side === 'LONG' ? 'BUY' : 'SELL',
                type:           'MARKET',
                quantity:       qty,
                builderAddress,
                feeRate,
                creds
              })
            } else {
              // ── Standard v3 route (no builder fee) ────────────────────
              result = await placeOrder({
                symbol:   sym,
                side:     side === 'LONG' ? 'BUY' : 'SELL',
                type:     'MARKET',
                quantity: qty,
                leverage: decision.leverage ?? 1,
                creds
              })
            }

            fillPrice  = result.avgPrice > 0 ? result.avgPrice : currentPrice
            orderIdStr = String(result.orderId)

            // SL + TP bracket orders. Pass the builder address through so
            // the closing fills also route through BUILD4 — without this
            // the entry collects the broker fee but the exit fill (SL/TP)
            // bypasses it, leaking ~50% of fee revenue per trade.
            if (decision.stopLoss && decision.takeProfit) {
              await placeBracketOrders({
                symbol:     sym,
                side,
                stopLoss:   decision.stopLoss,
                takeProfit: decision.takeProfit,
                quantity:   qty,
                creds,
                builderAddress,
                feeRate,
              })
            }
          } catch (execErr: any) {
            // Aster's signedPOST uses axios; on a 4xx the actual rejection
            // reason (e.g. "Account has insufficient balance", "Filter failure:
            // MIN_NOTIONAL", "Order would immediately liquidate") lives in
            // err.response.data — NOT in err.message (which is just the
            // generic "Request failed with status code 400"). Without
            // unwrapping it, every order failure looks identical in logs and
            // diagnosis is impossible. Hoist the body into execMsg so the
            // existing log line + memory note + auto-heal regex all see the
            // real Aster error string.
            const respBody = execErr?.response?.data
            const respDetail = respBody
              ? (typeof respBody === 'string' ? respBody : JSON.stringify(respBody))
              : ''
            const execMsg = respDetail
              ? `${execErr?.message ?? 'request failed'} — Aster: ${respDetail}`
              : String(execErr?.message ?? '')
            // Self-heal: when Aster returns -1000 "No agent found", the
            // user's on-file agent address isn't recognised by Aster
            // anymore (broker rotation, partial earlier flow, etc).
            // Without intervention this user is silently stuck — every
            // future tick re-fails identically. Fire reapproveAsterForUser
            // once now so the NEXT tick (≤60s) uses fresh creds and the
            // order succeeds. We don't retry the order in-tick because
            // we'd need to re-derive position sizing, balance check, and
            // bracket math — far simpler to let the next tick re-evaluate
            // from scratch with the same fresh signal.
            if (/no agent found|-1000/i.test(execMsg) && dbUser) {
              console.warn(
                `[Agent ${agent.name}] Aster reports "No agent found" — auto-reapproving for user=${dbUser.id} ` +
                `so next tick recovers without user intervention`
              )
              try {
                const { reapproveAsterForUser } = await import('../services/asterReapprove')
                const r = await reapproveAsterForUser(dbUser as any)
                console.log(
                  `[Agent ${agent.name}] auto-reapprove → success=${r.success} ` +
                  `agent=${r.agentAddress ?? 'n/a'} builder=${r.builderEnrolled ?? false} ` +
                  `error=${r.error ?? 'none'}`
                )
              } catch (healErr: any) {
                console.error(`[Agent ${agent.name}] auto-reapprove threw:`, healErr?.message)
              }
            }
            console.error(`[Agent ${agent.name}] Order execution failed:`, execErr.message)
            await saveMemory(agent.id, 'correction',
              `Order execution failed for ${pair} ${side}: ${execErr.message}`, null)
            return
          }
        }
        // ─────────────────────────────────────────────────────────────────

        const trade = await db.trade.create({
          data: {
            userId:     agent.userId,
            agentId:    agent.id,
            exchange:   agent.exchange,
            pair,
            side,
            entryPrice: fillPrice,
            size:       finalSize,
            leverage:   decision.leverage ?? 1,
            status:     'open',
            txHash:     orderIdStr,
            aiReasoning: decision.reasoning,
            signalsUsed: {
              regime:            decision.regime,
              setupScore:        decision.setupScore,
              timeframeAlignment: decision.timeframeAlignment,
              confidence:        decision.confidence,
              stopLoss:          decision.stopLoss,
              takeProfit:        decision.takeProfit
            }
          }
        })

        if (decision.memoryUpdate) {
          await saveMemory(agent.id, 'decision', decision.memoryUpdate, {
            action:     decision.action,
            pair,
            setupScore: decision.setupScore,
            tradeId:    trade.id
          })
        }

        openedThisTick++

        console.log(
          `[Agent ${agent.name}] Opened ${side} ${pair} @ $${fillPrice.toFixed(2)} | Size: $${finalSize.toFixed(0)} | Score: ${decision.setupScore}/10 | OrderId: ${orderIdStr}`
        )

        // Send the rich "🤖 X opened a position" Telegram message. The
        // notifier needs `pair` on the decision object — inject it here so
        // the existing helper formats the header correctly.
        const _bot2 = getBot()
        if (_bot2 && telegramId) {
          notifyTradeOpened(
            _bot2,
            telegramId,
            agent.name,
            { ...decision, pair },
            fillPrice,
            finalSize
          )
        }
      }

      if (decision.action === 'CLOSE') {
        const openPos = await db.trade.findFirst({
          where: { agentId: agent.id, pair, status: 'open' }
        })

        if (!openPos) return

        let exitPrice = ohlcv
          ? ohlcv['15m'].close[ohlcv['15m'].close.length - 1]
          : snapshot.price

        // ── Real Aster close (v3 EIP-712) ────────────────────────────────
        const dbUserClose = await db.user.findUnique({
          where: { id: agent.userId },
          include: { wallets: { where: { isActive: true }, take: 1 } }
        })
        const { resolveAgentCreds: resolveAgentCredsClose } = await import('../services/aster')
        const credsClose = dbUserClose
          ? await resolveAgentCredsClose(dbUserClose, dbUserClose.wallets?.[0]?.address ?? '')
          : null

        if (credsClose && agent.exchange !== 'mock') {
          try {
            const { closePosition, getMarkPrice } = await import('../services/aster')
            const markData = await getMarkPrice(pair)
            exitPrice = markData.markPrice

            const contractSize = parseFloat((openPos.size / openPos.entryPrice).toFixed(6))
            await closePosition(
              pair,
              openPos.side as 'LONG' | 'SHORT',
              contractSize,
              credsClose
            )
          } catch (closeErr: any) {
            console.error(`[Agent ${agent.name}] Close failed:`, closeErr.message)
          }
        }
        // ─────────────────────────────────────────────────────────────────

        const priceDiff = exitPrice - openPos.entryPrice
        const dirMult   = openPos.side === 'LONG' ? 1 : -1
        const pnl       = (priceDiff / openPos.entryPrice) * openPos.size * openPos.leverage * dirMult
        const pnlPct    = (priceDiff / openPos.entryPrice) * openPos.leverage * dirMult * 100

        await db.trade.update({
          where: { id: openPos.id },
          data: {
            status:    'closed',
            exitPrice,
            pnl,
            pnlPct,
            closedAt: new Date()
          }
        })

        // Update agent stats
        const allTrades = await db.trade.findMany({
          where: { agentId: agent.id, status: 'closed' },
          select: { pnl: true }
        })
        const wins = allTrades.filter((t) => (t.pnl ?? 0) > 0).length
        const totalPnl = allTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0)
        const winRate = allTrades.length > 0 ? (wins / allTrades.length) * 100 : 0

        await db.agent.update({
          where: { id: agent.id },
          data: {
            totalPnl,
            totalTrades: allTrades.length,
            winRate
          }
        })

        // Learning memory for losses
        if (pnl < 0) {
          await saveMemory(
            agent.id,
            'correction',
            `LOSS on ${pair} ${openPos.side}: closed at $${exitPrice.toFixed(2)}, entry was $${openPos.entryPrice.toFixed(2)}, lost $${Math.abs(pnl).toFixed(2)} USDT. Original reasoning: "${openPos.aiReasoning?.slice(0, 100)}"`,
            { pnl, pnlPct }
          )
        } else {
          await saveMemory(
            agent.id,
            'observation',
            `WIN on ${pair} ${openPos.side}: +$${pnl.toFixed(2)} USDT (${pnlPct.toFixed(2)}%). ${decision.memoryUpdate ?? ''}`,
            { pnl }
          )
        }

        closedThisTick++

        console.log(
          `[Agent ${agent.name}] Closed ${openPos.side} ${pair} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`
        )

        // Notify the user the position closed (always — never throttled).
        const _bot3 = getBot()
        if (_bot3 && telegramId) {
          const emoji = pnl >= 0 ? '✅' : '🔻'
          const msg =
            `${emoji} *${escapeMd(agent.name)}* closed a position\n\n` +
            `*${pair}* ${openPos.side}\n` +
            `*Entry:* $${openPos.entryPrice.toFixed(4)}\n` +
            `*Exit:* $${exitPrice.toFixed(4)}\n` +
            `*PnL:* ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} USDT (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`
          _bot3.api.sendMessage(telegramId, msg, { parse_mode: 'Markdown' }).catch(() => {})
        }
      }

      console.log(
        `[Agent ${agent.name}] Tick completed in ${Date.now() - startTime}ms`
      )
    } catch (err) {
      console.error(`[Agent ${agent.name}] Tick error for ${pair}:`, err)
      await safeAgentLogCreate({
        data: {
          agentId: agent.id,
          userId: agent.userId,
          action: 'TICK_ERROR',
          error: String(err).slice(0, 500)
        }
      })
    } finally {
      // Sweep finalised markets — settles winners/losers on resolved positions.
      // In `finally` so it runs unconditionally even when HOLD/validation
      // branches return early or the tick throws. Cheap: only fetches markets
      // with at least one open position for this agent.
      try {
        const exec = await import('../services/fortyTwoExecutor')
        await exec.settleResolvedPositions({ agentId: agent.id })
      } catch (settleErr: any) {
        console.error(`[Agent ${agent.name}] settle error:`, settleErr?.message)
      }
    }
  }
}
