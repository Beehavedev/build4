import { Bot, Context, InlineKeyboard } from 'grammy'
import { db } from '../../db'

export function registerCopytrade(bot: Bot) {
  bot.command('copytrade', async (ctx) => {
    const user = (ctx as any).dbUser
    if (!user) return

    // Build leaderboard from users with most trades/best PnL
    const topTraders = await db.user.findMany({
      include: {
        trades: { where: { status: 'closed' }, select: { pnl: true, closedAt: true } },
        _count: { select: { copyCopied: { where: { isActive: true } } } }
      },
      take: 20
    })

    const ranked = topTraders
      .map((u) => {
        const trades = u.trades
        const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0)
        const wins = trades.filter((t) => (t.pnl ?? 0) > 0).length
        const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0

        // 30d PnL
        const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000)
        const recentTrades = trades.filter((t) => t.closedAt && t.closedAt >= thirtyDaysAgo)
        const pnl30d = recentTrades.reduce((s, t) => s + (t.pnl ?? 0), 0)

        return {
          id: u.id,
          username: u.username ?? `User_${u.id.slice(0, 6)}`,
          totalTrades: trades.length,
          totalPnl,
          pnl30d,
          winRate,
          followers: u._count.copyCopied,
          verified: trades.length > 5
        }
      })
      .filter((u) => u.totalTrades > 0)
      .sort((a, b) => b.pnl30d - a.pnl30d)
      .slice(0, 10)

    if (ranked.length === 0) {
      await ctx.reply(
        '📋 *Copy Trading Leaderboard*\n\nNo traders with verified history yet.\n\nStart trading to appear on the leaderboard!',
        { parse_mode: 'Markdown' }
      )
      return
    }

    let text = `📋 *Copy Trading Leaderboard*\n`
    text += `_Top traders by 30-day PnL_\n\n`

    ranked.forEach((trader, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`
      const verBadge = trader.verified ? ' ✅' : ''
      text += `${medal} *@${trader.username}*${verBadge}\n`
      text += `30d: ${trader.pnl30d >= 0 ? '+' : ''}$${trader.pnl30d.toFixed(0)} | WR: ${trader.winRate.toFixed(0)}% | ${trader.followers} followers\n\n`
    })

    const keyboard = new InlineKeyboard()
    ranked.slice(0, 3).forEach((trader) => {
      keyboard
        .text(`Follow @${trader.username}`, `follow_${trader.id}`)
        .row()
    })
    keyboard.text('🔄 Refresh', 'copytrade_refresh')

    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard })
  })

  bot.callbackQuery('copytrade_refresh', async (ctx) => {
    await ctx.answerCallbackQuery('Refreshing...')
    // Re-trigger the command
    await ctx.reply('Use /copytrade to see the latest leaderboard.')
  })

  bot.callbackQuery(/^follow_(.+)$/, async (ctx) => {
    const copiedId = ctx.match[1]
    const user = (ctx as any).dbUser
    if (!user) return

    if (copiedId === user.id) {
      return ctx.answerCallbackQuery("You can't copy yourself!")
    }

    const existing = await db.copyFollow.findFirst({
      where: { followerId: user.id, copiedId }
    })

    if (existing?.isActive) {
      return ctx.answerCallbackQuery('Already following this trader!')
    }

    await db.copyFollow.upsert({
      where: { followerId_copiedId: { followerId: user.id, copiedId } },
      update: { isActive: true },
      create: { followerId: user.id, copiedId, allocation: 100, isActive: true }
    })

    await ctx.answerCallbackQuery('✅ Now copying this trader!')
    await ctx.reply(
      `✅ *Copy Trading Active*\n\nYou are now copying this trader with $100 USDT allocation.\n\nYou'll receive a notification every time they open a trade.\n\nUse /copytrade to manage your follows.`,
      { parse_mode: 'Markdown' }
    )
  })
}
