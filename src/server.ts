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
    // Map the DB chain tag (XLAYER/BSC/null) to the AgentIdentity chain
    // discriminator. Without this, XLayer-registered agents publish
    // metadata that incorrectly claims chain="BSC" — a correctness bug
    // for any off-chain scanner that trusts the metadata JSON.
    const chainForMetadata = (agent.onchainChain ?? 'BSC').toUpperCase() === 'XLAYER' ? 'xlayer' : 'bsc'
    const identity = buildAgentIdentity({
      name: agent.name,
      agentAddress: agent.walletAddress,
      ownerAddress,
      publicBaseUrl: baseUrl,
      model: agent.learningModel ?? undefined,
      chain: chainForMetadata as 'bsc' | 'xlayer',
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

    // ── Arbitrum balances (ETH for gas + USDC). Same wallet address as BSC.
    // Surfaced so the user can see funds they parked on Arbitrum (e.g. for
    // bridging to Hyperliquid) without leaving the app.
    let arbitrum: { eth: number; usdc: number; error: string | null } =
      { eth: 0, usdc: 0, error: null }
    try {
      const { getArbitrumBalances } = await import('./services/wallet')
      arbitrum = await getArbitrumBalances(wallet.address)
    } catch (e: any) {
      arbitrum.error = e?.message ?? 'arb_unavailable'
    }

    // ── Hyperliquid clearinghouse equity ───────────────────────────────────
    // Same wallet address as BSC (HL is EVM, derived from the same secp256k1
    // key). Gives us parity with the Aster card so users see HL equity at
    // a glance without leaving the Wallet tab.
    let hyperliquid: {
      usdc: number; accountValue: number;
      onboarded: boolean; error: string | null
    } = { usdc: 0, accountValue: 0, onboarded: !!user.hyperliquidOnboarded, error: null }
    try {
      const hlMod = await import('./services/hyperliquid')
      const acc = await hlMod.getAccountState(wallet.address)
      hyperliquid.usdc = acc.withdrawableUsdc
      hyperliquid.accountValue = acc.accountValue
      hyperliquid.onboarded = acc.onboarded
    } catch (e: any) {
      const msg = String(e?.message ?? 'hl_unavailable').toLowerCase()
      if (msg.includes('does not exist') || msg.includes('no user')) {
        hyperliquid.error = 'not_onboarded'
      } else {
        console.error('[API] /me/wallet hyperliquid failed:', wallet.address, '→', e?.message)
        hyperliquid.error = String(e?.message ?? 'hl_unavailable')
      }
    }

    // ── XLayer (chain id 196) — native OKB balance ────────────────────────
    // Same EVM address; surfaced so users can see whether they've topped up
    // OKB for XLayer registry txs / future XLayer trading.
    let xlayer: { okb: number; error: string | null } = { okb: 0, error: null }
    try {
      const { buildXLayerProvider } = await import('./services/xlayerProvider')
      const xp = buildXLayerProvider()
      const wei = await xp.getBalance(wallet.address)
      const { ethers } = await import('ethers')
      xlayer.okb = parseFloat(ethers.formatEther(wei))
    } catch (e: any) {
      xlayer.error = e?.shortMessage ?? e?.message ?? 'xlayer_rpc_failed'
    }

    res.json({
      address: wallet.address,
      chain: wallet.chain,
      label: wallet.label,
      pinProtected: !!user.pinHash,
      balances: { usdt, bnb, error: balanceError },
      arbitrum,
      aster,
      hyperliquid,
      xlayer,
      qrDataUrl
    })
  } catch (err: any) {
    console.error('[API] /me/wallet failed:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// $B4 holder wallet linking
//
// Lets a user prove ownership of an external EOA they hold $B4 on by
// signing a deterministic message with that wallet. The recovered signer
// must match the claimed address; the message must contain the user's
// Telegram ID (anti-replay across users) and a recent timestamp
// (anti-replay across sessions). On success we read the on-chain $B4
// balance at the BSC contract and cache it on User.linkedB4Balance.
//
// Airdrop allocations are computed against linkedB4WalletAddress —
// holders never need to move tokens to be eligible.
// ─────────────────────────────────────────────────────────────────────────────
const B4_TOKEN_BSC = (process.env.B4_TOKEN_ADDRESS ?? '0x1d547f9d0890ee5abfb49d7d53ca19df85da4444').toLowerCase()
const LINK_MESSAGE_MAX_AGE_MS = 10 * 60 * 1000  // 10 min — generous for slow signers, tight enough to limit replay window

function buildLinkChallenge(telegramId: string | bigint, address: string, isoTs: string): string {
  return [
    'Sign to link your wallet to BUILD4.',
    '',
    `Telegram ID: ${telegramId.toString()}`,
    `Wallet: ${address.toLowerCase()}`,
    `Issued: ${isoTs}`,
    '',
    'Only sign this if you initiated this action in @Build4ai_bot.',
  ].join('\n')
}

async function readB4Balance(address: string): Promise<{ balance: number; raw: string }> {
  const { ethers } = await import('ethers')
  const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org')
  const erc20 = new ethers.Contract(
    B4_TOKEN_BSC,
    ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'],
    provider,
  )
  const [raw, decimals] = await Promise.all([erc20.balanceOf(address) as Promise<bigint>, erc20.decimals() as Promise<number>])
  return { balance: parseFloat(ethers.formatUnits(raw, decimals)), raw: raw.toString() }
}

// GET — current link state for the authenticated user.
app.get('/api/me/link-wallet', requireTgUser, async (req, res) => {
  const user = (req as any).user
  res.json({
    linked: !!user.linkedB4WalletAddress,
    address: user.linkedB4WalletAddress ?? null,
    balance: user.linkedB4Balance ?? 0,
    linkedAt: user.linkedB4At ?? null,
    challenge: {
      // Pre-format an issued timestamp the client can use right now to
      // build the exact message string. Keeping the construction client-
      // side avoids a second round-trip but the server still accepts
      // any ISO timestamp within the freshness window.
      issuedAt: new Date().toISOString(),
      tokenAddress: B4_TOKEN_BSC,
    },
  })
})

// POST — verify signature, read on-chain balance, persist.
app.post('/api/me/link-wallet', requireTgUser, async (req, res) => {
  const user = (req as any).user
  try {
    const { ethers } = await import('ethers')
    const { address, signature, issuedAt } = req.body as { address?: string; signature?: string; issuedAt?: string }

    if (!address || !signature || !issuedAt) {
      return res.status(400).json({ success: false, error: 'address, signature, issuedAt required' })
    }
    if (!ethers.isAddress(address)) {
      return res.status(400).json({ success: false, error: 'Invalid address' })
    }

    const ts = Date.parse(issuedAt)
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > LINK_MESSAGE_MAX_AGE_MS) {
      return res.status(400).json({ success: false, error: 'Signature expired — refresh and sign again.' })
    }

    const message = buildLinkChallenge(user.telegramId, address, issuedAt)
    let recovered: string
    try {
      recovered = ethers.verifyMessage(message, signature)
    } catch {
      return res.status(400).json({ success: false, error: 'Invalid signature format.' })
    }
    if (recovered.toLowerCase() !== address.toLowerCase()) {
      return res.status(400).json({ success: false, error: 'Signature does not match the claimed wallet.' })
    }

    // Read on-chain $B4 balance. Failure here is non-fatal — we still
    // record the link so the holder can refresh later if BSC RPC is flaky.
    let balance = 0
    let balanceError: string | null = null
    try {
      const r = await readB4Balance(address)
      balance = r.balance
    } catch (e: any) {
      balanceError = e?.shortMessage ?? e?.message ?? 'rpc_failed'
    }

    await db.user.update({
      where: { id: user.id },
      data: {
        linkedB4WalletAddress: address.toLowerCase(),
        linkedB4Balance: balance,
        linkedB4At: new Date(),
      },
    })

    res.json({ success: true, address: address.toLowerCase(), balance, balanceError })
  } catch (err: any) {
    console.error('[link-wallet] failed:', err)
    res.status(500).json({ success: false, error: err?.message ?? 'Internal error' })
  }
})

// POST — refresh on-chain balance for an already-linked wallet.
app.post('/api/me/link-wallet/refresh', requireTgUser, async (req, res) => {
  const user = (req as any).user
  if (!user.linkedB4WalletAddress) {
    return res.status(400).json({ success: false, error: 'No linked wallet to refresh.' })
  }
  try {
    const { balance } = await readB4Balance(user.linkedB4WalletAddress)
    await db.user.update({
      where: { id: user.id },
      data: { linkedB4Balance: balance, linkedB4At: new Date() },
    })
    res.json({ success: true, address: user.linkedB4WalletAddress, balance })
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message ?? 'rpc_failed' })
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

    const wallet = await db.wallet.findFirst({ where: { userId: user.id, isActive: true } })
    if (!wallet || !wallet.encryptedPK) {
      return res.status(404).json({ success: false, error: 'No active wallet' })
    }

    const { decryptPrivateKey, encryptPrivateKey } = await import('./services/wallet')
    const { approveAgent, approveBuilder }      = await import('./services/aster')
    const { ensureAndDepositUSDT, USDT_BSC, MIN_BNB_FOR_GAS_WEI, getProvider } = await import('./services/asterDeposit')
    const { ethers: ethersLib } = await import('ethers')

    // Idempotent short-circuit: skip approve when the user is already
    // onboarded AND we can still produce working agent credentials. If
    // asterAgentEncryptedPK is unrecoverable (legacy encryption with a
    // different password, env-key rotation, etc.) we MUST let the flow
    // through so a fresh agent can be approved — otherwise the user is
    // permanently stuck (every signed call returns -1000 and there's no
    // way to recover).
    if (user.asterOnboarded) {
      let agentPkOk = false
      if (user.asterAgentEncryptedPK) {
        for (const cand of [user.id, user.telegramId?.toString()].filter(Boolean) as string[]) {
          try {
            const dec = decryptPrivateKey(user.asterAgentEncryptedPK, cand)
            if (dec?.startsWith('0x')) { agentPkOk = true; break }
          } catch { /* try next candidate */ }
        }
      }
      if (agentPkOk) {
        return res.json({ success: true, message: 'Already activated', alreadyOnboarded: true })
      }
      console.warn(
        `[/aster/approve] user=${user.id} tg=${user.telegramId} asterOnboarded=true but agent PK ` +
        `unrecoverable — proceeding to mint a fresh agent and re-approve`
      )
    }

    // Mirror the deposit flow: wallet PKs in production were encrypted
    // by different historical code paths (some with user.id, some with
    // telegramId, some legacy migrations under wallet.userId). Try every
    // plausible candidate before giving up so we don't lock activation
    // for users whose wallet decrypts fine in the deposit endpoint but
    // not here.
    let userPk: string | null = null
    {
      const idCandidates = Array.from(new Set([
        user.id,
        user.telegramId?.toString(),
        wallet.userId,                    // legacy: wallet row may be owned by a pre-migration userId
      ].filter((v): v is string => Boolean(v))))
      let lastErr: any = null
      for (const candidate of idCandidates) {
        try {
          const out = decryptPrivateKey(wallet.encryptedPK, candidate)
          if (out?.startsWith('0x')) { userPk = out; break }
        } catch (e) { lastErr = e }
      }
      if (!userPk) {
        // Surface enough format info that we can diagnose remotely from
        // the error response alone (Render logs aren't always reachable).
        const blob = wallet.encryptedPK ?? ''
        const parts = blob.split(':')
        const partLens = parts.map(p => p.length).join(',')
        const isCryptoJs = blob.startsWith('U2FsdGVk')
        const fmt = parts.length === 1 ? (isCryptoJs ? 'cryptojs(salted)' : 'cryptojs(raw)')
                  : parts.length === 2 ? 'node-crypto(iv:data)'
                  : parts.length === 3 ? 'node-crypto(salt:iv:data PBKDF2)'
                  : `unknown(${parts.length}-part)`
        console.error(
          `[/aster/approve] decrypt wallet PK failed user=${user.id} tg=${user.telegramId} ` +
          `wallet=${wallet.address} walletUserId=${wallet.userId} fmt=${fmt} totalLen=${blob.length} ` +
          `partLens=${partLens} head=${blob.slice(0,16)} tried=${idCandidates.length} ` +
          `err=${lastErr?.message ?? 'unknown'}`
        )
        return res.status(500).json({
          success: false,
          error: 'Could not decrypt wallet',
          debug: { fmt, totalLen: blob.length, partLens, head: blob.slice(0, 16), tried: idCandidates.length, reason: lastErr?.message ?? 'unknown' }
        })
      }
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

      // ── Aster → BSC: TEMPORARILY DISABLED.
      //
      // The previous implementation called Aster's signed FUTURE_SPOT
      // wallet/transfer endpoint and assumed Aster would surface the
      // funds back to the user's BSC wallet on-chain. That assumption
      // is wrong — FUTURE_SPOT only moves USDT between Aster's
      // INTERNAL futures and INTERNAL spot wallets. The funds end up
      // stranded in the user's Aster spot account with no in-app way
      // to recover them. Confirmed with user 7383875080 / wallet
      // 0x9751…3026: 26 USDT moved off futures, never arrived on BSC,
      // BSC USDT balance was 0.045 after the transfer.
      //
      // Until we wire up Aster's actual signed on-chain withdrawal
      // (likely /fapi/v3/capital/withdraw/apply or an EIP-712 vault
      // withdraw), refuse the request with a clear message routing
      // the user to asterdex.com so they can withdraw via Aster's
      // own UI. The miniapp already disables the button; this is a
      // defence-in-depth gate for older cached clients.
      return res.status(400).json({
        success: false,
        error: 'Aster→BSC withdrawal temporarily unavailable in-app. ' +
               'Please withdraw via asterdex.com → Wallet → Withdraw. ' +
               'In-app withdrawal coming soon.',
        useAsterDex: true,
      })
    })
  } catch (err: any) {
    if (res.headersSent) return
    console.error('[API] /aster/transfer failed:', err)
    res.status(500).json({ success: false, error: err?.message ?? 'Internal error' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Aster manual trading — used by the miniapp Trade page.
// These are thin wrappers around services/aster.ts. The agent uses the same
// underlying functions on its own ticks; these endpoints expose them to the UI
// for human-initiated orders.
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/aster/markprice/:pair  — public mark price + funding for one symbol
app.get('/api/aster/markprice/:pair', async (req, res) => {
  try {
    const { getMarkPrice } = await import('./services/aster')
    const data = await getMarkPrice(req.params.pair)
    res.json(data)
  } catch (err: any) {
    console.error('[API] /aster/markprice failed:', err?.message)
    res.status(500).json({ error: err?.message ?? 'Internal error' })
  }
})

// GET /api/aster/positions  — caller's live perp positions
app.get('/api/aster/positions', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    if (!user.asterOnboarded) {
      return res.status(400).json({ error: 'Activate trading account first', needsApprove: true })
    }
    const wallet = await db.wallet.findFirst({ where: { userId: user.id, isActive: true } })
    if (!wallet) return res.status(404).json({ error: 'No active wallet' })

    const { resolveAgentCreds, getPositions } = await import('./services/aster')
    const creds = await resolveAgentCreds(user, wallet.address)
    if (!creds) return res.status(400).json({ error: 'No agent credentials — re-activate Aster' })

    const positions = await getPositions(creds)
    res.json({ positions })
  } catch (err: any) {
    console.error('[API] /aster/positions failed:', err?.message)
    res.status(500).json({ error: err?.message ?? 'Internal error' })
  }
})

// POST /api/aster/order
// Body: { pair, side: 'LONG'|'SHORT', type: 'MARKET'|'LIMIT',
//         notionalUsdt, leverage, limitPrice? }
// Manual perp order. Converts USDT notional → base quantity using mark price
// (or the supplied limit price for LIMIT orders), sets leverage, and routes
// through the builder code path when ASTER_BUILDER_ADDRESS is configured so
// the platform earns its broker fee.
app.post('/api/aster/order', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    if (!user.asterOnboarded) {
      return res.status(400).json({ error: 'Activate trading account first', needsApprove: true })
    }

    const { pair, side, type, notionalUsdt, leverage, limitPrice } = req.body ?? {}
    if (typeof pair !== 'string' || !pair) {
      return res.status(400).json({ error: 'pair required' })
    }
    if (side !== 'LONG' && side !== 'SHORT') {
      return res.status(400).json({ error: 'side must be LONG or SHORT' })
    }
    if (type !== 'MARKET' && type !== 'LIMIT') {
      return res.status(400).json({ error: 'type must be MARKET or LIMIT' })
    }
    const notional = Number(notionalUsdt)
    if (!Number.isFinite(notional) || notional <= 0) {
      return res.status(400).json({ error: 'notionalUsdt must be > 0' })
    }
    const lev = Math.max(1, Math.min(50, Math.floor(Number(leverage) || 1)))
    const limit = type === 'LIMIT' ? Number(limitPrice) : 0
    if (type === 'LIMIT' && (!Number.isFinite(limit) || limit <= 0)) {
      return res.status(400).json({ error: 'limitPrice must be > 0 for LIMIT orders' })
    }

    const wallet = await db.wallet.findFirst({ where: { userId: user.id, isActive: true } })
    if (!wallet) return res.status(404).json({ error: 'No active wallet' })

    const aster = await import('./services/aster')
    const creds = await aster.resolveAgentCreds(user, wallet.address)
    if (!creds) return res.status(400).json({ error: 'No agent credentials — re-activate Aster' })

    const sym = pair.replace(/[\/\s]/g, '').toUpperCase()
    const refPrice = type === 'LIMIT' ? limit : (await aster.getMarkPrice(sym)).markPrice
    if (!Number.isFinite(refPrice) || refPrice <= 0) {
      return res.status(503).json({ error: 'Could not resolve mark price' })
    }

    // ── Round qty/price to per-symbol filter granularity. Without this,
    //    Aster rejects with "Precision is over the maximum defined for this
    //    asset" — most commonly when a small notional (e.g. $10 BTC) yields
    //    a 7-decimal qty but the symbol only allows stepSize=0.001.
    const filters = await aster.getSymbolFilters(sym)
    const rawQty = notional / refPrice
    const qtyStr = filters
      ? aster.roundDownToStep(rawQty, filters.stepSize, filters.quantityPrecision)
      : rawQty.toFixed(6)
    const qty = parseFloat(qtyStr)
    if (qty <= 0) {
      // Compute the equivalent USDT minimum so users don't have to do
      // mental math (e.g. for BTC at $78k, stepSize=0.001 → $78 USDT min).
      // Without this, users see "min step 0.001 BTC" and have no idea what
      // notional that maps to, then keep submitting failing orders.
      if (filters && filters.stepSize > 0) {
        const minNotional = Math.max(
          filters.stepSize * refPrice,
          filters.minNotional || 0,
        )
        const base = sym.replace(/USDT?$/, '')
        return res.status(400).json({
          error:
            `Order too small — need at least ~$${minNotional.toFixed(2)} USDT for ${sym} ` +
            `(1 step = ${filters.stepSize} ${base} at $${refPrice.toFixed(2)}). You sent $${notional}.`,
        })
      }
      return res.status(400).json({ error: 'Order size too small for current price' })
    }
    if (filters && filters.minQty > 0 && qty < filters.minQty) {
      return res.status(400).json({
        error: `Below minimum size: need ≥ ${filters.minQty} ${sym.replace(/USDT?$/, '')}, got ${qty}`,
      })
    }
    if (filters && filters.minNotional > 0 && qty * refPrice < filters.minNotional) {
      return res.status(400).json({
        error: `Below minimum notional: need ≥ ${filters.minNotional} USDT, got ${(qty * refPrice).toFixed(2)}`,
      })
    }
    let limitRounded = limit
    if (type === 'LIMIT' && filters) {
      limitRounded = parseFloat(aster.roundDownToStep(limit, filters.tickSize, filters.pricePrecision))
      if (!Number.isFinite(limitRounded) || limitRounded <= 0) {
        return res.status(400).json({
          error: `Limit price too low for tick size ${filters.tickSize}`,
        })
      }
    }

    // Margin pre-check — prevent obvious "insufficient margin" rejects.
    try {
      const bal = await aster.getAccountBalanceStrict(creds)
      if (bal.usdt <= 0) {
        return res.status(400).json({ error: `Aster balance is ${bal.usdt.toFixed(4)} USDT — deposit first` })
      }
      const requiredMargin = notional / lev
      if (requiredMargin > bal.availableMargin + 0.01) {
        return res.status(400).json({
          error: `Need ~${requiredMargin.toFixed(2)} USDT margin, have ${bal.availableMargin.toFixed(2)} available`
        })
      }
    } catch (balErr: any) {
      console.warn('[API] /aster/order balance pre-check failed:', balErr?.message)
    }

    const builderAddress = process.env.ASTER_BUILDER_ADDRESS
    const feeRate        = process.env.ASTER_BUILDER_FEE_RATE ?? '0.0001'
    const buySell        = side === 'LONG' ? 'BUY' : 'SELL'

    let result
    if (builderAddress && type === 'MARKET') {
      // Builder route only supports the params we wire; LIMIT routes still go
      // through the standard endpoint so timeInForce is honored.
      if (lev > 1) await aster.setLeverage(sym, lev, creds)
      result = await aster.placeOrderWithBuilderCode({
        symbol: sym, side: buySell, type: 'MARKET', quantity: qty,
        builderAddress, feeRate, creds
      })
    } else {
      result = await aster.placeOrder({
        symbol: sym, side: buySell, type, quantity: qty,
        price: type === 'LIMIT' ? limitRounded : undefined,
        leverage: lev, creds
      })
    }

    res.json({
      success: true,
      order: result,
      qty,
      refPrice,
      notionalUsdt: notional,
      leverage: lev
    })
  } catch (err: any) {
    const msg = err?.response?.data?.msg ?? err?.message ?? 'Internal error'
    console.error('[API] /aster/order failed:', msg)
    res.status(500).json({ error: msg })
  }
})

