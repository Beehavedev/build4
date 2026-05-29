// ─────────────────────────────────────────────────────────────────────────
// fourMemeSnipeAgent — Task #149: autonomous four.meme SNIPING.
//
// Replaces the old launch loop (fourMemeLaunchAgent). Instead of creating
// tokens, agents BUY other people's fresh bonding-curve launches that the
// scanner (fourMemeScanner) has scored as trustworthy, then EXIT before
// the curve migrates — or ride very-high-trust curves through migration
// and sell on Pancake.
//
// Two sweeps, both driven from the runner on a fast cadence:
//   • tickAllFourMemeSnipeAgents — per agent: pick top trusted candidates
//     from four_meme_launches_seen, buy with capped size+slippage+broker
//     fee, record the open position, fire the competition hook, log to the
//     brain feed.
//   • tickAllFourMemeSnipeExits — per open position: exit on rug / SL / TP
//     / fill-threshold (pre-migration), or ride-through → Pancake sell.
//     A claim_token CAS lock prevents two workers double-selling a bag.
//
// Master kill-switch: FOUR_MEME_ENABLED (underlying feature flag) AND
// FOUR_MEME_AGENT_SNIPE_ENABLED. Fail-closed.
// ─────────────────────────────────────────────────────────────────────────

import { ethers } from 'ethers'
import { db } from '../db'
import { buildBscProvider } from '../services/bscProvider'
import {
  isFourMemeEnabled,
  loadUserBscPrivateKey,
  buyTokenWithBnb,
  sellTokenForBnb,
  quoteSell,
  getTokenInfo,
} from '../services/fourMemeTrading'
import { pancakeSellTokenForBnb } from '../services/pancakeSwapTrading'
import { shouldRideThrough, TRUST_MIN_BUY } from '../services/fourMemeTrust'

