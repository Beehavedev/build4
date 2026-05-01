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
import { callLLM, type Provider } from '../services/inference'

// Provider preference — anthropic first, then degrade gracefully. We
// burn at most ONE provider per (agent × market) pair per tick; if the
// preferred provider is circuit-broken or missing creds, we try the
// next. This mirrors how `marketScan.ts` handles provider preference.
const PROVIDER_FALLBACK: Provider[] = ['anthropic', 'xai', 'hyperbolic']

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

interface AgentDecision {
  action:     'BUY' | 'SKIP'
  side:       'YES' | 'NO'
  conviction: number          // 0-1
  reasoning:  string          // <= 280 chars
}

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
  try {
    // Phase 4: pick up agents enabled via EITHER the legacy boolean OR the
    // newer per-agent enabledVenues array (driven by the venue chip in
    // Agent Studio). Either path opts the agent into autonomous Polymarket
    // trading; the per-market gates inside tickOneAgent (Safe deployed,
    // USDC funded, edge threshold met) still decide whether any single
    // tick actually places an order.
    // Phase 4 (2026-05-01) — also gate on the per-user
    // polymarketAgentTradingEnabled flag (mirrors the aster/HL pattern in
    // runner.ts). The check is done in JS rather than the SQL where-clause
    // because Prisma can't filter on a relation field with a default-true
    // boolean efficiently here, and the agent count is small.
    agents = await db.agent.findMany({
      where: {
        isActive: true,
        isPaused: false,
        OR: [
          { polymarketEnabled: true },
          { enabledVenues: { has: 'polymarket' } },
        ],
      },
      select: {
        id: true,
        userId: true,
        name: true,
        polymarketEnabled: true,
        polymarketMaxSizeUsdc: true,
        polymarketEdgeThreshold: true,
        lastPolymarketTickAt: true,
        predictionEdgeThreshold: true,
        predictionMaxDurationDays: true,
        enabledVenues: true,
        user: { select: { polymarketAgentTradingEnabled: true } },
      },
    }) as PolymarketAgentRow[]
    // Drop agents whose user has paused polymarket trading at the
    // platform level. Treat undefined / null as ALLOW so a missing
    // user record (shouldn't happen, but be defensive) does not
    // silently mute the venue.
    agents = agents.filter((a) => {
      const flag = (a as any).user?.polymarketAgentTradingEnabled
      return flag !== false
    })
  } catch (err) {
    console.error('[polymarketAgent] failed to load agents:', (err as Error).message)
    return { scanned, ticked, ordersPlaced, ordersSkipped, errors: errors + 1 }
  }

  scanned = agents.length
  if (agents.length === 0) return { scanned, ticked, ordersPlaced, ordersSkipped, errors }

  // Pull events ONCE for the whole sweep — every agent scores from the
  // same top-of-board snapshot so we don't multiply Gamma traffic by N.
  let events: PolymarketEvent[]
  try {
    events = await listEvents({ limit: 20, order: 'volume24hr' })
  } catch (err) {
    console.error('[polymarketAgent] listEvents failed:', (err as Error).message)
    return { scanned, ticked, ordersPlaced, ordersSkipped, errors: errors + 1 }
  }

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
      console.error(`[polymarketAgent] agent ${agent.id} tick failed:`, (err as Error).message)
    }
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

  // Make sure the user has Polymarket creds ready — this is idempotent
  // (no-ops once set up). If they haven't onboarded (no BSC wallet to
  // derive PK from), getOrCreateCreds throws and we log + bail.
  let walletAddress: string
  try {
    const c = await getOrCreateCreds(agent.userId)
    walletAddress = c.walletAddress
  } catch (err) {
    await logDecision(agent, null, null, {
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
    await logDecision(agent, null, null, {
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
    await logDecision(agent, null, null, {
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

  // Score the top events by 24h volume. Inside each event, score up to
  // MAX_MARKETS_PER_EVENT child markets (binary YES/NO sub-questions on
  // multi-outcome events). One LLM call per market → bounded cost per
  // tick: O(MAX_EVENTS_PER_TICK * MAX_MARKETS_PER_EVENT).
  const candidates = events
    .filter((e) => e.active && !e.closed && !e.archived && e.enableOrderBook)
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
// Score a single (event, market) with an LLM. Try providers in order
// until one returns parseable JSON or we exhaust the list.
// ─────────────────────────────────────────────────────────────────────────
async function scoreMarket(event: PolymarketEvent, market: PolymarketMarket): Promise<AgentDecision> {
  const yesPrice = market.bestAsk ?? market.outcomePrices[0] ?? 0.5
  const noPrice  = market.outcomes[1]
    ? (market.bestBid !== null ? 1 - market.bestBid : (market.outcomePrices[1] ?? 0.5))
    : 1 - yesPrice
  const endLabel = market.endDate ? new Date(market.endDate).toISOString().slice(0, 10) : 'unspecified'

  const system = [
    'You are a disciplined prediction-market trader analyzing a Polymarket binary outcome.',
    'You only place a trade when you have a real informational edge versus the market price.',
    'When the market price already reflects the available evidence, the correct action is SKIP.',
    'Your conviction is your subjective probability the chosen side resolves TRUE (0.0-1.0).',
    'Reply with STRICT JSON only — no prose, no markdown.',
  ].join(' ')

  const user = [
    `Event: ${event.title}`,
    `Market: ${market.question}`,
    `Description: ${(market.description ?? '').slice(0, 500)}`,
    `Resolution date: ${endLabel}`,
    `Outcomes: ${market.outcomes.join(' / ')}`,
    `YES priced at ${(yesPrice * 100).toFixed(1)}¢, NO priced at ${(noPrice * 100).toFixed(1)}¢`,
    `24h vol: $${Math.round(event.volume24hr || 0)}, liq: $${Math.round(market.liquidity || 0)}`,
    '',
    'Reply with JSON: {"action":"BUY"|"SKIP","side":"YES"|"NO","conviction":0.0-1.0,"reasoning":"<=240 chars"}',
  ].join('\n')

  let lastErr: Error | null = null
  for (const provider of PROVIDER_FALLBACK) {
    try {
      const r = await callLLM({
        provider,
        system,
        user,
        jsonMode: true,
        maxTokens: 300,
        temperature: 0.2,
        timeoutMs: 30_000,
      })
      const parsed = parseDecision(r.text)
      if (parsed) return parsed
      lastErr = new Error(`unparseable JSON from ${provider}`)
    } catch (err) {
      lastErr = err as Error
    }
  }
  throw lastErr ?? new Error('no providers available')
}

function parseDecision(raw: string): AgentDecision | null {
  if (!raw) return null
  // Some providers wrap JSON in code-fences even with jsonMode set.
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  let obj: any
  try { obj = JSON.parse(cleaned) } catch { return null }
  if (!obj || typeof obj !== 'object') return null
  const action = String(obj.action ?? '').toUpperCase()
  const side   = String(obj.side ?? '').toUpperCase()
  const conv   = Number(obj.conviction)
  if (action !== 'BUY' && action !== 'SKIP') return null
  if (side !== 'YES' && side !== 'NO') return null
  if (!Number.isFinite(conv) || conv < 0 || conv > 1) return null
  return {
    action,
    side,
    conviction: conv,
    reasoning:  String(obj.reasoning ?? '').slice(0, 280),
  }
}

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
