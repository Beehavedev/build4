import Anthropic from '@anthropic-ai/sdk'
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
import { buildMemoryContext, saveMemory } from './memory'

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
}

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
   Only trade when at least 3 of 4 signals agree:
   - 4h trend direction (EMA200)
   - 1h trend direction (EMA50)
   - 15m momentum (MACD + RSI)
   - Volume confirmation
   Fewer than 3 agreeing = HOLD

3. ENTRY QUALITY SCORING (0-10):
   - Trend alignment (all timeframes agree): +3
   - At key support/resistance level: +2
   - RSI not overbought/oversold against direction: +1
   - Volume above average: +1
   - Bollinger band context favorable: +1
   - MACD cross in your direction within last 3 bars: +1
   - Clean recent candle structure: +1
   Score 7-10: Full size | Score 5-6: Half size | Score 0-4: HOLD

4. RISK MANAGEMENT (non-negotiable):
   - Stop loss: below/above nearest swing low/high, NOT an arbitrary percentage
   - If R/R after proper SL/TP placement is less than 2:1: PASS
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
  "holdReason": null
}

For HOLD: set entryZone/stopLoss/takeProfit/size/leverage/riskRewardRatio to null. Use holdReason to explain what would change your mind.`

function buildMarketContext(
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

export function expandPairs(pairs: string[]): string[] {
  const expanded = new Set<string>()
  for (const p of pairs) {
    if (!p) continue
    if (p.toUpperCase() === 'ALL') {
      ALL_PAIRS_UNIVERSE.forEach((x) => expanded.add(x))
    } else {
      expanded.add(p.replace(/[\/\s]/g, '').toUpperCase())
    }
  }
  return Array.from(expanded)
}

export async function runAgentTick(agent: Agent): Promise<void> {
  const startTime = Date.now()

  const pairList = expandPairs(agent.pairs)
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
      // 1. Gather market data
      const ohlcv = await getMultiTimeframeOHLCV(pair)
      const marketContext = buildMarketContext(ohlcv['15m'], ohlcv['1h'], ohlcv['4h'], pair)

      // Indicator snapshot — used both for the live "Agent Brain" feed
      // (logged to AgentLog so the mini app can render it) and for the
      // per-tick Telegram summary message.
      {
        const _price = ohlcv['15m'].close[ohlcv['15m'].close.length - 1]
        const _rsi   = calculateRSI(ohlcv['15m'].close, 14)
        const _adx   = calculateADX(ohlcv['1h'], 14)
        const _regime = _adx > 25
          ? (calculateEMA(ohlcv['15m'].close, 9) > calculateEMA(ohlcv['4h'].close, 200)
              ? 'TRENDING UP'
              : 'TRENDING DOWN')
          : 'RANGING'
        snapshot = { price: _price, rsi: _rsi, adx: _adx, regime: _regime }
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
            const { buildCreds } = await import('../services/aster')
            const creds = buildCreds(userAddr, dbUser?.asterAgentAddress, process.env.ASTER_AGENT_PRIVATE_KEY)
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
${newsContext}

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

      // 7. Call Claude
      let decision: AgentDecision
      let rawResponse = ''

      try {
        const response = await anthropic.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 1000,
          system: TRADING_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userMessage }]
        })

        rawResponse =
          response.content[0].type === 'text' ? response.content[0].text : '{}'
        decision = JSON.parse(rawResponse.replace(/```json|```/g, '').trim())
      } catch (aiErr) {
        console.error(`[Agent ${agent.name}] Claude error:`, aiErr)
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
          regime: decision.regime ?? snapshot.regime ?? null
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
        // Validate
        if ((decision.riskRewardRatio ?? 0) < 2.0) {
          await saveMemory(
            agent.id,
            'observation',
            `Skipped ${pair} ${decision.action} — R/R was only ${decision.riskRewardRatio?.toFixed(1)}, below 2.0 minimum`,
            null
          )
          return
        }

        if (decision.confidence < 0.55) {
          return
        }

        if ((decision.setupScore ?? 0) < 5) return

        const side = decision.action === 'OPEN_LONG' ? 'LONG' : ('SHORT' as const)
        const riskCheck = await checkRiskGuard(
          agent,
          pair,
          side,
          decision.size ?? agent.maxPositionSize,
          decision.leverage ?? 1
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

        const currentPrice = ohlcv['15m'].close[ohlcv['15m'].close.length - 1]

        // ── Real Aster execution ──────────────────────────────────────────
        let fillPrice = currentPrice
        let orderIdStr = 'mock_' + Date.now()

        // Build EIP-712 credentials for this user
        const dbUser = await db.user.findUnique({
          where: { id: agent.userId },
          include: { wallets: { where: { isActive: true }, take: 1 } }
        })
        const userAddress = dbUser?.wallets?.[0]?.address ?? ''
        const { buildCreds } = await import('../services/aster')
        const creds = buildCreds(
          userAddress,
          dbUser?.asterAgentAddress,
          process.env.ASTER_AGENT_PRIVATE_KEY
        )

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

            // SL + TP bracket orders
            if (decision.stopLoss && decision.takeProfit) {
              await placeBracketOrders({
                symbol:     sym,
                side,
                stopLoss:   decision.stopLoss,
                takeProfit: decision.takeProfit,
                quantity:   qty,
                creds
              })
            }
          } catch (execErr: any) {
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

        let exitPrice = ohlcv['15m'].close[ohlcv['15m'].close.length - 1]

        // ── Real Aster close (v3 EIP-712) ────────────────────────────────
        const dbUserClose = await db.user.findUnique({
          where: { id: agent.userId },
          include: { wallets: { where: { isActive: true }, take: 1 } }
        })
        const { buildCreds: buildCredsClose } = await import('../services/aster')
        const credsClose = buildCredsClose(
          dbUserClose?.wallets?.[0]?.address ?? '',
          dbUserClose?.asterAgentAddress,
          process.env.ASTER_AGENT_PRIVATE_KEY
        )

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
    }
  }
}