// ── Tunables ─────────────────────────────────────────────────────────
function envNum(name: string, fallback: number): number {
  const v = process.env[name]
  if (v === undefined || v.trim() === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

// Per-buy size default (BNB) when the agent hasn't set fourMemeSnipeBuyBnb.
const DEFAULT_BUY_BNB = envNum('FOUR_MEME_SNIPE_BUY_BNB', 0.01)
// Hard ceiling on any single snipe buy, regardless of per-agent config —
// bounds blast radius the same way the launch agent capped initial buys.
const MAX_BUY_BNB = envNum('FOUR_MEME_SNIPE_MAX_BUY_BNB', 0.05)
// Slippage cap for snipe buys (curves move fast; default 8%).
const SNIPE_SLIPPAGE_BPS = Math.round(envNum('FOUR_MEME_SNIPE_SLIPPAGE_BPS', 800))
// Pancake ride-through exit slippage (deep liquidity; default 5%, hard-capped by the trading module).
const RIDE_EXIT_SLIPPAGE_BPS = Math.round(envNum('FOUR_MEME_SNIPE_RIDE_SLIPPAGE_BPS', 500))
const DEFAULT_MAX_POSITIONS = Math.round(envNum('FOUR_MEME_SNIPE_MAX_POSITIONS', 3))
const DEFAULT_TP_PCT = envNum('FOUR_MEME_SNIPE_TP_PCT', 80)
const DEFAULT_SL_PCT = envNum('FOUR_MEME_SNIPE_SL_PCT', 40)
const DEFAULT_EXIT_FILL_PCT = envNum('FOUR_MEME_SNIPE_EXIT_FILL_PCT', 90) // percent
// Per-agent minimum gap between buys so a fast runner can't fire several
// buys for one agent in the same scan window.
const MIN_TICK_INTERVAL_MS = Math.round(envNum('FOUR_MEME_SNIPE_MIN_TICK_MS', 15_000))
// Exit-claim lease — a claim older than this is treated as a crashed
// worker and reclaimed by the next exit sweep. Generous vs a healthy
// approve+sell round-trip so we never reclaim an in-flight sell.
const CLAIM_LEASE_SEC = Math.round(envNum('FOUR_MEME_SNIPE_CLAIM_LEASE_SEC', 300))
// Trust floor below which an open position is exited as a likely rug, and
// the rug flags that justify an immediate exit when the scanner re-scores
// a held token after entry.
const EXIT_RUG_TRUST_FLOOR = Math.round(envNum('FOUR_MEME_SNIPE_EXIT_RUG_FLOOR', 30))
// Gas reserve kept in the wallet so a buy never strands the wallet
// without enough BNB to later approve/sell.
const GAS_RESERVE_BNB = envNum('FOUR_MEME_SNIPE_GAS_RESERVE_BNB', 0.005)
// How many top candidates the buy loop considers per sweep.
const CANDIDATE_POOL = Math.round(envNum('FOUR_MEME_SNIPE_CANDIDATE_POOL', 40))

const ERC20_MIN_ABI = [
  'function balanceOf(address) view returns (uint256)',
] as const

// ── Master kill-switch ───────────────────────────────────────────────
export function isAgentSnipeEnabled(): boolean {
  if (!isFourMemeEnabled()) return false
  return process.env.FOUR_MEME_AGENT_SNIPE_ENABLED === 'true'
}

// ─────────────────────────────────────────────────────────────────────
// Buy sweep
// ─────────────────────────────────────────────────────────────────────
interface SnipeAgentRow {
  id: string
  userId: string
  name: string
  buyBnb: number
  minTrust: number
  maxPositions: number
  lastTickAt: Date | null
}

interface CandidateRow {
  token_address: string
  trust_score: number | null
  fill_pct: number | null
  version: number | null
}

export interface SnipeBuyResult {
  scanned: number
  ticked: number
  bought: number
  skipped: number
  errors: number
}

let lastBuyResult: SnipeBuyResult | null = null
export function getLastFourMemeSnipeBuyResult(): SnipeBuyResult | null {
  return lastBuyResult
}

async function logBrain(agentId: string, userId: string, message: string): Promise<void> {
  try {
    await db.$executeRawUnsafe(
      `INSERT INTO "AgentLog" ("id","agentId","userId","exchange","level","message","createdAt")
       VALUES ($1,$2,$3,'four_meme','info',$4,now())`,
      `snipe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      agentId,
      userId,
      message,
    )
  } catch (e) {
    console.warn('[fourMemeSnipe] log insert failed:', (e as Error).message)
  }
}

export async function tickAllFourMemeSnipeAgents(): Promise<SnipeBuyResult> {
  const result: SnipeBuyResult = { scanned: 0, ticked: 0, bought: 0, skipped: 0, errors: 0 }
  if (!isAgentSnipeEnabled()) {
    lastBuyResult = result
    return result
  }

  let agents: SnipeAgentRow[] = []
  try {
    const rowsRaw = await db.$queryRawUnsafe<any[]>(
      `SELECT a."id", a."userId", a."name",
              a."fourMemeSnipeBuyBnb"        AS "buyBnb",
              a."fourMemeSnipeMinTrust"      AS "minTrust",
              a."fourMemeSnipeMaxPositions"  AS "maxPositions",
              a."lastFourMemeSnipeTickAt"    AS "lastTickAt"
         FROM "Agent" a
        WHERE a."isActive" = true
          AND COALESCE(a."fourMemeSnipeEnabled", false) = true`,
    )
    const { filterAgentsByActiveSubscription } = await import('../services/subscriptions')
    const filtered = await filterAgentsByActiveSubscription(rowsRaw, 'fourMemeSnipeAgent')
    agents = filtered.map<SnipeAgentRow>((r) => ({
      id: r.id,
      userId: r.userId,
      name: r.name,
      buyBnb: clampBuy(parseNum(r.buyBnb, DEFAULT_BUY_BNB)),
      minTrust: Number.isFinite(Number(r.minTrust)) && r.minTrust !== null ? Number(r.minTrust) : TRUST_MIN_BUY,
      maxPositions:
        Number.isFinite(Number(r.maxPositions)) && r.maxPositions !== null
          ? Math.max(1, Number(r.maxPositions))
          : DEFAULT_MAX_POSITIONS,
      lastTickAt: toDate(r.lastTickAt),
    }))
  } catch (e) {
    console.warn('[fourMemeSnipe] agent query failed:', (e as Error).message)
    result.errors += 1
    lastBuyResult = result
    return result
  }

  result.scanned = agents.length
  if (agents.length === 0) {
    lastBuyResult = result
    return result
  }

  // Shared candidate pool — top trusted, non-graduated, buyable launches.
  let candidates: CandidateRow[] = []
  try {
    candidates = await db.$queryRawUnsafe<CandidateRow[]>(
      `SELECT "token_address", "trust_score", "fill_pct", "version"
         FROM "four_meme_launches_seen"
        WHERE "verdict" = 'buy'
          AND COALESCE("graduated", false) = false
        ORDER BY "trust_score" DESC NULLS LAST, "first_seen_at" DESC
        LIMIT $1`,
      CANDIDATE_POOL,
    )
  } catch (e) {
    console.warn('[fourMemeSnipe] candidate query failed:', (e as Error).message)
    result.errors += 1
    lastBuyResult = result
    return result
  }
  if (candidates.length === 0) {
    lastBuyResult = result
    return result
  }

  const provider = buildBscProvider(process.env.BSC_RPC_URL)
  const now = Date.now()

  for (const agent of agents) {
    try {
      // Per-agent tick throttle.
      if (agent.lastTickAt && now - agent.lastTickAt.getTime() < MIN_TICK_INTERVAL_MS) {
        continue
      }
      result.ticked += 1

      // Open-position cap.
      const openRows = await db.$queryRawUnsafe<Array<{ token_address: string }>>(
        `SELECT "token_address" FROM "four_meme_positions"
          WHERE "agent_id" = $1 AND "status" = 'open'`,
        agent.id,
      )
      await stampTick(agent.id)
      if (openRows.length >= agent.maxPositions) {
        result.skipped += 1
        continue
      }
      const held = new Set(openRows.map((r) => r.token_address.toLowerCase()))

      // First candidate clearing the agent's trust bar that it doesn't
      // already hold.
      const pick = candidates.find(
        (c) =>
          !held.has(c.token_address.toLowerCase()) &&
          (c.trust_score ?? 0) >= agent.minTrust,
      )
      if (!pick) {
        result.skipped += 1
        continue
      }

      const token = ethers.getAddress(pick.token_address)

      // Load wallet + balance check.
      let creds: { address: string; privateKey: string }
      try {
        creds = await loadUserBscPrivateKey(agent.userId)
      } catch (e) {
        console.warn(`[fourMemeSnipe] ${agent.id}: load PK failed:`, (e as Error).message)
        result.errors += 1
        continue
      }
      const balWei = await provider.getBalance(creds.address)
      const buyWei = ethers.parseEther(agent.buyBnb.toFixed(18))
      const reserveWei = ethers.parseEther(GAS_RESERVE_BNB.toFixed(18))
      if (balWei < buyWei + reserveWei) {
        await logBrain(
          agent.id,
          agent.userId,
          `[SNIPE SKIP] ${token.slice(0, 10)}… insufficient BNB ` +
            `(have ${Number(ethers.formatEther(balWei)).toFixed(4)}, need ` +
            `${(agent.buyBnb + GAS_RESERVE_BNB).toFixed(4)})`,
        )
        result.skipped += 1
        continue
      }

      // Re-verify the curve right before buying (the scanner snapshot may
      // be a few seconds stale). Refuse graduated/unsupported curves.
      let info
      try {
        info = await getTokenInfo(token)
      } catch (e) {
        console.warn(`[fourMemeSnipe] ${agent.id}: getTokenInfo failed:`, (e as Error).message)
        result.errors += 1
        continue
      }
      if (info.graduatedToPancake || !info.quoteIsBnb || info.version !== 2) {
        result.skipped += 1
        continue
      }

      // Buy — capped size + slippage + broker fee (fail-closed via feeCtx).
      let buyRes: Awaited<ReturnType<typeof buyTokenWithBnb>>
      try {
        buyRes = await buyTokenWithBnb(creds.privateKey, token, buyWei, {
          slippageBps: SNIPE_SLIPPAGE_BPS,
          feeCtx: { userId: agent.userId, agentId: agent.id, venue: 'fourmeme', side: 'buy' },
        })
      } catch (e) {
        console.warn(`[fourMemeSnipe] ${agent.id}: buy failed:`, (e as Error).message)
        await logBrain(agent.id, agent.userId, `[SNIPE FAIL] ${token.slice(0, 10)}… ${(e as Error).message.slice(0, 100)}`)
        result.errors += 1
        continue
      }

      const rideThrough = shouldRideThrough(pick.trust_score ?? 0)
      const entryCostBnb = Number(ethers.formatEther(buyRes.bnbSpentWei))

      // Record the open position. The partial unique index guards against
      // a duplicate open row for the same (agent, token). RETURNING + the
      // DO NOTHING clause lets us tell three cases apart:
      //   • returned a row   → fresh entry (count + log + competition hook)
      //   • returned nothing, no throw → CONFLICT: an open position already
      //       exists; the on-chain buy just topped up that bag and the exit
      //       sweep sells the full balanceOf, so it stays managed. Benign.
      //   • threw            → a REAL DB error (NOT a conflict, since
      //       ON CONFLICT suppresses those). We just spent BNB on-chain but
      //       failed to persist the bag — retry, and if it still fails,
      //       raise a loud ORPHANED-BUY alert so an operator can reconcile.
      const insertPosition = () =>
        db.$queryRawUnsafe<Array<{ id: string }>>(
          `INSERT INTO "four_meme_positions"
             ("id","agent_id","user_id","token_address","version","entry_bnb_wei",
              "entry_cost_bnb","tokens_wei","buy_tx","entry_fill_pct","trust_at_entry",
              "ride_through","status","opened_at")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'open',now())
           ON CONFLICT ("agent_id","token_address") WHERE "status" = 'open' DO NOTHING
           RETURNING "id"`,
          `pos_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          agent.id,
          agent.userId,
          token.toLowerCase(),
          info.version,
          buyRes.bnbSpentWei.toString(),
          entryCostBnb,
          buyRes.estimatedTokensWei.toString(),
          buyRes.txHash,
          info.fillPct,
          pick.trust_score ?? null,
          rideThrough,
        )

      let inserted = false
      let conflict = false
      let persistError: Error | null = null
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const ins = await insertPosition()
          inserted = ins.length > 0
          conflict = ins.length === 0
          persistError = null
          break
        } catch (e) {
          persistError = e as Error
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)))
        }
      }

      if (persistError) {
        // Bought on-chain but could not persist after retries. The exit
        // sweep can only manage positions it can see, so this bag is at
        // risk — surface it loudly (console + brain feed) for manual
        // reconciliation. Don't count it as a managed buy.
        const alert =
          `[SNIPE ORPHAN] bought ${token} but FAILED to persist position ` +
          `after retries (${persistError.message.slice(0, 80)}). tokens=${buyRes.estimatedTokensWei.toString()} ` +
          `spent=${entryCostBnb.toFixed(4)} BNB buyTx=${buyRes.txHash} — MANUAL RECONCILE NEEDED`
        console.error(`[fourMemeSnipe] ${agent.id}: ${alert}`)
        await logBrain(agent.id, agent.userId, alert)
        result.errors += 1
        continue
      }

      if (conflict) {
        // Already holding an open position for this token — the extra bag is
        // covered by that row / the next exit sweep. Don't double-count.
        console.warn(
          `[fourMemeSnipe] ${agent.id}: bought ${token.slice(0, 10)}… topped up an existing ` +
            `open position tx=${buyRes.txHash.slice(0, 12)}…`,
        )
        continue
      }

      result.bought += 1

      // Competition hook (fire-and-forget — never blocks the trade).
      void recordCompetitionForUser(agent.userId, token)

      await logBrain(
        agent.id,
        agent.userId,
        `[SNIPE BUY] ${token.slice(0, 10)}… trust=${pick.trust_score ?? '?'} ` +
          `fill=${((info.fillPct) * 100).toFixed(0)}% spent=${entryCostBnb.toFixed(4)} BNB ` +
          `${rideThrough ? '· ride-through' : ''} tx=${buyRes.txHash.slice(0, 12)}…`,
      )
    } catch (e) {
      result.errors += 1
      console.error(`[fourMemeSnipe] ${agent.id}: unexpected:`, (e as Error).message)
    }
  }

  lastBuyResult = result
  return result
}

