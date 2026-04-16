import { Bot, Context, InlineKeyboard } from 'grammy'
import { db } from '../../db'

export async function handlePortfolio(ctx: Context) {
  const user = (ctx as any).dbUser
  if (!user) return

  const [portfolio, agents, allTrades] = await Promise.all([
    db.portfolio.findUnique({ where: { userId: user.id } }),
    db.agent.findMany({ where: { userId: user.id } }),
    db.trade.findMany({
      where: { userId: user.id, status: 'closed' },
      orderBy: { closedAt: 'desc' },
      take: 20
    })
  ])

  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  const todayTrades = allTrades.filter(
    (t) => t.closedAt && t.closedAt >= todayStart
  )
  const todayPnl = todayTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0)
  const totalPnl = allTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0)
  const wins = allTrades.filter((t) => (t.pnl ?? 0) > 0).length
  const winRate =
    allTrades.length > 0 ? (wins / allTrades.length) * 100 : 0

  const bestTrade = allTrades.reduce(
    (best, t) => ((t.pnl ?? 0) > (best?.pnl ?? -Infinity) ? t : best),
    allTrades[0]
  )
  const worstTrade = allTrades.reduce(
    (worst, t) => ((t.pnl ?? 0) < (worst?.pnl ?? Infinity) ? t : worst),
    allTrades[0]
  )

  const pnlEmoji = totalPnl >= 0 ? '📈' : '📉'
  const todayEmoji = todayPnl >= 0 ? '🟢' : '🔴'

  let text = `${pnlEmoji} *Portfolio Overview*\n\n`
  text += `${todayEmoji} Today: ${todayPnl >= 0 ? '+' : ''}$${todayPnl.toFixed(2)} USDT\n`
  text += `📊 All-time PnL: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} USDT\n`
  text += `🎯 Win Rate: ${winRate.toFixed(1)}% (${wins}W / ${allTrades.length - wins}L)\n`
  text += `📝 Total Trades: ${allTrades.length}\n\n`

  if (bestTrade) {
    text += `🏆 Best Trade: +$${bestTrade.pnl?.toFixed(2)} (${bestTrade.pair})\n`
  }
  if (worstTrade && worstTrade.id !== bestTrade?.id) {
    text += `💔 Worst Trade: $${worstTrade.pnl?.toFixed(2)} (${worstTrade.pair})\n`
  }

  text += `\n*Active Agents:* ${agents.filter((a) => a.isActive).length}/${agents.length}\n`

  if (allTrades.length > 0) {
    text += `\n*Recent Trades:*\n`
    allTrades.slice(0, 5).forEach((t) => {
      const emoji = (t.pnl ?? 0) >= 0 ? '🟢' : '🔴'
      text += `${emoji} ${t.pair} ${t.side} ${(t.pnl ?? 0) >= 0 ? '+' : ''}$${(t.pnl ?? 0).toFixed(2)}\n`
    })
  }

  const miniAppUrl = process.env.MINIAPP_URL
  const keyboard = new InlineKeyboard()
    .text('🔄 Refresh', 'portfolio_refresh')

  if (miniAppUrl) {
    keyboard.row().url('📊 Full Chart View', miniAppUrl)
  }

  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard })
}

export function registerPortfolio(bot: Bot) {
  bot.command('portfolio', async (ctx) => handlePortfolio(ctx))

  bot.callbackQuery('portfolio_refresh', async (ctx) => {
    await ctx.answerCallbackQuery('Refreshing...')
    await handlePortfolio(ctx)
  })
}
