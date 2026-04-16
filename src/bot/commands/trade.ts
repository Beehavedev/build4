import { Bot, Context, InlineKeyboard } from 'grammy'
import { db } from '../../db'

export async function handleTradeStatus(ctx: Context) {
  const user = (ctx as any).dbUser
  if (!user) return

  const openTrades = await db.trade.findMany({
    where: { userId: user.id, status: 'open' },
    include: { agent: true },
    orderBy: { openedAt: 'desc' }
  })

  if (openTrades.length === 0) {
    const keyboard = new InlineKeyboard()
      .text('🤖 Create Agent', 'create_agent')
      .text('📊 Signals', 'signals')
    await ctx.reply(
      '📭 *No Open Positions*\n\nStart an AI agent to begin trading automatically.',
      { parse_mode: 'Markdown', reply_markup: keyboard }
    )
    return
  }

  let text = `📊 *Open Positions*\n\n`

  for (const trade of openTrades) {
    // Mock current price with small drift from entry
    const drift = 1 + (Math.random() - 0.48) * 0.03
    const currentPrice = trade.entryPrice * drift
    const priceDiff = currentPrice - trade.entryPrice
    const dirMult = trade.side === 'LONG' ? 1 : -1
    const unrealizedPnl =
      (priceDiff / trade.entryPrice) * trade.size * trade.leverage * dirMult
    const unrealizedPct =
      (priceDiff / trade.entryPrice) * trade.leverage * dirMult * 100
    const pnlEmoji = unrealizedPnl >= 0 ? '🟢' : '🔴'

    const signals = trade.signalsUsed as any
    const openMins = Math.round((Date.now() - trade.openedAt.getTime()) / 60000)

    text += `${pnlEmoji} *${trade.pair}* ${trade.side}\n`
    text += `Agent: ${trade.agent?.name ?? 'Manual'}\n`
    text += `Entry: $${trade.entryPrice.toFixed(4)} → Now: $${currentPrice.toFixed(4)}\n`
    text += `Size: $${trade.size} | ${trade.leverage}x leverage\n`
    text += `PnL: ${unrealizedPnl >= 0 ? '+' : ''}$${unrealizedPnl.toFixed(2)} (${unrealizedPct.toFixed(2)}%)\n`
    if (signals?.stopLoss) text += `SL: $${signals.stopLoss.toFixed(4)}`
    if (signals?.takeProfit) text += ` | TP: $${signals.takeProfit.toFixed(4)}`
    text += `\nOpen: ${openMins}m ago\n\n`
  }

  // Today's realized PnL
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  const todayTrades = await db.trade.findMany({
    where: { userId: user.id, status: 'closed', closedAt: { gte: todayStart } },
    select: { pnl: true }
  })
  const todayPnl = todayTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0)
  text += `💰 Today's Realized PnL: ${todayPnl >= 0 ? '+' : ''}$${todayPnl.toFixed(2)} USDT`

  const keyboard = new InlineKeyboard()
    .text('🔄 Refresh', 'tradestatus_refresh')
    .text('❌ Close All', 'close_all_positions')

  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard })
}

export function registerTrade(bot: Bot) {
  bot.command('trade', async (ctx) => {
    const user = (ctx as any).dbUser
    if (!user) return

    const agents = await db.agent.findMany({ where: { userId: user.id } })

    if (agents.length === 0) {
      const keyboard = new InlineKeyboard().text('🤖 Create Agent', 'create_agent')
      await ctx.reply(
        '🤖 *No Agents Found*\n\nCreate an AI trading agent first to start automated trading.\n\nUse /newagent to get started.',
        { parse_mode: 'Markdown', reply_markup: keyboard }
      )
      return
    }

    const activeAgent = agents.find((a) => a.isActive)

    if (!activeAgent) {
      let text = `🤖 *Your Agents*\n\n`
      agents.forEach((a) => {
        text += `• ${a.name} — ⏸ Paused\n`
        text += `  Pairs: ${a.pairs.join(', ')} | Exchange: ${a.exchange}\n`
        text += `  Total PnL: ${a.totalPnl >= 0 ? '+' : ''}$${a.totalPnl.toFixed(2)} | Win rate: ${a.winRate.toFixed(0)}%\n\n`
      })

      const keyboard = new InlineKeyboard()
      agents.slice(0, 3).forEach((a) => {
        keyboard.text(`▶️ Start ${a.name}`, `start_agent_${a.id}`).row()
      })
      keyboard.text('➕ New Agent', 'create_agent')

      await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard })
    } else {
      const keyboard = new InlineKeyboard()
        .text('⏸ Pause Agent', `pause_agent_${activeAgent.id}`)
        .text('📊 Status', 'tradestatus_refresh')

      await ctx.reply(
        `✅ *Agent Running: ${activeAgent.name}*\n\nExchange: ${activeAgent.exchange}\nPairs: ${activeAgent.pairs.join(', ')}\nMax position: $${activeAgent.maxPositionSize}\nMax daily loss: $${activeAgent.maxDailyLoss}\n\nAll-time PnL: ${activeAgent.totalPnl >= 0 ? '+' : ''}$${activeAgent.totalPnl.toFixed(2)} USDT\nWin rate: ${activeAgent.winRate.toFixed(0)}% (${activeAgent.totalTrades} trades)\n\nNext tick: ~60 seconds`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
      )
    }
  })

  bot.command('tradestatus', async (ctx) => handleTradeStatus(ctx))

  bot.callbackQuery('tradestatus_refresh', async (ctx) => {
    await ctx.answerCallbackQuery('Refreshing...')
    await handleTradeStatus(ctx)
  })

  bot.callbackQuery(/^start_agent_(.+)$/, async (ctx) => {
    const agentId = ctx.match[1]
    const user = (ctx as any).dbUser
    if (!user) return
    await db.agent.update({
      where: { id: agentId, userId: user.id },
      data: { isActive: true, isPaused: false }
    })
    await ctx.answerCallbackQuery('✅ Agent started!')
    await ctx.reply('✅ Agent is now active. First tick in ~60 seconds.')
  })

  bot.callbackQuery(/^pause_agent_(.+)$/, async (ctx) => {
    const agentId = ctx.match[1]
    const user = (ctx as any).dbUser
    if (!user) return
    await db.agent.update({
      where: { id: agentId, userId: user.id },
      data: { isActive: false }
    })
    await ctx.answerCallbackQuery('⏸ Agent paused')
    await ctx.reply('⏸ Agent paused. Your open positions remain open.')
  })

  bot.callbackQuery('close_all_positions', async (ctx) => {
    await ctx.answerCallbackQuery()
    const user = (ctx as any).dbUser
    if (!user) return

    const open = await db.trade.findMany({
      where: { userId: user.id, status: 'open' }
    })

    let totalPnl = 0
    for (const trade of open) {
      const drift = 1 + (Math.random() - 0.5) * 0.02
      const exitPrice = trade.entryPrice * drift
      const priceDiff = exitPrice - trade.entryPrice
      const dirMult = trade.side === 'LONG' ? 1 : -1
      const pnl =
        (priceDiff / trade.entryPrice) * trade.size * trade.leverage * dirMult
      totalPnl += pnl
      await db.trade.update({
        where: { id: trade.id },
        data: { status: 'closed', exitPrice, pnl, pnlPct: (pnl / trade.size) * 100, closedAt: new Date() }
      })
    }

    await ctx.reply(
      `✅ Closed ${open.length} position${open.length !== 1 ? 's' : ''}.\nTotal realized PnL: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} USDT`,
      { parse_mode: 'Markdown' }
    )
  })
}