async function recordCompetitionForUser(userId: string, token: string): Promise<void> {
  try {
    const user = await db.user.findUnique({ where: { id: userId }, select: { telegramId: true } })
    if (!user?.telegramId) return
    const { recordCompetitionTrade } = await import('../services/competition')
    await recordCompetitionTrade({ chatId: user.telegramId.toString(), tokenAddress: token })
  } catch {
    /* non-fatal */
  }
}

// ─────────────────────────────────────────────────────────────────────
// Exit sweep
// ─────────────────────────────────────────────────────────────────────
interface PositionRow {
  id: string
  agentId: string
  userId: string
  tokenAddress: string
  entryCostBnb: number | null
  rideThrough: boolean
  tpPct: number
  slPct: number
  exitFillPct: number
}

export interface SnipeExitResult {
  scanned: number
  evaluated: number
  sold: number
  errors: number
}

let lastExitResult: SnipeExitResult | null = null
export function getLastFourMemeSnipeExitResult(): SnipeExitResult | null {
  return lastExitResult
}

async function closePosition(
  rowId: string,
  reason: string,
  proceedsBnb: number | null,
  exitTx: string | null,
): Promise<void> {
  await db.$executeRawUnsafe(
    `UPDATE "four_meme_positions"
        SET "status" = 'closed',
            "exit_reason" = $2,
            "exit_proceeds_bnb" = $3,
            "exit_tx" = $4,
            "closed_at" = now()
      WHERE "id" = $1`,
    rowId,
    reason.slice(0, 80),
    proceedsBnb,
    exitTx,
  )
}

