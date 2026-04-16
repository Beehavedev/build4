import { Bot, Context, InlineKeyboard } from 'grammy'
import { db } from '../../db'
import { generateEVMWallet, encryptPrivateKey, truncateAddress } from '../../services/wallet'
import { registerAgentOnChain, bscscanTxUrl, bscscanAddressUrl } from '../../services/registry'

interface AgentSession {
  step: 'name' | 'exchange' | 'pairs' | 'maxPosition' | 'maxDailyLoss' | 'confirm' | 'done'
  name?: string
  walletAddress?: string
  encryptedPK?: string
  onchainTxHash?: string | null
  exchange?: string
  pairs?: string[]
  maxPosition?: number
  maxDailyLoss?: number
}

const sessions = new Map<string, AgentSession>()

const NAME_REGEX = /^[a-zA-Z0-9_]{3,24}$/

async function startAgentCreation(ctx: Context) {
  const user = (ctx as any).dbUser
  if (!user) return

  sessions.set(user.id, { step: 'name' })

  await ctx.reply(
    `🤖 *Create Your On-Chain Agent*

Every BUILD4 agent has its own *on-chain identity* — a unique name and a fresh BNB Smart Chain wallet that lives forever on the blockchain.

*Step 1 — Choose a name*

Pick a unique name for your agent (3-24 characters, letters/numbers/underscore only).

This name will be *permanently registered on-chain* and cannot be changed or reused by anyone else.

Examples: \`AlphaHunter\`, \`night_trader\`, \`BTCBull42\`

Reply with your agent's name 👇

(or /cancel to stop)`,
    { parse_mode: 'Markdown' }
  )
}

