import express from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { Prisma } from '@prisma/client'
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

// gzip/brotli compression for all responses. The mini-app bundle is ~976KB
// uncompressed; with default level-6 gzip this drops to ~280KB on the wire.
// Skips already-compressed responses (images, fonts) automatically. Filter
// honours the standard `x-no-compression` opt-out header for callers that
// stream raw bytes (none today, but cheap insurance).
const compression = (await import('compression')).default
app.use(compression({
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false
    return compression.filter(req, res)
  },
}))

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

// ── Public landing page (https://build4.io/) ────────────────────────────────
// Serves public/index.html with the WalletConnect Project ID injected in
// place of the placeholder string. We read the file once at boot, do the
// substitution, and cache the rendered HTML in memory (it never changes
// for the life of the process — the Project ID comes from a process env
// var). Failing to find the project id is non-fatal: the landing page
// still renders, but the Launch App button will surface a clear error
// when clicked instead of silently breaking.
const landingPath = path.join(__dirname, '..', 'public', 'index.html')
let _landingHtml: string | null = null
function getLandingHtml(): string {
  if (_landingHtml) return _landingHtml
  try {
    const raw = fs.readFileSync(landingPath, 'utf-8')
    const projectId = process.env.WALLETCONNECT_PROJECT_ID ?? ''
    if (!projectId) {
      console.warn('[landing] WALLETCONNECT_PROJECT_ID is not set — Launch App button will show an error when clicked.')
    }
    // Replace ALL occurrences of the placeholder so we don't accidentally
    // leave one behind if the page references the id more than once.
    _landingHtml = raw.split('__WALLETCONNECT_PROJECT_ID__').join(projectId)
    return _landingHtml
  } catch (err) {
    console.error('[landing] failed to read public/index.html:', (err as Error).message)
    // Last-resort fallback so the root path still serves something useful
    // (a redirect to the Telegram bot) instead of a 500 if the file is
    // missing on disk for any reason.
    return '<!doctype html><meta http-equiv="refresh" content="0;url=https://t.me/BUILD4_BOT">'
  }
}
app.get('/', (_req, res) => {
  // One website: build4.io. The bot's root redirects there so visitors
  // never see a separate landing page. Miniapp routes (/app/*) and API
  // routes (/api/*) are unaffected and continue to serve Telegram users.
  // 302 (temporary) instead of 301 to avoid aggressive browser caching
  // in case we want to change this back.
  res.setHeader('Cache-Control', 'no-store')
  res.redirect(302, 'https://build4.io/')
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
    // Backfill four.meme columns via raw SQL — these columns are added
    // by ensureTables but not all are in the deployed Prisma schema, so
    // a typed findMany() may not SELECT them. Without this the mini-app
    // toggle + interval input have no read source and would visibly
    // reset on reload even though the PATCH writes succeed.
    let approvalById = new Map<string, boolean>()
    let launchEnabledById = new Map<string, boolean>()
    let intervalById = new Map<string, number | null>()
    let initialBuyById = new Map<string, string | null>()
    let takeProfitById = new Map<string, number | null>()
    if (agents.length > 0) {
      try {
        const ids = agents.map(a => a.id)
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ')
        const rows = await db.$queryRawUnsafe<Array<{
          id: string
          requiresApproval: boolean | null
          launchEnabled: boolean | null
          intervalMinutes: number | null
          initialBuyBnb: string | null
          takeProfitPct: number | null
        }>>(
          `SELECT "id",
                  "fourMemeLaunchRequiresApproval" AS "requiresApproval",
                  "fourMemeLaunchEnabled"          AS "launchEnabled",
                  "fourMemeLaunchIntervalMinutes"  AS "intervalMinutes",
                  "fourMemeLaunchInitialBuyBnb"    AS "initialBuyBnb",
                  "fourMemeLaunchTakeProfitPct"    AS "takeProfitPct"
             FROM "Agent" WHERE "id" IN (${placeholders})`,
          ...ids,
        )
        for (const r of rows) {
          approvalById.set(r.id, !!r.requiresApproval)
          launchEnabledById.set(r.id, !!r.launchEnabled)
          intervalById.set(
            r.id,
            Number.isFinite(Number(r.intervalMinutes)) ? Number(r.intervalMinutes) : null,
          )
          initialBuyById.set(
            r.id,
            typeof r.initialBuyBnb === 'string' && r.initialBuyBnb.trim() !== '' ? r.initialBuyBnb : null,
          )
          takeProfitById.set(
            r.id,
            Number.isFinite(Number(r.takeProfitPct)) ? Number(r.takeProfitPct) : null,
          )
        }
      } catch (e: any) {
        console.warn('[API] /me/agents fourMeme columns backfill failed:', e?.message)
      }
    }
    res.json(agents.map(a => ({
      ...a,
      fourMemeLaunchRequiresApproval: approvalById.get(a.id) ?? false,
      fourMemeLaunchEnabled: launchEnabledById.get(a.id) ?? (a as any).fourMemeLaunchEnabled ?? false,
      // Demo Day — DEFAULT and MINIMUM = 1 minute. Coerce null/<1
      // legacy values to 1 so the UI input always shows a sensible
      // floor. The agent's tick gate uses the same floor server-side.
      fourMemeLaunchIntervalMinutes: (() => {
        const raw = intervalById.has(a.id) ? intervalById.get(a.id) : null
        const n = Number(raw)
        return Number.isFinite(n) && n >= 1 && n <= 60 ? n : 1
      })(),
      fourMemeLaunchInitialBuyBnb: initialBuyById.has(a.id) ? initialBuyById.get(a.id) : null,
      fourMemeLaunchTakeProfitPct: takeProfitById.has(a.id) ? takeProfitById.get(a.id) : null,
    })))
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
  // Internal gate identifier for SKIP_OPEN entries (rr_floor, no_balance,
  // venue_rejected, …). Null on every other action. The mini app turns
  // this into a friendly label so the user sees WHICH check killed the
  // trade in plain language rather than just "skipped".
  gate: string | null
  pair: string | null
  price: number | null
  reason: string | null
  adx: number | null
  rsi: number | null
  score: number | null
  regime: string | null
  // Which venue this row belongs to: 'aster' | 'hyperliquid' | 'fortytwo'
  // (or null for rows that legitimately have no venue, e.g. legacy logs).
  // Mini-app renders a coloured chip per venue so the user can tell at a
  // glance which exchange a brain-feed line came from.
  exchange: string | null
  createdAt: Date
}

async function fetchAgentLogFeed(where: any, limit: number, agentNameById: Map<string, string>, before?: Date): Promise<FeedEntry[]> {
  try {
    const entries = await db.agentLog.findMany({
      where: {
        ...where,
        pair: { not: null },
        // Strict `<` (not `<=`) so a "Load older" call using the oldest
        // visible entry's timestamp as the cursor never re-includes that
        // entry — which would render as a duplicate in the feed.
        ...(before ? { createdAt: { lt: before } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { agent: { select: { name: true, exchange: true } } }
    } as any)

    // ── Per-row venue tag, with raw-SQL backfill for stale Prisma clients.
    //
    // The runner writes each brain-feed row with a per-tick `exchange`
    // value — fortytwo for 42.space scans, hyperliquid for HL ticks,
    // aster for Aster — so the mini-app can render the right venue chip.
    // BUT: Prisma's typed `findMany` only SELECTs columns the deployed
    // Prisma client knows about, and on prod the client is sometimes
    // stale relative to schema.prisma. When that happens `exchange` is
    // missing from `entries[i]` even though the column is populated in
    // Postgres, so the `e.exchange ?? e.agent?.exchange` fallback below
    // would always lose to the agent's primary venue (typically aster)
    // and a 42.space row would render with an ASTER chip — the exact
    // bug we just shipped a fix for on the write path.
    //
    // To make the read bulletproof regardless of Prisma client state,
    // we issue a parallel raw SELECT for just the `exchange` column on
    // these row IDs and merge it in. One extra round-trip per page,
    // O(rows) memory; trivial cost for total resilience.
    const idList = (entries as any[]).map((e) => e.id).filter(Boolean)
    let rawExchangeById = new Map<string, string | null>()
    if (idList.length > 0) {
      try {
        const placeholders = idList.map((_, i) => `$${i + 1}`).join(', ')
        const rows = await db.$queryRawUnsafe<Array<{ id: string; exchange: string | null }>>(
          `SELECT "id", "exchange" FROM "AgentLog" WHERE "id" IN (${placeholders})`,
          ...idList,
        )
        for (const r of rows) rawExchangeById.set(r.id, r.exchange ?? null)
      } catch (rawErr: any) {
        // Swallow — column may not exist yet on a brand-new deploy
        // before ensureTables has finished its first run. Fallback
        // logic below still produces a sensible chip from the Agent
        // table; we just lose per-row precision until next tick.
        console.warn('[API] feed exchange raw-select failed:', rawErr?.message)
      }
    }

    return (entries as any[]).map((e) => ({
      id: e.id,
      agentId: e.agentId,
      agentName: e.agent?.name ?? agentNameById.get(e.agentId) ?? 'Agent',
      action: e.action,
      // executionResult is reused on SKIP_OPEN rows to carry the gate
      // identifier (rr_floor, no_balance, …). On other action types it
      // may hold an unrelated value, so only surface it for SKIP_OPEN.
      gate: e.action === 'SKIP_OPEN' ? (e.executionResult ?? null) : null,
      pair: e.pair ?? null,
      price: e.price ?? null,
      reason: e.reason ?? null,
      adx: e.adx ?? null,
      rsi: e.rsi ?? null,
      score: e.score ?? null,
      regime: e.regime ?? null,
      // Venue tag — preference order:
      //   1. Raw-SQL backfilled `exchange` column (always trustworthy
      //      because raw SQL bypasses the typed-client schema cache).
      //   2. Typed `e.exchange` from Prisma's SELECT — works when the
      //      deployed Prisma client is up to date.
      //   3. Agent's primary `exchange` — fallback for legacy rows
      //      from before the column existed. Loses per-tick venue
      //      precision but produces a non-null chip.
      exchange:
        rawExchangeById.get(e.id) ??
        e.exchange ??
        e.agent?.exchange ??
        null,
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

async function fetchTradeFeed(where: any, limit: number, agentNameById: Map<string, string>, before?: Date): Promise<FeedEntry[]> {
  // Trades are split into two virtual feed entries: one OPEN at openedAt, and
  // one CLOSE at closedAt if the trade has closed. That way the user sees
  // both sides of the lifecycle in chronological order.
  // The `before` cursor filters on openedAt — close-side virtual rows
  // anchored at closedAt could in theory still leak through if a trade
  // opened before the cursor closed after it, but that's the desired
  // behaviour (the close event IS older than the cursor in those cases
  // by openedAt and never duplicates a previously-seen entry id).
  const trades = await db.trade.findMany({
    where: { ...where, ...(before ? { openedAt: { lt: before } } : {}) },
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
      gate: null,
      pair: t.pair,
      price: t.entryPrice,
      reason: t.aiReasoning ?? `Executed on ${t.exchange} · size $${Number(t.size).toFixed(2)} · ${t.leverage}x`,
      adx: sig.adx ?? null,
      rsi: sig.rsi ?? null,
      score: sig.setupScore ?? sig.score ?? null,
      regime: sig.regime ?? null,
      exchange: t.exchange ?? null,
      createdAt: t.openedAt
    })
    if (t.closedAt) {
      const pnlStr = t.pnl != null ? `${t.pnl >= 0 ? '+' : ''}${Number(t.pnl).toFixed(2)} USDT` : ''
      out.push({
        id: `trade-close-${t.id}`,
        agentId: t.agentId ?? '',
        agentName,
        action: 'CLOSE',
        gate: null,
        pair: t.pair,
        price: t.exitPrice ?? t.entryPrice,
        reason: `Closed ${t.side} ${pnlStr}`.trim(),
        adx: null,
        rsi: null,
        score: null,
        regime: null,
        exchange: t.exchange ?? null,
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
        gate: null,
        pair: f.symbol,
        price: f.price,
        reason: `Closed ${f.positionSide !== 'BOTH' ? f.positionSide : (f.side === 'SELL' ? 'LONG' : 'SHORT')} ${f.realizedPnl >= 0 ? '+' : ''}${f.realizedPnl.toFixed(2)} USDT`,
        adx: null,
        rsi: null,
        score: null,
        regime: null,
        exchange: 'aster',
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
    // `before` is an ISO timestamp cursor for "Load older entries". When
    // present, only entries strictly older than this time are returned.
    // Bad timestamps fall through silently as undefined so a stale URL
    // can't 500 the feed.
    const beforeStr = req.query.before ? String(req.query.before) : ''
    const beforeDate = beforeStr ? new Date(beforeStr) : undefined
    const before = beforeDate && !isNaN(beforeDate.getTime()) ? beforeDate : undefined
    const agents = await db.agent.findMany({ where: { userId: user.id }, select: { id: true, name: true } })
    const nameById = new Map(agents.map((a) => [a.id, a.name]))
    const [logFeed, tradeFeed, asterFeed] = await Promise.all([
      fetchAgentLogFeed({ userId: user.id }, limit, nameById, before),
      fetchTradeFeed({ userId: user.id }, limit, nameById, before),
      // Aster fill feed reads the live exchange API and doesn't support
      // a `before` cursor — skip it on paginated calls so the merged
      // result doesn't keep reinjecting the latest fills as "older".
      // Trade-off: Aster fills older than what the live API returned
      // in the user's first un-paginated fetch will not appear when
      // the user clicks "Load older". DB-resident agent logs and our
      // own Trade rows still paginate normally. If this becomes a real
      // gap users complain about, plumb `endTime`/`fromId` through
      // fetchAsterTradeFeed → Aster userTrades API.
      before ? Promise.resolve([]) : fetchAsterTradeFeed(user.id, limit),
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

// Public campaign brain feed — no auth required. Funnels new visitors
// who hit the /app?startapp=brain deep link from any public surface
// (Telegram bot About page, Twitter share, etc.) directly into a live
// view of the campaign agent's reasoning. Only returns rows for the
// agent pinned by FT_CAMPAIGN_AGENT_ID, so non-campaign agents (and
// non-campaign trading data) stay private.
//
// In-memory 10s cache. The mini-app polls every 20s per viewer; with
// a viral campaign share that could be hundreds of concurrent visitors
// hammering the DB. Caching the (small) JSON response by query-string
// key for 10s collapses N concurrent requests into 1 DB roundtrip
// while keeping the feed feeling live (max 10s staleness vs a 20s
// poll cadence). Pre-paginated requests (?before=...) get distinct
// cache slots so "Load older" still works correctly.
const brainCache = new Map<string, { exp: number; body: any }>()
const BRAIN_CACHE_TTL_MS = 10_000
app.get('/api/public/campaign/brain', async (req, res) => {
  try {
    const cacheKey = `${req.query.limit ?? ''}|${req.query.before ?? ''}`
    const cached = brainCache.get(cacheKey)
    if (cached && cached.exp > Date.now()) {
      return res.json(cached.body)
    }
    // Opportunistic GC: prune expired entries when the map grows.
    if (brainCache.size > 100) {
      const now = Date.now()
      for (const [k, v] of brainCache) if (v.exp <= now) brainCache.delete(k)
    }
    const agentId = process.env.FT_CAMPAIGN_AGENT_ID
    if (!agentId) {
      return res.json({ agent: null, entries: [] })
    }
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      select: { id: true, name: true },
    })
    if (!agent) {
      return res.json({ agent: null, entries: [] })
    }

    // Compute REAL campaign stats from OutcomePosition. The Agent table's
    // totalTrades / totalPnl / winRate counters are updated on perp trades
    // only, so they always read 0 for the prediction-market campaign agent
    // and would mislead viewers into thinking the bot hadn't traded yet.
    // We aggregate the actual prediction positions here:
    //   - openPositions   = status='open' rows (live exposure)
    //   - resolved        = resolved_win + resolved_loss (settled rounds)
    //   - wins            = resolved_win
    //   - totalVolume     = sum(usdtIn) over ALL rows (cumulative $ traded)
    //   - realisedPnl     = sum(pnl) over resolved rows
    //   - winRate         = wins / resolved (null when nothing resolved yet)
    let stats = {
      openPositions: 0,
      resolved: 0,
      wins: 0,
      totalVolume: 0,
      realisedPnl: 0,
      winRate: null as number | null,
    }
    try {
      const positions = await db.outcomePosition.findMany({
        where: { agentId: agent.id },
        select: { status: true, usdtIn: true, pnl: true },
      })
      const open = positions.filter((p) => p.status === 'open')
      // Status flow for a campaign prediction position:
      //   open → resolved_win → claimed   (winning round, redeemed)
      //   open → resolved_loss            (losing round, no redemption)
      //   open → closed                   (manual sell before resolution)
      // A 'claimed' row IS a settled win that's been paid out — it must
      // count toward both `resolved` and `wins`, otherwise the brain feed
      // shows Resolved 0/0 + $0 PnL the moment the user clicks "claim"
      // from the wallet UI (which is what bit us in production: Round 1
      // paid out, the user claimed manually, and the page zeroed itself).
      const wins = positions.filter(
        (p) => p.status === 'resolved_win' || p.status === 'claimed',
      )
      const losses = positions.filter((p) => p.status === 'resolved_loss')
      const closedManual = positions.filter((p) => p.status === 'closed')
      const resolved = wins.length + losses.length + closedManual.length
      stats = {
        openPositions: open.length,
        resolved,
        wins: wins.length,
        totalVolume: positions.reduce((s, p) => s + (p.usdtIn || 0), 0),
        realisedPnl: [...wins, ...losses, ...closedManual].reduce(
          (s, p) => s + (p.pnl || 0),
          0,
        ),
        winRate: resolved > 0 ? wins.length / resolved : null,
      }
    } catch (statsErr: any) {
      console.warn('[API] /public/campaign/brain stats failed:', statsErr?.message)
    }
    const limit = Math.min(parseInt(String(req.query.limit ?? '30')) || 30, 100)
    const beforeStr = req.query.before ? String(req.query.before) : ''
    const beforeDate = beforeStr ? new Date(beforeStr) : undefined
    const before = beforeDate && !isNaN(beforeDate.getTime()) ? beforeDate : undefined

    // Pull AgentLog rows directly — campaign rows include CAMPAIGN_ENTER /
    // CAMPAIGN_HOLD / CAMPAIGN_DOUBLE_DOWN / CAMPAIGN_SPREAD actions plus
    // the per-tick swarm verdicts in `providers`. fetchAgentLogFeed filters
    // on `pair: not null`, which excludes 42.space prediction rows (no
    // pair), so we run a dedicated query here.
    // Two row types share this agentId in AgentLog:
    //   1. Campaign-tick rows  → exchange='42', action='CAMPAIGN_*' (the
    //      ones we actually want to surface — every entry includes the
    //      4-model swarm verdict in `providers`).
    //   2. 42.space scanner rows → exchange='fortytwo', action='HOLD'
    //      (high-volume background noise, ~5/min, would bury the
    //      campaign signal entirely).
    // Filter to (1) so the public page is the campaign brain feed, not
    // a generic agent log. The scanner rows are still readable via the
    // user-scoped feed for logged-in operators.
    const rows = await db.agentLog.findMany({
      where: {
        agentId: agent.id,
        exchange: '42',
        ...(before ? { createdAt: { lt: before } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true, action: true, parsedAction: true, reason: true,
        providers: true, exchange: true, createdAt: true,
        pair: true, price: true,
      },
    } as any)

    const body = {
      agent: {
        id: agent.id,
        name: agent.name,
        ...stats,
      },
      entries: rows.map((r: any) => ({
        id: r.id,
        action: r.action,
        parsedAction: r.parsedAction,
        reason: r.reason,
        providers: r.providers ?? null,
        exchange: r.exchange ?? null,
        pair: r.pair ?? null,
        price: r.price ?? null,
        createdAt: r.createdAt,
      })),
    }
    brainCache.set(cacheKey, { exp: Date.now() + BRAIN_CACHE_TTL_MS, body })
    res.json(body)
  } catch (err: any) {
    console.error('[API] /public/campaign/brain failed:', err?.message)
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
    const beforeStr = req.query.before ? String(req.query.before) : ''
    const beforeDate = beforeStr ? new Date(beforeStr) : undefined
    const before = beforeDate && !isNaN(beforeDate.getTime()) ? beforeDate : undefined
    const nameById = new Map([[agent.id, agent.name]])
    const [logFeed, tradeFeed] = await Promise.all([
      fetchAgentLogFeed({ agentId: agent.id }, limit, nameById, before),
      fetchTradeFeed({ agentId: agent.id }, limit, nameById, before)
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

// GET /api/agents/:id/positions  — open positions attributed to this agent
//
// Joins DB Trade rows (status='open' for this agent) with live Aster
// positions for the user's wallet, so each row carries the same live
// markPrice and unrealized PnL that the Trade page shows. Without this
// endpoint, Agent Studio had no way to surface what each agent is
// currently holding (or how much it is up/down right now), which is
// exactly the data the user needs to trust the agent. We deliberately
// scope to the agent's own DB rows — not just "any live position
// matching this pair/side" — so two agents trading the same pair don't
// each claim the same exposure.
app.get('/api/agents/:id/positions', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    const agent = await db.agent.findFirst({
      where: { id: String(req.params.id), userId: user.id },
      select: { id: true, name: true, exchange: true }
    })
    if (!agent) return res.status(404).json({ error: 'Agent not found' })

    const openTrades = await db.trade.findMany({
      where: { agentId: agent.id, status: 'open' },
      orderBy: { openedAt: 'desc' }
    })

    // Best-effort live overlay from Aster. If the user hasn't onboarded
    // yet, or the Aster call fails, we still return the DB rows — the
    // UI just shows entry/size without a live mark instead of erroring.
    //
    // We also track `liveLookupOk` separately so the reconciler below
    // only acts when we ACTUALLY confirmed the venue state. A transient
    // Aster outage must not silently mark every position closed.
    let livePositions: Array<{ symbol: string; side: string; markPrice: number; unrealizedPnl?: number; size?: number }> = []
    let liveLookupOk = false
    if (user.asterOnboarded) {
      try {
        const wallet = await db.wallet.findFirst({ where: { userId: user.id, isActive: true } })
        if (wallet) {
          const { resolveAgentCreds, getPositions } = await import('./services/aster')
          const creds = await resolveAgentCreds(user, wallet.address)
          if (creds) {
            const raw = await getPositions(creds)
            livePositions = raw.map((p: any) => ({
              symbol: p.symbol,
              side: p.side,
              markPrice: Number(p.markPrice),
              unrealizedPnl: typeof p.unrealizedPnl === 'number' ? p.unrealizedPnl : undefined,
              size: typeof p.size === 'number' ? p.size : undefined,
            }))
            liveLookupOk = true
          }
        }
      } catch (e: any) {
        // Non-fatal — return DB rows without live overlay
        console.warn(`[API] /agents/${agent.id}/positions live overlay failed: ${e?.message ?? e}`)
      }
    }

    // Reconcile DB rows against the live snapshot: any open Aster trade
    // (older than 60s) that doesn't appear in livePositions has been
    // closed on the venue (SL/TP/manual/liq) — flip it to status='closed'
    // so the panel doesn't keep showing ghost rows tagged "not live on
    // venue". After reconciliation, refetch the open trades so the
    // response only reflects what's actually still open.
    let effectiveOpenTrades = openTrades
    try {
      const { reconcileStaleAsterTrades } = await import('./services/asterReconcile')
      const r = await reconcileStaleAsterTrades(user.id, livePositions, liveLookupOk)
      if (r.closed > 0) {
        effectiveOpenTrades = await db.trade.findMany({
          where: { agentId: agent.id, status: 'open' },
          orderBy: { openedAt: 'desc' },
        })
      }
    } catch (e: any) {
      console.warn(`[API] /agents/${agent.id}/positions reconcile failed: ${e?.message ?? e}`)
    }

    // Phase 4 (2026-05-01) — multi-venue overlay. The original endpoint
    // only joined Aster live positions; HL/Polymarket/42 positions were
    // invisible from this panel. Now we also fetch:
    //   • HL positions via getAccountState (perp, has live mark + PnL)
    //   • Polymarket positions from db.polymarketPosition (status open/
    //     placed/matched/filled — entry price only, no live overlay)
    //   • 42.space positions from db.outcomePosition (status='open' —
    //     entry price + sizeUsdt, no live overlay)
    //
    // Live mark/PnL overlay only exists for the perp venues; prediction
    // venues just render the entry price the agent paid. The frontend
    // already gates the Close button to Aster-only via canClose so
    // surfacing extra venues here is purely additive.
    let hlPositions: Array<{ symbol: string; side: 'LONG' | 'SHORT'; szi: number; entryPx: number; markPx: number; unrealizedPnl: number; leverage: number }> = []
    if (user.hyperliquidOnboarded) {
      try {
        const wallet = await db.wallet.findFirst({ where: { userId: user.id, isActive: true } })
        if (wallet) {
          const { getAccountState } = await import('./services/hyperliquid')
          const acct = await getAccountState(wallet.address)
          hlPositions = acct.positions.map((p) => ({
            symbol: p.coin,
            side:   p.szi > 0 ? 'LONG' : 'SHORT',
            szi:    Math.abs(p.szi),
            entryPx: p.entryPx,
            // markPx: derive from positionValue/szi when szi != 0; HL doesn't
            // surface mark directly on positionRisk, but positionValue is
            // signed notional in USDC.
            markPx: p.szi !== 0 ? Math.abs(p.positionValue / p.szi) : 0,
            unrealizedPnl: p.unrealizedPnl,
            leverage: p.leverage ?? 1,
          }))
        }
      } catch (e: any) {
        console.warn(`[API] /agents/${agent.id}/positions HL overlay failed: ${e?.message ?? e}`)
      }
    }

    const polymarketPositions = await db.polymarketPosition.findMany({
      where: {
        agentId: agent.id,
        status: { in: ['placed', 'matched', 'filled'] },
      },
      orderBy: { openedAt: 'desc' },
    }).catch(() => [])

    const fortyTwoPositions = await db.$queryRawUnsafe<Array<{
      id: string; marketTitle: string; outcomeLabel: string; usdtIn: number;
      entryPrice: number; openedAt: Date;
    }>>(
      `SELECT id, "marketTitle", "outcomeLabel", "usdtIn", "entryPrice", "openedAt"
       FROM "OutcomePosition"
       WHERE "agentId"=$1 AND status='open'
       ORDER BY "openedAt" DESC`,
      agent.id,
    ).catch(() => [])

    // Build the unified positions array.
    //
    // Aster rows: existing logic (live overlay from livePositions).
    // HL rows: live overlay from hlPositions.
    // Polymarket / 42 rows: no live overlay (no perp-style mark) — show
    //   entry price as both entry and mark so the UI doesn't render '—',
    //   and PnL is null (would need a market re-read to compute, deferred).
    const asterAndHlRows = effectiveOpenTrades.map((t) => {
      if (t.exchange === 'hyperliquid') {
        const live = hlPositions.find(
          (lp) => lp.symbol.toUpperCase() === t.pair.toUpperCase() && lp.side === t.side,
        )
        const markPrice = live?.markPx ?? null
        const dir = t.side === 'LONG' ? 1 : -1
        const livePnl =
          live?.unrealizedPnl != null
            ? live.unrealizedPnl
            : (markPrice != null ? (markPrice - t.entryPrice) * t.size * dir : null)
        return {
          id: t.id,
          pair: t.pair,
          side: t.side,
          size: t.size,
          leverage: t.leverage,
          entryPrice: t.entryPrice,
          exchange: t.exchange,
          openedAt: t.openedAt,
          markPrice,
          unrealizedPnl: livePnl,
          liveOnVenue: !!live,
        }
      }
      // Aster (default branch — keeps the original behavior intact for
      // legacy rows where exchange is null/'aster').
      const live = livePositions.find(
        (lp) => lp.symbol.toUpperCase() === t.pair.toUpperCase() && lp.side === t.side,
      )
      const markPrice = live?.markPrice ?? null
      // Prefer Aster's authoritative `unrealizedPnl` when present — it
      // already accounts for any funding adjustments / fees Aster has
      // applied. Fall back to the standard `(mark - entry) * size * dir`
      // formula (matches Trade.tsx) so users still see an estimate when
      // the venue field is missing.
      const dir = t.side === 'LONG' ? 1 : -1
      const livePnl =
        live?.unrealizedPnl != null
          ? live.unrealizedPnl
          : (markPrice != null ? (markPrice - t.entryPrice) * t.size * dir : null)
      return {
        id: t.id,
        pair: t.pair,
        side: t.side,
        size: t.size,
        leverage: t.leverage,
        entryPrice: t.entryPrice,
        exchange: t.exchange,
        openedAt: t.openedAt,
        markPrice,
        unrealizedPnl: livePnl,
        liveOnVenue: !!live,
      }
    })

    const polymarketRows = polymarketPositions.map((p) => ({
      id: p.id,
      // pair: short market title so the UI's pair cell is informative.
      pair: (p.marketTitle ?? 'Polymarket').slice(0, 32),
      side: p.outcomeLabel ?? p.side,
      size: p.sizeUsdc,
      leverage: 1,
      entryPrice: p.entryPrice,
      exchange: 'polymarket',
      openedAt: p.openedAt,
      markPrice: null,
      unrealizedPnl: null,
      liveOnVenue: true,
    }))

    const fortyTwoRows = fortyTwoPositions.map((p) => ({
      id: p.id,
      pair: (p.marketTitle ?? '42.space').slice(0, 32),
      side: p.outcomeLabel,
      size: p.usdtIn,
      leverage: 1,
      entryPrice: p.entryPrice,
      exchange: 'fortytwo',
      openedAt: p.openedAt,
      markPrice: null,
      unrealizedPnl: null,
      liveOnVenue: true,
    }))

    const positions = [...asterAndHlRows, ...polymarketRows, ...fortyTwoRows]

    res.json({ positions })
  } catch (err: any) {
    console.error('[API] /agents/:id/positions failed:', err?.message ?? err)
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

    // ─── Per-section timeout helper ──────────────────────────────────────
    // Each venue read goes out to a different external RPC (BSC dataseed,
    // Aster tapi, Hyperliquid api, Polygon RPC, etc). Without a timeout, a
    // single hung endpoint blocks the whole /api/me/wallet response — which
    // is exactly what made the mini-app Wallet tab spin forever in
    // production. The timeout is intentionally short (5s): if a provider
    // can't answer in 5s the user sees a per-card error string rather than
    // a blank loading screen.
    const SECTION_TIMEOUT_MS = 5000
    const withTimeout = async <T>(
      p: Promise<T>,
      label: string,
      overrideMs?: number,
    ): Promise<T> => {
      const ms = overrideMs ?? SECTION_TIMEOUT_MS
      let timer: NodeJS.Timeout | undefined
      try {
        return await Promise.race([
          p,
          new Promise<T>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`${label}_timeout_${ms}ms`)),
              ms,
            )
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955'

    // ─── Per-venue async readers ─────────────────────────────────────────
    // Each reader is self-contained so we can fan them out in parallel
    // via Promise.allSettled below. They each return a fully-shaped object
    // matching the section's response field — never throw. A failed
    // section surfaces as a per-card error string so the UI's existing
    // error-state handling kicks in, instead of dragging the entire
    // endpoint into a 500.

    // Use the robust multi-endpoint BSC provider with staticNetwork +
    // FallbackProvider — a single bare JsonRpcProvider against
    // bsc-dataseed silently returns empty `0x` for balanceOf under
    // load, which ethers v6 then decodes to 0 (BUFFER_OVERRUN path),
    // making the user's REAL deposit show as $0.00. The fallback
    // provider transparently retries against three other public
    // dataseeds, eliminating that whole class of "I funded my wallet
    // but the app says zero" reports.
    // BscScan REST fallback. Used ONLY when the JSON-RPC FallbackProvider
    // path has already failed (every dataseed timed out). BscScan's read
    // API is a different network path (Cloudflare-fronted REST vs raw RPC
    // dataseed), so it survives the exact failure mode where every public
    // dataseed is rate-limiting or hanging from our egress IPs. Anonymous
    // calls work but are throttled to 1 req / 5s — set BSCSCAN_API_KEY in
    // Render env to lift that to 5 req/s (free tier).
    const readBscViaBscScan = async (
      addr: string,
    ): Promise<{ usdt: number; bnb: number } | null> => {
      const key = process.env.BSCSCAN_API_KEY ?? ''
      const keyParam = key ? `&apikey=${encodeURIComponent(key)}` : ''
      const bnbUrl =
        `https://api.bscscan.com/api?module=account&action=balance` +
        `&address=${addr}&tag=latest${keyParam}`
      const usdtUrl =
        `https://api.bscscan.com/api?module=account&action=tokenbalance` +
        `&contractaddress=${USDT_BSC}&address=${addr}&tag=latest${keyParam}`
      try {
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), 6000)
        const [bnbResp, usdtResp] = await Promise.all([
          fetch(bnbUrl, { signal: ctrl.signal }),
          fetch(usdtUrl, { signal: ctrl.signal }),
        ])
        clearTimeout(t)
        if (!bnbResp.ok || !usdtResp.ok) return null
        const bnbJson: any = await bnbResp.json()
        const usdtJson: any = await usdtResp.json()
        // BscScan returns { status:"1", result:"<wei-as-string>" } on success;
        // status:"0" + result:"NOTOK..." on rate-limit / invalid-key.
        if (bnbJson?.status !== '1' || usdtJson?.status !== '1') return null
        const bnb = parseFloat(ethers.formatEther(BigInt(bnbJson.result)))
        const usdt = parseFloat(ethers.formatUnits(BigInt(usdtJson.result), 18))
        return { bnb, usdt }
      } catch {
        return null
      }
    }

    // BSC gets a wider section budget (12s vs the default 5s). The seven-
    // endpoint FallbackProvider needs ~800ms per stalled endpoint to advance,
    // so a 5s ceiling only let it reach ~2 endpoints — that's why users hit
    // "bsc_*_timeout_5000ms" banners even though their deposits were on-chain.
    // 12s is still well under any reasonable HTTP idle, so the wallet card
    // never freezes the response — Promise.allSettled keeps the other cards
    // rendering at their own faster budgets in parallel.
    const BSC_SECTION_TIMEOUT_MS = 12000
    const readBsc = async () => {
      const { buildBscProvider } = await import('./services/bscProvider')
      const provider = buildBscProvider(process.env.BSC_RPC_URL)
      let usdt = 0, bnb = 0, balanceError: string | null = null
      // BNB and USDT calls run in parallel under the section budget so a
      // slow USDT contract call can't take BNB down with it.
      const [bnbRes, usdtRes] = await Promise.allSettled([
        withTimeout(provider.getBalance(wallet.address), 'bsc_bnb', BSC_SECTION_TIMEOUT_MS),
        withTimeout(
          new ethers.Contract(
            USDT_BSC,
            ['function balanceOf(address) view returns (uint256)'],
            provider,
          ).balanceOf(wallet.address) as Promise<bigint>,
          'bsc_usdt',
          BSC_SECTION_TIMEOUT_MS,
        ),
      ])
      if (bnbRes.status === 'fulfilled') {
        bnb = parseFloat(ethers.formatEther(bnbRes.value))
      } else {
        balanceError = `bnb: ${bnbRes.reason?.shortMessage ?? bnbRes.reason?.message ?? 'rpc_failed'}`
      }
      if (usdtRes.status === 'fulfilled') {
        usdt = parseFloat(ethers.formatUnits(usdtRes.value, 18))
      } else {
        const usdtErr = `usdt: ${usdtRes.reason?.shortMessage ?? usdtRes.reason?.message ?? 'rpc_failed'}`
        balanceError = balanceError ? `${balanceError}; ${usdtErr}` : usdtErr
      }
      // Belt-and-suspenders: if EITHER value failed (RPC stall), try the
      // BscScan REST API. We only override values that actually failed —
      // never overwrite a successful RPC read with a (potentially staler)
      // BscScan value. If BscScan also fails we keep the original RPC
      // error string so the UI banner still tells the user what happened.
      const rpcFailed = bnbRes.status !== 'fulfilled' || usdtRes.status !== 'fulfilled'
      if (rpcFailed) {
        const scan = await readBscViaBscScan(wallet.address)
        if (scan) {
          if (bnbRes.status !== 'fulfilled') bnb = scan.bnb
          if (usdtRes.status !== 'fulfilled') usdt = scan.usdt
          // Clear the error banner — we got the numbers. Surface the source
          // so support can tell at a glance that RPC failed but BscScan saved
          // the read.
          balanceError = null
          return { usdt, bnb, error: null as string | null, source: 'bscscan' as const }
        }
      }
      return { usdt, bnb, error: balanceError }
    }

    const readQr = () =>
      QRCode.toDataURL(wallet.address, {
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
    const readAster = async (): Promise<{
      usdt: number; availableMargin: number;
      onboarded: boolean; error: string | null
    }> => {
      const out = { usdt: 0, availableMargin: 0, onboarded: !!user.asterOnboarded, error: null as string | null }
      try {
        // CRITICAL: only make a SIGNED Aster balance call if this user has
        // their OWN per-user agent on file (set during /activate). For brand-
        // new / not-onboarded users, `resolveAgentCreds` would otherwise fall
        // back to the shared platform agent (env ASTER_AGENT_PRIVATE_KEY) and
        // signed `/fapi/v3/balance` can return USDT held by that shared agent
        // — which then surfaced on the home screen as a fictitious balance
        // (e.g. "$9.41 ASTER" + "not activated") for users who had genuinely
        // never deposited. We instead use the address-scoped public RPC,
        // which only reads the user's own on-chain Aster account.
        const asterMod = await import('./services/aster')
        const hasOwnAgent = !!(user as any).asterAgentEncryptedPK
        const isOnboarded = !!user.asterOnboarded

        if (hasOwnAgent && isOnboarded) {
          const creds = await asterMod.resolveAgentCreds(user, wallet.address)
          if (!creds) {
            out.error = 'no_agent_credentials'
          } else {
            const bal = await withTimeout(asterMod.getAccountBalanceStrict(creds), 'aster_signed')
            out.usdt = bal.usdt
            out.availableMargin = bal.availableMargin
          }
        } else {
          // Pre-activation path: address-scoped public RPC only. If the user
          // has never opened an Aster futures account this returns an
          // "account does not exist" error which we translate to
          // not_onboarded so the UI shows the activation flow.
          const bal = await withTimeout(asterMod.getAccountBalance({
            userAddress: wallet.address,
            signerAddress: wallet.address, // unused by RPC path
            signerPrivKey: '0x' + '0'.repeat(64), // unused by RPC path
          } as any), 'aster_rpc')
          out.usdt = bal.usdt
          out.availableMargin = bal.availableMargin
          if (bal.usdt === 0 && bal.availableMargin === 0) {
            out.error = 'not_onboarded'
          }
        }
      } catch (e: any) {
        const msg = String(e?.message ?? 'aster_unavailable').toLowerCase()
        if (msg.includes('account does not exist') || msg.includes('no aster user')) {
          out.error = 'not_onboarded'
        } else {
          console.error('[API] /me/wallet aster failed:', wallet.address, '→', e?.message)
          out.error = String(e?.message ?? 'aster_unavailable')
        }
      }
      return out
    }

    // ── Arbitrum balances (ETH for gas + USDC). Same wallet address as BSC.
    // Surfaced so the user can see funds they parked on Arbitrum (e.g. for
    // bridging to Hyperliquid) without leaving the app.
    const readArbitrum = async (): Promise<{ eth: number; usdc: number; error: string | null }> => {
      try {
        const { getArbitrumBalances } = await import('./services/wallet')
        return await withTimeout(getArbitrumBalances(wallet.address), 'arbitrum')
      } catch (e: any) {
        return { eth: 0, usdc: 0, error: e?.message ?? 'arb_unavailable' }
      }
    }

    // ── Hyperliquid clearinghouse equity ───────────────────────────────────
    // Same wallet address as BSC (HL is EVM, derived from the same secp256k1
    // key). Gives us parity with the Aster card so users see HL equity at
    // a glance without leaving the Wallet tab.
    const readHyperliquid = async (): Promise<{
      usdc: number; accountValue: number;
      onboarded: boolean; error: string | null
    }> => {
      const out = { usdc: 0, accountValue: 0, onboarded: !!user.hyperliquidOnboarded, error: null as string | null }
      try {
        const hlMod = await import('./services/hyperliquid')
        const acc = await withTimeout(hlMod.getAccountState(wallet.address), 'hyperliquid')
        out.usdc = acc.withdrawableUsdc
        out.accountValue = acc.accountValue
        out.onboarded = acc.onboarded
      } catch (e: any) {
        const msg = String(e?.message ?? 'hl_unavailable').toLowerCase()
        if (msg.includes('does not exist') || msg.includes('no user')) {
          out.error = 'not_onboarded'
        } else {
          console.error('[API] /me/wallet hyperliquid failed:', wallet.address, '→', e?.message)
          out.error = String(e?.message ?? 'hl_unavailable')
        }
      }
      return out
    }

    // ── XLayer (chain id 196) — native OKB balance ────────────────────────
    // Same EVM address; surfaced so users can see whether they've topped up
    // OKB for XLayer registry txs / future XLayer trading.
    const readXLayer = async (): Promise<{ okb: number; error: string | null }> => {
      try {
        const { buildXLayerProvider } = await import('./services/xlayerProvider')
        const xp = buildXLayerProvider()
        const wei = await withTimeout(xp.getBalance(wallet.address), 'xlayer')
        return { okb: parseFloat(ethers.formatEther(wei)), error: null }
      } catch (e: any) {
        return { okb: 0, error: e?.shortMessage ?? e?.message ?? 'xlayer_rpc_failed' }
      }
    }

    // ── Polygon (chain id 137) — USDC.e + MATIC at custodial EOA + Safe ─
    // Surfaced so users see Polymarket-relevant balances (USDC.e is the
    // collateral Polymarket's CTF Exchange uses, MATIC is the gas needed
    // for the one-tap fund tx that moves USDC.e from the EOA into their
    // gasless Safe). `safe.usdc` is what's actually tradable on Polymarket.
    const readPolygon = async (): Promise<{
      eoa: { address: string; usdcE: number; matic: number; error: string | null }
      safe: { address: string | null; usdcE: number; deployed: boolean; ready: boolean; error: string | null }
      hasCreds: boolean
    }> => {
      const out = {
        eoa:  { address: wallet.address, usdcE: 0, matic: 0, error: null as string | null },
        safe: { address: null as string | null, usdcE: 0, deployed: false, ready: false, error: null as string | null },
        hasCreds: false,
      }
      try {
        const { getPolygonBalances, getFunderAddress } = await import('./services/polymarketTrading')
        const [safeAddr, creds] = await Promise.all([
          withTimeout(getFunderAddress(user.id), 'polygon_funder'),
          db.polymarketCreds.findUnique({ where: { userId: user.id } }),
        ])
        out.hasCreds      = Boolean(creds)
        out.safe.address  = safeAddr
        out.safe.deployed = Boolean(creds?.safeDeployedAt)

        const [eoaBal, safeBal] = await Promise.all([
          withTimeout(getPolygonBalances(wallet.address), 'polygon_eoa').catch((e: any) => {
            out.eoa.error = e?.shortMessage ?? e?.message ?? 'polygon_rpc_failed'
            return null
          }),
          safeAddr
            ? withTimeout(getPolygonBalances(safeAddr), 'polygon_safe').catch((e: any) => {
                out.safe.error = e?.shortMessage ?? e?.message ?? 'polygon_rpc_failed'
                return null
              })
            : Promise.resolve(null),
        ])
        if (eoaBal) {
          out.eoa.usdcE = eoaBal.usdc
          out.eoa.matic = eoaBal.matic
        }
        if (safeBal) {
          out.safe.usdcE = safeBal.usdc
          out.safe.ready = Boolean(
            creds?.allowanceVerifiedAt ||
            (safeBal.allowanceCtf        >= 1_000_000 &&
             safeBal.allowanceNeg        >= 1_000_000 &&
             safeBal.allowanceNegAdapter >= 1_000_000 &&
             safeBal.ctfApprovedCtfExchange &&
             safeBal.ctfApprovedNegExchange &&
             safeBal.ctfApprovedNegAdapter)
          )
        }
      } catch (e: any) {
        out.eoa.error = out.eoa.error ?? (e?.message ?? 'polygon_unavailable')
      }
      return out
    }

    // ─── Fan out all venue reads in parallel ─────────────────────────────
    // allSettled so a thrown reader (shouldn't happen — they all swallow
    // their own errors — but defensive) can never take the response down.
    // Each settled value is the fully-shaped section object the response
    // expects. QR generation runs in the same gather since it's independent
    // and ~50ms, so latency is dominated by the slowest section, not summed.
    const [
      bscRes, qrRes, asterRes, arbitrumRes, hyperliquidRes, xlayerRes, polygonRes,
    ] = await Promise.allSettled([
      readBsc(), readQr(), readAster(), readArbitrum(), readHyperliquid(), readXLayer(), readPolygon(),
    ])

    const balances = bscRes.status === 'fulfilled'
      ? bscRes.value
      : { usdt: 0, bnb: 0, error: bscRes.reason?.message ?? 'bsc_unavailable' }
    const qrDataUrl = qrRes.status === 'fulfilled' ? qrRes.value : ''
    const aster = asterRes.status === 'fulfilled'
      ? asterRes.value
      : { usdt: 0, availableMargin: 0, onboarded: !!user.asterOnboarded, error: 'aster_unavailable' }
    const arbitrum = arbitrumRes.status === 'fulfilled'
      ? arbitrumRes.value
      : { eth: 0, usdc: 0, error: 'arb_unavailable' }
    const hyperliquid = hyperliquidRes.status === 'fulfilled'
      ? hyperliquidRes.value
      : { usdc: 0, accountValue: 0, onboarded: !!user.hyperliquidOnboarded, error: 'hl_unavailable' }
    const xlayer = xlayerRes.status === 'fulfilled'
      ? xlayerRes.value
      : { okb: 0, error: 'xlayer_unavailable' }
    const polygon = polygonRes.status === 'fulfilled'
      ? polygonRes.value
      : {
          eoa:  { address: wallet.address, usdcE: 0, matic: 0, error: 'polygon_unavailable' },
          safe: { address: null, usdcE: 0, deployed: false, ready: false, error: null },
          hasCreds: false,
        }

    res.json({
      address: wallet.address,
      chain: wallet.chain,
      label: wallet.label,
      pinProtected: !!user.pinHash,
      balances,
      arbitrum,
      aster,
      hyperliquid,
      xlayer,
      polygon,
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
    //
    // Retry up to 3 times with linear backoff (1s, 3s) before giving up.
    // Production observation: a single transient Aster API blip during
    // activation used to leave users in a state where every subsequent
    // order failed with "Cannot found builder config" — because the order
    // path attributes to the builder unconditionally, but Aster has no
    // record of this user authorizing it. Retrying inline fixes that root
    // cause for the common transient case. The DB flag below records the
    // outcome so the order path can skip builder attribution for the rare
    // user where every retry fails.
    let builderEnrolled = false
    let lastBuilderErr: string | null = null
    const userPkForBuilder = userPk || decryptPrivateKey(wallet.encryptedPK, user.id)
    for (let attempt = 1; attempt <= 3 && !builderEnrolled; attempt++) {
      try {
        const br = await approveBuilder({
          userAddress:    wallet.address,
          userPrivateKey: userPkForBuilder,
          builderAddress,
          maxFeeRate:     feeRate,
          builderName:    'BUILD4'
        })
        if (br.success) {
          builderEnrolled = true
          break
        }
        lastBuilderErr = br.error ?? 'unknown'
        console.warn(`[/aster/approve] approveBuilder attempt ${attempt}/3 failed:`, br.error)
      } catch (e: any) {
        lastBuilderErr = e?.message ?? 'threw'
        console.warn(`[/aster/approve] approveBuilder attempt ${attempt}/3 threw:`, e?.message)
      }
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, attempt * 1000))
      }
    }
    // Persist the outcome so /api/aster/order can decide whether to attach
    // builder+feeRate. Idempotent column (see ensureTables.ts). We update
    // even on failure (DEFAULT false already covers it, but explicit beats
    // implicit when an activation retry transitions true→false).
    try {
      await db.user.update({
        where: { id: user.id },
        data:  { asterBuilderEnrolled: builderEnrolled } as any,
      })
    } catch (e: any) {
      console.warn('[/aster/approve] failed to persist asterBuilderEnrolled:', e?.message)
    }

    userPk = ''

    await db.user.update({
      where: { id: user.id },
      data:  { asterOnboarded: true }
    })

    // Symmetric backfill of `enabledVenues` for any pre-existing agents.
    // Mirrors the HL-approve backfill: a user who created an agent before
    // ever approving Aster (vanishingly rare today, but possible if HL
    // approval lands first) would otherwise have an Aster-silent agent.
    try {
      const userAgents = await db.agent.findMany({
        where:  { userId: user.id },
        select: { id: true, enabledVenues: true, exchange: true },
      })
      for (const a of userAgents) {
        const cur = Array.isArray((a as any).enabledVenues) && (a as any).enabledVenues.length > 0
          ? (a as any).enabledVenues as string[]
          : (a.exchange ? [a.exchange] : [])
        if (cur.includes('aster')) continue
        const next = Array.from(new Set([...cur, 'aster']))
        await db.agent.update({ where: { id: a.id }, data: { enabledVenues: next } })
      }
    } catch (e: any) {
      console.warn(`[/aster/approve] enabledVenues backfill failed user=${user.id}:`, e?.message ?? e)
    }

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
    const { friendlyAsterError } = await import('./services/aster')
    const msg = friendlyAsterError(err)
    console.error('[API] /aster/positions failed:', msg, '(raw:', err?.message, 'status:', err?.response?.status, ')')
    res.status(502).json({ error: msg })
  }
})

// GET /api/aster/trades
// Query: ?symbol=SOLUSDT (optional) &limit=20 (optional, max 100)
// Returns the user's most recent Aster fills with commission, so users can
// audit fees end-to-end (notional, executed price, commission paid). This is
// the source of truth for builder-fee verification — Aster's `commission`
// field on each fill reflects the broker fee actually charged.
app.get('/api/aster/trades', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    if (!user.asterOnboarded) {
      return res.status(400).json({ error: 'Activate trading account first', needsApprove: true })
    }
    const wallet = await db.wallet.findFirst({ where: { userId: user.id, isActive: true } })
    if (!wallet) return res.status(404).json({ error: 'No active wallet' })

    const aster = await import('./services/aster')
    const creds = await aster.resolveAgentCreds(user, wallet.address)
    if (!creds) return res.status(400).json({ error: 'No agent credentials — re-activate Aster' })

    const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : undefined
    const limit  = Math.max(1, Math.min(100, parseInt(String(req.query.limit ?? '20'), 10) || 20))
    const trades = await aster.getUserTrades(creds, { symbol, limit })
    res.json({ trades })
  } catch (err: any) {
    const msg = (await import('./services/aster')).friendlyAsterError(err)
    console.error('[API] /aster/trades failed:', msg, '(raw:', err?.message, 'status:', err?.response?.status, ')')
    res.status(502).json({ error: msg })
  }
})

// GET /api/aster/orders
// Query: ?symbol=BTCUSDT (optional)
// Returns the user's resting (NEW / PARTIALLY_FILLED) orders. A LIMIT placed
// away from market sits here until matched — it is *not* a position yet, and
// it has no fills yet, so the only way for the UI to show it is this route.
// Errors propagate so the panel can render "Could not load open orders"
// distinctly from "no working orders" (same pattern as HL fills).
app.get('/api/aster/orders', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    if (!user.asterOnboarded) {
      return res.status(400).json({ error: 'Activate trading account first', needsApprove: true })
    }
    const wallet = await db.wallet.findFirst({ where: { userId: user.id, isActive: true } })
    if (!wallet) return res.status(404).json({ error: 'No active wallet' })

    const aster = await import('./services/aster')
    const creds = await aster.resolveAgentCreds(user, wallet.address)
    if (!creds) return res.status(400).json({ error: 'No agent credentials — re-activate Aster' })

    const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : undefined
    const orders = await aster.getOpenOrders(creds, symbol)
    res.json({ orders })
  } catch (err: any) {
    const msg = (await import('./services/aster')).friendlyAsterError(err)
    console.error('[API] /aster/orders failed:', msg, '(raw:', err?.message, 'status:', err?.response?.status, ')')
    res.status(502).json({ error: msg })
  }
})

// POST /api/aster/orders/cancel
// Body: { symbol: 'BTCUSDT', orderId: 12345 }
// Cancels a single resting order. The underlying service swallows errors
// (logs to console) for backwards compat with bracket-cancel callers, so
// we re-fetch open orders after to confirm the cancel actually took. If
// the order is still there we surface a distinct error to the UI.
app.post('/api/aster/orders/cancel', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    if (!user.asterOnboarded) {
      return res.status(400).json({ error: 'Activate trading account first', needsApprove: true })
    }
    const wallet = await db.wallet.findFirst({ where: { userId: user.id, isActive: true } })
    if (!wallet) return res.status(404).json({ error: 'No active wallet' })

    const { symbol, orderId } = (req.body ?? {}) as { symbol?: string; orderId?: number | string }
    if (!symbol || typeof symbol !== 'string') {
      return res.status(400).json({ error: 'symbol required' })
    }
    const oid = Number(orderId)
    if (!Number.isFinite(oid) || oid <= 0) {
      return res.status(400).json({ error: 'orderId required' })
    }

    const aster = await import('./services/aster')
    const creds = await aster.resolveAgentCreds(user, wallet.address)
    if (!creds) return res.status(400).json({ error: 'No agent credentials — re-activate Aster' })

    await aster.cancelOrder(symbol, oid, creds)
    // Confirm the cancel landed — Aster's API replies with the canceled
    // order on success but the service helper currently swallows the
    // payload, so we re-fetch and assert the orderId is gone.
    const remaining = await aster.getOpenOrders(creds, symbol)
    const stillThere = remaining.some(o => Number(o.orderId) === oid)
    if (stillThere) {
      return res.status(502).json({ error: 'Aster did not cancel the order — please try again.' })
    }
    res.json({ success: true, orderId: oid })
  } catch (err: any) {
    const msg = (await import('./services/aster')).friendlyAsterError(err)
    console.error('[API] /aster/orders/cancel failed:', msg, '(raw:', err?.message, 'status:', err?.response?.status, ')')
    res.status(502).json({ error: msg })
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

    const { pair, side, type, notionalUsdt, leverage, limitPrice, stopLoss } = req.body ?? {}
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
    let qtyStr = filters
      ? aster.roundDownToStep(rawQty, filters.stepSize, filters.quantityPrecision)
      : rawQty.toFixed(6)
    let qty = parseFloat(qtyStr)
    // ── If rounding DOWN strips notional below Aster's min (typical when the
    //    user types a $ amount that sits right at the $5 minimum and stepSize
    //    eats the fraction — e.g. $5 SOL at $170 → 0.0294 SOL → rounds to
    //    0.025 → effective notional $4.31), bump UP by one step. The
    //    downstream margin pre-check at /api/aster/order:2123 will still
    //    catch the case where the bumped qty exceeds the user's wallet, so
    //    no risk of silent overspend.
    if (filters && filters.stepSize > 0 && filters.minNotional > 0
        && qty * refPrice < filters.minNotional && qty * refPrice > 0) {
      const bumpedQty = qty + filters.stepSize
      const bumpedStr = aster.roundDownToStep(bumpedQty, filters.stepSize, filters.quantityPrecision)
      const bumped = parseFloat(bumpedStr)
      if (bumped * refPrice >= filters.minNotional) {
        qtyStr = bumpedStr
        qty    = bumped
      }
    }
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
      // Bump-up above already failed (must have been clipped by budget), so
      // suggest a clean USDT amount the user can re-enter. Add 10% headroom
      // over the minimum so step-rounding doesn't bite them a second time.
      const suggestUsdt = Math.ceil(filters.minNotional * 1.1)
      return res.status(400).json({
        error:
          `Order too small for ${sym} — Aster needs ≥ $${filters.minNotional} USDT notional, ` +
          `your $${notional} rounds down to $${(qty * refPrice).toFixed(2)} after step size. ` +
          `Try $${suggestUsdt} instead.`,
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

    // Only attribute to the builder if THIS user has actually signed
    // approveBuilder. Without their signed authorization on file, Aster
    // rejects the order with "Cannot found builder config" — which is
    // exactly the production bug this column was added to fix. When the
    // user isn't enrolled we route through the plain `placeOrder` path
    // (no builder/feeRate), the trade succeeds without us collecting the
    // kickback. A background reapprove path will retry enrollment.
    const builderActive = Boolean(builderAddress) && Boolean((user as any).asterBuilderEnrolled)

    let result
    if (builderActive && type === 'MARKET') {
      // Builder route only supports the params we wire; LIMIT routes still go
      // through the standard endpoint so timeInForce is honored.
      if (lev > 1) await aster.setLeverage(sym, lev, creds)
      result = await aster.placeOrderWithBuilderCode({
        symbol: sym, side: buySell, type: 'MARKET', quantity: qty,
        builderAddress: builderAddress!, feeRate, creds
      })
    } else {
      result = await aster.placeOrder({
        symbol: sym, side: buySell, type, quantity: qty,
        price: type === 'LIMIT' ? limitRounded : undefined,
        leverage: lev, creds
      })
    }

    // Optional stop-loss attached to the user's manual entry. Best-effort:
    // if the SL leg fails (bad price, wrong side of mark, etc.) we still
    // return success on the entry — the entry is what the user committed
    // capital to. The error is logged so operators can spot recurring
    // failures, and the user gets a non-fatal note in the response.
    let slStatus: 'placed' | 'skipped' | 'failed' = 'skipped'
    let slError: string | undefined
    const slPx = Number(stopLoss)
    if (Number.isFinite(slPx) && slPx > 0) {
      // Sanity: SL must be on the right side of the mark for the position
      // direction. Otherwise it would trigger immediately and close at a
      // loss the user didn't expect.
      const wrongSide =
        (side === 'LONG'  && slPx >= refPrice) ||
        (side === 'SHORT' && slPx <= refPrice)
      if (wrongSide) {
        slStatus = 'failed'
        slError =
          side === 'LONG'
            ? `Stop loss must be below the entry price ($${refPrice.toFixed(2)}).`
            : `Stop loss must be above the entry price ($${refPrice.toFixed(2)}).`
      } else {
        try {
          await aster.placeBracketOrders({
            symbol:         sym,
            side,
            stopLoss:       slPx,
            quantity:       qty,
            creds,
            // Even though closePosition='true' fills are flat-the-book,
            // route through the builder so BUILD4 earns the broker
            // kickback on the SL fill the same way we do on the entry.
            // Gated on `builderActive` (env set AND user enrolled) — see
            // the entry-leg comment above for why.
            ...(builderActive ? { builderAddress: builderAddress!, feeRate } : {}),
          })
          slStatus = 'placed'
        } catch (slErr: any) {
          slStatus = 'failed'
          // Run the raw thrown error through the same sanitizer the main
          // route uses — never let an axios message, exchange code, or
          // chain string surface to the user. Log the raw cause for the
          // operator side, return only the friendly message to the user.
          slError  = aster.friendlyAsterError(slErr)
          console.warn(
            '[API] /aster/order SL leg failed (raw):',
            slErr?.response?.data ?? slErr?.message,
          )
        }
      }
    }

    res.json({
      success: true,
      order: result,
      qty,
      refPrice,
      notionalUsdt: notional,
      leverage: lev,
      stopLoss: { status: slStatus, price: slPx > 0 ? slPx : undefined, error: slError },
    })
  } catch (err: any) {
    const msg = (await import('./services/aster')).friendlyAsterError(err)
    console.error('[API] /aster/order failed:', msg, '(raw:', err?.message, 'status:', err?.response?.status, ')')
    res.status(502).json({ error: msg })
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
    const msg = (await import('./services/aster')).friendlyAsterError(err)
    console.error('[API] /aster/close failed:', msg, '(raw:', err?.message, 'status:', err?.response?.status, ')')
    res.status(502).json({ error: msg })
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

// GET /api/aster/candles?symbol=BTCUSDT&interval=15m&limit=200
//
// Public Aster perp candles in lightweight-charts format.
// No auth — purely market data, identical to what /fapi/v1/klines returns
// but transposed into row-shape ({time, open, high, low, close, volume})
// so the frontend chart can `setData(rows)` without re-shaping.
//
// We expose this so the mini-app's chart shows the EXACT same candles the
// user is trading against on Aster, instead of reading Binance via
// TradingView (which can drift on illiquid pairs and confuses users when
// mark price disagrees with the visible chart).
app.get('/api/aster/candles', async (req, res) => {
  try {
    const symbol   = String(req.query.symbol ?? 'BTCUSDT')
    const interval = String(req.query.interval ?? '15m')
    const limit    = Math.max(1, Math.min(500, parseInt(String(req.query.limit ?? '200'), 10) || 200))
    const { getKlines } = await import('./services/aster')
    const k = await getKlines(symbol, interval, limit)
    const rows = k.timestamps.map((t, i) => ({
      time:   Math.floor(t / 1000),
      open:   k.open[i],
      high:   k.high[i],
      low:    k.low[i],
      close:  k.close[i],
      volume: k.volume[i],
    }))
    res.set('Cache-Control', 'public, max-age=2')
    res.json(rows)
  } catch (err: any) {
    console.error('[API] /aster/candles failed:', err?.message)
    res.status(502).json({ error: 'Could not load chart data — please try again.' })
  }
})

// GET /api/hl/candles?coin=BTC&interval=15m&limit=200
//
// Public Hyperliquid perp candles in lightweight-charts format. Coin is the
// bare symbol (e.g. "BTC", "ETH", "HYPE") — accepts BTCUSDT shapes too and
// strips the suffix server-side so the frontend can hand the same identifier
// it uses everywhere else.
app.get('/api/hl/candles', async (req, res) => {
  try {
    const coin     = String(req.query.coin ?? 'BTC')
    const interval = String(req.query.interval ?? '15m')
    const limit    = Math.max(1, Math.min(500, parseInt(String(req.query.limit ?? '200'), 10) || 200))
    const { getCandles } = await import('./services/hyperliquid')
    const rows = await getCandles(coin, interval, limit)
    res.set('Cache-Control', 'public, max-age=2')
    res.json(rows)
  } catch (err: any) {
    console.error('[API] /hl/candles failed:', err?.message)
    res.status(502).json({ error: 'Could not load chart data — please try again.' })
  }
})

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
    const { approveAgent, approveBuilderFee, getAccountState, getSpotUsdcBalance, waitForHlDeposit } =
      await import('./services/hyperliquid')
    const { getArbitrumBalances, bridgeArbitrumUsdcToHyperliquid } =
      await import('./services/wallet')

    // Fetch perps state + spot USDC + persisted unified flag in parallel.
    // For unified-account users HL treats spot USDC as collateral for perps,
    // so the master account is "funded enough for approveAgent" if EITHER
    // the perps clearinghouse has equity OR spot has USDC. Without this
    // gate the auto-bridge path triggers and demands $5 on Arbitrum from a
    // user who already has $100+ usable on HL — exactly the contradiction
    // shown in the mini-app ("$105 already usable" vs "needs $5 on Arb").
    const [accountBefore, spotUsdcBefore] = await Promise.all([
      getAccountState(wallet.address),
      getSpotUsdcBalance(wallet.address),
    ])
    const isUnified =
      accountBefore.abstraction === 'unifiedAccount' ||
      Boolean((user as any).hyperliquidUnified)
    const fundedForApprove =
      accountBefore.accountValue >= 1 || (isUnified && spotUsdcBefore >= 1)
    if (!fundedForApprove) {
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

    // Backfill `enabledVenues` on every existing agent owned by this user
    // so they start scanning Hyperliquid on the next runner tick. Without
    // this, an agent created before HL approval (e.g. via the new Onboard
    // page, which only runs Aster approve) stays HL-silent forever — the
    // user has to dig into Agent Studio and flip a per-agent chip to "fix"
    // something they never noticed was broken. We only ADD 'hyperliquid'
    // to whatever the agent already had so we never override a user who
    // intentionally pruned a venue via the chip toggles.
    try {
      const userAgents = await db.agent.findMany({
        where:  { userId: user.id },
        select: { id: true, enabledVenues: true, exchange: true },
      })
      for (const a of userAgents) {
        const cur = Array.isArray((a as any).enabledVenues) && (a as any).enabledVenues.length > 0
          ? (a as any).enabledVenues as string[]
          : (a.exchange ? [a.exchange] : [])
        if (cur.includes('hyperliquid')) continue
        const next = Array.from(new Set([...cur, 'hyperliquid']))
        await db.agent.update({ where: { id: a.id }, data: { enabledVenues: next } })
      }
      if (userAgents.length > 0) {
        console.log(`[/hyperliquid/approve] backfilled enabledVenues+=hyperliquid on ${userAgents.length} agent(s) for user=${user.id}`)
      }
    } catch (e: any) {
      // Non-fatal: the user can still flip per-agent chips manually if the
      // bulk backfill races a concurrent edit. We only log so production
      // ops can spot if the backfill ever wedges.
      console.warn(`[/hyperliquid/approve] enabledVenues backfill failed user=${user.id}:`, e?.message ?? e)
    }

    // ── 5) Auto move-to-perps. Most users land here with USDC sitting in
    //    HL spot (because that's where bridge deposits + L1 deposits go),
    //    but the agent trades perps and approveAgent doesn't move funds.
    //    Without this sweep the user gets approved but their first trade
    //    fails with "insufficient margin" and they have to discover the
    //    Move-to-Perps button on their own — friction point #4. We sweep
    //    everything except a $0.10 dust floor so HL doesn't reject zero
    //    transfers, and swallow the failure so a transient HL error here
    //    can't fail the activate flow itself.
    let movedToPerps = 0
    try {
      const { transferSpotPerp } = await import('./services/hyperliquid')
      const spotNow = await getSpotUsdcBalance(wallet.address)
      const sweep = Math.floor((spotNow - 0.10) * 100) / 100
      if (sweep >= 1) {
        const move = await transferSpotPerp(userPk, sweep, true)
        if (move.success) {
          movedToPerps = sweep
          console.log(`[/hyperliquid/approve] auto-move-to-perps user=${user.id} swept $${sweep}`)
        } else {
          console.warn(`[/hyperliquid/approve] auto-move-to-perps failed (non-fatal) user=${user.id}: ${move.error}`)
        }
      }
    } catch (e: any) {
      console.warn(`[/hyperliquid/approve] auto-move-to-perps threw (non-fatal) user=${user.id}: ${e?.message ?? e}`)
    }

    console.log(`[/hyperliquid/approve] user=${user.id} tg=${user.telegramId} agent=${agentAddress} OK`)
    return res.json({ success: true, agentAddress, movedToPerps })
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

    const { coin, side, type = 'MARKET', notionalUsdc, limitPx, leverage, stopLoss } = req.body ?? {}
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
            // ── BUILDER UNREGISTERED via approve path (operator-side issue)
            //    "Builder has insufficient balance to be approved" comes back
            //    on the APPROVE call, not the ORDER call. We deliberately do
            //    NOT fall back to a no-builder order here. Reasoning below.
            //    `result` keeps the original order error so the final
            //    response handler surfaces a clean "service unavailable"
            //    message and the operator gets a loud log line to act on.
            const approveErr = (br.error ?? '').toLowerCase()
            const isBuilderUnregistered = /builder/.test(approveErr)
              && /insufficient balance|not registered|not a (registered )?builder/.test(approveErr)
            if (isBuilderUnregistered) {
              console.error(
                `[/hyperliquid/order] BUILDER UNREGISTERED via approve path user=${user.id} ` +
                `approveErr="${br.error}" — failing the order. ACTION: top up USDC on the builder wallet on HL.`,
              )
            }
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

    // ── INTENTIONAL: NO no-builder fallback on /order
    //
    // Earlier revisions of this handler had a "last-resort" fallback that
    // retried the order with `noBuilder: true` whenever HL rejected because
    // OUR builder address wasn't registered/funded on HL. That fallback is
    // DELIBERATELY REMOVED. Reasoning:
    //
    //   1. Silent success on the no-builder path means we lose the 0.1%
    //      kickback on every affected fill while the operator has no signal
    //      to fix the underlying problem. The order succeeds, the user is
    //      happy, nobody reports anything, weeks of revenue evaporate.
    //
    //   2. Failing loudly on builder issues forces the user to surface the
    //      problem (via support / Telegram), which alerts the operator
    //      immediately. Recovery is cheap (top up the builder wallet on HL,
    //      or rotate HYPERLIQUID_BUILDER_ADDRESS) — typically <5 min.
    //
    //   3. Builder revenue is a load-bearing part of the venue's economics.
    //      Treating it as optional with a quiet fallback signals to the team
    //      that it's "nice to have" — which it isn't.
    //
    // If you ever consider re-adding a no-builder fallback here: don't.
    // Add an admin-only flag instead so operators can flip it deliberately
    // during a known incident, with a logged audit trail.

    if (!result.success) {
      // BUILDER UNREGISTERED — operator-side problem (builder wallet not
      // funded/registered on HL). The user's approval is irrelevant here, so
      // showing them an "approve" button would just loop them. Surface a
      // clean, non-jargon "service unavailable" message instead.
      const isUnregistered = /insufficient balance|not registered|not a (registered )?builder/i
        .test(result.error ?? '')
      if (isUnregistered) {
        console.error(
          `[/hyperliquid/order] BUILDER UNREGISTERED — operator must top up the builder wallet on HL ` +
          `(user=${user.id} err=${result.error})`,
        )
        return res.status(503).json({
          success: false,
          error:
            'Trading is temporarily unavailable on Hyperliquid. Please try again in a few minutes. ' +
            "If this continues, please contact support and we'll take a look.",
          code: 'service_unavailable',
        })
      }
      // Builder approval missing for THIS user — surface the flag so the
      // reactive "Approve builder fee & retry" button shows in the UI.
      const stillBuilder = /(builder|must approve)/i.test(result.error ?? '')
      return res.status(400).json({
        ...result,
        ...(stillBuilder ? { needsBuilderApproval: true } : {}),
      })
    }
    // Optional stop-loss attached to the user's manual entry. Best-effort:
    // if the SL leg fails we still return success on the entry — the
    // entry is what the user committed capital to. We log the SL failure
    // and surface it as a non-fatal note in the response so the UI can
    // tell the user "filled, but stop loss didn't land — try again".
    let slStatus: 'placed' | 'skipped' | 'failed' = 'skipped'
    let slError: string | undefined
    const slPx = Number(stopLoss)
    if (Number.isFinite(slPx) && slPx > 0) {
      // Sanity: SL must be on the right side of the mark for the position
      // direction (LONG → SL below mark, SHORT → SL above). HL would
      // accept the order and fire it instantly, closing for an unexpected
      // loss; reject locally with a clear message instead.
      const wrongSide =
        (side === 'LONG'  && slPx >= markPrice) ||
        (side === 'SHORT' && slPx <= markPrice)
      if (wrongSide) {
        slStatus = 'failed'
        slError =
          side === 'LONG'
            ? `Stop loss must be below the entry price ($${markPrice.toFixed(2)}).`
            : `Stop loss must be above the entry price ($${markPrice.toFixed(2)}).`
      } else {
        // Map any raw HL/SDK error string to a clean, actionable user
        // message. Never surface raw exchange/chain text — the operator
        // sees the raw form in logs, the user sees only the friendly form.
        const friendlyHlSlError = (raw: string | undefined): string => {
          const s = (raw ?? '').toLowerCase()
          if (!s) return 'Stop loss could not be placed — please try again or add it manually.'
          if (/(builder|must approve)/.test(s)) {
            return 'Stop loss could not be placed right now. Please tap "Approve builder fee" and try again.'
          }
          if (/(insufficient.*balance|not registered|not a (registered )?builder)/.test(s)) {
            return 'Stop loss is temporarily unavailable on this venue. Please try again in a few minutes.'
          }
          if (/(price|tick|decimals|invalid)/.test(s)) {
            return 'That stop-loss price isn\'t valid for this market — try a level a few cents away from the current price.'
          }
          if (/(min(imum)? size|size.*small|rounds to 0|sz)/.test(s)) {
            return 'Stop loss size is too small for this market — increase your position size and try again.'
          }
          if (/(429|too many requests)/.test(s)) {
            return 'The exchange is rate-limiting us right now — please retry the stop loss in a few seconds.'
          }
          if (/(timeout|timed out|econn|enotfound|network)/.test(s)) {
            return 'Could not reach the exchange to place the stop loss — please retry.'
          }
          return 'Stop loss could not be placed — please try again or add it manually.'
        }
        try {
          const { placeStopLoss } = await import('./services/hyperliquid')
          const slRes = await placeStopLoss(creds, {
            coin:      sym,
            side,
            sz,
            triggerPx: slPx,
          })
          if (slRes.success) {
            slStatus = 'placed'
          } else {
            slStatus = 'failed'
            slError  = friendlyHlSlError(slRes.error)
            console.warn(
              `[/hyperliquid/order] SL leg failed user=${user.id} raw="${slRes.error}"`,
            )
          }
        } catch (slErr: any) {
          slStatus = 'failed'
          slError  = friendlyHlSlError(slErr?.message)
          console.warn('[/hyperliquid/order] SL leg threw (raw):', slErr?.message)
        }
      }
    }

    return res.json({
      ...result,
      coin:     sym,
      side,
      type,
      sz,
      markPrice,
      notionalUsdc: notional,
      stopLoss: { status: slStatus, price: slPx > 0 ? slPx : undefined, error: slError },
    })
  } catch (err: any) {
    console.error('[API] /hyperliquid/order failed:', err?.message ?? err)
    res.status(500).json({ success: false, error: err?.message ?? 'Internal error' })
  }
})

// POST /api/hyperliquid/close
//
// Flatten the user's open perp position for `coin` with a single
// reduce-only IoC market order. We:
//   1. Pull live perp state to get the actual `szi` (signed base-coin
//      size) of the position. This is the only source of truth — using a
//      cached/stale UI value risks under- or over-closing.
//   2. Submit a MARKET order in the OPPOSITE direction with `r:true`
//      (reduceOnly), so HL guarantees the order can only shrink the
//      position and never accidentally flip it to the opposite side if
//      sizing is slightly off.
//   3. On ANY builder-related reject, immediately retry with noBuilder.
//      This is INTENTIONALLY more aggressive than /order's multi-stage
//      ladder (which auto-approves + backs off + only falls back on
//      unregistered) — for an EXIT, the priority is the user gets out;
//      losing the 0.1% builder kickback on a single close fill is
//      trivially acceptable compared to wedging a user inside a position
//      they're actively trying to flatten. See L1864+ for the regex and
//      the detailed asymmetry-vs-/order rationale.
//
// Body: { coin: string }
app.post('/api/hyperliquid/close', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    if (!user.hyperliquidOnboarded) {
      return res.status(400).json({
        success: false,
        error: 'Activate Hyperliquid trading first',
        needsApprove: true,
      })
    }

    const { coin } = req.body ?? {}
    if (typeof coin !== 'string' || !coin) {
      return res.status(400).json({ success: false, error: 'coin required' })
    }

    const wallet = await db.wallet.findFirst({ where: { userId: user.id, isActive: true } })
    if (!wallet) return res.status(404).json({ success: false, error: 'No active wallet' })

    const { resolveAgentCreds, getAccountState, placeOrder } = await import('./services/hyperliquid')
    const creds = await resolveAgentCreds(user, wallet.address)
    if (!creds) {
      return res.status(400).json({
        success: false,
        error: 'Agent credentials missing — re-activate Hyperliquid',
        needsApprove: true,
      })
    }

    const sym = coin.toUpperCase().replace(/USDT?$/, '').replace(/-USD$/, '')
    const state = await getAccountState(wallet.address)
    const pos = state.positions.find(p => p.coin.toUpperCase() === sym)
    if (!pos || pos.szi === 0) {
      return res.status(404).json({
        success: false,
        error: `No open ${sym} position to close`,
      })
    }

    // szi is signed: positive = long, negative = short. Close direction is
    //   the opposite. The size we send is |szi| — placeOrder applies the
    //   szDecimals rounding internally.
    const closeSide: 'LONG' | 'SHORT' = pos.szi > 0 ? 'SHORT' : 'LONG'
    const sz = Math.abs(pos.szi)

    // reduceOnly = true so we cannot accidentally flip into the opposite
    //   side if mark drift / rounding nudges the order slightly oversized.
    const orderArgs = {
      coin: sym,
      side: closeSide,
      type: 'MARKET' as const,
      sz,
      reduceOnly: true,
    }

    let result = await placeOrder(creds, orderArgs)

    // Builder-fallback policy for CLOSES is intentionally more aggressive
    // than for /order. /order has a multi-stage ladder (auto-approve →
    // backoff retry → noBuilder fallback only on unregistered errors)
    // because we want to actually collect the 0.1% fee on entries when
    // possible. For an EXIT, the priority is the user gets out — losing
    // the 0.1% kickback on a single fill is trivially acceptable compared
    // to wedging a user inside a position they're trying to close. So:
    // ANY builder-related error → immediately retry with noBuilder.
    //
    // Covered phrasings (all observed from HL):
    //   - "Builder fee has not been approved"   (user hasn't signed approval)
    //   - "Must approve builder fee"            (alt phrasing)
    //   - "Builder has insufficient balance"    (our builder unregistered)
    //   - "Not a registered builder"            (our builder unregistered)
    if (!result.success && /(builder|must approve)/i.test(result.error ?? '')) {
      console.warn(
        `[/hyperliquid/close] builder-related reject — falling back to no-builder close ` +
        `user=${user.id} coin=${sym} err=${result.error}`,
      )
      result = await placeOrder(creds, { ...orderArgs, noBuilder: true })
      if (result.success) {
        console.warn(
          `[/hyperliquid/close] no-builder close succeeded user=${user.id} coin=${sym} — 0.1% fee skipped`,
        )
      }
    }

    if (!result.success) {
      return res.status(400).json(result)
    }
    return res.json({
      ...result,
      coin: sym,
      side: closeSide,
      sz,
      closedSzi: pos.szi,
    })
  } catch (err: any) {
    console.error('[API] /hyperliquid/close failed:', err?.message ?? err)
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
    // getAccountState now also queries HL's userAbstraction endpoint in
    // parallel so we can detect Unified Account mode without waiting for
    // the user to tap Move and hit a 502.
    const [state, spotUsdc] = await Promise.all([
      getAccountState(wallet.address),
      getSpotUsdcBalance(wallet.address),
    ])

    // Source-of-truth resolution for the unified flag:
    //   1. Live HL response is authoritative when present (catches users
    //      who toggled abstraction on hyperliquid.xyz between sessions).
    //   2. Persisted DB flag is the fallback when HL is unreachable —
    //      protects the UI from regressing to "show CTAs" during HL
    //      outages.
    //   3. If HL says unified and DB doesn't yet know, persist async so
    //      future requests (and background workers that read straight
    //      from the DB) see it. Fire-and-forget — don't block the
    //      response on a write to fix a UI flag.
    const dbFlag   = Boolean((user as any).hyperliquidUnified)
    const liveFlag = state.abstraction === 'unifiedAccount'
    const unifiedAccount = state.abstraction === null ? dbFlag : liveFlag
    if (liveFlag && !dbFlag) {
      db.user.update({ where: { id: user.id }, data: { hyperliquidUnified: true } })
        .catch((e: any) => console.warn(`[/hyperliquid/account] persist unified flag failed user=${user.id}: ${e?.message}`))
    } else if (!liveFlag && state.abstraction !== null && dbFlag) {
      // User flipped OUT of unified mode (e.g. on hyperliquid.xyz). Clear
      // the cached flag so we stop hiding the move CTAs they now need.
      db.user.update({ where: { id: user.id }, data: { hyperliquidUnified: false } })
        .catch((e: any) => console.warn(`[/hyperliquid/account] clear unified flag failed user=${user.id}: ${e?.message}`))
    }

    // Onboarded self-heal: when the User row's `hyperliquidOnboarded`
    // flag is false BUT the user clearly has the artefacts of a
    // completed activation (an agent wallet address + its encrypted
    // private key in the DB) AND any sign of life on HL itself (real
    // perps balance, real spot USDC, or open positions), we treat the
    // user as onboarded and async-write the flag back so subsequent
    // requests agree. This protects against the failure mode the user
    // reported: "I activated before, but the page keeps asking me to
    // activate again." Causes seen in the wild include a DB rollback
    // that wiped the flag, a User row recreated by the new-user path
    // overwriting an existing record, and concurrent writes during
    // activation racing each other. As long as the agent keys exist
    // and HL has funds, the user IS onboarded — anything else is the
    // server's bookkeeping out of sync.
    const dbOnboarded = Boolean((user as any).hyperliquidOnboarded)
    const hasAgentKeys = Boolean(
      (user as any).hyperliquidAgentAddress &&
      (user as any).hyperliquidAgentEncryptedPK,
    )
    const hasHlActivity =
      (state.accountValue ?? 0) > 0 ||
      (spotUsdc ?? 0) > 0 ||
      ((state.positions ?? []) as any[]).some((p: any) => Number(p?.szi ?? 0) !== 0)
    const onboarded = dbOnboarded || (hasAgentKeys && hasHlActivity)
    if (onboarded && !dbOnboarded) {
      db.user.update({ where: { id: user.id }, data: { hyperliquidOnboarded: true } })
        .catch((e: any) => console.warn(`[/hyperliquid/account] self-heal onboarded flag failed user=${user.id}: ${e?.message}`))
      console.log(`[/hyperliquid/account] self-heal onboarded=true user=${user.id} (agent keys + HL activity present)`)
    }

    // IMPORTANT: spread `...state` FIRST so the explicit fields below
    // win on collision. `state` from getAccountState() carries its own
    // `onboarded` (HL-side meaningful: "does this address exist on HL")
    // which is NOT the same as our DB+self-heal `onboarded` (mini-app
    // meaningful: "is this user activated for trading"). Spreading it
    // last would let the HL-side value silently override our self-heal,
    // re-triggering the "asks to activate again" bug we're fixing.
    res.json({
      ...state,
      walletAddress:  wallet.address,
      onboarded,
      // True when this user has HL Unified Account enabled. The mini-app
      // suppresses spot↔perps move CTAs and shows a combined-balance hint
      // when this is true. Resolved live from HL each request, with the
      // persisted DB flag as a fallback for HL outages.
      unifiedAccount,
      spotUsdc,
    })
  } catch (err: any) {
    console.error('[API] /hyperliquid/account failed:', err?.message)
    res.status(500).json({ error: err?.message ?? 'Internal error' })
  }
})

// GET /api/hyperliquid/trades
// Query: ?limit=20 (optional, max 100)
// Returns the user's most recent Hyperliquid fills with per-fill fee, so
// users can audit their trading costs and verify builder-fee accounting
// end-to-end. HL emits a separate fill row per match (a single market
// order walking the book yields N fills with the same `oid`/`tid`),
// which we surface as-is — the UI dedupes presentationally if needed.
//
// ── Caching & 429 mitigation ─────────────────────────────────────────────
// HL's /info endpoint is rate-limited per IP and Render gives us a single
// shared egress IP for all users. With the mini-app polling every 5s plus
// other concurrent users, the Recent Fills card was flashing "429 Too Many
// Requests - null" intermittently.
//
// We cache the raw fills array per wallet address with a 15s TTL and
// dedupe concurrent in-flight fetches into a single upstream call. On any
// HL error (including 429), if we have *any* prior data — even past TTL —
// we serve it with `cached:true` instead of bubbling a 5xx, so the UI can
// keep showing the user's last-known fills without a red banner.
const HL_FILLS_TTL_MS = 15_000
const HL_FILLS_STALE_MAX_MS = 5 * 60_000 // refuse to serve cache older than 5min
type HlFillsCacheEntry = {
  data: any[]              // normalized fills array (as returned by getUserFillsStrict)
  fetchedAt: number
  inflight?: Promise<any[]>
}
const hlFillsCache = new Map<string, HlFillsCacheEntry>()

app.get('/api/hyperliquid/trades', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    if (!user.hyperliquidOnboarded) {
      return res.status(400).json({ error: 'Activate Hyperliquid trading first', needsApprove: true })
    }
    const wallet = await db.wallet.findFirst({ where: { userId: user.id, isActive: true } })
    if (!wallet) return res.status(404).json({ error: 'No active wallet' })

    const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit ?? '20'), 10) || 20))
    const cacheKey = wallet.address.toLowerCase()
    const now = Date.now()
    const cached = hlFillsCache.get(cacheKey)

    // 1. Fresh cache hit → serve immediately, skip HL entirely.
    if (cached && (now - cached.fetchedAt) < HL_FILLS_TTL_MS) {
      const trades = [...cached.data].sort((a, b) => b.time - a.time).slice(0, limit)
      return res.json({ trades, cached: true })
    }

    // 2. Otherwise refetch — but coalesce concurrent callers onto one
    //    in-flight promise so a burst of polls (multiple tabs, React
    //    StrictMode double-mount) only hits HL once.
    const { getUserFillsStrict } = await import('./services/hyperliquid')
    const entry: HlFillsCacheEntry = cached ?? { data: [], fetchedAt: 0 }
    if (!cached) hlFillsCache.set(cacheKey, entry)

    let promise = entry.inflight
    if (!promise) {
      promise = (async () => {
        try {
          const fresh = await getUserFillsStrict(wallet.address)
          entry.data = fresh
          entry.fetchedAt = Date.now()
          return fresh
        } finally {
          // Clear the in-flight slot so the *next* request triggers a real
          // fetch. We capture `promise` into a local above so resolved
          // callers can still read the result after this finally runs.
          entry.inflight = undefined
        }
      })()
      entry.inflight = promise
    }

    try {
      const all = await promise
      const trades = [...(all ?? [])].sort((a, b) => b.time - a.time).slice(0, limit)
      return res.json({ trades })
    } catch (hlErr: any) {
      // 3. HL upstream failed (typically 429). If we have ANY prior data
      //    that isn't ancient, return it with cached:true so the panel
      //    doesn't go red — fills don't change frequently and a 1-2min
      //    old snapshot is far better UX than a flashing error banner.
      if (entry.data.length > 0 && (Date.now() - entry.fetchedAt) < HL_FILLS_STALE_MAX_MS) {
        const trades = [...entry.data].sort((a, b) => b.time - a.time).slice(0, limit)
        return res.json({ trades, cached: true, stale: true })
      }
      // 4. No usable cache (cold open). Returning a 5xx here is what
      //    triggered the user-visible "Could not load fills: 429 Too
      //    Many Requests - null" red banner on first paint, because the
      //    client's grace-period suppression only fires once it has had
      //    at least one successful read. Return 200 with an empty list
      //    plus an explicit `rateLimited` flag so the UI can render a
      //    muted "temporarily unavailable" hint instead of an alarming
      //    error banner — the next 20s poll usually succeeds.
      const status = hlErr?.status ?? hlErr?.response?.status
      const msg = String(hlErr?.message ?? '')
      const isRateLimited = status === 429 || /429|too many requests|rate.?limit/i.test(msg)
      if (isRateLimited) {
        return res.json({ trades: [], rateLimited: true })
      }
      throw hlErr
    }
  } catch (err: any) {
    console.error('[API] /hyperliquid/trades failed:', err?.message)
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

// Mini-app one-shot agent creation. Replaces the multi-step bot flow:
// the FE sends { preset, startingCapital, chain? } and we run the full
// wallet-gen → fund → ERC-8004 register pipeline via the shared
// createAgentForUser service. On success we DM the user a confirmation
// with a deep-link back to the mini app so they get the same kind of
// "your agent is live" affordance whether they used the bot or the FE.
app.post('/api/me/agents/onboard', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    if (!user) return res.status(401).json({ error: 'Unauthenticated' })

    const body = (req.body ?? {}) as { preset?: unknown; startingCapital?: unknown; chain?: unknown; name?: unknown }
    const preset = String(body.preset ?? '').toLowerCase()
    if (!['safe', 'balanced', 'aggressive'].includes(preset)) {
      return res.status(400).json({ error: 'preset must be one of: safe, balanced, aggressive' })
    }
    const capital = Number(body.startingCapital)
    if (!Number.isFinite(capital) || capital < 5.5) {
      return res.status(400).json({ error: 'startingCapital must be >= 5.5 USDT' })
    }
    // chain is optional — service auto-picks XLayer when registry is configured.
    const chainStr = body.chain ? String(body.chain).toLowerCase() : undefined
    if (chainStr && !['bsc', 'xlayer'].includes(chainStr)) {
      return res.status(400).json({ error: "chain must be 'bsc' or 'xlayer'" })
    }
    // Optional user-supplied agent name. We surface a fast 400 with the
    // exact rule on bad input rather than letting createAgentForUser throw
    // a generic error from deep in the pipeline. Empty/missing → service
    // generates a random one. Same regex as agentCreation.ts for parity.
    let nameStr: string | undefined
    if (body.name !== undefined && body.name !== null && String(body.name).trim() !== '') {
      const trimmed = String(body.name).trim()
      if (!/^[a-zA-Z0-9_]{3,24}$/.test(trimmed)) {
        return res.status(400).json({ error: 'name must be 3–24 chars, letters/numbers/underscore only' })
      }
      nameStr = trimmed
    }

    const wallet = await db.wallet.findFirst({ where: { userId: user.id, isActive: true } })
    if (!wallet) return res.status(404).json({ error: 'No active wallet' })

    const { createAgentForUser } = await import('./services/agentCreation')
    const result = await createAgentForUser({
      userId:          user.id,
      ownerAddress:    wallet.address,
      preset:          preset as 'safe' | 'balanced' | 'aggressive',
      startingCapital: capital,
      chain:           chainStr as 'bsc' | 'xlayer' | undefined,
      name:            nameStr,
    })

    if (!result.ok) {
      const status = result.partial ? 502 : 400
      return res.status(status).json({
        error:   result.reason,
        partial: !!result.partial,
        agentId: result.agentId ?? null,
      })
    }

    // Best-effort confirmation DM. The user is already seeing the success
    // state in the mini app; the DM is for when they re-open Telegram and
    // want a deep-link back. Fire-and-forget so a Telegram outage can't
    // fail the activation response. Skipped silently for users who have
    // blocked the bot (botBlocked=true).
    const token = process.env.TELEGRAM_BOT_TOKEN
    if (token && user.telegramId && !user.botBlocked) {
      const miniBase = process.env.MINIAPP_URL
        || `https://${process.env.REPLIT_DOMAINS?.split(',')[0] || 'build4-1.onrender.com'}/app`
      // List the venues this agent will actually scan. agentCreation seeds
      // all 4 venues into enabledVenues by default, so the message should
      // say so — saying "Trading on Aster" was lying about scope and made
      // the user think HL/42/POLY were OFF until manually flipped.
      const enabledVenuesLive: string[] = Array.isArray((result.agent as any)?.enabledVenues)
        ? (result.agent as any).enabledVenues
        : ['aster', 'hyperliquid', 'fortytwo', 'polymarket']
      const venueNames = enabledVenuesLive
        .map((v) => v === 'aster' ? 'Aster'
                  : v === 'hyperliquid' ? 'Hyperliquid'
                  : v === 'fortytwo' ? '42.space'
                  : v === 'polymarket' ? 'Polymarket' : v)
      const venueList = venueNames.length > 1
        ? venueNames.slice(0, -1).join(', ') + ' & ' + venueNames[venueNames.length - 1]
        : (venueNames[0] ?? 'Aster')
      tgSendMessage(
        token,
        String(user.telegramId),
        `🚀 ${result.agent.name} is LIVE.\n\n` +
        `Scanning ${venueList} with the ${preset} preset and $${capital.toFixed(2)} per position. ` +
        `First scan kicks off in ~60 seconds — open BUILD4 to watch it work.\n\n` +
        `Note: Polymarket needs a one-time Safe setup before it can place orders. ` +
        `You'll see SKIP rows in the brain feed until you tap Predict → Setup.`,
        null,
        { text: '📱 Open BUILD4', url: miniBase },
      ).catch((e) => console.warn('[/api/me/agents/onboard] DM failed (non-fatal):', e?.message ?? e))
    }

    return res.json({ success: true, agent: result.agent })
  } catch (err: any) {
    console.error('[API] /api/me/agents/onboard failed:', err?.message ?? err)
    res.status(500).json({ error: err?.message ?? 'Internal error' })
  }
})

// Hard-delete an agent owned by the caller. Caller-owned and
// ownership-checked. We do NOT touch the agent's on-chain ERC-8004
// identity — that's immutable, and the agent's wallet will simply stop
// signing trades. The user can always create a fresh agent (with a
// fresh wallet + fresh identity) from the Onboard page.
//
// Three-step sequence:
//   1. Pause + deactivate the agent OUTSIDE the delete transaction so
//      the runner sees the change immediately (the runner's filter
//      requires isActive=true && isPaused=false). This closes the
//      window where the row vanishes mid-dispatch.
//   2. Cascade-clean dependent rows that have ON DELETE RESTRICT FKs
//      (AgentLog, AgentMemory). Without this, any agent that has
//      actually run hits a 23503 FK violation. Trade.agentId is
//      ON DELETE SET NULL so trade history (the financial record)
//      survives — only the back-reference is nulled.
//   3. Delete the Agent row in the same transaction as the cleanup so
//      a partial cleanup never leaves orphaned dependents.
app.delete('/api/agents/:id', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    if (!user) return res.status(401).json({ error: 'Unauthenticated' })

    const agentId = String(req.params.id)
    const agent = await db.agent.findUnique({ where: { id: agentId } })
    if (!agent) return res.status(404).json({ error: 'Agent not found' })
    if (agent.userId !== user.id) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    // Step 1: park the agent. Best-effort — if this update somehow
    // races and fails, the transaction below still tears the row down
    // cleanly, the runner just sees an "agent not found" on the very
    // next tick (which it already tolerates).
    try {
      await db.agent.update({ where: { id: agentId }, data: { isActive: false, isPaused: true } })
    } catch { /* tolerable — we're about to delete anyway */ }

    // Brief drain pause so any tick that already passed the
    // ACTIVE_AGENTS_FILTER and is currently running for this agent
    // has a moment to finish writing its log row before we drop it.
    // 1.2s is comfortably longer than a single trade-decision write.
    await new Promise((r) => setTimeout(r, 1200))

    // Step 2 + 3: remove dependent rows then the agent itself.
    await db.$transaction([
      db.agentLog.deleteMany({   where: { agentId } }),
      db.agentMemory.deleteMany({ where: { agentId } }),
      db.agent.delete({           where: { id: agentId } }),
    ])

    res.json({ ok: true })
  } catch (err: any) {
    console.error('[API] DELETE /api/agents/:id failed:', err?.message ?? err)
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

    // Master kill-switch behaviour preserved for back-compat. When
    // turning the agent ON, also seed enabledVenues from the legacy
    // `exchange` column if it's empty so the runner has at least one
    // venue to dispatch into. Turning OFF doesn't clear enabledVenues —
    // the user's per-venue selections persist across master toggles.
    const turningOn = !agent.isActive
    const venuesNow = Array.isArray((agent as any).enabledVenues) ? (agent as any).enabledVenues : []
    const seedVenues = turningOn && venuesNow.length === 0 && agent.exchange
      ? { enabledVenues: [agent.exchange] }
      : {}

    const updated = await db.agent.update({
      where: { id: agentId },
      data: { isActive: turningOn, isPaused: false, ...seedVenues }
    })
    res.json(updated)
  } catch {
    res.status(500).json({ error: 'Internal error' })
  }
})

// Per-agent venue toggle (Phase 1, 2026-04-28). Replaces the single
// "Activate" button on the agent card with one chip per venue:
// ASTER / HYPERLIQUID / 42SPACE. The user can enable any subset; the
// agent runs an independent scan + decision per enabled venue each tick.
//
// Body: { enabled: boolean } — explicit set. We don't toggle from the
// current state because the UI is optimistic and we want the server to
// be the source of truth for "is this venue on right now". Idempotent
// by design: setting enabled=true on an already-enabled venue is a
// no-op, same for disable.
//
// Side-effects:
//   • Adding the FIRST venue auto-flips isActive=true (so the agent
//     starts ticking immediately after the first chip turn-on).
//   • Removing the LAST venue auto-flips isActive=false (so the runner
//     stops dispatching for an empty allow-list).
// This keeps the master kill-switch behaviour intact for any legacy
// code path that still gates on isActive (and for the chat bot's
// existing "agent is active" copy).
// Phase 4 (2026-05-01) — 'polymarket' added so per-agent chip toggles work for
// the 4th venue. The toggle endpoint flips Agent.enabledVenues; the polymarket
// runner loop honors that array (in addition to the legacy polymarketEnabled
// boolean) so chip on/off translates directly to "this agent trades Polymarket
// or it doesn't".
const ALLOWED_VENUE_TOGGLES = new Set(['aster', 'hyperliquid', 'fortytwo', 'polymarket'])
app.post('/api/agents/:id/venues/:venue/toggle', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    if (!user) return res.status(401).json({ error: 'Unauthenticated' })

    const agentId = String(req.params.id)
    const venue   = String(req.params.venue ?? '').toLowerCase()
    if (!ALLOWED_VENUE_TOGGLES.has(venue)) {
      return res.status(400).json({ error: `Unknown venue '${venue}'` })
    }

    const body = (req.body ?? {}) as { enabled?: unknown }
    if (typeof body.enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled (boolean) is required' })
    }
    const enabled = body.enabled

    const agent = await db.agent.findUnique({ where: { id: agentId } })
    if (!agent) return res.status(404).json({ error: 'Agent not found' })
    if (agent.userId !== user.id) return res.status(403).json({ error: 'Forbidden' })

    const current: string[] = Array.isArray((agent as any).enabledVenues)
      ? (agent as any).enabledVenues
      : []
    const set = new Set(current)
    if (enabled) set.add(venue)
    else         set.delete(venue)
    const next = Array.from(set)

    // Master switch sync (see header comment): non-empty venues → active,
    // empty → inactive. Don't touch isPaused — that's reserved for
    // automated stops (daily-loss tripwires) and the user shouldn't be
    // able to override one of those by toggling a venue chip.
    //
    // Phase 4 (2026-05-01): Polymarket has its OWN legacy boolean
    // (`polymarketEnabled`) that the polymarket runner ALSO honors via an
    // OR clause for backwards compatibility with rows pre-dating
    // `enabledVenues`. If we don't sync that boolean here, toggling the
    // chip OFF would leave `polymarketEnabled=true` set at agent-creation
    // time and the runner would still tick the agent — making the chip a
    // no-op. Mirror the chip state into the boolean so the chip is the
    // single canonical control surface.
    const data: Prisma.AgentUpdateInput = {
      enabledVenues: next,
      isActive:      next.length > 0,
    }
    if (venue === 'polymarket') {
      data.polymarketEnabled = enabled
    }
    const updated = await db.agent.update({
      where: { id: agentId },
      data,
    })
    res.json({ ok: true, agent: updated })
  } catch (err: any) {
    console.error('[API] /agents/:id/venues/:venue/toggle failed:', err?.message ?? err)
    res.status(500).json({ error: 'Internal error' })
  }
})

// Update an agent's risk-limit settings (max position, max daily loss,
// max leverage). Originally these were only set at agent creation time —
// users were asking how to change them after the fact and the answer was
// "delete the agent and create a new one", which is awful. This endpoint
// lets the mini app surface inline editors on the agent card. All three
// fields are optional and are validated independently; missing fields
// keep their current value. Bounds chosen to match the existing agent
// runner clamps (leverage hard-clamp at 1..50; balance/loss must be
// strictly positive to avoid degenerate "trade nothing" agents).
app.patch('/api/agents/:id/settings', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    if (!user) return res.status(401).json({ error: 'Unauthenticated' })

    const agentId = String(req.params.id)
    const agent = await db.agent.findUnique({ where: { id: agentId } })
    if (!agent) return res.status(404).json({ error: 'Agent not found' })
    if (agent.userId !== user.id) return res.status(403).json({ error: 'Forbidden' })

    const body = (req.body ?? {}) as Record<string, unknown>
    const data: Record<string, number> = {}

    const toNum = (v: unknown): number | null => {
      if (v === undefined || v === null || v === '') return null
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isFinite(n) ? n : null
    }

    if ('maxPositionSize' in body) {
      const n = toNum(body.maxPositionSize)
      if (n === null || n <= 0 || n > 100_000) {
        return res.status(400).json({ error: 'maxPositionSize must be a positive number ≤ 100000' })
      }
      data.maxPositionSize = n
    }
    if ('maxDailyLoss' in body) {
      const n = toNum(body.maxDailyLoss)
      if (n === null || n <= 0 || n > 100_000) {
        return res.status(400).json({ error: 'maxDailyLoss must be a positive number ≤ 100000' })
      }
      data.maxDailyLoss = n
    }
    if ('maxLeverage' in body) {
      const n = toNum(body.maxLeverage)
      if (n === null || n < 1 || n > 50) {
        return res.status(400).json({ error: 'maxLeverage must be between 1 and 50' })
      }
      data.maxLeverage = Math.round(n)
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'No editable fields provided' })
    }

    const updated = await db.agent.update({ where: { id: agentId }, data })
    res.json(updated)
  } catch (err: any) {
    console.error('[API] /agents/:id/settings failed:', err?.message ?? err)
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

    // Look up the user's active wallet up-front so we can fan out the HL
    // calls in parallel with the DB reads. If there's no wallet (user
    // hasn't onboarded), HL fetches are skipped — Portfolio falls back to
    // the DB-only view exactly as before.
    const wallet = await db.wallet.findFirst({
      where: { userId: internalUserId, isActive: true },
    })

    // Fan out: portfolio row, DB-stored trades (Aster path / agent trades),
    // HL fills (closes — what shows up in Trade History) and HL open
    // positions (so users see live positions in history too without
    // having to switch tabs).
    //
    // We additionally try to reconcile stale Aster open-trades against
    // the live positionRisk snapshot before reading the trades — without
    // this, the Portfolio Trade History keeps showing closed-on-venue
    // rows as "Open" until the next agent tick reaches them. Errors
    // here are non-fatal; we still serve the DB rows below.
    if (wallet) {
      try {
        const u = await db.user.findUnique({ where: { id: internalUserId } })
        // Same shared-agent-leak guard as /api/me/wallet: only call
        // resolveAgentCreds (which falls back to the platform agent PK
        // when asterAgentEncryptedPK is null) for users who have BOTH
        // completed onboarding AND have their own per-user agent on
        // file. Without this gate, /api/portfolio for a legacy user
        // with asterOnboarded=true but asterAgentEncryptedPK=null would
        // sign with the platform agent and reconcile against the
        // platform agent's positions — leaking shared state across
        // users (the same root cause as the "$9.41 ASTER" bug on
        // /api/me/wallet).
        if (u?.asterOnboarded && (u as any).asterAgentEncryptedPK) {
          const { resolveAgentCreds, getPositions } = await import('./services/aster')
          const { reconcileStaleAsterTrades } = await import('./services/asterReconcile')
          const creds = await resolveAgentCreds(u as any, wallet.address)
          if (creds) {
            const raw = await getPositions(creds)
            const live = raw.map((p: any) => ({ symbol: p.symbol, side: p.side }))
            await reconcileStaleAsterTrades(internalUserId, live, true)
          }
        }
      } catch (e: any) {
        console.warn(`[API] /portfolio/:userId reconcile skipped: ${e?.message ?? e}`)
      }
    }

    const [portfolio, dbTrades, hlFills, hlState] = await Promise.all([
      db.portfolio.findUnique({ where: { userId: internalUserId } }),
      db.trade.findMany({
        where: { userId: internalUserId },
        orderBy: { openedAt: 'desc' },
        take: 50,
      }),
      wallet
        ? import('./services/hyperliquid').then(m => m.getUserFills(wallet.address))
        : Promise.resolve([] as any[]),
      wallet
        ? import('./services/hyperliquid').then(m => m.getAccountState(wallet.address))
        : Promise.resolve({ positions: [] as any[] } as any),
    ])

    // Map DB trades to the shape Portfolio.tsx expects.
    const trades: any[] = dbTrades.map(t => ({
      id: t.id,
      pair: t.pair,
      side: t.side,
      pnl: t.pnl,
      status: t.status,
      openedAt: t.openedAt,
      closedAt: t.closedAt,
      aiReasoning: t.aiReasoning,
      exchange: t.exchange,
    }))

    // ── Hyperliquid CLOSED trades (from userFills)
    //
    // HL emits one fill row per match, so a single market order can fan
    // out into multiple fills with the same `tid`. We only care about
    // closing fills (closedPnl != 0) and we aggregate by `tid` so each
    // close shows up as one row in Trade History — not five.
    const closingByTid = new Map<number, {
      tid: number
      coin: string
      time: number
      pnlSum: number
      szSum: number
      notionalSum: number  // for size-weighted avg price
      dir: string          // 'Close Long' / 'Close Short'
    }>()
    for (const f of hlFills) {
      if (f.closedPnl === 0) continue  // open fills handled via positions below
      const cur = closingByTid.get(f.tid)
      if (cur) {
        cur.pnlSum     += f.closedPnl
        cur.szSum      += f.sz
        cur.notionalSum += f.sz * f.px
        cur.time = Math.max(cur.time, f.time)
      } else {
        closingByTid.set(f.tid, {
          tid: f.tid,
          coin: f.coin,
          time: f.time,
          pnlSum: f.closedPnl,
          szSum: f.sz,
          notionalSum: f.sz * f.px,
          dir: f.dir,
        })
      }
    }
    for (const c of closingByTid.values()) {
      // dir: "Close Long" means we were long → side='LONG'
      //      "Close Short" means we were short → side='SHORT'
      const side = /short/i.test(c.dir) ? 'SHORT' : 'LONG'
      trades.push({
        id: `hl_${c.tid}`,
        pair: c.coin,
        side,
        pnl: c.pnlSum,
        status: 'closed',
        openedAt: new Date(c.time),  // best-effort; we don't have entry time here
        closedAt: new Date(c.time),
        exchange: 'hyperliquid',
      })
    }

    // ── Hyperliquid OPEN positions
    //
    // Surface as "open" rows in Trade History so users can see their live
    // exposure alongside their closed history without bouncing tabs.
    for (const p of (hlState.positions ?? [])) {
      if (!p.szi) continue
      trades.push({
        id: `hl_open_${p.coin}`,
        pair: p.coin,
        side: p.szi > 0 ? 'LONG' : 'SHORT',
        pnl: p.unrealizedPnl,
        status: 'open',
        openedAt: null,
        closedAt: null,
        exchange: 'hyperliquid',
      })
    }

    // Newest first overall — the chart math sorts on closedAt itself, so
    // this only affects the "Trade History" list ordering. Open rows
    // float to the top (closedAt null sorts as +Infinity here).
    trades.sort((a, b) => {
      const ta = a.closedAt ? new Date(a.closedAt).getTime() : Infinity
      const tb = b.closedAt ? new Date(b.closedAt).getTime() : Infinity
      return tb - ta
    })

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

// ─── Debug: per-user Polymarket agent state ───
// Returns the exact filter values the polymarket sweep uses so we can
// diagnose "Polymarket isn't running for my agent" reports without DB
// access. Scoped to the calling Telegram user, so safe to expose
// publicly — they only see their own agents. Hit this from a browser
// while logged into the mini-app: /api/me/debug-polymarket
app.get('/api/me/debug-polymarket', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    const u = await db.user.findUnique({
      where: { id: user.id },
      select: {
        id: true, telegramId: true,
        polymarketAgentTradingEnabled: true,
      },
    })
    // Raw SELECT bypasses any stale-Prisma-client problem and surfaces
    // every column relevant to the sweep filter.
    const rows = await db.$queryRawUnsafe<any[]>(
      `SELECT id, name, "isActive", "isPaused",
              "polymarketEnabled",
              "enabledVenues",
              "venuesAutoExpanded",
              "lastPolymarketTickAt",
              "polymarketMaxSizeUsdc",
              "polymarketEdgeThreshold",
              "createdAt"
         FROM "Agent"
        WHERE "userId" = $1
        ORDER BY "createdAt" DESC`,
      user.id,
    )
    const polyCreds = await db.polymarketCreds.findUnique({
      where: { userId: user.id },
      select: { walletAddress: true, safeAddress: true, createdAt: true },
    })
    const wouldMatchSweep = rows
      .filter((r) => r.isActive && !r.isPaused)
      .filter((r) => r.polymarketEnabled === true ||
                     (Array.isArray(r.enabledVenues) && r.enabledVenues.includes('polymarket')))
      .filter(() => u?.polymarketAgentTradingEnabled !== false)
    res.json({
      user: u,
      agents: rows,
      polymarketCreds: polyCreds,
      wouldMatchSweep: wouldMatchSweep.map((r) => ({ id: r.id, name: r.name })),
      diagnosis:
        u?.polymarketAgentTradingEnabled === false
          ? 'BLOCKED: User.polymarketAgentTradingEnabled is false'
          : wouldMatchSweep.length === 0
            ? rows.length === 0
              ? 'BLOCKED: User has no agents'
              : 'BLOCKED: No agent matches sweep filter — check polymarketEnabled / enabledVenues / isActive'
            : `OK: ${wouldMatchSweep.length} agent(s) would be picked up by the polymarket sweep`,
    })
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Internal error' })
  }
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

// ── 42.space "Agent vs Community" campaign recap (T011) ──────────────────
// GET /api/admin/campaign/state
//   Round-by-round breakdown of the campaign agent's positions: bucket,
//   size, multiplier, swarm vote, settled status, payout, PnL, cumulative.
//   Drives the leaderboard tweet + mini-app recap card.
//
// Reads positions tagged with `[CAMPAIGN ... round=<ms> ...]` in their
// reasoning prefix (set by fortyTwoCampaign.runCampaignTick), groups by
// round boundary, and computes per-round + cumulative PnL from the
// existing OutcomePosition fields (status, payoutUsdt, pnl).
app.get('/api/admin/campaign/state', requireAdmin, async (_req, res) => {
  try {
    const agentId = process.env.FT_CAMPAIGN_AGENT_ID
    if (!agentId) {
      return res.json({
        ok: false,
        reason: 'FT_CAMPAIGN_AGENT_ID not set',
        rounds: [],
        cumulativePnl: 0,
      })
    }
    const positions = await db.$queryRawUnsafe<Array<{
      id: string
      marketAddress: string
      marketTitle: string
      tokenId: number
      outcomeLabel: string
      usdtIn: number
      entryPrice: number
      payoutUsdt: number | null
      pnl: number | null
      status: string
      paperTrade: boolean
      txHashOpen: string | null
      reasoning: string | null
      providers: any
      openedAt: Date
      closedAt: Date | null
    }>>(
      `SELECT id, "marketAddress", "marketTitle", "tokenId", "outcomeLabel",
              "usdtIn", "entryPrice", "payoutUsdt", pnl, status, "paperTrade",
              "txHashOpen", reasoning, providers, "openedAt", "closedAt"
       FROM "OutcomePosition"
       WHERE "agentId" = $1
       ORDER BY "openedAt" ASC`,
      agentId,
    )

    // Group by round boundary parsed from the reasoning prefix.
    type RoundBucket = {
      roundBoundaryMs: number | null
      roundIdx: number | null
      positions: Array<{
        id: string
        kind: string         // ENTRY | DOUBLE_DOWN | SPREAD | UNTAGGED
        tick: string | null  // ENTRY | REASSESS_1 | REASSESS_2 | FINAL | null
        marketAddress: string
        marketTitle: string
        tokenId: number
        outcomeLabel: string
        usdtIn: number
        entryPrice: number
        impliedMultiplier: number
        payoutUsdt: number | null
        pnl: number | null
        status: string
        paperTrade: boolean
        txHashOpen: string | null
        thesis: string
        swarm: any
        openedAt: string
        closedAt: string | null
      }>
      totalIn: number
      totalPayout: number
      totalPnl: number
      settled: boolean
    }
    const startMs = Number(process.env.FT_CAMPAIGN_START_MS ?? 0) || null
    const buckets = new Map<string, RoundBucket>()
    for (const p of positions) {
      const m = (p.reasoning ?? '').match(/\[CAMPAIGN\s+(\w+)\s+round=(\d+)(?:\s+tick=(\w+))?\]\s*(.*)/)
      const kind = m?.[1] ?? 'UNTAGGED'
      const roundBoundaryMs = m ? Number(m[2]) : null
      const tick = m?.[3] ?? (kind === 'ENTRY' ? 'ENTRY' : null)
      const thesis = m?.[4] ?? (p.reasoning ?? '')
      const key = roundBoundaryMs?.toString() ?? `unbounded:${p.id}`
      const roundIdx = startMs && roundBoundaryMs
        ? Math.max(1, Math.min(12, Math.floor((roundBoundaryMs - startMs) / (4 * 60 * 60 * 1000)) + 1))
        : null
      let bucket = buckets.get(key)
      if (!bucket) {
        bucket = {
          roundBoundaryMs,
          roundIdx,
          positions: [],
          totalIn: 0,
          totalPayout: 0,
          totalPnl: 0,
          settled: true,
        }
        buckets.set(key, bucket)
      }
      const impliedMultiplier = p.entryPrice > 0 ? 1 / p.entryPrice : 0
      bucket.positions.push({
        id: p.id,
        kind,
        tick,
        marketAddress: p.marketAddress,
        marketTitle: p.marketTitle,
        tokenId: Number(p.tokenId),
        outcomeLabel: p.outcomeLabel,
        usdtIn: Number(p.usdtIn),
        entryPrice: Number(p.entryPrice),
        impliedMultiplier,
        payoutUsdt: p.payoutUsdt == null ? null : Number(p.payoutUsdt),
        pnl: p.pnl == null ? null : Number(p.pnl),
        status: p.status,
        paperTrade: p.paperTrade,
        txHashOpen: p.txHashOpen,
        thesis: thesis.slice(0, 500),
        swarm: p.providers,
        openedAt: p.openedAt.toISOString(),
        closedAt: p.closedAt?.toISOString() ?? null,
      })
      bucket.totalIn += Number(p.usdtIn)
      bucket.totalPayout += Number(p.payoutUsdt ?? 0)
      bucket.totalPnl += Number(p.pnl ?? 0)
      if (p.status === 'open') bucket.settled = false
    }

    const rounds = [...buckets.values()].sort((a, b) => {
      const aMs = a.roundBoundaryMs ?? Infinity
      const bMs = b.roundBoundaryMs ?? Infinity
      return aMs - bMs
    })

    let cumulative = 0
    const cumulativeByRound = rounds.map((r) => {
      cumulative += r.totalPnl
      return { roundIdx: r.roundIdx, roundBoundaryMs: r.roundBoundaryMs, cumulativePnl: cumulative }
    })

    return res.json({
      ok: true,
      agentId,
      campaignMode: process.env.FT_CAMPAIGN_MODE === 'true',
      campaignStartMs: startMs,
      tgChannel: process.env.FT_CAMPAIGN_TG_CHANNEL ?? null,
      rounds,
      cumulativeByRound,
      cumulativePnl: cumulative,
      totalRoundsTraded: rounds.length,
      totalUsdtDeployed: rounds.reduce((s, r) => s + r.totalIn, 0),
    })
  } catch (err) {
    console.error('[API] /admin/campaign/state failed:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

// POST /api/admin/campaign/resettle
//   Manually trigger the campaign agent's settle+claim sweep. Used to fix
//   the brain page when a round has finalised on-chain but the regular
//   per-tick sweep hasn't caught up (or failed transiently). Same code
//   path the runner calls after every campaign tick.
app.post('/api/admin/campaign/resettle', requireAdmin, async (_req, res) => {
  try {
    const agentId = process.env.FT_CAMPAIGN_AGENT_ID
    if (!agentId) {
      return res.status(400).json({ ok: false, error: 'FT_CAMPAIGN_AGENT_ID not set' })
    }
    const { claimAllAgentResolved } = await import('./services/fortyTwoExecutor')
    const sweep = await claimAllAgentResolved(agentId)
    return res.json(sweep)
  } catch (err) {
    console.error('[API] /admin/campaign/resettle failed:', err)
    res.status(500).json({ error: (err as Error).message })
  }
})

// POST /api/admin/campaign/tick?kind=ENTRY|REASSESS_1|REASSESS_2|FINAL
//   Manually fire a single campaign tick out-of-band (e.g. when the cron
//   missed a window due to a deploy restart). Runs the same runCampaignTick
//   code path as the scheduled cron and triggers the post-tick sweep.
app.post('/api/admin/campaign/tick', requireAdmin, async (req, res) => {
  try {
    const kindRaw = String(req.query.kind ?? req.body?.kind ?? '').toUpperCase()
    const validKinds = ['ENTRY', 'REASSESS_1', 'REASSESS_2', 'FINAL'] as const
    if (!(validKinds as readonly string[]).includes(kindRaw)) {
      return res.status(400).json({
        ok: false,
        error: `kind must be one of ${validKinds.join('|')}`,
      })
    }
    const kind = kindRaw as typeof validKinds[number]
    const { runCampaignTick } = await import('./services/fortyTwoCampaign')
    const tickResult = await runCampaignTick(kind)

    let sweep: unknown = null
    const agentId = process.env.FT_CAMPAIGN_AGENT_ID
    if (agentId) {
      try {
        const { claimAllAgentResolved } = await import('./services/fortyTwoExecutor')
        sweep = await claimAllAgentResolved(agentId)
      } catch (sweepErr) {
        sweep = { error: (sweepErr as Error).message }
      }
    }
    return res.json({ ok: true, kind, tickResult, sweep })
  } catch (err) {
    console.error('[API] /admin/campaign/tick failed:', err)
    res.status(500).json({ error: (err as Error).message })
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
  payload: { market: { address: string; question: string; description: string; status: string; endDate: string; category: string }
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
        // Resolution rules / market description from 42.space metadata.
        // Surfaced in the mini-app's expanded scanner row so users can read
        // the full question and resolution criteria before placing a trade.
        description: market.description ?? '',
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

// ──────────────────────────────────────────────────────────────────────────
// Polymarket — Builder Program read-only surfaces (Phase 1).
//
// We register as a Polymarket Builder so every order routed through the
// /predict tab in Phase 2+ accrues to our profile for the leaderboard,
// weekly USDC rewards and grant eligibility:
//   https://docs.polymarket.com/builders/overview
//   https://docs.polymarket.com/builders/tiers
//
// Phase 1 is read-only — no signing, no env vars required, no per-user
// state. Two endpoints:
//   GET /api/polymarket/events           → trending events list (15s cache)
//   GET /api/polymarket/orderbook/:tokenId → live orderbook for one outcome
//                                            token (1s TTL + dedup +
//                                            serve-stale on 429, mirroring
//                                            the HL fills cache pattern)
//
// Public (no auth) — every field rendered is already public on Polymarket.
// ──────────────────────────────────────────────────────────────────────────
const POLY_EVENTS_TTL_MS = 15_000
// Strict allowlist for Gamma sort orders. Any other value is rejected so
// (a) we never forward attacker-controlled junk to Gamma and (b) the cache
// key space is bounded — without this, an attacker could create unlimited
// distinct cache entries by varying the `order` param.
const POLY_EVENTS_ORDER_ALLOWLIST = new Set([
  'volume24hr', 'volume', 'liquidity', 'endDate', 'startDate',
])
// Hard cap on distinct (limit, tag, order) cache entries. With the
// allowlist above + numeric clamps on limit/tag, the natural ceiling is
// already small; the LRU is belt-and-braces against future param growth.
const POLY_EVENTS_CACHE_MAX = 64
type PolyEventsCacheKey = string // serialized query params
const polyEventsCache = new Map<string, {
  data: any[]
  fetchedAt: number
  inflight?: Promise<any[]>
}>()

app.get('/api/polymarket/events', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit ?? '20'), 10) || 20))
    const tagId = req.query.tag ? Math.max(0, parseInt(String(req.query.tag), 10) || 0) : undefined
    const orderRaw = String(req.query.order ?? 'volume24hr')
    if (!POLY_EVENTS_ORDER_ALLOWLIST.has(orderRaw)) {
      return res.status(400).json({ error: 'invalid_order' })
    }
    const order = orderRaw
    const cacheKey: PolyEventsCacheKey = `l=${limit}|t=${tagId ?? ''}|o=${order}`
    const now = Date.now()
    const cached = polyEventsCache.get(cacheKey)

    if (cached && cached.data.length > 0 && (now - cached.fetchedAt) < POLY_EVENTS_TTL_MS) {
      // LRU touch — Map preserves insertion order, so re-inserting moves
      // this key to the most-recently-used position for our eviction.
      polyEventsCache.delete(cacheKey)
      polyEventsCache.set(cacheKey, cached)
      return res.json({
        events: cached.data,
        cached: true,
        fetchedAt: cached.fetchedAt,
        builderCode: polymarketConfigBuilderCode(),
      })
    }

    const entry = cached ?? { data: [] as any[], fetchedAt: 0 }

    let promise = entry.inflight
    if (!promise) {
      promise = (async () => {
        try {
          const { listEvents } = await import('./services/polymarket')
          const events = await listEvents({ limit, tagId, order: order as any })
          entry.data = events
          entry.fetchedAt = Date.now()
          return events
        } finally {
          entry.inflight = undefined
        }
      })()
      entry.inflight = promise
    }

    try {
      const events = await promise
      // Only commit successful fetches to the cache so failed upstream
      // calls can never permanently occupy a slot.
      polyEventsCache.delete(cacheKey)
      polyEventsCache.set(cacheKey, entry)
      while (polyEventsCache.size > POLY_EVENTS_CACHE_MAX) {
        const oldest = polyEventsCache.keys().next().value
        if (!oldest) break
        polyEventsCache.delete(oldest)
      }
      return res.json({
        events,
        cached: false,
        fetchedAt: entry.fetchedAt,
        builderCode: polymarketConfigBuilderCode(),
      })
    } catch (gammaErr: any) {
      // Serve last good payload (≤ 5min) on upstream failure so the
      // /predict tab stays usable through brief Gamma outages.
      if (cached && cached.data.length > 0 && (Date.now() - cached.fetchedAt) < 5 * 60_000) {
        return res.json({
          events: cached.data,
          cached: true,
          stale: true,
          fetchedAt: cached.fetchedAt,
          builderCode: polymarketConfigBuilderCode(),
        })
      }
      throw gammaErr
    }
  } catch (err: any) {
    console.warn('[polymarket/events] failed:', err?.message)
    res.status(502).json({ error: err?.message ?? 'gamma_unavailable' })
  }
})

// Per-token orderbook cache. Same shape as the HL fills cache: in-flight
// dedup so a burst of polls only hits CLOB once, and serve-stale on
// upstream failure. Capped + LRU-evicted so an attacker spamming random
// valid-shaped uint256s can't grow memory unbounded.
const POLY_BOOK_TTL_MS = 1_000
const POLY_BOOK_STALE_MAX_MS = 60_000
const POLY_BOOK_CACHE_MAX = 512  // ~512 expanded markets across all users
type PolyBookCacheEntry = {
  data: any | null
  fetchedAt: number
  inflight?: Promise<any>
}
const polyBookCache = new Map<string, PolyBookCacheEntry>()

app.get('/api/polymarket/orderbook/:tokenId', async (req, res) => {
  // Polymarket token ids are very large numeric strings (uint256). Require
  // the realistic length range so we don't pass crap to CLOB and don't
  // accept arbitrarily-short numeric noise. Actual Polymarket CTF token
  // ids are ~76-78 digits; we accept 60-80 to leave a small safety margin.
  const tokenId = String(req.params.tokenId ?? '')
  if (!/^[0-9]{60,80}$/.test(tokenId)) {
    return res.status(400).json({ error: 'invalid_token_id' })
  }
  try {
    const now = Date.now()
    const cached = polyBookCache.get(tokenId)

    if (cached && cached.data && (now - cached.fetchedAt) < POLY_BOOK_TTL_MS) {
      // LRU touch
      polyBookCache.delete(tokenId)
      polyBookCache.set(tokenId, cached)
      return res.json({ book: cached.data, cached: true })
    }

    const entry = cached ?? { data: null, fetchedAt: 0 }

    let promise = entry.inflight
    if (!promise) {
      promise = (async () => {
        try {
          const { getOrderbook } = await import('./services/polymarket')
          const book = await getOrderbook(tokenId)
          entry.data = book
          entry.fetchedAt = Date.now()
          return book
        } finally {
          entry.inflight = undefined
        }
      })()
      entry.inflight = promise
    }

    try {
      const book = await promise
      // Commit on success only — failed lookups never occupy a cache slot.
      polyBookCache.delete(tokenId)
      polyBookCache.set(tokenId, entry)
      while (polyBookCache.size > POLY_BOOK_CACHE_MAX) {
        const oldest = polyBookCache.keys().next().value
        if (!oldest) break
        polyBookCache.delete(oldest)
      }
      return res.json({ book, cached: false })
    } catch (clobErr: any) {
      if (cached && cached.data && (Date.now() - cached.fetchedAt) < POLY_BOOK_STALE_MAX_MS) {
        return res.json({ book: cached.data, cached: true, stale: true })
      }
      throw clobErr
    }
  } catch (err: any) {
    console.warn('[polymarket/orderbook]', tokenId.slice(0, 12) + '…', 'failed:', err?.message)
    res.status(502).json({ error: err?.message ?? 'clob_unavailable' })
  }
})

// Helper so the events endpoint can surface our builder code (or null) to
// the client without importing the polymarket module synchronously at top
// of file. Returned in the response so the UI can show a "Powered by
// Polymarket Builder Program" badge with our short builder code.
function polymarketConfigBuilderCode(): string | null {
  // Read directly from env (not the cached config object) so test runs and
  // dynamic env updates are reflected without a server restart.
  const code = (process.env.POLY_BUILDER_CODE ?? '').trim()
  return code.length > 0 ? code : null
}

// ═══════════════════════════════════════════════════════════════════════
// Polymarket Phase 2 — manual trading endpoints (custodial PK signing).
// ───────────────────────────────────────────────────────────────────────
// These four routes form the full mini-app → Polymarket trading flow:
//   GET  /api/polymarket/wallet     — wallet status: address, USDC/MATIC
//                                      balances, allowance flag, has-creds
//   POST /api/polymarket/setup      — derive L2 API creds + run the
//                                      one-time USDC->CTF allowance tx
//   POST /api/polymarket/order      — place a market BUY/SELL on a token
//   GET  /api/polymarket/positions  — user's Polymarket position history
//
// Every order carries our POLY_BUILDER_CODE for grant-eligible volume
// attribution. Every order also writes an AgentLog row with
// exchange='polymarket' so the existing brain-feed UI tags the entry
// with a POLY chip alongside HL / Aster / 42.
// ───────────────────────────────────────────────────────────────────────

// Translate the raw Polymarket relayer/CLOB SDK error string into a
// user-facing message. The SDKs throw `new Error(JSON.stringify({
// error, status, statusText, data }))` from their axios catch blocks,
// which is fine for ops but useless in a toast. We parse the payload
// and turn the most common failure modes into something the operator
// can actually act on.
//
// IMPORTANT: 401 "invalid authorization" from relayer-v2.polymarket.com
// almost always means the POLY_BUILDER_API_KEY/SECRET/PASSPHRASE on the
// running deployment don't match the builder account on Polymarket's
// side. We have verified locally (with the Replit secret values) that
// the same code path successfully deploys a Safe and signs the HMAC,
// so a 401 in production strongly suggests the secrets on the deploy
// platform (Render, etc.) are stale or different — not a code bug.
function humanizeRelayerError(rawMsg: string, stepLabel: string): string {
  let parsed: any = null
  try { parsed = JSON.parse(rawMsg) } catch { /* not JSON */ }

  if (parsed && typeof parsed === 'object' && (parsed.status || parsed.error)) {
    const status = Number(parsed.status) || 0
    const innerErr =
      (parsed.data && (parsed.data.error || parsed.data.message)) ||
      parsed.statusText ||
      parsed.error ||
      ''

    if (status === 401 || /invalid authorization/i.test(String(innerErr))) {
      return (
        `${stepLabel} failed: Polymarket relayer returned 401 (invalid authorization). ` +
        `This means the POLY_BUILDER_API_KEY / POLY_BUILDER_SECRET / POLY_BUILDER_PASSPHRASE ` +
        `secrets on this server do not match the builder account on Polymarket. ` +
        `Verify those env vars match exactly the values issued by Polymarket and redeploy.`
      )
    }
    if (status === 403) {
      return (
        `${stepLabel} failed: Polymarket blocked the request (403). ` +
        `This is usually a region restriction (try without VPN) or the builder ` +
        `account has been disabled. If you are on the operator side, check that ` +
        `POLY_BUILDER_* secrets are not for a revoked builder.`
      )
    }
    if (status === 429) {
      return `${stepLabel} failed: Polymarket rate-limited the request (429). Wait a moment and try again.`
    }
    if (status >= 500) {
      return `${stepLabel} failed: Polymarket relayer is having issues (${status}). Try again in a moment.`
    }
    if (status >= 400) {
      return `${stepLabel} failed: Polymarket rejected the request (${status}${innerErr ? ` — ${innerErr}` : ''}).`
    }
    if (parsed.error === 'connection error') {
      return `${stepLabel} failed: could not reach Polymarket relayer (network error). Try again.`
    }
  }

  // Not a JSON SDK error — surface raw, truncated.
  return `${stepLabel} failed: ${rawMsg}`
}

// Tiny helper: write a polymarket-tagged brain-feed log row. AgentLog has
// a hard FK to Agent so we can only log when there's a real agentId
// (Phase 3 autonomous path). Manual user trades just write a console line
// and rely on the PolymarketPosition row itself as the audit trail —
// the mini-app's positions panel surfaces them directly without going
// through the brain-feed.
async function logPolymarketEvent(opts: {
  userId:    string
  agentId?:  string
  action:    string  // 'order_placed' | 'order_failed' | 'wallet_setup' | 'agent_decision'
  reason:    string
  pair?:     string
  price?:    number
  reasoning?: string
}) {
  if (!opts.agentId) {
    console.log(`[POLY] ${opts.action} user=${opts.userId} ${opts.reason}`)
    return
  }
  try {
    await db.agentLog.create({
      data: {
        agentId:         opts.agentId,
        userId:          opts.userId,
        action:          opts.action,
        rawResponse:     null,
        parsedAction:    null,
        executionResult: opts.action,
        error:           null,
        pair:            opts.pair ?? null,
        price:           opts.price ?? null,
        reason:          opts.reason,
        adx:             null,
        rsi:             null,
        score:           null,
        regime:          null,
        exchange:        'polymarket',
      },
    })
  } catch (err) {
    console.warn('[API] logPolymarketEvent failed:', (err as Error).message)
  }
}

// ── /api/fourmeme/* — Module 1 (existing-token trading) ─────────────
//
// All endpoints check FOUR_MEME_ENABLED at the top and 503 with a
// structured code when the flag is off. Behaviour with the flag unset
// (the production default) is identical to the feature not existing
// at all — no new attack surface, no new error paths in clients that
// don't know about four.meme yet.
app.get('/api/fourmeme/token/:address', async (req, res) => {
  try {
    const { isFourMemeEnabled, getTokenInfo, quoteBuyByBnb, quoteSell } =
      await import('./services/fourMemeTrading')
    if (!isFourMemeEnabled()) return res.status(503).json({ ok: false, code: 'FOUR_MEME_DISABLED' })
    const addr = String(req.params.address ?? '')
    // Try four.meme first, fall back to PancakeSwap V2 for arbitrary
    // BSC tokens (CAKE, BONK, etc.) so the in-app trade UI works on
    // anything with PCS liquidity, not just four.meme launches.
    let info: any
    let isFallback = false
    try {
      info = await getTokenInfo(addr)
    } catch (e: any) {
      const { pancakeGetTokenInfo } = await import('./services/pancakeSwapTrading')
      info = await pancakeGetTokenInfo(addr)
      isFallback = true
      // Pad missing four.meme fields so the wire format stays uniform.
      info.minTradingFeeWei = 0n
      info.offersWei = 0n
      info.maxOffersWei = 0n
      info.fundsWei = 0n
      info.maxFundsWei = 0n
      info.fillPct = 1
    }
    void isFallback
    // Always enrich with ERC20 metadata. The four.meme bonding-curve
    // helper doesn't return name/symbol/decimals, so without this the
    // mini-app would render "$TOKEN" for every graduated four.meme
    // token. Reading name/symbol is best-effort — some tokens use
    // bytes32 or omit the call entirely; we silently keep whatever
    // value the caller-side path already set.
    try {
      const { ethers } = await import('ethers')
      const { buildBscProvider } = await import('./services/bscProvider')
      const erc20 = new ethers.Contract(addr, [
        'function name() view returns (string)',
        'function symbol() view returns (string)',
        'function decimals() view returns (uint8)',
      ], buildBscProvider(process.env.BSC_RPC_URL))
      if (!info.name)     { try { info.name     = String(await erc20.name()) }     catch {} }
      if (!info.symbol)   { try { info.symbol   = String(await erc20.symbol()) }   catch {} }
      if (info.decimals == null) { try { info.decimals = Number(await erc20.decimals()) } catch {} }
    } catch { /* network glitch — fall through without metadata */ }
    // Optional pre-trade quotes when caller supplies amounts. When the
    // token has graduated to PancakeSwap the bonding-curve helper would
    // throw `GRADUATED` (and revert on-chain), so we transparently route
    // both quote and trade through the PancakeSwap V2 router instead —
    // keeps the API surface identical to the mini-app.
    const bnb = req.query.bnb ? String(req.query.bnb) : ''
    const sell = req.query.sell ? String(req.query.sell) : ''
    const out: any = {
      ok: true,
      info: {
        ...info,
        lastPriceWei: info.lastPriceWei.toString(),
        minTradingFeeWei: info.minTradingFeeWei.toString(),
        offersWei: info.offersWei.toString(),
        maxOffersWei: info.maxOffersWei.toString(),
        fundsWei: info.fundsWei.toString(),
        maxFundsWei: info.maxFundsWei.toString(),
      },
      venue: info.graduatedToPancake ? 'pancakeV2' : 'fourMemeCurve',
    }
    if (bnb) {
      const { ethers } = await import('ethers')
      const bnbWei = ethers.parseEther(bnb)
      if (info.graduatedToPancake) {
        const { pancakeQuoteBuy } = await import('./services/pancakeSwapTrading')
        const q = await pancakeQuoteBuy(addr, bnbWei)
        out.buyQuote = {
          estimatedAmountWei: q.estimatedAmountWei.toString(),
          amountMsgValueWei:  q.amountInWei.toString(),
        }
      } else {
        const q = await quoteBuyByBnb(addr, bnbWei)
        out.buyQuote = {
          estimatedAmountWei: q.estimatedAmountWei.toString(),
          estimatedCostWei:   q.estimatedCostWei.toString(),
          estimatedFeeWei:    q.estimatedFeeWei.toString(),
          amountMsgValueWei:  q.amountMsgValueWei.toString(),
          amountFundsWei:     q.amountFundsWei.toString(),
        }
      }
    }
    if (sell) {
      const { ethers } = await import('ethers')
      const tokensWei = ethers.parseUnits(sell, 18)
      if (info.graduatedToPancake) {
        const { pancakeQuoteSell } = await import('./services/pancakeSwapTrading')
        const q = await pancakeQuoteSell(addr, tokensWei)
        out.sellQuote = { fundsWei: q.estimatedBnbWei.toString(), feeWei: '0' }
      } else {
        const q = await quoteSell(addr, tokensWei)
        out.sellQuote = { fundsWei: q.fundsWei.toString(), feeWei: q.feeWei.toString() }
      }
    }
    res.json(out)
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message ?? String(err), code: err?.code })
  }
})

// GET /api/fourmeme/wallet-balance/:tokenAddress
// Returns the caller's BSC wallet BNB balance + the ERC20 balance of
// the given token. Used by the mini-app trade modal to power "Max"
// pre-fill on the amount input. Read-only, no signing.
app.get('/api/fourmeme/wallet-balance/:tokenAddress', requireTgUser, async (req, res) => {
  const user = (req as any).user
  if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })
  try {
    const { isFourMemeEnabled, loadUserBscPrivateKey } = await import('./services/fourMemeTrading')
    if (!isFourMemeEnabled()) return res.status(503).json({ ok: false, code: 'FOUR_MEME_DISABLED' })
    const { ethers } = await import('ethers')
    const { buildBscProvider } = await import('./services/bscProvider')
    const tokenAddress = ethers.getAddress(String(req.params.tokenAddress))
    const { address } = await loadUserBscPrivateKey(user.id)
    const provider = buildBscProvider(process.env.BSC_RPC_URL)
    const erc20 = new ethers.Contract(
      tokenAddress,
      ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'],
      provider,
    )
    let bnbWei = 0n, tokenWei = 0n, decimals = 18, errs: string[] = []
    try { bnbWei = await provider.getBalance(address) } catch (e: any) { errs.push(`bnb:${e?.shortMessage ?? e?.message}`) }
    try { tokenWei = await erc20.balanceOf(address) } catch (e: any) { errs.push(`token:${e?.shortMessage ?? e?.message}`) }
    try { decimals = Number(await erc20.decimals()) } catch { /* keep 18 */ }
    res.json({
      ok: true,
      address,
      bnbWei: bnbWei.toString(),
      bnbBalance: ethers.formatEther(bnbWei),
      tokenWei: tokenWei.toString(),
      tokenBalance: ethers.formatUnits(tokenWei, decimals),
      tokenDecimals: decimals,
      error: errs.length ? errs.join('; ') : null,
    })
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message ?? String(err) })
  }
})

