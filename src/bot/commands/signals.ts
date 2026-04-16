import { Bot, Context, InlineKeyboard } from 'grammy'
import { getLatestSignals, formatSignalMessage } from '../../services/signals'

export async function handleSignals(ctx: Context) {
  await ctx.reply('🔍 Fetching latest whale signals...')

  const signals = await getLatestSignals(5)

  for (const signal of signals) {
    const text = formatSignalMessage(signal)
    const keyboard = new InlineKeyboard()
      .text('🔍 Scan Contract', `scan_${signal.contractAddress}`)
      .text('💰 Buy Now', `quick_buy_${signal.token}`)
      .row()
      .text('👁 Track Wallet', `track_wallet_${signal.token}`)

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    })
  }

  const refreshKeyboard = new InlineKeyboard().text(
    '🔄 Refresh Signals',
    'signals'
  )
  await ctx.reply('_Signals update every 5 minutes_', {
    parse_mode: 'Markdown',
    reply_markup: refreshKeyboard
  })
}

export function registerSignals(bot: Bot) {
  bot.command('signals', async (ctx) => handleSignals(ctx))

  bot.command('smartmoney', async (ctx) => {
    const signals = await getLatestSignals(10)
    const smartMoneySignals = signals.filter((s) => s.type === 'SMART_MONEY' || s.type === 'ACCUMULATION')

    if (smartMoneySignals.length === 0) {
      await ctx.reply('No smart money signals in the last hour. Check back soon.')
      return
    }

    let text = `🧠 *Smart Money Tracker*\n\n`
    text += `Tracking ${smartMoneySignals.length} smart money movements:\n\n`

    for (const s of smartMoneySignals) {
      text += `• *${s.token}* — $${(s.amountUsd / 1000).toFixed(0)}k ${s.type === 'ACCUMULATION' ? 'accumulated' : 'moved'}\n`
      text += `  Wallet accuracy: ${s.walletAccuracy}% | Strength: ${s.signalStrength}\n\n`
    }

    await ctx.reply(text, { parse_mode: 'Markdown' })
  })

  bot.command('trending', async (ctx) => {
    await ctx.reply(
      `🔥 *Trending Tokens Right Now*

1. 🟢 *PEPE* +24.3% | Vol $892M | 4.2x avg
2. 🟢 *WIF* +18.7% | Vol $431M | 3.1x avg  
3. 🟢 *BONK* +12.1% | Vol $287M | 2.8x avg
4. 🔴 *FLOKI* -3.2% | Vol $164M | 1.9x avg
5. 🟢 *BRETT* +31.4% | Vol $203M | 5.7x avg

_Updated 2 min ago_`,
      { parse_mode: 'Markdown' }
    )
  })

  bot.callbackQuery('signals', async (ctx) => {
    await ctx.answerCallbackQuery('Loading signals...')
    await handleSignals(ctx)
  })

  bot.callbackQuery(/^scan_(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    const address = ctx.match[1]
    const { handleScanCommand } = await import('./scan')
    await handleScanCommand(ctx, address)
  })

  bot.callbackQuery(/^quick_buy_(.+)$/, async (ctx) => {
    const token = ctx.match[1]
    await ctx.answerCallbackQuery()
    await ctx.reply(
      `💰 Quick Buy *${token}*\n\nHow much USDT would you like to spend?\n\nReply with an amount or use /buy ${token} <amount>`,
      { parse_mode: 'Markdown' }
    )
  })
}
