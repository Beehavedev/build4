import { Bot, Context } from 'grammy'
import { isAdminTelegramId } from '../../services/telegramAuth'

// Fleet admin callback handlers. Currently: acknowledging a low-BNB alert so a
// known-low agent stops re-alerting until its wallet refills above threshold.
// The ack is persisted (fleet_low_balance_acks), so it survives redeploys —
// unlike the watcher's in-memory dedup set. Admin-gated: non-admins get a
// silent answerCallbackQuery so the surface isn't fingerprintable.

function isAdmin(ctx: Context): boolean {
  const tg = ctx.from?.id
  if (!tg) return false
  return isAdminTelegramId(BigInt(tg))
}

export function registerFleet(bot: Bot) {
  bot.callbackQuery(/^flbAck:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }

    const agentId = ctx.match?.[1]
    if (!agentId) {
      await ctx.answerCallbackQuery({ text: 'Missing agent id.' }).catch(() => {})
      return
    }

    try {
      const { ackFleetLowBalance, getFleetAgent, logFleet } = await import('../../services/fleet')
      const agent = await getFleetAgent(agentId)
      const ackedBy = ctx.from?.username ? `@${ctx.from.username}` : String(ctx.from?.id ?? 'admin')
      await ackFleetLowBalance(agentId, ackedBy)
      await logFleet(agentId, 'info', `low-balance alert acked by ${ackedBy}`)
      await ctx.answerCallbackQuery({
        text: `✅ Acked ${agent?.name ?? agentId}. Silenced until its wallet refills.`,
      })
    } catch (err: any) {
      console.error('[Fleet] flbAck callback failed:', err?.message ?? err)
      await ctx.answerCallbackQuery({ text: 'Ack failed — see logs.' }).catch(() => {})
    }
  })
}
