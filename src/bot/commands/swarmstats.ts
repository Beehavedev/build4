import { Bot, Context } from 'grammy'
import { getSwarmStats, formatSwarmStats, type Window } from '../../services/swarmStats'

async function reply(ctx: Context, window: Window): Promise<void> {
  try {
    const report = await getSwarmStats(window)
    await ctx.reply(formatSwarmStats(report), { parse_mode: 'Markdown' })
  } catch (err) {
    console.error('[swarmstats] failed to load roll-up:', err)
    await ctx.reply('⚠️ Could not load swarm stats right now. Please try again shortly.')
  }
}

export function registerSwarmStats(bot: Bot): void {
  bot.command('swarmstats', async (ctx) => {
    const arg = (ctx.match ?? '').toString().trim().toLowerCase()
    const window: Window = arg === '7d' || arg === 'week' ? '7d' : '24h'
    await reply(ctx, window)
  })
}
