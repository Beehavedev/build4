import { Bot, Context, InlineKeyboard } from 'grammy'
import { ethers } from 'ethers'
import { db } from '../../db'
import { generateEVMWallet, encryptPrivateKey, decryptPrivateKey, truncateAddress } from '../../services/wallet'
import { verifyPin, checkPinFailLimit, logSecurityEvent } from '../../services/security'
import { buildAgentIdentity, buildMetadataJson } from '../../services/agentIdentity'
import {
  mintBap578Agent, getBnbBalance,
  bap578TokenUrl, nfaScanUrl, bscscanTxUrl, bscscanAddressUrl,
  TOTAL_USER_FEE_BNB
} from '../../services/bap578'

// User pays protocol fee + BUILD4 fee + a tiny gas buffer (two txs).
const TOTAL_NEEDED_WEI = ethers.parseEther(TOTAL_USER_FEE_BNB) + ethers.parseEther('0.001')

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? 'https://build4-1.onrender.com'

interface AgentSession {
  step: 'name' | 'pin'
  name?: string
}

const sessions = new Map<string, AgentSession>()

const NAME_REGEX = /^[a-zA-Z0-9_]{3,24}$/

async function startAgentCreation(ctx: Context) {
  const user = (ctx as any).dbUser
  if (!user) return

  sessions.set(user.id, { step: 'name' })

  await ctx.reply(
    `🤖 *Create Your On-Chain Agent*

You're about to mint a *fully registered BAP-578 Non-Fungible Agent* on BNB Smart Chain. Each agent comes with:

• A unique on-chain identity & dedicated BSC wallet — permanent, verifiable on NFAScan
• An ERC-8004 trust profile with declared learning model + Merkle-rooted strategy
• Autonomous trading on *all Aster DEX perp pairs* via EIP-712 signed orders
• Risk controls (position size, leverage, SL/TP, daily loss caps) you can tune anytime

💰 *One-time cost: ${TOTAL_USER_FEE_BNB} BNB* (charged from your main wallet at mint).

*Pick a name*
3-24 characters, letters/numbers/underscore only. Permanently reserved on-chain.

Examples: \`AlphaHunter\`, \`night_trader\`, \`BTCBull42\`

Reply with your agent's name 👇

(or /cancel to stop)`,
    { parse_mode: 'Markdown' }
  )
}