// Demo Day — Portfolio "Token Bags" parity for tokens the user
// TRADED (not just launched). Records every successful manual buy
// into four_meme_holdings so /api/fourmeme/positions can UNION it
// with token_launches and surface the bag in the mini-app. Best-
// effort: a failure here MUST NOT roll back the on-chain tx the
// user already paid gas for, so we log and swallow. Token name +
// symbol are read via ERC20 metadata so the UI has something
// human-readable; on failure they stay null and the UI falls back
// to the truncated address.
async function recordFourMemeHoldingBuy(opts: {
  userId: string
  tokenAddress: string
  bnbAmount: string | number
  txHash: string
}): Promise<void> {
  try {
    const addr = String(opts.tokenAddress).toLowerCase()
    const { ethers } = await import('ethers')
    const { buildBscProvider } = await import('./services/bscProvider')
    const provider = buildBscProvider(process.env.BSC_RPC_URL)
    const ERC20 = [
      'function name() view returns (string)',
      'function symbol() view returns (string)',
    ]
    let name: string | null = null
    let symbol: string | null = null
    try {
      const c = new ethers.Contract(addr, ERC20, provider)
      const [n, s] = await Promise.all([c.name(), c.symbol()])
      name = String(n).slice(0, 80)
      symbol = String(s).slice(0, 20)
    } catch {
      // Non-standard ERC20 (very rare for four.meme tokens); the row
      // still upserts with name/symbol = null.
    }
    // Tx-level idempotency: if the SAME txHash already lives in
    // last_action_tx (or first_buy_tx for the very first call), the
    // ON CONFLICT branch becomes a no-op via the WHERE clause. Without
    // this an accidental double-call (client retry, /buy retried by the
    // user after a slow response) would double-count total_bnb_in for
    // a single on-chain action.
    await db.$executeRawUnsafe(
      `INSERT INTO "four_meme_holdings"
         ("user_id","token_address","token_name","token_symbol",
          "first_buy_tx","last_action_tx","total_bnb_in","total_bnb_out",
          "first_buy_at","last_action_at")
       VALUES ($1,$2,$3,$4,$5,$5,$6,'0',NOW(),NOW())
       ON CONFLICT ("user_id","token_address")
       DO UPDATE SET
         "total_bnb_in" = (COALESCE(NULLIF("four_meme_holdings"."total_bnb_in",''),'0')::NUMERIC
                           + EXCLUDED."total_bnb_in"::NUMERIC)::TEXT,
         "last_action_tx" = EXCLUDED."last_action_tx",
         "last_action_at" = NOW(),
         "token_name"   = COALESCE("four_meme_holdings"."token_name",   EXCLUDED."token_name"),
         "token_symbol" = COALESCE("four_meme_holdings"."token_symbol", EXCLUDED."token_symbol")
         WHERE "four_meme_holdings"."last_action_tx" IS DISTINCT FROM EXCLUDED."last_action_tx"
           AND "four_meme_holdings"."first_buy_tx"   IS DISTINCT FROM EXCLUDED."last_action_tx"`,
      opts.userId, addr, name, symbol, opts.txHash, String(opts.bnbAmount),
    )
  } catch (err: any) {
    console.warn('[fourmeme] recordHoldingBuy failed:', err?.message ?? err)
  }
}
async function recordFourMemeHoldingSell(opts: {
  userId: string
  tokenAddress: string
  bnbProceeds: string | number
  txHash: string
}): Promise<void> {
  try {
    const addr = String(opts.tokenAddress).toLowerCase()
    // UPDATE-only: if there's no holdings row (user sold a token they
    // never bought via us — e.g. they launched it, or transferred in),
    // do nothing. Launches still get their proceeds tracked via the
    // existing token_launches.sold_proceeds_bnb column.
    // Tx-level idempotency: skip if last_action_tx already equals the
    // incoming sell tx (accidental retry of the same on-chain action).
    await db.$executeRawUnsafe(
      `UPDATE "four_meme_holdings"
          SET "total_bnb_out" = (COALESCE(NULLIF("total_bnb_out",''),'0')::NUMERIC + $3::NUMERIC)::TEXT,
              "last_action_tx" = $4,
              "last_action_at" = NOW()
        WHERE "user_id" = $1 AND "token_address" = $2
          AND "last_action_tx" IS DISTINCT FROM $4`,
      opts.userId, addr, String(opts.bnbProceeds), opts.txHash,
    )
  } catch (err: any) {
    console.warn('[fourmeme] recordHoldingSell failed:', err?.message ?? err)
  }
}

