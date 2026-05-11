import { Bot, Context, InlineKeyboard } from 'grammy'
import { ethers } from 'ethers'
import { db, setAgentOnchainFields } from '../../db'
import { generateEVMWallet, encryptPrivateKey, decryptPrivateKey, truncateAddress } from '../../services/wallet'
import { verifyPin, checkPinFailLimit, logSecurityEvent } from '../../services/security'
import { buildAgentIdentity, buildMetadataJson, type AgentChain, CHAIN_LABEL } from '../../services/agentIdentity'
import {
  mintBap578Agent, getBnbBalance,
  bap578TokenUrl, nfaScanUrl, bscscanTxUrl, bscscanAddressUrl,
  TOTAL_USER_FEE_BNB, BAP578_CONTRACT, recoverBap578TokenId, getBap578LogicAddress
} from '../../services/bap578'
import {
  registerAgentOnchain, erc8004ScanUrl, erc8004RegistryScanUrl, recoverErc8004AgentId,
  XLAYER_ERC8004_REGISTRY, getScanTxUrl, getScanRegistryUrl, type RegistryChain,
} from '../../services/erc8004'
import { createAgentForUser } from '../../services/agentCreation'

// Mini-app URL (used for deep-link buttons that open straight into the
// onboarding flow). Mirrors the resolution logic in start.ts so changing
// MINIAPP_URL or REPLIT_DOMAINS in env affects both consistently.
function miniAppOnboardUrl(): string {
  const base = process.env.MINIAPP_URL
    || `https://${process.env.REPLIT_DOMAINS?.split(',')[0] || 'build4-1.onrender.com'}/app`
  // Use a query param the mini app reads on first paint to jump straight
  // to the Onboard page without the user having to navigate.
  return base.includes('?') ? `${base}&onboard=1` : `${base}?onboard=1`
}

// Per-agent scan-URL helper. Falls back to the BSC helpers for any agent
// whose `onchainChain` is null/'BSC' so historic agents render exactly as
// before. XLayer agents get oklink links via getScanRegistryUrl/getScanTxUrl.
function dbChainToRegistryChain(c: string | null | undefined): RegistryChain {
  return (c ?? '').toUpperCase() === 'XLAYER' ? 'xlayer' : 'bsc'
}
function agentScanRegistryUrl(agent: { onchainChain?: string | null; erc8004AgentId: string }): string {
  const chain = dbChainToRegistryChain(agent.onchainChain)
  return chain === 'bsc' ? erc8004ScanUrl(agent.erc8004AgentId) : getScanRegistryUrl(chain, agent.erc8004AgentId)
}
function agentScanTxUrl(agent: { onchainChain?: string | null }, txHash: string): string {
  return getScanTxUrl(dbChainToRegistryChain(agent.onchainChain), txHash)
}

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
  step: 'name' | 'chain' | 'pin' | 'upgrade_pin'
  name?: string
  chain?: AgentChain    // chosen via callback in the 'chain' step
  upgradeAgentId?: string
}

const sessions = new Map<string, AgentSession>()

const NAME_REGEX = /^[a-zA-Z0-9_]{3,24}$/

