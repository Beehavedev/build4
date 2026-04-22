import { Bot, Context } from 'grammy'
import { getMostRecentLiveSwarmPrediction, type ProviderTelemetry } from '../../services/fortyTwoExecutor'

function escapeMd(s: string): string {
  return s.replace(/([_*`\[\]])/g, '\\$1')
}

function trimReasoning(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine
}

/**
 * /showcase — partnership demo surface.
 *
 * Pulls the most recent live (real on-chain) OPEN_PREDICTION position whose
 * decision came from the multi-provider swarm and renders one clean message:
 *
 *   1. Consensus quote on top (the agreed-upon agent reasoning).
 *   2. Each provider's individual quote underneath, prefixed with the
 *      provider name.
 *   3. The BscScan tx hash at the bottom, as a clickable link.
 *
 * This is the screenshottable artifact for the 42.space partnership.
 */
export async function handleShowcase(ctx: Context) {
  const pos = await getMostRecentLiveSwarmPrediction()
  if (!pos) {
    await ctx.reply(
      `🎬 *BUILD4 × 42.space Swarm Demo*\n\n` +
      `_No live swarm-driven prediction trades on file yet._\n\n` +
      `Once a swarm-enabled agent opens a real on-chain position on a 42.space market, ` +
      `it will appear here with each provider's quote and the matching BscScan tx hash.`,
      { parse_mode: 'Markdown' }
    )
    return
  }

  const providers = (Array.isArray(pos.providers) ? pos.providers : []) as ProviderTelemetry[]
  const ok = providers.filter((p) => p.ok && p.reasoning)

  let text = `🎬 *BUILD4 × 42.space — Multi-Provider Swarm*\n\n`
  text += `*Market:* ${escapeMd(pos.marketTitle)}\n`
  text += `*Outcome:* ${escapeMd(pos.outcomeLabel)} @ ${(pos.entryPrice * 100).toFixed(1)}% implied\n`
  text += `*Allocation:* $${pos.usdtIn.toFixed(2)} USDT (real on-chain)\n\n`

  text += `*🤝 Consensus quote:*\n_${escapeMd(trimReasoning(pos.reasoning ?? '(no consensus reasoning recorded)', 350))}_\n\n`

  if (ok.length > 0) {
    text += `*🤖 Per-provider quotes (${ok.length}/${providers.length} ok):*\n`
    for (const p of ok) {
      text += `• *${escapeMd(p.provider)}* (${p.latencyMs}ms, ${p.tokensUsed}tok):\n`
      text += `  _${escapeMd(trimReasoning(p.reasoning ?? '', 220))}_\n`
    }
    text += `\n`
  }

  if (pos.txHashOpen) {
    text += `🔗 [Verify on BscScan](https://bscscan.com/tx/${pos.txHashOpen})`
  }

  await ctx.reply(text, { parse_mode: 'Markdown', disable_web_page_preview: true } as any)
}

export function registerShowcase(bot: Bot) {
  bot.command('showcase', handleShowcase)
}
