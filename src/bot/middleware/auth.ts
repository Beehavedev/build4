import { Context, NextFunction } from 'grammy'
import { db } from '../../db'
import { generateAndSaveWallet } from '../../services/wallet'

export async function authMiddleware(ctx: Context, next: NextFunction) {
  if (!ctx.from) return next()

  try {
    let user = await db.user.findUnique({
      where: { telegramId: BigInt(ctx.from.id) }
    })

    if (!user) {
      // Auto-create user + generate BSC wallet
      user = await db.user.create({
        data: {
          telegramId: BigInt(ctx.from.id),
          username: ctx.from.username,
          firstName: ctx.from.first_name
        }
      })

      // Auto-generate BSC wallet — capture PK so /start can show it once
      const newWallet = await generateAndSaveWallet(user.id, 'BSC', 'Main Wallet')
      ;(ctx as any).newWallet = newWallet

      // Ensure portfolio exists
      await db.portfolio.create({
        data: { userId: user.id }
      })

      // Initialize quests for user
      const quests = await db.quest.findMany({ where: { isActive: true } })
      for (const quest of quests) {
        await db.userQuest.upsert({
          where: { userId_questId: { userId: user.id, questId: quest.id } },
          update: {},
          create: { userId: user.id, questId: quest.id }
        })
      }

      console.log(`[Auth] New user: ${ctx.from.username ?? ctx.from.id}`)
    } else if (user.username !== ctx.from.username) {
      // Update username if changed
      await db.user.update({
        where: { id: user.id },
        data: { username: ctx.from.username }
      })
    }

    // Attach user to context
    ;(ctx as any).dbUser = user
  } catch (err) {
    console.error('[Auth] middleware error:', err)
  }

  return next()
}