app.post('/api/fourmeme/buy', requireTgUser, async (req, res) => {
  const user = (req as any).user
  if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })
  try {
    const { isFourMemeEnabled, buyTokenWithBnb, loadUserBscPrivateKey, getTokenInfo } =
      await import('./services/fourMemeTrading')
    if (!isFourMemeEnabled()) return res.status(503).json({ ok: false, code: 'FOUR_MEME_DISABLED' })
    const { tokenAddress, bnbAmount, slippageBps } = req.body ?? {}
    if (!tokenAddress || !bnbAmount) return res.status(400).json({ ok: false, error: 'tokenAddress + bnbAmount required' })
    const { ethers } = await import('ethers')
    const bnbWei = ethers.parseEther(String(bnbAmount))
    const { privateKey } = await loadUserBscPrivateKey(user.id)
    // Auto-route post-migration tokens through PancakeSwap V2 so the
    // mini-app can call this single endpoint regardless of venue.
    // For arbitrary PCS-only tokens (non-four.meme), getTokenInfo
    // throws — we synthesize a graduated-style info via the PCS
    // helper so the same routing works.
    let info: any
    try { info = await getTokenInfo(String(tokenAddress)) }
    catch {
      const { pancakeGetTokenInfo } = await import('./services/pancakeSwapTrading')
      info = await pancakeGetTokenInfo(String(tokenAddress))
    }
    if (info.graduatedToPancake) {
      const { pancakeBuyTokenWithBnb } = await import('./services/pancakeSwapTrading')
      const result = await pancakeBuyTokenWithBnb(privateKey, String(tokenAddress), bnbWei, {
        slippageBps: slippageBps != null ? Number(slippageBps) : undefined,
      })
      // Demo Day — Portfolio "Token Bags" parity: track this manual
      // buy in four_meme_holdings so it shows up alongside launches.
      // Uses the actual BNB spent (post-slippage) for accurate PnL.
      await recordFourMemeHoldingBuy({
        userId: user.id,
        tokenAddress: String(tokenAddress),
        bnbAmount: Number(ethers.formatEther(result.bnbSpentWei)),
        txHash: result.txHash,
      })
      return res.json({
        ok: true, venue: result.venue,
        txHash: result.txHash,
        tokenAddress: result.tokenAddress,
        bnbSpentWei: result.bnbSpentWei.toString(),
        estimatedTokensWei: result.estimatedTokensWei.toString(),
        minTokensWei: result.minTokensWei.toString(),
        slippageBps: result.slippageBps,
      })
    }
    const result = await buyTokenWithBnb(privateKey, String(tokenAddress), bnbWei, {
      slippageBps: slippageBps != null ? Number(slippageBps) : undefined,
    })
    await recordFourMemeHoldingBuy({
      userId: user.id,
      tokenAddress: String(tokenAddress),
      bnbAmount: Number(ethers.formatEther(result.bnbSpentWei)),
      txHash: result.txHash,
    })
    res.json({
      ok: true, venue: 'fourMemeCurve',
      txHash: result.txHash,
      tokenAddress: result.tokenAddress,
      bnbSpentWei: result.bnbSpentWei.toString(),
      estimatedTokensWei: result.estimatedTokensWei.toString(),
      minTokensWei: result.minTokensWei.toString(),
      slippageBps: result.slippageBps,
    })
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message ?? String(err), code: err?.code })
  }
})