// POST /api/aster/close
// Body: { pair, side: 'LONG'|'SHORT', size }   (size in base units; pass the
//   `size` field returned by /api/aster/positions to fully close)
app.post('/api/aster/close', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    if (!user.asterOnboarded) {
      return res.status(400).json({ error: 'Activate trading account first', needsApprove: true })
    }
    const { pair, side, size } = req.body ?? {}
    if (typeof pair !== 'string' || !pair) {
      return res.status(400).json({ error: 'pair required' })
    }
    if (side !== 'LONG' && side !== 'SHORT') {
      return res.status(400).json({ error: 'side must be LONG or SHORT' })
    }
    const qty = Number(size)
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ error: 'size must be > 0' })
    }

    const wallet = await db.wallet.findFirst({ where: { userId: user.id, isActive: true } })
    if (!wallet) return res.status(404).json({ error: 'No active wallet' })

    const { resolveAgentCreds, closePosition } = await import('./services/aster')
    const creds = await resolveAgentCreds(user, wallet.address)
    if (!creds) return res.status(400).json({ error: 'No agent credentials — re-activate Aster' })

    const result = await closePosition(pair.replace(/[\/\s]/g, '').toUpperCase(), side, qty, creds)
    res.json({ success: true, order: result })
  } catch (err: any) {
    const msg = err?.response?.data?.msg ?? err?.message ?? 'Internal error'
    console.error('[API] /aster/close failed:', msg)
    res.status(500).json({ error: msg })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Hyperliquid (foundation, added 2026-04-23)
//
// First-pass endpoints so the miniapp Hyperliquid tab and bot can show market
// data + account state. Order placement and onboarding (approveAgent) flow
// will land in a follow-up — for now this exposes:
//   GET  /api/hyperliquid/markprice/:coin   public mid for a perp coin
//   GET  /api/hyperliquid/account           caller's HL clearinghouse state
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/hyperliquid/markprice/:coin', async (req, res) => {
  try {
    const { getMarkPrice } = await import('./services/hyperliquid')
    const data = await getMarkPrice(req.params.coin)
    res.json(data)
  } catch (err: any) {
    console.error('[API] /hyperliquid/markprice failed:', err?.message)
    res.status(500).json({ error: err?.message ?? 'Internal error' })
  }
})

// In-process per-user mutex for /api/hyperliquid/approve. The endpoint
// performs a real on-chain transfer (Arbitrum USDC → HL bridge), and
// double-clicks would otherwise race on nonce/balance and could send
// the bridge twice. Lifecycle is tied to the request handler — entries
// are added before any signing and removed in `finally` whether we
// succeed, error, or time out. Single-instance deploy on Render makes
// this safe without a Redis-backed lock.
const HL_ACTIVATE_LOCKS = new Set<string>()

