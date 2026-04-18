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

function expandPairs(pairs: string[]): string[] {
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

  for (const pair of pairList) {
    try {
      // 1. Gather market data
      const ohlcv = await getMultiTimeframeOHLCV(pair)
      const marketContext = buildMarketContext(ohlcv['15m'], ohlcv['1h'], ohlcv['4h'], pair)

      // 2. Get open positions
      const openPositions = await db.trade.findMany({
        where: { agentId: agent.id, pair, status: 'open' }
      })

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
        await db.agentLog.create({
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

      // 8. Log the decision
      await db.agentLog.create({
        data: {
          agentId: agent.id,
          userId: agent.userId,
          action: decision.action,
          rawResponse: rawResponse.slice(0, 2000),
          parsedAction: decision.action,
          executionResult: `confidence=${decision.confidence}, score=${decision.setupScore}`
        }
      })

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

        let finalSize = decision.size ?? agent.maxPositionSize
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

        ;(trade as any)._decision   = decision
        ;(trade as any)._finalSize  = finalSize
        ;(trade as any)._fillPrice  = fillPrice

        console.log(
          `[Agent ${agent.name}] Opened ${side} ${pair} @ $${fillPrice.toFixed(2)} | Size: $${finalSize.toFixed(0)} | Score: ${decision.setupScore}/10 | OrderId: ${orderIdStr}`
        )
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
            `LOSS on ${pair} ${openPos.side}: closed at $${currentPrice.toFixed(2)}, entry was $${openPos.entryPrice.toFixed(2)}, lost $${Math.abs(pnl).toFixed(2)} USDT. Original reasoning: "${openPos.aiReasoning?.slice(0, 100)}"`,
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

        console.log(
          `[Agent ${agent.name}] Closed ${openPos.side} ${pair} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`
        )
      }

      console.log(
        `[Agent ${agent.name}] Tick completed in ${Date.now() - startTime}ms`
      )
    } catch (err) {
      console.error(`[Agent ${agent.name}] Tick error for ${pair}:`, err)
      await db.agentLog.create({
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
