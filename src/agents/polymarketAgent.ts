// ─────────────────────────────────────────────────────────────────────────
// polymarketAgent — Phase 3 autonomous Polymarket trader.
//
// Tick lifecycle (one user, every POLYMARKET_TICK_INTERVAL_MS):
//   1. Pull the user's enabled Polymarket agent rows (Agent.polymarketEnabled)
//   2. Pull top trending events (filtered: closed=false, active=true,
//      enableOrderBook=true, end-date inside 90d window) — same Gamma API
//      we use in Phase 1, hits the same 15s server cache.
//   3. For each candidate market, ask one LLM provider (Anthropic by
//      default, falls back to xai then hyperbolic) for an action verdict.
//      Prompt asks for { action: 'BUY'|'SKIP', side: 'YES'|'NO',
//      conviction: 0-1, reasoning: string }.
//   4. If conviction ≥ agent.polymarketEdgeThreshold AND the implied
//      edge (our prob estimate – market prob) ≥ threshold AND the user
//      doesn't already hold this market AND USDC balance is sufficient
//      → place a market order through `placeMarketOrder` (which threads
//      our builder code automatically) sized at agent.polymarketMaxSizeUsdc.
//   5. Every decision (including SKIPs and rejections) is logged to
//      AgentLog with exchange='polymarket' so the brain feed surfaces a
//      POLY chip alongside HL/Aster/42 entries.
//
// Failure modes are bounded — the tick wraps in try/catch per market,
// so one bad event can't poison the rest. The whole loop wraps in
// try/catch per user so one user's broken creds doesn't stop the others.
// ─────────────────────────────────────────────────────────────────────────

import { db } from '../db'
import { listEvents, type PolymarketEvent, type PolymarketMarket } from '../services/polymarket'
import {
  getOrCreateCreds,
  getPolygonBalances,
  placeMarketOrder,
  getBuilderCode,
} from '../services/polymarketTrading'
import { scorePredictionMarket, parsePredictionDecision } from './predictionBrain'

// Hard cap on number of events we score per tick — keeps the LLM bill
// bounded even if Gamma returns dozens. Five top-volume events is plenty
// for a 60s tick cadence: each event is one prompt round-trip, so this
// caps us at ≤ 5 LLM calls per agent per tick.
const MAX_EVENTS_PER_TICK = 5

// Hard cap on number of markets scored within a single multi-outcome
// event. Most events have 2-4 markets; some sports/election events have
// 30+ — without this cap a single event could blow the LLM budget.
const MAX_MARKETS_PER_EVENT = 3

// Max Polymarket tick frequency per agent. Even if the runner ticks
// every 10s, an individual polymarket agent only acts once per minute —
// markets move slowly relative to perps, and this keeps LLM cost low.
const MIN_TICK_INTERVAL_MS = 60_000

// Polymarket Gamma "Crypto" tag. Used as a server-side pre-filter on
// /events so the BUILD4 agent runner never even sees the sports/elections/
// weather long tail. Looked up via Gamma /tags?slug=crypto. Hardcoded
// because tag ids on Gamma are stable; a refresh script would only run
// once a year. If Polymarket ever renumbers, the keyword belt-and-
// suspenders below still keeps us crypto-only.
export const POLYMARKET_CRYPTO_TAG_ID = 21

// Crypto + Price-target keyword filter. Two purposes:
//  - belt-and-suspenders if Gamma tag fetch returns an off-topic event
//  - per-market gate: a crypto event can host non-price sub-markets
//    ("Will Coinbase list X?"); the agent only trades price targets.
const POLY_CRYPTO_KW = ['btc','bitcoin','eth','ethereum','sol','solana','bnb','xrp','doge','crypto','altcoin','defi']
const POLY_PRICE_KW  = ['$','price','reach','close above','close below',' above ',' below ','high of','low of','all-time high','ath']
function isCryptoEventTitle(title: string): boolean {
  const t = title.toLowerCase()
  return POLY_CRYPTO_KW.some((k) => t.includes(k))
}
function isCryptoPriceMarket(eventTitle: string, marketQuestion: string): boolean {
  const hay = `${eventTitle} ${marketQuestion}`.toLowerCase()
  return POLY_CRYPTO_KW.some((k) => hay.includes(k)) && POLY_PRICE_KW.some((k) => hay.includes(k))
}