// POST /api/hyperliquid/approve
//
// One-click HL onboarding. Decrypts the user's master wallet PK, generates
// a fresh per-user agent keypair, asks HL to authorise that agent via
// EIP-712 ApproveAgent (signed by master), encrypts the agent PK with the
// same scheme as user wallets, and persists. After this returns success
// the agent loop and /api/hyperliquid/order can sign for the user without
// ever touching the master key again.
//
// Idempotent: if the user is already onboarded with a working agent we
// short-circuit and return success without re-approving (HL would reject
// with "agent already exists" otherwise).
app.post('/api/hyperliquid/approve', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user

    // ── Short-circuit if already onboarded with an agent we can decrypt.
    if (user.hyperliquidOnboarded && user.hyperliquidAgentAddress && user.hyperliquidAgentEncryptedPK) {
      return res.json({
        success:      true,
        agentAddress: user.hyperliquidAgentAddress,
        alreadyOnboarded: true,
      })
    }

    const wallet = await db.wallet.findFirst({ where: { userId: user.id, isActive: true } })
    if (!wallet) return res.status(404).json({ success: false, error: 'No active wallet' })

    // ── 1) Decrypt the user's master PK. Mirrors the candidate-id loop
    //    used by /aster/approve so historical encryption keys still work.
    const { decryptPrivateKey, encryptPrivateKey } = await import('./services/wallet')
    const idCandidates = [user.id, user.telegramId?.toString()].filter(Boolean) as string[]
    let userPk: string | null = null
    let lastErr: any = null
    for (const candidate of idCandidates) {
      try {
        const out = decryptPrivateKey(wallet.encryptedPK, candidate)
        if (out?.startsWith('0x')) { userPk = out; break }
      } catch (e) { lastErr = e }
    }
    if (!userPk) {
      console.error(
        `[/hyperliquid/approve] decrypt wallet PK failed user=${user.id} tg=${user.telegramId} ` +
        `wallet=${wallet.address} err=${lastErr?.message ?? 'unknown'}`,
      )
      return res.status(500).json({ success: false, error: 'Could not decrypt wallet' })
    }

    // ── 2) Fresh agent keypair (per-user — HL also forbids reusing one
    //    agent address across multiple master accounts).
    const { ethers } = await import('ethers')
    const agentWallet = ethers.Wallet.createRandom()
    const agentAddress = agentWallet.address
    const agentEncryptedPK = encryptPrivateKey(agentWallet.privateKey, user.id)

    // ── 3) Ask HL to authorise the agent. Master signs EIP-712 ApproveAgent.
    //    HL rejects approveAgent on accounts with $0 equity — the user has
    //    to deposit USDC first. We make this seamless: if the master account
    //    is empty AND the user has spendable USDC + a sliver of ETH on
    //    Arbitrum, we auto-bridge it through HL's official bridge contract
    //    and wait for the credit before signing approveAgent.
    const { approveAgent, approveBuilderFee, getAccountState, waitForHlDeposit } =
      await import('./services/hyperliquid')
    const { getArbitrumBalances, bridgeArbitrumUsdcToHyperliquid } =
      await import('./services/wallet')

    const accountBefore = await getAccountState(wallet.address)
    if (accountBefore.accountValue < 1) {
      // ── Per-user mutex. The Activate button is async and easy to double-tap
      //    in Telegram's webview; without this guard a quick second tap can
      //    fire a second bridge tx before the first nonce settles. The lock
      //    is in-process (single Render instance) — sufficient since we don't
      //    horizontally scale this service.
      if (HL_ACTIVATE_LOCKS.has(user.id)) {
        return res.status(409).json({
          success: false,
          error:   'Activation already in progress. Hold on ~1 minute and reopen the page.',
        })
      }
      HL_ACTIVATE_LOCKS.add(user.id)
      try {
        const arb = await getArbitrumBalances(wallet.address)
        // HL minimum deposit is $5. Cap each auto-bridge at $500 to prevent
        // an accidental sweep of a wallet someone happens to have parked
        // funds on for unrelated purposes — they can repeat Activate later
        // (or use a manual transfer) to move more. Below $5 we can't
        // bootstrap HL, so we return a clean error.
        const HL_AUTO_BRIDGE_CAP = 500
        const available    = Math.floor(arb.usdc * 100) / 100
        const bridgeAmount = Math.min(available, HL_AUTO_BRIDGE_CAP)
        if (bridgeAmount < 5) {
          return res.status(400).json({
            success: false,
            error:   `Hyperliquid needs at least $5 USDC to activate. You currently have $${arb.usdc.toFixed(2)} USDC on Arbitrum (wallet ${wallet.address}). Send native USDC (not USDC.e) on Arbitrum One to that address, then tap Activate again.`,
          })
        }
        console.log(
          `[/hyperliquid/approve] auto-bridge user=${user.id} bridging $${bridgeAmount} of $${available} USDC from Arbitrum`,
        )
        const bridge = await bridgeArbitrumUsdcToHyperliquid(userPk, bridgeAmount)
        if (!bridge.success) {
          return res.status(400).json({
            success: false,
            error:   `Auto-bridge from Arbitrum failed: ${bridge.error ?? 'unknown error'}`,
          })
        }
        // Bridge confirmed on Arbitrum; now wait for HL to credit. Typically
        // 30-90s. Cap at 85s so we return cleanly before Render's 100s
        // request gateway timeout — if it isn't credited by then we surface
        // a 202 and the FE re-tries on the next tap.
        const credited = await waitForHlDeposit(wallet.address, 1, 85_000)
        if (credited === null) {
          return res.status(202).json({
            success: false,
            bridging: true,
            txHash:   bridge.txHash,
            error:    'Bridge sent. Hyperliquid is still crediting your account — wait ~1 minute and tap Activate again.',
          })
        }
        console.log(
          `[/hyperliquid/approve] auto-bridge user=${user.id} credited $${credited.toFixed(2)} on HL`,
        )
      } finally {
        HL_ACTIVATE_LOCKS.delete(user.id)
      }
    }

    const result = await approveAgent(userPk, agentAddress)
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error ?? 'approveAgent failed' })
    }

    // ── 3b) Authorise BUILD4's builder address to charge per-order kickback.
    //   Same one-tap flow — master signs ApproveBuilderFee right after the
    //   agent approval. Failure here is non-fatal: the user is still onboarded
    //   for trading, we just don't earn revenue on their orders. Logged so
    //   we can sweep up missed approvals later if it becomes common.
    const builderResult = await approveBuilderFee(userPk)
    if (!builderResult.success) {
      console.warn(
        `[/hyperliquid/approve] approveBuilderFee failed (non-fatal) user=${user.id} ` +
        `tg=${user.telegramId} err=${builderResult.error ?? 'unknown'}`,
      )
    }

    // ── 4) Persist. Only flip onboarded=true after on-chain success so a
    //    failed approve doesn't lock the user out of future retries.
    await db.user.update({
      where: { id: user.id },
      data: {
        hyperliquidAgentAddress:    agentAddress,
        hyperliquidAgentEncryptedPK: agentEncryptedPK,
        hyperliquidOnboarded:        true,
      },
    })

    console.log(`[/hyperliquid/approve] user=${user.id} tg=${user.telegramId} agent=${agentAddress} OK`)
    return res.json({ success: true, agentAddress })
  } catch (err: any) {
    console.error('[API] /hyperliquid/approve failed:', err?.message ?? err)
    res.status(500).json({ success: false, error: err?.message ?? 'Internal error' })
  }
})

// POST /api/hyperliquid/approve-builder
//
// Manual builder-fee approval. Used when /api/hyperliquid/order's auto-heal
// can't decrypt the master PK and surfaces { needsBuilderApproval: true } —
// the UI offers a button that calls this endpoint, after which the user can
// retry the order. Idempotent: HL silently no-ops a re-approval.
app.post('/api/hyperliquid/approve-builder', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    if (!user.hyperliquidOnboarded) {
      return res.status(400).json({ success: false, error: 'Activate Hyperliquid first' })
    }
    const wallet = await db.wallet.findFirst({ where: { userId: user.id, isActive: true } })
    if (!wallet) return res.status(404).json({ success: false, error: 'No active wallet' })

    const { decryptPrivateKey } = await import('./services/wallet')
    const idCandidates = Array.from(new Set([
      user.id,
      user.telegramId?.toString(),
      wallet.userId,
    ].filter((v): v is string => Boolean(v))))
    let userPk: string | null = null
    let lastErr: any = null
    for (const candidate of idCandidates) {
      try {
        const out = decryptPrivateKey(wallet.encryptedPK, candidate)
        if (out?.startsWith('0x')) { userPk = out; break }
      } catch (e) { lastErr = e }
    }
    if (!userPk) {
      console.error(
        `[/hyperliquid/approve-builder] decrypt wallet PK failed user=${user.id} ` +
        `wallet=${wallet.address} err=${lastErr?.message ?? 'unknown'}`,
      )
      return res.status(500).json({ success: false, error: 'Could not decrypt wallet' })
    }

    const { approveBuilderFee } = await import('./services/hyperliquid')
    const r = await approveBuilderFee(userPk)
    if (!r.success) {
      return res.status(400).json({ success: false, error: r.error ?? 'Builder approval failed' })
    }
    return res.json({ success: true, skipped: r.skipped ?? false })
  } catch (err: any) {
    console.error('[API] /hyperliquid/approve-builder failed:', err?.message ?? err)
    res.status(500).json({ success: false, error: err?.message ?? 'Internal error' })
  }
})

// POST /api/hyperliquid/order
//
// Place a perp order on Hyperliquid using the user's agent wallet.
// Body: { coin, side: 'LONG'|'SHORT', type: 'MARKET'|'LIMIT', notionalUsdc, limitPx?, leverage? }
//   - notionalUsdc: USD size of the position; we resolve mark price and
//     convert to base-coin size before sending. Keeps the UX in dollars
//     (what users actually think in) rather than HL's base units.
//   - leverage: optional, defaults to whatever the user already has set on
//     that asset. Cross-margin only for now.
app.post('/api/hyperliquid/order', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    if (!user.hyperliquidOnboarded) {
      return res.status(400).json({
        success: false,
        error: 'Activate Hyperliquid trading first',
        needsApprove: true,
      })
    }

    const { coin, side, type = 'MARKET', notionalUsdc, limitPx, leverage } = req.body ?? {}
    if (typeof coin !== 'string' || !coin) {
      return res.status(400).json({ success: false, error: 'coin required' })
    }
    if (side !== 'LONG' && side !== 'SHORT') {
      return res.status(400).json({ success: false, error: 'side must be LONG or SHORT' })
    }
    if (type !== 'MARKET' && type !== 'LIMIT') {
      return res.status(400).json({ success: false, error: 'type must be MARKET or LIMIT' })
    }
    const notional = Number(notionalUsdc)
    if (!Number.isFinite(notional) || notional <= 0) {
      return res.status(400).json({ success: false, error: 'notionalUsdc must be > 0' })
    }
    if (type === 'LIMIT' && (!Number.isFinite(Number(limitPx)) || Number(limitPx) <= 0)) {
      return res.status(400).json({ success: false, error: 'limitPx required for LIMIT orders' })
    }

    const wallet = await db.wallet.findFirst({ where: { userId: user.id, isActive: true } })
    if (!wallet) return res.status(404).json({ success: false, error: 'No active wallet' })

    const { resolveAgentCreds, getMarkPrice, placeOrder } = await import('./services/hyperliquid')
    const creds = await resolveAgentCreds(user, wallet.address)
    if (!creds) {
      return res.status(400).json({
        success: false,
        error: 'Agent credentials missing — re-activate Hyperliquid',
        needsApprove: true,
      })
    }

    // Convert USD notional → base-coin size using mark price. For LIMIT
    // orders we still size off the mark, not the limit price — gives the
    // user the position size they asked for in dollars regardless of
    // where their limit sits.
    const sym = coin.toUpperCase().replace(/USDT?$/, '').replace(/-USD$/, '')
    const { markPrice } = await getMarkPrice(sym)
    if (markPrice <= 0) {
      return res.status(500).json({ success: false, error: `Could not resolve mark price for ${sym}` })
    }
    const sz = Number((notional / markPrice).toFixed(6))
    if (sz <= 0) {
      return res.status(400).json({ success: false, error: 'computed size is 0; increase notionalUsdc' })
    }

    const orderArgs = {
      coin: sym,
      side,
      type,
      sz,
      limitPx: type === 'LIMIT' ? Number(limitPx) : undefined,
      leverage: leverage ? Number(leverage) : undefined,
    } as const
    let result = await placeOrder(creds, orderArgs)

    // ── Self-heal: users onboarded before the builder-fee rollout never
    //   signed approveBuilderFee, so HL rejects their first order with a
    //   "must approve builder fee" / "builder not approved" style error.
    //   Catch that on the fly, decrypt master PK, sign the missing approval,
    //   then retry the order — invisible to the user. One-shot only.
    const errStr = (result.error ?? '').toLowerCase()
    const looksLikeBuilderReject =
      !result.success &&
      (errStr.includes('builder') || errStr.includes('must approve'))

    // ── Distinct from "user hasn't approved yet": this means the builder
    //    address itself isn't registered/funded as a builder on HL.
    //    No amount of user-side approveBuilderFee can fix it. We'll skip
    //    straight to placing without a builder field below.
    const builderUnregistered =
      !result.success &&
      /insufficient balance|not registered|not a (registered )?builder/i.test(result.error ?? '')

    if (looksLikeBuilderReject && !builderUnregistered) {
      console.log(
        `[/hyperliquid/order] builder-rejection detected user=${user.id} — auto-approving and retrying`,
      )
      try {
        const { decryptPrivateKey } = await import('./services/wallet')
        // Mirror the broader candidate-id set used by /aster/approve so legacy
        // wallets (encrypted under wallet.userId rather than the new user.id)
        // still decrypt here. Without this, users onboarded before the userId
        // migration would silently fall through to the bare "Builder fee
        // not approved" reject with no path to recover.
        const idCandidates = Array.from(new Set([
          user.id,
          user.telegramId?.toString(),
          wallet.userId,
        ].filter((v): v is string => Boolean(v))))
        let userPk: string | null = null
        for (const candidate of idCandidates) {
          try {
            const out = decryptPrivateKey(wallet.encryptedPK, candidate)
            if (out?.startsWith('0x')) { userPk = out; break }
          } catch {}
        }
        if (userPk) {
          const { approveBuilderFee } = await import('./services/hyperliquid')
          const br = await approveBuilderFee(userPk)
          if (br.success) {
            // HL needs a beat for the approval to propagate to the
            // exchange's order-validation layer before the retry will see
            // it. Propagation latency is variable, so retry with backoff
            // (1.5s, 3s, 5s) before giving up — total ≤ ~10s, well under
            // the Render gateway timeout.
            const backoffsMs = [1500, 3000, 5000]
            for (let attempt = 0; attempt < backoffsMs.length; attempt++) {
              await new Promise(r => setTimeout(r, backoffsMs[attempt]))
              result = await placeOrder(creds, orderArgs)
              // If HL starts rate-limiting us mid-retry, STOP. Continuing
              // to hammer just deepens the 429 backoff window and surfaces
              // a confusing "429 Too Many Requests - null" to the user
              // instead of the actionable "Builder fee not approved" they
              // can recover from with the manual approve button.
              if (!result.success && /429|too many requests/i.test(result.error ?? '')) {
                console.warn(
                  `[/hyperliquid/order] HL rate-limited mid-retry user=${user.id} — bailing out of auto-heal loop`,
                )
                break
              }
              const stillBuilder = !result.success
                && /(builder|must approve)/i.test(result.error ?? '')
              if (!stillBuilder) break
              console.log(
                `[/hyperliquid/order] retry ${attempt + 1} still builder-rejected — backing off again`,
              )
            }
          } else {
            console.warn(
              `[/hyperliquid/order] auto-approveBuilderFee failed user=${user.id} err=${br.error}`,
            )
          }
        } else {
          console.warn(
            `[/hyperliquid/order] could not decrypt master PK for auto-approve user=${user.id}`,
          )
        }
      } catch (e: any) {
        console.warn('[/hyperliquid/order] auto-approve retry threw:', e?.message ?? e)
      }
    }

    // ── Last-resort fallback: if HL is still rejecting because OUR builder
    //   address isn't a registered/funded builder on HL, retry the order
    //   WITHOUT a builder field. Loses the 0.1% kickback for this fill but
    //   the user actually gets to trade. This path is OPS-side recoverable
    //   only — fund BUILDER_ADDRESS on HL and remove this branch's hits
    //   from logs. Surface the no-builder error to the user as a soft
    //   warning so they know the order placed but no fee was charged.
    if (!result.success && /insufficient balance|not registered|not a (registered )?builder/i.test(result.error ?? '')) {
      console.error(
        `[/hyperliquid/order] BUILDER UNREGISTERED — fund the builder address on HL. ` +
        `Falling back to no-builder order user=${user.id} err=${result.error}`,
      )
      result = await placeOrder(creds, { ...orderArgs, noBuilder: true })
      if (result.success) {
        console.warn(
          `[/hyperliquid/order] no-builder fallback succeeded user=${user.id} — 0.1% fee skipped`,
        )
      }
    }

    if (!result.success) {
      // If self-heal couldn't fix the builder reject, surface a flag so the
      // UI can prompt a manual "Approve builder fee" button (which calls
      // /api/hyperliquid/approve-builder). Match the same pattern used in
      // the auto-heal detector — `builder` OR `must approve` — so a slightly
      // worded HL reject doesn't suppress the UI button. EXCEPTION: don't
      // show the approve button for "insufficient balance" — user-side
      // approval can't fix that and the prompt would loop forever.
      const isUnregistered = /insufficient balance|not registered|not a (registered )?builder/i
        .test(result.error ?? '')
      const stillBuilder = !isUnregistered && /(builder|must approve)/i.test(result.error ?? '')
      return res.status(400).json({
        ...result,
        ...(stillBuilder ? { needsBuilderApproval: true } : {}),
      })
    }
    return res.json({
      ...result,
      coin:     sym,
      side,
      type,
      sz,
      markPrice,
      notionalUsdc: notional,
    })
  } catch (err: any) {
    console.error('[API] /hyperliquid/order failed:', err?.message ?? err)
    res.status(500).json({ success: false, error: err?.message ?? 'Internal error' })
  }
})

