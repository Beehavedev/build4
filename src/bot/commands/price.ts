import { Bot, InlineKeyboard } from 'grammy'
import { getPrice } from '../../services/price'

export function registerPriceCommands(bot: Bot) {
  bot.command('price', async (ctx) => {
    const args = ctx.message?.text?.split(' ')
    const symbol = (args?.[1] ?? 'BTC').toUpperCase()

    try {
      const data = await getPrice(symbol)
      const changeEmoji = data.change24h >= 0 ? '📈' : '📉'
      const changeStr = `${data.change24h >= 0 ? '+' : ''}${data.change24h.toFixed(2)}%`

      await ctx.reply(
        `${changeEmoji} *${symbol}/USDT*\n\nPrice: *$${data.price.toLocaleString('en-US', { maximumFractionDigits: 4 })}*\n24h Change: ${changeStr}\n24h High: $${data.high24h.toLocaleString()}\n24h Low: $${data.low24h.toLocaleString()}\nVolume: $${(data.volume24h / 1e9).toFixed(2)}B`,
        { parse_mode: 'Markdown' }
      )
    } catch {
      await ctx.reply(`Could not fetch price for ${symbol}. Try BTC, ETH, BNB, SOL.`)
    }
  })

  bot.command('buy', async (ctx) => {
    const args = ctx.message?.text?.split(' ')
    const token = args?.[1]?.toUpperCase()
    const amount = args?.[2] ? parseFloat(args[2]) : null

    if (!token) {
      await ctx.reply(
        '*Buy Tokens*\n\nUsage: `/buy TOKEN AMOUNT`\nExample: `/buy BTC 100`\n\nThis will buy $100 USDT worth of BTC.',
        { parse_mode: 'Markdown' }
      )
      return
    }

    try {
      const data = await getPrice(token)
      const spendAmount = amount ?? 100
      const tokensReceived = spendAmount / data.price

      const keyboard = new InlineKeyboard()
        .text(`✅ Buy $${spendAmount} of ${token}`, `confirm_buy_${token}_${spendAmount}`)
        .row()
        .text('❌ Cancel', 'cancel_action')

      await ctx.reply(
        `💰 *Buy ${token}*\n\nCurrent Price: $${data.price.toLocaleString('en-US', { maximumFractionDigits: 6 })}\n24h Change: ${data.change24h >= 0 ? '+' : ''}${data.change24h.toFixed(2)}%\n\nYou spend: $${spendAmount} USDT\nYou receive: ~${tokensReceived.toFixed(6)} ${token}\n\nConfirm purchase?`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
      )
    } catch {
      await ctx.reply(`Token ${token} not found. Try BTC, ETH, BNB, SOL.`)
    }
  })

  bot.callbackQuery(/^confirm_buy_(.+)_(.+)$/, async (ctx) => {
    const token = ctx.match[1]
    const amount = parseFloat(ctx.match[2])
    await ctx.answerCallbackQuery()

    // Mock execution
    const mockTxHash = `0x${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`
    await ctx.reply(
      `✅ *Buy Order Executed*\n\nToken: ${token}\nAmount: $${amount} USDT\nTx: \`${mockTxHash.slice(0, 20)}...\`\n\n_In production: actual DEX swap via OKX DEX API_`,
      { parse_mode: 'Markdown' }
    )
  })

  bot.command('sell', async (ctx) => {
    await ctx.reply(
      `💸 *Sell Tokens*\n\nSelect a token from your wallet to sell:\n\n_(In production: fetches live wallet balances)_\n\nUsage: \`/sell TOKEN AMOUNT\`\nExample: \`/sell ETH 0.5\``,
      { parse_mode: 'Markdown' }
    )
  })

  bot.command('swap', async (ctx) => {
    await ctx.reply(
      `🔄 *Multi-Chain Swap*\n\nOKX DEX integration\nSupported chains: BSC, ETH, Solana, Base, Arbitrum\n\nUsage: \`/swap FROM TO AMOUNT\`\nExample: \`/swap ETH USDT 0.5\`\n\n_Powered by OKX DEX aggregator for best rates_`,
      { parse_mode: 'Markdown' }
    )
  })

  bot.command('tokeninfo', async (ctx) => {
    const args = ctx.message?.text?.split(' ')
    const symbol = args?.[1]?.toUpperCase() ?? 'BTC'

    try {
      const data = await getPrice(symbol)
      await ctx.reply(
        `📊 *${symbol} Token Info*\n\nPrice: $${data.price.toLocaleString('en-US', { maximumFractionDigits: 6 })}\n24h Change: ${data.change24h >= 0 ? '+' : ''}${data.change24h.toFixed(2)}%\nMarket Cap: $${(data.marketCap / 1e9).toFixed(2)}B\nVolume 24h: $${(data.volume24h / 1e6).toFixed(0)}M`,
        { parse_mode: 'Markdown' }
      )
    } catch {
      await ctx.reply('Token not found.')
    }
  })

  bot.command('launch', async (ctx) => {
    const keyboard = new InlineKeyboard()
      .text('🟡 Four.meme', 'launch_fourmeme')
      .text('🟣 Raydium', 'launch_raydium')
      .row()
      .text('🥷 Stealth Launch', 'launch_stealth')

    await ctx.reply(
      `🚀 *Token Launch*\n\nChoose your launch platform:\n\n• *Four.meme* — BSC meme tokens\n• *Raydium* — Solana tokens\n• *Stealth* — Hidden launch with sniper config`,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    )
  })

  bot.callbackQuery(/^launch_(.+)$/, async (ctx) => {
    const platform = ctx.match[1]
    await ctx.answerCallbackQuery()
    await ctx.reply(
      `🚀 *${platform} Launch Wizard*\n\nReply with your token details:\n\nFormat:\nName: My Token\nSymbol: MTK\nSupply: 1000000000\nDescription: A great token\n\nOr use /launch for guided setup.`,
      { parse_mode: 'Markdown' }
    )
  })

  bot.callbackQuery('cancel_action', async (ctx) => {
    await ctx.answerCallbackQuery('Cancelled')
    await ctx.deleteMessage().catch(() => {})
  })
}
