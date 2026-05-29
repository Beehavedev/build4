import { Bot, Context } from 'grammy'
import { isAdminTelegramId } from '../../services/telegramAuth'

// /houseucl — admin-only one-shot trigger for the BUILD4 House Agent's
// 42.space sports pick. Reads market address from HOUSE_UCL_MARKET_ADDRESS
// env var. Silent no-op for non-admins so non-admins can't fingerprint
// that the surface exists.

function isAdmin(ctx: Context): boolean {
  const tg = ctx.from?.id
  if (!tg) return false
  return isAdminTelegramId(BigInt(tg))
}

export function registerHouseUcl(bot: Bot) {
  bot.command('houseucl', async (ctx) => {
    if (!isAdmin(ctx)) return
    // Args: /houseucl [0xMARKET] [dry] [force]
    // The market address arg is preferred; HOUSE_UCL_MARKET_ADDRESS env is
    // a fallback so the canonical UCL Final market still works with no args.
    const raw = (ctx.match ?? '').toString().trim()
    const tokens = raw.split(/\s+/).filter(Boolean)
    const addrFromArg = tokens.find((t) => /^0x[a-fA-F0-9]{40}$/.test(t))
    const flagsLower = tokens.filter((t) => t !== addrFromArg).join(' ').toLowerCase()
    const dryRun = flagsLower.includes('dry')
    const force = flagsLower.includes('force')
    const marketAddress = addrFromArg ?? process.env.HOUSE_UCL_MARKET_ADDRESS
    if (!marketAddress) {
      await ctx.reply(
        '❌ Pass a 0x market address (e.g. `/houseucl 0xabc…`) or set `HOUSE_UCL_MARKET_ADDRESS`.',
        { parse_mode: 'Markdown' },
      )
      return
    }

    await ctx.reply(
      `🏛️ Triggering House Agent 42.space pick…\n` +
        `market: \`${marketAddress}\`\n` +
        `dryRun=${dryRun} force=${force}`,
      { parse_mode: 'Markdown' },
    )

    try {
      const { runHouseFortyTwoPick } = await import('../../agents/houseFortyTwoSportsBrain')
      const r = await runHouseFortyTwoPick({ marketAddress, dryRun, force })
      if (!r.ok) {
        await ctx.reply(`❌ pick failed: ${r.reason ?? 'unknown'}`)
        return
      }
      if (r.existing) {
        await ctx.reply(
          `ℹ️ House already opened a position on this market.\n` +
            `outcome: ${r.existing.outcomeLabel}\n` +
            `usdtIn: $${r.existing.usdtIn}\n` +
            `tx: \`${r.existing.txHash ?? 'pending'}\``,
          { parse_mode: 'Markdown' },
        )
        return
      }
      if (!r.trade) {
        await ctx.reply(
          `🛑 SKIP — ${r.reason ?? 'swarm did not reach consensus'}\n` +
            (r.bucketLabel ? `crowd-leader bucket would have been: ${r.bucketLabel}` : ''),
        )
        return
      }
      const bcast = r.broadcast
        ? `\nbroadcast: ${bcast_status(r.broadcast)}`
        : ''
      await ctx.reply(
        `✅ ${r.dryRun ? '[DRY-RUN] ' : ''}pick executed\n` +
          `bucket: ${r.bucketLabel} (${r.bucketIndex})\n` +
          `size: $${r.sizeUsdt}\n` +
          `tx: \`${r.trade.txHash ?? '(dry-run)'}\`` +
          bcast,
        { parse_mode: 'Markdown' },
      )
    } catch (err) {
      await ctx.reply(`❌ exception: ${(err as Error).message.slice(0, 300)}`)
    }
  })
}

function bcast_status(b: { ok: boolean; channelConfigured: boolean; error?: string }): string {
  if (!b.channelConfigured) return '⚠️ FT_CAMPAIGN_TG_CHANNEL not set'
  if (b.ok) return '✅ posted'
  return `❌ ${b.error ?? 'unknown error'}`
}