app.get('/api/hyperliquid/account', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    const wallet = await db.wallet.findFirst({ where: { userId: user.id, isActive: true } })
    if (!wallet) return res.status(404).json({ error: 'No active wallet' })

    const { getAccountState, getSpotUsdcBalance } = await import('./services/hyperliquid')
    // Fetch perps state + spot USDC in parallel — both are independent
    // public reads. We surface spotUsdc so the UI can prompt the user to
    // do a spot→perps transfer when funds landed on the wrong sub-account.
    const [state, spotUsdc] = await Promise.all([
      getAccountState(wallet.address),
      getSpotUsdcBalance(wallet.address),
    ])
    res.json({
      walletAddress:  wallet.address,
      onboarded:      Boolean((user as any).hyperliquidOnboarded),
      // True when this user has HL Unified Account enabled. Once detected
      // (via a failed usdClassTransfer) we persist on the User row so the
      // /account read is the single source of truth and the UI can suppress
      // the move-to-perps / move-to-spot CTAs from the very first render
      // instead of waiting for the user to tap and see the error.
      unifiedAccount: Boolean((user as any).hyperliquidUnified),
      spotUsdc,
      ...state,
    })
  } catch (err: any) {
    console.error('[API] /hyperliquid/account failed:', err?.message)
    res.status(500).json({ error: err?.message ?? 'Internal error' })
  }
})

// POST /api/hyperliquid/spot-to-perps
// Move USDC from the user's HL spot sub-account into their perps account
// from inside the mini-app — no need to leave for app.hyperliquid.xyz.
// Body: { amount?: number }  // optional; omit / 0 = move full available balance
//
// All branchy logic (per-user mutex, decrypt-candidate loop, amount
// resolution) lives in `runSpotToPerps`. This handler is just an Express
// adapter so we can unit-test the logic without booting the server. See
// src/services/hyperliquid.spot-perps.test.ts.
app.post('/api/hyperliquid/spot-to-perps', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    const { runSpotToPerps } = await import('./services/spotToPerps')
    const { decryptPrivateKey } = await import('./services/wallet')
    const { getSpotUsdcBalance, transferSpotPerp } = await import('./services/hyperliquid')
    const result = await runSpotToPerps({
      user: { id: user.id, telegramId: user.telegramId },
      rawAmount: req.body?.amount,
      deps: {
        findActiveWallet: async (userId) => {
          const w = await db.wallet.findFirst({ where: { userId, isActive: true } })
          return w
            ? { address: w.address, encryptedPK: w.encryptedPK, userId: w.userId }
            : null
        },
        decryptPrivateKey,
        getSpotUsdcBalance,
        transferSpotPerp,
        markUnifiedAccount: async (userId) => {
          await db.user.update({ where: { id: userId }, data: { hyperliquidUnified: true } })
        },
      },
    })
    res.status(result.status).json(result.body)
  } catch (err: any) {
    console.error('[API] /hyperliquid/spot-to-perps failed:', err?.message)
    res.status(500).json({ success: false, error: err?.message ?? 'Internal error' })
  }
})

// POST /api/hyperliquid/perps-to-spot
// Reverse of /spot-to-perps: move USDC from the user's perps wallet back to
// their HL spot sub-account so they can withdraw to Arbitrum (HL withdrawals
// are only possible from spot). Mirrors the spot-to-perps endpoint exactly —
// same per-user mutex (intentionally shared with spot→perps so a quick
// double-tap across either direction can't race), same master-PK decrypt
// candidate loop, same input shape: { amount?: number } (omit / 0 = move
// all free margin).
app.post('/api/hyperliquid/perps-to-spot', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    if (HL_SPOT_TRANSFER_LOCKS.has(user.id)) {
      return res.status(409).json({
        success: false,
        error:   'Transfer already in progress. Hold on a few seconds and try again.',
      })
    }
    HL_SPOT_TRANSFER_LOCKS.add(user.id)
    try {
      const wallet = await db.wallet.findFirst({ where: { userId: user.id, isActive: true } })
      if (!wallet) return res.status(404).json({ success: false, error: 'No active wallet' })

      const { decryptPrivateKey } = await import('./services/wallet')
      const { getAccountState, transferSpotPerp } = await import('./services/hyperliquid')

      // Same broad candidate set as /spot-to-perps so legacy wallets
      // encrypted under any historical convention still work.
      const idCandidates = Array.from(new Set([
        user.id,
        user.telegramId?.toString(),
        wallet.userId,
      ].filter((v): v is string => Boolean(v))))
      let userPk: string | null = null
      for (const candidate of idCandidates) {
        try {
          const out = decryptPrivateKey(wallet.encryptedPK, candidate)
          if (out?.startsWith('0x')) { userPk = out; break }
        } catch { /* try next candidate */ }
      }
      if (!userPk) {
        console.error(
          `[/hyperliquid/perps-to-spot] decrypt wallet PK failed user=${user.id} tg=${user.telegramId} wallet=${wallet.address}`,
        )
        return res.status(500).json({
          success: false,
          error: 'Could not decrypt wallet. Use Admin → Wallet recovery to re-encrypt your private key, then try again.',
        })
      }

      // Available = free margin on perps (HL withdrawable). We refuse to
      // sweep margin that's locked behind open positions — HL would reject
      // it anyway, but failing fast gives the user a clearer error.
      const rawAmount = req.body?.amount
      const requested = rawAmount == null ? 0 : Number(rawAmount)
      if (!Number.isFinite(requested) || requested < 0) {
        return res.status(400).json({ success: false, error: 'amount must be a non-negative number' })
      }
      const acc = await getAccountState(wallet.address)
      const available = acc.withdrawableUsdc
      if (available < 0.01) {
        return res.status(400).json({
          success: false,
          error: `No free margin on perps to move (${wallet.address}). Close positions first if you want to withdraw.`,
        })
      }
      const amount = requested > 0 ? Math.min(requested, available) : available

      const result = await transferSpotPerp(userPk, amount, false)
      if (!result.success) {
        // Same unified-account detection as /spot-to-perps. Persist the
        // flag so the UI suppresses the move CTA on the next /account
        // poll, and surface it in the response so the page reacts
        // instantly without waiting for the poll cycle.
        if (result.unifiedAccount) {
          try { await db.user.update({ where: { id: user.id }, data: { hyperliquidUnified: true } }) }
          catch (e: any) {
            console.warn(`[/hyperliquid/perps-to-spot] persist unified flag failed user=${user.id}: ${e?.message}`)
          }
        }
        return res.status(502).json({
          success:        false,
          error:          result.error ?? 'transfer failed',
          unifiedAccount: result.unifiedAccount || undefined,
        })
      }

      console.log(
        `[/hyperliquid/perps-to-spot] user=${user.id} tg=${user.telegramId} ` +
        `wallet=${wallet.address} moved=$${amount.toFixed(2)} (of $${available.toFixed(2)} available)`,
      )
      res.json({ success: true, amount })
    } finally {
      HL_SPOT_TRANSFER_LOCKS.delete(user.id)
    }
  } catch (err: any) {
    console.error('[API] /hyperliquid/perps-to-spot failed:', err?.message)
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

// ─────────────────────────────────────────────────────────────────────────────
// Broadcast — POST /api/admin/broadcast + GET /api/admin/broadcast/status
//
// Fan-out a single message to every reachable Telegram user. Used for
// product announcements (X Layer win, new features, etc).
//
// Why we don't just use grammy's bot.api here: a 17k-user broadcast at the
// safe ~25 msg/sec pace takes ~11 minutes, far longer than any single HTTP
// request can hold open on Render. So we kick the job off in the background
// and expose a status endpoint the admin UI polls.
//
// Only ONE broadcast can run at a time (broadcastJob singleton). Calling
// POST while a job is in-flight returns 409.
//
// Telegram errors we handle:
//   403 "bot was blocked"  / "chat not found" / "user is deactivated"
//     → set user.botBlocked = true, never message them again
//   429 "Too Many Requests" → respect retry_after, sleep, retry once
//   anything else → log, count as failed, move on
type BroadcastJob = {
  id:            string
  startedAt:     number
  finishedAt:    number | null
  total:         number
  sent:          number
  blocked:       number
  failed:        number
  dryRun:        boolean
  message:       string
  buttonText:    string | null
  buttonUrl:     string | null
  parseMode:     'Markdown' | 'HTML' | null
  lastError:     string | null
  cancelled:     boolean
}
let broadcastJob: BroadcastJob | null = null

async function tgSendMessage(
  token:     string,
  chatId:    string,
  text:      string,
  parseMode: 'Markdown' | 'HTML' | null,
  button:    { text: string; url: string } | null,
): Promise<{ ok: boolean; status: number; description?: string; retryAfter?: number }> {
  const body: any = { chat_id: chatId, text, disable_web_page_preview: false }
  if (parseMode) body.parse_mode = parseMode
  if (button) body.reply_markup = { inline_keyboard: [[{ text: button.text, url: button.url }]] }
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })
  const json: any = await resp.json().catch(() => ({}))
  if (resp.ok && json?.ok) return { ok: true, status: 200 }
  return {
    ok:          false,
    status:      resp.status,
    description: json?.description ?? `HTTP ${resp.status}`,
    retryAfter:  json?.parameters?.retry_after,
  }
}

async function runBroadcastJob(job: BroadcastJob) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    job.lastError = 'TELEGRAM_BOT_TOKEN missing'
    job.finishedAt = Date.now()
    return
  }
  // Pull only what we need. Skip botBlocked=true so we don't waste rate budget.
  const users = await db.user.findMany({
    where:  { botBlocked: false },
    select: { id: true, telegramId: true },
  })
  job.total = users.length

  const button = job.buttonText && job.buttonUrl ? { text: job.buttonText, url: job.buttonUrl } : null
  // ~25 msg/sec is comfortably below Telegram's 30/sec global cap.
  const minIntervalMs = 40

  for (const u of users) {
    if (job.cancelled) break
    const tgId = u.telegramId.toString()

    if (job.dryRun) {
      job.sent++
      continue
    }

    const startedAt = Date.now()
    let r = await tgSendMessage(token, tgId, job.message, job.parseMode, button)

    // 429 — Telegram tells us how long to wait. Respect it and retry once.
    if (!r.ok && r.status === 429 && r.retryAfter) {
      await new Promise((res) => setTimeout(res, (r.retryAfter! + 1) * 1000))
      r = await tgSendMessage(token, tgId, job.message, job.parseMode, button)
    }

    if (r.ok) {
      job.sent++
    } else if (
      r.status === 403 ||
      /blocked|deactivated|chat not found|user is deactivated/i.test(r.description ?? '')
    ) {
      job.blocked++
      try {
        await db.user.update({ where: { id: u.id }, data: { botBlocked: true } })
      } catch (e) {
        // Non-fatal — keep broadcasting.
      }
    } else {
      job.failed++
      job.lastError = `${r.status} ${r.description ?? ''}`.trim()
      console.warn(`[broadcast] tg=${tgId} failed: ${job.lastError}`)
    }

    const elapsed = Date.now() - startedAt
    if (elapsed < minIntervalMs) {
      await new Promise((res) => setTimeout(res, minIntervalMs - elapsed))
    }
  }
  job.finishedAt = Date.now()
  console.log(
    `[broadcast] job=${job.id} done sent=${job.sent} blocked=${job.blocked} failed=${job.failed} total=${job.total} dryRun=${job.dryRun}`,
  )
}

