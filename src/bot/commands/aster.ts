import { Bot, Context, InlineKeyboard } from 'grammy'
import { db } from '../../db'
import { handleFund } from './fund'
import { decryptPrivateKey, truncateAddress } from '../../services/wallet'
import {
  approveAgent,
  getAccountBalance,
  getDepositAddress,
  ping,
  buildCreds
} from '../../services/aster'

export async function handleAsterStatus(ctx: Context) {
  const user = (ctx as any).dbUser
  if (!user) return

  const wallet = await db.wallet.findFirst({
    where: { userId: user.id, isActive: true }
  })

  const agentPrivKey = process.env.ASTER_AGENT_PRIVATE_KEY
  const agentAddress = process.env.ASTER_AGENT_ADDRESS ?? user.asterAgentAddress
  const isLive = !!(agentPrivKey && agentAddress && wallet?.address)

  let text = `🌟 *Aster DEX Status*\n\n`
  text += `Wallet: \`${wallet ? truncateAddress(wallet.address) : 'none'}\`\n`
  text += `Connected: ${user.asterOnboarded ? '✅ Yes' : '❌ Not yet'}\n`
  text += `Mode: ${isLive ? '🟢 Pro API (live)' : '🟡 Mock (demo)'}\n`

  if (isLive && wallet) {
    try {
      const alive = await ping()
      text += `Aster API: ${alive ? '🟢 Online' : '🔴 Offline'}\n`

      if (alive && user.asterOnboarded) {
        const creds = buildCreds(wallet.address, agentAddress, agentPrivKey)
        if (creds) {
          const bal = await getAccountBalance(creds)
          text += `\n*Futures Account:*\n`
          text += `USDT: $${bal.usdt.toFixed(2)}\n`
          text += `Available margin: $${bal.availableMargin.toFixed(2)}\n`
        }
      }
    } catch {
      text += `Aster API: ⚠️ Error\n`
    }
  }

  if (!isLive) {
    text += `\n_Add ASTER_AGENT_PRIVATE_KEY and ASTER_AGENT_ADDRESS to Replit Secrets._`
  }

  const keyboard = new InlineKeyboard()
    .text('💰 Deposit USDT', 'aster_deposit')
    .text('🔄 Refresh', 'aster_status')

  if (!user.asterOnboarded && isLive) {
    keyboard.row().text('🚀 Connect to BUILD4 (sign once)', 'aster_onboard')
  }

  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard })
}

export function registerAster(bot: Bot) {
  // NOTE: /deposit is intentionally NOT registered here. fund.ts owns it
  // and shows the user's real BUILD4 BSC wallet address with QR code.
  // The previous in-bot Aster-side /deposit relied on getDepositAddress(),
  // which is a signed endpoint that only works for ALREADY-onboarded wallets
  // — useless for the new-user activation flow. (See activation note in the
  // "No aster user found" branch of handleAsterConnect.)

  bot.command('status', async (ctx) => handleAsterStatus(ctx))
  bot.command('astats', async (ctx) => handleAsterStats(ctx))

  bot.callbackQuery('aster_status', async (ctx) => {
    await ctx.answerCallbackQuery('Refreshing...')
    await handleAsterStatus(ctx)
  })

  bot.callbackQuery('aster_deposit', async (ctx) => {
    await ctx.answerCallbackQuery()
    await handleFund(ctx)
  })

  bot.callbackQuery(/^copy_dep_(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Address copied!', show_alert: true })
  })

  // ─── Onboarding: user signs once to approve your agent ───────────────────
  bot.callbackQuery('aster_onboard', async (ctx) => {
    await ctx.answerCallbackQuery()
    await handleAsterConnect(ctx)
  })
}

