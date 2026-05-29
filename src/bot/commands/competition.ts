import { Bot, Context } from 'grammy'
import { loadUserBscPrivateKey } from '../../services/fourMemeTrading'
import {
  getActiveCompetition,
  getMyEntry,
  joinCompetition,
} from '../../services/competition'

// ── /competition — join the BUILD4 × four.meme leaderboard from Telegram ──
//
// The leaderboard is SHARED with the web dApp: both write to the same
// aster_competition_entries rows keyed on chat_id = Telegram user id. A bot
// user who joins here shows up on the SAME ranking as web users, and their
// /fourmeme buy/sell trades are counted (see recordCompetitionTrade hooks in
// fourMeme.ts).

function fmtBnb(n: number): string {
  return n.toFixed(4)
}

function parseSubcommand(text: string): { sub: string; args: string[] } {
  const parts = text.trim().split(/\s+/).slice(1)
  const sub = (parts[0] ?? '').toLowerCase()
  return { sub, args: parts.slice(1) }
}

function helpText(): string {
  return [
    '*BUILD4 × four.meme Competition*',
    '',
    'Join the AI Agent Trading Competition and climb the same leaderboard as web players. Your `/fourmeme` buys and sells are scored automatically.',
    '',
    '`/competition` — show your status',
    '`/competition join` — join the active competition',
    '',
    'Trade with `/fourmeme buy <token> <bnb>` and `/fourmeme sell <token> <amount>` — every fill counts toward your rank.',
  ].join('\n')
}

async function handleStatus(ctx: Context) {
  const user = (ctx as any).dbUser
  if (!user) { await ctx.reply('No user record found.'); return }
  const chatId = String(user.telegramId)

  const comp = await getActiveCompetition()
  if (!comp) {
    await ctx.reply('There is no active competition right now. Check back soon.')
    return
  }

  const entry = await getMyEntry(chatId)
  if (!entry) {
    await ctx.reply(
      [
        `*${comp.name}*`,
        `Status: ${comp.status}`,
        '',
        "You haven't joined yet.",
        'Send `/competition join` to enter and start scoring trades.',
      ].join('\n'),
      { parse_mode: 'Markdown' },
    )
    return
  }

  const pnlSign = entry.pnlBnb >= 0 ? '+' : ''
  const rankLine = entry.rank
    ? `Rank: #${entry.rank}${entry.totalEntries ? ` of ${entry.totalEntries}` : ''}`
    : 'Rank: unranked'
  await ctx.reply(
    [
      `*${comp.name}*`,
      `Status: ${comp.status}`,
      '',
      rankLine,
      `Equity: ${fmtBnb(entry.currentBnb)} BNB (started ${fmtBnb(entry.startingBnb)})`,
      `PnL: ${pnlSign}${fmtBnb(entry.pnlBnb)} BNB (${pnlSign}${entry.pnlPct.toFixed(2)}%)`,
      `Trades counted: ${entry.tradeCount}`,
      '',
      'Trade with `/fourmeme buy <token> <bnb>` to climb the board.',
    ].join('\n'),
    { parse_mode: 'Markdown' },
  )
}

async function handleJoin(ctx: Context) {
  const user = (ctx as any).dbUser
  if (!user) { await ctx.reply('No user record found.'); return }
  const chatId = String(user.telegramId)

  let walletAddress: string
  try {
    const loaded = await loadUserBscPrivateKey(user.id)
    walletAddress = loaded.address
  } catch (err: any) {
    await ctx.reply(`Could not load your trading wallet: ${err?.message ?? err}`)
    return
  }

  const result = await joinCompetition({
    chatId,
    walletAddress,
    username: user.username ?? null,
    persona: 'manual',
    mode: 'manual',
  })

  if (!result.ok) {
    await ctx.reply(result.message)
    return
  }

  if (result.alreadyJoined) {
    await ctx.reply(
      [
        `You're already in *${result.competition.name}*.`,
        '',
        'Send `/competition` to see your standing, or `/fourmeme buy <token> <bnb>` to trade.',
      ].join('\n'),
      { parse_mode: 'Markdown' },
    )
    return
  }

  await ctx.reply(
    [
      `✅ Joined *${result.competition.name}*!`,
      '',
      `Starting balance: ${fmtBnb(result.startingBnb)} BNB`,
      'Your custodial wallet is your competition account — fund it with BNB and trade via `/fourmeme`.',
      '',
      'Every buy/sell counts toward your rank on the shared leaderboard.',
    ].join('\n'),
    { parse_mode: 'Markdown' },
  )
}

export function registerCompetition(bot: Bot) {
  bot.command('competition', async (ctx) => {
    const text = ctx.message?.text ?? ''
    const { sub } = parseSubcommand(text)

    switch (sub) {
      case '':
      case 'status':
        await handleStatus(ctx)
        return
      case 'help':
        await ctx.reply(helpText(), { parse_mode: 'Markdown' })
        return
      case 'join':
        await handleJoin(ctx)
        return
      default:
        await ctx.reply(`Unknown subcommand "${sub}". Try \`/competition help\`.`, { parse_mode: 'Markdown' })
        return
    }
  })
}