export async function tickAllFourMemeSnipeExits(): Promise<SnipeExitResult> {
  const result: SnipeExitResult = { scanned: 0, evaluated: 0, sold: 0, errors: 0 }
  if (!isFourMemeEnabled()) {
    lastExitResult = result
    return result
  }

  // Stale-claim reaper — a worker that crashed mid-sell leaves claim_token
  // set and would freeze that position forever (the SELECT below filters
  // claim_token IS NULL). Reclaim any open position whose claim is older
  // than the lease so a later sweep can retry it. Safe even multi-process:
  // a still-running sell refreshes nothing, but the lease is long enough
  // (default 5 min) that a healthy sell completes well within it.
  try {
    await db.$executeRawUnsafe(
      `UPDATE "four_meme_positions"
          SET "claim_token" = NULL, "claim_at" = NULL
        WHERE "status" = 'open'
          AND "claim_token" IS NOT NULL
          AND "claim_at" IS NOT NULL
          AND "claim_at" < now() - ($1 || ' seconds')::interval`,
      String(CLAIM_LEASE_SEC),
    )
  } catch (e) {
    console.warn('[fourMemeSnipeExit] stale-claim reap failed:', (e as Error).message)
  }

  let rows: PositionRow[] = []
  try {
    const raw = await db.$queryRawUnsafe<any[]>(
      `SELECT p."id", p."agent_id" AS "agentId", p."user_id" AS "userId",
              p."token_address" AS "tokenAddress",
              p."entry_cost_bnb" AS "entryCostBnb",
              COALESCE(p."ride_through", false) AS "rideThrough",
              a."fourMemeSnipeTakeProfitPct"  AS "tpPct",
              a."fourMemeSnipeStopLossPct"    AS "slPct",
              a."fourMemeSnipeExitFillPct"    AS "exitFillPct"
         FROM "four_meme_positions" p
         JOIN "Agent" a ON a."id" = p."agent_id"
        WHERE p."status" = 'open'
          AND p."claim_token" IS NULL
          AND a."isActive" = true`,
    )
    const { filterAgentsByActiveSubscription } = await import('../services/subscriptions')
    const filtered = await filterAgentsByActiveSubscription(raw, 'fourMemeSnipeExit')
    rows = filtered.map<PositionRow>((r) => ({
      id: r.id,
      agentId: r.agentId,
      userId: r.userId,
      tokenAddress: r.tokenAddress,
      entryCostBnb: r.entryCostBnb !== null ? Number(r.entryCostBnb) : null,
      rideThrough: !!r.rideThrough,
      tpPct: numOr(r.tpPct, DEFAULT_TP_PCT),
      slPct: numOr(r.slPct, DEFAULT_SL_PCT),
      exitFillPct: numOr(r.exitFillPct, DEFAULT_EXIT_FILL_PCT),
    }))
  } catch (e) {
    console.warn('[fourMemeSnipeExit] query failed:', (e as Error).message)
    lastExitResult = { ...result, errors: 1 }
    return lastExitResult
  }

  result.scanned = rows.length
  if (rows.length === 0) {
    lastExitResult = result
    return result
  }

  const provider = buildBscProvider(process.env.BSC_RPC_URL)

  for (const row of rows) {
    try {
      const token = ethers.getAddress(row.tokenAddress)

      let creds: { address: string; privateKey: string }
      try {
        creds = await loadUserBscPrivateKey(row.userId)
      } catch (e) {
        console.warn(`[fourMemeSnipeExit] ${row.id}: load PK failed:`, (e as Error).message)
        continue
      }

      const erc20 = new ethers.Contract(token, ERC20_MIN_ABI, provider)
      const balWei: bigint = await erc20.balanceOf(creds.address)
      if (balWei <= 0n) {
        await closePosition(row.id, 'balance_zero', 0, null)
        continue
      }

      let info
      try {
        info = await getTokenInfo(token)
      } catch (e) {
        console.warn(`[fourMemeSnipeExit] ${row.id}: getTokenInfo failed:`, (e as Error).message)
        result.errors += 1
        continue
      }

      // ── Graduated → bonding-curve sells are dead. Exit via Pancake. ──
      if (info.graduatedToPancake) {
        if (!(await claim(row.id))) continue
        try {
          const sell = await pancakeSellTokenForBnb(creds.privateKey, token, balWei, {
            slippageBps: RIDE_EXIT_SLIPPAGE_BPS,
            feeCtx: { userId: row.userId, agentId: row.agentId, venue: 'pancake', side: 'sell' },
          })
          const proceeds = Number(ethers.formatEther(sell.estimatedBnbWei))
          await closePosition(row.id, row.rideThrough ? 'ride_through_pancake' : 'graduated_pancake', proceeds, sell.txHash)
          result.sold += 1
          await logBrain(
            row.agentId,
            row.userId,
            `[SNIPE EXIT pancake] ${token.slice(0, 10)}… proceeds≈${proceeds.toFixed(4)} BNB tx=${sell.txHash.slice(0, 12)}…`,
          )
        } catch (e) {
          console.warn(`[fourMemeSnipeExit] ${row.id}: pancake sell failed:`, (e as Error).message)
          await releaseClaim(row.id)
          result.errors += 1
        }
        continue
      }

      result.evaluated += 1

      // Quote the full bag on the curve.
      let proceedsBnb: number
      try {
        const q = await quoteSell(token, balWei)
        proceedsBnb = Number(ethers.formatEther(q.fundsWei))
      } catch (e) {
        console.warn(`[fourMemeSnipeExit] ${row.id}: quoteSell failed:`, (e as Error).message)
        result.errors += 1
        continue
      }

      const entryBnb = row.entryCostBnb && row.entryCostBnb > 0 ? row.entryCostBnb : null
      const pnlPct = entryBnb ? ((proceedsBnb / entryBnb) - 1) * 100 : null

      // Rug detection — instead of an expensive per-position re-scan, reuse
      // the scanner's latest enriched snapshot for this token (it already
      // tracks dev holdings, buyer breadth, and buy/sell counts). The
      // scanner re-scores held tokens on its fast cadence, so a dev dump /
      // wash collapse that lands AFTER entry shows up here as a rug verdict
      // or a trust score that has cratered below the floor. SL (proceeds
      // collapse) is the backstop when the scanner snapshot is stale.
      const snap = await readScannerSnapshot(token)
      const trustScore = snap?.trustScore ?? null
      const rugFlagged =
        (snap?.flags ? /whale|wash|heavy_selling/.test(snap.flags) : false) ||
        (trustScore !== null && trustScore <= EXIT_RUG_TRUST_FLOOR)

      // Decide whether to exit, and why (priority: rug → SL → fill → TP).
      let exitReason: string | null = null
      if (rugFlagged) {
        exitReason = `rug:${snap?.flags?.split(',').filter((f) => /whale|wash|selling/.test(f)).join('|') || `trust=${trustScore}`}`
      } else if (entryBnb && pnlPct !== null && pnlPct <= -row.slPct) {
        exitReason = `stop_loss:${pnlPct.toFixed(0)}%`
      } else if (!row.rideThrough && info.fillPct * 100 >= row.exitFillPct) {
        exitReason = `pre_migration:${(info.fillPct * 100).toFixed(0)}%`
      } else if (entryBnb && pnlPct !== null && pnlPct >= row.tpPct) {
        exitReason = `take_profit:+${pnlPct.toFixed(0)}%`
      }

      // Brain-feed HOLD/EXIT line every tick.
      await logBrain(
        row.agentId,
        row.userId,
        `[SNIPE ${exitReason ? 'EXIT' : 'HOLD'}] ${token.slice(0, 10)}… ` +
          `fill=${(info.fillPct * 100).toFixed(0)}% ` +
          `${entryBnb ? `pnl=${pnlPct! >= 0 ? '+' : ''}${pnlPct!.toFixed(0)}% ` : ''}` +
          `trust=${trustScore ?? '?'}${exitReason ? ` reason=${exitReason}` : ''}`,
      )

      if (!exitReason) continue

      // ── Exit on the curve ── CAS claim then sell the full bag.
      if (!(await claim(row.id))) continue
      try {
        const sell = await sellTokenForBnb(creds.privateKey, token, balWei, {
          slippageBps: SNIPE_SLIPPAGE_BPS,
          feeCtx: { userId: row.userId, agentId: row.agentId, venue: 'fourmeme', side: 'sell' },
        })
        const proceeds = Number(ethers.formatEther(sell.estimatedBnbWei))
        await closePosition(row.id, exitReason, proceeds, sell.txHash)
        result.sold += 1
        await logBrain(
          row.agentId,
          row.userId,
          `[SNIPE SOLD] ${token.slice(0, 10)}… reason=${exitReason} proceeds=${proceeds.toFixed(4)} BNB ` +
            `${entryBnb ? `pnl=${(((proceeds / entryBnb) - 1) * 100).toFixed(0)}% ` : ''}tx=${sell.txHash.slice(0, 12)}…`,
        )
      } catch (e) {
        const msg = (e as Error).message
        console.warn(`[fourMemeSnipeExit] ${row.id}: sell failed:`, msg)
        if (/V1_SELL_UNSAFE|GRADUATED/.test(msg)) {
          // Terminal for the curve path — close so we stop retrying.
          await closePosition(row.id, `sell_refused:${msg.slice(0, 30)}`, null, null)
        } else {
          await releaseClaim(row.id)
        }
        result.errors += 1
      }
    } catch (e) {
      result.errors += 1
      console.error(`[fourMemeSnipeExit] ${row.id}: unexpected:`, (e as Error).message)
    }
  }

  lastExitResult = result
  return result
}