// Whether XLayer is offered in the chain picker. False if no XLayer registry
// has been deployed yet — in that case we silently skip the picker and
// register on BSC like before, so the bot never offers a broken option.
function xlayerAvailable(): boolean {
  return !!XLAYER_ERC8004_REGISTRY
}

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
  chain: AgentChain
}) {
  const { ctx, user, name, userAddress, chain } = opts
  const chainLabel = CHAIN_LABEL[chain]

  await ctx.reply(`⏳ Registering *${name}* on ERC-8004 IdentityRegistry (${chainLabel})…`, { parse_mode: 'Markdown' })

  // All wallet/identity/register plumbing now lives in the shared service
  // so the mini-app onboard endpoint and this bot path stay in lock-step.
  // The bot defaults to the "balanced" preset to preserve historic risk
  // values (10x cap, 2%/4% SL/TP) — users tuning further go to Studio.
  const result = await createAgentForUser({
    userId: user.id,
    ownerAddress: userAddress,
    preset: 'balanced',
    startingCapital: 25,   // Balanced default; matches the new mini-app preset.
    name,
    chain,
  })

  if (!result.ok) {
    if (result.partial) {
      await ctx.reply(
        `⚠️ Registration partially failed: ${result.reason}\n\n` +
        `The agent's wallet was funded but the on-chain register call failed. Run /myagents to retry.`
      )
    } else {
      await ctx.reply(`❌ Registration failed: ${result.reason}\n\nNo agent was created. Try /newagent again.`)
    }
    return
  }

  const agent = result.agent
  const onchainAgentId = agent.erc8004AgentId as string
  const txHash = (agent.onchainTxHash ?? agent.erc8004TxHash) as string

  // Per-chain links: BSC keeps its BSCScan helpers; XLayer agents point at
  // oklink. BAP-578 NFA upgrade is BSC-only (contract lives on BSC), so
  // we hide the upgrade button for XLayer agents.
  const registryLinkUrl = chain === 'bsc' ? erc8004ScanUrl(onchainAgentId) : getScanRegistryUrl(chain, onchainAgentId)
  const txLinkUrl       = getScanTxUrl(chain, txHash)

  const upgradeKb = new InlineKeyboard()
  if (chain === 'bsc') {
    upgradeKb.text(`💎 Upgrade to BAP-578 NFA (${TOTAL_USER_FEE_BNB} BNB)`, `upgrade_bap578_${agent.id}`)
  }

  await ctx.reply(
    `🚀 *${name} is LIVE & on-chain!*

🆔 *ERC-8004 Agent ID:* #${onchainAgentId}
🌐 *Chain:* ${chainLabel}
🔐 On-chain identity: \`${agent.walletAddress}\`

[View agent on registry](${registryLinkUrl})
[Registration tx](${txLinkUrl})

━━━━━━━━━━━━━━

Your agent trades *all perp pairs on Aster DEX* — finding the best opportunities across the market. First scan in ~60 seconds. Tune position sizes, risk limits and pairs anytime in the *mini-app*.

${chain === 'bsc'
  ? `*Optional upgrade:* mint a BAP-578 Non-Fungible Agent NFT (verifiable on NFAScan) for ${TOTAL_USER_FEE_BNB} BNB.`
  : `_NFA upgrade is BSC-only and unavailable for XLayer agents._`}

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
      `✅ *${agent.name}* is already a BAP-578 NFA (#${agent.bap578TokenId}).\n\n[View on NFAScan](${nfaScanUrl(agent.name, agent.bap578TokenId!)})`,
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
      await setAgentOnchainFields(agent.id, { bap578TokenId: recovered, bap578Verified: true })
      await ctx.reply(
        `🎉 *${agent.name} is already a BAP-578 NFA!*\n\nWe recovered your previous mint from chain — no extra fee charged.\n\n💎 NFA #${recovered}\n[View on NFAScan](${nfaScanUrl(agent.name, recovered)})\n[Mint tx](${bscscanTxUrl(agent.bap578TxHash)})`,
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
      await setAgentOnchainFields(agent.id, { bap578TxHash: h })
    }
  })

  if (!mint.success || !mint.tokenId) {
    await ctx.reply(`❌ NFA mint failed: ${mint.reason ?? 'unknown error'}\n\nYour agent is still live — just not minted as an NFA yet.`)
    return
  }

  await setAgentOnchainFields(agent.id, {
    bap578TokenId: mint.tokenId,
    bap578TxHash: mint.txHash ?? null,
    bap578Verified: true
  })

  await ctx.reply(
    `🎉 *${agent.name} is now a BAP-578 NFA!*

💎 NFA #${mint.tokenId}
[View on NFAScan](${nfaScanUrl(agent.name, mint.tokenId)})
[BSCScan token](${bap578TokenUrl(mint.tokenId)})
[Mint tx](${bscscanTxUrl(mint.txHash!)})`,
    { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }
  )
}

// Deep-link the user into the mini-app onboarding flow. The mini app reads
// the `?onboard=1` query param on first paint and jumps straight to the
// preset-chip Onboard screen so the user goes from "Create Agent" tap →
// deployed agent in <60 seconds, no name prompt, no chain picker. The
// legacy text flow (startAgentCreation → reply with a name → chain picker)
// stays available as a fallback for anyone who has it bookmarked, but is
// no longer the primary entry point.
async function sendOnboardDeepLink(ctx: Context) {
  const url = miniAppOnboardUrl()
  const kb = new InlineKeyboard().webApp('🚀 Deploy in BUILD4', url)
  await ctx.reply(
    `🤖 *Deploy your AI agent*\n\n` +
    `One screen. Three risk presets. Set how much capital to start with, tap *Deploy* — your agent is live and trading on Aster within 60 seconds.\n\n` +
    `_Registration is free — BUILD4 covers the on-chain gas._`,
    { parse_mode: 'Markdown', reply_markup: kb }
  )
}