async function performMintAndCreate(opts: {
  ctx: Context
  user: any
  name: string
  userPK: string
  userAddress: string
}) {
  const { ctx, user, name, userPK, userAddress } = opts

  await ctx.reply(`⏳ Minting *${name}* on BAP-578…`, { parse_mode: 'Markdown' })

  const { address, privateKey } = generateEVMWallet()
  const encryptedPK = encryptPrivateKey(privateKey, user.id, undefined)

  const identity = buildAgentIdentity({
    name,
    agentAddress: address,
    ownerAddress: userAddress,
    publicBaseUrl: PUBLIC_BASE_URL
  })
  const metadataJson = JSON.stringify(buildMetadataJson(identity, null))
  const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(metadataJson))

  // Create the agent row first so we have an id to attach the tx hash to before
  // wait() returns — prevents double-charge on retry if the network hangs.
  const agent = await db.agent.create({
    data: {
      userId: user.id,
      name,
      walletAddress: address,
      encryptedPK,
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

  const mint = await mintBap578Agent({
    userWalletPK: userPK,
    agentName: name,
    agentAddress: address,
    metadataURI: identity.metadataUri,
    metadataHash,
    onTxSent: async (h) => {
      await db.agent.update({ where: { id: agent.id }, data: { bap578TxHash: h, onchainTxHash: h } })
    }
  })

  if (!mint.success || !mint.tokenId) {
    // Mint failed before any user funds were spent (or we have the tx hash already saved).
    // If no tx hash got saved, no money moved → safe to delete the row.
    const fresh = await db.agent.findUnique({ where: { id: agent.id } })
    if (!fresh?.bap578TxHash) {
      await db.agent.delete({ where: { id: agent.id } })
    }
    await ctx.reply(`❌ Mint failed: ${mint.reason ?? 'unknown error'}\n\nNo agent was created. Try /newagent again.`)
    return
  }

  await db.agent.update({
    where: { id: agent.id },
    data: {
      bap578TokenId: mint.tokenId,
      bap578TxHash: mint.txHash,
      onchainTxHash: mint.txHash,
      bap578Verified: true
    }
  })

  await ctx.reply(
    `🚀 *${name} is LIVE & verified!*

💎 *BAP-578 NFA #${mint.tokenId}*
🔐 On-chain identity: \`${address}\`

[View on NFAScan](${nfaScanUrl(address)})
[BSCScan token page](${bap578TokenUrl(mint.tokenId)})
[Mint transaction](${bscscanTxUrl(mint.txHash!)})

━━━━━━━━━━━━━━

Your agent now trades *all available perp pairs on Aster DEX* — finding the best opportunities across the market.

You can fine-tune position sizes, risk limits, and pairs anytime in the *mini-app*.

/myagents — manage agents
/tradestatus — monitor positions`,
    { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }
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

    // ── Step: name ────────────────────────────────────────────────
    if (session.step === 'name') {
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

      // Mandatory funding pre-check
      const wallets = await db.wallet.findMany({ where: { userId: user.id }, take: 1 })
      if (!wallets[0]?.encryptedPK) {
        sessions.delete(user.id)
        await ctx.reply('❌ No main wallet found. Run /start to initialize, then try again.')
        return
      }

      const balance = await getBnbBalance(wallets[0].address)
      if (balance < TOTAL_NEEDED_WEI) {
        sessions.delete(user.id)
        await ctx.reply(
          `❌ *Insufficient funds*\n\nMinting a verified BAP-578 agent costs *${TOTAL_USER_FEE_BNB} BNB*. Your main wallet currently holds ${ethers.formatEther(balance)} BNB.\n\n*Fund this wallet with BNB on BSC:*\n\`${wallets[0].address}\`\n\nThen run /newagent again.`,
          { parse_mode: 'Markdown' }
        )
        return
      }

      // PIN-protected → ask for PIN before we can sign
      if (user.pinHash) {
        sessions.set(user.id, { step: 'pin', name })
        await ctx.reply(
          `🔒 *Enter your PIN* to authorize the *${TOTAL_USER_FEE_BNB} BNB* mint payment.\n\n_Your reply will be deleted from chat for security._\n\n(or /cancelagent to stop)`,
          { parse_mode: 'Markdown' }
        )
        return
      }

      // No PIN → mint immediately
      sessions.delete(user.id)
      try {
        const userPK = decryptPrivateKey(wallets[0].encryptedPK, user.id)
        await performMintAndCreate({ ctx, user, name, userPK, userAddress: wallets[0].address })
      } catch (err: any) {
        console.error('[Agent] Create failed:', err)
        await ctx.reply(`❌ Failed to create agent: ${err.message}\n\nTry /newagent again.`)
      }
      return
    }

    // ── Step: pin ─────────────────────────────────────────────────
    if (session.step === 'pin' && session.name) {
      // Delete the user's PIN message immediately
      try { await ctx.deleteMessage() } catch {}

      const lock = await checkPinFailLimit(user.id)
      if (!lock.allowed) {
        sessions.delete(user.id)
        await ctx.reply('🚫 Too many PIN attempts. Try again in an hour.')
        return
      }

      if (!user.pinHash || !user.pinSalt || !verifyPin(text, user.pinHash, user.pinSalt)) {
        await logSecurityEvent({ userId: user.id, telegramId: ctx.from!.id, action: 'pin_failed', meta: { context: 'agent_mint' } })
        await ctx.reply('❌ Wrong PIN. Try again, or /cancelagent to stop.')
        return
      }

      const wallets = await db.wallet.findMany({ where: { userId: user.id }, take: 1 })
      if (!wallets[0]?.encryptedPK) {
        sessions.delete(user.id)
        await ctx.reply('❌ Wallet missing. Run /start.')
        return
      }

      const name = session.name
      sessions.delete(user.id)

      try {
        const userPK = decryptPrivateKey(wallets[0].encryptedPK, user.id, text)
        await performMintAndCreate({ ctx, user, name, userPK, userAddress: wallets[0].address })
      } catch (err: any) {
        console.error('[Agent] PIN mint failed:', err)
        await ctx.reply(`❌ Failed to create agent: ${err.message}\n\nTry /newagent again.`)
      }
      return
    }

    return next()
  })

  const showMyAgents = async (ctx: any) => {
    const user = ctx.dbUser
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
      if (a.bap578Verified && a.bap578TokenId) {
        text += `💎 *BAP-578 NFA:* #${a.bap578TokenId} ✓\n`
        text += `🌐 [View on NFAScan](${nfaScanUrl(a.walletAddress!)})\n`
        if (a.bap578TxHash) {
          text += `📜 [Mint tx](${bscscanTxUrl(a.bap578TxHash)})\n`
        }
      } else if (a.bap578TxHash) {
        text += `🟡 *BAP-578 mint:* awaiting confirmation\n`
        text += `📜 [Check tx](${bscscanTxUrl(a.bap578TxHash)})\n`
      } else {
        text += `⚠️ *Legacy agent* (pre-verification rollout)\n`
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
  }

  bot.command('myagents', showMyAgents)
  bot.callbackQuery('my_agents', async (ctx) => {
    await ctx.answerCallbackQuery()
    await showMyAgents(ctx)
  })

  /* legacy /verifyagent removed — verification is mandatory at /newagent
  bot.command('verifyagent', async (ctx) => {
    const user = (ctx as any).dbUser
    if (!user) return

    const arg = (ctx.match as string | undefined)?.trim()
    if (!arg) {
      await ctx.reply(
        `Usage: \`/verifyagent <agent_name>\`\n\nMints the official BAP-578 NFA NFT for the agent. Total cost: *${TOTAL_USER_FEE_BNB} BNB* (${PROTOCOL_FEE_BNB} BNB protocol fee + ${BUILD4_FEE_BNB} BNB BUILD4 service fee).`,
        { parse_mode: 'Markdown' }
      )
      return
    }

    if (user.pinHash) {
      await ctx.reply('🔒 PIN-protected wallets need to use the export flow (PIN gating for /verifyagent is coming soon). For now, temporarily remove PIN with /removepin, run /verifyagent, then re-set with /setpin.')
      return
    }

    const agent = await db.agent.findFirst({
      where: { userId: user.id, name: { equals: arg, mode: 'insensitive' } }
    })
    if (!agent || !agent.walletAddress) {
      await ctx.reply(`❌ No agent named *${arg}* found. Run /myagents to list yours.`, { parse_mode: 'Markdown' })
      return
    }
    if (agent.bap578Verified && agent.bap578TokenId) {
      await ctx.reply(`✅ *${agent.name}* is already BAP-578 verified.\n\nNFA #${agent.bap578TokenId}\n[View on NFAScan](${nfaScanUrl(agent.walletAddress)})`, {
        parse_mode: 'Markdown', link_preview_options: { is_disabled: true }
      })
      return
    }
    // If a previous mint tx was broadcast but never confirmed in our DB, refuse to re-pay.
    if (agent.bap578TxHash) {
      await ctx.reply(
        `🟡 A BAP-578 mint transaction was already broadcast for *${agent.name}* but its confirmation isn't recorded.\n\n[Check on BSCScan](${bscscanTxUrl(agent.bap578TxHash)})\n\nIf it succeeded, contact support to record the token id rather than minting (and paying) again.`,
        { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }
      )
      return
    }

    const wallets = await db.wallet.findMany({ where: { userId: user.id }, take: 1 })
    if (!wallets[0]?.encryptedPK) {
      await ctx.reply('❌ No main wallet found. Run /start to initialize.')
      return
    }

    const balance = await getBnbBalance(wallets[0].address)
    if (balance < TOTAL_NEEDED_WEI) {
      await ctx.reply(
        `❌ *Insufficient BNB*\n\nYou need at least *${TOTAL_USER_FEE_BNB} BNB* in your main wallet:\n\`${wallets[0].address}\`\n\nCurrent balance: ${ethers.formatEther(balance)} BNB\n\n_Cost: ${PROTOCOL_FEE_BNB} BNB (BAP-578 protocol) + ${BUILD4_FEE_BNB} BNB (BUILD4 service fee)._`,
        { parse_mode: 'Markdown' }
      )
      return
    }

    await ctx.reply(`⏳ Minting BAP-578 NFA for *${agent.name}*…\n\nPaying ${PROTOCOL_FEE_BNB} BNB to the BAP-578 contract + ${BUILD4_FEE_BNB} BNB BUILD4 service fee.`, { parse_mode: 'Markdown' })

    try {
      const userPK = decryptPrivateKey(wallets[0].encryptedPK, user.id)
      const identity = buildAgentIdentity({
        name: agent.name,
        agentAddress: agent.walletAddress,
        ownerAddress: wallets[0].address,
        publicBaseUrl: PUBLIC_BASE_URL,
        model: agent.learningModel ?? DEFAULT_LEARNING_MODEL
      })
      const metadataJson = JSON.stringify(buildMetadataJson(identity, agent.onchainTxHash))
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(metadataJson))

      const mint = await mintBap578Agent({
        userWalletPK: userPK,
        agentName: agent.name,
        agentAddress: agent.walletAddress,
        metadataURI: identity.metadataUri,
        metadataHash
      })

      if (!mint.success || !mint.tokenId) {
        await ctx.reply(`❌ Mint failed: ${mint.reason ?? 'unknown error'}`)
        return
      }

      await db.agent.update({
        where: { id: agent.id },
        data: { bap578TokenId: mint.tokenId, bap578TxHash: mint.txHash, bap578Verified: true }
      })

      await ctx.reply(
        `🎉 *${agent.name} is now BAP-578 verified!*\n\n💎 NFA #${mint.tokenId}\n[View on NFAScan](${nfaScanUrl(agent.walletAddress)})\n[BSCScan token page](${bap578TokenUrl(mint.tokenId)})\n[Mint transaction](${bscscanTxUrl(mint.txHash!)})`,
        { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }
      )
    } catch (e: any) {
      console.error('[verifyagent] error:', e)
      await ctx.reply(`❌ Mint failed: ${e.message}`)
    }
  })
  */
}