// Phase 4 (2026-05-03) — live sweep telemetry. Captured on every sweep
// completion, exposed via /api/me/debug-polymarket and the /debugpoly
// bot command so users (and us) can see *why* a sweep returned what it
// did without parsing Render logs. The shape mirrors the return value
// of tickAllPolymarketAgents plus a timestamp and the last error
// message — that's the diagnostic users actually need.
export interface PolymarketSweepStatus {
  at: string  // ISO timestamp of last sweep completion
  scanned: number
  ticked: number
  ordersPlaced: number
  ordersSkipped: number
  errors: number
  lastError: string | null
  loadAgentsError: string | null
  listEventsError: string | null
}
let lastSweepStatus: PolymarketSweepStatus | null = null
export function getLastPolymarketSweepStatus(): PolymarketSweepStatus | null {
  return lastSweepStatus
}

// AgentDecision is now PredictionDecision from predictionBrain — shared
// with 42.space so both prediction venues use the same shape.
import type { PredictionDecision } from './predictionBrain'
type AgentDecision = PredictionDecision

interface PolymarketAgentRow {
  id: string
  userId: string
  name: string
  polymarketEnabled: boolean
  polymarketMaxSizeUsdc: number
  polymarketEdgeThreshold: number
  lastPolymarketTickAt: Date | null
  // Phase 4 (2026-05-01) — generalized prediction-market risk fields. Both
  // are nullable so legacy rows that pre-date the migration still work; the
  // readers below fall back to polymarketEdgeThreshold / 14d defaults.
  predictionEdgeThreshold: number | null
  predictionMaxDurationDays: number | null
  // Phase 4 — reading enabledVenues lets the per-agent venue chip in
  // Agent Studio drive Polymarket on/off in addition to the legacy
  // polymarketEnabled boolean.
  enabledVenues: string[]
  // Phase 4 (2026-05-01) — joined user row used to gate dispatch on the
  // per-user platform allow flag. Optional + nullable on user so a row
  // that somehow loses its FK target doesn't crash the runner.
  user: { polymarketAgentTradingEnabled: boolean } | null
}

