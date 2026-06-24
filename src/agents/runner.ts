import cron from 'node-cron'
import { db } from '../db'
import { runAgentTick } from './tradingAgent'
import { Bot } from 'grammy'
import { buildAlignmentBar } from './indicators'

let botRef: Bot | null = null
export const runningAgents = new Set<string>()

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

  // Aster+HL: true 90s setInterval (cron can't express sub-minute).
  setInterval(() => { void runAllAgents() }, 90_000)

  // 42.space regular (non-campaign) scan — dedicated */10 cron.
  const tickFortyTwo = async () => {
    if (fortyTwoTickInflight) return
    fortyTwoTickInflight = true
    try {
      const { tickAllFortyTwoAgents } = await import('./fortyTwoAgent')
      const r = await tickAllFortyTwoAgents()
      console.log(`[fortyTwoAgent] dispatched=${r.dispatched} skippedCampaign=${r.skippedCampaign} skippedInflight=${r.skippedInflight}`)
    } catch (err) {
      console.error('[fortyTwoAgent] sweep failed:', (err as Error).message)
    } finally {
      fortyTwoTickInflight = false
    }
  }
  cron.schedule('*/10 * * * *', tickFortyTwo)
  setTimeout(tickFortyTwo, 8_000)

  // 42.space auto-close stale positions — every 5 min. Closes open
  // prediction positions whose implied probability has dropped sharply
  // from entry, or that are within 2h of market end and losing, so agents
  // don't ride a low-probability outcome to a guaranteed loss. Owners are
  // notified per closure. Single-flight via `fortyTwoAutoCloseInflight`.
  const tickFortyTwoAutoClose = async () => {
    if (fortyTwoAutoCloseInflight) return
    fortyTwoAutoCloseInflight = true
    try {
      const { autoCloseStalePositions } = await import('../services/fortyTwoExecutor')
      const r = await autoCloseStalePositions()
      if (r.closed.length > 0 || r.errors.length > 0) {
        console.log(`[fortyTwoAutoClose] scanned=${r.scanned} closed=${r.closed.length} errors=${r.errors.length}`)
      }
      for (const c of r.closed) {
        await notifyPredictionAutoClosed(c)
      }
      for (const e of r.errors) {
        console.warn(`[fortyTwoAutoClose] close failed position=${e.positionId}: ${e.reason}`)
      }
    } catch (err) {
      console.error('[fortyTwoAutoClose] sweep failed:', (err as Error).message)
    } finally {
      fortyTwoAutoCloseInflight = false
    }
  }
  cron.schedule('*/5 * * * *', tickFortyTwoAutoClose)
  setTimeout(tickFortyTwoAutoClose, 12_000)

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

  // ── Task #149 — four.meme SNIPING (replaces the retired launch loop) ──
  // Agents no longer LAUNCH their own tokens. The autonomous launch
  // decision loop (tickAllFourMemeLaunchAgents) is intentionally NO LONGER
  // SCHEDULED — the module is kept only so the legacy dev-bag take-profit
  // sweep below and the manual /fourmeme launch command still resolve.
  //
  // Three new sweeps replace it, all gated by FOUR_MEME_ENABLED (+ the
  // snipe master switch FOUR_MEME_AGENT_SNIPE_ENABLED for the buy/exit
  // loops), each with its own single-flight guard:
  //   1. Scanner — discover + score fresh launches (no LLM, fast cadence).
  //   2. Snipe buy — buy top trusted curves for opted-in agents.
  //   3. Snipe exit — sell pre-migration / TP / SL / rug, or ride-through.
  const tickFourMemeScanner = async () => {
    if (fourMemeScannerTickInflight) return
    fourMemeScannerTickInflight = true
    try {
      const { tickFourMemeScanner } = await import('../services/fourMemeScanner')
      const r = await tickFourMemeScanner()
      if (r.discovered > 0 || r.buyable > 0 || r.errors > 0) {
        console.log(
          `[fourMemeScanner] discovered=${r.discovered} enriched=${r.enriched} ` +
            `buyable=${r.buyable} errors=${r.errors}`,
        )
      }
    } catch (err) {
      console.error('[fourMemeScanner] sweep failed:', (err as Error).message)
    } finally {
      fourMemeScannerTickInflight = false
    }
  }
  setTimeout(tickFourMemeScanner, 7_000)
  setInterval(tickFourMemeScanner, 15_000)

  const tickFourMemeSnipe = async () => {
    if (fourMemeSnipeTickInflight) return
    fourMemeSnipeTickInflight = true
    try {
      const { tickAllFourMemeSnipeAgents } = await import('./fourMemeSnipeAgent')
      const r = await tickAllFourMemeSnipeAgents()
      if (r.bought > 0 || r.errors > 0) {
        console.log(
          `[fourMemeSnipe] scanned=${r.scanned} ticked=${r.ticked} ` +
            `bought=${r.bought} skipped=${r.skipped} errors=${r.errors}`,
        )
      }
    } catch (err) {
      console.error('[fourMemeSnipe] sweep failed:', (err as Error).message)
    } finally {
      fourMemeSnipeTickInflight = false
    }
  }
  setTimeout(tickFourMemeSnipe, 11_000)
  setInterval(tickFourMemeSnipe, 20_000)

  const tickFourMemeSnipeExit = async () => {
    if (fourMemeSnipeExitTickInflight) return
    fourMemeSnipeExitTickInflight = true
    try {
      const { tickAllFourMemeSnipeExits } = await import('./fourMemeSnipeAgent')
      const r = await tickAllFourMemeSnipeExits()
      if (r.sold > 0 || r.errors > 0) {
        console.log(
          `[fourMemeSnipeExit] scanned=${r.scanned} evaluated=${r.evaluated} ` +
            `sold=${r.sold} errors=${r.errors}`,
        )
      }
    } catch (err) {
      console.error('[fourMemeSnipeExit] sweep failed:', (err as Error).message)
    } finally {
      fourMemeSnipeExitTickInflight = false
    }
  }
  setTimeout(tickFourMemeSnipeExit, 15_000)
  setInterval(tickFourMemeSnipeExit, 15_000)

  // ── Community Trading Fleet — 50 community-owned four.meme agents ─────
  // Two sweeps (open + exit), each single-flighted. Mock-first: gated
  // entirely by fleet_settings (global_paused/live_trading in the DB), so
  // the schedulers are safe to leave armed — a fresh deploy with the
  // default paused+mock settings does nothing until an admin flips it on
  // from /fleet. Per-agent cooldown/jitter/daily-limit/daily-loss gates
  // live inside the engine; this just dispatches the sweeps.
  const tickFleetOpen = async () => {
    if (fleetOpenTickInflight) return
    fleetOpenTickInflight = true
    try {
      // Refresh the panel's single-LLM brain selection once per tick so a
      // /fleet dropdown change takes effect without a redeploy.
      const { refreshSwarmSelection } = await import('./fleetBrain')
      await refreshSwarmSelection()
      const { tickAllFleetAgents } = await import('./fleetAgent')
      const r = await tickAllFleetAgents()
      if (r.bought > 0 || r.errors > 0) {
        console.log(`[fleet] open: scanned=${r.scanned} ticked=${r.ticked} bought=${r.bought} skipped=${r.skipped} errors=${r.errors}`)
      }
    } catch (err) {
      console.error('[fleet] open sweep failed:', (err as Error).message)
    } finally {
      fleetOpenTickInflight = false
    }
  }
  setTimeout(tickFleetOpen, 18_000)
  setInterval(tickFleetOpen, 30_000)

  const tickFleetExit = async () => {
    if (fleetExitTickInflight) return
    fleetExitTickInflight = true
    try {
      const { refreshSwarmSelection } = await import('./fleetBrain')
      await refreshSwarmSelection()
      const { tickAllFleetExits } = await import('./fleetAgent')
      const r = await tickAllFleetExits()
      if (r.sold > 0 || r.errors > 0 || r.reaped > 0) {
        console.log(`[fleet] exit: scanned=${r.scanned} evaluated=${r.evaluated} sold=${r.sold} errors=${r.errors} reaped=${r.reaped}`)
      }
      // Escalate repeated stale-claim reaps to admins (deduped, threshold-gated).
      await noteFleetReaps(r.reaped)
    } catch (err) {
      console.error('[fleet] exit sweep failed:', (err as Error).message)
    } finally {
      fleetExitTickInflight = false
    }
  }
  setTimeout(tickFleetExit, 22_000)
  setInterval(tickFleetExit, 25_000)

  // Fleet low-BNB-balance watch. Once the fleet trades live, an agent wallet
  // that drains below its trade size silently stops opening positions. The
  // /fleet panel shows on-chain balances but only when an admin is looking;
  // this fires a deduped admin alert when any active agent's wallet crosses
  // below a low-balance threshold. Default cadence every 15 min; a boot
  // catch-up runs once ~40s after start so a redeploy surfaces low wallets
  // without waiting the full interval. No-op in mock mode (see watcher body).
  cron.schedule(process.env.FLEET_LOW_BALANCE_CRON ?? '*/15 * * * *', () => {
    void runFleetLowBalanceWatch()
  })
  setTimeout(() => { void runFleetLowBalanceWatch() }, 40_000)

  // Fleet auto-snapshot — scheduled off-server backstop. Pushes a full backup
  // CSV (the same file the /fleet "Backup all" button produces, restorable via
  // "Restore from CSV") to admin Telegram on a timer so a restore file always
  // exists OFF the database — the safety net if the prod fleet ever vanishes
  // (e.g. a Render DB recovery/restore). Opt-in because real private keys leave
  // the server: set FLEET_AUTOSNAPSHOT_ENABLED=true. Default cadence 06:00 UTC
  // daily; override with FLEET_AUTOSNAPSHOT_CRON. Empty fleet = no-op (so a
  // post-wipe run can't overwrite the value of an earlier good snapshot).
  if (process.env.FLEET_AUTOSNAPSHOT_ENABLED === 'true') {
    cron.schedule(process.env.FLEET_AUTOSNAPSHOT_CRON ?? '0 6 * * *', () => {
      void runFleetAutoSnapshot()
    }, { timezone: 'UTC' })
    // Boot catch-up: if the last successful snapshot is >20h old (or none
    // exists), fire one ~60s after start so a redeploy across the daily cron
    // time can't skip a day. The age guard stops a burst of redeploys from
    // snapshotting on every boot.
    setTimeout(() => { void runFleetAutoSnapshotCatchUp() }, 60_000)
  }

  // Competition bridge — push a per-agent fleet snapshot (volume + traded
  // tokens) to the build4.io competition site so every fleet agent shows on the
  // public leaderboard with live volume + on-chain PnL. Fail-closed: the push
  // helper is a no-op unless COMPETITION_BRIDGE_ENABLED='true' AND both
  // COMPETITION_SITE_URL + FLEET_BRIDGE_SECRET are set, so this is safe to leave
  // armed. Single-flighted; boot catch-up ~45s after start then every 120s.
  let competitionBridgeInflight = false
  const tickCompetitionBridge = async () => {
    if (competitionBridgeInflight) return
    competitionBridgeInflight = true
    try {
      const { pushFleetSnapshotToSite } = await import('../services/competitionBridge')
      const r = await pushFleetSnapshotToSite()
      if (!r.skipped && !r.ok) {
        console.error(`[competitionBridge] push failed: status=${r.status ?? '-'} ${r.error ?? ''}`.trim())
      } else if (r.ok) {
        console.log(`[competitionBridge] synced ${r.agents} agents`)
      }
    } catch (err) {
      console.error('[competitionBridge] tick failed:', (err as Error).message)
    } finally {
      competitionBridgeInflight = false
    }
  }
  setTimeout(tickCompetitionBridge, 45_000)
  setInterval(tickCompetitionBridge, 120_000)

  // Demo Day — autonomous take-profit sweep for already-launched dev
  // bags. Independent of the launch sweep above so a slow LLM round
  // can't block exits, and vice versa. Per-agent TP% lives on the
  // Agent row (NULL = leave it to the user, no autonomous exit).
  let fourMemeTpTickInflight = false
  const tickFourMemeTakeProfit = async () => {
    if (fourMemeTpTickInflight) {
      console.log('[fourMemeTakeProfit] previous tick still running, skipping')
      return
    }
    fourMemeTpTickInflight = true
    try {
      const { tickAllFourMemeTakeProfit } = await import('./fourMemeLaunchAgent')
      const r = await tickAllFourMemeTakeProfit()
      if (r.scanned > 0 || r.sold > 0 || r.errors > 0) {
        console.log(
          `[fourMemeTakeProfit] scanned=${r.scanned} evaluated=${r.evaluated} ` +
            `sold=${r.sold} errors=${r.errors}`,
        )
      }
    } catch (err) {
      console.error('[fourMemeTakeProfit] sweep failed:', (err as Error).message)
    } finally {
      fourMemeTpTickInflight = false
    }
  }
  setTimeout(tickFourMemeTakeProfit, 12_000)
  setInterval(tickFourMemeTakeProfit, 60_000)

  // ── Topaz DEX (BSC ve(3,3)) — Phase 1 master-wallet-only sweep ──────
  // 5-min interval matches the in-agent MIN_TICK_INTERVAL_MS so even a
  // double-fire from the watchdog cron can't trade twice per window.
  // Single-flight via `topazTickInflight` so a slow LLM round-trip or
  // pending swap tx receipt can't pile up sweeps.
  let topazTickInflight = false
  const tickTopaz = async () => {
    if (topazTickInflight) {
      console.log('[topazAgent] previous tick still running, skipping')
      return
    }
    topazTickInflight = true
    try {
      const { tickAllTopazAgents } = await import('./topazAgent')
      const r = await tickAllTopazAgents()
      if (r.scanned > 0 || r.errors > 0) {
        console.log(
          `[topazAgent] scanned=${r.scanned} ticked=${r.ticked} taken=${r.actionsTaken} ` +
            `skipped=${r.actionsSkipped} errors=${r.errors}`,
        )
      }
    } catch (err) {
      console.error('[topazAgent] sweep failed:', (err as Error).message)
    } finally {
      topazTickInflight = false
    }
  }
  // Boot catch-up so a redeploy mid-window doesn't wait the full 5 min.
  setTimeout(tickTopaz, 15_000)
  setInterval(tickTopaz, 300_000)
  // Belt-and-suspenders watchdog: every 5 min cron + in-process interval.
  // The agent itself enforces MIN_TICK_INTERVAL_MS, so this is idempotent.
  cron.schedule('*/5 * * * *', () => { void tickTopaz() }, { timezone: 'UTC' })

  // ── House Topaz brain ─────────────────────────────────────────────────
  // Autonomous Topaz brain for the singleton HOUSE wallet. Gated on
  // HouseAgent.{enabled, mode='autotrade', dex='topaz'} — short-circuits
  // cleanly when off, so the cron is safe to leave armed unconditionally.
  // Same three-layer pattern as agent-side Topaz: 15s boot catch-up +
  // 5min setInterval + */5 cron watchdog. MIN_TICK_INTERVAL_MS inside
  // the brain makes overlapping fires idempotent (plus an in-process
  // single-flight inflight guard).
  const tickHouseTopazWrapped = async () => {
    try {
      const { tickHouseTopaz } = await import('./houseTopazBrain')
      const r = await tickHouseTopaz()
      if (r.ticked && r.reason !== 'min_interval') {
        console.log(
          `[houseTopazBrain] ticked=${r.ticked} ` +
            `reason=${r.reason ?? '-'} ` +
            `action=${r.decision?.action ?? '-'} ` +
            `exec=${r.execution ?? '-'}`,
        )
      }
    } catch (err) {
      console.error('[houseTopazBrain] tick failed:', (err as Error).message)
    }
  }
  setTimeout(tickHouseTopazWrapped, 20_000)
  setInterval(tickHouseTopazWrapped, 300_000)
  cron.schedule('*/5 * * * *', () => { void tickHouseTopazWrapped() }, { timezone: 'UTC' })

  // ── House Agent × 42.space — kickoff scheduler + auto-claim sweep ────
  // Pre-kickoff window: if HOUSE_UCL_MARKET_ADDRESS + HOUSE_UCL_KICKOFF_MS
  // are set, fire ONE pick when we're in [kickoff - 15min, kickoff].
  // findOpenHousePosition (HouseLog probe) makes overlapping fires no-op.
  // Auto-claim sweep walks recent OPEN_42 rows that have no paired
  // CLAIM_42 yet and claims any whose markets have finalised on-chain.
  let houseUclInflight = false
  const tickHouseUcl = async () => {
    if (houseUclInflight) return
    houseUclInflight = true
    try {
      const marketAddress = process.env.HOUSE_UCL_MARKET_ADDRESS
      const kickoffStr = process.env.HOUSE_UCL_KICKOFF_MS
      if (!marketAddress || !kickoffStr) return
      const kickoff = Number(kickoffStr)
      if (!Number.isFinite(kickoff) || kickoff <= 0) return
      const now = Date.now()
      const windowOpen = kickoff - 15 * 60 * 1000
      if (now < windowOpen || now > kickoff) return
      const { runHouseFortyTwoPick } = await import('./houseFortyTwoSportsBrain')
      const r = await runHouseFortyTwoPick({ marketAddress })
      console.log(
        `[houseUcl] kickoff tick: ok=${r.ok} reason=${r.reason ?? '-'} ` +
          `bucket=${r.bucketIndex ?? '-'} size=$${r.sizeUsdt ?? 0} ` +
          `tx=${r.trade?.txHash ?? '-'}`,
      )
    } catch (err) {
      console.error('[houseUcl] kickoff tick crashed:', (err as Error).message)
    } finally {
      houseUclInflight = false
    }
  }
  cron.schedule('*/2 * * * *', () => { void tickHouseUcl() }, { timezone: 'UTC' })

  // ── House Agent × 42.space — autonomous FIFA World Cup "win or draw" ──
  // Fully autonomous, LIVE + REAL, gated via the House Agent panel state
  // (enabled + mode='campaign' + dex='42') inside runHouseWorldCupTick;
  // HOUSE_WC_ENABLED is a legacy override. Cron stays armed unconditionally.
  // Each tick enumerates live goal-differential WC markets, opens a swarm-backed
  // double-chance basket ($50 default) on any un-entered match, and runs the
  // odds-stop monitor (default off → hold to settlement) on open positions.
  // Settlement winnings are harvested by the generic OPEN_42 claim sweep
  // below (now V2/proxy aware). In-flight guard prevents overlap.
  let houseWcInflight = false
  const tickHouseWorldCup = async () => {
    if (houseWcInflight) return
    houseWcInflight = true
    try {
      // No env gate here — runHouseWorldCupTick self-gates on the House Agent
      // panel state (enabled + mode='campaign' + dex='42'), with a legacy
      // HOUSE_WC_ENABLED override inside. Cron stays armed unconditionally.
      const { runHouseWorldCupTick } = await import('./houseWorldCup')
      const r = await runHouseWorldCupTick()
      if (r.ran && (r.candidates > 0 || r.reason)) {
        console.log(
          `[houseWorldCup] tick: ran=${r.ran} reason=${r.reason ?? '-'} ` +
            `scanned=${r.scanned} candidates=${r.candidates} processed=${r.processed} ` +
            `entered=${r.results.filter((x) => x.action === 'entered').length} ` +
            `exited=${r.results.filter((x) => x.action === 'exit').length}`,
        )
      }
    } catch (err) {
      console.error('[houseWorldCup] tick crashed:', (err as Error).message)
    } finally {
      houseWcInflight = false
    }
  }
  cron.schedule('*/2 * * * *', () => { void tickHouseWorldCup() }, { timezone: 'UTC' })

  let houseClaimInflight = false
  const sweepHouseFortyTwoClaims = async () => {
    if (houseClaimInflight) return
    houseClaimInflight = true
    try {
      const { db } = await import('../db')
      // Find OPEN_42 markets without a paired CLAIM_42 row.
      const rows = await db.$queryRawUnsafe<Array<{ marketAddress: string }>>(
        `SELECT DISTINCT (open.meta->>'marketAddress') AS "marketAddress"
           FROM "HouseLog" open
          WHERE open.dex = '42'
            AND open.decision = 'OPEN_42'
            AND open."txHash" IS NOT NULL
            AND COALESCE((open.meta->>'dryRun')::boolean, false) = false
            AND open."createdAt" > NOW() - INTERVAL '30 days'
            AND NOT EXISTS (
              SELECT 1 FROM "HouseLog" claim
               WHERE claim.dex = '42'
                 AND claim.decision = 'CLAIM_42'
                 AND COALESCE((claim.meta->>'dryRun')::boolean, false) = false
                 AND LOWER(claim.meta->>'marketAddress') = LOWER(open.meta->>'marketAddress')
            )`,
      )
      if (rows.length === 0) return
      const { houseClaimFortyTwoMarket } = await import('../services/houseFortyTwoExecutor')
      const { getMarketByAddress } = await import('../services/fortyTwo')
      const { readMarketOnchain } = await import('../services/fortyTwoOnchain')
      for (const row of rows) {
        if (!row.marketAddress) continue
        try {
          const m = await getMarketByAddress(row.marketAddress)
          const state = await readMarketOnchain(m)
          if (!state.isFinalised) continue
          const r = await houseClaimFortyTwoMarket(row.marketAddress)
          console.log(
            `[houseUcl] auto-claim swept market=${row.marketAddress.slice(0, 10)}… tx=${r.txHash ?? '-'}`,
          )
        } catch (err) {
          console.warn(
            `[houseUcl] auto-claim failed market=${row.marketAddress?.slice(0, 10)}…:`,
            (err as Error).message,
          )
        }
      }
    } catch (err) {
      console.error('[houseUcl] claim sweep crashed:', (err as Error).message)
    } finally {
      houseClaimInflight = false
    }
  }
  setTimeout(sweepHouseFortyTwoClaims, 30_000)
  cron.schedule('*/10 * * * *', () => { void sweepHouseFortyTwoClaims() }, { timezone: 'UTC' })

  // Module 4 — auto-expire stale launch approval requests. The agent's
  // pending-dedup gate refuses to propose new launches while any
  // pending_user_approval row sits open. Without a sweeper, an owner
  // who never taps Approve/Reject silently blocks the agent forever.
  // We run hourly (cheap UPDATE) and let the helper read the TTL from
  // FOUR_MEME_APPROVAL_TTL_HOURS (default 24h). Fail-safe: any error
  // is logged inside the helper, never thrown.
  const sweepStaleApprovals = async () => {
    try {
      const { expireStalePendingApprovals } = await import('../services/fourMemeLaunch')
      const n = await expireStalePendingApprovals()
      if (n > 0) console.log(`[fourMemeLaunch] expired ${n} stale pending_user_approval row(s)`)
    } catch (err) {
      console.error('[fourMemeLaunch] approval expiry sweep failed:', (err as Error).message)
    }
  }
  setTimeout(sweepStaleApprovals, 15_000)
  setInterval(sweepStaleApprovals, 60 * 60 * 1000)

  // Task #73 — nudge owners before their approval requests expire. The
  // expiry sweep above silently flips stale pending_user_approval rows
  // to 'expired'; without warning, an owner who meant to approve just
  // sees the proposal vanish. This sweep DMs each owner once when their
  // row crosses ~80% of the TTL, with the same Approve/Reject buttons.
  // Runs every 30 min for responsiveness within the warn window; the
  // helper is idempotent (in-memory dedup) and never throws.
  const sweepApprovalNudges = async () => {
    try {
      const { nudgeApprovalsNearingExpiry } = await import('./fourMemeLaunchAgent')
      const r = await nudgeApprovalsNearingExpiry()
      if (r.nudged > 0 || r.errors > 0) {
        console.log(
          `[fourMemeLaunch] approval nudge sweep: found=${r.found} ` +
            `nudged=${r.nudged} errors=${r.errors}`,
        )
      }
    } catch (err) {
      console.error('[fourMemeLaunch] approval nudge sweep failed:', (err as Error).message)
    }
  }
  setTimeout(sweepApprovalNudges, 25_000)
  setInterval(sweepApprovalNudges, 30 * 60 * 1000)

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
        // After every tick, sweep settle+claim for the campaign agent's
        // resolved positions. The runner previously never ran this for the
        // campaign agent, so finished rounds stayed at status='open'
        // forever and the public brain feed showed Resolved 0/0 with $0
        // PnL even though 42.space had paid out. Cheap when there's
        // nothing to do (~1 DB read + 1 RPC read); only opens claim txs
        // when a market has actually finalised AND we have a winning row.
        const campaignAgentId = process.env.FT_CAMPAIGN_AGENT_ID
        if (campaignAgentId) {
          try {
            const { claimAllAgentResolved } = await import('../services/fortyTwoExecutor')
            const sweep = await claimAllAgentResolved(campaignAgentId)
            if (sweep.settled > 0 || sweep.marketsClaimed > 0) {
              console.log(
                `[fortyTwoCampaign] sweep after ${tick}: settled=${sweep.settled} ` +
                  `markets_claimed=${sweep.marketsClaimed} positions_claimed=${sweep.claimedPositions} ` +
                  `payout=$${sweep.payoutUsdt.toFixed(2)}`,
              )
            }
            for (const e of sweep.errors) {
              console.warn(
                `[fortyTwoCampaign] sweep claim error market=${e.marketAddress}: ${e.reason}`,
              )
            }
          } catch (sweepErr) {
            console.warn(`[fortyTwoCampaign] sweep crashed:`, (sweepErr as Error).message)
          }
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

    // ── ENTRY watchdog ──────────────────────────────────────────────────
    // Belt-and-suspenders against missing a round. Runs every 5 minutes;
    // runCampaignTick('ENTRY') is now idempotent (skips if an entry row
    // already exists for the current 4h round), so calling it on a loop
    // is safe — it only opens a position if the regular +5m cron failed
    // to fire (e.g. Render restarted between 16:00 and 16:05 UTC, which
    // is exactly what burned us on Round 4).
    cron.schedule('*/5 * * * *', () => { void fireCampaignTick('ENTRY') }, cronOpts)

    // Boot-time catch-up: if the process started mid-round (e.g. operator
    // redeployed at 16:30 UTC), fire ENTRY immediately rather than waiting
    // up to 5 min for the watchdog. Same idempotency guard protects us.
    setTimeout(() => { void fireCampaignTick('ENTRY') }, 10_000)

    // ── Campaign wallet low-balance watchdog ────────────────────────────
    // A correctly-configured campaign can still silently fail mid-run if
    // the pinned agent's BSC wallet runs out of BNB (gas) or USDT (stake).
    // Read the wallet balance every 15 min and DM the admin allowlist when
    // it drops below a configurable threshold (deduped — one DM per drop,
    // re-armed on recovery). Boot-time check ~30s in so a redeploy onto an
    // already-low wallet surfaces immediately.
    cron.schedule('*/15 * * * *', () => { void checkCampaignWalletBalance(bot) }, cronOpts)
    setTimeout(() => { void checkCampaignWalletBalance(bot) }, 30_000)

    console.log(
      '[Runner] 42.space campaign scheduler ARMED — ENTRY +5m + every-5min watchdog, ' +
        'REASSESS +1h30m/+3h, FINAL +3h45m past every 4h UTC boundary; ' +
        'boot-time ENTRY catch-up in 10s',
    )
  }

  // ── Campaign env-var sanity check (runs regardless of FT_CAMPAIGN_MODE) ──
  // FT_CAMPAIGN_MODE and FT_CAMPAIGN_AGENT_ID must be set together. Setting
  // one without the other silently puts the bot in a broken state: MODE=true
  // with no agent arms the scheduler against nothing, while AGENT_ID set with
  // MODE off leaves the pinned agent trading through the regular (wrong)
  // wallet path. We also confirm the pinned agent actually exists in the DB
  // and has a walletId bound, since an unbound agent can't resolve a signer.
  // Misconfigs log a loud warning AND DM the admin allowlist so deploy
  // mistakes surface immediately rather than after a missed campaign round.
  setTimeout(() => { void validateCampaignEnv(bot) }, 12_000)

  console.log('[Runner] Agent runner initialized')
}

