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

    // Wallet provisioning is silent. The private key is encrypted server-
    // side and recoverable any time via /wallet → 🔑 Export Private Key
    // (PIN-gated). We deliberately do NOT dump the PK on screen 1 here —
    // friction point #1: ~17.5k users opened /start, almost none read the
    // wall of text, and the PK in plain Telegram chat is a real exfil
    // risk anyway. New users now get a clean welcome → one CTA flow.
    //
    // The `(ctx as any).newWallet` injected by the wallet middleware is
    // intentionally ignored on this path. If we ever need a "your wallet
    // is ready" affordance we'll add it as a small notice with a link to
    // /wallet, not as a PK reveal.

    const wallet = await db.wallet.findFirst({
      where: { userId: user.id, isActive: true }
    })

    // Plain mini-app URL — NO ?onboard=1 query param. The mini-app's own
    // first-paint logic (App.tsx) sends users to Onboard when they have
    // zero agents and to the Dashboard otherwise. Hard-coding ?onboard=1
    // here used to force the Onboard page on every /start tap, which
    // meant returning users (who'd already deployed an agent) kept being
    // dropped on Deploy instead of their Dashboard.
    const miniAppUrl = process.env.MINIAPP_URL || `https://${process.env.REPLIT_DOMAINS?.split(',')[0] || 'build4-1.onrender.com'}/app`

    // Single primary action — Open BUILD4 — followed by two utility rows.
    // Wallet, How it works, and Help cover the only places someone might
    // need to go before they have an agent. Everything else (deposit,
    // signals, portfolio) is reachable from inside the mini app.
    const keyboard = new InlineKeyboard()
      .webApp('📱 Open BUILD4', miniAppUrl)
      .row()
      .text('💳 Wallet', 'wallet')
      .text('ℹ️ How it works', 'how_it_works')
      .row()
      .text('❓ Help', 'help')

    const walletLine = wallet
      ? `\n\n💳 Your BSC wallet: \`${truncateAddress(wallet.address)}\``
      : ''

    await ctx.reply(
      `⚡ *Welcome to BUILD4*

AI agents that trade perps and predictions on Aster, Hyperliquid and 42.space — all from inside Telegram.${walletLine}

*Tap 📱 Open BUILD4* to deploy your first agent. Pick a risk preset, set a starting capital, and your agent is live in under a minute. We cover the gas.

_Your wallet's private key can be exported any time from 💳 Wallet._`,
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
