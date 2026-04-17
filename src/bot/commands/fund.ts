import { Bot, Context, InlineKeyboard, InputFile } from 'grammy'
import QRCode from 'qrcode'
import { db } from '../../db'
import { getWalletBalances } from '../../services/wallet'

const FUND_INSTRUCTIONS = (address: string) => `💰 *Fund your BUILD4 account*

Send *USDT (BEP-20)* on *BNB Smart Chain* to your wallet:

\`${address}\`

_Tap the address above to copy it._

⚠️ *Important:*
• Network must be *BNB Smart Chain (BEP-20)* — NOT Ethereum, NOT Solana, NOT Tron. Wrong network = funds lost.
• Only send *USDT*. Other tokens won't be credited.
• Minimum: *10 USDT* recommended to cover trading.

Funds usually arrive within 30 seconds of confirmation. Tap *🔄 Check Balance* below after sending.`

async function buildQrPng(text: string): Promise<Buffer> {
  return QRCode.toBuffer(text, {
    errorCorrectionLevel: 'M',
    type: 'png',
    margin: 2,
    width: 360,
    color: { dark: '#000000', light: '#FFFFFF' }
  })
}

function fundKeyboard(address: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('📋 Copy Address', `fund_copy:${address}`)
    .text('🔄 Check Balance', 'fund_check')
    .row()
    .text('⬅️ Back', 'fund_back')
}

export async function handleFund(ctx: Context) {
  const user = (ctx as any).dbUser
  if (!user) return

  const wallet = await db.wallet.findFirst({
    where: { userId: user.id, isActive: true }
  })
  if (!wallet) {
    await ctx.reply('No wallet found. Please run /start to create one.')
    return
  }

  try {
    const png = await buildQrPng(wallet.address)
    await ctx.replyWithPhoto(new InputFile(png, `fund-${wallet.address.slice(2, 10)}.png`), {
      caption: FUND_INSTRUCTIONS(wallet.address),
      parse_mode: 'Markdown',
      reply_markup: fundKeyboard(wallet.address)
    })
  } catch (err) {
    console.error('[fund] QR generation failed:', err)
    // Fall back to text-only if QR rendering fails for any reason.
    await ctx.reply(FUND_INSTRUCTIONS(wallet.address), {
      parse_mode: 'Markdown',
      reply_markup: fundKeyboard(wallet.address)
    })
  }
}

export function registerFund(bot: Bot) {
  bot.command('fund', handleFund)
  // /deposit is an alias people will guess.
  bot.command('deposit', handleFund)

  bot.callbackQuery(/^fund_copy:(.+)$/, async (ctx) => {
    const address = ctx.match[1]
    // Telegram alerts can hold up to 200 chars and let the user select-and-copy
    // the address from the popup on every client.
    await ctx.answerCallbackQuery({
      text: address,
      show_alert: true
    })
  })

  bot.callbackQuery('fund_check', async (ctx) => {
    await ctx.answerCallbackQuery('Checking balance...')
    const user = (ctx as any).dbUser
    if (!user) return
    const wallet = await db.wallet.findFirst({
      where: { userId: user.id, isActive: true }
    })
    if (!wallet) return ctx.reply('No wallet found.')
    try {
      const bal = await getWalletBalances(wallet.address, wallet.chain)
      const status = bal.usdt > 0
        ? `✅ *${bal.usdt.toFixed(2)} USDT* received! You're ready to trade.\n\nNext: /newagent to spin up your AI trader, or /trade to manage existing ones.`
        : `⏳ No USDT received yet.\n\nIf you just sent a deposit, wait ~30 seconds for it to confirm on chain, then tap *🔄 Check Balance* again.`
      await ctx.reply(
        `💳 *Wallet Balance*\n\n${status}\n\nUSDT: $${bal.usdt.toFixed(2)}\n${bal.nativeSymbol}: ${bal.native.toFixed(4)}`,
        { parse_mode: 'Markdown' }
      )
    } catch (err: any) {
      console.error('[fund] balance check failed:', err)
      await ctx.reply('⚠️ Could not check balance right now. Try again in a moment.')
    }
  })

  bot.callbackQuery('fund_back', async (ctx) => {
    await ctx.answerCallbackQuery()
    try { await ctx.deleteMessage() } catch {}
  })
}