app.post('/api/fourmeme/sell', requireTgUser, async (req, res) => {
  const user = (req as any).user
  if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })
  try {
    const { isFourMemeEnabled, sellTokenForBnb, loadUserBscPrivateKey, getTokenInfo } =
      await import('./services/fourMemeTrading')
    if (!isFourMemeEnabled()) return res.status(503).json({ ok: false, code: 'FOUR_MEME_DISABLED' })
    const { tokenAddress, tokenAmount, slippageBps } = req.body ?? {}
    if (!tokenAddress || !tokenAmount) return res.status(400).json({ ok: false, error: 'tokenAddress + tokenAmount required' })
    const { ethers } = await import('ethers')
    const tokensWei = ethers.parseUnits(String(tokenAmount), 18)
    const { privateKey } = await loadUserBscPrivateKey(user.id)
    // Fallback to a PCS-synthesized info for non-four.meme tokens.
    let info: any
    try { info = await getTokenInfo(String(tokenAddress)) }
    catch {
      const { pancakeGetTokenInfo } = await import('./services/pancakeSwapTrading')
      info = await pancakeGetTokenInfo(String(tokenAddress))
    }
    if (info.graduatedToPancake) {
      const { pancakeSellTokenForBnb } = await import('./services/pancakeSwapTrading')
      const result = await pancakeSellTokenForBnb(privateKey, String(tokenAddress), tokensWei, {
        slippageBps: slippageBps != null ? Number(slippageBps) : undefined,
      })
      // Track proceeds in four_meme_holdings if we have a row for
      // this (user, token). Uses the EXPECTED bnb (estimatedBnbWei
      // pre-slippage) — exact actual is only knowable from the tx
      // receipt parse which is too slow to await synchronously here.
      await recordFourMemeHoldingSell({
        userId: user.id,
        tokenAddress: String(tokenAddress),
        bnbProceeds: Number(ethers.formatEther(result.estimatedBnbWei)),
        txHash: result.txHash,
      })
      return res.json({
        ok: true, venue: result.venue,
        txHash: result.txHash,
        approvalTxHash: result.approvalTxHash,
        tokenAddress: result.tokenAddress,
        tokensSoldWei: result.tokensSoldWei.toString(),
        estimatedBnbWei: result.estimatedBnbWei.toString(),
        minBnbWei: result.minBnbWei.toString(),
        slippageBps: result.slippageBps,
      })
    }
    const result = await sellTokenForBnb(privateKey, String(tokenAddress), tokensWei, {
      slippageBps: slippageBps != null ? Number(slippageBps) : undefined,
    })
    await recordFourMemeHoldingSell({
      userId: user.id,
      tokenAddress: String(tokenAddress),
      bnbProceeds: Number(ethers.formatEther(result.estimatedBnbWei)),
      txHash: result.txHash,
    })
    res.json({
      ok: true, venue: 'fourMemeCurve',
      txHash: result.txHash,
      tokenAddress: result.tokenAddress,
      tokensSoldWei: result.tokensSoldWei.toString(),
      estimatedBnbWei: result.estimatedBnbWei.toString(),
      minBnbWei: result.minBnbWei.toString(),
      slippageBps: result.slippageBps,
    })
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message ?? String(err), code: err?.code })
  }
})