// ─── /astats — dev-only platform health & Aster stats ──────────────────────
// Gated by DEV_TG_ID env var (comma-separated list of telegram user IDs).
// Silent no-op for non-dev users so the command stays invisible in support chats.
function isDev(tgId?: number | bigint): boolean {
  if (tgId === undefined || tgId === null) return false
  const allow = (process.env.DEV_TG_ID ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (allow.length === 0) return false
  return allow.includes(String(tgId))
}

export async function handleAsterStats(ctx: Context) {
  const tgId = ctx.from?.id
  if (!isDev(tgId)) return // silent — pretend the command doesn't exist

  const t0 = Date.now()
  await ctx.reply('⏳ Gathering stats...')

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)

  const [
    apiAlive,
    apiLatency,
    userTotal,
    userOnboarded,
    agentTotal,
    agentActive,
    agentPaused,
    agentTrading,
    trades24h,
    tradesOpen,
    tradesClosed24h,
    pnlAgg,
    volumeAgg,
    logs24h,
    logErrors24h,
    logOpens24h,
    topTraders
  ] = await Promise.all([
    (async () => {
      const start = Date.now()
      try {
        const ok = await ping()
        return { ok, ms: Date.now() - start }
      } catch {
        return { ok: false, ms: Date.now() - start }
      }
    })().then((r) => r.ok),
    (async () => {
      const start = Date.now()
      try { await ping() } catch {}
      return Date.now() - start
    })(),
    db.user.count(),
    db.user.count({ where: { asterOnboarded: true } }),
    db.agent.count(),
    db.agent.count({ where: { isActive: true } }),
    db.agent.count({ where: { isActive: true, isPaused: true } }),
    db.agent.count({ where: { isActive: true, isPaused: false } }),
    db.trade.count({ where: { openedAt: { gte: since } } }),
    db.trade.count({ where: { status: 'open' } }),
    db.trade.count({ where: { closedAt: { gte: since } } }),
    db.trade.aggregate({ _sum: { pnl: true }, where: { closedAt: { gte: since } } }),
    db.trade.aggregate({
      _sum: { size: true },
      where: { openedAt: { gte: since } }
    }),
    db.agentLog.count({ where: { createdAt: { gte: since } } }),
    db.agentLog.count({ where: { createdAt: { gte: since }, error: { not: null } } }),
    db.agentLog.count({ where: { createdAt: { gte: since }, action: { in: ['OPEN_LONG', 'OPEN_SHORT'] } } }),
    db.trade.groupBy({
      by: ['agentId'],
      where: { openedAt: { gte: since }, agentId: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { agentId: 'desc' } },
      take: 5
    })
  ])

  const topAgentIds = topTraders.map((t) => t.agentId).filter(Boolean) as string[]
  const topAgents = topAgentIds.length
    ? await db.agent.findMany({ where: { id: { in: topAgentIds } }, select: { id: true, name: true } })
    : []
  const nameById = new Map(topAgents.map((a) => [a.id, a.name]))

  const totalPnl = pnlAgg._sum.pnl ?? 0
  const totalVol = volumeAgg._sum.size ?? 0
  const onboardPct = userTotal > 0 ? ((userOnboarded / userTotal) * 100).toFixed(1) : '0'
  const tickRate = logs24h > 0 ? ((logErrors24h / logs24h) * 100).toFixed(2) : '0'
  const openRate = logs24h > 0 ? ((logOpens24h / logs24h) * 100).toFixed(2) : '0'

  const broker = process.env.ASTER_BUILDER_ADDRESS
  const agentEnv = process.env.ASTER_AGENT_ADDRESS
  const brokerPK = process.env.ASTER_BROKER_PK ? '✅' : '❌'
  const agentPK  = process.env.ASTER_AGENT_PRIVATE_KEY ? '✅' : '❌'

  let text = `🛠 *Aster Platform Stats* (last 24h)\n\n`
  text += `*API:* ${apiAlive ? '🟢' : '🔴'} ${apiLatency}ms\n`
  text += `*Env:* broker_pk ${brokerPK} · agent_pk ${agentPK}\n`
  if (broker) text += `Builder: \`${broker.slice(0, 6)}…${broker.slice(-4)}\`\n`
  if (agentEnv) text += `Agent: \`${agentEnv.slice(0, 6)}…${agentEnv.slice(-4)}\`\n`

  text += `\n*Users:* ${userTotal.toLocaleString()}\n`
  text += `Onboarded: ${userOnboarded.toLocaleString()} (${onboardPct}%)\n`

  text += `\n*Agents:* ${agentTotal.toLocaleString()}\n`
  text += `Active: ${agentActive.toLocaleString()} · Trading: ${agentTrading.toLocaleString()} · Paused: ${agentPaused.toLocaleString()}\n`

  text += `\n*Trades 24h:*\n`
  text += `Opened: ${trades24h} · Closed: ${tradesClosed24h} · Open now: ${tradesOpen}\n`
  text += `Volume: $${totalVol.toFixed(0)}\n`
  text += `Realized PnL: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}\n`

  text += `\n*Agent Activity 24h:*\n`
  text += `Ticks: ${logs24h.toLocaleString()} · Errors: ${logErrors24h} (${tickRate}%)\n`
  text += `Opens: ${logOpens24h} (${openRate}% of ticks)\n`

  if (topTraders.length > 0) {
    text += `\n*Top Traders 24h:*\n`
    for (const t of topTraders) {
      const name = nameById.get(t.agentId!) ?? t.agentId!.slice(0, 8)
      text += `• ${name}: ${t._count._all} trades\n`
    }
  }

  text += `\n_Query: ${Date.now() - t0}ms_`

  await ctx.reply(text, { parse_mode: 'Markdown' })
}

