/**
 * Community Trading Fleet — autonomous trading engine.
 *
 * Two sweeps, both single-flighted by the runner:
 *   • tickAllFleetAgents()  — OPEN sweep. Each eligible agent picks ONE
 *     candidate that matches its strategy and isn't already claimed this
 *     tick (so 50 agents don't pile into the same token), then buys it.
 *   • tickAllFleetExits()   — CLOSE sweep. Walks open positions and exits
 *     on TP / SL / pre-migration fill / graduation.
 *
 * MOCK-FIRST: when fleet_settings.live_trading is false (the default), buys
 * and sells use REAL four.meme quotes (live chain data) but send NO
 * transaction. PnL is computed from real re-quotes, so the dashboard shows
 * honest simulated performance with zero risk. Flip live_trading on from
 * the /fleet panel to route through the real buy/sell path.
 *
 * A position's `mock` flag is stamped at OPEN and drives its CLOSE path —
 * a mock bag is always closed in mock (there are no real tokens to sell),
 * regardless of the global setting at close time.
 */

import { ethers } from 'ethers'
import { db } from '../db'
import {
  getFleetSettings,
  listFleetAgents,
  getTodayStats,
  getOpenPositionCounts,
  getOpenTokensByAgent,
  getFleetCandidates,
  agentOpenGate,
  markFleetTick,
  decryptFleetAgentKey,
  isFleetLiveTradingEnabled,
  logFleet,
  FLEET_STRATEGIES,
  type FleetAgent,
  type FleetCandidate,
} from '../services/fleet'
import {
  isFourMemeEnabled,
  getTokenInfo,
  quoteBuyByBnb,
  quoteSell,
  buyTokenWithBnb,
  sellTokenForBnb,
  tokenBalanceOf,
} from '../services/fourMemeTrading'
import { shouldRideThrough } from '../services/fourMemeTrust'
import {
  pancakeQuoteSell,
  pancakeSellTokenForBnb,
  PANCAKE_HARD_MAX_SLIPPAGE_BPS,
} from '../services/pancakeSwapTrading'
import {
  isFleetSwarmEnabled,
  getEntryVerdict,
  getExitVerdict,
  type FleetVerdict,
} from './fleetBrain'

// Trailing-stop giveback (post-graduation only). Once a ride-through bag is on
// PancakeSwap we track peak PnL%; if it retraces this many points from the peak
// we exit even before the hard stop-loss fires, locking in the run. Default 20.
const FLEET_TRAIL_PCT = Math.max(1, Math.round(Number(process.env.FLEET_TRAIL_PCT) || 20))

// A bag whose wallet balance has collapsed to a dust fraction of what we recorded
// buying is a phantom/heavily-taxed buy. We only REAP it (close with no sell tx)
// when the quoted value of that residual is below this gas-aware BNB floor — i.e.
// selling it would net less than the sell gas costs. This guards against reaping
// a tiny token balance that is actually worth real BNB after a large price move.
// Default 0.0008 BNB (~a BSC sell's gas). Set FLEET_REAP_MIN_BNB to tune.
const FLEET_REAP_MIN_BNB = Math.max(0, Number(process.env.FLEET_REAP_MIN_BNB) || 0.0008)

// Ride-through master gate. Default OFF — with this unset, NO bag is ever held
// past graduation: a graduated bag force-sells exactly as before (reason
// 'graduated'), so the feature is a true zero-behavior-change opt-in. Set
// FLEET_RIDE_THROUGH_ENABLED=true to let high-trust launches migrate onto
// PancakeSwap and be managed there (TP/SL/trailing). The hard stop-loss and the
// kill-switch always override regardless of this flag.
function isFleetRideThroughEnabled(): boolean {
  return process.env.FLEET_RIDE_THROUGH_ENABLED === 'true'
}

export interface FleetBuyResult { scanned: number; ticked: number; bought: number; skipped: number; errors: number }
export interface FleetExitResult { scanned: number; evaluated: number; sold: number; errors: number; reaped: number }

// Exit-claim lease. A fleet position holds claim_token (the exit CAS lock) only
// for the brief window of a single live sell. A worker that CRASHES mid-sell
// (process killed, no catch runs) leaves claim_token set forever, and because
// closePosition's CAS requires `claim_token IS NULL`, that bag can never be
// re-claimed — it is stranded. The exit sweep reaps any claim older than this
// lease so a later tick retries it. The lease is far longer than any healthy
// sell, so a still-running (slow RPC) sell is never disturbed — same contract
// as the four.meme snipe-exit reaper.
const FLEET_CLAIM_LEASE_SEC = Math.max(30, Math.round(Number(process.env.FLEET_CLAIM_LEASE_SEC) || 300))

