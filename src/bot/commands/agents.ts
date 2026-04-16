import { Bot, Context, InlineKeyboard } from 'grammy'
import { db } from '../../db'

// Simple step-based agent creation using message state
const creationSessions = new Map<string, {
  step: number
  name?: string
  exchange?: string
  pairs?: string[]
  maxPosition?: number
  maxDailyLoss?: number
  maxLeverage?: number
}>()

export function registerAgents(bot: Bot) {
  bot.command('newagent', async (ctx) => {
    const user = (ctx as any).dbUser
    if (!user) return

    const sessionKey = user.id
    creationSessions.set(sessionKey, { step: 1 })

    const keyboard = new InlineKeyboard()
      .text('Aster DEX', 'agent_exchange_aster')
      .text('Hyperliquid', 'agent_exchange_hyperliquid')
      .row()
      .text('Mock (Testing)', 'agent_exchange_mock')

    await ctx.reply(
      `🤖 *Create AI Trading Agent*\n\n*Step 1/5 — Choose Exchange*\n\nWhich exchange should your agent trade on?`,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    )
  })

  // Exchange selection
  bot.callbackQuery(/^agent_exchange_(.+)$/, async (ctx) => {
    const exchange = ctx.match[1]
    const user = (ctx as any).dbUser
    if (!user) return

    const session = creationSessions.get(user.id)
    if (!session) return ctx.answerCallbackQuery('Session expired. Use /newagent')

    session.exchange = exchange
    session.step = 2
    await ctx.answerCallbackQuery()

    const keyboard = new InlineKeyboard()
      .text('BTC/USDT', 'agent_pair_BTC/USDT')
      .text('ETH/USDT', 'agent_pair_ETH/USDT')
      .row()
      .text('BNB/USDT', 'agent_pair_BNB/USDT')
      .text('SOL/USDT', 'agent_pair_SOL/USDT')
      .row()
      .text('✅ Done selecting pairs', 'agent_pairs_done')

    session.pairs = []
    await ctx.reply(
      `*Step 2/5 — Choose Trading Pairs*\n\nExchange: *${exchange}*\n\nSelect one or more pairs (tap to toggle):`,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    )
  })

  // Pair selection toggle
  bot.callbackQuery(/^agent_pair_(.+)$/, async (ctx) => {
    const pair = ctx.match[1]
    const user = (ctx as any).dbUser
    if (!user) return

    const session = creationSessions.get(user.id)
    if (!session) return ctx.answerCallbackQuery('Session expired')

    if (!session.pairs) session.pairs = []
    if (session.pairs.includes(pair)) {
      session.pairs = session.pairs.filter((p) => p !== pair)
      await ctx.answerCallbackQuery(`Removed ${pair}`)
    } else {
      session.pairs.push(pair)
      await ctx.answerCallbackQuery(`Added ${pair} ✓`)
    }
  })

  bot.callbackQuery('agent_pairs_done', async (ctx) => {
    const user = (ctx as any).dbUser
    if (!user) return

    const session = creationSessions.get(user.id)
    if (!session) return ctx.answerCallbackQuery('Session expired')

    if (!session.pairs || session.pairs.length === 0) {
      session.pairs = ['BTC/USDT']
    }

    session.step = 3
    await ctx.answerCallbackQuery()
    await ctx.reply(
      `*Step 3/5 — Risk Settings*\n\nSelected pairs: *${session.pairs.join(', ')}*\n\n*What is your maximum position size in USDT?*\n(This is the max size per trade)\n\nReply with a number, e.g. \`100\``,
      { parse_mode: 'Markdown' }
    )
  })

  // Agent naming — triggered after risk settings collection
  bot.callbackQuery(/^agent_confirm_(.+)$/, async (ctx) => {
    const agentId = ctx.match[1]
    const user = (ctx as any).dbUser
    if (!user) return

    await db.agent.update({
      where: { id: agentId },
      data: { isActive: true }
    })

    await ctx.answerCallbackQuery('✅ Agent activated!')
    await ctx.reply(
      `✅ *Agent is now LIVE!*\n\nYour agent will make its first analysis within 60 seconds.\n\nUse /tradestatus to monitor positions\nUse /myagents to manage your agents`,
      { parse_mode: 'Markdown' }
    )
  })

  // Handle text messages for the wizard steps
  bot.on('message:text', async (ctx, next) => {
    const user = (ctx as any).dbUser
    if (!user) return next()

    const session = creationSessions.get(user.id)
    if (!session || session.step < 3) return next()

    const text = ctx.message.text.trim()

    if (session.step === 3) {
      const amount = parseFloat(text)
      if (isNaN(amount) || amount < 10) {
        await ctx.reply('Please enter a valid amount (minimum $10)')
        return
      }
      session.maxPosition = amount
      session.step = 4
      await ctx.reply(
        `*Step 4/5 — Daily Loss Limit*\n\nMax position: *$${amount} USDT*\n\n*What is your maximum daily loss limit in USDT?*\nYour agent will pause trading if it hits this limit.\n\nReply with a number, e.g. \`50\``,
        { parse_mode: 'Markdown' }
      )
      return
    }

    if (session.step === 4) {
      const amount = parseFloat(text)
      if (isNaN(amount) || amount < 5) {
        await ctx.reply('Please enter a valid amount (minimum $5)')
        return
      }
      session.maxDailyLoss = amount
      session.step = 5
      await ctx.reply(
        `*Step 5/5 — Name Your Agent*\n\nDaily loss limit: *$${amount} USDT*\n\n*Give your agent a name:*\n\nE.g. "Alpha Hunter", "Night Trader", "BTC Bull"`,
        { parse_mode: 'Markdown' }
      )
      return
    }

    if (session.step === 5) {
      const name = text.slice(0, 32)
      session.name = name
      session.step = 6

      // Show summary + confirm
      const summary =
        `🤖 *Agent Summary*\n\n` +
        `Name: *${name}*\n` +
        `Exchange: *${session.exchange}*\n` +
        `Pairs: *${session.pairs?.join(', ')}*\n` +
        `Max Position: *$${session.maxPosition} USDT*\n` +
        `Max Daily Loss: *$${session.maxDailyLoss} USDT*\n` +
        `Max Leverage: *5x* (default)\n` +
        `Stop Loss: *2%* | Take Profit: *4%*\n\n` +
        `Ready to deploy your agent?`

      const keyboard = new InlineKeyboard()
        .text('✅ Create & Activate', `agent_create_confirm`)
        .text('❌ Cancel', 'agent_create_cancel')

      await ctx.reply(summary, { parse_mode: 'Markdown', reply_markup: keyboard })
      return
    }

    return next()
  })

  bot.callbackQuery('agent_create_confirm', async (ctx) => {
    const user = (ctx as any).dbUser
    if (!user) return

    const session = creationSessions.get(user.id)
    if (!session) return ctx.answerCallbackQuery('Session expired')

    try {
      const agent = await db.agent.create({
        data: {
          userId: user.id,
          name: session.name ?? 'APEX Agent',
          exchange: session.exchange ?? 'mock',
          pairs: session.pairs ?? ['BTC/USDT'],
          maxPositionSize: session.maxPosition ?? 100,
          maxDailyLoss: session.maxDailyLoss ?? 50,
          maxLeverage: 5,
          stopLossPct: 2,
          takeProfitPct: 4,
          isActive: true
        }
      })

      creationSessions.delete(user.id)
      await ctx.answerCallbackQuery('✅ Agent created!')
      await ctx.reply(
        `✅ *${agent.name} is now LIVE!*\n\nYour AI agent is analyzing the market.\nFirst trade decision in ~60 seconds.\n\n/tradestatus — Monitor positions\n/myagents — Manage agents`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      await ctx.answerCallbackQuery('Error creating agent')
      await ctx.reply('❌ Failed to create agent. Please try /newagent again.')
    }
  })

  bot.callbackQuery('agent_create_cancel', async (ctx) => {
    const user = (ctx as any).dbUser
    if (!user) return
    creationSessions.delete(user.id)
    await ctx.answerCallbackQuery('Cancelled')
    await ctx.reply('Agent creation cancelled. Use /newagent to start again.')
  })

  bot.command('myagents', async (ctx) => {
    const user = (ctx as any).dbUser
    if (!user) return

    const agents = await db.agent.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' }
    })

    if (agents.length === 0) {
      const keyboard = new InlineKeyboard().text('🤖 Create Agent', 'create_agent')
      await ctx.reply('No agents yet. Create your first AI trading agent!', {
        reply_markup: keyboard
      })
      return
    }

    let text = `🤖 *Your AI Agents*\n\n`
    agents.forEach((a) => {
      const status = a.isActive ? '🟢 Active' : a.isPaused ? '🔴 Paused' : '⚪ Inactive'
      text += `*${a.name}* — ${status}\n`
      text += `Exchange: ${a.exchange} | Pairs: ${a.pairs.join(', ')}\n`
      text += `PnL: ${a.totalPnl >= 0 ? '+' : ''}$${a.totalPnl.toFixed(2)} | WR: ${a.winRate.toFixed(0)}% (${a.totalTrades} trades)\n`
      text += `Max pos: $${a.maxPositionSize} | Max loss/day: $${a.maxDailyLoss}\n\n`
    })

    const keyboard = new InlineKeyboard()
    agents.slice(0, 2).forEach((a) => {
      if (a.isActive) {
        keyboard.text(`⏸ Pause ${a.name}`, `pause_agent_${a.id}`)
      } else {
        keyboard.text(`▶️ Start ${a.name}`, `start_agent_${a.id}`)
      }
      keyboard.row()
    })
    keyboard.text('➕ New Agent', 'create_agent')

    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard })
  })
}
