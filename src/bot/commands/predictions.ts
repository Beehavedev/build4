import { Bot, Context, InlineKeyboard } from 'grammy'
import {
  listUserPositions,
  isUserLiveOptedIn,
  setUserLiveOptIn,
  settleResolvedPositions,
} from '../../services/fortyTwoExecutor'

function fmtPnl(pnl: number | null): string {
  if (pnl === null) return '—'
  const sign = pnl >= 0 ? '+' : ''
  return `${sign}$${pnl.toFixed(2)}`
}

// Telegram Markdown is fragile — any unescaped *, _, `, [, ] in a market title
// or outcome label can break the whole message render. Escape conservatively.
function escapeMd(s: string): string {
  return s.replace(/([_*`\[\]])/g, '\\$1')
}

function statusEmoji(status: string): string {
  switch (status) {
    case 'open': return '🟡'
    case 'closed': return '⚪'
    case 'resolved_win': return '🟢'
    case 'resolved_loss': return '🔴'
    default: return '⚫'
  }
}

export async function handlePredictions(ctx: Context) {
  const user = (ctx as any).dbUser
  if (!user) return

  // Settle anything that resolved before showing the table.
  try { await settleResolvedPositions({ userId: user.id }) } catch {}

  const [positions, liveOptIn] = await Promise.all([
    listUserPositions(user.id, 25),
    isUserLiveOptedIn(user.id),
  ])

  const open = positions.filter((p) => p.status === 'open')
  const closed = positions.filter((p) => p.status !== 'open')
  const realized = closed.reduce((s, p) => s + (p.pnl ?? 0), 0)

  let text = `🎯 *Prediction Market Positions*\n\n`
  text += `*Mode:* ${liveOptIn ? '🔴 LIVE (real on-chain trades)' : '📝 PAPER (simulated)'}\n`
  text += `*Open positions:* ${open.length}\n`
  text += `*Realised PnL:* ${fmtPnl(realized)} USDT (${closed.length} settled)\n\n`

  if (positions.length === 0) {
    text += `_No prediction positions yet. Active agents will open these when their conviction beats the on-chain implied probability by ≥10%._\n`
  } else {
    text += `*Recent positions:*\n`
    for (const p of positions.slice(0, 12)) {
      const mode = p.paperTrade ? '📝' : '🔴'
      const titleRaw = p.marketTitle.length > 40 ? p.marketTitle.slice(0, 37) + '…' : p.marketTitle
      // Resolved winners need an on-chain claim before USDT lands in the wallet
      // — flag that explicitly so the displayed PnL isn't mistaken for cash.
      const claimSuffix = !p.paperTrade && p.status === 'resolved_win' ? ' _(unclaimed on-chain)_' : ''
      text += `${statusEmoji(p.status)}${mode} *${escapeMd(p.outcomeLabel)}* @ ${(p.entryPrice * 100).toFixed(0)}% — $${p.usdtIn.toFixed(2)} → ${fmtPnl(p.pnl)}${claimSuffix}\n`
      text += `   _${escapeMd(titleRaw)}_\n`
      // Per-provider swarm reasoning quotes (one truncated line per provider).
      // Only positions opened on the swarm path have this populated.
      if (Array.isArray(p.providers)) {
        for (const pr of p.providers as Array<{ provider: string; ok: boolean; reasoning: string | null }>) {
          if (!pr.ok || !pr.reasoning) continue
          const oneLine = pr.reasoning.replace(/\s+/g, ' ').trim()
          const trimmed = oneLine.length > 110 ? oneLine.slice(0, 107) + '…' : oneLine
          text += `   • _${escapeMd(pr.provider)}:_ ${escapeMd(trimmed)}\n`
        }
      }
      // BscScan link to the open transaction for live (non-paper) positions.
      if (!p.paperTrade && p.txHashOpen) {
        text += `   🔗 [BscScan tx](https://bscscan.com/tx/${p.txHashOpen})\n`
      }
    }
  }

  const kb = new InlineKeyboard()
  if (liveOptIn) {
    kb.text('📝 Switch to paper-trade', 'predictions_paper')
  } else {
    kb.text('🔴 Enable LIVE trading', 'predictions_live')
  }
  kb.row().text('🔄 Refresh', 'predictions_refresh')

  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb })
}

export function registerPredictions(bot: Bot) {
  bot.command('predictions', handlePredictions)

  bot.callbackQuery('predictions_refresh', async (ctx) => {
    await ctx.answerCallbackQuery('Refreshing…')
    await handlePredictions(ctx)
  })

  bot.callbackQuery('predictions_live', async (ctx) => {
    const user = (ctx as any).dbUser
    if (!user) return ctx.answerCallbackQuery('Not signed in')
    await setUserLiveOptIn(user.id, true)
    await ctx.answerCallbackQuery('Live trading ENABLED')
    await ctx.reply(
      `🔴 *LIVE prediction-market trading enabled.*\n\n` +
      `Your active agents will now place real on-chain swaps on 42.space using your active BSC wallet.\n` +
      `Positions are capped per market (≤$2 USDT each, ≤10% of agent.maxPositionSize, max 5 open, max 3 new/day).\n\n` +
      `Run /predictions again any time to switch back to paper mode.`,
      { parse_mode: 'Markdown' }
    )
  })

  bot.callbackQuery('predictions_paper', async (ctx) => {
    const user = (ctx as any).dbUser
    if (!user) return ctx.answerCallbackQuery('Not signed in')
    await setUserLiveOptIn(user.id, false)
    await ctx.answerCallbackQuery('Switched to paper mode')
    await ctx.reply(
      `📝 *Paper-trade mode active.*\n\nNo on-chain transactions will be sent. Agents still record positions for tracking.`,
      { parse_mode: 'Markdown' }
    )
  })
}