/**
 * Validate the campaign env vars on boot. No-op when neither FT_CAMPAIGN_MODE
 * nor FT_CAMPAIGN_AGENT_ID is set (a deploy that isn't running a campaign).
 * On any misconfiguration, logs a loud warning and DMs the admin allowlist.
 */
async function validateCampaignEnv(bot: Bot | null): Promise<void> {
  try {
    const mode = process.env.FT_CAMPAIGN_MODE === 'true'
    const agentId = (process.env.FT_CAMPAIGN_AGENT_ID ?? '').trim()
    const startMs = (process.env.FT_CAMPAIGN_START_MS ?? '').trim()

    // Nothing campaign-related is configured — not running a campaign, no-op.
    if (!mode && !agentId) return

    const problems: string[] = []

    // 1. MODE and AGENT_ID must be set together.
    if (mode && !agentId) {
      problems.push('FT_CAMPAIGN_MODE=true but FT_CAMPAIGN_AGENT_ID is unset — the campaign scheduler is armed with no agent to run.')
    }
    if (!mode && agentId) {
      problems.push('FT_CAMPAIGN_AGENT_ID is set but FT_CAMPAIGN_MODE is not "true" — the campaign scheduler is OFF, so the pinned agent will trade via the regular (wrong) wallet path.')
    }

    // 2. The pinned agent must exist in the DB and have a walletId bound.
    if (agentId) {
      try {
        const rows = await db.$queryRawUnsafe<Array<{ name: string; walletId: string | null }>>(
          `SELECT name, "walletId" FROM "Agent" WHERE id = $1 LIMIT 1`,
          agentId,
        )
        if (!rows.length) {
          problems.push(`FT_CAMPAIGN_AGENT_ID=${agentId} was not found in the Agent table.`)
        } else if (!rows[0].walletId) {
          problems.push(`Campaign agent "${rows[0].name}" (${agentId}) has no walletId bound — campaign trades can't resolve a signer.`)
        }
      } catch (dbErr) {
        problems.push(`Could not verify FT_CAMPAIGN_AGENT_ID against the DB: ${(dbErr as Error).message}`)
      }
    }

    // 3. FT_CAMPAIGN_START_MS, when set, must be a positive integer (ms epoch).
    if (startMs && !(Number.isFinite(Number(startMs)) && Number(startMs) > 0)) {
      problems.push(`FT_CAMPAIGN_START_MS=${startMs} is not a positive integer (expected unix ms of round 1).`)
    }

    if (problems.length === 0) {
      console.log('[Runner] Campaign env vars validated OK.')
      return
    }

    const logBody = problems.map((p) => `  - ${p}`).join('\n')
    console.warn(
      `\n${'='.repeat(60)}\n` +
        `[Runner] ⚠️  CAMPAIGN ENV MISCONFIGURED — bot may be in a broken state:\n` +
        `${logBody}\n` +
        `${'='.repeat(60)}\n`,
    )

    const { sendAdminAlert } = await import('../services/adminAlerts')
    const dmBody = problems.map((p) => `• ${p}`).join('\n')
    await sendAdminAlert(
      bot,
      `⚠️ *Campaign env misconfigured*\n\n` +
        `The bot just booted with a broken campaign config:\n\n${dmBody}\n\n` +
        `Fix the env vars and redeploy, or run /campaignstatus to inspect.`,
    )
  } catch (err) {
    console.error('[Runner] validateCampaignEnv crashed:', (err as Error).message)
  }
}

