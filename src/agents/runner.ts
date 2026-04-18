import cron from 'node-cron'
import { db } from '../db'
import { runAgentTick } from './tradingAgent'
import { Bot } from 'grammy'
import { buildAlignmentBar } from './indicators'

let botRef: Bot | null = null
const runningAgents = new Set<string>()

export function initRunner(bot: Bot) {
  botRef = bot

  // Main tick — every 60 seconds
  cron.schedule('* * * * *', async () => {
    await runAllAgents()
  })

  // Daily summary — midnight UTC
  cron.schedule('0 0 * * *', async () => {
    await sendDailySummaries()
  })

  // Proactive alerts — every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    await checkProactiveAlerts()
  })

  console.log('[Runner] Agent runner initialized')
}

// Stagger config — at 50 agents/sec we can drain ~3,000 agents/min.
// Anything more than that overflows the 60s cron window and the in-flight
// set will skip the next tick (which is fine — it just means slower tickers
// for very large active populations).
const TICK_BATCH_SIZE   = 50
const TICK_BATCH_GAP_MS = 1_000

async function runAllAgents() {
  try {
    // Filter at the DB level: only tick agents whose owner has actually
    // onboarded to Aster. Agents created during onboarding but never
    // activated by depositing USDT would otherwise burn 1 LLM call/min
    // forever. With 9k+ agents and Claude pricing, that's the difference
    // between $200/day and $200k/day.
    const activeAgents = await db.agent.findMany({
      where: {
        isActive: true,
        isPaused: false,
        user: { asterOnboarded: true }
      }
    })

    if (activeAgents.length === 0) {
      console.log('[Runner] No active onboarded agents, skipping tick')
      return
    }

    console.log(`[Runner] Ticking ${activeAgents.length} agents in batches of ${TICK_BATCH_SIZE}`)
    const tickStart = Date.now()
    let dispatched = 0
    let skippedInflight = 0

    for (let i = 0; i < activeAgents.length; i += TICK_BATCH_SIZE) {
      const batch = activeAgents.slice(i, i + TICK_BATCH_SIZE)

      for (const agent of batch) {
        if (runningAgents.has(agent.id)) {
          skippedInflight++
          continue
        }
        runningAgents.add(agent.id)
        // Fire-and-forget — we don't await individual ticks, only the
        // inter-batch gap. This bounds peak concurrency to TICK_BATCH_SIZE.
        runAgentTick(agent)
          .catch((err) => console.error(`[Runner] Agent ${agent.name} error:`, err?.message ?? err))
          .finally(() => runningAgents.delete(agent.id))
        dispatched++
      }

      // Pace the next batch only if there is one.
      if (i + TICK_BATCH_SIZE < activeAgents.length) {
        await new Promise((r) => setTimeout(r, TICK_BATCH_GAP_MS))
      }
    }

    const elapsed = ((Date.now() - tickStart) / 1000).toFixed(1)
    console.log(`[Runner] Dispatched ${dispatched} ticks in ${elapsed}s (${skippedInflight} skipped — still in flight from previous tick)`)
  } catch (err) {
    console.error('[Runner] Error fetching agents:', err)
  }
}

async function checkProactiveAlerts() {
  if (!botRef) return

  try {
    const openTrades = await db.trade.findMany({
      where: { status: 'open' },
      include: { agent: true, user: true }
    })

    for (const trade of openTrades) {
      if (!trade.agent) continue

      // Check signals stored in signalsUsed for stop loss proximity
      const signals = trade.signalsUsed as any
      if (!signals?.stopLoss || !signals?.takeProfit) continue

      // Mock: in production, fetch real current price
      // For now just check time-based alerts
      const openMinutes = (Date.now() - trade.openedAt.getTime()) / 60000

      // Alert if position has been open >4 hours without closure
      if (openMinutes > 240 && openMinutes < 245) {
        try {
          await botRef.api.sendMessage(
            trade.user.telegramId.toString(),
            `⏰ *Position Alert — ${trade.agent.name}*\n\n${trade.pair} ${trade.side} has been open for 4 hours.\nEntry: $${trade.entryPrice.toFixed(2)}\n\nConsider reviewing this position.`,
            { parse_mode: 'Markdown' }
          )
        } catch (e) {
          // User may have blocked bot
        }
      }
    }
  } catch (err) {
    console.error('[Runner] Proactive alerts error:', err)
  }
}

