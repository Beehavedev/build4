import { Bot, Context, InlineKeyboard } from 'grammy'
import { db } from '../../db'

export async function handleQuests(ctx: Context) {
  const user = (ctx as any).dbUser
  if (!user) return

  const userQuests = await db.userQuest.findMany({
    where: { userId: user.id },
    include: { quest: true },
    orderBy: { quest: { reward: 'desc' } }
  })

  if (userQuests.length === 0) {
    await ctx.reply('No quests found. Try /start to initialize your account.')
    return
  }

  const completed = userQuests.filter((uq) => uq.completed)
  const pending = userQuests.filter((uq) => !uq.completed)

  let text = `🎯 *Quests & Rewards*\n\n`
  text += `💎 Your $B4 Balance: ${user.b4Balance.toFixed(0)} $B4\n`
  text += `✅ Completed: ${completed.length}/${userQuests.length}\n\n`

  if (pending.length > 0) {
    text += `*Active Quests:*\n\n`
    pending.slice(0, 6).forEach((uq) => {
      const req = uq.quest.requirement as any
      const maxProgress = req.count ?? 1
      const pct = Math.min(100, Math.round((uq.progress / maxProgress) * 100))
      const bars = Math.round(pct / 10)
      const progressBar = '█'.repeat(bars) + '░'.repeat(10 - bars)

      text += `*${uq.quest.title}*\n`
      text += `${uq.quest.description}\n`
      text += `${progressBar} ${pct}% (${uq.progress}/${maxProgress})\n`
      text += `Reward: ${uq.quest.reward} $B4\n\n`
    })
  }

  if (completed.length > 0) {
    text += `*Completed:*\n`
    completed.forEach((uq) => {
      const claimed = uq.claimedAt ? '✅ Claimed' : '🎁 Unclaimed'
      text += `• ${uq.quest.title} — ${uq.quest.reward} $B4 ${claimed}\n`
    })
  }

  const unclaimedQuests = completed.filter((uq) => !uq.claimedAt)
  const keyboard = new InlineKeyboard()
  if (unclaimedQuests.length > 0) {
    keyboard.text(`🎁 Claim ${unclaimedQuests.length} Reward${unclaimedQuests.length > 1 ? 's' : ''}`, 'claim_quests').row()
  }
  keyboard.text('🔄 Refresh', 'quests_refresh')

  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard })
}

export function registerQuests(bot: Bot) {
  bot.command('quests', async (ctx) => handleQuests(ctx))
  bot.command('rewards', async (ctx) => handleQuests(ctx))

  bot.callbackQuery('quests', async (ctx) => {
    await ctx.answerCallbackQuery()
    await handleQuests(ctx)
  })

  bot.callbackQuery('quests_refresh', async (ctx) => {
    await ctx.answerCallbackQuery('Refreshing...')
    await handleQuests(ctx)
  })

  bot.callbackQuery('claim_quests', async (ctx) => {
    await ctx.answerCallbackQuery()
    const user = (ctx as any).dbUser
    if (!user) return

    const unclaimed = await db.userQuest.findMany({
      where: { userId: user.id, completed: true, claimedAt: null },
      include: { quest: true }
    })

    let totalReward = 0
    for (const uq of unclaimed) {
      totalReward += uq.quest.reward
      await db.userQuest.update({
        where: { id: uq.id },
        data: { claimedAt: new Date() }
      })
    }

    await db.user.update({
      where: { id: user.id },
      data: { b4Balance: { increment: totalReward } }
    })

    await ctx.reply(
      `🎉 *Claimed ${unclaimed.length} quest reward${unclaimed.length > 1 ? 's' : ''}!*\n\n+${totalReward} $B4 added to your balance.\n\nUse /rewards to see your total.`,
      { parse_mode: 'Markdown' }
    )
  })
}
