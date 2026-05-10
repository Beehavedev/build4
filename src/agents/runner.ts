import cron from 'node-cron'
import { db } from '../db'
import { runAgentTick } from './tradingAgent'
import { Bot } from 'grammy'
import { buildAlignmentBar } from './indicators'

let botRef: Bot | null = null
const runningAgents = new Set<string>()

export function getBot(): Bot | null {
  return botRef
}

// Escape every reserved character for Telegram's MarkdownV2 parser.
//
// Per Telegram docs (https://core.telegram.org/bots/api#markdownv2-style),
// these characters MUST be backslash-escaped anywhere outside an explicit
// markup token: `_ * [ ] ( ) ~ ` > # + - = | { } . !`. We additionally
// escape `\` itself so a stray backslash in user data (rare but possible
// in market titles, error strings, etc.) doesn't accidentally consume
// the next character.
//
// Why this matters: the previous version only escaped 5 chars
// (_ * ` [ ]), which is enough for hand-written messages but breaks
// instantly the moment user-supplied data contains a paren, dash, or
// dot — e.g. a 42.space prediction-market title like "UEFA Champions
// League Winner 2025/26?" or a Hyperliquid pair like "BTC-PERP". When
// Telegram rejects the message with 400 the per-call `try { } catch {}`
// at the send site silently swallows it, and the user sees zero
// heartbeats from that venue. This was the actual cause behind
// "Aster heartbeats arrive but HL/42 don't show up in chat".
//
// Callers must apply escapeMd ONLY to raw user data — never to strings
// that already contain intentional MarkdownV2 markup (`*bold*`, `_it_`,
// etc.). Pre-escaped sequences like `\\.` written into the surrounding
// template are fine because escapeMd is never called on them.
export function escapeMd(s: string): string {
  return (s ?? '').replace(/([\\_*\[\]()~`>#+\-=|{}.!])/g, '\\$1')
}

// Tracks how many ticks each agent has run since (re-)activation, so we can
// send "verbose" tick summaries for the first few ticks and then go quiet.
const ticksSinceActivation = new Map<string, number>()
const lastTickSummaryAt    = new Map<string, number>()

export function noteAgentActivated(agentId: string) {
  ticksSinceActivation.set(agentId, 0)
  lastTickSummaryAt.delete(agentId)
}
export function noteAgentTicked(agentId: string) {
  ticksSinceActivation.set(agentId, (ticksSinceActivation.get(agentId) ?? 0) + 1)
}
export function getTickCount(agentId: string): number {
  return ticksSinceActivation.get(agentId) ?? 0
}
export function shouldSendSummary(agentId: string, hasAction: boolean, bestScore: number): boolean {
  const tickN = getTickCount(agentId)
  if (tickN <= 3) return true              // first 3 ticks always verbose
  if (hasAction) return true               // any OPEN/CLOSE always
  const last = lastTickSummaryAt.get(agentId) ?? 0
  const FIVE_MIN = 5 * 60 * 1000
  if (Date.now() - last < FIVE_MIN) return false
  return bestScore >= 6                    // only "near-miss" HOLDs after warmup
}
export function markSummarySent(agentId: string) {
  lastTickSummaryAt.set(agentId, Date.now())
}

// Per-(agent, pair, kind) Telegram cooldown. Without this, an agent
// whose AUTO scan keeps surfacing the same low-quality pair (e.g. a
// recently-listed coin with no usable indicator data) spams the user
// with the *identical* notification every minute. The cooldown lets
// the first analysis through, then suppresses repeats for the same
// (agent, pair) for ten minutes.
//
// `kind` separates "analyzed" from "skipped" so a single tick that
// produces BOTH messages (an OPEN decision that then trips a risk
// gate) can still surface both — once. Without separating them, the
// analyzed message would mark the cooldown and the paired skip
// reason would be silently swallowed for ten minutes, which exactly
// reverses the "the user must always see why a decision didn't fill"
// invariant of the skip notification.
//
// Action notifications (trade opened / closed) bypass this entirely
// because they go through notifyTradeOpened in this same module.
const lastPairNotifyAt = new Map<string, number>()
const PAIR_NOTIFY_COOLDOWN_MS = 10 * 60 * 1000
// Heartbeat ("I scanned but nothing scored high enough") gets a longer
// cooldown than the per-pair analyzed/skipped cap. Without the heartbeat,
// a venue with a small focus list (e.g. Hyperliquid's 14-pair curated
// universe) goes completely silent during quiet markets and looks broken
// from the user's side. With it, the user gets a "still alive, nothing
// to do" pulse every half hour per (agent, venue) — enough to confirm
// the runner is dispatching, not so often that it becomes noise.
const HEARTBEAT_COOLDOWN_MS = 30 * 60 * 1000
type PairNotifyKind = 'analyzed' | 'skipped' | 'heartbeat'
export function shouldSendPairNotification(agentId: string, pair: string, kind: PairNotifyKind): boolean {
  const key = `${agentId}:${pair}:${kind}`
  const last = lastPairNotifyAt.get(key) ?? 0
  const cooldown = kind === 'heartbeat' ? HEARTBEAT_COOLDOWN_MS : PAIR_NOTIFY_COOLDOWN_MS
  if (Date.now() - last < cooldown) return false
  return true
}
export function markPairNotificationSent(agentId: string, pair: string, kind: PairNotifyKind): void {
  lastPairNotifyAt.set(`${agentId}:${pair}:${kind}`, Date.now())
}

export function initRunner(bot: Bot) {
  botRef = bot

  // Main tick — every 60 seconds
  cron.schedule('* * * * *', async () => {
    await runAllAgents()
  })

  // Daily summary — 09:00 UTC
  cron.schedule('0 9 * * *', async () => {
    await sendDailySummaries()
  })

  // Proactive alerts — every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    await checkProactiveAlerts()
  })

  // Breaking-news monitor — every 60 seconds. The fetchNewsSignal()
  // call inside is itself 60s-cached and shared across all agents,
  // so this is a single Claude call/min globally.
  startNewsMonitor()

  // Listing/delisting monitor — polls Aster exchangeInfo every 60s and
  // alerts every active-agent owner when a new pair lists or an existing
  // pair enters reduce-only / delists. Detects within 60s of Aster's own
  // tweet — gives BUILD4 agents a real edge over manual traders.
  startListingMonitor()

  // Swarm divergence watch — daily at 09:15 UTC. Computes the no-quorum
  // fallback rate per pair over the last N days and pings admins via
  // Telegram if any pair (with enough sample) crosses the threshold. This
  // is the scheduled equivalent of `tsx scripts/swarmDivergence.ts
  // --threshold N`. Configure with SWARM_DIVERGENCE_* env vars and
  // ADMIN_TELEGRAM_IDS (see src/services/adminAlerts.ts).
  cron.schedule(process.env.SWARM_DIVERGENCE_CRON ?? '15 9 * * *', async () => {
    await runSwarmDivergenceWatch()
  })

  // Polymarket autonomous agent (Phase 3). Independent of the perp
  // tick — a Polymarket agent only acts on markets, never on perps. We
  // tick every 60s; the agent itself enforces a per-row min interval so
  // an over-eager runner can't double-fire. Single-flight via
  // `polymarketTickInflight` so a slow LLM round trip can't pile up.
  // Phase 4 (2026-05-03): always log the sweep result (not just when
  // scanned>0), so a user reporting "Polymarket isn't running for my
  // agent" can be debugged from Render logs alone — the line tells us
  // whether the sweep is firing AND whether it found the agent.
  const tickPolymarket = async () => {
    if (polymarketTickInflight) {
      console.log('[polymarketAgent] previous tick still running, skipping')
      return
    }
    polymarketTickInflight = true
    try {
      const { tickAllPolymarketAgents } = await import('./polymarketAgent')
      const r = await tickAllPolymarketAgents()
      console.log(`[polymarketAgent] scanned=${r.scanned} ticked=${r.ticked} placed=${r.ordersPlaced} skipped=${r.ordersSkipped} errors=${r.errors}`)
    } catch (err) {
      console.error('[polymarketAgent] sweep failed:', (err as Error).message)
    } finally {
      polymarketTickInflight = false
    }
  }
  // Kick the first sweep immediately on boot so users don't wait the
  // full 60s after a Render deploy to see Polymarket activity start.
  // Defer by 5s to let the rest of initRunner finish wiring up first.
  setTimeout(tickPolymarket, 5_000)
  setInterval(tickPolymarket, 60_000)

  // Module 4 — autonomous four.meme token launches. Independent of every
  // other tick: a launch agent only creates new tokens, never trades.
  // Master kill-switch is FOUR_MEME_AGENT_LAUNCH_ENABLED (checked inside
  // tickAllFourMemeLaunchAgents) on top of the existing FOUR_MEME_ENABLED
  // and FOUR_MEME_LAUNCH_ENABLED flags. Single-flight via the inflight
  // guard so a slow LLM round-trip + on-chain createToken (which can take
  // 30s+) can't pile up. Per-agent caps (1 launch/day, 0.05 BNB/launch)
  // live inside the agent module.
  const tickFourMemeLaunch = async () => {
    if (fourMemeLaunchTickInflight) {
      console.log('[fourMemeLaunchAgent] previous tick still running, skipping')
      return
    }
    fourMemeLaunchTickInflight = true
    try {
      const { tickAllFourMemeLaunchAgents } = await import('./fourMemeLaunchAgent')
      const r = await tickAllFourMemeLaunchAgents()
      console.log(
        `[fourMemeLaunchAgent] scanned=${r.scanned} ticked=${r.ticked} ` +
          `launched=${r.launchesAttempted} skipped=${r.launchesSkipped} errors=${r.errors}`,
      )
    } catch (err) {
      console.error('[fourMemeLaunchAgent] sweep failed:', (err as Error).message)
    } finally {
      fourMemeLaunchTickInflight = false
    }
  }
  setTimeout(tickFourMemeLaunch, 7_000)
  setInterval(tickFourMemeLaunch, 60_000)

  // ── BUILD4 × 42.space "Agent vs Community" 48h campaign ──────────────
  // 12 rounds of BTC 8h Price Markets, one round per 4h UTC boundary
  // (00/04/08/12/16/20). For each round we fire 4 ticks:
  //   ENTRY      = boundary + 5min   (always trades $50 — no skip)
  //   REASSESS_1 = boundary + 1h30m  (HOLD/DOUBLE_DOWN/SPREAD)
  //   REASSESS_2 = boundary + 3h     (HOLD/DOUBLE_DOWN/SPREAD)
  //   FINAL      = boundary + 3h45m  (last call before market locks)
  //
  // All cron strings are explicit UTC. Gated on FT_CAMPAIGN_MODE=true so
  // the scheduler is a complete no-op for any deploy that doesn't set the
  // env. The runCampaignTick() function itself short-circuits if the
  // campaign agent isn't found, so accidental enables can't trade.
  if (process.env.FT_CAMPAIGN_MODE === 'true') {
    let campaignTickInflight = false
    const fireCampaignTick = async (tick: 'ENTRY' | 'REASSESS_1' | 'REASSESS_2' | 'FINAL') => {
      if (campaignTickInflight) {
        console.warn(`[fortyTwoCampaign] previous tick still running, skipping ${tick}`)
        return
      }
      campaignTickInflight = true
      try {
        const { runCampaignTick } = await import('../services/fortyTwoCampaign')
        const r = await runCampaignTick(tick)
        if (r.ok) {
          console.log(
            `[fortyTwoCampaign] ${tick} OK: market=${r.marketAddress ?? '-'} ` +
              `bucket=${r.bucketIndex ?? '-'} positionId=${r.positionId ?? '-'}`,
          )
        } else {
          console.warn(`[fortyTwoCampaign] ${tick} no-trade: ${r.reason ?? 'unknown'}`)
        }
      } catch (err) {
        console.error(`[fortyTwoCampaign] ${tick} crashed:`, (err as Error).message)
      } finally {
        campaignTickInflight = false
      }
    }
    const cronOpts = { timezone: 'UTC' as const }
    cron.schedule('5 0,4,8,12,16,20 * * *',  () => { void fireCampaignTick('ENTRY') },      cronOpts)
    cron.schedule('30 1,5,9,13,17,21 * * *', () => { void fireCampaignTick('REASSESS_1') }, cronOpts)
    cron.schedule('0 3,7,11,15,19,23 * * *', () => { void fireCampaignTick('REASSESS_2') }, cronOpts)
    cron.schedule('45 3,7,11,15,19,23 * * *',() => { void fireCampaignTick('FINAL') },      cronOpts)
    console.log(
      '[Runner] 42.space campaign scheduler ARMED — ENTRY +5m, REASSESS +1h30m/+3h, FINAL +3h45m past every 4h UTC boundary',
    )
  }

  console.log('[Runner] Agent runner initialized')
}

// In-flight guard for the Polymarket autonomous sweep. The sweep is
// parallel-friendly internally, but we never want two concurrent sweeps
// because they'd contend for the same polymarketCreds rows + LLM quota.
let polymarketTickInflight = false

// In-flight guard for the four.meme launch agent sweep. createToken
// can take 30s+ on-chain — we never want a second sweep to start one
// before the first finishes, since both would race the daily-cap read.
let fourMemeLaunchTickInflight = false

// ── Swarm divergence watch ─────────────────────────────────────────
async function runSwarmDivergenceWatch() {
  const days      = Math.max(1, parseInt(process.env.SWARM_DIVERGENCE_DAYS      ?? '1',  10) || 1)
  const threshold = parseFloat(process.env.SWARM_DIVERGENCE_THRESHOLD ?? '50')
  const minSample = Math.max(1, parseInt(process.env.SWARM_DIVERGENCE_MIN_SAMPLE ?? '20', 10) || 20)

  if (!Number.isFinite(threshold) || threshold <= 0) {
    console.log('[SwarmDivergence] SWARM_DIVERGENCE_THRESHOLD invalid/disabled, skipping watch.')
    return
  }

  try {
    const { analyzeDivergence, MissingProvidersColumnError } = await import('../swarm/divergenceAnalysis')
    const { sendAdminAlert, hasAdminTargets } = await import('../services/adminAlerts')

    let result
    try {
      result = await analyzeDivergence({ days, threshold, minSample })
    } catch (err) {
      if (err instanceof MissingProvidersColumnError) {
        // Brand-new DB without the swarm-telemetry columns — nothing to report.
        console.log('[SwarmDivergence] Skipping watch: AgentLog.providers column missing.')
        return
      }
      throw err
    }

    console.log(
      `[SwarmDivergence] ${result.overall.total} swarm ticks in last ${days}d, ` +
      `${result.overall.fallback} no-quorum (${result.overall.fallbackPct}%), ` +
      `${result.offenders.length} pair(s) over ${threshold}% threshold (min sample ${minSample}).`
    )

    if (result.offenders.length === 0) return

    if (!hasAdminTargets()) {
      console.warn('[SwarmDivergence] Threshold breached but ADMIN_TELEGRAM_IDS not set — alert dropped.')
      return
    }

    const lines = result.offenders
      .slice(0, 10)
      .map((o) => `• \`${escapeMd(o.pair)}\`: *${o.fallbackPct}%* no-quorum across ${o.total} ticks`)
    const more = result.offenders.length > 10 ? `\n…and ${result.offenders.length - 10} more` : ''
    const text =
      `🐝 *Swarm divergence alert*\n` +
      `Window: last ${days}d (since ${result.sinceIso})\n` +
      `Threshold: ${threshold}% no-quorum, min sample ${minSample}\n\n` +
      `Overall: ${result.overall.fallback}/${result.overall.total} ticks fell back ` +
      `(${result.overall.fallbackPct}%)\n\n` +
      `*Offending pair(s):*\n${lines.join('\n')}${more}\n\n` +
      `Run \`tsx scripts/swarmDivergence.ts --days ${days} --threshold ${threshold} --min-sample ${minSample}\` ` +
      `for the full breakdown.`

    const res = await sendAdminAlert(botRef, text)
    console.log(`[SwarmDivergence] Alert sent to ${res.sent}/${res.attempted} admins (${res.failed} failed).`)
  } catch (err: any) {
    console.error('[SwarmDivergence] Watch error:', err?.message ?? err)
  }
}

// Telegram throttle — Bot API allows ~30 msg/sec globally. We pace at
// 25 msg/sec (40ms gap) for headroom; below the FloodWait threshold.
async function broadcastThrottled(
  userIds: Array<bigint | string | number>,
  text: string
): Promise<{ sent: number; blocked: number }> {
  if (!botRef || userIds.length === 0) return { sent: 0, blocked: 0 }
  let sent = 0
  let blocked = 0
  for (const id of userIds) {
    try {
      await botRef.api.sendMessage(id.toString(), text, { parse_mode: 'Markdown' })
      sent++
    } catch {
      blocked++
    }
    await new Promise((r) => setTimeout(r, 40))
  }
  return { sent, blocked }
}

// ── Listing monitor ────────────────────────────────────────────────
async function listingMonitorTick() {
  if (!botRef) return
  try {
    const { checkForListingChanges } = await import('../services/listingDetector')
    const events = await checkForListingChanges()
    if (events.length === 0) return

    // Resolve once: distinct telegram IDs of users with at least one
    // active agent. Cheaper than the nested {agents:{some:...}} filter
    // because Agent.isActive is indexed.
    let activeUserIds: bigint[] = []
    if (events.some((e) => e.type === 'NEW_LISTING')) {
      const rows = await db.agent.findMany({
        where: { isActive: true },
        select: { user: { select: { telegramId: true } } },
        distinct: ['userId']
      })
      activeUserIds = Array.from(new Set(rows.map((r) => r.user.telegramId)))
    }

    for (const ev of events) {
      if (ev.type === 'NEW_LISTING') {
        const text =
          `🚀 *NEW LISTING DETECTED*\n\n` +
          `*${escapeMd(ev.symbol)}* just listed on Aster.\n\n` +
          `Your AI agents are scanning it now. New listings often move ` +
          `50-200% in the first hour.\n\n` +
          `📊 BUILD4 detected this within 60 seconds.`
        const { sent } = await broadcastThrottled(activeUserIds, text)
        console.log(`[Listing] Alerted ${sent}/${activeUserIds.length} users about ${ev.symbol}`)
      } else if (ev.type === 'REDUCE_ONLY' || ev.type === 'DELISTING') {
        // Only alert users with open positions in this specific pair —
        // case-insensitive match because some agents store the pair as
        // 'ETHUSDT' and others as 'ETH/USDT'.
        const sym = ev.symbol
        const positions = await db.trade.findMany({
          where: {
            status: 'open',
            OR: [{ pair: sym }, { pair: sym.replace('USDT', '/USDT') }]
          },
          include: { agent: { include: { user: { select: { telegramId: true } } } } }
        })
        const uniq = new Map<string, bigint>()
        for (const p of positions) {
          if (!p.agent) continue
          uniq.set(p.agent.user.telegramId.toString(), p.agent.user.telegramId)
        }
        if (uniq.size === 0) {
          console.log(`[Listing] ${ev.type} ${sym} — no open positions, no alert`)
          continue
        }
        const text =
          `⚠️ *${ev.type === 'DELISTING' ? 'DELISTED' : 'REDUCE-ONLY'} — ${escapeMd(sym)}*\n\n` +
          `Aster ${ev.type === 'DELISTING' ? 'has removed' : 'is winding down'} this pair.\n` +
          `You have an open position.\n\n` +
          `Your agent will close it on the next tick. Funds are safe.`
        const { sent } = await broadcastThrottled(Array.from(uniq.values()), text)
        console.log(`[Listing] ${ev.type} ${sym}: alerted ${sent} position holder(s)`)
      }
    }
  } catch (err: any) {
    console.error('[Listing] Monitor error:', err?.message ?? err)
  }
}

function startListingMonitor() {
  // Cold-start scan immediately so the baseline is loaded; subsequent
  // ticks emit real events. The first call always returns [] by design.
  setTimeout(async () => {
    try {
      const { checkForListingChanges } = await import('../services/listingDetector')
      await checkForListingChanges()
      console.log('[Listing] Baseline pair set captured')
    } catch (e: any) {
      console.error('[Listing] Baseline scan failed:', e?.message ?? e)
    }
  }, 5_000)
  setInterval(listingMonitorTick, 60_000)
}

// ── News monitor ───────────────────────────────────────────────────
// Polls the shared news signal and pushes a Telegram alert to every
// active-agent owner when a HIGH-impact breaking event lands. The
// throttle below prevents the same headline from being broadcast more
// than once.
let lastBroadcastedHeadline = ''

async function newsMonitorTick() {
  if (!botRef) return
  try {
    const { fetchNewsSignal } = await import('../services/newsIntelligence')
    const signal = await fetchNewsSignal()
    if (Math.abs(signal.score) < 7) return
    if (!signal.isBreaking) return
    if (!signal.topHeadline || signal.topHeadline === lastBroadcastedHeadline) return
    lastBroadcastedHeadline = signal.topHeadline

    const activeUsers = await db.user.findMany({
      where: { agents: { some: { isActive: true } } },
      select: { telegramId: true }
    })

    const emoji = signal.score > 0 ? '🚀' : '🚨'
    const direction = signal.score > 0 ? 'BULLISH' : 'BEARISH'
    const affected = signal.affectedCoins.length > 0 ? signal.affectedCoins.join(', ') : 'broad market'
    const text =
      `${emoji} *BREAKING NEWS ALERT*\n\n` +
      `${escapeMd(signal.topHeadline)}\n\n` +
      `Market Impact: *${direction}* (${signal.score}/10)\n` +
      `Your agents are adjusting strategy automatically.\n\n` +
      `Affected: ${escapeMd(affected)}`

    for (const u of activeUsers) {
      try {
        await botRef.api.sendMessage(u.telegramId.toString(), text, { parse_mode: 'Markdown' })
      } catch {
        // user blocked bot, etc.
      }
    }
    console.log(`[News] Broadcast "${signal.topHeadline.slice(0, 60)}" to ${activeUsers.length} users`)
  } catch (err: any) {
    console.error('[News] Monitor error:', err?.message ?? err)
  }
}

function startNewsMonitor() {
  setInterval(newsMonitorTick, 60_000)
  // First check after 10s so we don't block startup.
  setTimeout(newsMonitorTick, 10_000)
}

// Stagger config — at 50 agents/sec we can drain ~3,000 agents/min.
// Anything more than that overflows the 60s cron window and the in-flight
// set will skip the next tick (which is fine — it just means slower tickers
// for very large active populations).
const TICK_BATCH_SIZE   = 50
const TICK_BATCH_GAP_MS = 1_000

// Filter at the DB level: only tick agents whose owner has onboarded to
// AT LEAST ONE supported venue. Agents created during onboarding but
// never activated would otherwise burn 1 LLM call/min forever. With
// 9k+ agents and Claude pricing, that's the difference between $200/day
// and $200k/day. The OR covers both venues — a user who only finished
// the Hyperliquid handshake should still have their HL-targeting agents
// tick (and vice versa for Aster). Per-venue execution dispatch happens
// inside `executeOpen` / `executeClose` based on `agent.exchange`.
//
// Exported so a structural test can guard the shape against future
// regressions (e.g. someone tightening it back to Aster-only and
// silently locking out HL traffic).
export const ACTIVE_AGENTS_FILTER = {
  isActive: true,
  isPaused: false,
  user: {
    OR: [
      { asterOnboarded:        true },
      { hyperliquidOnboarded:  true },
    ],
  },
} as const

async function runAllAgents() {
  try {
    // Pull the per-user venue allow flags alongside the agent rows so we
    // can gate dispatch on `User.{aster|hyperliquid}AgentTradingEnabled`
    // without an N+1 round-trip per agent. Selecting only the booleans
    // keeps the per-row payload tiny on the 9k+ agents table.
    const activeAgents = await db.agent.findMany({
      where: ACTIVE_AGENTS_FILTER,
      include: {
        user: {
          select: {
            asterAgentTradingEnabled: true,
            hyperliquidAgentTradingEnabled: true,
          },
        },
      },
    })

    if (activeAgents.length === 0) {
      console.log('[Runner] No active onboarded agents, skipping tick')
      return
    }

    // Multi-venue dispatch (Phase 1, 2026-04-28). Each agent now has an
    // `enabledVenues` array. We expand into (agent × venue) tick units —
    // each unit is an independent scan + decision + execute pass against
    // that one venue. The trading agent reads `agent.exchange` for venue
    // routing throughout, so we clone the agent row per venue with
    // `exchange` set to the venue being processed. No deeper signature
    // change required — the cloned read travels naturally through
    // executeOpen/executeClose's existing branches.
    //
    // Backfilled rows have enabledVenues = [exchange] so behaviour is
    // unchanged for users who haven't opted in to additional venues.
    type TickUnit = { agent: typeof activeAgents[number]; venue: string }
    const tickUnits: TickUnit[] = []
    let skippedNoVenue = 0
    for (const agent of activeAgents) {
      const venues = Array.isArray((agent as any).enabledVenues) && (agent as any).enabledVenues.length > 0
        ? (agent as any).enabledVenues as string[]
        // Defensive fallback for any row that escaped the boot-time
        // backfill (NULL or empty enabledVenues): treat as single-venue
        // on the legacy `exchange` column. Without this an upgrade could
        // silently mute every legacy agent for one tick.
        : [agent.exchange]
      if (venues.length === 0) {
        skippedNoVenue++
        continue
      }
      for (const venue of venues) {
        // Phase 4 (2026-05-02) — 'polymarket' is handled by a SEPARATE
        // runner loop (tickAllPolymarketAgents, see setInterval above)
        // that reads real prediction markets via the Gamma API and
        // writes brain-feed rows tagged with the market QUESTION text.
        // The perp brain (tradingAgent.ts) below would otherwise run its
        // ADX/RSI/funding-rate pipeline on crypto perp tickers and stamp
        // them with exchange='polymarket', producing nonsense POLY-tagged
        // entries like "HOLD ARBUSDT — Funding rate 0.0000%". Skip here
        // so the dedicated polymarket runner is the only writer for
        // exchange='polymarket' brain logs.
        if (venue === 'polymarket') continue
        tickUnits.push({ agent, venue })
      }
    }

    console.log(`[Runner] Ticking ${activeAgents.length} agents → ${tickUnits.length} (agent×venue) units in batches of ${TICK_BATCH_SIZE}`)
    const tickStart = Date.now()
    let dispatched = 0
    let skippedInflight = 0
    let skippedVenueDisabled = 0

    for (let i = 0; i < tickUnits.length; i += TICK_BATCH_SIZE) {
      const batch = tickUnits.slice(i, i + TICK_BATCH_SIZE)

      for (const { agent, venue } of batch) {
        // Per-user platform allow check, now indexed by THIS unit's venue
        // (not agent.exchange). A user pausing "all my Hyperliquid agents"
        // mutes the HL slice of every dual-venue agent without touching
        // the Aster slice — exactly the granularity the platform toggles
        // on the mini app are meant to provide.
        const venueAllowed =
          (venue === 'aster'       && agent.user?.asterAgentTradingEnabled       !== false) ||
          (venue === 'hyperliquid' && agent.user?.hyperliquidAgentTradingEnabled !== false) ||
          // 42.space and any other non-perp venue have no per-user pause
          // flag yet — implicit allow until Phase 2 introduces one.
          (venue !== 'aster' && venue !== 'hyperliquid')
        if (!venueAllowed) {
          skippedVenueDisabled++
          continue
        }

        // In-flight key is (agentId, venue) so the Aster slice and HL
        // slice of the same agent can run concurrently within a tick.
        // Without this scoping the second venue would be skipped until
        // the first finished — defeating the parallel-venue model.
        const inflightKey = `${agent.id}:${venue}`
        if (runningAgents.has(inflightKey)) {
          skippedInflight++
          continue
        }
        runningAgents.add(inflightKey)

        // Strip the join + override `exchange` to the per-unit venue.
        // Downstream tradingAgent.ts reads agent.exchange for routing,
        // open-trade venue filters, log lines, executeOpen branches —
        // every one of those resolves naturally to this venue.
        const { user: _u, ...plainAgent } = agent as any
        const unitAgent = { ...plainAgent, exchange: venue }
        runAgentTick(unitAgent)
          .catch((err) => console.error(`[Runner] Agent ${agent.name} (${venue}) error:`, err?.message ?? err))
          .finally(() => runningAgents.delete(inflightKey))
        dispatched++
      }

      // Pace the next batch only if there is one.
      if (i + TICK_BATCH_SIZE < tickUnits.length) {
        await new Promise((r) => setTimeout(r, TICK_BATCH_GAP_MS))
      }
    }

    const elapsed = ((Date.now() - tickStart) / 1000).toFixed(1)
    console.log(`[Runner] Dispatched ${dispatched} ticks in ${elapsed}s (${skippedInflight} skipped — still in flight, ${skippedVenueDisabled} skipped — venue paused by user, ${skippedNoVenue} skipped — no venues enabled)`)
  } catch (err) {
    console.error('[Runner] Error fetching agents:', err)
  }
}

async function checkProactiveAlerts() {
  if (!botRef) return

  try {
    const openTrades = await db.trade.findMany({
      where: { status: 'open' },
      include: { agent: true, user: true }
    })

    for (const trade of openTrades) {
      if (!trade.agent) continue

      // Check signals stored in signalsUsed for stop loss proximity
      const signals = trade.signalsUsed as any
      if (!signals?.stopLoss || !signals?.takeProfit) continue

      // Mock: in production, fetch real current price
      // For now just check time-based alerts
      const openMinutes = (Date.now() - trade.openedAt.getTime()) / 60000

      // Alert if position has been open >4 hours without closure
      if (openMinutes > 240 && openMinutes < 245) {
        try {
          await botRef.api.sendMessage(
            trade.user.telegramId.toString(),
            `⏰ *Position Alert — ${escapeMd(trade.agent.name)}*\n\n${trade.pair} ${trade.side} has been open for 4 hours.\nEntry: $${trade.entryPrice.toFixed(2)}\n\nConsider reviewing this position.`,
            { parse_mode: 'Markdown' }
          )
        } catch (e) {
          // User may have blocked bot
        }
      }
    }
  } catch (err) {
    console.error('[Runner] Proactive alerts error:', err)
  }
}

async function sendDailySummaries() {
  if (!botRef) return

  try {
    const agents = await db.agent.findMany({
      where: { isActive: true },
      include: { user: true }
    })

    const todayStart = new Date()
    todayStart.setUTCHours(0, 0, 0, 0)
    todayStart.setUTCDate(todayStart.getUTCDate() - 1)

    for (const agent of agents) {
      try {
        const todayTrades = await db.trade.findMany({
          where: {
            agentId: agent.id,
            status: 'closed',
            closedAt: { gte: todayStart }
          }
        })

        const opensToday = await db.trade.count({
          where: { agentId: agent.id, openedAt: { gte: todayStart } }
        })
        const scansToday = await db.agentLog.count({
          where: { agentId: agent.id, createdAt: { gte: todayStart }, pair: { not: null } }
        })

        if (todayTrades.length === 0 && opensToday === 0 && scansToday === 0) continue

        const todayPnl = todayTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0)
        const wins = todayTrades.filter((t) => (t.pnl ?? 0) > 0).length
        const winRate = todayTrades.length > 0 ? (wins / todayTrades.length) * 100 : 0

        // Best closed trade today
        const bestTrade = todayTrades.reduce<{ pair: string; side: string; pnl: number } | null>(
          (best, t) => {
            const p = t.pnl ?? 0
            return !best || p > best.pnl ? { pair: t.pair, side: t.side, pnl: p } : best
          },
          null
        )

        const emoji = todayPnl >= 0 ? '📈' : todayPnl < 0 ? '📉' : '📊'
        const today = new Date().toISOString().slice(0, 10)
        const status = agent.isActive && !agent.isPaused
          ? '🟢 Active and scanning'
          : agent.isPaused ? '⏸ Paused' : '⏹ Stopped'

        const bestLine = bestTrade && bestTrade.pnl > 0
          ? `\n*Best trade:* ${bestTrade.pair} ${bestTrade.side} ${bestTrade.pnl >= 0 ? '+' : ''}$${bestTrade.pnl.toFixed(2)}`
          : ''

        await botRef.api.sendMessage(
          agent.user.telegramId.toString(),
          `${emoji} *Daily Agent Report — ${today}*\n\n` +
          `*Agent:* ${escapeMd(agent.name)}\n` +
          `*Trades closed:* ${todayTrades.length} (${wins}W / ${todayTrades.length - wins}L)\n` +
          `*Positions opened:* ${opensToday}\n` +
          `*PnL today:* ${todayPnl >= 0 ? '+' : ''}$${todayPnl.toFixed(2)} USDT\n` +
          `*Win rate today:* ${winRate.toFixed(0)}%` +
          bestLine + `\n` +
          `*Pairs scanned:* ${scansToday} analyses\n\n` +
          `*Status:* ${status}\n\n` +
          `_All-time: ${agent.totalTrades} trades · ${agent.winRate.toFixed(0)}% win · ${agent.totalPnl >= 0 ? '+' : ''}$${agent.totalPnl.toFixed(2)}_`,
          { parse_mode: 'Markdown' }
        )
      } catch (e) {
        // User may have blocked bot
      }
    }
  } catch (err) {
    console.error('[Runner] Daily summaries error:', err)
  }
}

export function notifyTradeOpened(
  bot: Bot,
  telegramId: string,
  agentName: string,
  decision: any,
  fillPrice: number,
  finalSize: number
) {
  const side = decision.action === 'OPEN_LONG' ? '🟢 LONG' : '🔴 SHORT'
  const alignBar = buildAlignmentBar(decision.timeframeAlignment)
  const confBar =
    '█'.repeat(Math.round(decision.confidence * 10)) +
    '░'.repeat(10 - Math.round(decision.confidence * 10))

  const slPct = decision.stopLoss
    ? Math.abs(((fillPrice - decision.stopLoss) / fillPrice) * 100).toFixed(2)
    : '—'
  const tpPct = decision.takeProfit
    ? Math.abs(((decision.takeProfit - fillPrice) / fillPrice) * 100).toFixed(2)
    : '—'

  const msg = `🤖 *${escapeMd(agentName)}* opened a position

${side} *${decision.pair}* | ${decision.leverage}x leverage

*Entry:* $${fillPrice.toFixed(4)}
*Stop Loss:* $${decision.stopLoss?.toFixed(4) ?? '—'} (−${slPct}%)
*Take Profit:* $${decision.takeProfit?.toFixed(4) ?? '—'} (+${tpPct}%)
*Size:* $${finalSize.toFixed(0)} USDT
*R/R Ratio:* ${decision.riskRewardRatio?.toFixed(1) ?? '—'}:1

*Market Regime:* ${decision.regime}
*Setup Score:* ${decision.setupScore}/10
*Timeframes:* ${alignBar}
*Confidence:* ${confBar} ${Math.round(decision.confidence * 100)}%

💭 *Why:*
${decision.reasoning}

${decision.keyRisks?.length > 0 ? `⚠️ *Risks:*\n${decision.keyRisks.map((r: string) => `• ${r}`).join('\n')}` : ''}`

  bot.api
    .sendMessage(telegramId, msg, { parse_mode: 'Markdown' })
    .catch(() => {})
}
