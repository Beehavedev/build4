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