// ── Campaign wallet low-balance watchdog state ─────────────────────────────
// A correctly-configured campaign can still silently fail mid-run if the
// pinned agent's BSC wallet runs out of BNB (gas) or USDT (stake) to place
// trades. The watchdog cron below reads the wallet balance periodically and
// DMs the admin allowlist when it drops below a configurable threshold. We
// dedupe with a module-level latch so we send ONE DM per drop instead of
// spamming every tick; the latch clears once the balance recovers above the
// threshold so a future drop re-alerts.
let campaignLowBalanceAlerted = false

async function checkCampaignWalletBalance(bot: Bot | null): Promise<void> {
  try {
    const bnbThreshold = Math.max(
      0,
      parseFloat(process.env.FT_CAMPAIGN_LOW_BNB_THRESHOLD ?? '0.005') || 0.005,
    )
    const usdtThreshold = Math.max(
      0,
      parseFloat(process.env.FT_CAMPAIGN_LOW_USDT_THRESHOLD ?? '60') || 60,
    )

    const { readCampaignWalletBalance } = await import('../services/fortyTwoCampaign')
    const bal = await readCampaignWalletBalance()
    if (!bal.ok) {
      // Misconfig / flaky RPC — the boot-time env check already covers
      // misconfig loudly, so here we just log and skip rather than alert.
      console.warn(`[fortyTwoCampaign] balance watchdog skipped: ${bal.error}`)
      return
    }

    const bnb = bal.bnb ?? 0
    const usdt = bal.usdt ?? 0
    const lowBnb = bnb < bnbThreshold
    const lowUsdt = usdt < usdtThreshold

    if (!lowBnb && !lowUsdt) {
      // Healthy — re-arm the latch so a future drop alerts again.
      if (campaignLowBalanceAlerted) {
        console.log(
          `[fortyTwoCampaign] wallet balance recovered (BNB=${bnb.toFixed(5)} ` +
            `USDT=$${usdt.toFixed(2)}); re-arming low-balance alert.`,
        )
      }
      campaignLowBalanceAlerted = false
      return
    }

    // Already alerted on this drop — stay quiet until it recovers.
    if (campaignLowBalanceAlerted) return

    const reasons: string[] = []
    if (lowBnb) reasons.push(`BNB ${bnb.toFixed(5)} below ${bnbThreshold} (gas for trades/claims)`)
    if (lowUsdt) reasons.push(`USDT $${usdt.toFixed(2)} below $${usdtThreshold} (position stake)`)

    console.warn(
      `[fortyTwoCampaign] ⚠️  campaign wallet low on funds: ${reasons.join('; ')} ` +
        `addr=${bal.address}`,
    )

    const { sendAdminAlert } = await import('../services/adminAlerts')
    await sendAdminAlert(
      bot,
      `⚠️ *Campaign wallet low on funds*\n\n` +
        `The campaign agent's BSC wallet is running low and may fail to place ` +
        `trades or claim payouts:\n\n` +
        reasons.map((r) => `• ${r}`).join('\n') +
        `\n\nWallet: \`${bal.address}\`\n\n` +
        `Top it up to keep the campaign running.`,
    )
    campaignLowBalanceAlerted = true
  } catch (err) {
    console.error('[fortyTwoCampaign] checkCampaignWalletBalance crashed:', (err as Error).message)
  }
}

