import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import { db } from './db'
import { createBot } from './bot'
import { initRunner } from './agents/runner'
import { migrateOldUsers } from './migrate'
import { ensureNewTables } from './ensureTables'
import { requireTgUser } from './services/telegramAuth'

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

    // ── Aster account balance ────────────────────────────────────────
    // Per Aster v3 broker model: platform agent signs all queries on behalf
    // of the user, but only AFTER the user has called approveAgent once
    // (the /aster onboarding flow). Skip the API call until they do — it
    // would 403 anyway, and we'd rather show actionable guidance.
    let aster: {
      usdt: number; availableMargin: number;
      onboarded: boolean; error: string | null
    } = { usdt: 0, availableMargin: 0, onboarded: !!user.asterOnboarded, error: null }

    if (!user.asterOnboarded) {
      aster.error = 'not_onboarded'
    } else {
      try {
        const asterMod = await import('./services/aster')
        const creds = asterMod.buildCreds(wallet.address) // platform signer from env
        if (!creds) {
          aster.error = 'no_agent_credentials'
        } else {
          const bal = await asterMod.getAccountBalanceStrict(creds)
          aster.usdt = bal.usdt
          aster.availableMargin = bal.availableMargin
        }
      } catch (e: any) {
        const apiMsg = e?.response?.data?.msg ?? e?.response?.data?.message
        const msg = apiMsg ?? e?.message ?? 'aster_unavailable'
        console.error('[API] /me/wallet aster failed:', wallet.address, '→', e?.response?.status, e?.response?.data ?? msg)
        aster.error = String(msg)
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
    const agentPrivKey   = process.env.ASTER_AGENT_PRIVATE_KEY
    const agentAddress   = process.env.ASTER_AGENT_ADDRESS
    const feeRate        = process.env.ASTER_BUILDER_FEE_RATE ?? '0.0001'
    if (!builderAddress || !agentPrivKey || !agentAddress) {
      return res.status(500).json({ success: false, error: 'Platform not configured' })
    }

    if (user.asterOnboarded) {
      return res.json({ success: true, message: 'Already activated', alreadyOnboarded: true })
    }

    const wallet = await db.wallet.findFirst({ where: { userId: user.id, isActive: true } })
    if (!wallet || !wallet.encryptedPK) {
      return res.status(404).json({ success: false, error: 'No active wallet' })
    }

    const { decryptPrivateKey } = await import('./services/wallet')
    const { approveAgent }      = await import('./services/aster')

    let userPk: string
    try {
      userPk = decryptPrivateKey(wallet.encryptedPK, user.id)
    } catch {
      return res.status(500).json({ success: false, error: 'Could not decrypt wallet' })
    }
    if (!userPk?.startsWith('0x')) {
      return res.status(500).json({ success: false, error: 'Invalid wallet key' })
    }

    const result = await approveAgent({
      userAddress:    wallet.address,
      userPrivateKey: userPk,
      agentAddress,
      agentName:      'BUILD4 Trading Agent',
      builderAddress,
      maxFeeRate:     feeRate,
      expiredDays:    365
    })

    // Wipe local key reference ASAP. JS GC will collect, but null helps.
    userPk = ''

    if (!result.success) {
      const errStr = String(result.error ?? '').toLowerCase()
      const isNewWallet = errStr.includes('no aster user') || errStr.includes('user not found')
      return res.status(400).json({
        success: false,
        error: result.error ?? 'approve_failed',
        needsAsterAccount: isNewWallet  // mini app uses this to show the right next-step UI
      })
    }

    await db.user.update({
      where: { id: user.id },
      data:  { asterOnboarded: true, asterAgentAddress: agentAddress }
    })

    return res.json({ success: true, message: 'Trading account activated' })
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
      if (!wallet) return res.status(404).json({ success: false, error: 'No active wallet' })

      const { buildCreds, transferAsset } = await import('./services/aster')
      const creds = buildCreds(wallet.address)
      if (!creds) return res.status(500).json({ success: false, error: 'Platform not configured' })

      const kindType = direction === 'to_aster' ? 'SPOT_FUTURE' : 'FUTURE_SPOT'
      const result   = await transferAsset(creds, amt.toString(), kindType)

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

app.post('/api/agents/:id/toggle', async (req, res) => {
  try {
    const agent = await db.agent.findUnique({ where: { id: req.params.id } })
    if (!agent) return res.status(404).json({ error: 'Agent not found' })

    const updated = await db.agent.update({
      where: { id: req.params.id },
      data: { isActive: !agent.isActive, isPaused: false }
    })
    res.json(updated)
  } catch {
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

app.get('/api/signals', async (_req, res) => {
  const { getLatestSignals } = await import('./services/signals')
  const signals = await getLatestSignals(10)
  res.json(signals)
})

async function main() {
  // Connect DB
  await db.$connect()
  console.log('[DB] Connected')

  // Create new tables safely (no drops, no renames)
  await ensureNewTables()

  // Migrate old users from Drizzle tables to Prisma tables
  await migrateOldUsers()

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
