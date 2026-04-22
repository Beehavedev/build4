import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import { db } from './db'
import { createBot } from './bot'
import { initRunner } from './agents/runner'
import { migrateOldUsers, migrateAgentsToAuto } from './migrate'
import { ensureNewTables } from './ensureTables'
import { requireTgUser, requireAdmin, isAdminTelegramId } from './services/telegramAuth'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = parseInt(process.env.PORT ?? '3000')

app.use(express.json())

// Serve mini-app static files
const miniAppDist = path.join(__dirname, 'miniapp', 'dist')
app.use('/app', express.static(miniAppDist, {
  setHeaders: (res, filePath) => {
    // Hashed assets (Vite outputs /assets/*-[hash].js) can be cached forever.
    // index.html must NEVER be cached — Telegram WebView caches HTML aggressively.
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
      res.setHeader('Pragma', 'no-cache')
      res.setHeader('Expires', '0')
    } else if (filePath.includes('/assets/')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    }
  }
}))
app.use('/app', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  res.sendFile(path.join(miniAppDist, 'index.html'))
})

// REST API routes
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ERC-8004 metadata endpoint — public, returns the agent's identity JSON.
// AI-agent scanners (NFAScan, etc.) fetch this to verify the agent's
// declared model, learning Merkle root, and trust signals.
app.get('/api/agents/:address/metadata.json', async (req, res) => {
  try {
    const { buildMetadataJson, buildAgentIdentity } = await import('./services/agentIdentity')
    const address = req.params.address
    const agent = await db.agent.findFirst({
      where: { walletAddress: { equals: address, mode: 'insensitive' } },
      include: { user: { include: { wallets: { where: { isActive: true }, take: 1 } } } }
    })
    if (!agent || !agent.walletAddress) return res.status(404).json({ error: 'Agent not found' })

    const ownerAddress = agent.user.wallets[0]?.address ?? '0x0000000000000000000000000000000000000000'
    const baseUrl = `${req.protocol}://${req.get('host')}`
    const identity = buildAgentIdentity({
      name: agent.name,
      agentAddress: agent.walletAddress,
      ownerAddress,
      publicBaseUrl: baseUrl,
      model: agent.learningModel ?? undefined
    })
    const json = buildMetadataJson(identity, agent.onchainTxHash)
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.json({
      ...json,
      stats: {
        totalPnl: agent.totalPnl,
        totalTrades: agent.totalTrades,
        winRate: agent.winRate,
        isActive: agent.isActive
      }
    })
  } catch (err) {
    console.error('[API] /agents/:address/metadata.json failed:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

app.get('/api/user/:telegramId', async (req, res) => {
  try {
    const user = await db.user.findUnique({
      where: { telegramId: BigInt(req.params.telegramId) },
      include: { wallets: true, portfolio: true }
    })
    if (!user) return res.status(404).json({ error: 'User not found' })
    res.json({ ...user, telegramId: user.telegramId.toString() })
  } catch (err) {
    res.status(500).json({ error: 'Internal error' })
  }
})

// Authenticated endpoints — use signed Telegram initData
app.get('/api/me/agents', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    const agents = await db.agent.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' }
    })
    res.json(agents)
  } catch (err) {
    console.error('[API] /me/agents failed:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

// Live "Agent Brain" feed — last 20 decisions across all of the signed-in
// user's agents. Powers the timeline on the mini-app Agents tab.
// ── Brain feed helpers ──────────────────────────────────────────────────
// The feed has TWO sources:
//   1. AgentLog rows — rich reasoning entries written by the runner. These
//      include adx/rsi/score/regime/reason. Best-effort: if the running
//      Prisma client is stale (Render edge case) the read or the underlying
//      writes can fail with PrismaClientValidationError, in which case we
//      silently return an empty list and fall back to source #2.
//   2. Trade rows — every executed order. These ALWAYS succeed because the
//      Trade model has no recently-added fields. This guarantees that any
//      real trade the user sees on Aster also shows up in their brain feed,
//      even if the rich logging path is broken.
// We fetch both, merge them, sort by time, and cap at `limit`.

const isStaleClientError = (err: any): boolean => {
  const code = err?.code
  return (
    code === 'P2021' ||
    code === 'P2022' ||
    err?.name === 'PrismaClientValidationError' ||
    /Unknown argument|Unknown field/i.test(String(err?.message ?? ''))
  )
}

type FeedEntry = {
  id: string
  agentId: string
  agentName: string
  action: string
  pair: string | null
  price: number | null
  reason: string | null
  adx: number | null
  rsi: number | null
  score: number | null
  regime: string | null
  createdAt: Date
}

async function fetchAgentLogFeed(where: any, limit: number, agentNameById: Map<string, string>): Promise<FeedEntry[]> {
  try {
    const entries = await db.agentLog.findMany({
      where: { ...where, pair: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { agent: { select: { name: true } } }
    } as any)
    return (entries as any[]).map((e) => ({
      id: e.id,
      agentId: e.agentId,
      agentName: e.agent?.name ?? agentNameById.get(e.agentId) ?? 'Agent',
      action: e.action,
      pair: e.pair ?? null,
      price: e.price ?? null,
      reason: e.reason ?? null,
      adx: e.adx ?? null,
      rsi: e.rsi ?? null,
      score: e.score ?? null,
      regime: e.regime ?? null,
      createdAt: e.createdAt
    }))
  } catch (err: any) {
    if (isStaleClientError(err)) {
      console.error(`[API] feed agentLog read degraded (${err?.code ?? 'validation'}):`, err?.message?.split('\n')[0])
      return []
    }
    throw err
  }
}

async function fetchTradeFeed(where: any, limit: number, agentNameById: Map<string, string>): Promise<FeedEntry[]> {
  // Trades are split into two virtual feed entries: one OPEN at openedAt, and
  // one CLOSE at closedAt if the trade has closed. That way the user sees
  // both sides of the lifecycle in chronological order.
  const trades = await db.trade.findMany({
    where,
    orderBy: { openedAt: 'desc' },
    take: limit,
    include: { agent: { select: { name: true } } }
  })
  const out: FeedEntry[] = []
  for (const t of trades as any[]) {
    const sig = (t.signalsUsed ?? {}) as any
    const agentName = t.agent?.name ?? agentNameById.get(t.agentId ?? '') ?? 'Agent'
    out.push({
      id: `trade-open-${t.id}`,
      agentId: t.agentId ?? '',
      agentName,
      action: t.side === 'LONG' ? 'OPEN_LONG' : 'OPEN_SHORT',
      pair: t.pair,
      price: t.entryPrice,
      reason: t.aiReasoning ?? `Executed on ${t.exchange} · size $${Number(t.size).toFixed(2)} · ${t.leverage}x`,
      adx: sig.adx ?? null,
      rsi: sig.rsi ?? null,
      score: sig.setupScore ?? sig.score ?? null,
      regime: sig.regime ?? null,
      createdAt: t.openedAt
    })
    if (t.closedAt) {
      const pnlStr = t.pnl != null ? `${t.pnl >= 0 ? '+' : ''}${Number(t.pnl).toFixed(2)} USDT` : ''
      out.push({
        id: `trade-close-${t.id}`,
        agentId: t.agentId ?? '',
        agentName,
        action: 'CLOSE',
        pair: t.pair,
        price: t.exitPrice ?? t.entryPrice,
        reason: `Closed ${t.side} ${pnlStr}`.trim(),
        adx: null,
        rsi: null,
        score: null,
        regime: null,
        createdAt: t.closedAt
      })
    }
  }
  return out
}

async function fetchAsterTradeFeed(userId: string, limit: number): Promise<FeedEntry[]> {
  try {
    const dbUser = await db.user.findUnique({
      where: { id: userId },
      include: { wallets: { where: { isActive: true }, take: 1 } }
    })
    const wallet = dbUser?.wallets[0]
    if (!dbUser || !wallet) return []
    const { resolveAgentCreds, getUserTrades } = await import('./services/aster')
    const creds = await resolveAgentCreds(dbUser, wallet.address)
    if (!creds) return []
    const fills = await getUserTrades(creds, { limit: 100 })
    return fills
      .filter(f => f.realizedPnl !== 0)
      .sort((a, b) => b.time - a.time)
      .slice(0, limit)
      .map(f => ({
        id: `aster-fill-${f.orderId}-${f.time}`,
        agentId: '',
        agentName: 'Aster',
        action: 'CLOSE',
        pair: f.symbol,
        price: f.price,
        reason: `Closed ${f.positionSide !== 'BOTH' ? f.positionSide : (f.side === 'SELL' ? 'LONG' : 'SHORT')} ${f.realizedPnl >= 0 ? '+' : ''}${f.realizedPnl.toFixed(2)} USDT`,
        adx: null,
        rsi: null,
        score: null,
        regime: null,
        createdAt: new Date(f.time)
      }))
  } catch (e) {
    console.warn('[API] fetchAsterTradeFeed failed:', (e as Error).message)
    return []
  }
}

function mergeFeeds(a: FeedEntry[], b: FeedEntry[], limit: number): FeedEntry[] {
  return [...a, ...b]
    .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())
    .slice(0, limit)
}

app.get('/api/me/feed', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    const limit = Math.min(parseInt(String(req.query.limit ?? '20')) || 20, 100)
    const agents = await db.agent.findMany({ where: { userId: user.id }, select: { id: true, name: true } })
    const nameById = new Map(agents.map((a) => [a.id, a.name]))
    const [logFeed, tradeFeed, asterFeed] = await Promise.all([
      fetchAgentLogFeed({ userId: user.id }, limit, nameById),
      fetchTradeFeed({ userId: user.id }, limit, nameById),
      fetchAsterTradeFeed(user.id, limit)
    ])
    res.json(mergeFeeds(mergeFeeds(logFeed, tradeFeed, limit * 2), asterFeed, limit))
  } catch (err: any) {
    if (isStaleClientError(err)) {
      console.error(`[API] /me/feed schema mismatch (${err?.code ?? 'validation'}):`, err?.message?.split('\n')[0])
      return res.json([])
    }
    console.error('[API] /me/feed failed:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

// Per-agent feed — same shape, scoped to one agent the user owns.
app.get('/api/agents/:id/feed', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    const agent = await db.agent.findFirst({
      where: { id: String(req.params.id), userId: user.id },
      select: { id: true, name: true }
    })
    if (!agent) return res.status(404).json({ error: 'Agent not found' })
    const limit = Math.min(parseInt(String(req.query.limit ?? '20')) || 20, 100)
    const nameById = new Map([[agent.id, agent.name]])
    const [logFeed, tradeFeed] = await Promise.all([
      fetchAgentLogFeed({ agentId: agent.id }, limit, nameById),
      fetchTradeFeed({ agentId: agent.id }, limit, nameById)
    ])
    res.json(mergeFeeds(logFeed, tradeFeed, limit))
  } catch (err: any) {
    if (isStaleClientError(err)) {
      console.error(`[API] /agents/:id/feed schema mismatch (${err?.code ?? 'validation'}):`, err?.message?.split('\n')[0])
      return res.json([])
    }
    console.error('[API] /agents/:id/feed failed:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

app.get('/api/me/portfolio', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    const [portfolio, trades, wallets] = await Promise.all([
      db.portfolio.findUnique({ where: { userId: user.id } }),
      db.trade.findMany({ where: { userId: user.id }, orderBy: { openedAt: 'desc' }, take: 50 }),
      db.wallet.findMany({ where: { userId: user.id, isActive: true } })
    ])
    res.json({ portfolio, trades, wallets, user: { ...user, telegramId: user.telegramId.toString() } })
  } catch (err) {
    console.error('[API] /me/portfolio failed:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

// Active wallet for the signed-in user, with on-chain balances + QR data URL.
app.get('/api/me/wallet', requireTgUser, async (req, res) => {
  try {
    const { ethers } = await import('ethers')
    const QRCode = (await import('qrcode')).default
    const user = (req as any).user
    const wallet = await db.wallet.findFirst({
      where: { userId: user.id, isActive: true }
    })
    if (!wallet) return res.status(404).json({ error: 'No active wallet' })

    const BSC_RPC = process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org'
    const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955'
    const provider = new ethers.JsonRpcProvider(BSC_RPC)

    let usdt = 0, bnb = 0, balanceError: string | null = null
    try {
      const [bnbWei, usdtWei] = await Promise.all([
        provider.getBalance(wallet.address),
        new ethers.Contract(USDT_BSC, ['function balanceOf(address) view returns (uint256)'], provider).balanceOf(wallet.address)
      ])
      bnb = parseFloat(ethers.formatEther(bnbWei))
      usdt = parseFloat(ethers.formatUnits(usdtWei, 18))
    } catch (e: any) {
      balanceError = e?.message ?? 'rpc_failed'
    }

    const qrDataUrl = await QRCode.toDataURL(wallet.address, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 360,
      color: { dark: '#000000', light: '#FFFFFF' }
    })

    // ── Aster account balance via public RPC (no signing required) ──
    // Aster's tapi.asterdex.com/info JSON-RPC accepts any wallet address
    // unauthenticated, so we always query — even for users who haven't run
    // approveAgent yet. If they have no Aster futures account, the RPC
    // returns an "account does not exist" error which we surface as
    // not_onboarded so the mini app shows the activation flow.
    let aster: {
      usdt: number; availableMargin: number;
      onboarded: boolean; error: string | null
    } = { usdt: 0, availableMargin: 0, onboarded: !!user.asterOnboarded, error: null }

    try {
      const asterMod = await import('./services/aster')
      const creds = await asterMod.resolveAgentCreds(user, wallet.address)
      if (!creds) {
        aster.error = 'no_agent_credentials'
      } else {
        const bal = await asterMod.getAccountBalanceStrict(creds)
        aster.usdt = bal.usdt
        aster.availableMargin = bal.availableMargin
      }
    } catch (e: any) {
      const msg = String(e?.message ?? 'aster_unavailable').toLowerCase()
      if (msg.includes('account does not exist') || msg.includes('no aster user')) {
        aster.error = 'not_onboarded'
      } else {
        console.error('[API] /me/wallet aster failed:', wallet.address, '→', e?.message)
        aster.error = String(e?.message ?? 'aster_unavailable')
      }
    }

    res.json({
      address: wallet.address,
      chain: wallet.chain,
      label: wallet.label,
      pinProtected: !!user.pinHash,
      balances: { usdt, bnb, error: balanceError },
      aster,
      qrDataUrl
    })
  } catch (err: any) {
    console.error('[API] /me/wallet failed:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Aster onboarding — POST /api/aster/approve
//
// Performs the one-time approveAgent EIP-712 signature ENTIRELY server-side.
// We decrypt the user's wallet private key, sign the ApproveAgent message,
// submit it to Aster, and on success flip asterOnboarded=true. The plaintext
// key never leaves this function (lives in memory for ~100ms during signing).
//
// Why server-side: the wallet was created by us, the user has no external
// copy. Signing here means the user never has to leave the mini app, never
// has to install MetaMask, never has to visit asterdex.com — and we keep the
// broker fee on every subsequent trade.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/aster/approve', requireTgUser, async (req, res) => {
  const user = (req as any).user
  try {
    const builderAddress = process.env.ASTER_BUILDER_ADDRESS
    const feeRate        = process.env.ASTER_BUILDER_FEE_RATE ?? '0.0001'
    if (!builderAddress) {
      return res.status(500).json({ success: false, error: 'Platform not configured (no builder)' })
    }

    if (user.asterOnboarded) {
      return res.json({ success: true, message: 'Already activated', alreadyOnboarded: true })
    }

    const wallet = await db.wallet.findFirst({ where: { userId: user.id, isActive: true } })
    if (!wallet || !wallet.encryptedPK) {
      return res.status(404).json({ success: false, error: 'No active wallet' })
    }

    const { decryptPrivateKey, encryptPrivateKey } = await import('./services/wallet')
    const { approveAgent, approveBuilder }      = await import('./services/aster')
    const { ensureAndDepositUSDT, USDT_BSC, MIN_BNB_FOR_GAS_WEI, getProvider } = await import('./services/asterDeposit')
    const { ethers: ethersLib } = await import('ethers')

    let userPk: string
    try {
      userPk = decryptPrivateKey(wallet.encryptedPK, user.id)
    } catch {
      return res.status(500).json({ success: false, error: 'Could not decrypt wallet' })
    }
    if (!userPk?.startsWith('0x')) {
      return res.status(500).json({ success: false, error: 'Invalid wallet key' })
    }

    // ── Per-user agent keypair. Aster requires each agent address to be
    //    UNIQUE per user — sharing a single platform-wide ASTER_AGENT_ADDRESS
    //    fails with "Agent address already exists" for everyone after the
    //    first user. So we generate a fresh agent wallet per user, encrypt
    //    its PK with the same scheme as user wallets (master key + userId),
    //    and persist on success. If a previous failed attempt already left
    //    an unsaved agent, we still generate a new one — Aster has no record
    //    of the failed attempt and we want a clean address each retry.
    let agentWallet: { address: string; privateKey: string }
    if (user.asterAgentEncryptedPK) {
      // Reuse previously-generated agent (idempotent retry after partial success)
      try {
        const decryptedAgentPk = decryptPrivateKey(user.asterAgentEncryptedPK, user.id)
        const w = new ethersLib.Wallet(decryptedAgentPk)
        agentWallet = { address: w.address, privateKey: decryptedAgentPk }
      } catch {
        // Stored key corrupt — fall through to generating a new one
        const w = ethersLib.Wallet.createRandom()
        agentWallet = { address: w.address, privateKey: w.privateKey }
      }
    } else {
      const w = ethersLib.Wallet.createRandom()
      agentWallet = { address: w.address, privateKey: w.privateKey }
    }

    // agentName: NO spaces, NO special chars. Aster's server appears to
    // re-derive the EIP-712 message from the parsed querystring, and any
    // whitespace normalization on their side would diverge from the raw
    // string we signed, producing a misleading "Signature check failed".
    const callApproveAgent = () => approveAgent({
      userAddress:    wallet.address,
      userPrivateKey: userPk,
      agentAddress:   agentWallet.address,
      agentName:      'BUILD4Agent',
      builderAddress,
      maxFeeRate:     feeRate,
      expiredDays:    365
    })

    const looksLikeNoAccount = (msg: string) => {
      const m = msg.toLowerCase()
      return m.includes('no aster user') || m.includes('user not found') ||
             m.includes('account does not exist')
    }

    // ── 1) Try approveAgent first. If wallet already has an Aster account
    //      (existing prod users, or anyone who deposited via asterdex.com
    //      previously), this succeeds immediately and we skip the on-chain hop.
    let result = await callApproveAgent()
    let bootstrap: { approveTx?: string; depositTx?: string; depositedUsdt?: string } | undefined

    // ── 2) If it failed because the Aster account doesn't exist yet, do the
    //      on-chain bootstrap: deposit the wallet's full BSC USDT balance to
    //      AstherusVault, then retry approveAgent.
    if (!result.success && looksLikeNoAccount(String(result.error ?? ''))) {
      console.log('[/aster/approve] account does not exist — initiating on-chain bootstrap for', wallet.address)
      try {
        const provider = getProvider()
        const erc20 = new (await import('ethers')).ethers.Contract(
          USDT_BSC,
          ['function balanceOf(address) view returns (uint256)'],
          provider
        )
        const [usdtBalWei, bnbBalWei] = await Promise.all([
          erc20.balanceOf(wallet.address) as Promise<bigint>,
          provider.getBalance(wallet.address)
        ])

        if (usdtBalWei === 0n) {
          userPk = ''
          return res.status(400).json({
            success: false,
            error: 'Your BSC USDT balance is 0 — please send USDT to your wallet before activating.',
            needsAsterAccount: true
          })
        }
        if (bnbBalWei < MIN_BNB_FOR_GAS_WEI) {
          userPk = ''
          return res.status(400).json({
            success: false,
            error: `Activation requires ~0.001 BNB for gas (you have ${(await import('ethers')).ethers.formatEther(bnbBalWei)} BNB). Please send a small amount of BNB to your wallet and tap Activate again.`,
            needsBnb: true
          })
        }

        const dep = await ensureAndDepositUSDT({
          userPrivateKey: userPk,
          amountWei:      usdtBalWei,
          broker:         0n  // BUILD4 broker id (deposit-side); 0 = none for now
        })

        if (!dep.success) {
          userPk = ''
          return res.status(400).json({
            success: false,
            error: `Deposit to Aster failed: ${dep.error ?? 'unknown'}`,
            approveTx: dep.approveTx,
            depositTx: dep.depositTx
          })
        }

        bootstrap = {
          approveTx: dep.approveTx,
          depositTx: dep.depositTx,
          depositedUsdt: (await import('ethers')).ethers.formatUnits(usdtBalWei, 18)
        }

        // Wait briefly for Aster to index the on-chain Deposit event before
        // retrying approveAgent. BSC blocks are ~3s; 5s gives a buffer.
        await new Promise(r => setTimeout(r, 5_000))

        // Retry up to 3 times with 4s spacing — total ~17s wall time worst case.
        for (let attempt = 1; attempt <= 3; attempt++) {
          result = await callApproveAgent()
          if (result.success) break
          if (!looksLikeNoAccount(String(result.error ?? ''))) break  // different error, give up
          console.log(`[/aster/approve] retry ${attempt}/3 — account still indexing`)
          if (attempt < 3) await new Promise(r => setTimeout(r, 4_000))
        }
      } catch (bootstrapErr: any) {
        console.error('[/aster/approve] bootstrap failed:', bootstrapErr)
        userPk = ''
        return res.status(500).json({
          success: false,
          error: `Bootstrap failed: ${bootstrapErr?.message ?? 'unknown'}`
        })
      }
    }

    // Wipe local key reference ASAP. JS GC will collect, but null helps.
    userPk = ''

    if (!result.success) {
      const errStr = String(result.error ?? '').toLowerCase()
      const isNewWallet = looksLikeNoAccount(errStr)
      return res.status(400).json({
        success: false,
        error:           result.error ?? 'approve_failed',
        needsAsterAccount: isNewWallet,
        // If the deposit landed but approveAgent is still indexing, surface tx
        // hashes so support / the user can verify and retry shortly.
        ...(bootstrap ?? {})
      })
    }

    // Persist the per-user agent keypair NOW (before approveBuilder), so even
    // if approveBuilder fails or the process crashes, we still have a record
    // of which agent address Aster has registered for this user. Without this,
    // a retry would generate a NEW agent address and Aster would say "Agent
    // address already exists" for the previous one we forgot.
    const encryptedAgentPk = encryptPrivateKey(agentWallet.privateKey, user.id)
    await db.user.update({
      where: { id: user.id },
      data: {
        asterAgentAddress:     agentWallet.address,
        asterAgentEncryptedPK: encryptedAgentPk,
      }
    })

    // Best-effort: enroll our broker so trades carry the BUILD4 fee. If this
    // fails we still mark the user as onboarded — they can trade without a
    // builder fee, and we can retry later. We don't block activation on it.
    let builderEnrolled = false
    try {
      const br = await approveBuilder({
        userAddress:    wallet.address,
        userPrivateKey: userPk || decryptPrivateKey(wallet.encryptedPK, user.id),
        builderAddress,
        maxFeeRate:     feeRate,
        builderName:    'BUILD4'
      })
      builderEnrolled = br.success
      if (!br.success) {
        console.warn('[/aster/approve] approveBuilder failed (non-fatal):', br.error)
      }
    } catch (e: any) {
      console.warn('[/aster/approve] approveBuilder threw (non-fatal):', e?.message)
    }

    userPk = ''

    await db.user.update({
      where: { id: user.id },
      data:  { asterOnboarded: true }
    })

    return res.json({
      success: true,
      message: bootstrap
        ? `Deposited ${bootstrap.depositedUsdt} USDT to Aster and activated trading`
        : 'Trading account activated',
      builderEnrolled,
      ...(bootstrap ?? {})
    })
  } catch (err: any) {
    console.error('[API] /aster/approve failed:', err)
    if (res.headersSent) return
    res.status(500).json({ success: false, error: err?.message ?? 'Internal error' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Aster transfer — POST /api/aster/transfer
// Body: { amount: string, direction: 'to_aster' | 'to_bsc' }
// Moves USDT between the user's BSC wallet and their Aster futures account
// using the platform agent signature (no user key needed).
// ─────────────────────────────────────────────────────────────────────────────
const transferLocks = new Map<string, Promise<unknown>>()
function withTransferLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = transferLocks.get(userId) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  transferLocks.set(userId, next)
  next.finally(() => {
    if (transferLocks.get(userId) === next) transferLocks.delete(userId)
  })
  return next
}

app.post('/api/aster/transfer', requireTgUser, async (req, res) => {
  const user = (req as any).user
  try {
    await withTransferLock(user.id, async () => {
      const { amount, direction } = req.body ?? {}
      const amt = Number(amount)
      if (!Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({ success: false, error: 'Invalid amount' })
      }
      if (direction !== 'to_aster' && direction !== 'to_bsc') {
        return res.status(400).json({ success: false, error: 'Invalid direction' })
      }
      if (!user.asterOnboarded) {
        return res.status(400).json({ success: false, error: 'Activate trading account first', needsApprove: true })
      }

      const wallet = await db.wallet.findFirst({ where: { userId: user.id, isActive: true } })
      if (!wallet || !wallet.encryptedPK) {
        return res.status(404).json({ success: false, error: 'No active wallet' })
      }

      // ── BSC → Aster: this is an ON-CHAIN deposit (USDT.approve + Vault.deposit
      //    on BSC). Aster's /fapi/v3/asset/wallet/transfer with SPOT_FUTURE only
      //    moves between Aster's INTERNAL spot↔futures wallets — it does not
      //    touch BSC. Using it for new users with funds on-chain returns -5010
      //    "internal error" because there's no Aster-spot balance to move.
      if (direction === 'to_aster') {
        const { decryptPrivateKey } = await import('./services/wallet')
        const { ensureAndDepositUSDT, MIN_BNB_FOR_GAS_WEI, getProvider } = await import('./services/asterDeposit')
        const { ethers } = await import('ethers')

        let userPk: string | null = null
        let lastErr: any = null
        // Try both Prisma user.id (new wallets) and telegramId as string (migrated legacy wallets)
        const idCandidates = [user.id, user.telegramId?.toString()].filter(Boolean) as string[]
        for (const candidate of idCandidates) {
          try {
            const out = decryptPrivateKey(wallet.encryptedPK, candidate)
            if (out && out.startsWith('0x')) { userPk = out; break }
          } catch (e) { lastErr = e }
        }
        if (!userPk) {
          const blob = wallet.encryptedPK ?? ''
          const parts = blob.split(':')
          const partLens = parts.map(p => p.length).join(',')
          const isCryptoJs = blob.startsWith('U2FsdGVk')
          const fmt = parts.length === 1 ? (isCryptoJs ? 'cryptojs(salted)' : 'cryptojs(raw)')
                    : parts.length === 2 ? 'node-crypto(iv:data)'
                    : parts.length === 3 ? 'node-crypto(salt:iv:data PBKDF2)'
                    : `unknown(${parts.length}-part)`
          console.error(`[transfer] decrypt failed user=${user.id} tg=${user.telegramId} wallet=${wallet.address} fmt=${fmt} totalLen=${blob.length} partLens=${partLens} head=${blob.slice(0,16)} err=${lastErr?.message}`)
          return res.status(500).json({
            success: false,
            error: 'Could not decrypt wallet',
            debug: { fmt, totalLen: blob.length, partLens, head: blob.slice(0,16), tried: idCandidates.length, reason: lastErr?.message ?? 'unknown' }
          })
        }

        const provider = getProvider()
        const bnbBal = await provider.getBalance(wallet.address)
        if (bnbBal < MIN_BNB_FOR_GAS_WEI) {
          return res.status(400).json({
            success: false,
            error: `Need ~0.001 BNB for gas (you have ${ethers.formatEther(bnbBal)} BNB).`
          })
        }

        const amountWei = ethers.parseUnits(amt.toString(), 18)
        const dep = await ensureAndDepositUSDT({
          userPrivateKey: userPk,
          amountWei,
          broker:         0n
        })
        userPk = ''

        if (!dep.success) {
          return res.status(400).json({
            success: false,
            error: dep.error ?? 'deposit_failed',
            approveTx: dep.approveTx,
            depositTx: dep.depositTx
          })
        }
        return res.json({
          success:   true,
          tranId:    dep.depositTx,
          approveTx: dep.approveTx,
          depositTx: dep.depositTx
        })
      }

      // ── Aster → BSC: use Aster's signed FUTURE_SPOT transfer (internal),
      //    which Aster surfaces back to the user's BSC wallet automatically.
      const { resolveAgentCreds, transferAsset } = await import('./services/aster')
      const creds = await resolveAgentCreds(user, wallet.address)
      if (!creds) return res.status(500).json({ success: false, error: 'Agent not configured for this user' })

      const result = await transferAsset(creds, amt.toString(), 'FUTURE_SPOT')
      if (!result.success) {
        return res.status(400).json({ success: false, error: result.error ?? 'transfer_failed' })
      }
      return res.json({ success: true, tranId: result.tranId })
    })
  } catch (err: any) {
    if (res.headersSent) return
    console.error('[API] /aster/transfer failed:', err)
    res.status(500).json({ success: false, error: err?.message ?? 'Internal error' })
  }
})

// Per-user mutex for withdrawals — prevents double-spend if a client
// fires concurrent requests before the first tx is broadcast.
const withdrawLocks = new Map<string, Promise<unknown>>()
function withWithdrawLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = withdrawLocks.get(userId) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  withdrawLocks.set(userId, next)
  next.finally(() => {
    if (withdrawLocks.get(userId) === next) withdrawLocks.delete(userId)
  })
  return next
}

// Withdraw USDT (BEP-20) from the user's active wallet to an external address.
// Body: { to: string, amount: number, pin?: string }
app.post('/api/me/withdraw', requireTgUser, async (req, res) => {
  const user = (req as any).user
  try {
    await withWithdrawLock(user.id, async () => {
    const { ethers } = await import('ethers')
    const { decryptPrivateKey } = await import('./services/wallet')
    const { verifyPin, logSecurityEvent, checkPinFailLimit } = await import('./services/security')

    const { to, amount, pin } = req.body ?? {}

    // ── Input validation ─────────────────────────────────────────────
    if (typeof to !== 'string' || !ethers.isAddress(to)) {
      return res.status(400).json({ error: 'Invalid destination address' })
    }
    const amt = Number(amount)
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: 'Invalid amount' })
    }
    if (amt < 1) {
      return res.status(400).json({ error: 'Minimum withdrawal is 1 USDT' })
    }

    const wallet = await db.wallet.findFirst({ where: { userId: user.id, isActive: true } })
    if (!wallet || !wallet.encryptedPK) {
      return res.status(404).json({ error: 'No active wallet' })
    }

    // ── PIN gate (with brute-force lockout) ──────────────────────────
    if (user.pinHash) {
      const limit = await checkPinFailLimit(user.id)
      if (!limit.allowed) {
        return res.status(429).json({ error: 'Too many wrong PIN attempts. Try again in an hour.' })
      }
      if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) {
        return res.status(401).json({ error: 'PIN required', pinRequired: true })
      }
      if (!user.pinSalt || !verifyPin(pin, user.pinHash, user.pinSalt)) {
        // Log under 'pin_failed' so it counts against checkPinFailLimit (which
        // tracks pin_failed + pk_export_denied_bad_pin across the user's hour).
        await logSecurityEvent({ userId: user.id, telegramId: user.telegramId, action: 'pin_failed', walletId: wallet.id, meta: { source: 'withdraw' } })
        return res.status(401).json({ error: 'Wrong PIN' })
      }
    }

    // ── Decrypt PK and build tx ──────────────────────────────────────
    const BSC_RPC = process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org'
    const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955'
    const provider = new ethers.JsonRpcProvider(BSC_RPC)
    const pk = decryptPrivateKey(wallet.encryptedPK, user.id, user.pinHash ? pin : undefined)
    if (!pk || !pk.startsWith('0x')) {
      return res.status(500).json({ error: 'Could not decrypt wallet' })
    }
    const signer = new ethers.Wallet(pk, provider)

    // ── Pre-flight: USDT and BNB-for-gas ────────────────────────────
    const usdt = new ethers.Contract(USDT_BSC, [
      'function balanceOf(address) view returns (uint256)',
      'function transfer(address to, uint256 amount) returns (bool)'
    ], signer)
    const [usdtWei, bnbWei, feeData] = await Promise.all([
      usdt.balanceOf(wallet.address),
      provider.getBalance(wallet.address),
      provider.getFeeData()
    ])
    const amountWei = ethers.parseUnits(amt.toString(), 18)
    if (usdtWei < amountWei) {
      return res.status(400).json({
        error: `Insufficient USDT. Wallet holds ${ethers.formatUnits(usdtWei, 18)}.`
      })
    }
    // ERC-20 transfer typically uses ~55k gas. We require ~3x that as headroom.
    const gasPrice = feeData.gasPrice ?? ethers.parseUnits('1', 'gwei')
    const minBnbForGas = gasPrice * 200_000n
    if (bnbWei < minBnbForGas) {
      return res.status(400).json({
        error: `Need ~${ethers.formatEther(minBnbForGas)} BNB for gas. Wallet has ${ethers.formatEther(bnbWei)} BNB. Send a tiny amount of BNB to your wallet first.`,
        needsBnb: true
      })
    }

    // ── Send tx ──────────────────────────────────────────────────────
    const tx = await usdt.transfer(to, amountWei)
    await logSecurityEvent({
      userId: user.id, telegramId: user.telegramId, action: 'withdraw_sent',
      walletId: wallet.id, meta: { to, amount: amt, txHash: tx.hash }
    })
    // Don't await receipt — return optimistically with hash so the user gets
    // immediate feedback. Frontend can poll the explorer link.
    res.json({
      success: true,
      txHash: tx.hash,
      explorerUrl: `https://bscscan.com/tx/${tx.hash}`
    })
    })
  } catch (err: any) {
    if (res.headersSent) return
    console.error('[API] /me/withdraw failed:', err)
    res.status(500).json({ error: err?.shortMessage ?? err?.message ?? 'Internal error' })
  }
})

app.get('/api/agents/:userId', async (req, res) => {
  try {
    const raw = req.params.userId
    // Mini app passes Telegram numeric ID; bot passes internal UUID. Support both.
    let internalUserId = raw
    if (/^\d+$/.test(raw)) {
      const u = await db.user.findUnique({ where: { telegramId: BigInt(raw) } })
      if (!u) return res.json([])
      internalUserId = u.id
    }
    const agents = await db.agent.findMany({
      where: { userId: internalUserId },
      orderBy: { createdAt: 'desc' }
    })
    res.json(agents)
  } catch (err) {
    console.error('[API] /agents failed:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

app.post('/api/agents/:id/toggle', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    if (!user) return res.status(401).json({ error: 'Unauthenticated' })

    const agentId = String(req.params.id)
    const agent = await db.agent.findUnique({ where: { id: agentId } })
    if (!agent) return res.status(404).json({ error: 'Agent not found' })

    // Ownership check — caller must own the agent they're toggling.
    if (agent.userId !== user.id) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    const updated = await db.agent.update({
      where: { id: agentId },
      data: { isActive: !agent.isActive, isPaused: false }
    })
    res.json(updated)
  } catch {
    res.status(500).json({ error: 'Internal error' })
  }
})

app.get('/api/trades/:userId', async (req, res) => {
  try {
    const raw = req.params.userId
    let internalUserId = raw
    if (/^\d+$/.test(raw)) {
      const u = await db.user.findUnique({ where: { telegramId: BigInt(raw) } })
      if (!u) return res.json([])
      internalUserId = u.id
    }
    const trades = await db.trade.findMany({
      where: { userId: internalUserId },
      orderBy: [{ status: 'asc' }, { openedAt: 'desc' }],
      take: 100,
      include: { agent: { select: { name: true } } }
    })

    let livePositions: any[] = []
    let asterHistory: any[] = []
    try {
      const dbUser = await db.user.findUnique({
        where: { id: internalUserId },
        include: { wallets: { where: { isActive: true }, take: 1 } }
      })
      const wallet = dbUser?.wallets[0]
      if (dbUser && wallet) {
        const { resolveAgentCreds, getPositions, getUserTrades } = await import('./services/aster')
        const creds = await resolveAgentCreds(dbUser, wallet.address)
        if (creds) {
          const [positions, userTrades] = await Promise.all([
            getPositions(creds),
            getUserTrades(creds, { limit: 100 })
          ])
          livePositions = positions.map((p: any) => ({
            symbol: p.symbol,
            positionAmt: p.side === 'LONG' ? p.size : -p.size,
            entryPrice: p.entryPrice,
            markPrice: p.markPrice ?? p.entryPrice,
            unRealizedProfit: p.unrealizedPnl ?? 0,
            leverage: p.leverage ?? 1
          }))
          asterHistory = userTrades
        }
      }
    } catch (e) {
      console.warn('[API] /trades live positions skipped:', (e as Error).message)
    }

    const liveBySymbol = new Map(livePositions.map(p => [p.symbol, p]))

    const result = trades.map(t => {
      const symbol = t.pair.replace('/', '')
      const live = liveBySymbol.get(symbol)
      const isOpen = t.status === 'open'
      return {
        id: t.id,
        pair: t.pair,
        side: t.side,
        size: t.size,
        entryPrice: t.entryPrice,
        leverage: t.leverage,
        pnl: isOpen && live ? live.unRealizedProfit : t.pnl,
        status: t.status,
        agentName: t.agent?.name
      }
    })

    const knownSymbols = new Set(
      trades.filter(t => t.status === 'open').map(t => t.pair.replace('/', ''))
    )
    for (const live of livePositions) {
      if (knownSymbols.has(live.symbol)) continue
      const side = live.positionAmt > 0 ? 'LONG' : 'SHORT'
      result.unshift({
        id: `live_${live.symbol}`,
        pair: live.symbol,
        side,
        size: Math.abs(live.positionAmt) * live.entryPrice,
        entryPrice: live.entryPrice,
        leverage: live.leverage,
        pnl: live.unRealizedProfit,
        status: 'open',
        agentName: undefined
      })
    }

    // Closing fills from Aster — anything with realized PnL is a real close.
    // Surface as "closed" rows so users see actual trade history even when
    // SL/TP/manual closes never made it back to our DB.
    const dbClosedKeys = new Set(
      trades
        .filter(t => t.status === 'closed' && t.closedAt)
        .map(t => `${t.pair.replace('/', '')}_${Math.floor(new Date(t.closedAt!).getTime() / 60000)}`)
    )
    const closingFills = asterHistory
      .filter(f => f.realizedPnl !== 0)
      .sort((a, b) => b.time - a.time)
      .slice(0, 50)

    for (const fill of closingFills) {
      const dedupeKey = `${fill.symbol}_${Math.floor(fill.time / 60000)}`
      if (dbClosedKeys.has(dedupeKey)) continue
      const side = fill.positionSide === 'LONG' || (fill.positionSide === 'BOTH' && fill.side === 'SELL')
        ? 'LONG' : 'SHORT'
      result.push({
        id: `aster_${fill.orderId}`,
        pair: fill.symbol,
        side,
        size: fill.quoteQty,
        entryPrice: fill.price,
        leverage: 1,
        pnl: fill.realizedPnl,
        status: 'closed',
        agentName: undefined
      })
    }

    res.json(result)
  } catch (err) {
    console.error('[API] /trades failed:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

app.get('/api/portfolio/:userId', async (req, res) => {
  try {
    const raw = req.params.userId
    let internalUserId = raw
    if (/^\d+$/.test(raw)) {
      const u = await db.user.findUnique({ where: { telegramId: BigInt(raw) } })
      if (!u) return res.json({ portfolio: null, trades: [] })
      internalUserId = u.id
    }
    const [portfolio, trades] = await Promise.all([
      db.portfolio.findUnique({ where: { userId: internalUserId } }),
      db.trade.findMany({
        where: { userId: internalUserId },
        orderBy: { openedAt: 'desc' },
        take: 50
      })
    ])
    res.json({ portfolio, trades })
  } catch (err) {
    console.error('[API] /portfolio failed:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

app.get('/api/leaderboard', async (_req, res) => {
  try {
    const users = await db.user.findMany({
      include: {
        trades: {
          where: { status: 'closed' },
          select: { pnl: true, closedAt: true }
        }
      },
      take: 50
    })

    const ranked = users
      .map((u) => {
        const totalPnl = u.trades.reduce((s, t) => s + (t.pnl ?? 0), 0)
        const wins = u.trades.filter((t) => (t.pnl ?? 0) > 0).length
        const winRate = u.trades.length > 0 ? (wins / u.trades.length) * 100 : 0
        const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000)
        const pnl30d = u.trades
          .filter((t) => t.closedAt && t.closedAt >= thirtyDaysAgo)
          .reduce((s, t) => s + (t.pnl ?? 0), 0)

        return {
          id: u.id,
          username: u.username ?? `User_${u.id.slice(0, 6)}`,
          totalTrades: u.trades.length,
          totalPnl,
          pnl30d,
          winRate
        }
      })
      .filter((u) => u.totalTrades > 0)
      .sort((a, b) => b.pnl30d - a.pnl30d)
      .slice(0, 10)

    res.json(ranked)
  } catch {
    res.status(500).json({ error: 'Internal error' })
  }
})

// ─── Admin: editable AI cost rates (Task #23) ───
app.get('/api/me/admin', requireTgUser, async (req, res) => {
  const user = (req as any).user
  res.json({ isAdmin: isAdminTelegramId(user.telegramId) })
})

app.get('/api/admin/cost-rates', requireAdmin, async (_req, res) => {
  try {
    const { listCostRates } = await import('./services/costRates')
    const rates = await listCostRates()
    res.json({ rates })
  } catch (err) {
    console.error('[API] /admin/cost-rates GET failed:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

app.put('/api/admin/cost-rates/:provider', requireAdmin, async (req, res) => {
  try {
    const { upsertCostRate } = await import('./services/costRates')
    const provider = String(req.params.provider ?? '').toLowerCase()
    const rate = Number(req.body?.usdPer1MTokens)
    const user = (req as any).user
    // requireAdmin allows two auth paths: a Telegram admin (user attached)
    // or the ADMIN_TOKEN shared secret (no user). Record an actor either way.
    const changedBy = user ? String(user.telegramId) : 'admin-token'
    await upsertCostRate(provider, rate, changedBy)
    res.json({ ok: true })
  } catch (err: any) {
    const msg = err?.message ?? 'Internal error'
    const status = /Invalid|must be/.test(msg) ? 400 : 500
    if (status === 500) console.error('[API] /admin/cost-rates PUT failed:', err)
    res.status(status).json({ error: msg })
  }
})

app.delete('/api/admin/cost-rates/:provider', requireAdmin, async (req, res) => {
  try {
    const { deleteCostRate } = await import('./services/costRates')
    await deleteCostRate(String(req.params.provider ?? '').toLowerCase())
    res.json({ ok: true })
  } catch (err) {
    console.error('[API] /admin/cost-rates DELETE failed:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

// ──────────────────────────────────────────────────────────────────────────
// Market-creator admin endpoints. The autonomous agent populates a queue
// of researched/Claude-evaluated proposals; admin reviews and submits them
// to 42.space (manual handoff until 42.space exposes a creation API).
// All routes are gated by requireAdmin (Telegram-id allowlist).
// ──────────────────────────────────────────────────────────────────────────
app.get('/api/admin/market-proposals', requireAdmin, async (req, res) => {
  try {
    const { listProposals } = await import('./services/marketProposalStore')
    const status = req.query.status
      ? String(req.query.status).split(',') as any
      : undefined
    const limit = req.query.limit ? Math.min(200, Number(req.query.limit) || 50) : 50
    const proposals = await listProposals({ status, limit })
    res.json({ proposals })
  } catch (err) {
    console.error('[API] /admin/market-proposals GET failed:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

app.post('/api/admin/market-proposals/:id/status', requireAdmin, async (req, res) => {
  try {
    const { updateProposalStatus, getProposalById } = await import('./services/marketProposalStore')
    const id = String(req.params.id)
    const status = String(req.body?.status ?? '')
    if (!['approved', 'rejected', 'submitted', 'live'].includes(status)) {
      return res.status(400).json({ error: 'invalid status' })
    }
    const existing = await getProposalById(id)
    if (!existing) return res.status(404).json({ error: 'not found' })
    let marketAddress: string | undefined
    if (req.body?.marketAddress) {
      const ma = String(req.body.marketAddress).trim()
      // Lightweight EVM-address sanity check — 0x followed by 40 hex chars.
      // We don't checksum-validate here; the on-chain side will reject
      // anything malformed when actually used.
      if (!/^0x[a-fA-F0-9]{40}$/.test(ma)) {
        return res.status(400).json({ error: 'marketAddress must be a 0x-prefixed 40-char hex string' })
      }
      marketAddress = ma
    }
    if (status === 'live' && !marketAddress) {
      return res.status(400).json({ error: 'marketAddress is required when status=live' })
    }
    await updateProposalStatus(id, status as any, { marketAddress })
    const updated = await getProposalById(id)
    res.json({ proposal: updated })
  } catch (err) {
    console.error('[API] /admin/market-proposals status update failed:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

// On-demand pipeline run. Useful for the partnership demo: an admin can
// kick the agent live and watch new proposals show up. Long-running
// (~10-30s with Claude); we don't await it on the response so the HTTP
// call returns immediately.
app.post('/api/admin/market-creator/run', requireAdmin, async (_req, res) => {
  try {
    const { runMarketCreator } = await import('./agents/marketCreator')
    // Fire and forget — pipeline takes 10-30s with the Claude eval. The
    // admin who triggered this can poll GET /api/admin/market-proposals to
    // see the new rows, so we skip the Telegram alert on this on-demand
    // path (alerts are reserved for the future cron-driven runs).
    runMarketCreator().catch((err) => {
      console.error('[marketCreator] background run failed:', err)
    })
    res.json({ ok: true, message: 'market-creator run started' })
  } catch (err) {
    console.error('[API] /admin/market-creator/run failed:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

// Force a real, on-chain prediction-market trade RIGHT NOW for partnership
// demos. Picks the highest-volume live 42.space market, reads its outcomes
// on-chain, picks the highest-implied-probability outcome (most liquid side),
// and opens a small position from the calling admin's wallet via the same
// `openManualPredictionPosition` path the mini-app uses. This is the
// safety-net trigger so a demo never has to wait for Claude's autonomous
// edge-detection to fire.
//
// Body (all optional):
//   { usdtAmount?: number = 2, marketAddress?: string, tokenId?: number }
// If marketAddress/tokenId are supplied, we skip auto-selection and trade
// exactly that outcome.
//
// The admin MUST be authenticated via Telegram initData (the ADMIN_TOKEN
// shared-secret path attaches no user, so it can't open a position). The
// caller's own BSC wallet funds the trade.
app.post('/api/admin/predictions/force-demo-trade', requireAdmin, async (req, res) => {
  try {
    const user = (req as any).user as { id: string } | undefined
    if (!user?.id) {
      return res.status(400).json({
        error: 'force-demo-trade requires Telegram-authenticated admin (not ADMIN_TOKEN), so the trade can be funded from the admin wallet',
      })
    }

    const body = (req.body ?? {}) as {
      usdtAmount?: number
      marketAddress?: string
      tokenId?: number
    }
    const usdtAmount = Number.isFinite(body.usdtAmount) ? Number(body.usdtAmount) : 2

    let marketAddress = body.marketAddress
    let tokenId = body.tokenId

    if (!marketAddress || !Number.isFinite(tokenId)) {
      const { getAllMarkets } = await import('./services/fortyTwo')
      const { readMarketOnchain } = await import('./services/fortyTwoOnchain')

      const markets = await getAllMarkets({
        status: 'live',
        limit: 10,
        order: 'volume',
        ascending: false,
      })
      if (markets.length === 0) {
        return res.status(503).json({ error: 'no live 42.space markets available' })
      }

      // Walk down the volume-ranked list until we find a market we can read
      // on-chain with at least one tradable outcome.
      let chosen: { market: typeof markets[number]; tokenId: number; label: string } | null = null
      for (const m of markets) {
        try {
          const state = await readMarketOnchain(m)
          if (state.isFinalised) continue
          const tradable = state.outcomes.filter((o) => o.impliedProbability > 0)
          if (tradable.length === 0) continue
          // Highest implied prob = most liquid side = lowest slippage for a
          // small demo trade.
          const best = tradable.reduce((a, b) =>
            b.impliedProbability > a.impliedProbability ? b : a,
          )
          chosen = { market: m, tokenId: best.tokenId, label: best.label }
          break
        } catch (err) {
          console.warn(`[force-demo-trade] skip market ${m.address}:`, err)
        }
      }

      if (!chosen) {
        return res.status(503).json({ error: 'no tradable live markets found (all unreadable or finalised)' })
      }
      marketAddress = chosen.market.address
      tokenId = chosen.tokenId
      console.log(
        `[force-demo-trade] auto-selected market ${marketAddress} outcome "${chosen.label}" (tokenId=${tokenId})`,
      )
    }

    const { openManualPredictionPosition } = await import('./services/fortyTwoExecutor')
    const result = await openManualPredictionPosition({
      userId: user.id,
      marketAddress: marketAddress!,
      tokenId: Number(tokenId),
      usdtAmount,
    })

    if (!result.ok) {
      console.warn('[force-demo-trade] openManualPredictionPosition refused:', result.reason)
      return res.status(400).json({ ok: false, reason: result.reason })
    }
    console.log(`[force-demo-trade] opened position ${result.positionId} tx=${result.txHash}`)
    res.json({
      ok: true,
      positionId: result.positionId,
      txHash: result.txHash,
      marketAddress,
      tokenId,
      usdtAmount,
    })
  } catch (err) {
    console.error('[API] /admin/predictions/force-demo-trade failed:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

app.get('/api/signals', async (_req, res) => {
  const { getLatestSignals } = await import('./services/signals')
  const signals = await getLatestSignals(10)
  res.json(signals)
})

// ──────────────────────────────────────────────────────────────────────────
// /api/predictions/latest — feeds the mini-app Predictions tab
//
// Composes three real data sources:
//   1. Most recent live swarm-driven prediction position (same row as
//      /showcase) → swarm hero card with per-provider verdicts.
//   2. Recent open OutcomePosition rows across all users (anonymous, demo
//      surface) → positions table.
//   3. Live 42.space markets via the REST API → market scanner.
//
// Public (no auth) — every field rendered is already public information
// (on-chain tx hashes, public market data). No telegramId required so the
// 42.space team can preview the page without a Telegram session.
// ──────────────────────────────────────────────────────────────────────────
// 60s in-memory cache for the 42.space markets list. The Predictions tab
// auto-refreshes every 30s; without this we'd hit 42.space twice a minute
// per active viewer and risk rate-limiting.
const predictionScannerCache: {
  value: Array<{
    marketTitle: string
    marketAddress: string
    category: string
    startDate: string
    endDate: string
    elapsedPct: number
    volume: number
    traders: number
  }>
  fetchedAt: number
} = { value: [], fetchedAt: 0 }

app.get('/api/predictions/latest', async (_req, res) => {
  const startedAt = Date.now()
  try {
    const { getMostRecentLiveSwarmPrediction } = await import('./services/fortyTwoExecutor')

    // ── Swarm hero ──
    const swarmPos = await getMostRecentLiveSwarmPrediction()
    let swarm: any = null
    if (swarmPos) {
      const providers = (Array.isArray(swarmPos.providers) ? swarmPos.providers : []) as Array<{
        provider: string
        model?: string | null
        action?: string
        predictionTrade?: { conviction?: number } | null
        reasoning?: string | null
        latencyMs: number
        tokensUsed: number
        inputTokens?: number
        outputTokens?: number
      }>
      const consensusYes = swarmPos.entryPrice >= 0.5
      const agents = providers.map((p) => {
        const conv = p.predictionTrade?.conviction
        const probability = typeof conv === 'number' ? conv : swarmPos.entryPrice
        const verdict: 'YES' | 'NO' = probability >= 0.5 ? 'YES' : 'NO'
        // Pre-Task #24 telemetry rows only carry tokensUsed (no split). Match
        // the conservative attribution used by getSwarmStats: count it all as
        // output tokens. Newer rows carry both inputTokens/outputTokens.
        const hasSplit = typeof p.inputTokens === 'number' || typeof p.outputTokens === 'number'
        const inputTokens = hasSplit ? (p.inputTokens ?? 0) : 0
        const outputTokens = hasSplit ? (p.outputTokens ?? 0) : (p.tokensUsed ?? 0)
        return {
          name: p.provider,
          model: p.model ?? null,
          verdict,
          probability,
          reasoning: (p.reasoning ?? '').replace(/\s+/g, ' ').trim(),
          latencyMs: p.latencyMs ?? 0,
          tokens: p.tokensUsed ?? (inputTokens + outputTokens),
          inputTokens,
          outputTokens,
          matchesConsensus: verdict === (consensusYes ? 'YES' : 'NO'),
          error: null as string | null,
        }
      })
      const totalInputTokens = agents.reduce((s, a) => s + a.inputTokens, 0)
      const totalOutputTokens = agents.reduce((s, a) => s + a.outputTokens, 0)
      const totalTokens = agents.reduce((s, a) => s + a.tokens, 0)
      const avgLatencyMs =
        agents.length > 0 ? Math.round(agents.reduce((s, a) => s + a.latencyMs, 0) / agents.length) : 0
      const matching = agents.filter((a) => a.matchesConsensus).length
      const confidenceScore = agents.length > 0 ? matching / agents.length : 0

      swarm = {
        marketTitle: swarmPos.marketTitle,
        marketAddress: swarmPos.marketAddress,
        outcomeLabel: swarmPos.outcomeLabel,
        consensus: consensusYes ? 'YES' : 'NO',
        impliedProbability: swarmPos.entryPrice,
        confidenceScore,
        agentCount: agents.length,
        avgLatencyMs,
        totalTokens,
        totalInputTokens,
        totalOutputTokens,
        usdtIn: swarmPos.usdtIn,
        reasoning: (swarmPos.reasoning ?? '').replace(/\s+/g, ' ').trim(),
        txHash: swarmPos.txHashOpen,
        openedAt: swarmPos.openedAt,
        agents,
      }
    }

    // ── Positions table — anonymous, recent across all users ──
    // NOTE: this endpoint is unauthenticated and aggregates positions across
    // all users for the demo. We deliberately DO NOT include the per-position
    // txHashOpen here — exposing it would let any caller resolve the wallet
    // address on BscScan and trace a Telegram user's full on-chain history.
    // The single swarm-hero card above keeps its txHash because that row is
    // already public via /showcase and identifies the swarm trade, not a user.
    const posRows = await db.$queryRawUnsafe<Array<{
      id: string
      marketAddress: string
      marketTitle: string
      tokenId: number
      outcomeLabel: string
      usdtIn: number
      entryPrice: number
      exitPrice: number | null
      pnl: number | null
      status: string
      paperTrade: boolean
      openedAt: Date
      closedAt: Date | null
    }>>(
      `SELECT id,"marketAddress","marketTitle","tokenId","outcomeLabel","usdtIn","entryPrice",
              "exitPrice",pnl,status,"paperTrade","openedAt","closedAt"
       FROM "OutcomePosition"
       WHERE "paperTrade" = false
       ORDER BY "openedAt" DESC
       LIMIT 20`,
    )
    const positions = posRows.map((p) => {
      let mappedStatus: 'open' | 'resolved' | 'claimable' | 'claimed'
      if (p.status === 'open') mappedStatus = 'open'
      else if (p.status === 'resolved_win') mappedStatus = 'claimable'
      else if (p.status === 'closed') mappedStatus = 'claimed'
      else mappedStatus = 'resolved'
      return {
        marketTitle: p.marketTitle,
        marketAddress: p.marketAddress,
        tokenId: p.tokenId,
        outcome: p.outcomeLabel,
        entryPrice: p.entryPrice,
        currentPrice: p.exitPrice ?? p.entryPrice,
        pnlUsdt: p.pnl ?? 0,
        usdtIn: p.usdtIn,
        openedAt: p.openedAt,
        // txHash intentionally omitted — see note above.
        txHash: null as string | null,
        status: mappedStatus,
      }
    })

    // ── Market scanner — live 42.space markets, cached 60s in-memory ──
    let apiStatus: 'live' | 'stale' | 'down' = 'live'
    let scanner = predictionScannerCache.value
    const cacheAge = Date.now() - predictionScannerCache.fetchedAt
    if (cacheAge > 60_000) {
      try {
        const { getAllMarkets } = await import('./services/fortyTwo')
        const markets = await getAllMarkets({ status: 'live', limit: 25, order: 'volume', ascending: false })
        scanner = markets.map((m) => ({
          marketTitle: m.question,
          marketAddress: m.address,
          category: (m.categories ?? [])[0] ?? 'uncategorized',
          startDate: m.startDate,
          endDate: m.endDate,
          elapsedPct: m.elapsedPct,
          // Activity metrics — null/undefined coerced to 0 so the mini-app
          // sort comparators are deterministic. `traders` is the unique
          // participant count surfaced by the 42.space markets endpoint
          // (rendered as "entries" in the UI).
          volume: typeof m.volume === 'number' ? m.volume : 0,
          traders: typeof m.traders === 'number' ? m.traders : 0,
        }))
        predictionScannerCache.value = scanner
        predictionScannerCache.fetchedAt = Date.now()
      } catch (err) {
        console.warn('[predictions/latest] 42.space markets fetch failed:', (err as Error).message)
        // Serve stale cache if we have one, mark API as stale; otherwise down.
        apiStatus = scanner.length > 0 ? 'stale' : 'down'
      }
    }

    res.json({
      swarm,
      positions,
      scanner,
      meta: {
        apiStatus,
        lastFetchedAt: new Date().toISOString(),
        marketsTracked: scanner.length,
        responseTimeMs: Date.now() - startedAt,
      },
    })
  } catch (err) {
    console.error('[predictions/latest] failed:', (err as Error).message)
    res.status(500).json({ error: 'Internal error' })
  }
})

// ──────────────────────────────────────────────────────────────────────────
// GET /api/predictions/market/:address
// On-demand outcome detail for a single 42.space market. Reads marginal
// prices straight off the bonding curve (cached 30s by getOutcomePrices),
// so the scanner row in the mini-app can show real per-outcome probabilities
// when a user taps a market — without us having to fan out 25 reads on
// every /api/predictions/latest poll.
// Public (read-only, all data is on-chain).
// ──────────────────────────────────────────────────────────────────────────
const predictionMarketCache = new Map<string, {
  payload: { market: { address: string; question: string; status: string; endDate: string; category: string }
                outcomes: Array<{ tokenId: number; label: string; priceFloat: number; impliedProbability: number; isWinner: boolean }> }
  fetchedAt: number
}>()
const MARKET_DETAIL_TTL_MS = 30_000

app.get('/api/predictions/market/:address', async (req, res) => {
  const address = req.params.address
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({ error: 'invalid_market_address' })
  }
  const cached = predictionMarketCache.get(address.toLowerCase())
  if (cached && Date.now() - cached.fetchedAt < MARKET_DETAIL_TTL_MS) {
    return res.json({ ...cached.payload, cached: true })
  }
  try {
    const [{ getMarketByAddress }, { getOutcomePrices }] = await Promise.all([
      import('./services/fortyTwo'),
      import('./services/fortyTwoOnchain'),
    ])
    const market = await getMarketByAddress(address)
    const outcomes = await getOutcomePrices(market.address, market.curve, market.collateralDecimals)
    const payload = {
      market: {
        address: market.address,
        question: market.question,
        status: market.status,
        endDate: market.endDate,
        category: (market.categories ?? [])[0] ?? 'uncategorized',
      },
      outcomes: outcomes.map((o) => ({
        tokenId: o.tokenId,
        label: o.label,
        priceFloat: o.priceFloat,
        impliedProbability: o.impliedProbability,
        isWinner: o.isWinner,
      })),
    }
    predictionMarketCache.set(address.toLowerCase(), { payload, fetchedAt: Date.now() })
    res.json({ ...payload, cached: false })
  } catch (err) {
    console.warn('[predictions/market] failed for', address, ':', (err as Error).message)
    res.status(502).json({ error: 'market_detail_unavailable' })
  }
})

// Manual user-initiated prediction trade. Triggered when a user taps
// "Place trade" on a market scanner row in the mini-app. Bypasses the
// swarm/conviction gating used by autonomous agents (the user's tap IS
// the conviction) but still applies per-user fat-finger and rate caps.
// Paper-vs-live is governed by the same User.fortyTwoLiveTrade toggle
// that gates agent-driven trades, so a user in paper mode keeps simulating
// regardless of which path opened the position.
// ─── /api/me/predictions-mode ─────────────────────────────────────────────
// Read & toggle the user's paper-vs-live opt-in for 42.space prediction
// trades from the mini-app. Mirrors the /predictions Telegram command's
// "Enable LIVE trading" / "Switch to paper-trade" buttons so users no
// longer have to leave the mini-app to flip the switch. The same
// User.fortyTwoLiveTrade column governs both autonomous-agent trades and
// the manual /api/predictions/buy path, so flipping it here propagates
// to every code path immediately.
app.get('/api/me/predictions-mode', requireTgUser, async (req, res) => {
  const user = (req as any).user
  if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })
  try {
    const { isUserLiveOptedIn } = await import('./services/fortyTwoExecutor')
    const liveOptIn = await isUserLiveOptedIn(user.id)
    res.json({ ok: true, liveOptIn })
  } catch (err) {
    console.error('[API] /me/predictions-mode GET failed:', err)
    res.status(500).json({ ok: false, error: 'lookup failed' })
  }
})

app.post('/api/me/predictions-mode', requireTgUser, async (req, res) => {
  const user = (req as any).user
  if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })
  // Body is intentionally strict: must be an explicit boolean. We don't
  // want a stray `"true"` string or missing field to silently flip a
  // user into live mode against their intent.
  const enabled = req.body?.enabled
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'enabled must be boolean' })
  }
  try {
    const { setUserLiveOptIn } = await import('./services/fortyTwoExecutor')
    await setUserLiveOptIn(user.id, enabled)
    res.json({ ok: true, liveOptIn: enabled })
  } catch (err) {
    console.error('[API] /me/predictions-mode POST failed:', err)
    res.status(500).json({ ok: false, error: 'update failed' })
  }
})

// ──────────────────────────────────────────────────────────────────────────
// GET /api/me/positions — authenticated, user-owned positions for the
// mini-app "Your Positions" section. Returns rows with their cuid `id` so
// the sell/claim endpoints below can reference them. Also opportunistically
// runs settleResolvedPositions(userId) so any newly-finalised markets get
// their status flipped to resolved_win/_loss before we render claim buttons.
// ──────────────────────────────────────────────────────────────────────────
app.get('/api/me/positions', requireTgUser, async (req, res) => {
  const user = (req as any).user
  if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })

  try {
    const exec = await import('./services/fortyTwoExecutor')
    // Best-effort settle — if 42.space / RPC is wedged we still want to show
    // the user their positions, just without the freshest resolution state.
    try { await exec.settleResolvedPositions({ userId: user.id }) } catch {}

    const rows = await exec.listUserPositions(user.id, 50)
    const positions = rows.map((p) => ({
      id: p.id,
      marketTitle: p.marketTitle,
      marketAddress: p.marketAddress,
      tokenId: p.tokenId,
      outcomeLabel: p.outcomeLabel,
      usdtIn: p.usdtIn,
      entryPrice: p.entryPrice,
      exitPrice: p.exitPrice,
      payoutUsdt: p.payoutUsdt,
      pnl: p.pnl,
      status: p.status, // 'open' | 'closed' | 'resolved_win' | 'resolved_loss' | 'claimed'
      paperTrade: p.paperTrade,
      txHashOpen: p.txHashOpen,
      txHashClose: p.txHashClose,
      openedAt: p.openedAt,
      closedAt: p.closedAt,
    }))
    res.setHeader('Cache-Control', 'no-store')
    res.json({ ok: true, positions })
  } catch (err) {
    console.error('[API] /me/positions failed:', err)
    res.status(500).json({ ok: false, error: (err as Error).message })
  }
})

// POST /api/predictions/sell — close (sell back to USDT) one of the
// caller's open positions. Bypasses the per-user kill switch so users can
// always exit live exposure even with new-trade opt-in disabled.
app.post('/api/predictions/sell', requireTgUser, async (req, res) => {
  const user = (req as any).user
  if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })

  const positionId = typeof req.body?.positionId === 'string' ? req.body.positionId : ''
  if (!positionId) return res.status(400).json({ ok: false, error: 'invalid_position_id' })

  try {
    const { closeUserPredictionPosition } = await import('./services/fortyTwoExecutor')
    const result = await closeUserPredictionPosition(user.id, positionId)
    if (!result.ok) return res.status(400).json(result)
    return res.json(result)
  } catch (err) {
    console.error('[API] /predictions/sell failed:', err)
    return res.status(500).json({ ok: false, error: (err as Error).message })
  }
})

// POST /api/predictions/claim — claim payout for one resolved-winning
// position. Implementation calls claimAllResolved on the position's market
// because the on-chain `claimSimple` redeems every winning OT the wallet
// holds for that market regardless; batching by market is the natural unit.
app.post('/api/predictions/claim', requireTgUser, async (req, res) => {
  const user = (req as any).user
  if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })

  const positionId = typeof req.body?.positionId === 'string' ? req.body.positionId : ''
  if (!positionId) return res.status(400).json({ ok: false, error: 'invalid_position_id' })

  try {
    const { db } = await import('./db')
    const rows = await db.$queryRawUnsafe<Array<{ marketAddress: string; status: string }>>(
      `SELECT "marketAddress", status FROM "OutcomePosition"
       WHERE id = $1 AND "userId" = $2 LIMIT 1`,
      positionId,
      user.id,
    )
    if (rows.length === 0) return res.status(404).json({ ok: false, error: 'position_not_found' })
    if (rows[0].status !== 'resolved_win') {
      return res.status(400).json({ ok: false, error: `position not claimable (status=${rows[0].status})` })
    }
    const { claimUserResolvedForMarket } = await import('./services/fortyTwoExecutor')
    const result = await claimUserResolvedForMarket(user.id, rows[0].marketAddress)
    if (!result.ok) return res.status(400).json(result)
    return res.json(result)
  } catch (err) {
    console.error('[API] /predictions/claim failed:', err)
    return res.status(500).json({ ok: false, error: (err as Error).message })
  }
})

// POST /api/predictions/claim-all — sweep every resolved-winning position
// the caller owns, one tx per market. Returns aggregate counts plus any
// per-market errors (so the UI can surface partial-success cases).
app.post('/api/predictions/claim-all', requireTgUser, async (req, res) => {
  const user = (req as any).user
  if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })

  try {
    const { claimAllUserResolved } = await import('./services/fortyTwoExecutor')
    const result = await claimAllUserResolved(user.id)
    return res.json(result)
  } catch (err) {
    console.error('[API] /predictions/claim-all failed:', err)
    return res.status(500).json({ ok: false, error: (err as Error).message })
  }
})

app.post('/api/predictions/buy', requireTgUser, async (req, res) => {
  const user = (req as any).user
  if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })

  const body = req.body ?? {}
  const marketAddress = typeof body.marketAddress === 'string' ? body.marketAddress : ''
  const tokenId = Number(body.tokenId)
  const usdtAmount = Number(body.usdtAmount)

  if (!/^0x[0-9a-fA-F]{40}$/.test(marketAddress)) {
    return res.status(400).json({ ok: false, error: 'invalid_market_address' })
  }
  if (!Number.isFinite(tokenId) || tokenId < 0) {
    return res.status(400).json({ ok: false, error: 'invalid_token_id' })
  }
  if (!Number.isFinite(usdtAmount) || usdtAmount <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid_amount' })
  }

  try {
    const { openManualPredictionPosition } = await import('./services/fortyTwoExecutor')
    const result = await openManualPredictionPosition({
      userId: user.id,
      marketAddress,
      tokenId,
      usdtAmount,
    })
    if (!result.ok) {
      // Caller-fixable validation errors (amount, sizing, wallet) → 400 so
      // the mini-app can surface the reason verbatim. Genuine server errors
      // (RPC, DB) flow through the catch block below as 500s.
      return res.status(400).json(result)
    }
    return res.json(result)
  } catch (err) {
    console.error('[API] /predictions/buy failed:', err)
    return res.status(500).json({ ok: false, error: (err as Error).message })
  }
})

// Read-only swarm divergence stats. Same aggregation as
// scripts/swarmDivergence.ts. Mirrors the CLI's `--days` and `--pair` flags
// as query params. Gated by the shared `requireAdmin` middleware: callers
// must either supply the `ADMIN_TOKEN` via `?token=` / `x-admin-token` header
// or be a Telegram user whose ID is in `ADMIN_TELEGRAM_IDS`.
app.get('/api/admin/swarm-divergence', requireAdmin, async (req, res) => {
  try {
    const days = req.query.days
      ? Math.min(365, Math.max(1, parseInt(String(req.query.days), 10) || 7))
      : 7
    const pair = typeof req.query.pair === 'string' ? req.query.pair : null
    const { analyzeDivergence, MissingProvidersColumnError } = await import('./swarm/divergenceAnalysis')
    try {
      const report = await analyzeDivergence({ days, pair })
      res.setHeader('Cache-Control', 'no-store')
      res.json(report)
    } catch (err) {
      if (err instanceof MissingProvidersColumnError) {
        return res.status(503).json({ error: 'swarm_telemetry_unavailable', detail: err.message })
      }
      throw err
    }
  } catch (err) {
    console.error('[API] /admin/swarm-divergence failed:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

// Per-provider swarm telemetry roll-up (mirrors the /swarmstats Telegram
// command). Public read — same data the bot already exposes in chat, just
// rendered visually in the mini-app dashboard.
app.get('/api/swarm/stats', async (req, res) => {
  try {
    const { getSwarmStats } = await import('./services/swarmStats')
    const raw = String(req.query.window ?? '24h').toLowerCase()
    const window = raw === '7d' || raw === 'week' ? '7d' : '24h'
    const report = await getSwarmStats(window)
    res.json({
      window: report.window,
      since: report.since.toISOString(),
      rows: report.rows
    })
  } catch (err) {
    console.error('[API] /swarm/stats failed:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

// Drill-down companion to /api/admin/swarm-divergence: returns recent
// AgentLog rows (with each provider's vote) so operators can see *which*
// ticks disagreed for a given pair/provider, not just the aggregate %.
app.get('/api/admin/swarm-divergence/samples', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN
  if (adminToken) {
    const supplied = (req.headers['x-admin-token'] as string | undefined)
      ?? (typeof req.query.token === 'string' ? req.query.token : undefined)
    if (supplied !== adminToken) return res.status(401).json({ error: 'Unauthorized' })
  }
  try {
    const days = req.query.days
      ? Math.min(365, Math.max(1, parseInt(String(req.query.days), 10) || 7))
      : 7
    const limit = req.query.limit
      ? Math.min(200, Math.max(1, parseInt(String(req.query.limit), 10) || 25))
      : 25
    const pair = typeof req.query.pair === 'string' ? req.query.pair : null
    const provider = typeof req.query.provider === 'string' ? req.query.provider : null
    const onlyFallback = req.query.onlyFallback === '1' || req.query.onlyFallback === 'true'
    const { getDivergenceSamples, MissingProvidersColumnError } = await import('./swarm/divergenceAnalysis')
    try {
      const result = await getDivergenceSamples({ days, pair, provider, limit, onlyFallback })
      res.setHeader('Cache-Control', 'no-store')
      res.json(result)
    } catch (err) {
      if (err instanceof MissingProvidersColumnError) {
        return res.status(503).json({ error: 'swarm_telemetry_unavailable', detail: err.message })
      }
      throw err
    }
  } catch (err) {
    console.error('[API] /admin/swarm-divergence/samples failed:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

async function main() {
  // Connect DB
  await db.$connect()
  console.log('[DB] Connected')

  // Create new tables safely (no drops, no renames)
  await ensureNewTables()

  // Migrate old users from Drizzle tables to Prisma tables
  await migrateOldUsers()

  // Force every existing agent onto AUTO mode so the multi-pair scanner
  // can actually pick the day's hot pairs instead of being stuck on
  // whatever single pair was set at agent creation time. Idempotent.
  await migrateAgentsToAuto()

  // Create bot
  const bot = createBot()

  // Webhook or polling
  let webhookUrl = process.env.TELEGRAM_WEBHOOK_URL
  if (!webhookUrl && process.env.REPLIT_DOMAINS) {
    const domain = process.env.REPLIT_DOMAINS.split(',')[0].trim()
    if (domain && !domain.includes('.replit.dev')) {
      webhookUrl = `https://${domain}/api/webhook`
    }
  }

  if (webhookUrl) {
    app.post('/api/webhook', async (req, res) => {
      try {
        await bot.handleUpdate(req.body)
        res.sendStatus(200)
      } catch (err) {
        console.error('[Webhook] Error:', err)
        res.sendStatus(500)
      }
    })

    app.listen(PORT, async () => {
      console.log(`[Server] Running on port ${PORT}`)
      await bot.init()
      console.log(`[Bot] Initialized as @${bot.botInfo.username}`)
      await bot.api.setWebhook(webhookUrl)
      console.log(`[Bot] Webhook set to ${webhookUrl}`)
    })
  } else {
    app.listen(PORT, () => {
      console.log(`[Server] Running on port ${PORT}`)
    })
    if (process.env.TELEGRAM_BOT_EXTERNAL === 'true') {
      console.log('[Bot] TELEGRAM_BOT_EXTERNAL=true — skipping polling (production bot handles messages)')
    } else {
      bot.start().catch((err: any) => {
        console.warn(`[Bot] Polling failed (production bot may be running): ${err.message}`)
        console.log('[Bot] HTTP server still running — use webhook mode in production')
      })
      console.log('[Bot] Starting in polling mode...')
    }
  }

  // Start agent runner
  initRunner(bot)
  console.log('[Runner] Agent runner started')

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('[Server] Shutting down...')
    await bot.stop()
    await db.$disconnect()
    process.exit(0)
  })
}

main().catch((err) => {
  console.error('[Fatal]', err)
  process.exit(1)
})