app.post('/api/admin/broadcast', requireAdmin, async (req, res) => {
  try {
    if (broadcastJob && !broadcastJob.finishedAt) {
      return res.status(409).json({
        success: false,
        error:   'A broadcast is already running',
        job:     broadcastJob,
      })
    }
    const { message, parseMode, buttonText, buttonUrl, dryRun } = req.body ?? {}
    if (typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'message required' })
    }
    if (message.length > 4000) {
      return res.status(400).json({ success: false, error: 'message exceeds 4000 chars' })
    }
    if ((buttonText && !buttonUrl) || (!buttonText && buttonUrl)) {
      return res.status(400).json({ success: false, error: 'buttonText and buttonUrl must both be set or both empty' })
    }
    const pm = parseMode === 'Markdown' || parseMode === 'HTML' ? parseMode : null

    broadcastJob = {
      id:         `bc_${Date.now()}`,
      startedAt:  Date.now(),
      finishedAt: null,
      total:      0,
      sent:       0,
      blocked:    0,
      failed:     0,
      dryRun:     !!dryRun,
      message,
      buttonText: buttonText ?? null,
      buttonUrl:  buttonUrl  ?? null,
      parseMode:  pm,
      lastError:  null,
      cancelled:  false,
    }
    // Fire-and-forget. Status endpoint is the source of truth for progress.
    runBroadcastJob(broadcastJob).catch((e) => {
      console.error('[broadcast] job crashed:', e)
      if (broadcastJob) {
        broadcastJob.lastError = e?.message ?? String(e)
        broadcastJob.finishedAt = Date.now()
      }
    })
    res.json({ success: true, job: broadcastJob })
  } catch (err: any) {
    console.error('[API] /admin/broadcast failed:', err)
    res.status(500).json({ success: false, error: err?.message ?? 'Internal error' })
  }
})

app.get('/api/admin/broadcast/status', requireAdmin, async (_req, res) => {
  res.json({ job: broadcastJob })
})

app.post('/api/admin/broadcast/cancel', requireAdmin, async (_req, res) => {
  if (broadcastJob && !broadcastJob.finishedAt) {
    broadcastJob.cancelled = true
    return res.json({ success: true, job: broadcastJob })
  }
  res.json({ success: false, error: 'No running broadcast' })
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
// $B4 buybacks (Task #9). The team performs buybacks manually for now and
// posts each tx through the admin form. The mini-app's Home tab reads the
// public stats endpoint to show "$B4 bought back to date" + recent activity.
// txHash is unique so reposting the same tx is idempotent.
// ──────────────────────────────────────────────────────────────────────────
app.post('/api/admin/buybacks', requireAdmin, async (req, res) => {
  try {
    // Lower-case the txHash so two posts of the same hash with different
    // casing collapse to one row. Without this, the check-then-insert
    // duplicate guard could be bypassed by mixed casing.
    const txHash    = String(req.body?.txHash    ?? '').trim().toLowerCase()
    const chain     = String(req.body?.chain     ?? 'BSC').trim().toUpperCase()
    const amountB4  = Number(req.body?.amountB4)
    const amountUsdt = Number(req.body?.amountUsdt)
    const note      = req.body?.note ? String(req.body.note).slice(0, 280) : null

    if (!/^0x[0-9a-f]{64}$/.test(txHash)) {
      return res.status(400).json({ success: false, error: 'txHash must be a 0x-prefixed 32-byte hex string' })
    }
    if (!Number.isFinite(amountB4) || amountB4 <= 0) {
      return res.status(400).json({ success: false, error: 'amountB4 must be a positive number' })
    }
    if (!Number.isFinite(amountUsdt) || amountUsdt <= 0) {
      return res.status(400).json({ success: false, error: 'amountUsdt must be a positive number' })
    }
    if (!['BSC', 'XLAYER', 'ARBITRUM'].includes(chain)) {
      return res.status(400).json({ success: false, error: 'chain must be BSC, XLAYER, or ARBITRUM' })
    }

    // Idempotent: if the same txHash was already posted we surface the
    // existing row instead of erroring, so admin retries are safe.
    const existing = await db.$queryRawUnsafe<Array<any>>(
      `SELECT * FROM "BuybackTx" WHERE "txHash" = $1 LIMIT 1`,
      txHash,
    )
    if (existing.length > 0) {
      return res.json({ success: true, alreadyExists: true, buyback: existing[0] })
    }

    try {
      await db.$executeRawUnsafe(
        `INSERT INTO "BuybackTx" ("id","txHash","chain","amountB4","amountUsdt","note")
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5)`,
        txHash, chain, amountB4, amountUsdt, note,
      )
      res.json({ success: true })
    } catch (insertErr: any) {
      // 23505 = unique_violation. Two admins posted the same tx
      // concurrently — both passed the SELECT, only one INSERT wins. We
      // turn the loser into an idempotent success so neither caller sees
      // a 500.
      const code = insertErr?.code ?? insertErr?.meta?.code
      const isDup =
        code === '23505' ||
        /unique constraint|duplicate key/i.test(String(insertErr?.message ?? ''))
      if (isDup) {
        const existingNow = await db.$queryRawUnsafe<Array<any>>(
          `SELECT * FROM "BuybackTx" WHERE "txHash" = $1 LIMIT 1`,
          txHash,
        )
        return res.json({ success: true, alreadyExists: true, buyback: existingNow[0] ?? null })
      }
      throw insertErr
    }
  } catch (err: any) {
    console.error('[API] /admin/buybacks POST failed:', err)
    res.status(500).json({ success: false, error: err?.message ?? 'Internal error' })
  }
})

app.delete('/api/admin/buybacks/:id', requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id ?? '')
    await db.$executeRawUnsafe(`DELETE FROM "BuybackTx" WHERE "id" = $1`, id)
    res.json({ success: true })
  } catch (err: any) {
    console.error('[API] /admin/buybacks DELETE failed:', err)
    res.status(500).json({ success: false, error: err?.message ?? 'Internal error' })
  }
})

// Public — no auth. Powers the Home-tab buyback card. Bounded result set
// so a long history can't blow up the response.
app.get('/api/buybacks', async (_req, res) => {
  try {
    const recent = await db.$queryRawUnsafe<Array<any>>(
      `SELECT "id","txHash","chain","amountB4","amountUsdt","note","createdAt"
         FROM "BuybackTx"
         ORDER BY "createdAt" DESC
         LIMIT 25`,
    )
    const totals = await db.$queryRawUnsafe<Array<{ count: bigint; b4: number | null; usdt: number | null }>>(
      `SELECT COUNT(*)::bigint AS count,
              COALESCE(SUM("amountB4"), 0)::float AS b4,
              COALESCE(SUM("amountUsdt"), 0)::float AS usdt
         FROM "BuybackTx"`,
    )
    const t = totals[0] ?? { count: 0n, b4: 0, usdt: 0 }
    res.json({
      totals: {
        count:      Number(t.count ?? 0),
        amountB4:   Number(t.b4   ?? 0),
        amountUsdt: Number(t.usdt ?? 0),
      },
      recent,
    })
  } catch (err: any) {
    console.error('[API] /buybacks failed:', err)
    res.status(500).json({ totals: { count: 0, amountB4: 0, amountUsdt: 0 }, recent: [], error: err?.message ?? 'Internal error' })
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
    // NOTE: an auto-settle call previously lived here. It was removed
    // because a misfiring on-chain finalisation check could flip live
    // status=open rows to resolved_loss on every page load, vanishing
    // user positions from the UI. Settlement now stays the agent runner's
    // job — listUserPositions just shows whatever is in the DB.

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

// GET /api/admin/predictions/stats — read-only diagnostic. Returns row
// counts in OutcomePosition broken down by status × paperTrade so we can
// see exactly what the table holds without needing direct DB access.
app.get('/api/admin/predictions/stats', requireAdmin, async (_req, res) => {
  try {
    const { db } = await import('./db')
    const rows = await db.$queryRawUnsafe<Array<{
      status: string; paperTrade: boolean; n: bigint
    }>>(
      `SELECT status, "paperTrade", COUNT(*)::bigint AS n
       FROM "OutcomePosition"
       GROUP BY status, "paperTrade"
       ORDER BY status, "paperTrade"`,
    )
    const breakdown = rows.map((r) => ({
      status: r.status, paperTrade: r.paperTrade, count: Number(r.n),
    }))
    const total = breakdown.reduce((s, r) => s + r.count, 0)
    const recent = await db.$queryRawUnsafe<Array<{
      id: string; marketTitle: string; status: string; paperTrade: boolean;
      openedAt: Date; closedAt: Date | null
    }>>(
      `SELECT id, "marketTitle", status, "paperTrade", "openedAt", "closedAt"
       FROM "OutcomePosition"
       ORDER BY "openedAt" DESC
       LIMIT 10`,
    )
    res.json({ ok: true, total, breakdown, recent })
  } catch (err) {
    console.error('[API] /admin/predictions/stats failed:', err)
    res.status(500).json({ ok: false, error: (err as Error).message })
  }
})

// POST /api/admin/predictions/backfill-recent
//
// Recovery for missing OutcomePosition rows when the chain shows real
// trades but the DB is empty (e.g. after a Postgres reset). Scans
// ERC-1155 TransferSingle MINT events (from = 0x0) on every live 42.space
// market for the last `windowHours` (default 2, max 24), filters to
// recipients in our Wallet table, parses USDT in from the same tx's
// USDT Transfer log, and inserts an OutcomePosition row mirroring what
// the live INSERT path writes. Idempotent: skips any txHash already
// present in OutcomePosition. Set { dryRun: true } to preview without
// writing.
app.post('/api/admin/predictions/backfill-recent', requireAdmin, async (req, res) => {
  try {
    const windowHours = Math.min(72, Math.max(1, Number(req.body?.windowHours ?? 2)))
    const dryRun = req.body?.dryRun === true
    // Which 42.space market lifecycle states to scan. By default we cover
    // both 'live' (open for trading) AND 'ended' (trading closed but
    // resolution pending) — users often hold positions on markets that
    // tipped from live → ended between buy and recovery, and we don't want
    // to silently skip those.
    const allowedStatuses = ['live', 'ended', 'finalised', 'resolved'] as const
    type Status = (typeof allowedStatuses)[number]
    const requestedStatuses: Status[] = Array.isArray(req.body?.statuses)
      ? req.body.statuses.filter((s: unknown): s is Status =>
          typeof s === 'string' && (allowedStatuses as readonly string[]).includes(s),
        )
      : ['live', 'ended']
    const { db } = await import('./db')
    const { ethers } = await import('ethers')
    const { buildBscProvider } = await import('./services/bscProvider')
    const { getAllMarkets, getMarketByAddress } = await import('./services/fortyTwo')
    const { readMarketOnchain } = await import('./services/fortyTwoOnchain')
    const { USDT_BSC } = await import('./services/fortyTwoTrader')

    const provider = buildBscProvider(process.env.BSC_RPC_URL)
    const latest = await provider.getBlockNumber()
    // BSC ~3s/block → 1200 blocks/hr.
    const fromBlock = Math.max(0, latest - windowHours * 1200)

    // Map of lowercased wallet address → userId.
    const wallets = await db.$queryRawUnsafe<Array<{ userId: string; address: string }>>(
      `SELECT "userId", LOWER(address) AS address FROM "Wallet" WHERE chain = 'BSC'`,
    )
    const walletByAddr = new Map(wallets.map((w) => [w.address, w.userId]))

    // Already-recorded tx hashes so we don't double-insert.
    const existingTx = await db.$queryRawUnsafe<Array<{ txHashOpen: string }>>(
      `SELECT "txHashOpen" FROM "OutcomePosition" WHERE "txHashOpen" IS NOT NULL`,
    )
    const seenTx = new Set(existingTx.map((r) => r.txHashOpen.toLowerCase()))

    // Markets to scan. We hit each requested status separately because the
    // 42 API only accepts a single status filter per call. De-dupe by
    // address in case a market shifted state between calls.
    const errors: Array<{ market: string; reason: string }> = []
    const marketMap = new Map<string, Awaited<ReturnType<typeof getAllMarkets>>[number]>()
    for (const status of requestedStatuses) {
      try {
        const ms = await getAllMarkets({ status, limit: 100 })
        for (const m of ms) marketMap.set(m.address.toLowerCase(), m)
      } catch (e) {
        errors.push({ market: `__list:${status}`, reason: (e as Error).message })
      }
    }
    const markets = [...marketMap.values()]

    // 42.space outcome tokens are ERC-6909, NOT ERC-1155. Their Transfer
    // event has the signature
    //   Transfer(address caller, address indexed sender,
    //            address indexed receiver, uint256 indexed id, uint256 amount)
    //   topic0 = 0x1b3d7edb...
    //   topic1 = sender (we want 0x0 → mint)
    //   topic2 = receiver (the buyer wallet)
    //   topic3 = id      (outcome tokenId)
    //   data   = (caller, amount)
    //
    // We also keep the legacy ERC-1155 TransferSingle topic so this scanner
    // continues to work for any market that ever ships the standard event.
    //   ERC-1155 TransferSingle(operator, from, to, id, value)
    //     topic0 = 0xc3d58168..., topic2 = from(0x0), topic3 = to
    const ERC6909_TOPIC = ethers.id(
      'Transfer(address,address,address,uint256,uint256)',
    )
    const ERC1155_TOPIC = ethers.id(
      'TransferSingle(address,address,address,uint256,uint256)',
    )
    const ZERO_TOPIC = '0x' + '0'.repeat(64)

    const matches: Array<{
      userId: string; marketAddress: string; tokenId: number;
      outcomeTokenAmount: number; txHash: string; recipient: string;
    }> = []

    // Chunk eth_getLogs into 500-block windows — most public BSC RPCs
    // (Ankr free, dataseeds) reject larger ranges with code -32062
    // "Block range is too large".
    //
    // Parallelize across markets with a concurrency cap so wide windows
    // (24h+) finish before Render's ~60s gateway timeout. Per-chunk calls
    // within a single market stay sequential — the bottleneck is total
    // RPC calls (markets × chunks), not within any one market.
    const CHUNK = 500
    const CONCURRENCY = 8

    async function scanMarket(m: typeof markets[number]) {
      let chunkStart = fromBlock
      while (chunkStart <= latest) {
        const chunkEnd = Math.min(chunkStart + CHUNK - 1, latest)
        try {
          // Match BOTH ERC-6909 and ERC-1155 mint events in one RPC call
          // by passing topic0 as an OR-list and sender/from as 0x0. The
          // zero-address filter applies at the same topic position to both
          // events: topic1 for ERC-6909 (sender) and topic1 for ERC-1155
          // would be the operator (not zero) — so a topic1=0x0 filter
          // would EXCLUDE legitimate ERC-1155 mints. Instead we drop the
          // sender filter and check it client-side per event type. The
          // node returns only events with the matching topic0, so the
          // payload stays small.
          const logs = await provider.getLogs({
            address: m.address,
            topics: [[ERC6909_TOPIC, ERC1155_TOPIC]],
            fromBlock: chunkStart,
            toBlock: chunkEnd,
          })
          for (const log of logs) {
            if (log.topics.length !== 4) continue
            let recipient = ''
            let id = 0
            let amount = 0n
            if (log.topics[0] === ERC6909_TOPIC) {
              if (log.topics[1] !== ZERO_TOPIC) continue // not a mint
              recipient = ('0x' + log.topics[2].slice(26)).toLowerCase()
              id = Number(BigInt(log.topics[3]))
              const dec = ethers.AbiCoder.defaultAbiCoder().decode(
                ['address', 'uint256'], log.data,
              )
              amount = dec[1] as bigint
            } else if (log.topics[0] === ERC1155_TOPIC) {
              if (log.topics[2] !== ZERO_TOPIC) continue // not a mint
              recipient = ('0x' + log.topics[3].slice(26)).toLowerCase()
              const dec = ethers.AbiCoder.defaultAbiCoder().decode(
                ['uint256', 'uint256'], log.data,
              )
              id = Number(dec[0] as bigint)
              amount = dec[1] as bigint
            } else {
              continue
            }
            const userId = walletByAddr.get(recipient)
            if (!userId) continue
            if (seenTx.has(log.transactionHash.toLowerCase())) continue
            matches.push({
              userId,
              marketAddress: m.address,
              tokenId: id,
              outcomeTokenAmount: Number(ethers.formatUnits(amount, 18)),
              txHash: log.transactionHash,
              recipient,
            })
          }
        } catch (e) {
          errors.push({
            market: `${m.address}@[${chunkStart},${chunkEnd}]`,
            reason: (e as Error).message,
          })
        }
        chunkStart = chunkEnd + 1
      }
    }

    // Simple worker pool: pull from a shared queue.
    let cursor = 0
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, markets.length) }, async () => {
        while (true) {
          const i = cursor++
          if (i >= markets.length) return
          await scanMarket(markets[i])
        }
      }),
    )

    if (dryRun) {
      return res.json({
        ok: true, dryRun: true, windowHours, fromBlock, toBlock: latest,
        marketsScanned: markets.length, matched: matches.length,
        sample: matches.slice(0, 5), errors,
      })
    }

    let inserted = 0
    for (const match of matches) {
      try {
        // Resolve usdtIn from the tx's USDT Transfer log
        // (sender → router/market). Falls back to estimate via marginal price.
        const receipt = await provider.getTransactionReceipt(match.txHash)
        let usdtIn = 0
        if (receipt) {
          // ERC-20 Transfer(from, to, value): topic0 = sig,
          // topic1 = from, topic2 = to, data = value.
          const ERC20_TRANSFER = ethers.id('Transfer(address,address,uint256)')
          for (const lg of receipt.logs) {
            if (lg.address.toLowerCase() !== USDT_BSC.toLowerCase()) continue
            if (lg.topics[0] !== ERC20_TRANSFER || lg.topics.length < 3) continue
            const fromAddr = ('0x' + lg.topics[1].slice(26)).toLowerCase()
            if (fromAddr !== match.recipient) continue
            try {
              const [value] = ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], lg.data)
              usdtIn = Number(ethers.formatUnits(value as bigint, 18))
              break
            } catch {}
          }
        }

        const market = await getMarketByAddress(match.marketAddress)
        const state = await readMarketOnchain(market)
        const outcome = state.outcomes.find((o) => o.tokenId === match.tokenId)
        const entryPrice = outcome?.impliedProbability ?? 0
        const outcomeLabel = outcome?.label ?? `tokenId ${match.tokenId}`
        if (!usdtIn && entryPrice > 0) {
          usdtIn = match.outcomeTokenAmount * entryPrice
        }

        await db.$executeRawUnsafe(
          `INSERT INTO "OutcomePosition"
             ("id","userId","agentId","marketAddress","marketTitle","tokenId","outcomeLabel",
              "usdtIn","entryPrice","status","paperTrade","txHashOpen","reasoning",
              "outcomeTokenAmount","providers")
           VALUES (gen_random_uuid()::text,$1,NULL,$2,$3,$4,$5,$6,$7,'open',false,$8,$9,$10,NULL)`,
          match.userId, match.marketAddress, market.question, match.tokenId,
          outcomeLabel, usdtIn, entryPrice, match.txHash,
          'Backfilled from on-chain TransferSingle', match.outcomeTokenAmount,
        )
        inserted++
      } catch (e) {
        errors.push({ market: match.marketAddress, reason: `insert ${match.txHash}: ${(e as Error).message}` })
      }
    }

    res.json({
      ok: true, dryRun: false, windowHours, fromBlock, toBlock: latest,
      marketsScanned: markets.length, matched: matches.length, inserted, errors,
    })
  } catch (err) {
    console.error('[API] /admin/predictions/backfill-recent failed:', err)
    res.status(500).json({ ok: false, error: (err as Error).message })
  }
})