// ─────────────────────────────────────────────────────────────────────────
// Public entry point — called from runner.ts on a schedule.
// Iterates every Polymarket-enabled agent, ticks each one independently.
// Returns counts so the runner can log a summary line.
// ─────────────────────────────────────────────────────────────────────────
export async function tickAllPolymarketAgents(): Promise<{
  scanned: number
  ticked: number
  ordersPlaced: number
  ordersSkipped: number
  errors: number
}> {
  let scanned = 0
  let ticked = 0
  let ordersPlaced = 0
  let ordersSkipped = 0
  let errors = 0

  let agents: PolymarketAgentRow[] = []
  let loadAgentsError: string | null = null
  try {
    // Phase 4 (2026-05-03): switched from db.agent.findMany() to raw SQL.
    // Why: an earlier deploy was returning scanned=0 even when /debugpoly
    // (which uses raw SQL) showed the agent was eligible. The most
    // plausible explanation is a stale Prisma client on Render's build
    // (predictionEdgeThreshold / predictionMaxDurationDays / enabledVenues
    // missing from the generated client) silently throwing inside
    // findMany — caught here, swallowed as "load failed", returns
    // scanned=0 with no actionable error to the user.
    //
    // Raw SQL bypasses the client entirely, reads the columns directly
    // from Postgres (where ensureTables guarantees they exist), and
    // gives us a real error string we can surface via /debugpoly when
    // something IS actually wrong with the schema.
    const rows = await db.$queryRawUnsafe<any[]>(
      `SELECT a."id", a."userId", a."name",
              a."polymarketEnabled",
              a."polymarketMaxSizeUsdc",
              a."polymarketEdgeThreshold",
              a."lastPolymarketTickAt",
              a."predictionEdgeThreshold",
              a."predictionMaxDurationDays",
              a."enabledVenues",
              u."polymarketAgentTradingEnabled" AS "userPolymarketAgentTradingEnabled"
         FROM "Agent" a
         LEFT JOIN "User" u ON u."id" = a."userId"
        WHERE a."isActive" = true
          AND a."isPaused" = false
          AND (
            a."polymarketEnabled" = true
            OR 'polymarket' = ANY(a."enabledVenues")
          )`,
    )
    // Drop agents whose user has paused polymarket trading at the
    // platform level. Treat undefined / null as ALLOW so a missing
    // user record (shouldn't happen, but be defensive) does not
    // silently mute the venue.
    agents = rows
      .filter((r) => r.userPolymarketAgentTradingEnabled !== false)
      .map<PolymarketAgentRow>((r) => ({
        id: r.id,
        userId: r.userId,
        name: r.name,
        polymarketEnabled: r.polymarketEnabled,
        polymarketMaxSizeUsdc: Number(r.polymarketMaxSizeUsdc ?? 5),
        polymarketEdgeThreshold: Number(r.polymarketEdgeThreshold ?? 0.05),
        lastPolymarketTickAt: r.lastPolymarketTickAt instanceof Date
          ? r.lastPolymarketTickAt
          : (r.lastPolymarketTickAt ? new Date(r.lastPolymarketTickAt) : null),
        predictionEdgeThreshold: r.predictionEdgeThreshold == null
          ? null
          : Number(r.predictionEdgeThreshold),
        predictionMaxDurationDays: r.predictionMaxDurationDays == null
          ? null
          : Number(r.predictionMaxDurationDays),
        enabledVenues: Array.isArray(r.enabledVenues) ? r.enabledVenues : [],
        user: { polymarketAgentTradingEnabled: r.userPolymarketAgentTradingEnabled !== false },
      }))
  } catch (err) {
    loadAgentsError = (err as Error).message ?? String(err)
    console.error('[polymarketAgent] failed to load agents:', loadAgentsError)
    lastSweepStatus = {
      at: new Date().toISOString(),
      scanned: 0, ticked: 0, ordersPlaced: 0, ordersSkipped: 0,
      errors: errors + 1,
      lastError: loadAgentsError,
      loadAgentsError,
      listEventsError: null,
    }
    return { scanned, ticked, ordersPlaced, ordersSkipped, errors: errors + 1 }
  }

  scanned = agents.length
  if (agents.length === 0) return { scanned, ticked, ordersPlaced, ordersSkipped, errors }

  // Pull events ONCE for the whole sweep — every agent scores from the
  // same top-of-board snapshot so we don't multiply Gamma traffic by N.
  //
  // Phase 4 (2026-05-03) — DON'T early-return on listEvents failure.
  // If Gamma is unreachable from Render's IP, an early return means
  // tickOneAgent never runs, lastPolymarketTickAt never gets stamped,
  // and the user has no visible signal that the sweep is reaching
  // their agent at all. Falling through with `events=[]` lets each
  // agent's tickOneAgent still:
  //   1. Stamp lastPolymarketTickAt (proves sweep matched the row),
  //   2. Send a heartbeat ("Polymarket data temporarily unavailable"),
  //   3. Run the setup-blocked / safe-not-deployed / low-USDC gates,
  //   4. Skip with a brain-feed entry (visible to the user).
  // The Gamma error is logged with full detail so we can fix it.
  let events: PolymarketEvent[] = []
  let listEventsError: string | null = null
  try {
    events = await listEvents({ limit: 20, order: 'volume24hr', tagId: POLYMARKET_CRYPTO_TAG_ID })
  } catch (err) {
    errors++
    listEventsError = (err as Error).message ?? String(err)
    console.error(`[polymarketAgent] listEvents failed (continuing with empty events): ${listEventsError}`)
  }

  let lastTickError: string | null = null
  for (const agent of agents) {
    // Tick-rate gate — even if runner spins fast, each agent acts at
    // most once a minute. lastPolymarketTickAt is updated below.
    const last = agent.lastPolymarketTickAt?.getTime() ?? 0
    if (Date.now() - last < MIN_TICK_INTERVAL_MS) continue

    try {
      const summary = await tickOneAgent(agent, events)
      ticked++
      ordersPlaced  += summary.ordersPlaced
      ordersSkipped += summary.ordersSkipped
    } catch (err) {
      errors++
      lastTickError = `${agent.name}: ${(err as Error).message ?? String(err)}`
      console.error(`[polymarketAgent] agent ${agent.id} tick failed:`, (err as Error).message)
    }
  }

  lastSweepStatus = {
    at: new Date().toISOString(),
    scanned, ticked, ordersPlaced, ordersSkipped, errors,
    lastError: lastTickError,
    loadAgentsError,
    listEventsError,
  }
  return { scanned, ticked, ordersPlaced, ordersSkipped, errors }
}