async function sendDailySummaries() {
  if (!botRef) return

  try {
    const agents = await db.agent.findMany({
      where: { isActive: true },
      include: { user: true }
    })

    const todayStart = new Date()
    todayStart.setUTCHours(0, 0, 0, 0)
    todayStart.setUTCDate(todayStart.getUTCDate() - 1)

    for (const agent of agents) {
      try {
        const todayTrades = await db.trade.findMany({
          where: {
            agentId: agent.id,
            status: 'closed',
            closedAt: { gte: todayStart }
          }
        })

        if (todayTrades.length === 0) continue

        const todayPnl = todayTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0)
        const wins = todayTrades.filter((t) => (t.pnl ?? 0) > 0).length
        const winRate = (wins / todayTrades.length) * 100

        const emoji = todayPnl >= 0 ? '📈' : '📉'

        await botRef.api.sendMessage(
          agent.user.telegramId.toString(),
          `${emoji} *Daily Summary — ${agent.name}*\n\nTrades: ${todayTrades.length} (${wins}W / ${todayTrades.length - wins}L)\nPnL: ${todayPnl >= 0 ? '+' : ''}$${todayPnl.toFixed(2)} USDT\nWin Rate: ${winRate.toFixed(0)}%\n\n📊 All-time: ${agent.totalTrades} trades | ${agent.winRate.toFixed(0)}% win rate | ${agent.totalPnl >= 0 ? '+' : ''}$${agent.totalPnl.toFixed(2)} total`,
          { parse_mode: 'Markdown' }
        )
      } catch (e) {
        // User may have blocked bot
      }
    }
  } catch (err) {
    console.error('[Runner] Daily summaries error:', err)
  }
}

export function notifyTradeOpened(
  bot: Bot,
  telegramId: string,
  agentName: string,
  decision: any,
  fillPrice: number,
  finalSize: number
) {
  const side = decision.action === 'OPEN_LONG' ? '🟢 LONG' : '🔴 SHORT'
  const alignBar = buildAlignmentBar(decision.timeframeAlignment)
  const confBar =
    '█'.repeat(Math.round(decision.confidence * 10)) +
    '░'.repeat(10 - Math.round(decision.confidence * 10))

  const slPct = decision.stopLoss
    ? Math.abs(((fillPrice - decision.stopLoss) / fillPrice) * 100).toFixed(2)
    : '—'
  const tpPct = decision.takeProfit
    ? Math.abs(((decision.takeProfit - fillPrice) / fillPrice) * 100).toFixed(2)
    : '—'

  const msg = `🤖 *${agentName}* opened a position

${side} *${decision.pair}* | ${decision.leverage}x leverage

*Entry:* $${fillPrice.toFixed(4)}
*Stop Loss:* $${decision.stopLoss?.toFixed(4) ?? '—'} (−${slPct}%)
*Take Profit:* $${decision.takeProfit?.toFixed(4) ?? '—'} (+${tpPct}%)
*Size:* $${finalSize.toFixed(0)} USDT
*R/R Ratio:* ${decision.riskRewardRatio?.toFixed(1) ?? '—'}:1

*Market Regime:* ${decision.regime}
*Setup Score:* ${decision.setupScore}/10
*Timeframes:* ${alignBar}
*Confidence:* ${confBar} ${Math.round(decision.confidence * 100)}%

💭 *Why:*
${decision.reasoning}

${decision.keyRisks?.length > 0 ? `⚠️ *Risks:*\n${decision.keyRisks.map((r: string) => `• ${r}`).join('\n')}` : ''}`

  bot.api
    .sendMessage(telegramId, msg, { parse_mode: 'Markdown' })
    .catch(() => {})
}
