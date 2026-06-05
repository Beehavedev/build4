import { Bot, session } from 'grammy'
import { authMiddleware } from './middleware/auth'
import { registerStart } from './commands/start'
import { registerWallet, handlePinReply, handleWalletImportReply } from './commands/wallet'
import { registerTrade } from './commands/trade'
import { registerSignals } from './commands/signals'
import { registerScan } from './commands/scan'
import { registerPortfolio } from './commands/portfolio'
import { registerQuests } from './commands/quests'
import { registerCopytrade } from './commands/copytrade'
import { registerAgents } from './commands/agents'
import { registerPriceCommands } from './commands/price'
import { registerTrustWallet } from './commands/trustwallet'
import { registerAster } from './commands/aster'
import { registerFund, handleFund } from './commands/fund'
import { registerPredictions } from './commands/predictions'
import { registerShowcase } from './commands/showcase'
import { registerSwarmStats } from './commands/swarmstats'
import { registerCampaignWallet } from './commands/campaignWallet'
import { registerFourMeme } from './commands/fourMeme'
import { registerCompetition } from './commands/competition'
import { registerTopaz } from './commands/topaz'
import { registerHouseUcl } from './commands/houseUcl'
import { registerSubscribe, handlePaymentTxReply } from './commands/subscribe'
import { registerFleet } from './commands/fleet'
import { registerLlm } from './llm'