// ─────────────────────────────────────────────────────────────────────────
// Per-agent tick. Returns counts. Caller wraps in try/catch.
// ─────────────────────────────────────────────────────────────────────────
async function tickOneAgent(
  agent: PolymarketAgentRow,
  events: PolymarketEvent[],
): Promise<{ ordersPlaced: number; ordersSkipped: number }> {
  let ordersPlaced = 0
  let ordersSkipped = 0

  // Phase 4 (2026-05-01) — generalized prediction-market knobs.
  //
  //   effectiveEdge       : minimum (LLM conviction − market-implied price)
  //                         we'll cross the spread for. Falls back to the
  //                         legacy polymarketEdgeThreshold so rows that
  //                         pre-date the migration still trade.
  //
  //   maxEndDateMs        : Unix-ms ceiling on a market's resolution date.
  //                         Capital locked in long-dated markets is the
  //                         user's primary risk concern (you can't ragequit
  //                         a Polymarket position the way you can close a
  //                         perp). Default 14d gives the LLM ~2-week
  //                         resolution horizon. predictionMaxDurationDays
  //                         is nullable until backfill, so default in JS.
  const effectiveEdge = agent.predictionEdgeThreshold ?? agent.polymarketEdgeThreshold
  const maxDurationDays = agent.predictionMaxDurationDays ?? 14
  const maxEndDateMs = Date.now() + maxDurationDays * 86400000

  // Stamp the tick time UP-FRONT so a slow LLM round-trip can't cause
  // back-to-back ticks if the runner double-fires.
  await db.agent.update({
    where: { id: agent.id },
    data:  { lastPolymarketTickAt: new Date() },
  })

  // Phase 4 (2026-05-03) — Telegram scan heartbeat. Mirrors the 42.space
  // pattern in tradingAgent.ts so users with Polymarket enabled see a
  // "Dominic on Polymarket — scanned N markets" message in chat instead
  // of having to dig through the brain feed to confirm the venue is
  // running. Fired BEFORE the setup-blocked / safe-not-deployed gates
  // so users without onboarding still get the signal that the agent
  // tried — and a one-line hint about what's blocking it.
  // Rate-limited to once every ~10 minutes per agent via the same
  // shouldSendPairNotification helper used by 42.space and Aster/HL.
  try {
    const { getBot, shouldSendPairNotification, markPairNotificationSent, escapeMd } =
      await import('./runner')
    const bot = getBot()
    const u = await db.user.findUnique({
      where: { id: agent.userId },
      select: { telegramId: true },
    })
    const tg = u?.telegramId?.toString() ?? null
    const heartbeatKey = '__scanlog__:polymarket'
    if (bot && tg && shouldSendPairNotification(agent.id, heartbeatKey, 'heartbeat')) {
      markPairNotificationSent(agent.id, heartbeatKey, 'heartbeat')
      const top = events
        .filter((e) => e.active && !e.closed && !e.archived && e.enableOrderBook)
        .slice(0, 3)
      const lines = top
        .map((e) => `• ${escapeMd((e.title ?? '').slice(0, 60))}`)
        .join('\n')
      const body = top.length === 0
        ? `Scanned Polymarket — no live events returned\\.`
        : `Scanned ${events.length} live Polymarket events:\n${lines}`
      const msg = `🎲 *${escapeMd(agent.name)} on Polymarket*\n\n${body}`
      try { await bot.api.sendMessage(tg, msg, { parse_mode: 'MarkdownV2' }) } catch {}
    }
  } catch (e: any) {
    console.warn(`[polymarketAgent] heartbeat send failed for ${agent.id}:`, e?.message)
  }

  // Make sure the user has Polymarket creds ready — this is idempotent
  // (no-ops once set up). If they haven't onboarded (no BSC wallet to
  // derive PK from), getOrCreateCreds throws and we log + bail.
  let walletAddress: string
  try {
    const c = await getOrCreateCreds(agent.userId)
    walletAddress = c.walletAddress
  } catch (err) {
    await logDecision(agent, null, { question: 'Polymarket setup required' } as any, {
      action: 'SKIP',
      side:   'YES',
      conviction: 0,
      reasoning: `setup_blocked: ${(err as Error).message.slice(0, 200)}`,
    })
    return { ordersPlaced, ordersSkipped: ordersSkipped + 1 }
  }

  // Resolve the funder (Safe) address — that's where USDC lives under
  // the gasless model. If the user hasn't run /setup yet there's no
  // Safe deployed and we have nothing to trade against.
  const polyCreds = await db.polymarketCreds.findUnique({
    where: { userId: agent.userId },
  })
  const safeAddress = polyCreds?.safeAddress ?? null
  if (!safeAddress) {
    await logDecision(agent, null, { question: 'Polymarket Safe not deployed — run setup' } as any, {
      action: 'SKIP', side: 'YES', conviction: 0,
      reasoning: 'safe_not_deployed: user must run /api/polymarket/setup before agent can trade',
    })
    return { ordersPlaced, ordersSkipped: ordersSkipped + 1 }
  }

  // Read live USDC balance at the SAFE — the agent refuses to trade if
  // it can't afford the configured max size. Under the gasless model
  // there's no MATIC requirement at all; Polymarket's relayer pays for
  // every on-chain action (deploy, approve, redeem). Daily order POSTs
  // are off-chain EIP-712 signatures, free either way.
  let usdcBal = 0
  try {
    const bals = await getPolygonBalances(safeAddress)
    usdcBal = bals.usdc
  } catch (err) {
    console.warn(`[polymarketAgent] balance check failed for ${agent.id}:`, (err as Error).message)
  }
  void walletAddress
  if (usdcBal < agent.polymarketMaxSizeUsdc) {
    await logDecision(agent, null, { question: `Polymarket low USDC ($${usdcBal.toFixed(2)})` } as any, {
      action: 'SKIP', side: 'YES', conviction: 0,
      reasoning: `insufficient_usdc: have $${usdcBal.toFixed(2)}, need $${agent.polymarketMaxSizeUsdc}`,
    })
    return { ordersPlaced, ordersSkipped: ordersSkipped + 1 }
  }

  // Pull all condition IDs we already hold — agent should not pile in
  // to a market it has open exposure on. This is a DB read against
  // the per-user position rows, very cheap.
  const heldConditionIds = new Set<string>(
    (await db.polymarketPosition.findMany({
      where: { userId: agent.userId, status: { in: ['placed', 'matched', 'filled'] } },
      select: { conditionId: true },
    })).map((p) => p.conditionId),
  )

  // Crypto-only universe filter. The Gamma API is pre-filtered server-side
  // via tag_id=POLYMARKET_CRYPTO_TAG_ID upstream in tickAllPolymarketAgents
  // (one fetch shared across all enabled agents). The keyword check below
  // is a belt-and-suspenders pass in case Gamma returns a tagged-but-
  // off-topic event, AND it implements the per-market Price-target gate
  // (the agent only trades price markets, not "Will Coinbase list X?").
  const candidates = events
    .filter((e) => e.active && !e.closed && !e.archived && e.enableOrderBook)
    .filter((e) => isCryptoEventTitle(e.title ?? ''))
    .slice(0, MAX_EVENTS_PER_TICK)

  for (const event of candidates) {
    const markets = (event.markets || [])
      .filter((m) => m.enableOrderBook && !m.closed && !m.archived
                     && Array.isArray(m.clobTokenIds) && m.clobTokenIds.length >= 1
                     && Array.isArray(m.outcomes) && m.outcomes.length >= 1
                     // Phase 4: enforce predictionMaxDurationDays. A null
                     // endDate is treated as too-long (skip) — we'd rather
                     // miss an open-ended market than accidentally lock
                     // capital for months.
                     && m.endDate !== null
                     && new Date(m.endDate).getTime() <= maxEndDateMs)
      // Architect-review fix: apply the crypto+price gate BEFORE slicing
      // to MAX_MARKETS_PER_EVENT. Otherwise a crypto event whose first 3
      // child markets happen to be non-price (e.g. "Will Coinbase list X
      // by date?") would silently starve the agent of valid price markets
      // further down the list.
      .filter((m) => isCryptoPriceMarket(event.title ?? '', m.question ?? ''))
      .slice(0, MAX_MARKETS_PER_EVENT)

    for (const market of markets) {
      if (heldConditionIds.has(market.conditionId)) {
        ordersSkipped++
        continue
      }

      let decision: AgentDecision
      try {
        decision = await scoreMarket(event, market)
      } catch (err) {
        ordersSkipped++
        await logDecision(agent, event, market, {
          action: 'SKIP', side: 'YES', conviction: 0,
          reasoning: `llm_failed: ${(err as Error).message.slice(0, 200)}`,
        })
        continue
      }

      // Pull the implied probability from the market (book-side aware
      // depending on the side the LLM picked). This is the price at
      // which we'd actually fill, so the edge calc compares LLM
      // conviction against the *executable* market price, not the last
      // trade.
      const yesPrice = market.bestAsk ?? market.outcomePrices[0] ?? 0.5
      const noPrice  = market.outcomes[1]
        ? (market.bestBid !== null ? 1 - market.bestBid : (market.outcomePrices[1] ?? 0.5))
        : null
      const sidePrice = decision.side === 'YES' ? yesPrice : (noPrice ?? 1 - yesPrice)
      // LLM conviction is treated as our subjective probability that the
      // chosen side resolves true. Edge = our prob – market-implied prob.
      const edge = decision.conviction - sidePrice

      if (decision.action === 'SKIP'
          || decision.conviction < effectiveEdge
          || edge < effectiveEdge
          || sidePrice <= 0
          || sidePrice >= 1) {
        ordersSkipped++
        await logDecision(agent, event, market, decision, { edge, sidePrice })
        continue
      }

      // For NO buys we need to actually buy the NO token (clobTokenIds[1]),
      // priced via 1 - bestBid_of_yes. If the market has no NO leg
      // (single-outcome scalar), force YES.
      const tokenIdx = decision.side === 'NO' && market.clobTokenIds[1] ? 1 : 0
      const tokenId  = market.clobTokenIds[tokenIdx]
      const outcomeLabel = market.outcomes[tokenIdx] ?? (tokenIdx === 0 ? 'Yes' : 'No')

      const result = await placeMarketOrder({
        userId:    agent.userId,
        agentId:   agent.id,
        tokenId,
        side:      'BUY',
        amount:    agent.polymarketMaxSizeUsdc,
        marketCtx: {
          conditionId:  market.conditionId,
          marketTitle:  market.question,
          marketSlug:   market.slug,
          outcomeLabel,
        },
        reasoning: decision.reasoning,
        // Slippage cap — refuse if the book has moved >5% from what
        // the model scored. Without this an autonomous agent could keep
        // chewing up size on a thin book during a fast move.
        expectedPrice:  sidePrice,
        maxSlippageBps: 500,
      })

      if (result.ok) {
        ordersPlaced++
        heldConditionIds.add(market.conditionId)
        await logDecision(agent, event, market, decision, {
          edge, sidePrice,
          execution: `order_placed pos=${result.positionId} fill=~${(result.fillPrice ?? sidePrice).toFixed(3)}`,
        })
        // Phase 4 (2026-05-01) — Telegram notification on successful
        // Polymarket entry. Mirrors the per-trade notify pattern used by
        // Aster/HL/42 so users with all 4 venues enabled see Polymarket
        // activity in chat instead of having to open the mini app.
        // Wrapped in try/catch + .catch(() => {}) — a missing telegramId
        // or a Telegram outage must NEVER block the trading loop.
        try {
          const { getBot } = await import('./runner')
          const bot = getBot()
          if (bot) {
            const u = await db.user.findUnique({
              where: { id: agent.userId },
              select: { telegramId: true },
            })
            const tg = u?.telegramId?.toString() ?? null
            if (tg) {
              const fillPx = result.fillPrice ?? sidePrice
              const title = (market.question ?? '').slice(0, 80)
              // escape only the markdown specials we actually use in the
              // body — full escapeMd would be overkill for this short
              //, mostly-numeric template.
              const safeTitle = title.replace(/([_*`\[\]()])/g, '\\$1')
              const safeAgent = agent.name.replace(/([_*`\[\]()])/g, '\\$1')
              const safeOutcome = outcomeLabel.replace(/([_*`\[\]()])/g, '\\$1')
              const msg =
                `🎲 *${safeAgent}* opened a Polymarket position\n\n` +
                `*Market:* ${safeTitle}${title.length === 80 ? '…' : ''}\n` +
                `*Outcome:* ${safeOutcome} (${decision.side})\n` +
                `*Entry:* ${(fillPx * 100).toFixed(1)}¢ (implied ${(fillPx * 100).toFixed(1)}%)\n` +
                `*Edge:* +${(edge * 100).toFixed(1)}pp vs market\n` +
                `*Size:* $${agent.polymarketMaxSizeUsdc.toFixed(0)} USDC\n` +
                `*Conviction:* ${(decision.conviction * 100).toFixed(0)}%\n\n` +
                `💭 ${(decision.reasoning ?? '').slice(0, 240)}`
              bot.api.sendMessage(tg, msg, { parse_mode: 'Markdown' }).catch(() => {})
            }
          }
        } catch (notifyErr) {
          // Notification failures must never affect trading. Log only.
          console.warn(
            `[polymarketAgent] notify failed for ${agent.id}:`,
            (notifyErr as Error).message,
          )
        }
      } else {
        ordersSkipped++
        await logDecision(agent, event, market, decision, {
          edge, sidePrice,
          execution: `order_failed ${result.error?.slice(0, 200) ?? 'unknown'}`,
        })
      }
    }
  }

  return { ordersPlaced, ordersSkipped }
}

// ─────────────────────────────────────────────────────────────────────────
// Score a single (event, market) with the shared prediction-market brain.
// Polymarket-specific work here = computing executable YES/NO prices from
// the order book; the LLM scoring itself is venue-agnostic and lives in
// predictionBrain.ts so 42.space gets the same judgement.
// ─────────────────────────────────────────────────────────────────────────
async function scoreMarket(event: PolymarketEvent, market: PolymarketMarket): Promise<AgentDecision> {
  const yesPrice = market.bestAsk ?? market.outcomePrices[0] ?? 0.5
  const noPrice  = market.outcomes[1]
    ? (market.bestBid !== null ? 1 - market.bestBid : (market.outcomePrices[1] ?? 0.5))
    : 1 - yesPrice

  return scorePredictionMarket({
    venue:       'polymarket',
    eventTitle:  event.title,
    question:    market.question,
    description: market.description,
    endDateIso:  market.endDate,
    outcomes:    market.outcomes,
    yesPrice,
    noPrice,
    volume24h:   event.volume24hr ?? null,
    liquidity:   market.liquidity ?? null,
  })
}

// Re-export so callers that imported parseDecision from this module
// continue to compile against the shared parser in predictionBrain.
const parseDecision = parsePredictionDecision
void parseDecision

// ─────────────────────────────────────────────────────────────────────────
// Brain-feed log helper. Always writes — even SKIPs. The mini-app brain
// feed displays exchange='polymarket' rows with a POLY chip so the user
// sees what their agent is thinking even when it doesn't trade.
// ─────────────────────────────────────────────────────────────────────────
async function logDecision(
  agent: PolymarketAgentRow,
  event: PolymarketEvent | null,
  market: PolymarketMarket | null,
  decision: AgentDecision,
  extras: { edge?: number; sidePrice?: number; execution?: string } = {},
) {
  try {
    const builder = getBuilderCode()
    const pair = market?.question?.slice(0, 80) ?? event?.title?.slice(0, 80) ?? null
    const reasonParts: string[] = []
    if (extras.execution) reasonParts.push(extras.execution)
    reasonParts.push(`${decision.action} ${decision.side} (conv ${decision.conviction.toFixed(2)})`)
    if (typeof extras.edge === 'number') reasonParts.push(`edge ${(extras.edge * 100).toFixed(1)}%`)
    reasonParts.push(decision.reasoning)
    if (builder) reasonParts.push(`builder=${builder.slice(0, 12)}`)

    await db.agentLog.create({
      data: {
        agentId:         agent.id,
        userId:          agent.userId,
        action:          decision.action === 'BUY' ? 'polymarket_buy' : 'polymarket_skip',
        rawResponse:     null,
        parsedAction:    `${decision.action}_${decision.side}`,
        executionResult: extras.execution ?? null,
        error:           null,
        pair,
        price:           extras.sidePrice ?? null,
        reason:          reasonParts.join(' · ').slice(0, 500),
        adx:             null,
        rsi:             null,
        score:           Math.round(decision.conviction * 100),
        regime:          null,
        exchange:        'polymarket',
      },
    })
  } catch (err) {
    console.warn('[polymarketAgent] logDecision failed:', (err as Error).message)
  }
}