// GET /api/fourmeme/launch — feature-flag probe so the mini-app can
// hide the "Launch token" entry point when either FOUR_MEME_ENABLED or
// FOUR_MEME_LAUNCH_ENABLED is off, without having to attempt a real
// launch and parse the 503. Cheap, public (no requireTgUser): the
// answer is identical for every user and only reflects an env flag.
app.get('/api/fourmeme/launch', async (_req, res) => {
  try {
    const { isFourMemeLaunchEnabled } = await import('./services/fourMemeLaunch')
    res.json({ ok: true, enabled: isFourMemeLaunchEnabled() })
  } catch (err: any) {
    res.status(500).json({ ok: false, enabled: false, error: err?.message ?? String(err) })
  }
})

// POST /api/fourmeme/launch — Module 3 token creation. Body:
//   {
//     tokenName: string,
//     tokenSymbol: string,
//     tokenDescription?: string,
//     initialBuyBnb?: string,        // decimal BNB; default "0"
//     imageBase64?: string,          // bare base64 OR data:image/...;base64,...
//     imageUrl?: string,             // pre-uploaded CDN URL (skip upload)
//     webUrl?: string, twitterUrl?: string, telegramUrl?: string,
//   }
// Response: { ok, txHash, tokenAddress, launchUrl, initialBuyBnb, imageUrl, walletAddress }
// Per-route 6MB body parser so the documented 5MB image cap is
// actually reachable (the global app.use(express.json()) at the top
// of this file uses the default ~100KB limit). 6MB raw JSON
// comfortably accommodates a 5MB image after base64 inflation.
app.post('/api/fourmeme/launch', express.json({ limit: '6mb' }), requireTgUser, async (req, res) => {
  const user = (req as any).user
  if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })
  try {
    const { isFourMemeLaunchEnabled, launchFourMemeTokenForUser, LaunchValidationError } =
      await import('./services/fourMemeLaunch')
    if (!isFourMemeLaunchEnabled()) {
      return res.status(503).json({ ok: false, code: 'FOUR_MEME_LAUNCH_DISABLED' })
    }
    const body = req.body ?? {}
    let imageBuffer: Buffer | undefined
    if (typeof body.imageBase64 === 'string' && body.imageBase64.length > 0) {
      const stripped = body.imageBase64.replace(/^data:image\/[a-zA-Z+]+;base64,/, '')
      // Strict base64 check — Buffer.from is permissive and silently
      // drops bad chars, so we validate first.
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(stripped) || stripped.length % 4 !== 0) {
        return res.status(400).json({ ok: false, error: 'invalid imageBase64' })
      }
      try {
        imageBuffer = Buffer.from(stripped, 'base64')
      } catch {
        return res.status(400).json({ ok: false, error: 'invalid imageBase64' })
      }
      if (imageBuffer.length === 0) {
        return res.status(400).json({ ok: false, error: 'invalid imageBase64' })
      }
      if (imageBuffer.length > 5 * 1024 * 1024) {
        return res.status(400).json({ ok: false, error: 'image larger than 5MB' })
      }
    }
    try {
      const result = await launchFourMemeTokenForUser(user.id, {
        tokenName: String(body.tokenName ?? ''),
        tokenSymbol: String(body.tokenSymbol ?? ''),
        tokenDescription: body.tokenDescription ? String(body.tokenDescription) : undefined,
        initialBuyBnb: body.initialBuyBnb != null ? String(body.initialBuyBnb) : '0',
        imageBuffer,
        imageUrl: body.imageUrl ? String(body.imageUrl) : undefined,
        webUrl: body.webUrl ? String(body.webUrl) : undefined,
        twitterUrl: body.twitterUrl ? String(body.twitterUrl) : undefined,
        telegramUrl: body.telegramUrl ? String(body.telegramUrl) : undefined,
      })
      res.json({ ok: true, ...result })
    } catch (inner: any) {
      if (inner instanceof LaunchValidationError) {
        return res.status(400).json({ ok: false, error: inner.message, code: inner.code })
      }
      throw inner
    }
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message ?? String(err), code: err?.code })
  }
})

