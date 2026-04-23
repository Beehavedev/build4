import { Bot, InlineKeyboard } from 'grammy'
import { db } from '../../db'
import { truncateAddress } from '../../services/wallet'

export function registerStart(bot: Bot) {
  bot.command('start', async (ctx) => {
    const user = (ctx as any).dbUser
    if (!user) return

    // Deep-link payload (e.g. /start connect_aster) — route directly to the
    // Aster onboarding flow so the mini-app "Reconnect Now" button drops the
    // user straight into the approveAgent signing step.
    const payload = (ctx.match as string | undefined)?.trim()
    if (payload === 'connect_aster') {
      const { handleAsterConnect } = await import('./aster')
      return handleAsterConnect(ctx)
    }

    // First-time wallet — show the private key ONCE so user can back it up
    const newWallet = (ctx as any).newWallet as { address: string; privateKey: string } | undefined
    if (newWallet) {
      await ctx.reply(
        `🔐 *Your new BSC wallet is ready*

*Address:*
\`${newWallet.address}\`

⚠️ *PRIVATE KEY — SAVE THIS NOW*
\`${newWallet.privateKey}\`

*Read carefully:*
• This is the *only time* this key will be shown.
• Save it somewhere safe (password manager, written down).
• Anyone with this key can steal your funds — *never share it*.
• If you lose it and lose access to this Telegram account, your funds are gone forever.
• BUILD4 stores an encrypted copy so the agent can sign trades, but we cannot recover it for you.

After saving, delete this message from your chat for extra safety.`,
        { parse_mode: 'Markdown' }
      )
    }

    const wallet = await db.wallet.findFirst({
      where: { userId: user.id, isActive: true }
    })

    const miniAppUrl = process.env.MINIAPP_URL || `https://${process.env.REPLIT_DOMAINS?.split(',')[0] || 'build4-1.onrender.com'}/app`

    const keyboard = new InlineKeyboard()
      .text('💰 Deposit', 'deposit')
      .text('💳 Wallet', 'wallet')
      .row()
      .webApp('📱 Open BUILD4', miniAppUrl)
      .row()
      .text('🤖 Create Agent', 'create_agent')
      .text('🗂 My Agents', 'my_agents')
      .row()
      .text('📊 Signals', 'signals')
      .text('📈 Portfolio', 'portfolio')
      .row()
      .text('ℹ️ How it works', 'how_it_works')
      .text('❓ Help', 'help')

    const walletLine = wallet
      ? `\n\n💳 *Your BSC Wallet:* \`${truncateAddress(wallet.address)}\``
      : ''

    await ctx.reply(
      `⚡ *Welcome to BUILD4*

The AI trading hub on Telegram — perps, predictions, swaps and launches across BSC, xLayer and OKX, all from one chat.${walletLine}

*What you can do here:*
• 🤖 *AI agents* — describe a strategy in plain English, let it trade 24/7
• 📈 *Aster perps* — leveraged longs/shorts, signed on-chain with EIP-712
• 🔮 *42.space predictions* — agents trade live prediction markets on BSC
• 🔄 *Multi-chain swaps* — BSC, xLayer and OKX OS in one tap
• 🚀 *Token launches* — launch and trade new tokens from inside the bot
• 📊 *Signals & copy trading* — whale flow, smart money, top traders
• 🎁 *$B4 rewards* — earn points on every trade, signal and quest

*Get started in 3 steps:*

*1️⃣ Deposit USDT*
Tap *💰 Deposit* to see your wallet address. Send USDT (BSC) to fund your account.

*2️⃣ Create your AI agent*
Tap *🤖 Create Agent* and tell it your strategy ("scalp BTC at 3x", "fade overhyped predictions", etc).

*3️⃣ Let it work*
Your agent runs 24/7 across perps and prediction markets, signs every order itself, and reports PnL straight to this chat. You stay in full control — pause anytime.

Tap *ℹ️ How it works* for the full breakdown.`,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      }
    )
  })

  bot.callbackQuery('deposit', async (ctx) => {
    await ctx.answerCallbackQuery()
    const { handleFund } = await import('./fund')
    await handleFund(ctx)
  })

  bot.callbackQuery('how_it_works', async (ctx) => {
    await ctx.answerCallbackQuery()
    await ctx.reply(
      `ℹ️ *How BUILD4 works*

*🔐 Your wallet*
When you ran /start, BUILD4 generated a fresh BNB Smart Chain wallet for you. The private key is encrypted and stored securely — only you control your funds.

*💵 Funding*
Deposit USDT (BEP-20) to your wallet address. Funds stay in *your* wallet at all times — BUILD4 never custodies them.

*🤖 The AI agent*
You describe your strategy in plain English. The agent monitors markets 24/7 using whale flow, smart money tracking, price action and live prediction-market odds — then decides when to enter and exit.

*✍️ Where your agent trades*
• *Aster DEX perps* — BUILD4 is a registered builder. Your agent signs perp orders with EIP-712 and submits them via the Aster Builder API.
• *42.space predictions* — your agent reads live bonding-curve odds on BSC and buys/sells outcome shares directly on chain.
• *Multi-chain swaps* — manual buy/sell across BSC, xLayer and OKX OS routed through OKX DEX aggregator for best price.
• *Token launches* — launch your own token or trade fresh listings the moment they drop.

*💰 Fees*
You only pay the standard venue fees (Aster, 42.space, OKX) plus a small builder fee that funds BUILD4. No subscriptions, no upfront cost.

*🛑 You're in control*
Pause your agent anytime with /trade. Withdraw your USDT to any external wallet whenever you want. BUILD4 has *zero* ability to move your funds — only sign trades on your behalf.

*🎯 Bonus*
Earn $B4 reward points for every trade, signal followed, or quest completed.`,
      { parse_mode: 'Markdown' }
    )
  })

  bot.callbackQuery('wallet', async (ctx) => {
    await ctx.answerCallbackQuery()
    const { handleWalletCommand } = await import('./wallet')
    await handleWalletCommand(ctx)
  })

  // create_agent callback is registered in commands/agents.ts (starts on-chain creation)

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