// In-flight guard for the dedicated 42.space regular sweep (*/10 cron).
let fortyTwoTickInflight = false

// In-flight guard for the 42.space auto-close stale-position sweep (*/5 cron).
let fortyTwoAutoCloseInflight = false

// Task #149 — single-flight guards for the three four.meme snipe sweeps.
// The scanner does bounded RPC log scans; the buy/exit sweeps fire
// on-chain txs — in every case we never want a second sweep to start
// before the first finishes (they'd race the same cursor/positions).
let fourMemeScannerTickInflight = false
let fourMemeSnipeTickInflight = false
let fourMemeSnipeExitTickInflight = false

// Community Trading Fleet — single-flight guards for the open + exit sweeps.
let fleetOpenTickInflight = false
let fleetExitTickInflight = false

// Fleet stale-claim reap watch. The exit sweep silently reclaims positions whose
// worker crashed mid-sell. A single reap is benign (one redeploy mid-sell), but
// reaps that keep happening signal something broken (RPC hangs, process crashes,
// a wedged sell path) and admins should be told. We accumulate reaped counts in
// a rolling window and fire one deduped admin alert once they cross a threshold,
// then stay quiet until the window goes clean again so a future spike re-alerts.
let fleetReapWindowStart = 0
let fleetReapWindowCount = 0
let fleetReapAlerted = false