// GET /api/fourmeme/launches — caller's last ~20 launch attempts from
// the runtime-managed `token_launches` table. Auth-gated to the calling
// Telegram user; rows are filtered to user_id = caller, so users can
// only ever see their own history. Returns rows ordered newest-first
// with everything the bot/mini-app need to render (status, tx_hash,
// token_address, four.meme launchUrl, error_message). Tolerates the
// table being entirely absent (fresh local dev) by returning [].
app.get('/api/fourmeme/launches', requireTgUser, async (req, res) => {
  const user = (req as any).user
  if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })
  try {
    // Surface long-pending rows as 'stale' before reading so the
    // mini-app/bot can show them as retryable instead of confusing the
    // user with a forever-spinning ⏳ pill.
    try {
      const { markUserPendingStale } = await import('./services/fourMemeLaunch')
      await markUserPendingStale(user.id)
    } catch {
      /* sweeper is best-effort, never block the read */
    }
    // Parameterized via Prisma's tagged-template $queryRaw — ${user.id}
    // is bound as a SQL parameter, not interpolated.
    const rows = await db.$queryRaw<Array<{
      id: string
      token_name: string
      token_symbol: string
      token_address: string | null
      tx_hash: string | null
      launch_url: string | null
      image_url: string | null
      initial_liquidity_bnb: string | null
      status: string
      error_message: string | null
      created_at: Date
    }>>`
      SELECT "id","token_name","token_symbol","token_address","tx_hash",
             "launch_url","image_url","initial_liquidity_bnb","status",
             "error_message","created_at"
        FROM "token_launches"
       WHERE "user_id" = ${user.id}
       ORDER BY "created_at" DESC
       LIMIT 20
    `
    const launches = rows.map((r) => ({
      id: r.id,
      tokenName: r.token_name,
      tokenSymbol: r.token_symbol,
      tokenAddress: r.token_address,
      txHash: r.tx_hash,
      launchUrl:
        r.launch_url ??
        (r.token_address ? `https://four.meme/token/${r.token_address}` : null),
      bscScanUrl: r.tx_hash ? `https://bscscan.com/tx/${r.tx_hash}` : null,
      imageUrl: r.image_url,
      initialBuyBnb: r.initial_liquidity_bnb,
      status: r.status,
      errorMessage: r.error_message,
      createdAt: r.created_at instanceof Date
        ? r.created_at.toISOString()
        : new Date(r.created_at as any).toISOString(),
    }))
    res.json({ ok: true, launches })
  } catch (err: any) {
    // Missing table (fresh dev DB without ensureTables having run) → []
    const msg = String(err?.message ?? err)
    if (/relation .*token_launches.* does not exist/i.test(msg)) {
      return res.json({ ok: true, launches: [] })
    }
    res.status(400).json({ ok: false, error: msg, code: err?.code })
  }
})