// Exported so other commands (e.g. /start connect_aster deep link) can
// trigger the approveAgent flow directly without going through /status.
export async function handleAsterConnect(ctx: Context) {
  const user = (ctx as any).dbUser
  if (!user) return

  const builderAddress = process.env.ASTER_BUILDER_ADDRESS
  const agentPrivKey   = process.env.ASTER_AGENT_PRIVATE_KEY
  const agentAddress   = process.env.ASTER_AGENT_ADDRESS
  const feeRate        = process.env.ASTER_BUILDER_FEE_RATE ?? '0.0001'

  if (!builderAddress || !agentPrivKey || !agentAddress) {
    return ctx.reply(
      '⚠️ Platform not fully configured.\n\n' +
      'The following Replit Secrets are required:\n' +
      '• `ASTER_BUILDER_ADDRESS`\n' +
      '• `ASTER_AGENT_PRIVATE_KEY`\n' +
      '• `ASTER_AGENT_ADDRESS`',
      { parse_mode: 'Markdown' }
    )
  }

  const wallet = await db.wallet.findFirst({
    where: { userId: user.id, isActive: true }
  })
  if (!wallet) return ctx.reply('No active wallet. Use /wallet first.')

  await ctx.reply('⏳ Signing approval transaction...')

  try {
    const userPrivKey = decryptPrivateKey(wallet.encryptedPK, user.id)

    const result = await approveAgent({
      userAddress:    wallet.address,
      userPrivateKey: userPrivKey,
      agentAddress,
      agentName:      'BUILD4 Trading Bot',
      builderAddress,
      maxFeeRate:     feeRate,
      expiredDays:    365
    })

    if (result.success) {
      await db.user.update({
        where: { id: user.id },
        data: {
          asterAgentAddress: agentAddress,
          asterOnboarded:    true
        }
      })

      await ctx.reply(
        `✅ *Connected to Aster!*\n\n` +
        `Your wallet is now authorized for AI agent trading.\n\n` +
        `*What happens next:*\n` +
        `1. Use /deposit to fund your Aster futures account\n` +
        `2. Use /newagent to create a trading agent\n` +
        `3. The agent trades automatically every 60 seconds\n\n` +
        `Fee rate: ${parseFloat(feeRate) * 100}% per trade`,
        { parse_mode: 'Markdown' }
      )
    } else {
      const errStr = String(result.error ?? '').toLowerCase()
      const isNewWallet = errStr.includes('no aster user') || errStr.includes('user not found')

      if (isNewWallet) {
        const wallet = await db.wallet.findFirst({
          where: { userId: user.id, isActive: true }
        })
        const addr = wallet?.address ?? '(run /fund)'
        const miniAppUrl =
          process.env.MINIAPP_URL ||
          `https://${process.env.REPLIT_DOMAINS?.split(',')[0] || 'build4-1.onrender.com'}/app`
        const kb = new InlineKeyboard().webApp('🚀 Open BUILD4 mini app', miniAppUrl)
        await ctx.reply(
          `⚡ *Almost there — one-tap activation*\n\n` +
          `Your Aster account just needs a one-time on-chain setup. BUILD4 does ` +
          `all of it for you — *no WalletConnect, no asterdex.com visit, no signing in your wallet app*.\n\n` +
          `*1. Fund your BUILD4 wallet*\n` +
          `Send any amount of USDT (BEP-20, BNB Smart Chain) to:\n\`${addr}\`\n` +
          `Add ~0.001 BNB for gas (any small amount works).\n\n` +
          `*2. Open the mini app and tap "Activate Trading Account"*\n` +
          `BUILD4 will deposit your USDT to Aster on-chain and approve trading ` +
          `automatically. Takes about 15 seconds.\n\n` +
          `_If you saw a "nonce was not sent" error trying to connect on asterdex.com — ignore it. You don't need that flow anymore._`,
          { parse_mode: 'Markdown', link_preview_options: { is_disabled: true }, reply_markup: kb } as any
        )
      } else {
        await ctx.reply(
          `❌ *Connection failed*\n\n\`${result.error}\`\n\nTry again in a moment.`,
          { parse_mode: 'Markdown' }
        )
      }
    }
  } catch (err: any) {
    await ctx.reply(`❌ Error: ${err.message}`)
  }
}