async function noteFleetReaps(reaped: number): Promise<void> {
  const windowMs = Math.max(1, parseFloat(process.env.FLEET_REAP_ALERT_WINDOW_MIN ?? '30') || 30) * 60_000
  const threshold = Math.max(1, parseInt(process.env.FLEET_REAP_ALERT_THRESHOLD ?? '3', 10) || 3)
  const now = Date.now()

  // Roll the window: if it elapsed with no fresh reaps to extend it, reset and
  // re-arm so a future spike alerts again.
  if (now - fleetReapWindowStart > windowMs) {
    fleetReapWindowStart = now
    fleetReapWindowCount = 0
    fleetReapAlerted = false
  }

  if (reaped <= 0) return
  fleetReapWindowCount += reaped

  if (fleetReapWindowCount < threshold || fleetReapAlerted) return

  try {
    const { sendAdminAlert, hasAdminTargets } = await import('../services/adminAlerts')
    if (!hasAdminTargets()) {
      console.warn(`[FleetReap] ${fleetReapWindowCount} stale exit-claim(s) reaped but ADMIN_TELEGRAM_IDS not set — alert dropped.`)
      fleetReapAlerted = true
      return
    }
    const windowMin = Math.round(windowMs / 60_000)
    const text =
      `🧟 *Fleet stuck\\-trade alert*\n` +
      `${fleetReapWindowCount} fleet exit\\(s\\) had to be force\\-reclaimed in the last ${windowMin} min after a worker crashed mid\\-sell\\.\n\n` +
      `Repeated reaps mean the sell path is wedging \\(RPC hangs, process crashes, or a stuck live sell\\)\\. Check the fleet exit logs and BSC RPC health\\.`
    const res = await sendAdminAlert(botRef, text)
    fleetReapAlerted = true
    console.log(`[FleetReap] Alert sent to ${res.sent}/${res.attempted} admins (${res.failed} failed) for ${fleetReapWindowCount} reap(s).`)
  } catch (err: any) {
    console.error('[FleetReap] Alert error:', err?.message ?? err)
  }
}

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