// GET /api/fourmeme/positions — enriched view of every four.meme bag
// the caller has touched (launched, currently held, or sold). Joins
// `token_launches` (canonical "user has touched this token" record)
// with on-chain reads: live ERC20 balanceOf at the user's BSC wallet
// + bonding-curve quoteSell so the mini-app's Portfolio tab can show
// each bag with its current BNB value and unrealised PnL alongside
// the realised PnL on already-sold rows. Per-row enrichment failures
// degrade to a balance/value of null with `error` populated, so a
// single graduated/V1 token can never blank the whole list.
app.get('/api/fourmeme/positions', requireTgUser, async (req, res) => {
  const user = (req as any).user
  if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })
  try {
    const { ethers } = await import('ethers')
    const { buildBscProvider } = await import('./services/bscProvider')
    const { quoteSell, loadUserBscPrivateKey } = await import('./services/fourMemeTrading')
    const provider = buildBscProvider(process.env.BSC_RPC_URL)
    let walletAddress: string | null = null
    try {
      const c = await loadUserBscPrivateKey(user.id)
      walletAddress = c.address
    } catch {
      // No wallet → still return the launches list (without on-chain
      // enrichment) so the user at least sees their launch history.
    }
    // Demo Day — Portfolio "Token Bags" sources two tables:
    //   1. token_launches: tokens the user (or their agent) LAUNCHED
    //   2. four_meme_holdings: tokens the user TRADED (manual buys
    //      via /api/fourmeme/buy)
    // Both are SELECTed here, then merged in JS with launches winning
    // any duplicate (a launch is the richer record). Final list is
    // sorted by recency (launch.created_at vs holding.last_action_at).
    type LaunchRow = {
      id: string
      token_name: string
      token_symbol: string
      token_address: string | null
      tx_hash: string | null
      launch_url: string | null
      image_url: string | null
      initial_liquidity_bnb: string | null
      status: string
      sold_at: Date | null
      sold_proceeds_bnb: string | null
      sold_tx_hash: string | null
      created_at: Date
    }
    const launchRows = await db.$queryRaw<LaunchRow[]>`
      SELECT "id","token_name","token_symbol","token_address","tx_hash",
             "launch_url","image_url","initial_liquidity_bnb","status",
             "sold_at","sold_proceeds_bnb","sold_tx_hash","created_at"
        FROM "token_launches"
       WHERE "user_id" = ${user.id}
         AND "token_address" IS NOT NULL
       ORDER BY "created_at" DESC
       LIMIT 50
    `
    type HoldingRow = {
      id: string
      token_name: string | null
      token_symbol: string | null
      token_address: string
      first_buy_tx: string | null
      last_action_tx: string | null
      total_bnb_in: string
      total_bnb_out: string
      first_buy_at: Date
      last_action_at: Date
    }
    let holdingRows: HoldingRow[] = []
    try {
      holdingRows = await db.$queryRaw<HoldingRow[]>`
        SELECT "id","token_name","token_symbol","token_address",
               "first_buy_tx","last_action_tx",
               "total_bnb_in","total_bnb_out",
               "first_buy_at","last_action_at"
          FROM "four_meme_holdings"
         WHERE "user_id" = ${user.id}
         ORDER BY "last_action_at" DESC
         LIMIT 50
      `
    } catch (e: any) {
      // Table may not exist yet on a freshly-deployed DB before
      // ensureTables runs — degrade silently to launches-only.
      if (!/relation .*four_meme_holdings.* does not exist/i.test(String(e?.message ?? e))) {
        console.warn('[fourmeme/positions] holdings query failed:', e?.message ?? e)
      }
    }
    // Merge: launches win on duplicate token_address (lowercased).
    const launchAddrs = new Set(
      launchRows.map((r) => (r.token_address ?? '').toLowerCase()).filter(Boolean),
    )
    type Row =
      | { kind: 'launch'; r: LaunchRow }
      | { kind: 'buy'; r: HoldingRow }
    const rows: Row[] = [
      ...launchRows.map((r) => ({ kind: 'launch' as const, r })),
      ...holdingRows
        .filter((h) => !launchAddrs.has(h.token_address.toLowerCase()))
        .map((r) => ({ kind: 'buy' as const, r })),
    ]
    rows.sort((a, b) => {
      const ta = a.kind === 'launch'
        ? (a.r.created_at instanceof Date ? a.r.created_at.getTime() : new Date(a.r.created_at as any).getTime())
        : (a.r.last_action_at instanceof Date ? a.r.last_action_at.getTime() : new Date(a.r.last_action_at as any).getTime())
      const tb = b.kind === 'launch'
        ? (b.r.created_at instanceof Date ? b.r.created_at.getTime() : new Date(b.r.created_at as any).getTime())
        : (b.r.last_action_at instanceof Date ? b.r.last_action_at.getTime() : new Date(b.r.last_action_at as any).getTime())
      return tb - ta
    })
    const ERC20 = ['function balanceOf(address) view returns (uint256)']
    const positions = await Promise.all(rows.map(async (row) => {
      // Normalize the two row kinds into a single working shape so the
      // on-chain enrichment block stays simple. For "buy" rows we
      // synthesize: status='bought', sold flag derives from whether the
      // current balance is zero (computed below), entryBnb = total_bnb_in,
      // proceedsBnb = total_bnb_out (used only when balance==0 to flag
      // realised PnL on a fully-exited bag).
      const isLaunch = row.kind === 'launch'
      const r = row.r
      const tokenAddr = (isLaunch ? (r as LaunchRow).token_address : (r as HoldingRow).token_address) as string
      const tokenName  = isLaunch ? (r as LaunchRow).token_name   : ((r as HoldingRow).token_name   ?? `${tokenAddr.slice(0, 6)}…${tokenAddr.slice(-4)}`)
      const tokenSym   = isLaunch ? (r as LaunchRow).token_symbol : ((r as HoldingRow).token_symbol ?? '')
      const imageUrl   = isLaunch ? (r as LaunchRow).image_url    : null
      const launchUrl  = (isLaunch ? (r as LaunchRow).launch_url : null) ?? `https://four.meme/token/${tokenAddr}`
      const txHash     = isLaunch ? (r as LaunchRow).tx_hash      : (r as HoldingRow).first_buy_tx
      const sellTxHash = isLaunch ? (r as LaunchRow).sold_tx_hash : (r as HoldingRow).last_action_tx
      const status     = isLaunch ? (r as LaunchRow).status       : 'bought'
      const createdAt  = isLaunch ? (r as LaunchRow).created_at   : (r as HoldingRow).first_buy_at
      const entryBnb   = isLaunch
        ? ((r as LaunchRow).initial_liquidity_bnb ? Number((r as LaunchRow).initial_liquidity_bnb) : null)
        : Number((r as HoldingRow).total_bnb_in)
      // Sold detection differs by source:
      //  - launches: explicit sold_at column (set by the autonomous TP
      //    sweep or manual sell that wrote sold_at)
      //  - buys: there's no explicit "fully exited" flag. We mark it as
      //    sold only if total_bnb_out > 0 AND the live balance comes
      //    back as 0 below; until then we treat it as held.
      let sold = isLaunch ? !!(r as LaunchRow).sold_at : false
      const buyOutBnb = isLaunch ? null : Number((r as HoldingRow).total_bnb_out)
      const launchProceedsBnb = isLaunch
        ? ((r as LaunchRow).sold_proceeds_bnb ? Number((r as LaunchRow).sold_proceeds_bnb) : null)
        : null
      let proceedsBnb: number | null = launchProceedsBnb ?? (buyOutBnb && buyOutBnb > 0 ? buyOutBnb : null)
      const soldAtRaw: Date | null = isLaunch
        ? (r as LaunchRow).sold_at
        : (sellTxHash && buyOutBnb && buyOutBnb > 0 ? (r as HoldingRow).last_action_at : null)
      let balanceWei: bigint = 0n
      let balanceTokens: number | null = null
      let currentValueBnb: number | null = null
      let pnlBnb: number | null = null
      let pnlPct: number | null = null
      let enrichError: string | null = null
      if (sold) {
        // Realised: pnl is proceeds − entry, position is closed.
        if (proceedsBnb != null && entryBnb != null) {
          pnlBnb = proceedsBnb - entryBnb
          pnlPct = entryBnb > 0 ? (pnlBnb / entryBnb) * 100 : null
        }
      } else if (walletAddress) {
        try {
          const erc20 = new ethers.Contract(tokenAddr, ERC20, provider)
          balanceWei = BigInt(await erc20.balanceOf(walletAddress))
          balanceTokens = Number(ethers.formatUnits(balanceWei, 18))
          if (balanceWei > 0n) {
            try {
              const q = await quoteSell(tokenAddr, balanceWei)
              currentValueBnb = Number(ethers.formatEther(q.fundsWei))
              if (entryBnb != null) {
                // PnL math:
                //  - launches: simple unrealized = current − entry.
                //  - buys (moonbag-aware): TOTAL PnL = realized + unrealized
                //    = (prior_out − entry) + current_value
                //    = current_value + prior_out − entry
                //    This handles the "sold most, holds a moonbag" case
                //    (out > in) where clamping net entry to 0 would
                //    DROP the already-realized surplus. Pct uses the
                //    original entry as the cost basis denominator.
                if (isLaunch) {
                  pnlBnb = currentValueBnb - entryBnb
                  pnlPct = entryBnb > 0 ? (pnlBnb / entryBnb) * 100 : null
                } else {
                  pnlBnb = currentValueBnb + (buyOutBnb ?? 0) - entryBnb
                  pnlPct = entryBnb > 0 ? (pnlBnb / entryBnb) * 100 : null
                }
              }
            } catch (e: any) {
              // Curve quote failed — most likely token has graduated to
              // PCS (V1 sell unsafe / liquidity migrated). Surface so
              // the UI can hint "graduated, sell on PancakeSwap".
              enrichError = `quote: ${e?.shortMessage ?? e?.message ?? 'failed'}`.slice(0, 120)
            }
          } else if (!isLaunch && buyOutBnb && buyOutBnb > 0) {
            // Buy row, balance==0, and we have recorded sell proceeds
            // → treat as fully exited. Realised PnL = total_out − total_in.
            sold = true
            proceedsBnb = buyOutBnb
            if (entryBnb != null) {
              pnlBnb = buyOutBnb - entryBnb
              pnlPct = entryBnb > 0 ? (pnlBnb / entryBnb) * 100 : null
            }
          }
        } catch (e: any) {
          enrichError = `balance: ${e?.shortMessage ?? e?.message ?? 'rpc_failed'}`.slice(0, 120)
        }
      }
      return {
        id: r.id,
        tokenName,
        tokenSymbol: tokenSym,
        tokenAddress: tokenAddr,
        imageUrl,
        launchUrl,
        bscScanUrl: txHash ? `https://bscscan.com/tx/${txHash}` : null,
        sellTxHash,
        sellTxScanUrl: sellTxHash ? `https://bscscan.com/tx/${sellTxHash}` : null,
        status,
        source: isLaunch ? 'launch' as const : 'buy' as const,
        sold,
        soldAt: soldAtRaw ? soldAtRaw.toISOString() : null,
        entryBnb,
        balanceTokens,
        currentValueBnb,
        soldProceedsBnb: proceedsBnb,
        pnlBnb,
        pnlPct,
        createdAt: createdAt instanceof Date
          ? createdAt.toISOString()
          : new Date(createdAt as any).toISOString(),
        error: enrichError,
      }
    }))
    res.json({ ok: true, walletAddress, positions })
  } catch (err: any) {
    const msg = String(err?.message ?? err)
    if (/relation .*token_launches.* does not exist/i.test(msg)) {
      return res.json({ ok: true, walletAddress: null, positions: [] })
    }
    res.status(400).json({ ok: false, error: msg })
  }
})

// POST /api/fourmeme/retry — re-runs a previously-failed (or
// auto-marked stale) launch using the original tokenName / symbol /
// description / initialBuy / image from the row. Body: { launchId }.
// Auth-gated and ownership-checked inside retryLaunchForUser so users
// can only ever retry their own rows.
app.post('/api/fourmeme/retry', requireTgUser, async (req, res) => {
  const user = (req as any).user
  if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })
  try {
    const { isFourMemeLaunchEnabled, retryLaunchForUser, LaunchRetryError, LaunchValidationError } =
      await import('./services/fourMemeLaunch')
    if (!isFourMemeLaunchEnabled()) {
      return res.status(503).json({ ok: false, code: 'FOUR_MEME_LAUNCH_DISABLED' })
    }
    const launchId = String((req.body ?? {}).launchId ?? '')
    if (!launchId) {
      return res.status(400).json({ ok: false, error: 'launchId required' })
    }
    try {
      const result = await retryLaunchForUser(user.id, launchId)
      res.json({ ok: true, ...result })
    } catch (inner: any) {
      if (inner instanceof LaunchRetryError) {
        const status = inner.code === 'NOT_FOUND' ? 404 : inner.code === 'NOT_RETRYABLE' ? 409 : 400
        return res.status(status).json({ ok: false, error: inner.message, code: inner.code })
      }
      if (inner instanceof LaunchValidationError) {
        return res.status(400).json({ ok: false, error: inner.message, code: inner.code })
      }
      throw inner
    }
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message ?? String(err), code: err?.code })
  }
})

// Task #64 — per-agent toggle for the HITL launch approval flow. Kept
// separate from /api/agents/:id/settings (numeric-only) so we don't
// over-pack the existing schema with booleans. Idempotent: same value
// in == same value out.
// Demo Day toggle — flip the master per-agent four.meme launch
// switch from the mini-app. Mirror of /four-meme-approval but writes
// to the `fourMemeLaunchEnabled` column. When ON the agent enters
// the 60s tick loop and writes a brain-feed line every cycle (LAUNCH
// or SKIP with a verbose reason), so judges can watch it think live.
// Demo Day — set per-agent four.meme scan cadence in minutes (1..60).
// NULL or out-of-range falls back to the hardcoded MIN_TICK_INTERVAL_MS
// floor in src/agents/fourMemeLaunchAgent.ts.
app.patch('/api/agents/:id/four-meme-launch-interval', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })
    const agentId = String(req.params.id)
    const raw = req.body?.minutes
    let minutes: number | null = null
    if (raw === null || raw === undefined || raw === '') {
      minutes = null
    } else {
      const n = Number(raw)
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 60) {
        return res.status(400).json({ ok: false, error: 'minutes must be an integer 1..60 or null' })
      }
      minutes = n
    }
    const owner = await db.$queryRawUnsafe<Array<{ userId: string }>>(
      `SELECT "userId" FROM "Agent" WHERE "id" = $1 LIMIT 1`,
      agentId,
    )
    if (owner.length === 0) return res.status(404).json({ ok: false, error: 'agent not found' })
    if (owner[0].userId !== user.id) return res.status(403).json({ ok: false, error: 'forbidden' })
    await db.$executeRawUnsafe(
      `UPDATE "Agent" SET "fourMemeLaunchIntervalMinutes" = $1 WHERE "id" = $2`,
      minutes,
      agentId,
    )
    res.json({ ok: true, agentId, minutes })
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message ?? String(err) })
  }
})

// Demo Day — set per-agent initial dev-buy size in BNB. Decimal string,
// 0 < value ≤ 0.05 (MAX_INITIAL_BUY_BNB). NULL/empty falls back to
// "let the LLM propose, capped at 0.05 BNB". When set, the launch
// agent OVERRIDES the LLM's proposed buy with this exact amount.
app.patch('/api/agents/:id/four-meme-launch-initial-buy', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })
    const agentId = String(req.params.id)
    const raw = req.body?.bnb
    let bnb: string | null = null
    if (raw === null || raw === undefined || raw === '') {
      bnb = null
    } else {
      const s = String(raw).trim()
      const n = Number(s)
      if (!Number.isFinite(n) || n <= 0 || n > 0.05) {
        return res.status(400).json({ ok: false, error: 'bnb must be > 0 and ≤ 0.05, or null' })
      }
      // Re-stringify to canonical form (max 6 decimals matches LaunchParams).
      bnb = n.toFixed(6).replace(/\.?0+$/, '')
      if (bnb === '' || bnb === '0') bnb = '0.000001'
    }
    const owner = await db.$queryRawUnsafe<Array<{ userId: string }>>(
      `SELECT "userId" FROM "Agent" WHERE "id" = $1 LIMIT 1`,
      agentId,
    )
    if (owner.length === 0) return res.status(404).json({ ok: false, error: 'agent not found' })
    if (owner[0].userId !== user.id) return res.status(403).json({ ok: false, error: 'forbidden' })
    await db.$executeRawUnsafe(
      `UPDATE "Agent" SET "fourMemeLaunchInitialBuyBnb" = $1 WHERE "id" = $2`,
      bnb,
      agentId,
    )
    res.json({ ok: true, agentId, bnb })
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message ?? String(err) })
  }
})

// Demo Day — set per-agent auto-sell take-profit threshold in percent
// (1..10000). NULL = manual management (no autonomous exit ever).
// When set, the TP sweep liquidates the entire dev bag the moment
// curve sell-quote ≥ entry × (1 + pct/100). No stop-loss because a
// dev's first buy IS the bonding-curve floor.
app.patch('/api/agents/:id/four-meme-launch-take-profit', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })
    const agentId = String(req.params.id)
    const raw = req.body?.pct
    let pct: number | null = null
    if (raw === null || raw === undefined || raw === '') {
      pct = null
    } else {
      const n = Number(raw)
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 10000) {
        return res.status(400).json({ ok: false, error: 'pct must be an integer 1..10000 or null' })
      }
      pct = n
    }
    const owner = await db.$queryRawUnsafe<Array<{ userId: string }>>(
      `SELECT "userId" FROM "Agent" WHERE "id" = $1 LIMIT 1`,
      agentId,
    )
    if (owner.length === 0) return res.status(404).json({ ok: false, error: 'agent not found' })
    if (owner[0].userId !== user.id) return res.status(403).json({ ok: false, error: 'forbidden' })
    await db.$executeRawUnsafe(
      `UPDATE "Agent" SET "fourMemeLaunchTakeProfitPct" = $1 WHERE "id" = $2`,
      pct,
      agentId,
    )
    res.json({ ok: true, agentId, pct })
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message ?? String(err) })
  }
})

app.patch('/api/agents/:id/four-meme-launch-enabled', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })
    const agentId = String(req.params.id)
    const enabled = Boolean(req.body?.enabled)
    const owner = await db.$queryRawUnsafe<Array<{ userId: string }>>(
      `SELECT "userId" FROM "Agent" WHERE "id" = $1 LIMIT 1`,
      agentId,
    )
    if (owner.length === 0) return res.status(404).json({ ok: false, error: 'agent not found' })
    if (owner[0].userId !== user.id) return res.status(403).json({ ok: false, error: 'forbidden' })
    const updated = await db.$executeRawUnsafe(
      `UPDATE "Agent" SET "fourMemeLaunchEnabled" = $1 WHERE "id" = $2`,
      enabled,
      agentId,
    )
    // Demo Day diagnostics — log every toggle so we can grep Render
    // logs for "[fourMemeToggle]" and confirm the PATCH actually
    // reached this DB. Without this we have no way to tell apart
    // (a) toggle never reached the server vs (b) PATCH succeeded but
    // the sweep query disagrees vs (c) different DB on Render.
    // PII note: only log the last 4 digits of the Telegram ID. Full
    // telegramId in centralized Render logs would be a leak; the last
    // 4 are enough to correlate with the user when they ask "did my
    // toggle persist?" without exposing their account identifier.
    const tgTail = String(user.telegramId ?? '').slice(-4)
    console.log(
      `[fourMemeToggle] user=${user.id.slice(0, 8)} tg=…${tgTail} ` +
      `agent=${agentId.slice(0, 12)} enabled=${enabled} rowsAffected=${updated}`,
    )
    res.json({ ok: true, agentId, enabled, rowsAffected: Number(updated) })
  } catch (err: any) {
    console.error('[fourMemeToggle] PATCH failed:', err?.message ?? err)
    res.status(400).json({ ok: false, error: err?.message ?? String(err) })
  }
})

app.patch('/api/agents/:id/four-meme-approval', requireTgUser, async (req, res) => {
  try {
    const user = (req as any).user
    if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })
    const agentId = String(req.params.id)
    const requireApproval = Boolean(req.body?.requireApproval)
    // Verify ownership before the UPDATE to surface a clean 403/404.
    const owner = await db.$queryRawUnsafe<Array<{ userId: string }>>(
      `SELECT "userId" FROM "Agent" WHERE "id" = $1 LIMIT 1`,
      agentId,
    )
    if (owner.length === 0) return res.status(404).json({ ok: false, error: 'agent not found' })
    if (owner[0].userId !== user.id) return res.status(403).json({ ok: false, error: 'forbidden' })
    await db.$executeRawUnsafe(
      `UPDATE "Agent" SET "fourMemeLaunchRequiresApproval" = $1 WHERE "id" = $2`,
      requireApproval,
      agentId,
    )
    res.json({ ok: true, agentId, requireApproval })
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message ?? String(err) })
  }
})

// ── Task #64: HITL approval endpoints ────────────────────────────────
// Mini-app counterparts to the Telegram inline buttons. Every endpoint
// is requireTgUser-gated and the underlying service helpers re-check
// ownership against `user_id`, so a forged launchId can't escape the
// caller's own pending row.
app.get('/api/fourmeme/pending-approvals', requireTgUser, async (req, res) => {
  const user = (req as any).user
  if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })
  try {
    const rows = await db.$queryRaw<Array<{
      id: string
      agent_id: string | null
      token_name: string
      token_symbol: string
      token_description: string | null
      initial_liquidity_bnb: string | null
      metadata: string | null
      created_at: Date
    }>>`
      SELECT "id","agent_id","token_name","token_symbol","token_description",
             "initial_liquidity_bnb","metadata","created_at"
        FROM "token_launches"
       WHERE "user_id" = ${user.id}
         AND "status" = 'pending_user_approval'
       ORDER BY "created_at" DESC
       LIMIT 20
    `
    const pending = rows.map((r) => {
      let conviction: number | null = null
      let reasoning: string | null = null
      try {
        if (r.metadata) {
          const m = JSON.parse(r.metadata)
          if (typeof m?.conviction === 'number') conviction = m.conviction
          if (typeof m?.reasoning === 'string') reasoning = m.reasoning
        }
      } catch {}
      return {
        id: r.id,
        agentId: r.agent_id,
        tokenName: r.token_name,
        tokenSymbol: r.token_symbol,
        tokenDescription: r.token_description,
        initialBuyBnb: r.initial_liquidity_bnb,
        conviction,
        reasoning,
        createdAt: r.created_at instanceof Date
          ? r.created_at.toISOString()
          : new Date(r.created_at as any).toISOString(),
      }
    })
    res.json({ ok: true, pending })
  } catch (err: any) {
    const msg = String(err?.message ?? err)
    if (/relation .*token_launches.* does not exist/i.test(msg)) {
      return res.json({ ok: true, pending: [] })
    }
    res.status(400).json({ ok: false, error: msg })
  }
})

app.post('/api/fourmeme/approve', requireTgUser, async (req, res) => {
  const user = (req as any).user
  if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })
  try {
    const launchId = String(req.body?.launchId ?? '')
    if (!launchId) return res.status(400).json({ ok: false, error: 'launchId required' })
    const { executeApprovedLaunch, LaunchApprovalError } = await import('./services/fourMemeLaunch')
    try {
      const result = await executeApprovedLaunch({ launchId, userId: user.id })
      res.json({ ok: true, ...result })
    } catch (inner: any) {
      if (inner instanceof LaunchApprovalError) {
        const status = inner.code === 'NOT_FOUND' ? 404
                     : inner.code === 'FORBIDDEN' ? 403
                     : 409
        return res.status(status).json({ ok: false, error: inner.message, code: inner.code })
      }
      throw inner
    }
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message ?? String(err), code: err?.code })
  }
})

// GET /api/fourmeme/launches/live — for each of the caller's `launched`
// rows that has a tokenAddress, fetch the bonding-curve state via
// getTokenInfo and return current price + a rough PnL estimate against
// the dev's recorded initial-buy BNB. Kept as a separate endpoint from
// /launches so the historical list still loads instantly even when RPC
// is slow; the mini-app fetches this lazily after the row list renders.
//
// PnL is intentionally "rough" — we don't store the exact tokens the
// dev received at launch, so we estimate them from the curve's avg
// fill price (fundsWei / boughtTokensWei). Since the dev was the very
// first buyer, their actual entry price was ≤ avg, meaning this
// estimate UNDER-counts tokens received and therefore UNDER-states
// gains / OVER-states losses. That's the safer direction for a
// "rough" number surfaced to a user.
app.get('/api/fourmeme/launches/live', requireTgUser, async (req, res) => {
  const user = (req as any).user
  if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })
  try {
    const { isFourMemeEnabled, getTokenInfo } = await import('./services/fourMemeTrading')
    if (!isFourMemeEnabled()) return res.json({ ok: true, live: {} })
    const rows = await db.$queryRaw<Array<{
      id: string
      token_address: string
      initial_liquidity_bnb: string | null
    }>>`
      SELECT "id","token_address","initial_liquidity_bnb"
        FROM "token_launches"
       WHERE "user_id" = ${user.id}
         AND "status" = 'launched'
         AND "token_address" IS NOT NULL
       ORDER BY "created_at" DESC
       LIMIT 20
    `
    const live: Record<string, {
      lastPriceWei?: string
      quoteIsBnb?: boolean
      fillPct?: number
      graduatedToPancake?: boolean
      pnlPct?: number | null
      currentValueBnb?: string | null
      error?: string
    }> = {}
    await Promise.all(rows.map(async (r) => {
      try {
        const info = await getTokenInfo(r.token_address)
        let pnlPct: number | null = null
        let currentValueBnb: string | null = null
        const initialBnbStr = r.initial_liquidity_bnb
        if (info.quoteIsBnb && initialBnbStr) {
          const initialBnb = Number(initialBnbStr)
          const boughtTokensWei = info.maxOffersWei - info.offersWei
          if (
            Number.isFinite(initialBnb) && initialBnb > 0 &&
            boughtTokensWei > 0n && info.fundsWei > 0n && info.lastPriceWei > 0n
          ) {
            const initialBnbWei = BigInt(Math.round(initialBnb * 1e18))
            // tokensReceived ≈ initialBnbWei / avgPrice
            //               = initialBnbWei * boughtTokensWei / fundsWei
            const tokensReceivedWei = (initialBnbWei * boughtTokensWei) / info.fundsWei
            // currentValueBnbWei = tokensReceivedWei * lastPriceWei / 1e18
            //   (lastPriceWei is BNB-wei per 1 token-wei * 1e18 scaling)
            const currentValueWei = (tokensReceivedWei * info.lastPriceWei) / (10n ** 18n)
            currentValueBnb = (Number(currentValueWei) / 1e18).toString()
            const initialF = Number(initialBnbWei)
            if (initialF > 0) {
              pnlPct = (Number(currentValueWei - initialBnbWei) / initialF) * 100
            }
          }
        }
        live[r.id] = {
          lastPriceWei: info.lastPriceWei.toString(),
          quoteIsBnb: info.quoteIsBnb,
          fillPct: info.fillPct,
          graduatedToPancake: info.graduatedToPancake,
          pnlPct,
          currentValueBnb,
        }
      } catch (e: any) {
        live[r.id] = { error: e?.message ?? String(e) }
      }
    }))
    res.json({ ok: true, live })
  } catch (err: any) {
    const msg = String(err?.message ?? err)
    if (/relation .*token_launches.* does not exist/i.test(msg)) {
      return res.json({ ok: true, live: {} })
    }
    res.status(400).json({ ok: false, error: msg, code: err?.code })
  }
})

app.post('/api/fourmeme/reject', requireTgUser, async (req, res) => {
  const user = (req as any).user
  if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })
  try {
    const launchId = String(req.body?.launchId ?? '')
    if (!launchId) return res.status(400).json({ ok: false, error: 'launchId required' })
    const { rejectPendingLaunch, LaunchApprovalError } = await import('./services/fourMemeLaunch')
    try {
      await rejectPendingLaunch({ launchId, userId: user.id })
      res.json({ ok: true })
    } catch (inner: any) {
      if (inner instanceof LaunchApprovalError) {
        const status = inner.code === 'NOT_FOUND' ? 404
                     : inner.code === 'FORBIDDEN' ? 403
                     : 409
        return res.status(status).json({ ok: false, error: inner.message, code: inner.code })
      }
      throw inner
    }
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message ?? String(err), code: err?.code })
  }
})

app.get('/api/fourmeme/agent-status', requireTgUser, async (req, res) => {
  const user = (req as any).user
  if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })
  try {
    const { isFourMemeEnabled, isAgentWallet, loadUserBscPrivateKey } =
      await import('./services/fourMemeTrading')
    if (!isFourMemeEnabled()) return res.status(503).json({ ok: false, code: 'FOUR_MEME_DISABLED' })
    const { address } = await loadUserBscPrivateKey(user.id)
    const isAgent = await isAgentWallet(address)
    res.json({ ok: true, address, isAgent })
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message ?? String(err), code: err?.code })
  }
})

app.get('/api/polymarket/wallet', requireTgUser, async (req, res) => {
  const user = (req as any).user
  if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })
  try {
    const creds = await db.polymarketCreds.findUnique({ where: { userId: user.id } })

    // EOA — the signing key, derived from the user's BSC wallet PK. We
    // intentionally prefer the *active* BSC wallet over creds.walletAddress:
    // the fund helper (`getUserPolygonSigner`) signs with the active wallet,
    // and `/api/me/wallet` also reports on the active wallet, so all three
    // surfaces (Wallet card, Predictions panel, fund tx) stay consistent.
    // (creds.walletAddress is preserved as a fallback for users who haven't
    // initialised an active BSC wallet yet — extremely rare in practice.)
    const activeBsc = await db.wallet.findFirst({
      where: { userId: user.id, isActive: true, chain: 'BSC' },
    })
    const walletAddress: string | null =
      activeBsc?.address ?? creds?.walletAddress ?? null

    // Safe — the funder. This is where users deposit USDC.e and where
    // Polymarket holds positions. Null until /setup deploys it.
    const safeAddress: string | null = creds?.safeAddress ?? null

    // Read balances at the SAFE (the trading address) and the EOA (where
    // the user's external USDC.e lands and where MATIC for the one-tap
    // fund transfer lives). EOA balances drive the "Fund Polymarket"
    // CTA — when the EOA holds USDC.e, the UI shows a one-click button
    // to sweep it into the Safe; when MATIC is missing, the UI prompts
    // the user to send a small amount for gas.
    let balances:
      | {
          usdc: number
          allowanceCtf: number
          allowanceNeg: number
          allowanceNegAdapter: number
          ctfApprovedCtfExchange: boolean
          ctfApprovedNegExchange: boolean
          ctfApprovedNegAdapter:  boolean
        }
      | null = null
    let eoaBalances: { usdcE: number; matic: number } | null = null
    if (walletAddress) {
      try {
        const { getPolygonBalances } = await import('./services/polymarketTrading')
        const e = await getPolygonBalances(walletAddress)
        eoaBalances = { usdcE: e.usdc, matic: e.matic }
      } catch (e) {
        console.warn('[API] polymarket/wallet eoa balances failed:', (e as Error).message)
      }
    }
    if (safeAddress) {
      try {
        const { getPolygonBalances } = await import('./services/polymarketTrading')
        const b = await getPolygonBalances(safeAddress)
        balances = {
          usdc:                    b.usdc,
          allowanceCtf:            b.allowanceCtf,
          allowanceNeg:            b.allowanceNeg,
          allowanceNegAdapter:     b.allowanceNegAdapter,
          ctfApprovedCtfExchange:  b.ctfApprovedCtfExchange,
          ctfApprovedNegExchange:  b.ctfApprovedNegExchange,
          ctfApprovedNegAdapter:   b.ctfApprovedNegAdapter,
        }
      } catch (e) {
        console.warn('[API] polymarket/wallet balances failed:', (e as Error).message)
      }
    }

    const ready = Boolean(
      creds && safeAddress && balances &&
      balances.allowanceCtf        >= 1_000_000 &&
      balances.allowanceNeg        >= 1_000_000 &&
      balances.allowanceNegAdapter >= 1_000_000 &&
      balances.ctfApprovedCtfExchange &&
      balances.ctfApprovedNegExchange &&
      balances.ctfApprovedNegAdapter,
    )

    res.json({
      ok: true,
      walletAddress,                                        // EOA (signer)
      safeAddress,                                          // Gnosis Safe (funder, deposit address)
      hasCreds:          Boolean(creds),
      safeDeployed:      Boolean(creds?.safeDeployedAt),
      allowanceVerified: Boolean(creds?.allowanceVerifiedAt),
      ready,
      balances,
      eoaBalances,                                          // Polygon balances at the EOA (for Fund button)
      builderCode: polymarketConfigBuilderCode(),
    })
  } catch (err: any) {
    console.error('[API] /polymarket/wallet failed:', err)
    res.status(500).json({ ok: false, error: 'wallet_lookup_failed' })
  }
})