export function registerAgents(bot: Bot) {
  bot.command('newagent', async (ctx) => {
    await sendOnboardDeepLink(ctx)
  })

  bot.callbackQuery('create_agent', async (ctx) => {
    await ctx.answerCallbackQuery()
    await sendOnboardDeepLink(ctx)
  })

  // Legacy text-prompt flow, kept as an escape hatch for power users.
  // Anyone who types `/newagent_classic` still gets the original name →
  // chain picker → mint flow. Not advertised in any menu.
  bot.command('newagent_classic', async (ctx) => {
    await startAgentCreation(ctx)
  })

  // Chain picker callbacks — fired from the inline keyboard rendered after
  // the user passes name validation. Both buttons resolve the same way:
  // pop the session, look up the user's owner wallet, and run the mint.
  bot.callbackQuery(/^chain_pick_(xlayer|bsc)$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    const user = (ctx as any).dbUser
    if (!user) return
    const session = sessions.get(user.id)
    if (!session || session.step !== 'chain' || !session.name) {
      await ctx.reply('Session expired — run /newagent again.')
      return
    }
    const chain: AgentChain = ctx.match![1] === 'xlayer' ? 'xlayer' : 'bsc'
    const name = session.name
    sessions.delete(user.id)

    // Strip the inline keyboard so the user can't double-click.
    try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }) } catch {}

    const wallets = await db.wallet.findMany({ where: { userId: user.id }, take: 1 })
    if (!wallets[0]) {
      await ctx.reply('❌ No main wallet found. Run /start to initialize, then try again.')
      return
    }
    try {
      await performMintAndCreate({ ctx, user, name, userAddress: wallets[0].address, chain })
    } catch (err: any) {
      console.error('[Agent] Create flow threw (chain pick):', err)
      const recent = await db.agent.findFirst({
        where: {
          userId: user.id,
          name,
          createdAt: { gt: new Date(Date.now() - 60_000) }
        }
      })
      if (recent) {
        console.error(`[Agent] Suppressed false-failure UI: agent "${name}" exists (id=${recent.id}).`)
        await ctx.reply(`✅ *${name}* was created. Run /myagents to see it.`, { parse_mode: 'Markdown' })
      } else {
        await ctx.reply(`❌ Failed to create agent: ${err.message}\n\nTry /newagent again.`)
      }
    }
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
      //
      // Chain selection: if XLayer is configured we let the user choose. If
      // not, fall straight through to BSC so the bot never offers a broken
      // option (XLayer registry needs to be deployed first, see scripts/).
      if (xlayerAvailable()) {
        sessions.set(user.id, { step: 'chain', name })
        const kb = new InlineKeyboard()
          .text('🟣 XLayer (default)', `chain_pick_xlayer`).row()
          .text('🟡 BNB Smart Chain',  `chain_pick_bsc`)
        await ctx.reply(
          `🌐 *Pick a chain for ${name}*\n\nERC-8004 IdentityRegistry is live on both. XLayer is the default for the campaign.`,
          { parse_mode: 'Markdown', reply_markup: kb }
        )
        return
      }
      sessions.delete(user.id)
      try {
        await performMintAndCreate({ ctx, user, name, userAddress: wallets[0].address, chain: 'bsc' })
      } catch (err: any) {
        console.error('[Agent] Create flow threw:', err)
        // The agent row may already exist with on-chain identity registered —
        // check before yelling at the user. If a row matching this name was
        // created in the last 60s, the on-chain register almost certainly
        // succeeded and only a downstream DB write failed. Don't tell the
        // user it failed when their agent is actually live.
        const recent = await db.agent.findFirst({
          where: {
            userId: user.id,
            name,
            createdAt: { gt: new Date(Date.now() - 60_000) }
          }
        })
        if (recent) {
          console.error(`[Agent] Suppressed false-failure UI: agent "${name}" exists (id=${recent.id}). Original error was logged above.`)
          await ctx.reply(
            `✅ *${name}* was created. Run /myagents to see it.`,
            { parse_mode: 'Markdown' }
          )
        } else {
          await ctx.reply(`❌ Failed to create agent: ${err.message}\n\nTry /newagent again.`)
        }
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
        await performMintAndCreate({
          ctx, user, name,
          userAddress: wallets[0]?.address ?? '',
          chain: xlayerAvailable() ? 'xlayer' : 'bsc',
        })
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

  // Task #75 — per-user cooldown for the on-chain self-heal pass below.
  // Self-heal can't change between two clicks of the same user (it only
  // backfills missing on-chain identifiers), so re-running it on every
  // toggle re-render burns ~1-3s of RPC latency before editMessageText
  // fires. Cache the last sync timestamp per user and skip the heal if
  // we synced recently OR the caller explicitly opts out.
  const SELF_HEAL_COOLDOWN_MS = 60_000
  const lastSelfHealAt = new Map<string, number>()

  // Task #72 — extracted rendering so the inline launch-approval toggle
  // can reuse the exact same text+keyboard via editMessageText.
  // Task #75 — `opts.skipSelfHeal` lets quick re-renders (e.g. the
  // launch-approval toggle) bypass the on-chain re-sync entirely so the
  // edit feels instant; otherwise the cooldown above gates it.
  const buildMyAgentsView = async (
    user: any,
    opts: { skipSelfHeal?: boolean; forceSelfHeal?: boolean } = {},
  ): Promise<{ text: string; keyboard: InlineKeyboard } | null> => {
    // Task #76 — `forceSelfHeal` resets the per-user cooldown so the
    // refresh button always runs a fresh on-chain sync regardless of
    // when /myagents was last opened.
    if (opts.forceSelfHeal) lastSelfHealAt.delete(user.id)
    let agents = await db.agent.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' }
    })

    // Task #72 — backfill the per-agent four.meme approval flag via raw
    // SQL. The column is added by ensureTables but not in the deployed
    // Prisma schema, so a typed findMany() never SELECTs it. Mirrors the
    // same pattern used by GET /api/me/agents.
    const fourMemeApprovalById = new Map<string, boolean>()
    if (agents.length > 0) {
      try {
        const ids = agents.map(a => a.id)
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ')
        const rows = await db.$queryRawUnsafe<Array<{ id: string; v: boolean | null }>>(
          `SELECT "id", "fourMemeLaunchRequiresApproval" AS "v" FROM "Agent" WHERE "id" IN (${placeholders})`,
          ...ids,
        )
        for (const r of rows) fourMemeApprovalById.set(r.id, !!r.v)
      } catch (e: any) {
        console.warn('[/myagents] fourMeme approval backfill failed:', e?.message)
      }
    }

    // Self-heal: backfill missing on-chain identifiers from BSC. Runs in
    // parallel and only touches agents that look unsynced. Failures are
    // swallowed so a flaky RPC never breaks the menu.
    // Task #75 — gated by an explicit skip flag (used by the toggle
    // re-render path) and a per-user cooldown so quick re-opens of
    // /myagents don't re-pay the full RPC latency. The first call still
    // syncs; subsequent calls within SELF_HEAL_COOLDOWN_MS reuse the
    // last sync's results (which were persisted to the DB).
    const lastSyncAt = lastSelfHealAt.get(user.id) ?? 0
    const withinCooldown = Date.now() - lastSyncAt < SELF_HEAL_COOLDOWN_MS
    const shouldSelfHeal = !opts.skipSelfHeal && !withinCooldown
    const ownerWallet = shouldSelfHeal
      ? (await db.wallet.findFirst({ where: { userId: user.id } }))?.address
      : undefined
    const hasApiKey = !!(process.env.BSCSCAN_API_KEY ?? process.env.ETHERSCAN_API_KEY)
    if (shouldSelfHeal) await Promise.all(agents.map(async (a) => {
      console.log(`[Sync] agent="${a.name}" wallet=${a.walletAddress ?? 'NONE'} ercId=${a.erc8004AgentId ?? 'NONE'} ercTx=${a.erc8004TxHash ?? 'NONE'} bapId=${a.bap578TokenId ?? 'NONE'} bapTx=${a.bap578TxHash ?? 'NONE'}`)
      if (!a.walletAddress) {
        console.log(`[Sync] agent="${a.name}" SKIP: no walletAddress`)
        return
      }
      try {
        // Self-heal: previous recoverBap578TokenId did an owner-wide
        // Etherscan lookup and could attribute another agent's tokenId
        // to this one (same owner wallet = matches every NFA they minted).
        // For any verified row, ask the chain who that tokenId actually
        // belongs to. If logicAddress != this agent's wallet → it's a
        // wrong attribution; clear it. Otherwise leave it alone — Smith
        // and other legitimately-upgraded agents are unaffected.
        if (a.bap578Verified && a.bap578TokenId && a.walletAddress) {
          const onchainLogic = await getBap578LogicAddress(a.bap578TokenId)
          if (onchainLogic && onchainLogic !== a.walletAddress.toLowerCase()) {
            console.log(`[Sync] agent="${a.name}" CLEARING wrong bap578TokenId=${a.bap578TokenId} (chain logicAddr=${onchainLogic} != agent=${a.walletAddress.toLowerCase()})`)
            await setAgentOnchainFields(a.id, { bap578TokenId: null, bap578Verified: false })
            ;(a as any).bap578TokenId = null
            ;(a as any).bap578Verified = false
          } else if (onchainLogic) {
            console.log(`[Sync] agent="${a.name}" bap578 verified ✓ (chain logicAddr matches)`)
          }
        }
        if (!a.erc8004AgentId) {
          console.log(`[Sync] agent="${a.name}" recovering ERC-8004 agentId…`)
          const recovered = await recoverErc8004AgentId({ agentAddress: a.walletAddress, txHash: a.erc8004TxHash })
          console.log(`[Sync] agent="${a.name}" ERC-8004 recovered=${recovered ?? 'null'}`)
          if (recovered) {
            await setAgentOnchainFields(a.id, { erc8004AgentId: recovered, erc8004Verified: true })
            ;(a as any).erc8004AgentId = recovered
            ;(a as any).erc8004Verified = true
          }
        }
        if (!a.bap578TokenId) {
          if (!ownerWallet) {
            console.log(`[Sync] agent="${a.name}" SKIP BAP-578: no ownerWallet`)
          } else {
            console.log(`[Sync] agent="${a.name}" recovering BAP-578 tokenId (owner=${ownerWallet})…`)
            const tokenId = await recoverBap578TokenId({
              ownerAddress: ownerWallet,
              agentAddress: a.walletAddress,
              txHash: a.bap578TxHash
            })
            console.log(`[Sync] agent="${a.name}" BAP-578 recovered=${tokenId ?? 'null'}`)
            if (tokenId) {
              await setAgentOnchainFields(a.id, { bap578TokenId: tokenId, bap578Verified: true })
              ;(a as any).bap578TokenId = tokenId
              ;(a as any).bap578Verified = true
            }
          }
        }
      } catch (e: any) {
        console.error(`[Sync] agent="${a.name}" FAILED:`,
          'msg=', e?.message || '(empty)',
          'code=', e?.code,
          'meta=', JSON.stringify(e?.meta),
          'name=', e?.name,
          'stack=', e?.stack?.split('\n').slice(0, 4).join(' | '))
      }
    }))
    // Task #75 — only mark the cooldown as fresh after the heal pass
    // actually completed. If a transient RPC failure threw before this
    // point we want the next /myagents to retry rather than be silently
    // suppressed for a full minute.
    if (shouldSelfHeal) lastSelfHealAt.set(user.id, Date.now())

    if (agents.length === 0) {
      return null
    }

    let text = `🤖 *Your On-Chain Agents*\n\n_Every agent below is registered on the ERC-8004 IdentityRegistry. Chain shown per agent._\n\n`
    agents.forEach((a) => {
      const status   = a.isActive ? '🟢 Active' : a.isPaused ? '🔴 Paused' : '⚪ Inactive'
      const chainTag = (a.onchainChain ?? 'BSC').toUpperCase() === 'XLAYER' ? '🟣 XLayer' : '🟡 BSC'
      text += `━━━━━━━━━━━━━━\n*${a.name}* — ${status} · ${chainTag}\n`

      if (a.erc8004Verified && a.erc8004AgentId) {
        text += `🆔 *ERC-8004 Agent ID:* #${a.erc8004AgentId} ✓\n`
        text += `🔎 [View on chain](${agentScanRegistryUrl(a as any)})\n`
      } else if (a.erc8004TxHash) {
        text += `🟡 *ERC-8004 register:* awaiting confirmation\n`
        text += `📜 [Check tx](${agentScanTxUrl(a as any, a.erc8004TxHash)})\n`
      }
      // BAP-578 NFA is BSC-only — only render the section for BSC agents.
      if (dbChainToRegistryChain(a.onchainChain) === 'bsc') {
        if (a.bap578Verified && a.bap578TokenId) {
          text += `💎 *BAP-578 NFA:* #${a.bap578TokenId} ✓\n`
          text += `🌐 [View on NFAScan](${nfaScanUrl(a.name, a.bap578TokenId!)})\n`
        } else if (a.bap578TxHash) {
          text += `🟡 *BAP-578 mint:* awaiting confirmation\n`
          text += `📜 [Check tx](${bscscanTxUrl(a.bap578TxHash)})\n`
        }
      }
      if (a.learningModel) {
        text += `🧠 *Model:* ${a.learningModel}\n`
      }
      // 8004scan aggregator is currently BSC-only — only show for BSC agents.
      if (a.erc8004AgentId && dbChainToRegistryChain(a.onchainChain) === 'bsc') {
        text += `📊 [View on 8004scan](${erc8004RegistryScanUrl(a.erc8004AgentId)})\n`
      }
      // Task #72 — surface the four.meme HITL approval flag so users
      // can see at a glance whether the launch agent will auto-fire or
      // wait for confirmation.
      const requireApproval = fourMemeApprovalById.get(a.id) ?? false
      text += requireApproval
        ? `🚀 *Token launches:* ✅ approval required\n`
        : `🚀 *Token launches:* ⚡ auto-launch\n`
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
      // Task #72 — Telegram parity for the mini-app launch-approval toggle.
      const requireApproval = fourMemeApprovalById.get(a.id) ?? false
      keyboard.text(
        requireApproval
          ? `🚀 ${a.name}: launches need approval — tap to auto-launch`
          : `🚀 ${a.name}: launches auto-fire — tap to require approval`,
        `toggle_4m_appr_${a.id}`,
      ).row()
      keyboard.text(`🗑 Remove ${a.name}`, `remove_agent_confirm_${a.id}`).row()
    })
    keyboard.text('➕ New Agent', 'create_agent').row()
    // Task #76 — manual on-chain refresh. Bypasses the per-user
    // self-heal cooldown so a user who just confirmed a mint/register
    // tx can force a fresh sync without waiting up to 60s.
    keyboard.text('🔄 Refresh on-chain status', 'refresh_my_agents')

    return { text, keyboard }
  }

  const showMyAgents = async (ctx: any) => {
    const user = ctx.dbUser
    if (!user) return
    const view = await buildMyAgentsView(user)
    if (!view) {
      const keyboard = new InlineKeyboard().text('🤖 Create your first agent', 'create_agent')
      await ctx.reply('No agents yet. Create your first on-chain AI agent!', {
        reply_markup: keyboard,
      })
      return
    }
    await ctx.reply(view.text, { parse_mode: 'Markdown', reply_markup: view.keyboard })
  }

  bot.command('myagents', showMyAgents)
  bot.callbackQuery('my_agents', async (ctx) => {
    await ctx.answerCallbackQuery()
    await showMyAgents(ctx)
  })

  // Task #76 — manual refresh button. Forces a fresh on-chain self-heal
  // pass (bypassing the per-user cooldown) and edits the existing
  // /myagents message in place with the synced status.
  bot.callbackQuery('refresh_my_agents', async (ctx) => {
    const user = (ctx as any).dbUser
    if (!user) {
      await ctx.answerCallbackQuery({ text: 'Sign in via /start first.', show_alert: true })
      return
    }
    // Telegram only honours the first answerCallbackQuery for a given
    // callback, so defer the toast until we know the actual outcome
    // (synced / already-up-to-date / failed). The message edit itself
    // is the primary user-visible feedback; the toast is just a hint.
    let toast: { text: string; show_alert?: boolean } = { text: '✅ Synced.' }
    try {
      const view = await buildMyAgentsView(user, { forceSelfHeal: true })
      if (!view) {
        try {
          await ctx.editMessageText('No agents yet. Create your first on-chain AI agent!', {
            reply_markup: new InlineKeyboard().text('🤖 Create your first agent', 'create_agent'),
          })
        } catch {}
      } else {
        try {
          await ctx.editMessageText(view.text, {
            parse_mode: 'Markdown',
            reply_markup: view.keyboard,
          })
        } catch (e: any) {
          // Telegram throws "message is not modified" if nothing changed —
          // surface a distinct toast so the user knows the refresh ran.
          const msg = e?.message ?? ''
          if (/not modified/i.test(msg)) {
            toast = { text: '✅ Already up to date.' }
          } else {
            console.warn('[/myagents] refresh editMessageText failed:', msg)
            toast = { text: 'Refresh ran but the message could not be updated.' }
          }
        }
      }
    } catch (err: any) {
      console.error('[/myagents] refresh failed:', err)
      toast = { text: 'Refresh failed. Try again.', show_alert: true }
    }
    try { await ctx.answerCallbackQuery(toast) } catch {}
  })

  // Task #72 — toggle the four.meme HITL launch-approval flag from the
  // /myagents menu. Owner-gated (re-checks `userId` before UPDATE),
  // edits the message in place so the user sees the new state without
  // re-running /myagents. Same column the mini-app PATCH writes to.
  bot.callbackQuery(/^toggle_4m_appr_(.+)$/, async (ctx) => {
    const user = (ctx as any).dbUser
    const agentId = ctx.match![1]
    if (!user) {
      await ctx.answerCallbackQuery({ text: 'Sign in via /start first.', show_alert: true })
      return
    }
    try {
      const rows = await db.$queryRawUnsafe<Array<{
        userId: string
        v: boolean | null
      }>>(
        `SELECT "userId", COALESCE("fourMemeLaunchRequiresApproval", false) AS "v"
           FROM "Agent" WHERE "id" = $1 LIMIT 1`,
        agentId,
      )
      if (rows.length === 0) {
        await ctx.answerCallbackQuery({ text: 'Agent not found.', show_alert: true })
        return
      }
      if (rows[0].userId !== user.id) {
        await ctx.answerCallbackQuery({ text: 'Not your agent.', show_alert: true })
        return
      }
      const next = !rows[0].v
      await db.$executeRawUnsafe(
        `UPDATE "Agent" SET "fourMemeLaunchRequiresApproval" = $1 WHERE "id" = $2`,
        next,
        agentId,
      )
      await ctx.answerCallbackQuery({
        text: next
          ? '✅ Launches now require your approval.'
          : '⚡ Launches will fire automatically.',
      })
      // Task #75 — toggling the launch-approval flag never affects the
      // on-chain identity rows, so skip the self-heal RPC pass entirely
      // and let editMessageText fire as quickly as the DB read allows.
      const view = await buildMyAgentsView(user, { skipSelfHeal: true })
      if (view) {
        try {
          await ctx.editMessageText(view.text, {
            parse_mode: 'Markdown',
            reply_markup: view.keyboard,
          })
        } catch (e: any) {
          // Telegram throws if nothing changed or the message is too old.
          // Either way the toast already confirmed the new state, so we
          // log and move on rather than spamming a new /myagents reply.
          console.warn('[/myagents] editMessageText after toggle failed:', e?.message)
        }
      }
    } catch (err: any) {
      console.error('[/myagents] toggle_4m_appr failed:', err)
      try {
        await ctx.answerCallbackQuery({ text: 'Toggle failed. Try again.', show_alert: true })
      } catch {}
    }
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
      await ctx.reply(`✅ *${agent.name}* is already BAP-578 verified.\n\nNFA #${agent.bap578TokenId}\n[View on NFAScan](${nfaScanUrl(agent.name, agent.bap578TokenId ?? mint.tokenId)})`, {
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
        `🎉 *${agent.name} is now BAP-578 verified!*\n\n💎 NFA #${mint.tokenId}\n[View on NFAScan](${nfaScanUrl(agent.name, agent.bap578TokenId ?? mint.tokenId)})\n[BSCScan token page](${bap578TokenUrl(mint.tokenId)})\n[Mint transaction](${bscscanTxUrl(mint.txHash!)})`,
        { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }
      )
    } catch (e: any) {
      console.error('[verifyagent] error:', e)
      await ctx.reply(`❌ Mint failed: ${e.message}`)
    }
  })
  */
}