// ── Fleet low-BNB-balance watch ──────────────────────────────────────────
// Tracks which agents we've already alerted about so the watcher doesn't
// re-ping admins every interval. An agent is removed from the set once its
// wallet refills above the threshold, so a later re-drain alerts again.
const fleetLowBalanceAlerted = new Set<string>()

// Scheduled off-server fleet backup. Exports the full backup CSV and sends it
// to admin Telegram as a document. No-op when no admin targets are configured
// or the fleet is empty. Best-effort — a send failure is logged, never thrown,
// so a flaky Telegram call can't take down the runner.
async function runFleetAutoSnapshot(): Promise<void> {
  try {
    const { hasAdminTargets, sendAdminDocument } = await import('../services/adminAlerts')
    if (!hasAdminTargets()) {
      console.log('[FleetSnapshot] No ADMIN_TELEGRAM_IDS configured; skipping snapshot.')
      return
    }
    const fleet = await import('../services/fleet')
    const rows = await fleet.exportFleetBackup()
    if (rows.length === 0) {
      console.log('[FleetSnapshot] Fleet is empty; skipping snapshot (nothing to back up).')
      return
    }
    const csv = fleet.serializeFleetBackupCsv(rows)
    const failed = rows.filter((r) => r.error).length
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const filename = `fleet-autosnapshot-${stamp}.csv`
    const caption =
      `🛟 Fleet auto-snapshot — ${rows.length} agent(s)` +
      (failed > 0 ? `, ${failed} un-decryptable` : '') +
      `.\nRestore via the /fleet panel "Restore from CSV" on THIS bot.`
    const res = await sendAdminDocument(botRef, Buffer.from(csv, 'utf-8'), filename, caption)
    await fleet.logFleet(null, 'info', `auto-snapshot sent to ${res.sent}/${res.attempted} admin(s) (${rows.length} agents, ${failed} failed)`)
  } catch (e) {
    console.error('[FleetSnapshot] auto-snapshot failed:', (e as Error).message)
  }
}

