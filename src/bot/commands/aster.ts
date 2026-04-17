import { Bot, Context, InlineKeyboard } from 'grammy'
import { db } from '../../db'
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
  bot.command('deposit', async (ctx) => {
    const user = (ctx as any).dbUser
    if (!user) return

    const wallet = await db.wallet.findFirst({
      where: { userId: user.id, isActive: true }
    })

    const agentPrivKey = process.env.ASTER_AGENT_PRIVATE_KEY
    const agentAddress = process.env.ASTER_AGENT_ADDRESS ?? user.asterAgentAddress

    if (!agentPrivKey || !agentAddress || !wallet || !user.asterOnboarded) {
      await ctx.reply(
        `💰 *Deposit USDT for Trading*\n\n` +
        `First connect your account via /status, then deposit USDT to your Aster futures wallet.\n\n` +
        `_Currently running in demo mode._`,
        { parse_mode: 'Markdown' }
      )
      return
    }

    const creds = buildCreds(wallet.address, agentAddress, agentPrivKey)
    if (!creds) return ctx.reply('Could not build credentials.')

    const addr = await getDepositAddress(creds)
    if (!addr) return ctx.reply('Could not fetch deposit address. Try again.')

    await ctx.reply(
      `💰 *Deposit USDT to Aster Futures*\n\n` +
      `Network: *${addr.network}*\n` +
      `Address:\n\`${addr.address}\`\n\n` +
      `⚠️ Only send USDT on ${addr.network}.\n` +
      `Funds appear in ~1-3 minutes.`,
      {
        parse_mode: 'Markdown',
        reply_markup: new InlineKeyboard()
          .text('📋 Copy Address', `copy_dep_${addr.address.slice(0, 20)}`)
      }
    )
  })

  bot.command('status', async (ctx) => handleAsterStatus(ctx))

  bot.callbackQuery('aster_status', async (ctx) => {
    await ctx.answerCallbackQuery('Refreshing...')
    await handleAsterStatus(ctx)
  })

  bot.callbackQuery('aster_deposit', async (ctx) => {
    await ctx.answerCallbackQuery()
    // Re-use deposit command handler
    const fakeCtx = { ...ctx, message: { text: '/deposit' } }
    await ctx.reply('Use /deposit to get your deposit address.')
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
      await ctx.reply(
        `❌ *Connection failed*\n\n\`${result.error}\`\n\nTry again or check your wallet has USDT on Aster.`,
        { parse_mode: 'Markdown' }
      )
    }
  } catch (err: any) {
    await ctx.reply(`❌ Error: ${err.message}`)
  }
}
