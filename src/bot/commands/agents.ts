import { Bot, Context, InlineKeyboard } from 'grammy'
import { ethers } from 'ethers'
import { db } from '../../db'
import { generateEVMWallet, encryptPrivateKey, decryptPrivateKey, truncateAddress } from '../../services/wallet'
import { verifyPin, checkPinFailLimit, logSecurityEvent } from '../../services/security'
import { buildAgentIdentity, buildMetadataJson } from '../../services/agentIdentity'
import {
  mintBap578Agent, getBnbBalance,
  bap578TokenUrl, nfaScanUrl, bscscanTxUrl, bscscanAddressUrl,
  TOTAL_USER_FEE_BNB, BAP578_CONTRACT, recoverBap578TokenId
} from '../../services/bap578'
import { registerAgentOnchain, erc8004ScanUrl, erc8004RegistryScanUrl, recoverErc8004AgentId } from '../../services/erc8004'

const BSC_RPC = process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org'
const BAP578_EVENT_ABI = [
  'event AgentCreated(uint256 indexed tokenId, address indexed owner, address logicAddress, string metadataURI)'
]

async function recoverBap578TokenIdFromTx(txHash: string): Promise<string | null> {
  try {
    const provider = new ethers.JsonRpcProvider(BSC_RPC)
    const receipt = await provider.getTransactionReceipt(txHash)
    if (!receipt || receipt.status !== 1) return null
    const iface = new ethers.Interface(BAP578_EVENT_ABI)
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== BAP578_CONTRACT.toLowerCase()) continue
      try {
        const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data })
        if (parsed?.name === 'AgentCreated') return parsed.args.tokenId.toString()
      } catch {}
    }
    return null
  } catch (e: any) {
    console.error('[BAP578] recoverTokenIdFromTx failed:', e.message)
    return null
  }
}

// Optional BAP-578 NFA mint upgrade needs full fee + gas buffer.
const BAP578_NEEDED_WEI = ethers.parseEther(TOTAL_USER_FEE_BNB) + ethers.parseEther('0.001')

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? 'https://build4-1.onrender.com'

interface AgentSession {
  step: 'name' | 'pin' | 'upgrade_pin'
  name?: string
  upgradeAgentId?: string
}

const sessions = new Map<string, AgentSession>()

const NAME_REGEX = /^[a-zA-Z0-9_]{3,24}$/

async function startAgentCreation(ctx: Context) {
  const user = (ctx as any).dbUser
  if (!user) return

  sessions.set(user.id, { step: 'name' })

  await ctx.reply(
    `🤖 *Create Your On-Chain Agent*

Every BUILD4 agent is *permanently registered on the official ERC-8004 Identity Registry* on BNB Smart Chain. You get:

• A unique on-chain agent ID — verifiable on BSCScan & agent registries
• A dedicated BSC wallet (the agent's own signer)
• ERC-8004 trust profile with declared learning model + Merkle-rooted strategy
• Autonomous trading on *all Aster DEX perp pairs* via EIP-712 signed orders
• Risk controls (position size, leverage, SL/TP, daily loss caps) tunable anytime

🆓 *Registration is free* — BUILD4 covers the on-chain gas for you.

You can *optionally* upgrade to a *BAP-578 Non-Fungible Agent NFT* (verifiable on NFAScan) afterwards for ${TOTAL_USER_FEE_BNB} BNB.

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
  userAddress: string
}) {
  const { ctx, user, name, userAddress } = opts

  await ctx.reply(`⏳ Registering *${name}* on ERC-8004 IdentityRegistry…`, { parse_mode: 'Markdown' })

  const { address, privateKey } = generateEVMWallet()
  const encryptedPK = encryptPrivateKey(privateKey, user.id, undefined)

  const identity = buildAgentIdentity({
    name,
    agentAddress: address,
    ownerAddress: userAddress,
    publicBaseUrl: PUBLIC_BASE_URL
  })

  // Create the agent row first so we have an id to attach tx hashes to.
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

  const reg = await registerAgentOnchain({
    agentWalletPK: privateKey,
    agentAddress: address,
    metadataURI: identity.metadataUri,
    onAgentFunded: async (h) => {
      await db.agent.update({ where: { id: agent.id }, data: { erc8004FundTxHash: h } })
    },
    onRegisterTxSent: async (h) => {
      await db.agent.update({ where: { id: agent.id }, data: { erc8004TxHash: h, onchainTxHash: h } })
    }
  })

  if (!reg.success || !reg.agentId) {
    // If no funding tx went out, nothing was spent → safe to delete the row.
    const fresh = await db.agent.findUnique({ where: { id: agent.id } })
    if (!fresh?.erc8004FundTxHash) {
      await db.agent.delete({ where: { id: agent.id } })
      await ctx.reply(`❌ Registration failed: ${reg.reason ?? 'unknown error'}\n\nNo agent was created. Try /newagent again.`)
    } else {
      await ctx.reply(`⚠️ Registration partially failed: ${reg.reason ?? 'unknown error'}\n\nThe agent's wallet was funded but the on-chain register call failed. Run /myagents to retry.`)
    }
    return
  }

  await db.agent.update({
    where: { id: agent.id },
    data: {
      erc8004AgentId: reg.agentId,
      erc8004TxHash: reg.txHash,
      onchainTxHash: reg.txHash,
      erc8004Verified: true
    }
  })

  const upgradeKb = new InlineKeyboard()
    .text(`💎 Upgrade to BAP-578 NFA (${TOTAL_USER_FEE_BNB} BNB)`, `upgrade_bap578_${agent.id}`)

  await ctx.reply(
    `🚀 *${name} is LIVE & on-chain!*

🆔 *ERC-8004 Agent ID:* #${reg.agentId}
🔐 On-chain identity: \`${address}\`

[View agent NFT on BSCScan](${erc8004ScanUrl(reg.agentId)})
[Registration tx](${bscscanTxUrl(reg.txHash!)})

━━━━━━━━━━━━━━

Your agent trades *all perp pairs on Aster DEX* — finding the best opportunities across the market. Tune position sizes, risk limits, and pairs anytime in the *mini-app*.

*Optional upgrade:* mint a BAP-578 Non-Fungible Agent NFT (verifiable on NFAScan) for ${TOTAL_USER_FEE_BNB} BNB.

/myagents — manage agents
/tradestatus — monitor positions`,
    { parse_mode: 'Markdown', link_preview_options: { is_disabled: true }, reply_markup: upgradeKb }
  )
}