export function registerAgents(bot: Bot) {
  bot.command('newagent', async (ctx) => {
    await startAgentCreation(ctx)
  })

  // Triggered from the main "Create Agent" button on the welcome screen
  bot.callbackQuery('create_agent', async (ctx) => {
    await ctx.answerCallbackQuery()
    await startAgentCreation(ctx)
  })

  // Cancel anytime
  bot.command('cancelagent', async (ctx) => {
    const user = (ctx as any).dbUser
    if (user) sessions.delete(user.id)
    await ctx.reply('Agent creation cancelled.')
  })

  // Text handler for the conversation
  bot.on('message:text', async (ctx, next) => {
    const user = (ctx as any).dbUser
    if (!user) return next()

    const session = sessions.get(user.id)
    if (!session) return next()

    const text = ctx.message.text.trim()
    if (text.startsWith('/')) return next()

    // STEP 1: Name → validate, generate wallet, register on-chain
    if (session.step === 'name') {
      const name = text

      if (!NAME_REGEX.test(name)) {
        await ctx.reply('❌ Invalid name. Use 3-24 letters/numbers/underscore only.\n\nTry again:')
        return
      }

      // Check global uniqueness (case-insensitive)
      const existing = await db.agent.findFirst({
        where: { name: { equals: name, mode: 'insensitive' } }
      })
      if (existing) {
        await ctx.reply(`❌ The name *${name}* is already taken on-chain.\n\nPick another name:`, {
          parse_mode: 'Markdown'
        })
        return
      }

      await ctx.reply(`⏳ Reserving *${name}*...\n\nGenerating wallet & broadcasting registration to BNB Chain...`, {
        parse_mode: 'Markdown'
      })

      // Generate the agent's own wallet — its on-chain identity
      const { address, privateKey } = generateEVMWallet()
      const encryptedPK = encryptPrivateKey(privateKey, user.id)

      // Try to register on-chain
      const wallets = await db.wallet.findMany({ where: { userId: user.id }, take: 1 })
      const ownerAddress = wallets[0]?.address ?? '0x0000000000000000000000000000000000000000'

      const result = await registerAgentOnChain(name, address, ownerAddress)

      session.name = name
      session.walletAddress = address
      session.encryptedPK = encryptedPK
      session.onchainTxHash = result.txHash ?? null
      session.step = 'exchange'

      const onchainStatus = result.success
        ? `✅ *Registered on-chain*\n[View transaction](${bscscanTxUrl(result.txHash!)})`
        : `🟡 *On-chain registration pending*\n_Reason: ${result.reason}_\n_Will be claimed automatically when registry wallet is funded._`

      const keyboard = new InlineKeyboard()
        .text('Aster DEX (perps)', 'agent_exchange_aster')
        .row()
        .text('Mock (Testing)', 'agent_exchange_mock')

      await ctx.reply(
        `✅ *Agent ${name} created!*

🔐 *On-chain identity*
\`${address}\`
[View on BSCScan](${bscscanAddressUrl(address)})

${onchainStatus}

━━━━━━━━━━━━━━

*Step 2 — Choose exchange*

Where should your agent trade?`,
        {
          parse_mode: 'Markdown',
          reply_markup: keyboard,
          link_preview_options: { is_disabled: true }
        }
      )
      return
    }

    // STEP 4: Max position
    if (session.step === 'maxPosition') {
      const amount = parseFloat(text)
      if (isNaN(amount) || amount < 10) {
        await ctx.reply('❌ Please enter a valid amount (minimum 10 USDT).')
        return
      }
      session.maxPosition = amount
      session.step = 'maxDailyLoss'
      await ctx.reply(
        `*Step 5 — Daily loss limit*\n\nMax position: *${amount} USDT* ✓\n\nWhat's the max your agent can lose in a single day before pausing? (USDT)\n\nReply with a number, e.g. \`50\``,
        { parse_mode: 'Markdown' }
      )
      return
    }

    // STEP 5: Max daily loss → confirm
    if (session.step === 'maxDailyLoss') {
      const amount = parseFloat(text)
      if (isNaN(amount) || amount < 5) {
        await ctx.reply('❌ Please enter a valid amount (minimum 5 USDT).')
        return
      }
      session.maxDailyLoss = amount
      session.step = 'confirm'

      const summary =
        `🤖 *Review your agent*\n\n` +
        `*Name:* ${session.name}\n` +
        `*Wallet:* \`${truncateAddress(session.walletAddress!)}\`\n` +
        `*Exchange:* ${session.exchange}\n` +
        `*Pairs:* ${session.pairs?.join(', ')}\n` +
        `*Max position:* ${session.maxPosition} USDT\n` +
        `*Max daily loss:* ${session.maxDailyLoss} USDT\n` +
        `*Leverage:* 5x | *SL:* 2% | *TP:* 4%\n\n` +
        `Ready to deploy?`

      const keyboard = new InlineKeyboard()
        .text('🚀 Deploy Agent', 'agent_create_confirm')
        .text('❌ Cancel', 'agent_create_cancel')

      await ctx.reply(summary, { parse_mode: 'Markdown', reply_markup: keyboard })
      return
    }

    return next()
  })

  // STEP 2: Exchange selection
  bot.callbackQuery(/^agent_exchange_(.+)$/, async (ctx) => {
    const exchange = ctx.match[1]
    const user = (ctx as any).dbUser
    if (!user) return ctx.answerCallbackQuery('Session expired')

    const session = sessions.get(user.id)
    if (!session) return ctx.answerCallbackQuery('Session expired. Use /newagent')

    session.exchange = exchange
    session.pairs = []
    session.step = 'pairs'
    await ctx.answerCallbackQuery()

    const keyboard = new InlineKeyboard()
      .text('BTC/USDT', 'agent_pair_BTC/USDT')
      .text('ETH/USDT', 'agent_pair_ETH/USDT')
      .row()
      .text('BNB/USDT', 'agent_pair_BNB/USDT')
      .text('SOL/USDT', 'agent_pair_SOL/USDT')
      .row()
      .text('✅ Done', 'agent_pairs_done')

    await ctx.reply(
      `*Step 3 — Choose trading pairs*\n\nExchange: *${exchange}* ✓\n\nTap pairs to add them. Tap *✅ Done* when finished.`,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    )
  })

  // STEP 3: Pair toggle
  bot.callbackQuery(/^agent_pair_(.+)$/, async (ctx) => {
    const pair = ctx.match[1]
    const user = (ctx as any).dbUser
    if (!user) return

    const session = sessions.get(user.id)
    if (!session) return ctx.answerCallbackQuery('Session expired')

    if (!session.pairs) session.pairs = []
    if (session.pairs.includes(pair)) {
      session.pairs = session.pairs.filter((p) => p !== pair)
      await ctx.answerCallbackQuery(`Removed ${pair}`)
    } else {
      session.pairs.push(pair)
      await ctx.answerCallbackQuery(`Added ${pair} ✓ (${session.pairs.length} selected)`)
    }
  })

  bot.callbackQuery('agent_pairs_done', async (ctx) => {
    const user = (ctx as any).dbUser
    if (!user) return

    const session = sessions.get(user.id)
    if (!session) return ctx.answerCallbackQuery('Session expired')

    if (!session.pairs || session.pairs.length === 0) {
      session.pairs = ['BTC/USDT']
    }

    session.step = 'maxPosition'
    await ctx.answerCallbackQuery()
    await ctx.reply(
      `*Step 4 — Max position size*\n\nPairs: *${session.pairs.join(', ')}* ✓\n\nWhat's the maximum size per trade? (USDT)\n\nReply with a number, e.g. \`100\``,
      { parse_mode: 'Markdown' }
    )
  })

  // FINAL: Save agent to DB
  bot.callbackQuery('agent_create_confirm', async (ctx) => {
    const user = (ctx as any).dbUser
    if (!user) return

    const session = sessions.get(user.id)
    if (!session || !session.name || !session.walletAddress) {
      return ctx.answerCallbackQuery('Session expired')
    }

    try {
      const agent = await db.agent.create({
        data: {
          userId: user.id,
          name: session.name,
          walletAddress: session.walletAddress,
          encryptedPK: session.encryptedPK,
          onchainTxHash: session.onchainTxHash ?? null,
          onchainChain: 'BSC',
          exchange: session.exchange ?? 'mock',
          pairs: session.pairs ?? ['BTC/USDT'],
          maxPositionSize: session.maxPosition ?? 100,
          maxDailyLoss: session.maxDailyLoss ?? 50,
          maxLeverage: 5,
          stopLossPct: 2,
          takeProfitPct: 4,
          isActive: true
        }
      })

      sessions.delete(user.id)
      await ctx.answerCallbackQuery('🚀 Deployed!')

      const onchainLine = agent.onchainTxHash
        ? `[View on-chain registration](${bscscanTxUrl(agent.onchainTxHash)})`
        : `_On-chain registration pending — will be confirmed shortly._`

      await ctx.reply(
        `🚀 *${agent.name} is LIVE!*\n\n` +
          `🔐 Agent wallet: \`${agent.walletAddress}\`\n` +
          `${onchainLine}\n\n` +
          `Your agent is now analyzing the market. First trade decision in ~60 seconds.\n\n` +
          `/myagents — manage agents\n` +
          `/tradestatus — monitor positions`,
        { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }
      )
    } catch (err: any) {
      console.error('[Agent] Create failed:', err)
      await ctx.answerCallbackQuery('Error')
      await ctx.reply(`❌ Failed to create agent: ${err.message}\n\nTry /newagent again.`)
    }
  })

  bot.callbackQuery('agent_create_cancel', async (ctx) => {
    const user = (ctx as any).dbUser
    if (user) sessions.delete(user.id)
    await ctx.answerCallbackQuery('Cancelled')
    await ctx.reply('Agent creation cancelled.')
  })

  // /myagents
  bot.command('myagents', async (ctx) => {
    const user = (ctx as any).dbUser
    if (!user) return

    const agents = await db.agent.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' }
    })

    if (agents.length === 0) {
      const keyboard = new InlineKeyboard().text('🤖 Create your first agent', 'create_agent')
      await ctx.reply('No agents yet. Create your first on-chain AI agent!', {
        reply_markup: keyboard
      })
      return
    }

    let text = `🤖 *Your On-Chain Agents*\n\n`
    agents.forEach((a) => {
      const status = a.isActive ? '🟢 Active' : a.isPaused ? '🔴 Paused' : '⚪ Inactive'
      const onchain = a.onchainTxHash ? '⛓ on-chain' : '🟡 pending'
      text += `*${a.name}* — ${status} | ${onchain}\n`
      if (a.walletAddress) {
        text += `Wallet: \`${truncateAddress(a.walletAddress)}\`\n`
      }
      text += `Exchange: ${a.exchange} | ${a.pairs.join(', ')}\n`
      text += `PnL: ${a.totalPnl >= 0 ? '+' : ''}$${a.totalPnl.toFixed(2)} | WR: ${a.winRate.toFixed(0)}% (${a.totalTrades} trades)\n\n`
    })

    const keyboard = new InlineKeyboard()
    agents.slice(0, 2).forEach((a) => {
      if (a.isActive) {
        keyboard.text(`⏸ Pause ${a.name}`, `pause_agent_${a.id}`).row()
      } else {
        keyboard.text(`▶️ Start ${a.name}`, `start_agent_${a.id}`).row()
      }
    })
    keyboard.text('➕ New Agent', 'create_agent')

    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard })
  })
}
