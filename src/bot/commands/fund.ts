import { Bot, Context, InlineKeyboard, InputFile } from 'grammy'
import QRCode from 'qrcode'
import { ethers } from 'ethers'
import { db } from '../../db'

// Read on-chain BSC balances directly. We deliberately do NOT use the
// shared getWalletBalances() helper here because it falls back to mock
// values on RPC failure, which would falsely greet the user with
// "✅ USDT received!" on a deposit confirmation screen.
const BSC_RPC = process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org'
const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955'
const ERC20_BAL_ABI = ['function balanceOf(address) view returns (uint256)']

async function readBscBalanceStrict(address: string): Promise<{ usdt: number; bnb: number }> {
  const provider = new ethers.JsonRpcProvider(BSC_RPC)
  const [bnbWei, usdtWei] = await Promise.all([
    provider.getBalance(address),
    new ethers.Contract(USDT_BSC, ERC20_BAL_ABI, provider).balanceOf(address)
  ])
  return {
    bnb: parseFloat(ethers.formatEther(bnbWei)),
    usdt: parseFloat(ethers.formatUnits(usdtWei, 18))
  }
}

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
  // Bind Check Balance to the exact address shown so a wallet switch
  // mid-flow can't make the user check the wrong wallet.
  return new InlineKeyboard()
    .text('📋 Copy Address', `fund_copy:${address}`)
    .text('🔄 Check Balance', `fund_check:${address}`)
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

  bot.callbackQuery(/^fund_check:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery('Checking balance...')
    const user = (ctx as any).dbUser
    if (!user) return
    const address = ctx.match[1]

    // Validate the address actually belongs to this user — prevents
    // someone replaying a callback button to peek at another wallet.
    const wallet = await db.wallet.findFirst({
      where: { userId: user.id, address }
    })
    if (!wallet) {
      await ctx.reply('That wallet is no longer linked to your account. Run /fund again for a fresh address.')
      return
    }

    try {
      const bal = await readBscBalanceStrict(address)
      const short = `${address.slice(0, 6)}…${address.slice(-4)}`
      const status = bal.usdt > 0
        ? `✅ *${bal.usdt.toFixed(2)} USDT* in your wallet — you're ready to trade.\n\nNext: /newagent to spin up your AI trader, or /trade to manage existing ones.`
        : `⏳ No USDT in this wallet yet.\n\nIf you just sent a deposit, wait ~30 seconds for it to confirm on chain, then tap *🔄 Check Balance* again.`
      await ctx.reply(
        `💳 *Wallet Balance* (\`${short}\`)\n\n${status}\n\nUSDT: $${bal.usdt.toFixed(2)}\nBNB: ${bal.bnb.toFixed(4)}`,
        { parse_mode: 'Markdown' }
      )
    } catch (err: any) {
      console.error('[fund] balance check RPC failed:', err)
      await ctx.reply(
        '⚠️ Couldn\'t reach the BNB Smart Chain right now. This does *not* mean your deposit failed — try the *🔄 Check Balance* button again in a moment.',
        { parse_mode: 'Markdown' }
      )
    }
  })

  bot.callbackQuery('fund_back', async (ctx) => {
    await ctx.answerCallbackQuery()
    try { await ctx.deleteMessage() } catch {}
  })
}