async function performBap578Upgrade(opts: {
  ctx: Context
  user: any
  agentId: string
  userPK: string
}) {
  const { ctx, user, agentId, userPK } = opts
  const agent = await db.agent.findUnique({ where: { id: agentId } })
  if (!agent || agent.userId !== user.id) {
    await ctx.reply('❌ Agent not found.')
    return
  }
  if (agent.bap578Verified && agent.bap578TokenId) {
    await ctx.reply(
      `✅ *${agent.name}* is already a BAP-578 NFA (#${agent.bap578TokenId}).\n\n[View on NFAScan](${nfaScanUrl(agent.walletAddress!)})`,
      { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }
    )
    return
  }
  if (!agent.walletAddress) {
    await ctx.reply('❌ Agent has no on-chain wallet — cannot mint NFA.')
    return
  }
  // Self-heal: if a mint tx was already broadcast (e.g. previous DB write
  // failed after the on-chain tx confirmed), recover the tokenId from chain
  // instead of charging the user a second time.
  if (agent.bap578TxHash) {
    const recovered = await recoverBap578TokenIdFromTx(agent.bap578TxHash)
    if (recovered) {
      await db.agent.update({
        where: { id: agent.id },
        data: { bap578TokenId: recovered, bap578Verified: true }
      })
      await ctx.reply(
        `🎉 *${agent.name} is already a BAP-578 NFA!*\n\nWe recovered your previous mint from chain — no extra fee charged.\n\n💎 NFA #${recovered}\n[View on NFAScan](${nfaScanUrl(agent.walletAddress)})\n[Mint tx](${bscscanTxUrl(agent.bap578TxHash)})`,
        { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }
      )
      return
    }
    await ctx.reply(
      `🟡 A BAP-578 mint tx was already broadcast for *${agent.name}* but isn't confirmed yet.\n\n[Check tx](${bscscanTxUrl(agent.bap578TxHash)})\n\nTry again in a minute.`,
      { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }
    )
    return
  }

  await ctx.reply(`⏳ Minting BAP-578 NFA for *${agent.name}*…`, { parse_mode: 'Markdown' })

  const identity = buildAgentIdentity({
    name: agent.name,
    agentAddress: agent.walletAddress,
    ownerAddress: '',
    publicBaseUrl: PUBLIC_BASE_URL,
    model: agent.learningModel ?? undefined
  })
  const metadataJson = JSON.stringify(buildMetadataJson(identity, agent.onchainTxHash))
  const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(metadataJson))

  const mint = await mintBap578Agent({
    userWalletPK: userPK,
    agentName: agent.name,
    agentAddress: agent.walletAddress,
    metadataURI: agent.metadataUri ?? identity.metadataUri,
    metadataHash,
    onTxSent: async (h) => {
      await db.agent.update({ where: { id: agent.id }, data: { bap578TxHash: h } })
    }
  })

  if (!mint.success || !mint.tokenId) {
    await ctx.reply(`❌ NFA mint failed: ${mint.reason ?? 'unknown error'}\n\nYour agent is still live — just not minted as an NFA yet.`)
    return
  }

  await db.agent.update({
    where: { id: agent.id },
    data: { bap578TokenId: mint.tokenId, bap578TxHash: mint.txHash, bap578Verified: true }
  })

  await ctx.reply(
    `🎉 *${agent.name} is now a BAP-578 NFA!*

💎 NFA #${mint.tokenId}
[View on NFAScan](${nfaScanUrl(agent.walletAddress)})
[BSCScan token](${bap578TokenUrl(mint.tokenId)})
[Mint tx](${bscscanTxUrl(mint.txHash!)})`,
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

      // Lightweight pre-check: user just needs an owner wallet on file.
      const wallets = await db.wallet.findMany({ where: { userId: user.id }, take: 1 })
      if (!wallets[0]) {
        sessions.delete(user.id)
        await ctx.reply('❌ No main wallet found. Run /start to initialize, then try again.')
        return
      }

      // ERC-8004 register is sponsored by BUILD4's registry wallet — user
      // pays nothing, signs nothing, no PIN needed.
      sessions.delete(user.id)
      try {
        await performMintAndCreate({ ctx, user, name, userAddress: wallets[0].address })
      } catch (err: any) {
        console.error('[Agent] Create failed:', err)
        await ctx.reply(`❌ Failed to create agent: ${err.message}\n\nTry /newagent again.`)
      }
      return
    }

    // ── Step: pin ─────────────────────────────────────────────────
    // (legacy — ERC-8004 register no longer requires user payment, so this
    // step is unreachable. Kept as a safety fallback in case an old session
    // is still hanging around.)
    if (session.step === 'pin' && session.name) {
      try { await ctx.deleteMessage() } catch {}
      const wallets = await db.wallet.findMany({ where: { userId: user.id }, take: 1 })
      const name = session.name
      sessions.delete(user.id)
      try {
        await performMintAndCreate({ ctx, user, name, userAddress: wallets[0]?.address ?? '' })
      } catch (err: any) {
        console.error('[Agent] mint failed:', err)
        await ctx.reply(`❌ Failed to create agent: ${err.message}\n\nTry /newagent again.`)
      }
      return
    }

    // ── Step: upgrade_pin (BAP-578 NFA upgrade) ───────────────────
    if (session.step === 'upgrade_pin' && session.upgradeAgentId) {
      try { await ctx.deleteMessage() } catch {}

      const lock = await checkPinFailLimit(user.id)
      if (!lock.allowed) {
        sessions.delete(user.id)
        await ctx.reply('🚫 Too many PIN attempts. Try again in an hour.')
        return
      }
      if (!user.pinHash || !user.pinSalt || !verifyPin(text, user.pinHash, user.pinSalt)) {
        await logSecurityEvent({ userId: user.id, telegramId: ctx.from!.id, action: 'pin_failed', meta: { context: 'bap578_upgrade' } })
        await ctx.reply('❌ Wrong PIN. Try again, or /cancelagent to stop.')
        return
      }

      const wallets = await db.wallet.findMany({ where: { userId: user.id }, take: 1 })
      if (!wallets[0]?.encryptedPK) {
        sessions.delete(user.id)
        await ctx.reply('❌ Wallet missing. Run /start.')
        return
      }

      const upgradeId = session.upgradeAgentId
      sessions.delete(user.id)

      try {
        const userPK = decryptPrivateKey(wallets[0].encryptedPK, user.id, text)
        await performBap578Upgrade({ ctx, user, agentId: upgradeId, userPK })
      } catch (err: any) {
        console.error('[Agent] PIN upgrade failed:', err)
        await ctx.reply(`❌ Upgrade failed: ${err.message}`)
      }
      return
    }

    return next()
  })

  const showMyAgents = async (ctx: any) => {
    const user = ctx.dbUser
    if (!user) return

    let agents = await db.agent.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' }
    })

    // Self-heal: backfill missing on-chain identifiers from BSC. Runs in
    // parallel and only touches agents that look unsynced. Failures are
    // swallowed so a flaky RPC never breaks the menu.
    const ownerWallet = (await db.wallet.findFirst({ where: { userId: user.id } }))?.address
    await Promise.all(agents.map(async (a) => {
      if (!a.walletAddress) return
      try {
        if (!a.erc8004AgentId) {
          const recovered = await recoverErc8004AgentId({ agentAddress: a.walletAddress, txHash: a.erc8004TxHash })
          if (recovered) {
            await db.agent.update({
              where: { id: a.id },
              data: { erc8004AgentId: recovered, erc8004Verified: true }
            })
            ;(a as any).erc8004AgentId = recovered
            ;(a as any).erc8004Verified = true
          }
        }
        if (!a.bap578TokenId && ownerWallet) {
          const tokenId = await recoverBap578TokenId({
            ownerAddress: ownerWallet,
            agentAddress: a.walletAddress,
            txHash: a.bap578TxHash
          })
          if (tokenId) {
            await db.agent.update({
              where: { id: a.id },
              data: { bap578TokenId: tokenId, bap578Verified: true }
            })
            ;(a as any).bap578TokenId = tokenId
            ;(a as any).bap578Verified = true
          }
        }
      } catch (e: any) {
        console.error('[Agent] sync failed for', a.name, e.message)
      }
    }))

    if (agents.length === 0) {
      const keyboard = new InlineKeyboard().text('🤖 Create your first agent', 'create_agent')
      await ctx.reply('No agents yet. Create your first on-chain AI agent!', {
        reply_markup: keyboard
      })
      return
    }

    let text = `🤖 *Your On-Chain Agents*\n\n_Every agent below is registered on the ERC-8004 IdentityRegistry on BNB Smart Chain._\n\n`
    agents.forEach((a) => {
      const status = a.isActive ? '🟢 Active' : a.isPaused ? '🔴 Paused' : '⚪ Inactive'
      text += `━━━━━━━━━━━━━━\n*${a.name}* — ${status}\n`

      if (a.erc8004Verified && a.erc8004AgentId) {
        text += `🆔 *ERC-8004 Agent ID:* #${a.erc8004AgentId} ✓\n`
        text += `🔎 [View on BSCScan](${erc8004ScanUrl(a.erc8004AgentId)})\n`
      } else if (a.erc8004TxHash) {
        text += `🟡 *ERC-8004 register:* awaiting confirmation\n`
        text += `📜 [Check tx](${bscscanTxUrl(a.erc8004TxHash)})\n`
      }
      if (a.walletAddress) {
        text += `🔐 *Agent wallet:* \`${a.walletAddress}\`\n`
        text += `🔎 [Wallet on BSCScan](${bscscanAddressUrl(a.walletAddress)})\n`
      }
      if (a.bap578Verified && a.bap578TokenId) {
        text += `💎 *BAP-578 NFA:* #${a.bap578TokenId} ✓\n`
        text += `🌐 [View on NFAScan](${nfaScanUrl(a.walletAddress!)})\n`
      } else if (a.bap578TxHash) {
        text += `🟡 *BAP-578 mint:* awaiting confirmation\n`
        text += `📜 [Check tx](${bscscanTxUrl(a.bap578TxHash)})\n`
      }
      if (a.learningModel) {
        text += `🧠 *Model:* ${a.learningModel}\n`
      }
      if (a.erc8004AgentId) {
        text += `📊 [More on 8004scan](${erc8004RegistryScanUrl(a.erc8004AgentId)})\n`
      }
      text += `📊 PnL: ${a.totalPnl >= 0 ? '+' : ''}$${a.totalPnl.toFixed(2)} | WR: ${a.winRate.toFixed(0)}% (${a.totalTrades} trades)\n\n`
    })

    const keyboard = new InlineKeyboard()
    agents.forEach((a) => {
      if (a.isActive) {
        keyboard.text(`⏸ Pause ${a.name}`, `pause_agent_${a.id}`).row()
      } else {
        keyboard.text(`▶️ Start ${a.name}`, `start_agent_${a.id}`).row()
      }
      if (!a.bap578Verified) {
        // Allow re-attempt even if a tx was broadcast — the upgrade handler is
        // self-healing and will recover the tokenId from the existing receipt.
        keyboard.text(`💎 Upgrade ${a.name} → NFA`, `upgrade_bap578_${a.id}`).row()
      }
      keyboard.text(`🗑 Remove ${a.name}`, `remove_agent_confirm_${a.id}`).row()
    })
    keyboard.text('➕ New Agent', 'create_agent')

    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard })
  }

  bot.command('myagents', showMyAgents)
  bot.callbackQuery('my_agents', async (ctx) => {
    await ctx.answerCallbackQuery()
    await showMyAgents(ctx)
  })

  bot.callbackQuery(/^upgrade_bap578_(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    const user = (ctx as any).dbUser
    if (!user) return
    const agentId = ctx.match![1]

    const agent = await db.agent.findUnique({ where: { id: agentId } })
    if (!agent || agent.userId !== user.id) {
      await ctx.reply('❌ Agent not found.')
      return
    }
    if (agent.bap578Verified || agent.bap578TxHash) {
      await ctx.reply('ℹ️ This agent already has a BAP-578 mint in progress or completed. Run /myagents to check.')
      return
    }

    const wallets = await db.wallet.findMany({ where: { userId: user.id }, take: 1 })
    if (!wallets[0]?.encryptedPK) {
      await ctx.reply('❌ No main wallet found. Run /start to initialize, then try again.')
      return
    }
    const balance = await getBnbBalance(wallets[0].address)
    if (balance < BAP578_NEEDED_WEI) {
      await ctx.reply(
        `❌ *Insufficient BNB*\n\nA BAP-578 NFA upgrade costs *${TOTAL_USER_FEE_BNB} BNB*. Your main wallet currently holds ${ethers.formatEther(balance)} BNB.\n\nFund: \`${wallets[0].address}\``,
        { parse_mode: 'Markdown' }
      )
      return
    }

    if (user.pinHash) {
      sessions.set(user.id, { step: 'upgrade_pin', upgradeAgentId: agent.id } as any)
      await ctx.reply(
        `🔒 *Enter your PIN* to authorize the *${TOTAL_USER_FEE_BNB} BNB* NFA mint for *${agent.name}*.\n\n_Your reply will be deleted from chat for security._\n\n(or /cancelagent to stop)`,
        { parse_mode: 'Markdown' }
      )
      return
    }

    try {
      const userPK = decryptPrivateKey(wallets[0].encryptedPK, user.id)
      await performBap578Upgrade({ ctx, user, agentId: agent.id, userPK })
    } catch (err: any) {
      console.error('[Agent] Upgrade failed:', err)
      await ctx.reply(`❌ Upgrade failed: ${err.message}`)
    }
  })

  // Remove agent — confirmation step
  bot.callbackQuery(/^remove_agent_confirm_(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    const user = (ctx as any).dbUser
    if (!user) return
    const agentId = ctx.match![1]
    const agent = await db.agent.findUnique({ where: { id: agentId } })
    if (!agent || agent.userId !== user.id) {
      await ctx.reply('❌ Agent not found.')
      return
    }
    const kb = new InlineKeyboard()
      .text(`✅ Yes, remove ${agent.name}`, `remove_agent_do_${agent.id}`)
      .row()
      .text('↩️ Cancel', 'my_agents')
    await ctx.reply(
      `⚠️ *Remove ${agent.name}?*\n\nThis stops the agent and deletes its memory and logs from BUILD4. Its on-chain ERC-8004 identity${agent.bap578Verified ? ' and BAP-578 NFA' : ''} stay on BSC forever — only the BUILD4 record is removed.\n\nTrade history is kept (anonymised) so your portfolio stats stay accurate.`,
      { parse_mode: 'Markdown', reply_markup: kb }
    )
  })

  // Remove agent — execute
  bot.callbackQuery(/^remove_agent_do_(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    const user = (ctx as any).dbUser
    if (!user) return
    const agentId = ctx.match![1]
    const agent = await db.agent.findUnique({ where: { id: agentId } })
    if (!agent || agent.userId !== user.id) {
      await ctx.reply('❌ Agent not found.')
      return
    }
    try {
      await db.$transaction([
        db.agentMemory.deleteMany({ where: { agentId } }),
        db.agentLog.deleteMany({ where: { agentId } }),
        db.trade.updateMany({ where: { agentId }, data: { agentId: null } }),
        db.agent.delete({ where: { id: agentId } })
      ])
      await ctx.reply(`🗑 *${agent.name}* removed.`, { parse_mode: 'Markdown' })
    } catch (err: any) {
      console.error('[Agent] Remove failed:', err)
      await ctx.reply(`❌ Could not remove agent: ${err.message}`)
    }
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