// POST /api/admin/ensure-tables
//
// Re-runs the boot-time ensureNewTables() routine on demand. Idempotent —
// every statement uses CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS,
// so it's safe to call any time. Use when production has lost a table (e.g.
// "relation does not exist" errors after a DB reset / schema-search-path
// change) and we don't want to wait for a full Render redeploy to pick up
// the boot path.
app.post('/api/admin/ensure-tables', requireAdmin, async (_req, res) => {
  try {
    const { ensureNewTables } = await import('./ensureTables')
    await ensureNewTables()
    res.json({ ok: true })
  } catch (err) {
    console.error('[API] /admin/ensure-tables failed:', err)
    res.status(500).json({ ok: false, error: (err as Error).message })
  }
})

// POST /api/admin/users/enable-swarm
//
// Bulk-flips User.swarmEnabled. With { all: true } it enables swarm mode
// for every user in the DB. With { userIds: ["..."] } it targets specific
// users. With { value: false } the same call disables it.
//
// Why: when ANTHROPIC_API_KEY runs out of credits the legacy
// single-provider path errors every tick. swarmEnabled=true makes the
// trading agent fan the prompt out to all configured providers
// (XAI/HYPERBOLIC/AKASH/...) and use the highest-confidence successful
// reply when Anthropic 400s, eliminating the outage.
//
// Body: { all?: boolean, userIds?: string[], value?: boolean }
app.post('/api/admin/users/enable-swarm', requireAdmin, async (req, res) => {
  try {
    const all = req.body?.all === true
    const userIds = Array.isArray(req.body?.userIds) ? (req.body.userIds as string[]) : null
    const value = req.body?.value === false ? false : true

    if (!all && (!userIds || userIds.length === 0)) {
      return res.status(400).json({ ok: false, error: 'pass either { all: true } or { userIds: [...] }' })
    }

    let updated: number
    if (all) {
      const rows = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
        `WITH upd AS (UPDATE "User" SET "swarmEnabled" = $1 WHERE "swarmEnabled" IS DISTINCT FROM $1 RETURNING 1)
         SELECT COUNT(*)::bigint AS count FROM upd`,
        value,
      )
      updated = Number(rows[0]?.count ?? 0)
    } else {
      const rows = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
        `WITH upd AS (UPDATE "User" SET "swarmEnabled" = $1 WHERE id = ANY($2::text[]) AND "swarmEnabled" IS DISTINCT FROM $1 RETURNING 1)
         SELECT COUNT(*)::bigint AS count FROM upd`,
        value,
        userIds,
      )
      updated = Number(rows[0]?.count ?? 0)
    }

    return res.json({ ok: true, value, updated })
  } catch (err) {
    console.error('[API] /admin/users/enable-swarm failed:', err)
    return res.status(500).json({ ok: false, error: (err as Error).message })
  }
})

// GET /api/admin/predictions/diagnose
//
// Returns aggregate counts of OutcomePosition rows broken down by the four
// dimensions the swarm hero card filters on (status, paperTrade,
// providers IS NOT NULL, txHashOpen IS NOT NULL) so we can see exactly
// where swarm-driven trades are landing or dying. Also reports recent
// AgentLog OPEN_PREDICTION counts to confirm the agents are even producing
// the intent in the first place.
app.get('/api/admin/predictions/diagnose', requireAdmin, async (_req, res) => {
  try {
    const overall = await db.$queryRawUnsafe<Array<{
      status: string
      paperTrade: boolean
      hasProviders: boolean
      hasTxHash: boolean
      n: bigint
    }>>(
      `SELECT status,
              "paperTrade",
              ("providers" IS NOT NULL) AS "hasProviders",
              ("txHashOpen" IS NOT NULL) AS "hasTxHash",
              COUNT(*)::bigint AS n
       FROM "OutcomePosition"
       GROUP BY status, "paperTrade", ("providers" IS NOT NULL), ("txHashOpen" IS NOT NULL)
       ORDER BY n DESC`,
    )

    const recent = await db.$queryRawUnsafe<Array<{
      id: string
      status: string
      paperTrade: boolean
      hasProviders: boolean
      hasTxHash: boolean
      openedAt: Date
      marketTitle: string
    }>>(
      `SELECT id, status, "paperTrade",
              ("providers" IS NOT NULL) AS "hasProviders",
              ("txHashOpen" IS NOT NULL) AS "hasTxHash",
              "openedAt", "marketTitle"
       FROM "OutcomePosition"
       ORDER BY "openedAt" DESC
       LIMIT 20`,
    )

    const userFlags = await db.$queryRawUnsafe<Array<{
      total: bigint
      swarmOn: bigint
      liveOn: bigint
      both: bigint
    }>>(
      `SELECT COUNT(*)::bigint AS total,
              SUM(CASE WHEN "swarmEnabled" THEN 1 ELSE 0 END)::bigint AS "swarmOn",
              SUM(CASE WHEN "fortyTwoLiveTrade" THEN 1 ELSE 0 END)::bigint AS "liveOn",
              SUM(CASE WHEN "swarmEnabled" AND "fortyTwoLiveTrade" THEN 1 ELSE 0 END)::bigint AS both
       FROM "User"`,
    )

    const recentAgentOpens = await db.$queryRawUnsafe<Array<{
      action: string
      n: bigint
    }>>(
      `SELECT action, COUNT(*)::bigint AS n
       FROM "AgentLog"
       WHERE "createdAt" > NOW() - INTERVAL '24 hours'
         AND action IN ('OPEN_PREDICTION', 'TICK_ERROR', 'BUY', 'SELL', 'HOLD', 'SKIP_OPEN')
       GROUP BY action
       ORDER BY n DESC`,
    ).catch(() => [])

    // SKIP_OPEN breakdown: which gate is killing OPEN_LONG/SHORT decisions?
    // executionResult holds the gate name (rr_floor, confidence_floor,
    // setup_score_floor, risk_guard, twak_risk, exec_failed, etc.).
    const skipReasons = await db.$queryRawUnsafe<Array<{
      gate: string
      parsedAction: string
      n: bigint
    }>>(
      `SELECT "executionResult" AS gate,
              COALESCE("parsedAction", '?') AS "parsedAction",
              COUNT(*)::bigint AS n
       FROM "AgentLog"
       WHERE "createdAt" > NOW() - INTERVAL '24 hours'
         AND action = 'SKIP_OPEN'
       GROUP BY "executionResult", "parsedAction"
       ORDER BY n DESC
       LIMIT 30`,
    ).catch(() => [])

    return res.json({
      ok: true,
      heroCardWouldShow: overall.some(r =>
        r.status === 'open' && !r.paperTrade && r.hasProviders && r.hasTxHash
      ),
      breakdown: overall.map(r => ({ ...r, n: Number(r.n) })),
      recent20: recent,
      userFlags: {
        total: Number(userFlags[0]?.total ?? 0),
        swarmOn: Number(userFlags[0]?.swarmOn ?? 0),
        liveOn: Number(userFlags[0]?.liveOn ?? 0),
        bothOn: Number(userFlags[0]?.both ?? 0),
      },
      agentLogLast24h: recentAgentOpens.map(r => ({ action: r.action, n: Number(r.n) })),
      skipReasonsLast24h: skipReasons.map(r => ({
        gate: r.gate, decision: r.parsedAction, n: Number(r.n)
      })),
    })
  } catch (err) {
    console.error('[API] /admin/predictions/diagnose failed:', err)
    return res.status(500).json({ ok: false, error: (err as Error).message })
  }
})