export function createBot(): Bot {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required')

  const bot = new Bot(token)

  // Session middleware
  bot.use(session({ initial: () => ({}) }))

  // Auth middleware — creates user on first message
  bot.use(authMiddleware)

  // PIN reply interceptor — must run BEFORE command handlers so digits-only
  // messages from a pending PIN prompt don't fall through to other handlers.
  // Also catches subscription tx-hash replies (0x…64hex) so they don't get
  // mistaken for an LLM prompt.
  bot.on('message:text', async (ctx, next) => {
    // PIN and payment flows take precedence: they only consume when THEIR
    // pending state is set, so running them first prevents a pending wallet
    // import from hijacking a PIN reply (digits) or a payment tx hash
    // (0x+64hex, same shape as a private key). The import handler runs last and
    // only consumes when it is the sole pending text flow.
    if (await handlePinReply(ctx)) return
    if (await handlePaymentTxReply(ctx)) return
    if (await handleWalletImportReply(ctx)) return
    await next()
  })

  // Register all command handlers
  registerStart(bot)
  registerWallet(bot)
  registerTrade(bot)
  registerSignals(bot)
  registerScan(bot)
  registerPortfolio(bot)
  registerQuests(bot)
  registerCopytrade(bot)
  registerAgents(bot)
  registerPriceCommands(bot)
  registerTrustWallet(bot)
  registerAster(bot)
  registerFund(bot)
  registerPredictions(bot)
  registerShowcase(bot)
  registerSwarmStats(bot)
  registerCampaignWallet(bot)
  registerFourMeme(bot)
  registerCompetition(bot)
  registerTopaz(bot)
  registerHouseUcl(bot)
  registerSubscribe(bot)
  registerFleet(bot)

  // Fallback commands
  bot.command('settings', async (ctx) => {
    await ctx.reply(
      `⚙️ *Settings*\n\nUse these commands to configure your experience:\n\n• /newagent — Create/configure agents\n• /wallet — Manage wallets\n• /myagents — View agent settings\n\nMore settings coming soon.`,
      { parse_mode: 'Markdown' }
    )
  })

  bot.command('cancel', async (ctx) => {
    await ctx.reply('Action cancelled.')
  })

  bot.command('gas', async (ctx) => {
    await ctx.reply(
      `⛽ *Gas Prices*\n\n🟡 BSC: ~0.5 Gwei (< $0.01)\n🔵 ETH: ~15 Gwei (~$2-5)\n🟣 Polygon: ~30 Gwei (< $0.01)\n🔴 Arbitrum: ~0.1 Gwei (~$0.05)\n\n_Updated 1 min ago_`
    )
  })

  bot.command('help', async (ctx) => {
    await ctx.reply(
      `📖 *BUILD4 Commands*\n\n*Wallet:* /wallet /linkwallet\n*Trading:* /trade /tradestatus /newagent /myagents\n*Market:* /signals /smartmoney /scan /trending /price\n*Buy/Sell:* /buy /sell /swap /launch\n*Social:* /copytrade /portfolio /predictions /showcase\n*Compete:* /competition\n*Rewards:* /quests /rewards\n*Utility:* /settings /gas /swarmstats /cancel /help`,
      { parse_mode: 'Markdown' }
    )
  })

  // LLM fallback — must be registered LAST so all slash commands and other
  // message:text handlers (PIN reply, agents wizard, etc.) take priority.
  // Only fires for plain text that nothing else handled.
  registerLlm(bot)

  // Error handler
  bot.catch((err) => {
    console.error('[Bot] Error:', err.message)
  })

  // Telegram chat menu — registers the slash-command shortcuts that show
  // when the user taps the menu button next to the message field. Fire
  // and forget; setMyCommands is idempotent and Telegram caches the list
  // server-side so it persists across restarts.
  bot.api.setMyCommands([
    { command: 'start',       description: 'Open BUILD4 main menu' },
    { command: 'wallet',      description: 'View wallet & balances (BSC + Arbitrum)' },
    { command: 'trade',       description: 'Trade Aster perps · BSC' },
    { command: 'tradestatus', description: 'Open positions & PnL' },
    { command: 'newagent',    description: 'Create an AI trading agent' },
    { command: 'myagents',    description: 'List your agents' },
    { command: 'signals',     description: 'Whale flow & smart-money signals' },
    { command: 'portfolio',   description: 'Portfolio overview' },
    { command: 'predictions', description: 'Trade 42.space prediction markets' },
    { command: 'competition', description: 'Join the four.meme trading competition' },
    { command: 'price',       description: 'Quick token price' },
    { command: 'subscribe',   description: 'Manage your BUILD4 Pro subscription' },
    { command: 'help',        description: 'Show all commands' },
  ]).catch((err: any) => console.error('[Bot] setMyCommands failed:', err?.message))

  // Persistent menu button — the "Open App" launcher next to the message
  // field that opens the BUILD4 mini-app. Without this Telegram falls back to
  // showing the slash-command list instead of the app launcher, which is why
  // the mini-app "disappears" from the bot. Idempotent + cached server-side so
  // it persists across restarts.
  //
  // CRITICAL: ONLY the real production bot may set this. The chat menu button is
  // a single global setting shared by every instance using this token. The
  // ephemeral workspace/dev instance (REPLIT_DOMAINS=*.replit.dev) or any
  // stand-down instance (TELEGRAM_BOT_EXTERNAL=true) must NOT set it — otherwise
  // every workspace restart clobbers the production menu with an unreachable dev
  // URL and the mini-app "disappears" for real users.
  const isEphemeralOrStandby =
    process.env.TELEGRAM_BOT_EXTERNAL === 'true'
    || (process.env.REPLIT_DOMAINS || '').includes('.replit.dev')
  if (isEphemeralOrStandby) {
    console.log('[Bot] Ephemeral/standby instance — NOT setting chat menu button (prod bot owns it)')
  } else {
    const miniAppUrl = process.env.MINIAPP_URL
      || `https://${process.env.REPLIT_DOMAINS?.split(',')[0] || 'build4-1.onrender.com'}/app`
    bot.api.setChatMenuButton({
      menu_button: { type: 'web_app', text: 'Open App', web_app: { url: miniAppUrl } },
    }).catch((err: any) => console.error('[Bot] setChatMenuButton failed:', err?.message))
  }

  return bot
}
