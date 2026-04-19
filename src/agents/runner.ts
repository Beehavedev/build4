import cron from 'node-cron'
import { db } from '../db'
import { runAgentTick } from './tradingAgent'
import { Bot } from 'grammy'
import { buildAlignmentBar } from './indicators'

let botRef: Bot | null = null
const runningAgents = new Set<string>()

export function getBot(): Bot | null {
  return botRef
}

// Escape characters Telegram's "Markdown" parse mode treats as control chars.
// Without this, an agent named e.g. "Algo_v2" or "Best*Trader" causes the
// entire message to be rejected with a 400 from Telegram.
export function escapeMd(s: string): string {
  return (s ?? '').replace(/([_*`\[\]])/g, '\\$1')
}

// Tracks how many ticks each agent has run since (re-)activation, so we can
// send "verbose" tick summaries for the first few ticks and then go quiet.
const ticksSinceActivation = new Map<string, number>()
const lastTickSummaryAt    = new Map<string, number>()

export function noteAgentActivated(agentId: string) {
  ticksSinceActivation.set(agentId, 0)
  lastTickSummaryAt.delete(agentId)
}
export function noteAgentTicked(agentId: string) {
  ticksSinceActivation.set(agentId, (ticksSinceActivation.get(agentId) ?? 0) + 1)
}
export function getTickCount(agentId: string): number {
  return ticksSinceActivation.get(agentId) ?? 0
}
export function shouldSendSummary(agentId: string, hasAction: boolean, bestScore: number): boolean {
  const tickN = getTickCount(agentId)
  if (tickN <= 3) return true              // first 3 ticks always verbose
  if (hasAction) return true               // any OPEN/CLOSE always
  const last = lastTickSummaryAt.get(agentId) ?? 0
  const FIVE_MIN = 5 * 60 * 1000
  if (Date.now() - last < FIVE_MIN) return false
  return bestScore >= 6                    // only "near-miss" HOLDs after warmup
}
export function markSummarySent(agentId: string) {
  lastTickSummaryAt.set(agentId, Date.now())
}

export function initRunner(bot: Bot) {
  botRef = bot

  // Main tick — every 60 seconds
  cron.schedule('* * * * *', async () => {
    await runAllAgents()
  })

  // Daily summary — 09:00 UTC
  cron.schedule('0 9 * * *', async () => {
    await sendDailySummaries()
  })

  // Proactive alerts — every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    await checkProactiveAlerts()
  })

  // Breaking-news monitor — every 60 seconds. The fetchNewsSignal()
  // call inside is itself 60s-cached and shared across all agents,
  // so this is a single Claude call/min globally.
  startNewsMonitor()

  // Listing/delisting monitor — polls Aster exchangeInfo every 60s and
  // alerts every active-agent owner when a new pair lists or an existing
  // pair enters reduce-only / delists. Detects within 60s of Aster's own
  // tweet — gives BUILD4 agents a real edge over manual traders.
  startListingMonitor()

  console.log('[Runner] Agent runner initialized')
}

// Telegram throttle — Bot API allows ~30 msg/sec globally. We pace at
// 25 msg/sec (40ms gap) for headroom; below the FloodWait threshold.
async function broadcastThrottled(
  userIds: Array<bigint | string | number>,
  text: string
): Promise<{ sent: number; blocked: number }> {
  if (!botRef || userIds.length === 0) return { sent: 0, blocked: 0 }
  let sent = 0
  let blocked = 0
  for (const id of userIds) {
    try {
      await botRef.api.sendMessage(id.toString(), text, { parse_mode: 'Markdown' })
      sent++
    } catch {
      blocked++
    }
    await new Promise((r) => setTimeout(r, 40))
  }
  return { sent, blocked }
}

// ── Listing monitor ────────────────────────────────────────────────
async function listingMonitorTick() {
  if (!botRef) return
  try {
    const { checkForListingChanges } = await import('../services/listingDetector')
    const events = await checkForListingChanges()
    if (events.length === 0) return

    // Resolve once: distinct telegram IDs of users with at least one
    // active agent. Cheaper than the nested {agents:{some:...}} filter
    // because Agent.isActive is indexed.
    let activeUserIds: bigint[] = []
    if (events.some((e) => e.type === 'NEW_LISTING')) {
      const rows = await db.agent.findMany({
        where: { isActive: true },
        select: { user: { select: { telegramId: true } } },
        distinct: ['userId']
      })
      activeUserIds = Array.from(new Set(rows.map((r) => r.user.telegramId)))
    }

    for (const ev of events) {
      if (ev.type === 'NEW_LISTING') {
        const text =
          `🚀 *NEW LISTING DETECTED*\n\n` +
          `*${escapeMd(ev.symbol)}* just listed on Aster.\n\n` +
          `Your AI agents are scanning it now. New listings often move ` +
          `50-200% in the first hour.\n\n` +
          `📊 BUILD4 detected this within 60 seconds.`
        const { sent } = await broadcastThrottled(activeUserIds, text)
        console.log(`[Listing] Alerted ${sent}/${activeUserIds.length} users about ${ev.symbol}`)
      } else if (ev.type === 'REDUCE_ONLY' || ev.type === 'DELISTING') {
        // Only alert users with open positions in this specific pair —
        // case-insensitive match because some agents store the pair as
        // 'ETHUSDT' and others as 'ETH/USDT'.
        const sym = ev.symbol
        const positions = await db.trade.findMany({
          where: {
            status: 'open',
            OR: [{ pair: sym }, { pair: sym.replace('USDT', '/USDT') }]
          },
          include: { agent: { include: { user: { select: { telegramId: true } } } } }
        })
        const uniq = new Map<string, bigint>()
        for (const p of positions) {
          if (!p.agent) continue
          uniq.set(p.agent.user.telegramId.toString(), p.agent.user.telegramId)
        }
        if (uniq.size === 0) {
          console.log(`[Listing] ${ev.type} ${sym} — no open positions, no alert`)
          continue
        }
        const text =
          `⚠️ *${ev.type === 'DELISTING' ? 'DELISTED' : 'REDUCE-ONLY'} — ${escapeMd(sym)}*\n\n` +
          `Aster ${ev.type === 'DELISTING' ? 'has removed' : 'is winding down'} this pair.\n` +
          `You have an open position.\n\n` +
          `Your agent will close it on the next tick. Funds are safe.`
        const { sent } = await broadcastThrottled(Array.from(uniq.values()), text)
        console.log(`[Listing] ${ev.type} ${sym}: alerted ${sent} position holder(s)`)
      }
    }
  } catch (err: any) {
    console.error('[Listing] Monitor error:', err?.message ?? err)
  }
}

function startListingMonitor() {
  // Cold-start scan immediately so the baseline is loaded; subsequent
  // ticks emit real events. The first call always returns [] by design.
  setTimeout(async () => {
    try {
      const { checkForListingChanges } = await import('../services/listingDetector')
      await checkForListingChanges()
      console.log('[Listing] Baseline pair set captured')
    } catch (e: any) {
      console.error('[Listing] Baseline scan failed:', e?.message ?? e)
    }
  }, 5_000)
  setInterval(listingMonitorTick, 60_000)
}

// ── News monitor ───────────────────────────────────────────────────
// Polls the shared news signal and pushes a Telegram alert to every
// active-agent owner when a HIGH-impact breaking event lands. The
// throttle below prevents the same headline from being broadcast more
// than once.
let lastBroadcastedHeadline = ''

async function newsMonitorTick() {
  if (!botRef) return
  try {
    const { fetchNewsSignal } = await import('../services/newsIntelligence')
    const signal = await fetchNewsSignal()
    if (Math.abs(signal.score) < 7) return
    if (!signal.isBreaking) return
    if (!signal.topHeadline || signal.topHeadline === lastBroadcastedHeadline) return
    lastBroadcastedHeadline = signal.topHeadline

    const activeUsers = await db.user.findMany({
      where: { agents: { some: { isActive: true } } },
      select: { telegramId: true }
    })

    const emoji = signal.score > 0 ? '🚀' : '🚨'
    const direction = signal.score > 0 ? 'BULLISH' : 'BEARISH'
    const affected = signal.affectedCoins.length > 0 ? signal.affectedCoins.join(', ') : 'broad market'
    const text =
      `${emoji} *BREAKING NEWS ALERT*\n\n` +
      `${escapeMd(signal.topHeadline)}\n\n` +
      `Market Impact: *${direction}* (${signal.score}/10)\n` +
      `Your agents are adjusting strategy automatically.\n\n` +
      `Affected: ${escapeMd(affected)}`

    for (const u of activeUsers) {
      try {
        await botRef.api.sendMessage(u.telegramId.toString(), text, { parse_mode: 'Markdown' })
      } catch {
        // user blocked bot, etc.
      }
    }
    console.log(`[News] Broadcast "${signal.topHeadline.slice(0, 60)}" to ${activeUsers.length} users`)
  } catch (err: any) {
    console.error('[News] Monitor error:', err?.message ?? err)
  }
}

function startNewsMonitor() {
  setInterval(newsMonitorTick, 60_000)
  // First check after 10s so we don't block startup.
  setTimeout(newsMonitorTick, 10_000)
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
            `⏰ *Position Alert — ${escapeMd(trade.agent.name)}*\n\n${trade.pair} ${trade.side} has been open for 4 hours.\nEntry: $${trade.entryPrice.toFixed(2)}\n\nConsider reviewing this position.`,
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

        const opensToday = await db.trade.count({
          where: { agentId: agent.id, openedAt: { gte: todayStart } }
        })
        const scansToday = await db.agentLog.count({
          where: { agentId: agent.id, createdAt: { gte: todayStart }, pair: { not: null } }
        })

        if (todayTrades.length === 0 && opensToday === 0 && scansToday === 0) continue

        const todayPnl = todayTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0)
        const wins = todayTrades.filter((t) => (t.pnl ?? 0) > 0).length
        const winRate = todayTrades.length > 0 ? (wins / todayTrades.length) * 100 : 0

        // Best closed trade today
        const bestTrade = todayTrades.reduce<{ pair: string; side: string; pnl: number } | null>(
          (best, t) => {
            const p = t.pnl ?? 0
            return !best || p > best.pnl ? { pair: t.pair, side: t.side, pnl: p } : best
          },
          null
        )

        const emoji = todayPnl >= 0 ? '📈' : todayPnl < 0 ? '📉' : '📊'
        const today = new Date().toISOString().slice(0, 10)
        const status = agent.isActive && !agent.isPaused
          ? '🟢 Active and scanning'
          : agent.isPaused ? '⏸ Paused' : '⏹ Stopped'

        const bestLine = bestTrade && bestTrade.pnl > 0
          ? `\n*Best trade:* ${bestTrade.pair} ${bestTrade.side} ${bestTrade.pnl >= 0 ? '+' : ''}$${bestTrade.pnl.toFixed(2)}`
          : ''

        await botRef.api.sendMessage(
          agent.user.telegramId.toString(),
          `${emoji} *Daily Agent Report — ${today}*\n\n` +
          `*Agent:* ${escapeMd(agent.name)}\n` +
          `*Trades closed:* ${todayTrades.length} (${wins}W / ${todayTrades.length - wins}L)\n` +
          `*Positions opened:* ${opensToday}\n` +
          `*PnL today:* ${todayPnl >= 0 ? '+' : ''}$${todayPnl.toFixed(2)} USDT\n` +
          `*Win rate today:* ${winRate.toFixed(0)}%` +
          bestLine + `\n` +
          `*Pairs scanned:* ${scansToday} analyses\n\n` +
          `*Status:* ${status}\n\n` +
          `_All-time: ${agent.totalTrades} trades · ${agent.winRate.toFixed(0)}% win · ${agent.totalPnl >= 0 ? '+' : ''}$${agent.totalPnl.toFixed(2)}_`,
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

  const msg = `🤖 *${escapeMd(agentName)}* opened a position

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