// POST /api/admin/users/enable-live-trade
//
// Bulk-flips User.fortyTwoLiveTrade. With { all: true } it enables LIVE
// (real-money) prediction trading for every user; with { userIds: [...] }
// it targets specific users; with { value: false } it disables.
//
// IMPORTANT: this is the kill-switch that gates whether a user's agent is
// allowed to actually move USDT on-chain (vs writing a paper-trade row).
// Flipping all users to true means every agent that produces an
// OPEN_PREDICTION decision will sign a real BSC transaction with the
// user's wallet. Use deliberately.
//
// Body: { all?: boolean, userIds?: string[], value?: boolean }
app.post('/api/admin/users/enable-live-trade', requireAdmin, async (req, res) => {
  try {
    const all = req.body?.all === true
    const userIds = Array.isArray(req.body?.userIds) ? (req.body.userIds as string[]) : null
    const value = req.body?.value === false ? false : true

    if (!all && (!userIds || userIds.length === 0)) {
      return res.status(400).json({ ok: false, error: 'pass either { all: true } or { userIds: [...] }' })
    }

    let updated: number
    if (all) {
      const rows = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
        `WITH upd AS (UPDATE "User" SET "fortyTwoLiveTrade" = $1 WHERE "fortyTwoLiveTrade" IS DISTINCT FROM $1 RETURNING 1)
         SELECT COUNT(*)::bigint AS count FROM upd`,
        value,
      )
      updated = Number(rows[0]?.count ?? 0)
    } else {
      const rows = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
        `WITH upd AS (UPDATE "User" SET "fortyTwoLiveTrade" = $1 WHERE id = ANY($2::text[]) AND "fortyTwoLiveTrade" IS DISTINCT FROM $1 RETURNING 1)
         SELECT COUNT(*)::bigint AS count FROM upd`,
        value,
        userIds,
      )
      updated = Number(rows[0]?.count ?? 0)
    }

    return res.json({ ok: true, value, updated })
  } catch (err) {
    console.error('[API] /admin/users/enable-live-trade failed:', err)
    return res.status(500).json({ ok: false, error: (err as Error).message })
  }
})

// POST /api/admin/predictions/recover-by-tx
//
// Single-tx recovery: takes one BSC tx hash, looks up the receipt, finds the
// ERC-1155/6909 TransferSingle MINT log on a 42.space market within that tx,
// matches the recipient to a wallet in our DB, parses USDT in from the
// USDT Transfer log in the same tx, and inserts a single OutcomePosition row.
// Idempotent: skips if txHashOpen already exists. Useful when the agent
// knows the buy went through on-chain (e.g. user has the BSCscan link) but
// the row never made it into the DB.
//
// Body: { txHash: string, dryRun?: boolean }
app.post('/api/admin/predictions/recover-by-tx', requireAdmin, async (req, res) => {
  try {
    const txHash = String(req.body?.txHash ?? '').trim()
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return res.status(400).json({ ok: false, error: 'invalid_tx_hash' })
    }
    const dryRun = req.body?.dryRun === true
    const { db } = await import('./db')
    const { ethers } = await import('ethers')
    const { buildBscProvider } = await import('./services/bscProvider')
    const { getMarketByAddress } = await import('./services/fortyTwo')
    const { USDT_BSC } = await import('./services/fortyTwoTrader')

    const provider = buildBscProvider(process.env.BSC_RPC_URL)
    const receipt = await provider.getTransactionReceipt(txHash)
    if (!receipt) return res.status(404).json({ ok: false, error: 'tx_not_found' })
    if (receipt.status !== 1) {
      return res.status(400).json({ ok: false, error: 'tx_reverted_on_chain' })
    }

    // Skip if already recorded.
    const existing = await db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM "OutcomePosition" WHERE LOWER("txHashOpen") = LOWER($1) LIMIT 1`,
      txHash,
    )
    if (existing.length > 0) {
      return res.json({ ok: true, alreadyRecorded: true, positionId: existing[0].id })
    }

    // 42.space outcome tokens are ERC-6909, NOT ERC-1155. The Transfer
    // event signature differs:
    //   ERC-6909: Transfer(address caller, address indexed sender,
    //                      address indexed receiver, uint256 indexed id,
    //                      uint256 amount)  → 0x1b3d7edb...
    //   ERC-1155: TransferSingle(address indexed op, address indexed from,
    //                            address indexed to, uint256 id, uint256 v)
    //                          → 0xc3d58168...
    // We accept BOTH topics so this code keeps working if 42 ever ships a
    // contract that emits the standard ERC-1155 event.
    //
    // Mint detection: topic1 (`from` for ERC-1155, `sender` for ERC-6909) is
    // the zero address. For ERC-1155 the from is at topic2 (because operator
    // is topic1), so we check both layouts below.
    const ERC1155_TOPIC = ethers.id('TransferSingle(address,address,address,uint256,uint256)')
    const ERC6909_TOPIC = ethers.id('Transfer(address,address,address,uint256,uint256)')
    const ZERO_TOPIC = '0x' + '0'.repeat(64)
    const USDT_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)')

    const usdtIface = new ethers.Interface([
      'event Transfer(address indexed from, address indexed to, uint256 value)',
    ])

    let recipient = ''
    let tokenId = 0
    let outcomeTokenAmount = 0
    let marketAddress = ''
    for (const l of receipt.logs) {
      if (l.address.toLowerCase() === USDT_BSC.toLowerCase()) continue
      const t0 = l.topics[0]
      if (t0 === ERC6909_TOPIC && l.topics.length === 4 && l.topics[1] === ZERO_TOPIC) {
        // ERC-6909 Transfer mint: topics = [sig, sender(0x0), receiver, id], data = (caller, amount)
        recipient = ('0x' + l.topics[2].slice(26)).toLowerCase()
        tokenId = Number(BigInt(l.topics[3]))
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['address', 'uint256'], l.data)
        outcomeTokenAmount = Number(ethers.formatUnits(decoded[1] as bigint, 18))
        marketAddress = ethers.getAddress(l.address)
        break
      }
      if (t0 === ERC1155_TOPIC && l.topics.length === 4 && l.topics[2] === ZERO_TOPIC) {
        // ERC-1155 TransferSingle mint: topics = [sig, operator, from(0x0), to], data = (id, value)
        recipient = ('0x' + l.topics[3].slice(26)).toLowerCase()
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256'], l.data)
        tokenId = Number(decoded[0] as bigint)
        outcomeTokenAmount = Number(ethers.formatUnits(decoded[1] as bigint, 18))
        marketAddress = ethers.getAddress(l.address)
        break
      }
    }
    if (!marketAddress) {
      return res.status(400).json({ ok: false, error: 'no_mint_log_in_tx' })
    }

    // Find the matching wallet → user.
    const walletRows = await db.$queryRawUnsafe<Array<{ userId: string }>>(
      `SELECT "userId" FROM "Wallet" WHERE chain = 'BSC' AND LOWER(address) = $1 LIMIT 1`,
      recipient,
    )
    if (walletRows.length === 0) {
      return res.status(404).json({ ok: false, error: 'recipient_not_a_known_wallet', recipient })
    }
    const userId = walletRows[0].userId

    // Parse USDT in: Transfer(from = recipient OR initiator, to = market).
    let usdtIn = 0
    for (const l of receipt.logs) {
      if (l.address.toLowerCase() !== USDT_BSC.toLowerCase()) continue
      if (l.topics[0] !== USDT_TRANSFER_TOPIC) continue
      const p = usdtIface.parseLog({ topics: [...l.topics], data: l.data })
      if (!p) continue
      const to = String(p.args.to).toLowerCase()
      if (to === marketAddress.toLowerCase()) {
        usdtIn = Number(ethers.formatUnits(p.args.value, 18))
        break
      }
    }

    // Pull market title + outcome label for human-readable rows.
    let marketTitle = marketAddress
    let outcomeLabel = `Outcome ${tokenId}`
    let entryPrice = usdtIn > 0 && outcomeTokenAmount > 0 ? usdtIn / outcomeTokenAmount : 0
    try {
      const m = await getMarketByAddress(marketAddress)
      marketTitle = m.question ?? marketTitle
      const o = m.outcomes?.find((x) => Number(x.tokenId) === tokenId)
      if (o?.label) outcomeLabel = o.label
    } catch {}

    if (dryRun) {
      return res.json({
        ok: true, dryRun: true,
        wouldInsert: { userId, marketAddress, marketTitle, tokenId, outcomeLabel,
          usdtIn, entryPrice, outcomeTokenAmount, txHash },
      })
    }

    const inserted = await db.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO "OutcomePosition"
         ("id","userId","agentId","marketAddress","marketTitle","tokenId","outcomeLabel",
          "usdtIn","entryPrice","status","paperTrade","txHashOpen","reasoning",
          "outcomeTokenAmount","providers")
       VALUES (gen_random_uuid()::text,$1,NULL,$2,$3,$4,$5,$6,$7,'open',false,$8,$9,$10,NULL)
       RETURNING id`,
      userId, marketAddress, marketTitle, tokenId, outcomeLabel,
      usdtIn, entryPrice, txHash, 'Recovered from on-chain tx', outcomeTokenAmount,
    )
    res.json({ ok: true, positionId: inserted[0].id, userId, marketAddress, tokenId,
      outcomeLabel, usdtIn, outcomeTokenAmount })
  } catch (err) {
    console.error('[API] /admin/predictions/recover-by-tx failed:', err)
    res.status(500).json({ ok: false, error: (err as Error).message })
  }
})

