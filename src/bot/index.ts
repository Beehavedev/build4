import { Bot, session } from 'grammy'
import { authMiddleware } from './middleware/auth'
import { registerStart } from './commands/start'
import { registerWallet, handlePinReply } from './commands/wallet'
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
  bot.on('message:text', async (ctx, next) => {
    const handled = await handlePinReply(ctx)
    if (!handled) await next()
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
      `📖 *BUILD4 Commands*\n\n*Wallet:* /wallet /linkwallet\n*Trading:* /trade /tradestatus /newagent /myagents\n*Market:* /signals /smartmoney /scan /trending /price\n*Buy/Sell:* /buy /sell /swap /launch\n*Social:* /copytrade /portfolio\n*Rewards:* /quests /rewards\n*Utility:* /settings /gas /cancel /help`,
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

  return bot
}