// Max-hold forced exit. four.meme bags routinely dump rather than tick up to the
// +TP target, so a position can sit open a long time riding down to the hard
// stop-loss — freezing the agent's capital (and its one position slot) the whole
// time. To keep capital RECYCLING (more round-trips = more competition volume),
// once a bag has been open longer than this many minutes we force-sell it at
// market regardless of PnL. The hard stop-loss still fires first (it keeps its
// more informative reason), and phantom-bag reaping still happens above. Set
// FLEET_MAX_HOLD_MIN=0 to disable. Default 5 minutes.
const _fleetMaxHoldMin = Number(process.env.FLEET_MAX_HOLD_MIN)
const FLEET_MAX_HOLD_MIN = Number.isFinite(_fleetMaxHoldMin) && _fleetMaxHoldMin >= 0 ? _fleetMaxHoldMin : 5

// Seam for tests. The no-double-trade guarantees (open-path ON CONFLICT claim,
// exit-path CAS lock, mid-sweep kill-switch recheck) are pure Postgres
// semantics, so the concurrency tests in fleetAgent.test.ts drive the REAL
// openPosition/closePosition against a real DB while stubbing only the chain
// I/O and settings reads here (same mutable-object pattern as competition.ts /
// fortyTwoExecutor). Production code calls through these indirections so a test
// can count how many real buys/sells actually fired. Never reassign in prod.
export const __testDeps = {
  isFourMemeEnabled,
  getTokenInfo,
  quoteBuyByBnb,
  quoteSell,
  buyTokenWithBnb,
  sellTokenForBnb,
  tokenBalanceOf,
  pancakeQuoteSell,
  pancakeSellTokenForBnb,
  getFleetSettings,
  decryptFleetAgentKey,
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** Pick the best candidate for an agent: matches strategy filter + watchlist,
 *  not already held, not claimed this tick. Highest strategy score wins. */
function pickCandidate(
  agent: FleetAgent,
  candidates: FleetCandidate[],
  claimed: Set<string>,
  heldByAgent: Set<string>,
): FleetCandidate | null {
  const profile = FLEET_STRATEGIES[agent.strategy]
  const watch = agent.watchlist ? new Set(agent.watchlist.map((w) => w.toLowerCase())) : null
  let best: FleetCandidate | null = null
  let bestScore = -Infinity
  for (const c of candidates) {
    const addr = c.tokenAddress.toLowerCase()
    if (claimed.has(addr) || heldByAgent.has(addr)) continue
    if (watch && !watch.has(addr)) continue
    if (c.trustScore < agent.minTrust) continue
    if (!profile.filter(c, agent)) continue
    const s = profile.score(c)
    if (s > bestScore) { bestScore = s; best = c }
  }
  return best
}

// ════════════════════════════════════════════════════════════════════════
// OPEN sweep
// ════════════════════════════════════════════════════════════════════════

export async function tickAllFleetAgents(): Promise<FleetBuyResult> {
  const out: FleetBuyResult = { scanned: 0, ticked: 0, bought: 0, skipped: 0, errors: 0 }

  const settings = await getFleetSettings()
  if (settings.globalPaused) return out

  // Effective live mode for NEW positions requires BOTH the DB toggle AND the
  // FLEET_LIVE_TRADING env gate (prod-only). If the DB flag is on but the env
  // gate is off (e.g. dev/staging), opens silently fall back to mock so no real
  // BNB is ever spent. Exits are NOT gated this way — a real bag opened while
  // live must always be sellable to exit (see closePosition / position.mock).
  const liveEffective = settings.liveTrading && isFleetLiveTradingEnabled()

  const agents = (await listFleetAgents()).filter((a) => a.status === 'active')
  out.scanned = agents.length
  if (agents.length === 0) return out

  const candidates = await getFleetCandidates(80)
  if (candidates.length === 0) return out

  const [stats, openCounts, openTokens] = await Promise.all([
    getTodayStats(),
    getOpenPositionCounts(),
    getOpenTokensByAgent(),
  ])

  const claimed = new Set<string>()

  for (const agent of shuffle(agents)) {
    const gate = agentOpenGate(agent, stats.get(agent.id), openCounts.get(agent.id) ?? 0)
    if (gate) { out.skipped += 1; continue }
    out.ticked += 1

    const held = openTokens.get(agent.id) ?? new Set<string>()
    const candidate = pickCandidate(agent, candidates, claimed, held)
    if (!candidate) { out.skipped += 1; continue }

    // 4-LLM brain (opt-in): confirm or veto the mechanically-picked candidate.
    // Gated by BOTH the env master switch and this agent's swarm_enabled flag,
    // so with either off this block is skipped entirely (zero cost / behavior
    // change). Fail-safe in every non-BUY case (SKIP consensus, no quorum, no
    // live providers, or a thrown error): we DON'T buy. The brain can only ever
    // remove a mechanical buy, never create one.
    let brainVerdict: FleetVerdict<'BUY' | 'SKIP'> | undefined
    if (isFleetSwarmEnabled() && agent.swarmEnabled) {
      try {
        brainVerdict = await getEntryVerdict({
          tokenAddress: candidate.tokenAddress,
          version: candidate.version,
          trustScore: candidate.trustScore,
          fillPct: candidate.fillPct,
          fundsBnb: candidate.fundsBnb,
          buyerCount: candidate.buyerCount,
          buyCount: candidate.buyCount,
          sellCount: candidate.sellCount,
          volumeBnb: candidate.volumeBnb,
          devHoldsPct: candidate.devHoldsPct,
          ageMinutes: candidate.firstSeenAt ? (Date.now() - candidate.firstSeenAt.getTime()) / 60_000 : null,
        })
      } catch (err) {
        out.skipped += 1
        await logFleet(agent.id, 'decision',
          `${agent.strategy} brain error — skip ${candidate.tokenAddress.slice(0, 10)}…: ${(err as Error).message}`,
          { token: candidate.tokenAddress, kind: 'entry' })
        continue
      }
      if (brainVerdict.action !== 'BUY') {
        out.skipped += 1
        await logFleet(agent.id, 'decision',
          `${agent.strategy} VETO ${candidate.tokenAddress.slice(0, 10)}… · ${brainVerdict.summary}`,
          { token: candidate.tokenAddress, kind: 'entry', verdict: brainVerdict.action, agreement: brainVerdict.agreement, votes: brainVerdict.votes })
        continue
      }
    }

    try {
      const opened = await openPosition(agent, candidate, liveEffective, brainVerdict)
      claimed.add(candidate.tokenAddress.toLowerCase())
      if (!opened) { out.skipped += 1; continue } // lost the (agent,token) claim — no spend
      openCounts.set(agent.id, (openCounts.get(agent.id) ?? 0) + 1)
      const s = stats.get(agent.id) ?? { buys: 0, pnl: 0 }
      stats.set(agent.id, { buys: s.buys + 1, pnl: s.pnl })
      await markFleetTick(agent.id)
      out.bought += 1
    } catch (err) {
      out.errors += 1
      await logFleet(agent.id, 'error', `buy failed: ${(err as Error).message}`, { token: candidate.tokenAddress })
    }
  }

  return out
}

async function openPosition(agent: FleetAgent, c: FleetCandidate, live: boolean, brain?: FleetVerdict<'BUY' | 'SKIP'>): Promise<boolean> {
  const token = ethers.getAddress(c.tokenAddress)
  const buyWei = ethers.parseEther(agent.maxTradeSizeBnb.toString())
  const posId = `fpos_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

  // Ride-through is decided ONCE, at entry: a very-high-trust launch is NOT
  // force-sold at graduation — it migrates with the token onto PancakeSwap and
  // is managed there (see evaluateExit). Same trust threshold as the four.meme
  // snipe agent (shouldRideThrough / TRUST_VERY_HIGH), but gated behind the
  // FLEET_RIDE_THROUGH_ENABLED master switch so the default is zero-change.
  const rideThrough = isFleetRideThroughEnabled() && shouldRideThrough(c.trustScore)

  // Real quote regardless of mode (live chain data).
  const info = await __testDeps.getTokenInfo(token)
  const quote = await __testDeps.quoteBuyByBnb(token, buyWei)
  const tokensWei = quote.estimatedAmountWei
  if (tokensWei <= 0n) throw new Error('quote returned zero tokens')
  const entryCostBnb = Number(ethers.formatEther(quote.estimatedCostWei + quote.estimatedFeeWei)) || agent.maxTradeSizeBnb
  const tokensHuman = Number(ethers.formatUnits(tokensWei, 18))
  const priceBnb = tokensHuman > 0 ? entryCostBnb / tokensHuman : 0
  const mock = !live

  // CLAIM FIRST, SPEND SECOND. The partial unique index
  // fleet_positions_open_unique enforces one open bag per (agent, token), so
  // this INSERT … ON CONFLICT DO NOTHING atomically reserves the pair. If we
  // lose the claim (row already open) we return false WITHOUT sending any tx —
  // so a race can never double-spend real BNB on the same token.
  const claimed = await db.$executeRawUnsafe(
    `INSERT INTO "fleet_positions" (
       "id","agent_id","token_address","version","entry_bnb_wei","entry_cost_bnb",
       "tokens_wei","buy_tx","entry_fill_pct","trust_at_entry","mock","ride_through","status"
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10,$11,'open')
     ON CONFLICT ("agent_id", "token_address") WHERE "status" = 'open' DO NOTHING`,
    posId, agent.id, token.toLowerCase(), info.version, buyWei.toString(), entryCostBnb,
    tokensWei.toString(), info.fillPct, c.trustScore, mock, rideThrough,
  )
  if (Number(claimed) === 0) return false // already holding this token — no spend, no trade row

  let txHash: string | null = null
  if (live) {
    if (!__testDeps.isFourMemeEnabled()) {
      await db.$executeRawUnsafe(`DELETE FROM "fleet_positions" WHERE "id" = $1 AND "status" = 'open'`, posId)
      throw new Error('four.meme disabled (FOUR_MEME_ENABLED) — cannot trade live')
    }
    try {
      const pk = __testDeps.decryptFleetAgentKey(agent)
      const res = await __testDeps.buyTokenWithBnb(pk, token, buyWei, { slippageBps: agent.slippageBps })
      txHash = res.txHash ?? null
      await db.$executeRawUnsafe(`UPDATE "fleet_positions" SET "buy_tx" = $1 WHERE "id" = $2`, txHash, posId)
    } catch (err) {
      // Buy failed — release the claim so the token is tradeable again.
      await db.$executeRawUnsafe(`DELETE FROM "fleet_positions" WHERE "id" = $1 AND "status" = 'open'`, posId)
      throw err
    }
  }

  await db.$executeRawUnsafe(
    `INSERT INTO "fleet_trades" (
       "id","agent_id","position_id","side","token_address","amount_bnb",
       "tokens_wei","price_bnb","status","mock","tx_hash","reason"
     ) VALUES ($1,$2,$3,'buy',$4,$5,$6,$7,'filled',$8,$9,$10)`,
    `ftr_${posId}_b`, agent.id, posId, token.toLowerCase(), entryCostBnb,
    tokensWei.toString(), priceBnb, mock, txHash,
    `${agent.strategy} entry · trust ${c.trustScore} · fill ${(info.fillPct * 100).toFixed(0)}%` +
      `${rideThrough ? ' · ride-through' : ''}${brain ? ` · ${brain.summary}` : ''}`,
  )
  await logFleet(agent.id, 'trade',
    `${mock ? '[MOCK] ' : ''}BUY ${agent.maxTradeSizeBnb} BNB → ${token.slice(0, 10)}… (${agent.strategy}, trust ${c.trustScore}${rideThrough ? ', ride-through' : ''})`,
    { token, posId, tokensWei: tokensWei.toString(), mock, txHash, rideThrough })
  // Brain feed: record the per-provider votes behind the confirmed BUY so the
  // /fleet panel can show WHY the swarm green-lit this entry.
  if (brain) {
    await logFleet(agent.id, 'decision',
      `${agent.strategy} BUY-confirm ${token.slice(0, 10)}… · ${brain.summary}`,
      { token, posId, kind: 'entry', verdict: brain.action, agreement: brain.agreement, confidence: brain.confidence, votes: brain.votes })
  }
  return true
}

// ════════════════════════════════════════════════════════════════════════
// CLOSE sweep
// ════════════════════════════════════════════════════════════════════════

// Stale-claim reaper — a worker that crashed mid-sell (process killed, no catch
// ran) leaves claim_token set forever, freezing that bag because closePosition's
// CAS lock requires `claim_token IS NULL`. Reclaim any open position whose claim
// is older than the lease so a later exit tick can retry it. Safe multi-process:
// the lease is far longer than any healthy live sell, so a still-running (slow
// RPC) sell is never disturbed. Best-effort — a reap failure must not stop the
// exit sweep. Mirrors the four.meme snipe-exit reaper contract.
async function reapStaleExitClaims(): Promise<number> {
  try {
    const reaped = await db.$executeRawUnsafe(
      `UPDATE "fleet_positions"
          SET "claim_token" = NULL, "claim_at" = NULL
        WHERE "status" = 'open'
          AND "claim_token" IS NOT NULL
          AND "claim_at" IS NOT NULL
          AND "claim_at" < now() - ($1 || ' seconds')::interval`,
      String(FLEET_CLAIM_LEASE_SEC),
    )
    return Number(reaped) || 0
  } catch (e) {
    console.warn('[fleet] stale-claim reap failed:', (e as Error).message)
    return 0
  }
}

export async function tickAllFleetExits(): Promise<FleetExitResult> {
  const out: FleetExitResult = { scanned: 0, evaluated: 0, sold: 0, errors: 0, reaped: 0 }

  // global_paused is a true kill switch — it halts EVERY agent, exits
  // included (matches the ensureTables contract). The admin takes manual
  // control of open bags while paused.
  const settings = await getFleetSettings()
  if (settings.globalPaused) return out

  out.reaped = await reapStaleExitClaims()
  if (out.reaped > 0) {
    // A reap means a worker crashed mid-sell and left a position frozen. One-off
    // reaps are benign (a single redeploy mid-sell), but repeated reaps signal a
    // broken sell path / RPC / process instability — the caller escalates those
    // to admins. Always log the count here so the signal is never lost.
    console.warn(`[fleet] reaped ${out.reaped} stale exit-claim(s) (crashed mid-sell)`)
  }

  const positions = await db.$queryRawUnsafe<any[]>(
    `SELECT * FROM "fleet_positions" WHERE "status" = 'open' ORDER BY "opened_at" ASC`,
  )
  out.scanned = positions.length
  if (positions.length === 0) return out

  const agents = await listFleetAgents()
  const agentById = new Map(agents.map((a) => [a.id, a]))

  for (const p of positions) {
    const agent = agentById.get(p.agent_id)
    if (!agent) continue
    out.evaluated += 1
    try {
      const decision = await evaluateExit(p, agent)
      if (decision) {
        const closed = await closePosition(p, agent, decision.proceedsBnb, decision.reason, !!p.mock, decision.venue, decision.sellWei)
        if (closed) out.sold += 1
      }
    } catch (err) {
      out.errors += 1
      await logFleet(agent.id, 'error', `exit eval failed: ${(err as Error).message}`, { posId: p.id })
    }
  }

  return out
}

async function evaluateExit(p: any, agent: FleetAgent): Promise<{ proceedsBnb: number; reason: string; venue: 'fourmeme' | 'pancake'; sellWei: bigint } | null> {
  const token = ethers.getAddress(p.token_address)
  const recordedWei = BigInt(p.tokens_wei)
  if (recordedWei <= 0n) return null

  const rideThrough = !!p.ride_through
  const storedVenue: 'fourmeme' | 'pancake' = p.venue === 'pancake' ? 'pancake' : 'fourmeme'

  // ── Sell the wallet's ACTUAL balance, not the recorded buy-quote amount. ──
  // four.meme tokens routinely apply a transfer tax / deliver a partial fill,
  // so the wallet ends up holding fewer tokens than the buy quote recorded.
  // Quoting or selling the recorded amount makes the sell's estimateGas revert
  // with "ERC20: transfer amount exceeds balance", which strands the bag forever
  // — it can never exit, so the agent's capital never recycles. Clamp to the
  // live on-chain balance. A bag whose real balance is a rounding-dust fraction
  // of what we recorded is phantom (the buy never actually delivered the tokens)
  // — reap it (close, no sell tx) so the agent's position slot frees at once.
  // Mock bags hold no real tokens, so they keep using the recorded amount
  // (re-quoted for honest simulated PnL).
  let sellWei = recordedWei
  let suspectedPhantom = false
  if (!p.mock) {
    let balWei = recordedWei
    try { balWei = await __testDeps.tokenBalanceOf(token, agent.walletAddress) }
    catch { balWei = recordedWei }
    sellWei = balWei < recordedWei ? balWei : recordedWei
    // Nothing left to sell — definitively phantom (the buy never delivered). Reap
    // now; there's nothing to quote.
    if (sellWei <= 0n) {
      return { proceedsBnb: 0, reason: 'reap_empty', venue: storedVenue, sellWei: 0n }
    }
    // Wallet holds only a dust fraction of what we recorded buying. Flag it so we
    // can reap AFTER quoting — but only if the residual is worth less than gas
    // (see FLEET_REAP_MIN_BNB). This avoids abandoning a tiny token balance that
    // is actually worth real BNB after a large price move.
    suspectedPhantom = sellWei <= recordedWei / 1000n
  }

  const info = await __testDeps.getTokenInfo(token)
  const graduated = !!info.graduatedToPancake || storedVenue === 'pancake'

  // Quote on the venue that actually holds the liquidity. Once a token
  // graduates, the bonding curve is closed — the only place to sell is
  // PancakeSwap — so a graduated bag (ride-through or not) is quoted/sold there.
  let proceedsBnb: number
  let venue: 'fourmeme' | 'pancake'
  if (graduated) {
    venue = 'pancake'
    const q = await __testDeps.pancakeQuoteSell(token, sellWei)
    proceedsBnb = Number(ethers.formatEther(q.estimatedBnbWei))
  } else {
    venue = 'fourmeme'
    const q = await __testDeps.quoteSell(token, sellWei)
    proceedsBnb = Number(ethers.formatEther(q.fundsWei))
  }

  // Value-gated phantom reap: a dust-balance bag whose quoted residual is worth
  // less than the sell gas is unsellable junk clogging the agent's slot — reap it
  // (close, no tx). A dust balance that has mooned above the floor is NOT reaped;
  // it falls through to the normal TP/SL exit logic and is sold (clamped).
  if (suspectedPhantom && proceedsBnb < FLEET_REAP_MIN_BNB) {
    return { proceedsBnb: 0, reason: 'reap_empty', venue, sellWei: 0n }
  }

  const entryCost = Number(p.entry_cost_bnb) || 0
  const pnlPct = entryCost > 0 ? ((proceedsBnb - entryCost) / entryCost) * 100 : 0
  const fillPct = info.fillPct * 100

  // Persist the four.meme → pancake transition once, so later ticks quote
  // pancake directly and the panel shows the live venue.
  if (venue === 'pancake' && storedVenue !== 'pancake') {
    await db.$executeRawUnsafe(`UPDATE "fleet_positions" SET "venue" = 'pancake' WHERE "id" = $1`, p.id)
  }

  // ── HARD STOP-LOSS — unconditional, evaluated FIRST so neither ride-through
  //    nor the LLM brain can ever block a protective exit. ──
  if (pnlPct <= -agent.stopLossPct) return { proceedsBnb, reason: `stop_loss ${pnlPct.toFixed(0)}%`, venue, sellWei }

  // ── MAX-HOLD forced exit — recycle frozen capital. A bag open longer than
  //    FLEET_MAX_HOLD_MIN is force-sold at market regardless of PnL (and
  //    regardless of ride-through), so the agent's capital and its position slot
  //    recycle into the next trade instead of sitting underwater waiting for the
  //    +TP that four.meme dumps rarely hit. Evaluated after the hard stop-loss so
  //    a stopped-out bag keeps that more informative reason. ──
  if (FLEET_MAX_HOLD_MIN > 0 && p.opened_at) {
    const ageMin = (Date.now() - new Date(p.opened_at).getTime()) / 60000
    if (ageMin >= FLEET_MAX_HOLD_MIN) {
      return { proceedsBnb, reason: `max_hold ${ageMin.toFixed(0)}m (PnL ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(0)}%)`, venue, sellWei }
    }
  }

  if (graduated) {
    // Non-ride-through bag: legacy behavior — don't hold past migration, exit
    // now (on pancake). reason kept as 'graduated' for dashboard continuity.
    if (!rideThrough) return { proceedsBnb, reason: 'graduated', venue, sellWei }

    // Ride-through bag: actively managed on PancakeSwap. Track peak PnL% for the
    // trailing stop (persisted so it survives across exit ticks / redeploys).
    const prevPeak = p.peak_pnl_pct != null ? Number(p.peak_pnl_pct) : pnlPct
    const peak = Math.max(prevPeak, pnlPct)
    if (p.peak_pnl_pct == null || peak > prevPeak) {
      await db.$executeRawUnsafe(`UPDATE "fleet_positions" SET "peak_pnl_pct" = $1 WHERE "id" = $2`, peak, p.id)
    }
    if (pnlPct >= agent.takeProfitPct) return { proceedsBnb, reason: `take_profit +${pnlPct.toFixed(0)}%`, venue, sellWei }
    // Trailing stop: once we've run up past the trail band, exit if we give back
    // FLEET_TRAIL_PCT points from the peak (locks in a graduated runner).
    if (peak >= FLEET_TRAIL_PCT && (peak - pnlPct) >= FLEET_TRAIL_PCT) {
      return { proceedsBnb, reason: `trailing_stop ${pnlPct.toFixed(0)}% (peak +${peak.toFixed(0)}%)`, venue, sellWei }
    }
    const swarmReason = await maybeSwarmExit(p, agent, token, info, venue)
    if (swarmReason) return { proceedsBnb, reason: swarmReason, venue, sellWei }
    return null
  }

  // ── Still on the bonding curve ──
  if (pnlPct >= agent.takeProfitPct) return { proceedsBnb, reason: `take_profit +${pnlPct.toFixed(0)}%`, venue, sellWei }
  // Pre-migration fill exit — SUPPRESSED for ride-through bags so they're allowed
  // to graduate and keep running on pancake instead of being sold near the top of
  // the curve.
  if (!rideThrough && fillPct >= agent.exitFillPct) {
    return { proceedsBnb, reason: `pre_migration fill ${fillPct.toFixed(0)}%`, venue, sellWei }
  }
  const swarmReason = await maybeSwarmExit(p, agent, token, info, venue)
  if (swarmReason) return { proceedsBnb, reason: swarmReason, venue, sellWei }
  return null
}

/**
 * 4-LLM brain exit consult (opt-in). Returns a SELL reason when the swarm
 * reaches a SELL quorum, else null. Gated by FLEET_SWARM_ENABLED + the agent's
 * swarm_enabled flag, so with either off this is a no-op (zero cost). Fail-safe:
 * a thrown brain error never forces a sell — the mechanical TP/SL/trailing layer
 * (evaluated above, including the unconditional hard stop-loss) always protects
 * the position. The per-provider votes are logged to the /fleet brain feed.
 */
async function maybeSwarmExit(
  p: any, agent: FleetAgent, token: string, info: any, venue: 'fourmeme' | 'pancake',
): Promise<string | null> {
  if (!isFleetSwarmEnabled() || !agent.swarmEnabled) return null
  let verdict: FleetVerdict<'HOLD' | 'SELL'>
  try {
    verdict = await getExitVerdict({
      tokenAddress: token,
      symbol: info.symbol ?? null,
      venue,
      fillPct: typeof info.fillPct === 'number' ? info.fillPct : 0,
      graduated: venue === 'pancake',
    })
  } catch (err) {
    await logFleet(agent.id, 'decision',
      `${agent.strategy} exit-brain error ${token.slice(0, 10)}…: ${(err as Error).message}`,
      { posId: p.id, token, kind: 'exit' })
    return null
  }
  await logFleet(agent.id, 'decision',
    `${agent.strategy} exit ${verdict.action ?? 'no-quorum'} ${token.slice(0, 10)}… · ${verdict.summary}`,
    { posId: p.id, token, kind: 'exit', verdict: verdict.action, agreement: verdict.agreement, confidence: verdict.confidence, votes: verdict.votes })
  return verdict.action === 'SELL' ? `swarm_exit (${verdict.agreement})` : null
}

async function closePosition(p: any, agent: FleetAgent, proceedsBnb: number, reason: string, mock: boolean, venue?: 'fourmeme' | 'pancake', sellWei?: bigint): Promise<boolean> {
  const token = ethers.getAddress(p.token_address)
  // sellWei (from evaluateExit) is the wallet's ACTUAL clamped balance; callers
  // that don't pass it (tests) fall back to the recorded amount. A zero amount
  // is a REAP: the bag holds no real tokens, so we close it WITHOUT a sell tx
  // (which would only revert) to free the agent's slot and recycle the capital.
  const tokensWei = sellWei ?? BigInt(p.tokens_wei)
  // Sell venue: explicit (from evaluateExit) wins; otherwise fall back to the
  // row's persisted venue. Graduated/ride-through bags route to PancakeSwap.
  const sellVenue: 'fourmeme' | 'pancake' = venue ?? (p.venue === 'pancake' ? 'pancake' : 'fourmeme')
  let txHash: string | null = null
  let finalProceeds = proceedsBnb

  // CAS-LOCK BEFORE SELLING. Acquire an exclusive claim on the position
  // *before* any live sell tx, so two overlapping exit ticks can never both
  // submit a real sell (duplicate gas burn). We do NOT time-expire an active
  // lock: a slow/stalled live sell (RPC hang) must never have its lock taken
  // over by a second worker, or both could sell. claim_at is recorded for
  // observability only; reclaim of crashed-worker locks is handled out-of-band.
  const claimTok = `fcl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const lock = await db.$executeRawUnsafe(
    `UPDATE "fleet_positions"
        SET "claim_token" = $1, "claim_at" = NOW()
      WHERE "id" = $2 AND "status" = 'open' AND "claim_token" IS NULL`,
    claimTok, p.id,
  )
  if (Number(lock) === 0) return false // another worker holds the lock

  if (!mock && tokensWei > 0n) {
    // four.meme master switch only gates four.meme curve sells. A graduated bag
    // sells on PancakeSwap, so it must NOT be blocked by FOUR_MEME_ENABLED.
    if (sellVenue === 'fourmeme' && !__testDeps.isFourMemeEnabled()) {
      // Ownership-scoped release: only clear OUR lock.
      await db.$executeRawUnsafe(
        `UPDATE "fleet_positions" SET "claim_token" = NULL WHERE "id" = $1 AND "claim_token" = $2`, p.id, claimTok)
      throw new Error('four.meme disabled — cannot sell live')
    }
    // Kill-switch recheck immediately before the live sell: if an admin flips
    // global pause mid-sweep, fail closed and release our lock instead of selling.
    const live = await __testDeps.getFleetSettings()
    if (live.globalPaused) {
      await db.$executeRawUnsafe(
        `UPDATE "fleet_positions" SET "claim_token" = NULL WHERE "id" = $1 AND "claim_token" = $2`, p.id, claimTok)
      return false
    }
    try {
      const pk = __testDeps.decryptFleetAgentKey(agent)
      let res: { txHash?: string | null; estimatedBnbWei?: bigint }
      if (sellVenue === 'pancake') {
        // PancakeSwap V2 router enforces a hard slippage ceiling; clamp the
        // agent's configured slippage so a high four.meme setting can't push a
        // pancake sell past PANCAKE_HARD_MAX_SLIPPAGE_BPS (which would throw).
        const slippageBps = Math.min(agent.slippageBps, PANCAKE_HARD_MAX_SLIPPAGE_BPS)
        res = await __testDeps.pancakeSellTokenForBnb(pk, token, tokensWei, { slippageBps })
      } else {
        res = await __testDeps.sellTokenForBnb(pk, token, tokensWei, { slippageBps: agent.slippageBps })
      }
      txHash = res.txHash ?? null
      if (res.estimatedBnbWei) finalProceeds = Number(ethers.formatEther(res.estimatedBnbWei))
    } catch (err) {
      // Sell failed — release ONLY our lock so a later tick can retry the exit.
      await db.$executeRawUnsafe(
        `UPDATE "fleet_positions" SET "claim_token" = NULL WHERE "id" = $1 AND "claim_token" = $2`, p.id, claimTok)
      throw err
    }
  }

  // Finalize under the lock we already hold.
  const res = await db.$executeRawUnsafe(
    `UPDATE "fleet_positions"
        SET "status" = 'closed', "exit_reason" = $1, "exit_proceeds_bnb" = $2,
            "exit_tx" = $3, "closed_at" = NOW(), "claim_token" = NULL
      WHERE "id" = $4 AND "status" = 'open' AND "claim_token" = $5`,
    reason, finalProceeds, txHash, p.id, claimTok,
  )
  if (Number(res) === 0) return false // lost the race after selling (should not happen — we hold the lock)

  const entryCost = Number(p.entry_cost_bnb) || 0
  const pnl = finalProceeds - entryCost
  await db.$executeRawUnsafe(
    `INSERT INTO "fleet_trades" (
       "id","agent_id","position_id","side","token_address","amount_bnb",
       "tokens_wei","pnl_bnb","status","mock","tx_hash","reason"
     ) VALUES ($1,$2,$3,'sell',$4,$5,$6,$7,'filled',$8,$9,$10)`,
    `ftr_${p.id}_s`, agent.id, p.id, token.toLowerCase(), finalProceeds,
    tokensWei.toString(), pnl, mock, txHash, reason,
  )
  await logFleet(agent.id, 'trade',
    `${mock ? '[MOCK] ' : ''}SELL ${token.slice(0, 10)}… → ${finalProceeds.toFixed(5)} BNB (PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(5)}) · ${reason}`,
    { token, posId: p.id, pnl, mock, txHash })
  return true
}

// Test-only handle on the module-private trade functions so the concurrency
// suite (fleetAgent.test.ts) can drive the REAL open/close paths. Not used by
// production code.
export const __test = { openPosition, closePosition, evaluateExit, reapStaleExitClaims, pickCandidate }