// Snapshot is considered "fresh" if one ran within this window; a boot catch-up
// only fires when the last snapshot is older (or absent).
const AUTOSNAPSHOT_MAX_AGE_MS = 20 * 60 * 60 * 1000
async function runFleetAutoSnapshotCatchUp(): Promise<void> {
  try {
    const { lastAutoSnapshotAt } = await import('../services/fleet')
    const last = await lastAutoSnapshotAt()
    if (last && Date.now() - last.getTime() < AUTOSNAPSHOT_MAX_AGE_MS) {
      console.log('[FleetSnapshot] Recent snapshot exists; skipping boot catch-up.')
      return
    }
    await runFleetAutoSnapshot()
  } catch (e) {
    console.error('[FleetSnapshot] boot catch-up failed:', (e as Error).message)
  }
}

async function runFleetLowBalanceWatch() {
  try {
    const { getFleetSettings, listFleetAgents, isFleetLiveTradingEnabled, getLowBalanceAckedIds, clearFleetLowBalanceAck } = await import('../services/fleet')

    // Only meaningful when the fleet is actually trading live: mock mode never
    // spends BNB, so unfunded wallets there are expected and alerting would be
    // pure noise. Mirror the OPEN sweep's live-effective gate (DB toggle + env
    // gate + four.meme master switch) and the global pause. When not live we
    // also clear the dedup set so a future go-live starts from a clean slate.
    const fourMemeOn = process.env.FOUR_MEME_ENABLED === 'true'
    const settings = await getFleetSettings()
    const liveEffective = settings.liveTrading && isFleetLiveTradingEnabled() && fourMemeOn
    if (!liveEffective || settings.globalPaused) {
      fleetLowBalanceAlerted.clear()
      return
    }

    const agents = (await listFleetAgents()).filter((a) => a.status === 'active')
    if (agents.length === 0) {
      fleetLowBalanceAlerted.clear()
      return
    }

    // Threshold per agent = maxTradeSizeBnb × rounds + gas buffer, so a wallet
    // that can't cover its next few trades + gas trips the alert. An absolute
    // override (FLEET_LOW_BALANCE_BNB) takes precedence when set, for admins
    // who want one flat floor across the whole fleet.
    const rounds = Math.max(1, parseFloat(process.env.FLEET_LOW_BALANCE_ROUNDS ?? '2') || 2)
    const gasBuffer = Math.max(0, parseFloat(process.env.FLEET_LOW_BALANCE_GAS_BNB ?? '0.0005') || 0)
    const absOverride = parseFloat(process.env.FLEET_LOW_BALANCE_BNB ?? '')
    const hasAbs = Number.isFinite(absOverride) && absOverride > 0

    const { buildBscProvider } = await import('../services/bscProvider')
    const { ethers } = await import('ethers')
    const provider = buildBscProvider(process.env.BSC_RPC_URL)

    // Admin acks persist across restarts: an acked agent stays silent until
    // its wallet recovers above threshold, even though the in-memory dedup set
    // is wiped on every redeploy. Load them once per tick.
    const acked = await getLowBalanceAckedIds()

    const newlyLow: Array<{ id: string; name: string; addr: string; bnb: number; threshold: number }> = []
    // Agents that were silenced by an admin ack and have now refilled above
    // threshold — we close the loop with a one-line "re-armed" notice so admins
    // know their top-up landed and alerts are live again.
    const recoveredAcked: Array<{ id: string; name: string; addr: string; bnb: number; threshold: number }> = []

    const results = await Promise.allSettled(
      agents.map(async (a) => {
        const wei = await provider.getBalance(a.walletAddress)
        const bnb = Number(ethers.formatEther(wei))
        const threshold = hasAbs ? absOverride : a.maxTradeSizeBnb * rounds + gasBuffer
        return { id: a.id, name: a.name, addr: a.walletAddress, bnb, threshold }
      }),
    )

    for (const r of results) {
      if (r.status !== 'fulfilled') continue
      const { id, name, addr, bnb, threshold } = r.value
      if (bnb < threshold) {
        // Silenced by an admin ack — skip until the wallet recovers. This is
        // the cross-restart guard the in-memory set can't provide.
        if (acked.has(id)) continue
        // Only surface agents that just crossed below — deduped across ticks.
        if (!fleetLowBalanceAlerted.has(id)) {
          fleetLowBalanceAlerted.add(id)
          newlyLow.push({ id, name, addr, bnb, threshold })
        }
      } else {
        // Recovered (or never low) — clear so a future drain re-alerts.
        fleetLowBalanceAlerted.delete(id)
        // Auto-clear a persisted ack now that the wallet refilled above
        // threshold, so the next drain alerts again. Only acked agents reach
        // here — record successful clears so we can tell admins the silenced
        // wallet they topped up is back above threshold.
        if (acked.has(id)) {
          await clearFleetLowBalanceAck(id)
            .then(() => recoveredAcked.push({ id, name, addr, bnb, threshold }))
            .catch((e) =>
              console.warn(`[FleetLowBalance] Failed to auto-clear ack for ${id}:`, e?.message ?? e),
            )
        }
      }
    }

    if (newlyLow.length === 0 && recoveredAcked.length === 0) return

    const { sendAdminAlert, hasAdminTargets } = await import('../services/adminAlerts')
    if (!hasAdminTargets()) {
      if (newlyLow.length > 0)
        console.warn(`[FleetLowBalance] ${newlyLow.length} agent(s) low on BNB but ADMIN_TELEGRAM_IDS not set — alert dropped.`)
      return
    }

    const fmtAddr = (a: string) => `${a.slice(0, 8)}…${a.slice(-4)}`

    // Close the loop on acked wallets that refilled: a one-line "re-armed"
    // notice per recovered agent so admins know their top-up landed and the
    // agent will alert again on a future drain. Only fires for agents that were
    // actually acked, so normal recoveries stay silent.
    if (recoveredAcked.length > 0) {
      const recLines = recoveredAcked
        .slice(0, 20)
        .map((l) => `✅ ${escapeMd(l.name)} \`${fmtAddr(l.addr)}\` wallet refilled to *${l.bnb.toFixed(4)}* BNB \\(above ${l.threshold.toFixed(4)}\\) — low\\-balance alerts re\\-armed`)
      const recMore = recoveredAcked.length > 20 ? `\n…and ${recoveredAcked.length - 20} more` : ''
      const recText = `${recLines.join('\n')}${recMore}`
      const recRes = await sendAdminAlert(botRef, recText)
      console.log(`[FleetLowBalance] Recovery notice sent to ${recRes.sent}/${recRes.attempted} admins (${recRes.failed} failed) for ${recoveredAcked.length} re-armed agent(s).`)
    }

    if (newlyLow.length === 0) return

    const lines = newlyLow
      .slice(0, 20)
      .map((l) => `• ${escapeMd(l.name)} \`${fmtAddr(l.addr)}\`: *${l.bnb.toFixed(4)}* BNB \\(below ${l.threshold.toFixed(4)}\\)`)
    const more = newlyLow.length > 20 ? `\n…and ${newlyLow.length - 20} more` : ''
    const text =
      `⛽ *Fleet low\\-balance alert*\n` +
      `${newlyLow.length} active agent wallet\\(s\\) dropped below their low\\-balance threshold and will stop opening positions until refunded:\n\n` +
      `${lines.join('\n')}${more}\n\n` +
      `Tap *Ack* to silence an agent until its wallet refills above threshold \\(persists across restarts\\)\\.`

    // One inline "Ack" button per agent (cap to the 20 shown). Acking persists
    // a DB row so the agent stays silent across redeploys until it recovers.
    const { InlineKeyboard } = await import('grammy')
    const kb = new InlineKeyboard()
    for (const l of newlyLow.slice(0, 20)) {
      kb.text(`✅ Ack ${l.name}`, `flbAck:${l.id}`).row()
    }

    const res = await sendAdminAlert(botRef, text, { replyMarkup: kb })
    console.log(`[FleetLowBalance] Alert sent to ${res.sent}/${res.attempted} admins (${res.failed} failed) for ${newlyLow.length} agent(s).`)
  } catch (err: any) {
    console.error('[FleetLowBalance] Watch error:', err?.message ?? err)
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
  // 3-min cadence — fetchNewsSignal() is itself
  // cached for 60s and gated on score>=7+isBreaking, so most ticks
  // were no-ops anyway. 3min still gives same-day breaking-news
  // coverage with 1/3 the LLM calls.
  setInterval(newsMonitorTick, 180_000)
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
    const activeAgentsRaw = await db.agent.findMany({
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

    // Subscription soft-pause. When SUBSCRIPTION_ENFORCED='true', drop any
    // agent whose owner's subscription has expired — they STAY in the DB
    // (no destructive mutation), they just don't tick. Resume is instant
    // on the next renewal payment. When the gate is OFF (default), the
    // helper returns 'all' and this filter is a no-op. One indexed SELECT
    // per tick; cheap even at 17k users.
    const { getActiveSubscriberUserIds } = await import('../services/subscriptions')
    const allowed = await getActiveSubscriberUserIds()
    const activeAgents = allowed === 'all'
      ? activeAgentsRaw
      : activeAgentsRaw.filter((a) => (allowed as string[]).includes(a.userId))
    const subPaused = activeAgentsRaw.length - activeAgents.length
    if (subPaused > 0) {
      console.log(`[Runner] Subscription gate paused ${subPaused}/${activeAgentsRaw.length} agents (expired subs)`)
    }

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
        // 42.space regular (non-campaign) scan is owned by the dedicated
        // tickAllFortyTwoAgents loop on the */10 cron above (Task #90).
        // Campaign agent has its own +5m/+1h30m/+3h/+3h45m scheduler
        // (CAMPAIGN block, untouched). Skipping here ensures neither
        // path is double-driven from this generic loop.
        if (venue === 'fortytwo' || venue === '42') continue
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

// Telegram Markdown (legacy, not V2) escape — only the chars that break the
// legacy parser. Matches the conservative escaping in commands/predictions.ts
// so auto-close notifications render market titles/labels safely.
function escapeMdLegacy(s: string): string {
  return (s ?? '').replace(/([_*`\[\]])/g, '\\$1')
}

/**
 * Notify a position owner that the stale-sweep auto-closed one of their
 * 42.space prediction positions. Resolves the owner's telegramId from the
 * userId, then sends a one-shot Markdown message. Best-effort: a blocked
 * bot or missing user is swallowed so the sweep never throws.
 */
async function notifyPredictionAutoClosed(c: {
  positionId: string
  userId: string
  marketTitle: string
  outcomeLabel: string
  reason: string
  pnl: number
  paperTrade: boolean
}): Promise<void> {
  if (!botRef) return
  let telegramId: bigint | null = null
  try {
    const u = await db.user.findUnique({ where: { id: c.userId }, select: { telegramId: true } })
    telegramId = u?.telegramId ?? null
  } catch {
    return
  }
  if (!telegramId) return

  const mode = c.paperTrade ? '📝 Paper' : '🔴 Live'
  const sign = c.pnl >= 0 ? '+' : ''
  const title = c.marketTitle.length > 60 ? c.marketTitle.slice(0, 57) + '…' : c.marketTitle
  const msg =
    `⏱️ *Prediction position auto-closed*\n\n` +
    `${mode} — *${escapeMdLegacy(c.outcomeLabel)}*\n` +
    `_${escapeMdLegacy(title)}_\n\n` +
    `*PnL:* ${sign}$${c.pnl.toFixed(2)} USDT\n` +
    `*Reason:* ${escapeMdLegacy(c.reason)}`

  try {
    await botRef.api.sendMessage(telegramId.toString(), msg, { parse_mode: 'Markdown' })
  } catch {
    // User may have blocked the bot — ignore.
  }
}