app.post('/api/polymarket/setup', requireTgUser, async (req, res) => {
  const user = (req as any).user
  if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })
  try {
    const {
      getOrCreateCreds,
      deploySafeIfNeeded,
      ensureUsdcAllowance,
    } = await import('./services/polymarketTrading')

    // (1) Derive CLOB L2 HMAC creds (one-time, signed by the EOA).
    const { walletAddress } = await getOrCreateCreds(user.id)

    // (2) Deploy the Gnosis Safe via Polymarket's relayer (gasless).
    //     Idempotent — returns existing safeAddress if already deployed.
    let safe: { safeAddress: string; alreadyDeployed: boolean; txHash?: string }
    try {
      safe = await deploySafeIfNeeded(user.id)
    } catch (deployErr: any) {
      const rawMsg = String(deployErr?.message ?? deployErr)
      const friendly = humanizeRelayerError(rawMsg, 'Safe deploy')
      await logPolymarketEvent({
        userId: user.id,
        action: 'wallet_setup_failed',
        reason: `Safe deploy failed: ${rawMsg.slice(0, 300)}`,
      })
      return res.status(502).json({
        ok: false,
        walletAddress,
        credsReady: true,
        error: 'safe_deploy_failed',
        details: friendly.slice(0, 500),
      })
    }

    // (3) Approve USDC + CTF to the three exchange contracts (gasless,
    //     batched in one relayer transaction).
    let allowance: { alreadyApproved: boolean; txHashes: string[] } = { alreadyApproved: true, txHashes: [] }
    try {
      allowance = await ensureUsdcAllowance(user.id)
    } catch (allowErr: any) {
      const rawMsg = String(allowErr?.message ?? allowErr)
      const friendly = humanizeRelayerError(rawMsg, 'USDC + CTF allowance')
      await logPolymarketEvent({
        userId: user.id,
        action: 'wallet_setup_failed',
        reason: `Allowance tx failed: ${rawMsg.slice(0, 300)}`,
      })
      return res.status(502).json({
        ok: false,
        walletAddress,
        safeAddress: safe.safeAddress,
        credsReady: true,
        error: 'allowance_failed',
        details: friendly.slice(0, 500),
      })
    }

    await logPolymarketEvent({
      userId: user.id,
      action: 'wallet_setup',
      reason: [
        safe.alreadyDeployed
          ? `Safe already deployed at ${safe.safeAddress.slice(0, 10)}…`
          : `Safe deployed gaslessly at ${safe.safeAddress.slice(0, 10)}…`,
        allowance.alreadyApproved
          ? 'USDC + CTF allowances already in place'
          : `Approved USDC + CTF gaslessly (${allowance.txHashes.length} relayer tx)`,
      ].join(' · '),
    })

    res.json({
      ok: true,
      walletAddress,
      safeAddress: safe.safeAddress,
      safeNewlyDeployed: !safe.alreadyDeployed,
      credsReady: true,
      allowance,
    })
  } catch (err: any) {
    const msg = err?.message ?? String(err)
    console.error('[API] /polymarket/setup failed:', msg)
    res.status(500).json({ ok: false, error: 'setup_failed', details: msg.slice(0, 300) })
  }
})

// Gasless redeem of a resolved Polymarket position. Routes through CTF
// for standard binary markets and the NegRiskAdapter for neg-risk
// markets. Caller specifies which via `isNegRisk`.
app.post('/api/polymarket/redeem', requireTgUser, async (req, res) => {
  const user = (req as any).user
  if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })
  try {
    const body         = req.body ?? {}
    const conditionId  = String(body.conditionId ?? '')
    const isNegRisk    = Boolean(body.isNegRisk)
    const negRiskAmts  = Array.isArray(body.negRiskAmounts)
      ? body.negRiskAmounts.map((x: any) => BigInt(String(x)))
      : undefined

    if (!/^0x[0-9a-fA-F]{64}$/.test(conditionId)) {
      return res.status(400).json({ ok: false, error: 'invalid_condition_id' })
    }

    const { redeemPositions } = await import('./services/polymarketTrading')
    const { txHash } = await redeemPositions({
      userId:     user.id,
      conditionId,
      isNegRisk,
      negRiskAmounts: negRiskAmts,
    })

    await logPolymarketEvent({
      userId: user.id,
      action: 'redeem',
      reason: `Redeemed positions for condition ${conditionId.slice(0, 10)}… (gasless via relayer)`,
    })

    res.json({ ok: true, txHash })
  } catch (err: any) {
    const msg = err?.message ?? String(err)
    console.error('[API] /polymarket/redeem failed:', msg)
    res.status(502).json({ ok: false, error: 'redeem_failed', details: msg.slice(0, 300) })
  }
})

// One-tap fund: sweep custodial EOA USDC.e → user's Polymarket Safe.
// This is the only on-chain action the user themselves pays gas for in
// the Polymarket flow — every Safe-side action (deploy, approvals, orders,
// redemptions) is sponsored by Polymarket's relayer. To execute the
// transfer the user must hold a small amount of MATIC (~0.005) at their
// custodial EOA; if missing we return a NEED_MATIC code so the UI can
// show a clear "send MATIC for gas to {address}" prompt.
app.post('/api/polymarket/fund', requireTgUser, async (req, res) => {
  const user = (req as any).user
  if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })
  try {
    const body = req.body ?? {}
    // Optional explicit amount; absent = sweep entire EOA balance.
    const amountIn = body.amount === undefined || body.amount === null
      ? undefined
      : Number(body.amount)
    if (amountIn !== undefined && (!Number.isFinite(amountIn) || amountIn <= 0 || amountIn > 100_000)) {
      return res.status(400).json({ ok: false, error: 'invalid_amount', message: 'amount must be 0..100000' })
    }

    const { fundSafeFromEoa } = await import('./services/polymarketTrading')
    const result = await fundSafeFromEoa({ userId: user.id, amountUsdc: amountIn })

    await logPolymarketEvent({
      userId: user.id,
      action: 'fund',
      reason: `Funded Safe with ${result.amountUsdc.toFixed(2)} USDC.e (tx ${result.txHash.slice(0, 10)}…)`,
    })

    res.json({ ok: true, ...result })
  } catch (err: any) {
    const msg = String(err?.message ?? err)
    // NEED_MATIC is the user-actionable error: surface a structured code
    // so the UI can show the right prompt instead of an opaque toast.
    if (msg.includes('NEED_MATIC')) {
      // EOA address is the user's active BSC wallet address (same secp256k1
      // key, identical address on every EVM chain). The UI uses this to
      // show "send MATIC for gas to {address}" with a copy button.
      const w = await db.wallet.findFirst({
        where: { userId: user.id, isActive: true, chain: 'BSC' },
      }).catch(() => null)
      return res.status(400).json({
        ok: false, error: 'need_matic', code: 'NEED_MATIC',
        eoaAddress: w?.address ?? null, details: msg.slice(0, 200),
      })
    }
    if (msg.includes('No USDC.e balance')) {
      return res.status(400).json({ ok: false, error: 'no_usdc', details: msg.slice(0, 200) })
    }
    if (msg.includes('Safe not deployed')) {
      return res.status(400).json({ ok: false, error: 'no_safe', details: msg.slice(0, 200) })
    }
    console.error('[API] /polymarket/fund failed:', msg)
    res.status(500).json({ ok: false, error: 'fund_failed', details: msg.slice(0, 300) })
  }
})

app.post('/api/polymarket/order', requireTgUser, async (req, res) => {
  const user = (req as any).user
  if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })
  try {
    const body = req.body ?? {}
    const tokenId      = String(body.tokenId ?? '')
    const side         = String(body.side ?? '').toUpperCase()
    // Frontend sends `sizeUsdc` (clearer name); we accept both for back-compat
    // with any future caller (e.g. CLI scripts) that uses `amount`.
    const amount       = Number(body.sizeUsdc ?? body.amount)
    const conditionId  = String(body.conditionId ?? '')
    const marketTitle  = String(body.marketTitle ?? '')
    const marketSlug   = body.marketSlug ? String(body.marketSlug) : undefined
    const outcomeLabel = String(body.outcomeLabel ?? 'Yes')
    // Price snapshot the user saw at click time. Used for slippage protection
    // — if the executable price has moved more than SLIPPAGE_BPS from this
    // snapshot we refuse the order rather than execute against a worse book.
    const expectedPrice = Number(body.price)

    if (!/^[0-9]{60,80}$/.test(tokenId)) {
      return res.status(400).json({ ok: false, error: 'invalid_token_id' })
    }
    if (side !== 'BUY' && side !== 'SELL') {
      return res.status(400).json({ ok: false, error: 'invalid_side' })
    }
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000) {
      return res.status(400).json({ ok: false, error: 'invalid_amount', message: 'amount must be 0..10000' })
    }
    if (!/^0x[0-9a-fA-F]{2,128}$/.test(conditionId) && conditionId.length > 0) {
      return res.status(400).json({ ok: false, error: 'invalid_condition_id' })
    }
    if (!marketTitle || marketTitle.length > 500) {
      return res.status(400).json({ ok: false, error: 'invalid_market_title' })
    }

    const { placeMarketOrder } = await import('./services/polymarketTrading')
    const result = await placeMarketOrder({
      userId:  user.id,
      tokenId,
      side: side as 'BUY' | 'SELL',
      amount,
      marketCtx: { conditionId, marketTitle, marketSlug, outcomeLabel },
      reasoning: 'Manual mini-app trade',
      // Server-side slippage cap: refuse if price moved >5% from what user
      // saw at click time. Polymarket markets move slowly, so a 5% band is
      // generous for normal use; tightens against a moving book during
      // adverse selection moments (e.g. during a major news event).
      expectedPrice: Number.isFinite(expectedPrice) && expectedPrice > 0 && expectedPrice < 1
        ? expectedPrice
        : undefined,
      maxSlippageBps: 500,
    })

    if (!result.ok) {
      await logPolymarketEvent({
        userId: user.id,
        action: 'order_failed',
        reason: `${side} ${amount} ${outcomeLabel} on "${marketTitle.slice(0, 60)}" — ${result.error?.slice(0, 120) ?? 'unknown error'}`,
        pair:   marketSlug ?? marketTitle.slice(0, 60),
      })
      return res.status(502).json({ ...result, ok: false })
    }

    await logPolymarketEvent({
      userId: user.id,
      action: 'order_placed',
      reason: `${side} ${amount} USDC on "${marketTitle.slice(0, 60)}" ${outcomeLabel} @ ~${(result.fillPrice ?? 0).toFixed(3)}`,
      pair:   marketSlug ?? marketTitle.slice(0, 60),
      price:  result.fillPrice,
    })
    res.json({ ...result, ok: true })
  } catch (err: any) {
    const msg = err?.message ?? String(err)
    console.error('[API] /polymarket/order failed:', msg)
    res.status(500).json({ ok: false, error: 'order_failed', details: msg.slice(0, 300) })
  }
})

app.get('/api/polymarket/positions', requireTgUser, async (req, res) => {
  const user = (req as any).user
  if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })
  try {
    const { getUserPositions } = await import('./services/polymarketTrading')
    const positions = await getUserPositions(user.id)
    res.json({ ok: true, positions })
  } catch (err: any) {
    console.error('[API] /polymarket/positions failed:', err?.message ?? err)
    res.status(500).json({ ok: false, error: 'positions_lookup_failed' })
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

// ─── /api/me/venue-permissions ────────────────────────────────────────────
// Per-user "my agents are allowed to trade on this platform" allow-list.
// Reads/writes the three boolean gates that govern whether the runner
// dispatches an agent's tick to the venue's executor:
//   - aster       → User.asterAgentTradingEnabled
//   - hyperliquid → User.hyperliquidAgentTradingEnabled
//   - fortytwo    → User.fortyTwoLiveTrade (existing — same flag the
//                   /api/me/predictions-mode endpoint manages, exposed
//                   here too so the mini-app can read all three states
//                   in a single round-trip)
// The flags are independent of the *Onboarded flags. A user can be
// onboarded on Hyperliquid but choose to pause HL trading without
// disconnecting; the runner skips dispatch silently.
app.get('/api/me/venue-permissions', requireTgUser, async (req, res) => {
  const user = (req as any).user
  if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })
  try {
    const u = await db.user.findUnique({
      where: { id: user.id },
      select: {
        asterAgentTradingEnabled: true,
        hyperliquidAgentTradingEnabled: true,
        fortyTwoLiveTrade: true,
        polymarketAgentTradingEnabled: true,
        asterOnboarded: true,
        hyperliquidOnboarded: true,
      },
    })
    if (!u) return res.status(404).json({ ok: false, error: 'user not found' })
    // Polymarket "onboarded" = the user has a deployed Safe with API
    // creds registered. We derive it from PolymarketCreds rather than
    // a User flag so the state is always truthful (a user who deployed
    // their Safe in another session shows as onboarded immediately).
    // safeAddress can be null on legacy rows where setup failed midway,
    // so we require it explicitly to avoid lighting up a non-functional
    // "ready" state. .catch returns false on any DB hiccup so the whole
    // permissions endpoint never 500s due to a single missing table.
    const polyCreds = await db.polymarketCreds
      .findUnique({
        where: { userId: user.id },
        select: { safeAddress: true },
      })
      .catch(() => null)
    const polymarketOnboarded = !!polyCreds?.safeAddress
    res.json({
      ok: true,
      permissions: {
        aster:       !!u.asterAgentTradingEnabled,
        hyperliquid: !!u.hyperliquidAgentTradingEnabled,
        fortytwo:    !!u.fortyTwoLiveTrade,
        // Phase 4 (2026-05-01) — Polymarket gets a real per-user toggle.
        polymarket:  !!u.polymarketAgentTradingEnabled,
      },
      onboarded: {
        aster:       !!u.asterOnboarded,
        hyperliquid: !!u.hyperliquidOnboarded,
        // 42.space requires no per-user onboarding — anyone with a wallet
        // can trade on-chain prediction markets — so it's always "ready".
        fortytwo:    true,
        polymarket:  polymarketOnboarded,
      },
    })
  } catch (err) {
    console.error('[API] /me/venue-permissions GET failed:', err)
    res.status(500).json({ ok: false, error: 'lookup failed' })
  }
})

app.post('/api/me/venue-permissions', requireTgUser, async (req, res) => {
  const user = (req as any).user
  if (!user?.id) return res.status(401).json({ ok: false, error: 'unauthorized' })
  // Body is intentionally strict — never silently flip a user into LIVE
  // mode (especially for 42.space) due to a missing or coerced field.
  const venue = req.body?.venue
  const enabled = req.body?.enabled
  if (venue !== 'aster' && venue !== 'hyperliquid' && venue !== 'fortytwo' && venue !== 'polymarket') {
    return res.status(400).json({ ok: false, error: 'venue must be aster | hyperliquid | fortytwo | polymarket' })
  }
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'enabled must be boolean' })
  }
  try {
    if (venue === 'fortytwo') {
      // Reuse the existing executor helper so the same audit trail and
      // any side-effects (e.g. paper→live state initialisation) fire
      // regardless of which endpoint the user used to flip the switch.
      const { setUserLiveOptIn } = await import('./services/fortyTwoExecutor')
      await setUserLiveOptIn(user.id, enabled)
    } else {
      const field =
        venue === 'aster'       ? 'asterAgentTradingEnabled' :
        venue === 'hyperliquid' ? 'hyperliquidAgentTradingEnabled' :
        /* polymarket */          'polymarketAgentTradingEnabled'
      await db.user.update({
        where: { id: user.id },
        data: { [field]: enabled },
      })
    }
    res.json({ ok: true, venue, enabled })
  } catch (err) {
    console.error('[API] /me/venue-permissions POST failed:', err)
    res.status(500).json({ ok: false, error: 'update failed' })
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

// 60s soft cache for the live curve quote per (market|tokenId|amount-bucket).
// We bucket the token amount to ~3 sig-figs so two users with very similar
// position sizes can share a cache hit. The quote is purely informational
// (display-only), so a minute of staleness is fine and saves a lot of RPC.
const _liveValueCache = new Map<string, { value: number | null; at: number }>()
const LIVE_VALUE_TTL_MS = 60_000
function liveValueCacheKey(market: string, tokenId: number, otAmount: number): string {
  // bucket to 3 sig-figs of token quantity
  const exp = Math.max(0, Math.floor(Math.log10(otAmount)) - 2)
  const step = Math.pow(10, exp)
  const bucket = Math.round(otAmount / step) * step
  return `${market.toLowerCase()}|${tokenId}|${bucket.toFixed(6)}`
}

/**
 * Quote the bonding curve's redeem value for every open, non-paper position
 * in `rows`. Bounded (max 25), parallel, and cached. Returns a Map of
 * positionId → USDT value (float) or null if the quote couldn't be obtained.
 *
 * For 42.space's curve-driven parimutuel markets this on-chain quote IS
 * the canonical "(your tokens / winning supply) × pool" calculation,
 * already integrating fees and curve walk — strictly more accurate than
 * computing the formula ourselves with separate supply + balance reads.
 */
async function quoteCurrentValuesForPositions(
  rows: Array<{
    id: string; status: string; paperTrade: boolean;
    marketAddress: string; tokenId: number; outcomeTokenAmount: number | null;
    usdtIn: number; entryPrice: number;
  }>,
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>()
  const targets = rows
    .filter((r) => r.status === 'open' && !r.paperTrade)
    .map((r) => {
      const tokens = r.outcomeTokenAmount ?? (r.entryPrice > 0 ? r.usdtIn / r.entryPrice : 0)
      return { id: r.id, market: r.marketAddress, tokenId: r.tokenId, tokens }
    })
    .filter((t) => t.tokens > 0)
    .slice(0, 25)
  if (targets.length === 0) return out

  const { quoteRedeemValue } = await import('./services/fortyTwoOnchain')
  const { ethers } = await import('ethers')
  const now = Date.now()
  await Promise.all(targets.map(async (t) => {
    const key = liveValueCacheKey(t.market, t.tokenId, t.tokens)
    const cached = _liveValueCache.get(key)
    if (cached && now - cached.at < LIVE_VALUE_TTL_MS) {
      out.set(t.id, cached.value)
      return
    }
    try {
      const otDelta = ethers.parseUnits(t.tokens.toFixed(18).slice(0, 38), 18)
      const raw = await quoteRedeemValue(t.market, t.tokenId, otDelta)
      const value = raw === null ? null : Number(ethers.formatUnits(raw, 18))
      _liveValueCache.set(key, { value, at: now })
      out.set(t.id, value)
    } catch (err) {
      // Quote already logs internally on failure — record null and move on.
      out.set(t.id, null)
    }
  }))
  return out
}

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

    // Fire-and-forget: rewrite stale payout/pnl on already-claimed and
    // already-closed rows from the receipt's USDT Transfer (truth), and
    // null out any pre-claim 1:1 estimate the old settle path stamped on
    // resolved_win rows. Bounded to 25 rows per call, runs entirely in
    // background — never blocks the positions response.
    void exec.backfillReceiptPayoutsForUser(user.id).catch((err) => {
      console.warn('[positions] backfill failed:', (err as Error).message)
    })

    // Live parimutuel-implied current value of each open position. We
    // call the bonding curve's `calRedeemValueByOtDelta` quote — for a
    // curve-driven parimutuel like 42.space this is the on-chain truth
    // of "what would the user receive if they redeemed N tokens RIGHT
    // NOW". It already integrates pool size, winning-side supply, fees,
    // and curve walk in a single read, which is more accurate than us
    // computing `(your tokens / supply) × pool` ourselves and matches
    // exactly what the contract pays out at claim/sell time.
    //
    // Bounded to 25 quotes per request, in parallel, with a soft 60s
    // cache. Failures fall back to null — the UI renders a clean dash.
    const valuesByPosition = await quoteCurrentValuesForPositions(rows)

    const positions = rows.map((p) => ({
      id: p.id,
      marketTitle: p.marketTitle,
      marketAddress: p.marketAddress,
      tokenId: p.tokenId,
      outcomeLabel: p.outcomeLabel,
      usdtIn: p.usdtIn,
      entryPrice: p.entryPrice,
      exitPrice: p.exitPrice,
      outcomeTokenAmount: p.outcomeTokenAmount,
      payoutUsdt: p.payoutUsdt,
      pnl: p.pnl,
      status: p.status, // 'open' | 'closed' | 'resolved_win' | 'resolved_loss' | 'claimed'
      paperTrade: p.paperTrade,
      txHashOpen: p.txHashOpen,
      txHashClose: p.txHashClose,
      openedAt: p.openedAt,
      closedAt: p.closedAt,
      currentValueUsdt: valuesByPosition.get(p.id) ?? null,
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
// AI usage dashboard — combined per-provider rollup + daily timeseries for a
// calendar-aligned window (today/mtd/ytd) or a rolling window (24h/7d/30d).
// Drives the admin "AI Usage" mini-app page so operators can track ecosystem
// LLM spend at a glance.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/admin/ai-usage', requireAdmin, async (req, res) => {
  try {
    const { getSwarmStats, getDailyUsage } = await import('./services/swarmStats')
    type W = Awaited<ReturnType<typeof getSwarmStats>>['window']
    const allowed = new Set(['24h', '7d', '30d', 'today', 'mtd', 'ytd'])
    const raw = String(req.query.window ?? 'today').toLowerCase()
    const window = (allowed.has(raw) ? raw : 'today') as W
    const [report, daily] = await Promise.all([
      getSwarmStats(window),
      getDailyUsage(window),
    ])
    const totals = report.rows.reduce(
      (acc, r) => ({
        calls: acc.calls + r.callCount,
        inputTokens: acc.inputTokens + r.inputTokens,
        outputTokens: acc.outputTokens + r.outputTokens,
        totalTokens: acc.totalTokens + r.totalTokens,
        estimatedUsd: acc.estimatedUsd + r.estimatedUsd,
      }),
      { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedUsd: 0 },
    )
    res.json({
      window: report.window,
      since: report.since.toISOString(),
      now: new Date().toISOString(),
      totals,
      rows: report.rows,
      daily,
      quorum: report.quorum,
    })
  } catch (err) {
    console.error('[API] /admin/ai-usage failed:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// AI provider credits / health snapshot.
//
// Honesty note: most LLM providers (Anthropic, xAI, OpenAI, Akash) do NOT
// expose an account-balance endpoint via the standard inference API key. We
// surface what we *can* — env-key presence, circuit-breaker park status,
// default model — and link out to each provider's billing dashboard for the
// rest, instead of fabricating numbers. Hyperbolic is the only one with a
// public balance endpoint at time of writing; we attempt it with a short
// timeout and fall through to "see dashboard" on any failure.
// ─────────────────────────────────────────────────────────────────────────────
const PROVIDER_DASHBOARDS: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/settings/billing',
  xai: 'https://console.x.ai/team/default/usage',
  hyperbolic: 'https://app.hyperbolic.xyz/settings/billing',
  akash: 'https://chatapi.akash.network/',
}

async function fetchHyperbolicBalance(apiKey: string): Promise<number | null> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 5000)
  try {
    const r = await fetch('https://api.hyperbolic.xyz/billing/balance', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    })
    if (!r.ok) return null
    const j = (await r.json()) as { credits?: number; balance?: number }
    const v = typeof j.credits === 'number' ? j.credits : typeof j.balance === 'number' ? j.balance : null
    return v
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

app.get('/api/admin/ai-credits', requireAdmin, async (_req, res) => {
  try {
    const { getProviderStatus, getCircuitState } = await import('./services/inference')
    const status = getProviderStatus()
    const circuits = getCircuitState()
    const now = Date.now()
    const out = await Promise.all(
      (Object.keys(status) as Array<keyof typeof status>).map(async (provider) => {
        const cfg = status[provider]
        const parkedUntil = circuits[provider] ?? 0
        const tripped = parkedUntil > now
        let balance: number | null = null
        let balanceError: string | null = null
        if (cfg.live && provider === 'hyperbolic') {
          const apiKey = process.env[cfg.envVar]
          if (apiKey) {
            balance = await fetchHyperbolicBalance(apiKey)
            if (balance === null) balanceError = 'Endpoint did not return a balance'
          }
        }
        return {
          provider,
          configured: cfg.live,
          envVar: cfg.envVar,
          defaultModel: cfg.defaultModel,
          circuitTripped: tripped,
          circuitParkedUntil: tripped ? new Date(parkedUntil).toISOString() : null,
          balanceUsd: balance,
          balanceError,
          dashboardUrl: PROVIDER_DASHBOARDS[provider] ?? null,
        }
      }),
    )
    res.json({ providers: out, fetchedAt: new Date().toISOString() })
  } catch (err) {
    console.error('[API] /admin/ai-credits failed:', err)
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
  // Connect DB — retry up to 5 times with exponential backoff so a
  // transient Postgres P1017 ("server has closed the connection",
  // typically Render's Postgres briefly at connection limit or in a
  // maintenance window) doesn't crash the boot. Prisma also connects
  // lazily on first query, so even if all retries fail we let the
  // server come up and serve traffic — individual queries will retry
  // their own connections.
  let connected = false
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await db.$connect()
      connected = true
      console.log(`[DB] Connected (attempt ${attempt})`)
      break
    } catch (err) {
      const msg = (err as Error).message ?? String(err)
      console.warn(`[DB] $connect attempt ${attempt}/5 failed: ${msg}`)
      if (attempt < 5) await new Promise((r) => setTimeout(r, 1000 * attempt))
    }
  }
  if (!connected) {
    console.error('[DB] All $connect retries failed — booting anyway, queries will lazy-connect')
  }

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
      // Always 200: returning 500 causes Telegram to retry the same update,
      // creating a death loop when a handler throws (e.g. Markdown parse
      // errors on a single broken reply). bot.catch logs the actual error.
      try {
        await bot.handleUpdate(req.body)
      } catch (err) {
        console.error('[Webhook] Error:', err)
      }
      res.sendStatus(200)
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
