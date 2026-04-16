import { Bot, Context, InlineKeyboard } from 'grammy'
import { ethers } from 'ethers'
import { db } from '../../db'
import { generateEVMWallet, encryptPrivateKey, decryptPrivateKey, truncateAddress } from '../../services/wallet'
import { registerAgentOnChain, bscscanTxUrl, bscscanAddressUrl } from '../../services/registry'
import { buildAgentIdentity, buildMetadataJson, DEFAULT_LEARNING_MODEL } from '../../services/agentIdentity'
import { mintBap578Agent, getBnbBalance, getBap578MintFee, bap578TokenUrl, nfaScanUrl, MINT_FEE_BNB } from '../../services/bap578'

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

      // Try BAP-578 NFA mint automatically when the user has BNB and no PIN.
      // PIN-protected users must call /verifyagent so we can prompt for the PIN.
      let bap578Status = ''
      if (!user.pinHash && wallets[0] && result.success) {
        try {
          const userBalance = await getBnbBalance(wallets[0].address)
          const fee = await getBap578MintFee()
          const needed = fee + ethers.parseEther('0.001')
          if (userBalance >= needed) {
            const userPK = decryptPrivateKey(wallets[0].encryptedPK!, user.id)
            const metadataJson = JSON.stringify(buildMetadataJson(identity, result.txHash))
            const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(metadataJson))
            const mint = await mintBap578Agent({
              userWalletPK: userPK,
              agentName: name,
              agentAddress: address,
              metadataURI: identity.metadataUri,
              metadataHash,
              onTxSent: async (h) => {
                // Persist before confirmation so a wait()-failure can't double-charge.
                await db.agent.update({ where: { id: agent.id }, data: { bap578TxHash: h } })
              }
            })
            if (mint.success && mint.tokenId) {
              await db.agent.update({
                where: { id: agent.id },
                data: { bap578TokenId: mint.tokenId, bap578TxHash: mint.txHash, bap578Verified: true }
              })
              bap578Status = `\n\n💎 *BAP-578 NFA #${mint.tokenId} minted!*\n[View on NFAScan](${nfaScanUrl(address)}) · [BSCScan](${bap578TokenUrl(mint.tokenId)})`
            } else {
              bap578Status = `\n\n🟡 BAP-578 mint skipped: _${mint.reason}_\nRun /verifyagent ${name} to retry.`
            }
          } else {
            bap578Status = `\n\n💎 *Verify on BAP-578* (NFAScan-listed): fund your wallet with ${MINT_FEE_BNB} BNB then run /verifyagent ${name}`
          }
        } catch (e: any) {
          console.error('[BAP578] auto-mint error:', e.message)
        }
      } else if (user.pinHash) {
        bap578Status = `\n\n💎 *Verify on BAP-578*: run /verifyagent ${name} (PIN required, costs ${MINT_FEE_BNB} BNB)`
      }

      await ctx.reply(
        `🚀 *${agent.name} is LIVE!*

🔐 *On-chain identity*
\`${address}\`
[View on BSCScan](${bscscanAddressUrl(address)})

${onchainStatus}${bap578Status}

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

  // /verifyagent <name> — manually mint the BAP-578 NFA for an existing agent.
  // Costs 0.01 BNB from the user's main wallet.
  bot.command('verifyagent', async (ctx) => {
    const user = (ctx as any).dbUser
    if (!user) return

    const arg = (ctx.match as string | undefined)?.trim()
    if (!arg) {
      await ctx.reply('Usage: `/verifyagent <agent_name>`\n\nMints the official BAP-578 NFA NFT for the agent (costs 0.01 BNB).', { parse_mode: 'Markdown' })
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
    const fee = await getBap578MintFee()
    if (balance < fee + ethers.parseEther('0.001')) {
      await ctx.reply(
        `❌ *Insufficient BNB*\n\nYou need at least *${MINT_FEE_BNB} BNB* (+ a tiny gas buffer) in your main wallet:\n\`${wallets[0].address}\`\n\nCurrent balance: ${ethers.formatEther(balance)} BNB`,
        { parse_mode: 'Markdown' }
      )
      return
    }

    await ctx.reply(`⏳ Minting BAP-578 NFA for *${agent.name}*…\n\nPaying ${MINT_FEE_BNB} BNB to the registry contract.`, { parse_mode: 'Markdown' })

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
}
