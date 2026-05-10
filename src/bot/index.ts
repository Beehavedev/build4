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
import { registerPredictions } from './commands/predictions'
import { registerShowcase } from './commands/showcase'
import { registerSwarmStats } from './commands/swarmstats'
import { registerCampaignWallet } from './commands/campaignWallet'
import { registerFourMeme } from './commands/fourMeme'
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
  registerPredictions(bot)
  registerShowcase(bot)
  registerSwarmStats(bot)
  registerCampaignWallet(bot)
  registerFourMeme(bot)

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

  // /debugpoly — diagnose why an agent isn't being picked up by the
  // Polymarket sweep. Returns the same payload as
  // /api/me/debug-polymarket but accessible from inside Telegram so a
  // user without browser-side mini-app auth can still self-serve.
  bot.command('debugpoly', async (ctx) => {
    try {
      const tg = ctx.from?.id
      if (!tg) { await ctx.reply('No telegram id on context.'); return }
      const { db } = await import('../db')
      const u = await db.user.findUnique({
        where: { telegramId: BigInt(tg) },
        select: { id: true, polymarketAgentTradingEnabled: true },
      })
      if (!u) { await ctx.reply('No user row for your telegram id.'); return }
      const rows = await db.$queryRawUnsafe<any[]>(
        `SELECT name, "isActive", "isPaused", "polymarketEnabled",
                "enabledVenues", "venuesAutoExpanded",
                "lastPolymarketTickAt", "createdAt"
           FROM "Agent"
          WHERE "userId" = $1
          ORDER BY "createdAt" DESC`,
        u.id,
      )
      const polyCreds = await db.polymarketCreds.findUnique({
        where: { userId: u.id },
        select: { walletAddress: true, safeAddress: true },
      })
      const matched = rows.filter((r) =>
        r.isActive && !r.isPaused &&
        (r.polymarketEnabled === true ||
          (Array.isArray(r.enabledVenues) && r.enabledVenues.includes('polymarket'))),
      )
      // Live sweep telemetry — captured at the end of every sweep in
      // polymarketAgent.ts. If null, the runner has never finished a
      // sweep yet (server probably just booted).
      const { getLastPolymarketSweepStatus } = await import('../agents/polymarketAgent')
      const sweep = getLastPolymarketSweepStatus()
      const lines: string[] = []
      lines.push(`*Polymarket debug*`)
      lines.push(`user.polymarketAgentTradingEnabled: \`${u.polymarketAgentTradingEnabled}\``)
      lines.push(`creds: ${polyCreds ? `wallet=\`${polyCreds.walletAddress.slice(0,10)}…\` safe=\`${polyCreds.safeAddress?.slice(0,10) ?? 'null'}…\`` : '_none — run setup_'}`)
      lines.push('')
      lines.push(`*Agents (${rows.length}):*`)
      for (const r of rows) {
        const venues = Array.isArray(r.enabledVenues) ? r.enabledVenues.join(',') : '?'
        lines.push(`• \`${r.name}\` active=${r.isActive} paused=${r.isPaused} polyEn=${r.polymarketEnabled} venues=[${venues}] expanded=${r.venuesAutoExpanded} lastTick=${r.lastPolymarketTickAt ? new Date(r.lastPolymarketTickAt).toISOString().slice(11,19) : 'never'}`)
      }
      lines.push('')
      lines.push(`*Sweep would pick up: ${matched.length} agent(s)*`)
      if (matched.length > 0) lines.push(matched.map((m) => `→ ${m.name}`).join('\n'))
      lines.push('')
      if (sweep) {
        lines.push(`*Last sweep* ${sweep.at.slice(11,19)} UTC: scanned=${sweep.scanned} ticked=${sweep.ticked} placed=${sweep.ordersPlaced} skipped=${sweep.ordersSkipped} errors=${sweep.errors}`)
        if (sweep.loadAgentsError) lines.push(`  loadAgentsError: \`${sweep.loadAgentsError.slice(0,200)}\``)
        if (sweep.listEventsError) lines.push(`  listEventsError: \`${sweep.listEventsError.slice(0,200)}\``)
        if (sweep.lastError)       lines.push(`  lastTickError: \`${sweep.lastError.slice(0,200)}\``)
      } else {
        lines.push(`*Last sweep:* _never completed yet_`)
      }
      lines.push('')
      const diag = u.polymarketAgentTradingEnabled === false
        ? 'BLOCKED: User.polymarketAgentTradingEnabled=false'
        : matched.length === 0
          ? rows.length === 0 ? 'BLOCKED: no agents' : 'BLOCKED: no agent matches sweep filter'
          : 'OK: agent(s) eligible'
      lines.push(`*Diagnosis:* ${diag}`)
      await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' })
    } catch (err: any) {
      await ctx.reply(`debugpoly error: ${err?.message ?? err}`)
    }
  })

  bot.command('help', async (ctx) => {
    await ctx.reply(
      `📖 *BUILD4 Commands*\n\n*Wallet:* /wallet /linkwallet\n*Trading:* /trade /tradestatus /newagent /myagents\n*Market:* /signals /smartmoney /scan /trending /price\n*Buy/Sell:* /buy /sell /swap /launch\n*Social:* /copytrade /portfolio /predictions /showcase\n*Rewards:* /quests /rewards\n*Utility:* /settings /gas /swarmstats /cancel /help`,
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
    { command: 'price',       description: 'Quick token price' },
    { command: 'help',        description: 'Show all commands' },
  ]).catch((err: any) => console.error('[Bot] setMyCommands failed:', err?.message))

  return bot
}