// ── CAS claim helpers (claim_token doubles as a single-flight lock) ──
async function claim(rowId: string): Promise<boolean> {
  const token = `__claim_${Date.now()}_${Math.random().toString(36).slice(2, 6)}__`
  const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE "four_meme_positions"
        SET "claim_token" = $1, "claim_at" = now()
      WHERE "id" = $2 AND "status" = 'open' AND "claim_token" IS NULL
    RETURNING "id"`,
    token,
    rowId,
  )
  return rows.length > 0
}

async function releaseClaim(rowId: string): Promise<void> {
  try {
    await db.$executeRawUnsafe(
      `UPDATE "four_meme_positions" SET "claim_token" = NULL, "claim_at" = NULL
        WHERE "id" = $1 AND "status" = 'open'`,
      rowId,
    )
  } catch (e) {
    console.warn(`[fourMemeSnipeExit] ${rowId}: release claim failed:`, (e as Error).message)
  }
}

// Latest enriched snapshot the scanner wrote for a token — used by the
// exit sweep for cheap post-entry rug detection (the scanner re-scores
// held tokens on its fast cadence, so dev dumps / wash collapse surface
// here without a per-position re-scan).
async function readScannerSnapshot(
  token: string,
): Promise<{ trustScore: number | null; flags: string | null } | null> {
  try {
    const rows = await db.$queryRawUnsafe<Array<{ trust_score: number | null; flags: string | null }>>(
      `SELECT "trust_score", "flags" FROM "four_meme_launches_seen"
        WHERE "token_address" = $1 LIMIT 1`,
      token.toLowerCase(),
    )
    if (rows.length === 0) return null
    return { trustScore: rows[0].trust_score, flags: rows[0].flags }
  } catch {
    return null
  }
}

async function stampTick(agentId: string): Promise<void> {
  try {
    await db.$executeRawUnsafe(
      `UPDATE "Agent" SET "lastFourMemeSnipeTickAt" = now() WHERE "id" = $1`,
      agentId,
    )
  } catch {
    /* non-fatal */
  }
}

// ── Small parse helpers ──────────────────────────────────────────────
function parseNum(v: any, fallback: number): number {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
function numOr(v: any, fallback: number): number {
  if (v === null || v === undefined) return fallback
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
function clampBuy(bnb: number): number {
  if (!Number.isFinite(bnb) || bnb <= 0) return DEFAULT_BUY_BNB
  return Math.min(bnb, MAX_BUY_BNB)
}
function toDate(v: any): Date | null {
  if (v instanceof Date) return v
  if (v) {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}
