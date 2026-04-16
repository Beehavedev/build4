import { Bot, InlineKeyboard } from 'grammy'
import { db } from '../../db'
import { truncateAddress } from '../../services/wallet'

export function registerStart(bot: Bot) {
  bot.command('start', async (ctx) => {
    const user = (ctx as any).dbUser
    if (!user) return

    const wallet = await db.wallet.findFirst({
      where: { userId: user.id, isActive: true }
    })

    const miniAppUrl = process.env.MINIAPP_URL || `https://${process.env.REPLIT_DOMAINS?.split(',')[0] || 'build4-1.onrender.com'}/app`

    const keyboard = new InlineKeyboard()
      .webApp('📱 Open BUILD4', miniAppUrl)
      .row()
      .text('💰 My Wallet', 'wallet')
      .text('🤖 Create Agent', 'create_agent')
      .row()
      .text('📊 Signals', 'signals')
      .text('🏆 Quests', 'quests')
      .row()
      .text('📈 Portfolio', 'portfolio')
      .text('❓ Help', 'help')

    const walletLine = wallet
      ? `\n\n💳 *Your BSC Wallet:* \`${truncateAddress(wallet.address)}\``
      : ''

    await ctx.reply(
      `⚡ *Welcome to BUILD4 Trading Bot*

The world's most advanced AI crypto trading agent.${walletLine}

*What BUILD4 does:*
• 🤖 AI agents trade perpetual futures 24/7
• 🐋 Real-time whale & smart money signals
• 🔍 Contract safety scanner
• 📋 Copy top traders automatically
• 🚀 Launch tokens on Four.meme & Raydium
• 🎯 Earn $B4 rewards for every action

*Powered by Claude Sonnet AI*
Your agent learns from every trade, remembers your risk profile, and improves over time.

Use /help to see all commands.`,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      }
    )
  })

  bot.callbackQuery('wallet', async (ctx) => {
    await ctx.answerCallbackQuery()
    const { handleWalletCommand } = await import('./wallet')
    await handleWalletCommand(ctx)
  })

  bot.callbackQuery('create_agent', async (ctx) => {
    await ctx.answerCallbackQuery()
    await ctx.reply(
      '🤖 *Create Your AI Agent*\n\nUse /newagent to start the agent creation wizard.',
      { parse_mode: 'Markdown' }
    )
  })

  bot.callbackQuery('signals', async (ctx) => {
    await ctx.answerCallbackQuery()
    const { handleSignals } = await import('./signals')
    await handleSignals(ctx)
  })

  bot.callbackQuery('quests', async (ctx) => {
    await ctx.answerCallbackQuery()
    const { handleQuests } = await import('./quests')
    await handleQuests(ctx)
  })

  bot.callbackQuery('portfolio', async (ctx) => {
    await ctx.answerCallbackQuery()
    const { handlePortfolio } = await import('./portfolio')
    await handlePortfolio(ctx)
  })

  bot.callbackQuery('help', async (ctx) => {
    await ctx.answerCallbackQuery()
    await ctx.reply(
      `📖 *BUILD4 Command Reference*

*💰 Wallet*
/wallet — View wallets & balances
/linkwallet — Import existing wallet

*🤖 AI Trading*
/newagent — Create AI trading agent
/myagents — View your agents
/trade — Toggle active agent
/tradestatus — Open positions & PnL

*📊 Market Intel*
/signals — Whale & smart money signals
/smartmoney — Smart money tracker
/scan — Contract safety scanner
/trending — Trending tokens
/price — Quick price check

*💸 Trading*
/buy — Buy tokens
/sell — Sell tokens
/swap — Multi-chain swap

*📋 Copy Trading*
/copytrade — Copy top traders

*🚀 Launch*
/launch — Launch a token

*🎮 Rewards*
/quests — Earn $B4 quests
/rewards — $B4 dashboard
/portfolio — Portfolio overview

*🔧 Utility*
/settings — Trading settings
/help — This menu`,
      { parse_mode: 'Markdown' }
    )
  })
}
