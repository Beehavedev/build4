import { Bot, Context, InlineKeyboard } from 'grammy'
import {
  listUserPositions,
  settleResolvedPositions,
  isUserLiveOptedIn,
  setUserLiveOptIn,
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

  const [positions, enabled] = await Promise.all([
    listUserPositions(user.id, 25),
    isUserLiveOptedIn(user.id),
  ])

  const open = positions.filter((p) => p.status === 'open')
  const closed = positions.filter((p) => p.status !== 'open')
  const realized = closed.reduce((s, p) => s + (p.pnl ?? 0), 0)

  let text = `🎯 *Prediction Market Positions*\n\n`
  text += `*Status:* ${enabled ? '💚 ENABLED — trading in LOVE Mode on BSC' : '⏸ DISABLED — no new trades'}\n`
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
        for (const pr of p.providers as Array<{ provider: string; reasoning: string | null }>) {
          if (!pr.reasoning) continue
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

  // Telegram hard-caps text messages at 4096 chars. With many positions and
  // multi-provider quotes we can blow past this; truncate defensively so the
  // send always succeeds.
  const TG_MAX = 3900
  if (text.length > TG_MAX) {
    text = text.slice(0, TG_MAX) + '\n\n_…output truncated to fit Telegram limit._\n'
  }

  // Per-user enable/disable kill switch — when off, no new trades open
  // (existing positions can still be closed/settled).
  const kb = new InlineKeyboard()
  if (enabled) {
    kb.text('⏸ Disable trading', 'predictions_disable')
  } else {
    kb.text('✅ Enable trading', 'predictions_enable')
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

  bot.callbackQuery('predictions_enable', async (ctx) => {
    const user = (ctx as any).dbUser
    if (!user) return ctx.answerCallbackQuery('Not signed in')
    await setUserLiveOptIn(user.id, true)
    await ctx.answerCallbackQuery('42.space trading ENABLED')
    await ctx.reply(
      `✅ *42.space trading enabled.*\n\n` +
      `Live on-chain trades will execute when agents find edge ≥10% and when you tap markets in the mini-app.\n` +
      `Caps: ≤$2/agent trade, ≤$25/manual trade, max 5 open per agent, max 10 manual open.`,
      { parse_mode: 'Markdown' }
    )
  })

  bot.callbackQuery('predictions_disable', async (ctx) => {
    const user = (ctx as any).dbUser
    if (!user) return ctx.answerCallbackQuery('Not signed in')
    await setUserLiveOptIn(user.id, false)
    await ctx.answerCallbackQuery('42.space trading DISABLED')
    await ctx.reply(
      `⏸ *42.space trading disabled.*\n\n` +
      `No new positions will be opened by agents or manual taps. Existing open positions remain — you can still close or settle them.`,
      { parse_mode: 'Markdown' }
    )
  })

  // Legacy callbacks from the old paper-vs-live UI. No-op acks so old
  // inline keyboards in chat history don't 404 when tapped.
  bot.callbackQuery('predictions_live', async (ctx) => {
    await ctx.answerCallbackQuery('Use the new Enable/Disable button')
  })
  bot.callbackQuery('predictions_paper', async (ctx) => {
    await ctx.answerCallbackQuery('Paper mode is gone — use Enable/Disable instead')
  })
}
