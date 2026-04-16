import { Bot, Context, InlineKeyboard } from 'grammy'
import { db } from '../../db'
import { generateEVMWallet, encryptPrivateKey, truncateAddress } from '../../services/wallet'
import { registerAgentOnChain, bscscanTxUrl, bscscanAddressUrl } from '../../services/registry'
import { buildAgentIdentity, DEFAULT_LEARNING_MODEL } from '../../services/agentIdentity'

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? 'https://build4-1.onrender.com'

interface AgentSession {
  step: 'name' | 'done'
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

*Pick a name*

3-24 characters, letters/numbers/underscore only. *Permanently registered on-chain* and cannot be reused by anyone else.

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

  bot.callbackQuery('create_agent', async (ctx) => {
    await ctx.answerCallbackQuery()
    await startAgentCreation(ctx)
  })

  bot.command('cancelagent', async (ctx) => {
    const user = (ctx as any).dbUser
    if (user) sessions.delete(user.id)
    await ctx.reply('Agent creation cancelled.')
  })

  bot.on('message:text', async (ctx, next) => {
    const user = (ctx as any).dbUser
    if (!user) return next()

    const session = sessions.get(user.id)
    if (!session) return next()

    const text = ctx.message.text.trim()
    if (text.startsWith('/')) return next()

    if (session.step !== 'name') return next()

    const name = text

    if (!NAME_REGEX.test(name)) {
      await ctx.reply('❌ Invalid name. Use 3-24 letters/numbers/underscore only.\n\nTry again:')
      return
    }

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

    const { address, privateKey } = generateEVMWallet()
    const encryptedPK = encryptPrivateKey(privateKey, user.id)

    const wallets = await db.wallet.findMany({ where: { userId: user.id }, take: 1 })
    const ownerAddress = wallets[0]?.address ?? '0x0000000000000000000000000000000000000000'

    // Build full ERC-8004 identity (model, learning Merkle root, metadata URI…)
    const identity = buildAgentIdentity({
      name,
      agentAddress: address,
      ownerAddress,
      publicBaseUrl: PUBLIC_BASE_URL
    })

    const result = await registerAgentOnChain(identity)

    try {
      const agent = await db.agent.create({
        data: {
          userId: user.id,
          name,
          walletAddress: address,
          encryptedPK,
          onchainTxHash: result.txHash ?? null,
          onchainChain: 'BSC',
          learningModel: identity.model,
          learningRoot: identity.learningRoot,
          metadataUri: identity.metadataUri,
          identityStandard: identity.standard,
          exchange: 'aster',
          pairs: ['ALL'],
          maxPositionSize: 100,
          maxDailyLoss: 50,
          maxLeverage: 5,
          stopLossPct: 2,
          takeProfitPct: 4,
          isActive: true
        }
      })

      sessions.delete(user.id)

      const onchainStatus = result.success
        ? `✅ *Registered on-chain*\n[View transaction](${bscscanTxUrl(result.txHash!)})`
        : `🟡 *On-chain registration pending*\n_${result.reason}_`

      await ctx.reply(
        `🚀 *${agent.name} is LIVE!*

🔐 *On-chain identity*
\`${address}\`
[View on BSCScan](${bscscanAddressUrl(address)})

${onchainStatus}

━━━━━━━━━━━━━━

Your agent now trades *all available perp pairs on Aster DEX* — finding the best opportunities across the market.

You can fine-tune position sizes, risk limits, and pairs anytime in the *mini-app*.

/myagents — manage agents
/tradestatus — monitor positions`,
        { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }
      )
    } catch (err: any) {
      console.error('[Agent] Create failed:', err)
      sessions.delete(user.id)
      await ctx.reply(`❌ Failed to create agent: ${err.message}\n\nTry /newagent again.`)
    }
  })

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

    let text = `🤖 *Your On-Chain Agents*\n\n_Every agent below has a unique identity permanently registered on BNB Smart Chain._\n\n`
    agents.forEach((a) => {
      const status = a.isActive ? '🟢 Active' : a.isPaused ? '🔴 Paused' : '⚪ Inactive'
      text += `━━━━━━━━━━━━━━\n*${a.name}* — ${status}\n`

      if (a.walletAddress) {
        text += `🔐 *On-chain ID:* \`${a.walletAddress}\`\n`
        text += `🔎 [View agent on BSCScan](${bscscanAddressUrl(a.walletAddress)})\n`
      }
      if (a.onchainTxHash) {
        text += `⛓ *Registration:* \`${truncateAddress(a.onchainTxHash)}\`\n`
        text += `📜 [View registration tx](${bscscanTxUrl(a.onchainTxHash)})\n`
      } else {
        text += `🟡 *Registration:* pending broadcast\n`
      }
      // ERC-8004 trust signals (visible to scanners like NFAScan)
      if (a.identityStandard) {
        text += `🏛 *Standard:* ${a.identityStandard} ✓\n`
      }
      if (a.learningModel) {
        text += `🧠 *Model:* ${a.learningModel}\n`
      }
      if (a.learningRoot) {
        text += `🌲 *Learning root:* \`${a.learningRoot.slice(0, 10)}...${a.learningRoot.slice(-6)}\` (Merkle ✓)\n`
      }
      if (a.metadataUri) {
        text += `📄 [Public metadata JSON](${a.metadataUri})\n`
      }
      text += `📊 PnL: ${a.totalPnl >= 0 ? '+' : ''}$${a.totalPnl.toFixed(2)} | WR: ${a.winRate.toFixed(0)}% (${a.totalTrades} trades)\n\n`
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