// POST /api/admin/predictions/recover-mis-settled
//
// Recovery endpoint for the bug where settleResolvedPositions could flip
// open positions to resolved_loss when the on-chain `resolvedAnswer`
// briefly returned 0n while `isFinalised` was true. For every position
// whose status is resolved_win/_loss but whose market re-reads as
// non-finalised OR with answer=0n, this resets the row back to status='open'
// (clearing exitPrice, payoutUsdt, pnl, closedAt). Bounded to the last
// `windowHours` (default 24) to limit blast radius.
//
// Idempotent: re-running it after the markets actually finalise will be a
// no-op because the on-chain re-check will pass and the rows will be left
// alone (the ordinary settlement loop will then settle them correctly).
app.post('/api/admin/predictions/recover-mis-settled', requireAdmin, async (req, res) => {
  try {
    const windowHours = Math.min(168, Math.max(1, Number(req.body?.windowHours ?? 24)))
    const cutoff = new Date(Date.now() - windowHours * 3600_000)
    const { db } = await import('./db')
    const { readMarketOnchain } = await import('./services/fortyTwoOnchain')
    const { getMarketByAddress } = await import('./services/fortyTwo')

    const candidates = await db.$queryRawUnsafe<Array<{
      id: string; marketAddress: string; status: string; closedAt: Date | null
    }>>(
      `SELECT id, "marketAddress", status, "closedAt"
       FROM "OutcomePosition"
       WHERE status IN ('resolved_win','resolved_loss','closed')
         AND "closedAt" IS NOT NULL AND "closedAt" >= $1`,
      cutoff,
    )

    // Group by market so we only do one on-chain read per market.
    const byMarket = new Map<string, typeof candidates>()
    for (const c of candidates) {
      if (!byMarket.has(c.marketAddress)) byMarket.set(c.marketAddress, [])
      byMarket.get(c.marketAddress)!.push(c)
    }

    let recovered = 0
    const errors: Array<{ market: string; reason: string }> = []
    for (const [addr, rows] of byMarket) {
      try {
        const market = await getMarketByAddress(addr)
        const state = await readMarketOnchain(market)
        const looksMisSettled = !state.isFinalised || state.resolvedAnswer === 0n
        if (!looksMisSettled) continue
        for (const r of rows) {
          await db.$executeRawUnsafe(
            `UPDATE "OutcomePosition"
             SET status='open', "exitPrice"=NULL, "payoutUsdt"=NULL, pnl=NULL, "closedAt"=NULL
             WHERE id=$1`,
            r.id,
          )
          recovered++
        }
      } catch (e) {
        errors.push({ market: addr, reason: (e as Error).message })
      }
    }
    res.json({ ok: true, scanned: candidates.length, recovered, errors })
  } catch (err) {
    console.error('[API] /admin/predictions/recover-mis-settled failed:', err)
    res.status(500).json({ ok: false, error: (err as Error).message })
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

// ─────────────────────────────────────────────────────────────────────────────
// Admin: re-activate Aster for a specific user.
//
// Used when a user shows up in the logs as `400 { code: -1000, msg: 'No agent
// found' }` from Aster — meaning the asterAgentAddress on file isn't
// recognised by Aster (broker rotation, partial earlier flow, etc). Mints a
// fresh agent keypair, runs approveAgent + approveBuilder, and persists.
//
// Auth: ADMIN_TOKEN via x-admin-token header (or ?token=). Same pattern as
// the other /api/admin/* endpoints.
//
// Body: { userId: string }  OR  { walletAddress: string }
// Returns: { success, agentAddress?, builderEnrolled?, error? }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/admin/aster/reactivate-user', express.json(), async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN
  if (adminToken) {
    const supplied = (req.headers['x-admin-token'] as string | undefined)
      ?? (typeof req.query.token === 'string' ? req.query.token : undefined)
    if (supplied !== adminToken) return res.status(401).json({ error: 'Unauthorized' })
  }
  try {
    const { userId, walletAddress } = (req.body ?? {}) as { userId?: string; walletAddress?: string }
    let user: any = null
    if (userId) {
      user = await db.user.findUnique({ where: { id: userId } })
    } else if (walletAddress) {
      const w = await db.wallet.findFirst({
        where: { address: { equals: walletAddress, mode: 'insensitive' }, isActive: true },
      })
      if (w) user = await db.user.findUnique({ where: { id: w.userId } })
    } else {
      return res.status(400).json({ error: 'Provide userId or walletAddress' })
    }
    if (!user) return res.status(404).json({ error: 'User not found' })

    const { reapproveAsterForUser } = await import('./services/asterReapprove')
    const result = await reapproveAsterForUser(user)
    return res.json({ ...result, userId: user.id })
  } catch (e: any) {
    console.error('[admin/aster/reactivate-user] failed:', e)
    return res.status(500).json({ success: false, error: e?.message ?? 'internal' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/wallet/diagnose-decrypt
//
// Forensic tool for "Could not decrypt wallet" cases. Tries every plausible
// (userId × masterKey) combination against a wallet's encryptedPK and reports
// which combo (if any) worked.
//
// Body: { walletAddress: string }  OR  { userId: string }
// Optional: { extraKey?: string, extraUserId?: string } — paste a candidate
//           master key or user-id we want to test that's not in env.
//
// Returns:
//   { wallet: {...}, candidates: [{userId, key, label, ok, reason?, prefix?}],
//     anyOk: bool, currentEnv: { hasMaster, hasLegacy, sameValue } }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/admin/wallet/diagnose-decrypt', express.json(), async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN
  if (adminToken) {
    const supplied = (req.headers['x-admin-token'] as string | undefined)
      ?? (typeof req.query.token === 'string' ? req.query.token : undefined)
    if (supplied !== adminToken) return res.status(401).json({ error: 'Unauthorized' })
  }
  try {
    const { walletAddress, userId, extraKey, extraUserId } = (req.body ?? {}) as {
      walletAddress?: string; userId?: string; extraKey?: string; extraUserId?: string
    }
    let wallet: any = null
    let candidateWallets: any[] = []
    if (walletAddress) {
      // Try exact match first; fall back to startsWith so the operator can
      // paste the truncated form (e.g. "0x9751") that we see in screenshots.
      wallet = await db.wallet.findFirst({
        where: { address: { equals: walletAddress, mode: 'insensitive' } },
      })
      if (!wallet) {
        candidateWallets = await db.wallet.findMany({
          where: { address: { startsWith: walletAddress, mode: 'insensitive' } },
          take: 10,
        })
        if (candidateWallets.length === 1) wallet = candidateWallets[0]
      }
    } else if (userId) {
      wallet = await db.wallet.findFirst({ where: { userId, isActive: true } })
    } else {
      return res.status(400).json({ error: 'Provide walletAddress or userId' })
    }
    if (!wallet?.encryptedPK) {
      return res.status(404).json({
        error: 'Wallet not found or no encryptedPK',
        hint: candidateWallets.length > 1
          ? `${candidateWallets.length} wallets matched the prefix — provide a longer address`
          : 'Try a partial address prefix or provide userId',
        matches: candidateWallets.map(w => ({ address: w.address, userId: w.userId, hasPK: Boolean(w.encryptedPK) })),
      })
    }

    // Find every User row that historically might have owned this wallet.
    // Includes the current owner plus any user with the same telegramId
    // (account re-creates).
    const owner = await db.user.findUnique({ where: { id: wallet.userId } })
    let siblingUsers: any[] = []
    if (owner?.telegramId) {
      siblingUsers = await db.user.findMany({ where: { telegramId: owner.telegramId } })
    }
    const userIdSet = new Set<string>(
      [wallet.userId, owner?.id, owner?.telegramId?.toString(), extraUserId,
        ...siblingUsers.map(u => u.id),
        ...siblingUsers.map(u => u.telegramId?.toString()),
      ].filter((v): v is string => Boolean(v))
    )

    const masterPrimary = process.env.MASTER_ENCRYPTION_KEY ?? process.env.WALLET_ENCRYPTION_KEY ?? 'default_dev_key_change_in_prod_32c'
    const masterLegacy  = process.env.WALLET_ENCRYPTION_KEY ?? process.env.MASTER_ENCRYPTION_KEY ?? 'default-dev-key-change-me-32chars!'
    const keySet = new Map<string, string>([
      ['MASTER_ENCRYPTION_KEY', masterPrimary],
      ['WALLET_ENCRYPTION_KEY', masterLegacy],
      ['default-modern',        'default_dev_key_change_in_prod_32c'],
      ['default-legacy',        'default-dev-key-change-me-32chars!'],
    ])
    if (extraKey) keySet.set('extraKey', extraKey)

    const CryptoJS = (await import('crypto-js')).default
    const blob = wallet.encryptedPK as string
    const candidates: any[] = []
    let anyOk = false
    for (const uid of userIdSet) {
      for (const [keyLabel, masterValue] of keySet) {
        const keyMaterial = masterValue + uid
        const key = CryptoJS.SHA256(keyMaterial).toString()
        let ok = false; let reason: string | null = null; let prefix: string | null = null
        try {
          const bytes = CryptoJS.AES.decrypt(blob, key)
          const out = bytes.toString(CryptoJS.enc.Utf8)
          if (out) {
            ok = out.startsWith('0x')
            prefix = out.slice(0, 6)
            if (!ok) reason = 'decrypted but no 0x prefix'
          } else {
            reason = 'empty result (wrong key)'
          }
        } catch (e: any) {
          reason = e?.message ?? 'threw'
        }
        if (ok) anyOk = true
        candidates.push({ userId: uid.slice(0, 12) + '…', keyLabel, ok, reason, prefix })
      }
    }

    return res.json({
      wallet: { id: wallet.id, address: wallet.address, userId: wallet.userId, isActive: wallet.isActive,
                blobLen: blob.length, blobHead: blob.slice(0, 16) },
      owner: owner ? { id: owner.id, telegramId: owner.telegramId?.toString(), asterOnboarded: owner.asterOnboarded } : null,
      siblingUserCount: siblingUsers.length,
      candidates,
      anyOk,
      currentEnv: {
        hasMaster:  Boolean(process.env.MASTER_ENCRYPTION_KEY),
        hasLegacy:  Boolean(process.env.WALLET_ENCRYPTION_KEY),
        sameValue:  process.env.MASTER_ENCRYPTION_KEY === process.env.WALLET_ENCRYPTION_KEY,
        masterLen:  process.env.MASTER_ENCRYPTION_KEY?.length ?? null,
        legacyLen:  process.env.WALLET_ENCRYPTION_KEY?.length ?? null,
      },
    })
  } catch (e: any) {
    console.error('[admin/wallet/diagnose-decrypt] failed:', e)
    return res.status(500).json({ error: e?.message ?? 'internal' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/wallet/reencrypt
//
// Recovery tool for wallets whose encryptedPK can no longer be decrypted by
// any of the candidate keys (env rotation gap, externally-encrypted import,
// historical default drift). Operator pastes the raw private key once; we
// validate it actually corresponds to the wallet's address, then re-encrypt
// with the CURRENT MASTER_ENCRYPTION_KEY scheme and update the row.
//
// Body: { walletAddress: string, privateKey: string, telegramId?: string|number }
//   - telegramId is optional but recommended when multiple users share an
//     address (defensive disambiguation; rare in practice).
//
// Auth: requireAdmin (Telegram-id allowlist OR ADMIN_TOKEN header), same
// pattern as /api/admin/buybacks. The mini-app's Admin tab calls this via
// the standard apiFetch path so no token plumbing is needed in the UI.
//
// CRITICAL: this endpoint accepts a raw private key in the request body.
// Only call over HTTPS and never log the body. The PK is round-tripped
// in memory and the request body is discarded after the DB write.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/wallet/list?telegramId=<id>
//
// Helper for the Wallet Recovery panel: returns the wallet rows for a given
// Telegram user (address, chain, walletId, decryptable boolean, age) so the
// operator can see which wallet they actually need the PK for, instead of
// guessing the address. Read-only.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/admin/wallet/list', requireAdmin, async (req, res) => {
  try {
    const tgRaw = typeof req.query.telegramId === 'string' ? req.query.telegramId.trim() : ''
    if (!/^\d{1,20}$/.test(tgRaw)) {
      return res.status(400).json({ error: 'telegramId query param required (digits)' })
    }
    const u = await db.user.findFirst({ where: { telegramId: BigInt(tgRaw) } })
    if (!u) return res.status(404).json({ error: `No user with telegramId=${tgRaw}` })

    const rows = await db.wallet.findMany({
      where: { userId: u.id },
      select: { id: true, address: true, chain: true, encryptedPK: true, createdAt: true },
    })

    const { decryptPrivateKey } = await import('./services/wallet')
    const wallets = rows.map((w) => {
      let decryptable = false
      try { decryptPrivateKey(w.encryptedPK, u.id); decryptable = true } catch {}
      return {
        walletId:    w.id,
        address:     w.address,
        chain:       w.chain,
        decryptable,
        createdAt:   w.createdAt,
      }
    })
    return res.json({ userId: u.id, telegramId: tgRaw, wallets })
  } catch (e: any) {
    console.error('[admin/wallet/list] failed:', e?.message ?? e)
    return res.status(500).json({ error: e?.message ?? 'internal' })
  }
})

app.post('/api/admin/wallet/reencrypt', requireAdmin, express.json(), async (req, res) => {
  // Identify the admin actor for the audit log. requireAdmin attaches
  // req.user when the caller authenticated via Telegram initData; for the
  // ADMIN_TOKEN path req.user is undefined and we record "token-auth".
  const actor = (req as any).user
    ? `tg=${(req as any).user.telegramId} userId=${(req as any).user.id}`
    : 'token-auth'

  try {
    const { walletAddress, privateKey, telegramId, chain, walletId } =
      (req.body ?? {}) as {
        walletAddress?: string
        privateKey?: string
        telegramId?: string | number
        chain?: string
        walletId?: string
      }

    if (!walletAddress || typeof walletAddress !== 'string'
        || !/^0x[0-9a-fA-F]{40}$/.test(walletAddress.trim())) {
      return res.status(400).json({ error: 'walletAddress must be a 0x-prefixed 40-hex string' })
    }
    if (!privateKey || typeof privateKey !== 'string'
        || !/^(0x)?[0-9a-fA-F]{64}$/.test(privateKey.trim())) {
      return res.status(400).json({ error: 'privateKey must be 64 hex chars (0x prefix optional)' })
    }
    const addrNormalized = walletAddress.trim()
    const pkRaw = privateKey.trim()
    const pkNormalized = pkRaw.startsWith('0x') ? pkRaw : `0x${pkRaw}`

    // Disambiguation contract (architect review):
    //   - walletId, when provided, is the strongest selector and short-circuits.
    //   - Otherwise telegramId is required so we can scope to that user's
    //     wallets. We refuse to operate on walletAddress alone because the
    //     Wallet table has no uniqueness constraint on `address` and the same
    //     EVM address can legitimately appear under multiple users (e.g.
    //     re-imported wallet) or multiple chains for one user.
    //   - If the resulting query matches !=1 row we abort and report the count
    //     so the operator can supply walletId or chain explicitly.
    let candidates: any[]

    if (walletId) {
      const w = await db.wallet.findUnique({ where: { id: walletId } })
      candidates = w ? [w] : []
    } else {
      if (telegramId === undefined || telegramId === null || telegramId === '') {
        return res.status(400).json({
          error: 'telegramId is required (or supply walletId) — refusing to disambiguate by address alone',
        })
      }
      const tgStr = String(telegramId).trim()
      if (!/^\d{1,20}$/.test(tgStr)) {
        return res.status(400).json({ error: 'telegramId must be a numeric Telegram user id' })
      }
      const u = await db.user.findFirst({ where: { telegramId: BigInt(tgStr) } })
      if (!u) return res.status(404).json({ error: `No user with telegramId=${tgStr}` })

      const where: any = {
        userId:  u.id,
        address: { equals: addrNormalized, mode: 'insensitive' },
      }
      if (chain && typeof chain === 'string' && chain.trim()) where.chain = chain.trim()

      candidates = await db.wallet.findMany({ where })
    }

    if (candidates.length === 0) {
      console.warn(`[admin/wallet/reencrypt] not_found actor=${actor} addr=${addrNormalized}`)
      return res.status(404).json({ error: 'Wallet not found' })
    }
    if (candidates.length > 1) {
      console.warn(
        `[admin/wallet/reencrypt] ambiguous actor=${actor} addr=${addrNormalized} ` +
        `count=${candidates.length} chains=${candidates.map((w) => w.chain).join(',')}`
      )
      return res.status(409).json({
        error: 'Multiple wallets matched — supply chain or walletId to disambiguate',
        matchCount: candidates.length,
        chains: candidates.map((w: any) => w.chain),
        walletIds: candidates.map((w: any) => w.id),
      })
    }
    const wallet = candidates[0]

    // Validate the PK actually controls the address before touching the DB.
    // Prevents the operator from bricking a wallet by pasting the wrong key.
    const { ethers } = await import('ethers')
    let derivedAddress: string
    try {
      derivedAddress = new ethers.Wallet(pkNormalized).address
    } catch {
      return res.status(400).json({ error: 'Invalid private key (failed to parse)' })
    }
    if (derivedAddress.toLowerCase() !== wallet.address.toLowerCase()) {
      return res.status(400).json({
        error: 'Private key does not match the resolved wallet address',
        derivedAddress,
        resolvedAddress: wallet.address,
      })
    }

    // Re-encrypt with the CURRENT scheme (encryptPrivateKey reads MASTER_KEY
    // at module load). The decrypt path will reach this blob via the primary
    // MASTER_KEY candidate from now on.
    const { encryptPrivateKey, decryptPrivateKey } = await import('./services/wallet')
    const newEncrypted = encryptPrivateKey(pkNormalized, wallet.userId)

    // Sanity check: round-trip the new blob before persisting. Catches any
    // env/scheme drift between encrypt and decrypt (defense in depth).
    let roundTrip: string
    try {
      roundTrip = decryptPrivateKey(newEncrypted, wallet.userId)
    } catch (e: any) {
      return res.status(500).json({ error: `Re-encryption sanity check failed: ${e?.message}` })
    }
    if (roundTrip !== pkNormalized) {
      return res.status(500).json({ error: 'Re-encryption sanity check returned mismatched PK' })
    }

    await db.wallet.update({
      where: { id: wallet.id },
      data:  { encryptedPK: newEncrypted },
    })

    console.log(
      `[admin/wallet/reencrypt] success actor=${actor} target_user=${wallet.userId} ` +
      `walletId=${wallet.id} address=${wallet.address} chain=${wallet.chain} ` +
      `oldBlobLen=${wallet.encryptedPK?.length ?? 0} newBlobLen=${newEncrypted.length}`
    )
    return res.json({
      success:  true,
      walletId: wallet.id,
      userId:   wallet.userId,
      address:  wallet.address,
      chain:    wallet.chain,
    })
  } catch (e: any) {
    console.error(`[admin/wallet/reencrypt] failed actor=${actor} err=${e?.message ?? e}`)
    return res.status(500).json({ error: e?.message ?? 'internal' })
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
