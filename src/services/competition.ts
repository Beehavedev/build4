/**
 * BUILD4 × four.meme competition — BOT side.
 *
 * The competition leaderboard is a SHARED surface between the web dApp
 * (build4io-site/) and this Telegram bot. Both write to the SAME Postgres
 * tables (`aster_competition` + `aster_competition_entries`) and both key
 * an entry on `chat_id` = the Telegram user id (string).
 *
 * Web identity → chat_id: build4io-site/server/competition-auth.ts resolves
 * a SIWE wallet to `telegram_wallets.chat_id`, which is the Telegram user id
 * (see src/migrate.ts: `BigInt(chat_id)` → `User.telegramId`).
 *
 * Bot identity → chat_id: the bot user's `User.telegramId`. So writing
 * `chat_id = String(user.telegramId)` here guarantees a Telegram person who
 * uses BOTH the bot and the web maps to ONE leaderboard row, never two.
 *
 * This module owns NO schema. The competition tables are provisioned by the
 * web (ensureDefaultCompetition / ensureCompetitionColumns in
 * build4io-site/server/competition-routes.ts). We only read/write rows via
 * raw SQL — mirroring the raw-SQL pattern used by src/services/houseAgent.ts.
 */

import { db } from '../db'
import { getWalletBalances as _getWalletBalances } from './wallet'
import {
  LEADERBOARD_ORDER_BY,
  JOIN_INSERT_COLUMNS,
  JOIN_CONFLICT_CLAUSE,
  columnList,
} from './competitionLeaderboardContract'

// Injectable dependencies so unit tests can stub the on-chain balance read
// (joinCompetition snapshots the custodial wallet's BNB) without hitting a
// real BSC RPC. Mirrors the __testDeps pattern in fortyTwoExecutor.
export const __testDeps: { getWalletBalances: typeof _getWalletBalances } = {
  getWalletBalances: _getWalletBalances,
}

export interface ActiveCompetition {
  id: string
  name: string
  startDate: Date
  endDate: Date
  status: string
  prizePool: string
  maxEntries: number
}

/** Mirror of the web's getActiveCompetition: upcoming OR active, soonest first. */
export async function getActiveCompetition(): Promise<ActiveCompetition | null> {
  const rows = await db.$queryRawUnsafe<any[]>(
    `SELECT id, name, start_date, end_date, status, prize_pool, max_entries
       FROM aster_competition
      WHERE status IN ('upcoming', 'active')
      ORDER BY start_date ASC
      LIMIT 1`,
  )
  const row = rows?.[0]
  if (!row) return null
  return {
    id: String(row.id),
    name: String(row.name),
    startDate: new Date(row.start_date),
    endDate: new Date(row.end_date),
    status: String(row.status),
    prizePool: String(row.prize_pool),
    maxEntries: Number(row.max_entries),
  }
}

export interface CompetitionEntry {
  id: string
  agentName: string | null
  persona: string
  mode: string
  walletAddress: string | null
  startingBnb: number
  currentBnb: number
  pnlBnb: number
  pnlPct: number
  tradeCount: number
  trackedTokens: string[]
  joinedAt: Date | null
  /** 1-based rank on the unified leaderboard, or null if not yet ranked. */
  rank: number | null
  /** Total number of entries in the active competition. */
  totalEntries: number
}

function parseTracked(raw: any): string[] {
  try {
    const arr = JSON.parse(String(raw || '[]'))
    return Array.isArray(arr) ? arr.map((s) => String(s)) : []
  } catch {
    return []
  }
}

/** Read this Telegram user's entry in the active competition, or null. */
export async function getMyEntry(chatId: string): Promise<CompetitionEntry | null> {
  const comp = await getActiveCompetition()
  if (!comp) return null
  const rows = await db.$queryRawUnsafe<any[]>(
    `SELECT id, agent_name, persona, mode, wallet_address,
            starting_balance_usdt, current_equity_usdt, pnl_usdt, pnl_percent,
            trade_count, tracked_tokens, joined_at
       FROM aster_competition_entries
      WHERE competition_id = $1 AND chat_id = $2
      LIMIT 1`,
    comp.id,
    chatId,
  )
  const row = rows?.[0]
  if (!row) return null

  // Compute this user's rank + total entries to mirror the web leaderboard
  // exactly. The web orders rows by pnl_percent DESC NULLS LAST and assigns
  // sequential positions (rank = array index + 1), so we use ROW_NUMBER()
  // with the same ORDER BY — NOT RANK(), which would emit duplicate ranks on
  // tied pnl_percent and diverge from the web's 1,2,3,… numbering.
  let rank: number | null = null
  let totalEntries = 0
  try {
    const ranked = await db.$queryRawUnsafe<any[]>(
      `SELECT rank, total FROM (
         SELECT chat_id,
                ROW_NUMBER() OVER (${LEADERBOARD_ORDER_BY}) AS rank,
                COUNT(*) OVER () AS total
           FROM aster_competition_entries
          WHERE competition_id = $1
       ) ranked
       WHERE chat_id = $2
       LIMIT 1`,
      comp.id,
      chatId,
    )
    const rr = ranked?.[0]
    if (rr) {
      rank = Number(rr.rank) || null
      totalEntries = Number(rr.total) || 0
    }
  } catch (e: any) {
    console.warn('[Competition] rank lookup failed:', e?.message ?? e)
  }

  return {
    id: String(row.id),
    agentName: row.agent_name ?? null,
    persona: row.persona ?? 'manual',
    mode: row.mode ?? 'manual',
    walletAddress: row.wallet_address ?? null,
    startingBnb: Number(row.starting_balance_usdt) || 0,
    currentBnb: Number(row.current_equity_usdt) || 0,
    pnlBnb: Number(row.pnl_usdt) || 0,
    pnlPct: Number(row.pnl_percent) || 0,
    tradeCount: Number(row.trade_count) || 0,
    trackedTokens: parseTracked(row.tracked_tokens),
    joinedAt: row.joined_at ? new Date(row.joined_at) : null,
    rank,
    totalEntries,
  }
}

export type JoinResult =
  | { ok: true; alreadyJoined: boolean; entryId: string; startingBnb: number; competition: ActiveCompetition }
  | { ok: false; reason: 'no_competition' | 'ended' | 'full' | 'error'; message: string }

/**
 * Join the active competition for a Telegram user.
 *
 * - Snapshots the custodial wallet's current BNB balance as the starting
 *   balance (BNB-denominated despite the legacy `_usdt` column names — same
 *   convention the web uses).
 * - Idempotent: an existing entry returns alreadyJoined=true without a
 *   second insert.
 * - Capacity is enforced atomically via INSERT … SELECT … WHERE count < cap,
 *   and the unique index idx_comp_entry_unique (competition_id, chat_id)
 *   dedupes concurrent joins.
 */
export async function joinCompetition(opts: {
  chatId: string
  walletAddress: string
  username?: string | null
  agentName?: string | null
  persona?: string
  mode?: string
}): Promise<JoinResult> {
  const comp = await getActiveCompetition()
  if (!comp) return { ok: false, reason: 'no_competition', message: 'No active competition right now.' }
  if (comp.status === 'ended') return { ok: false, reason: 'ended', message: 'This competition has ended.' }

  // Fast path: already joined → idempotent return.
  const existing = await db.$queryRawUnsafe<any[]>(
    `SELECT id, starting_balance_usdt FROM aster_competition_entries
      WHERE competition_id = $1 AND chat_id = $2 LIMIT 1`,
    comp.id,
    opts.chatId,
  )
  if (existing?.[0]) {
    return {
      ok: true,
      alreadyJoined: true,
      entryId: String(existing[0].id),
      startingBnb: Number(existing[0].starting_balance_usdt) || 0,
      competition: comp,
    }
  }

  // Snapshot starting BNB from the custodial wallet. Fail CLOSED on a failed
  // balance read: getWalletBalances returns { native: 0, error: '...' } when
  // the BSC RPC is unavailable. Inserting an entry with a 0 baseline would
  // corrupt the user's PnL/equity and their leaderboard ranking forever, so
  // we refuse to join and ask them to retry — mirroring the web join, which
  // also requires a successful balance read.
  const bal = await __testDeps.getWalletBalances(opts.walletAddress, 'BSC')
  if (bal.error || !Number.isFinite(bal.native)) {
    console.warn(
      `[Competition] join balance snapshot failed chatId=${opts.chatId} comp=${comp.id}: ${bal.error ?? 'non-finite native'}`,
    )
    return {
      ok: false,
      reason: 'error',
      message: 'Could not read your wallet balance to snapshot your starting amount. Please try again in a moment.',
    }
  }
  const startingBnb = bal.native

  const username = opts.username ? String(opts.username).slice(0, 40) : null
  const agentName = opts.agentName ? String(opts.agentName).slice(0, 40) : null
  const persona = (opts.persona ? String(opts.persona) : 'manual').slice(0, 24)
  const mode = (opts.mode ? String(opts.mode) : 'manual').slice(0, 24)

  // Atomic capacity-guarded insert with RETURNING so we know deterministically
  // whether THIS call created the row — even under a race where two joins hit
  // the exact capacity boundary at once. ON CONFLICT dedupes a concurrent join
  // by the same chat_id. Mirrors the web join handler in
  // build4io-site/server/competition-routes.ts.
  const inserted = await db.$queryRawUnsafe<any[]>(
    `INSERT INTO aster_competition_entries
       (${columnList(JOIN_INSERT_COLUMNS)})
     SELECT $1, $2, $3, $4, $5, $5, $6, $7, $8, '[]'
      WHERE (SELECT COUNT(*) FROM aster_competition_entries WHERE competition_id = $1) < $9
     ${JOIN_CONFLICT_CLAUSE}
     RETURNING id, starting_balance_usdt`,
    comp.id,
    opts.chatId,
    username,
    opts.walletAddress,
    startingBnb,
    agentName,
    persona,
    mode,
    comp.maxEntries,
  )

  // RETURNING gave us a row → this call created the entry: a fresh join.
  if (inserted?.[0]) {
    return {
      ok: true,
      alreadyJoined: false,
      entryId: String(inserted[0].id),
      startingBnb: Number(inserted[0].starting_balance_usdt) || 0,
      competition: comp,
    }
  }

  // No row returned → either the competition just filled, or another request
  // (or this user concurrently) joined first. Recheck by chat_id to tell the
  // two apart deterministically: a row present means they ARE in the
  // competition (already joined); its absence means there was no slot (full).
  const recheck = await db.$queryRawUnsafe<any[]>(
    `SELECT id, starting_balance_usdt FROM aster_competition_entries
      WHERE competition_id = $1 AND chat_id = $2 LIMIT 1`,
    comp.id,
    opts.chatId,
  )
  if (recheck?.[0]) {
    return {
      ok: true,
      alreadyJoined: true,
      entryId: String(recheck[0].id),
      startingBnb: Number(recheck[0].starting_balance_usdt) || 0,
      competition: comp,
    }
  }
  return { ok: false, reason: 'full', message: 'The competition is full — all entry slots are taken.' }
}

/**
 * Record a bot four.meme trade against the competition entry, if the user
 * has joined. Fire-and-forget: callers MUST NOT await this on the critical
 * path — a competition write must never block or fail a real trade.
 *
 * Mirrors the web's recordTradeInternal: adds the token to tracked_tokens
 * (so leaderboard equity recompute marks it to market) and bumps trade_count.
 */
export async function recordCompetitionTrade(opts: {
  chatId: string
  tokenAddress: string
}): Promise<void> {
  try {
    const comp = await getActiveCompetition()
    if (!comp) return
    const rows = await db.$queryRawUnsafe<any[]>(
      `SELECT id, tracked_tokens FROM aster_competition_entries
        WHERE competition_id = $1 AND chat_id = $2 LIMIT 1`,
      comp.id,
      opts.chatId,
    )
    const row = rows?.[0]
    if (!row) return // not joined — silently skip
    const tracked = parseTracked(row.tracked_tokens)
    const tokenLc = opts.tokenAddress.toLowerCase()
    if (!tracked.map((s) => s.toLowerCase()).includes(tokenLc)) {
      tracked.push(opts.tokenAddress)
    }
    await db.$executeRawUnsafe(
      `UPDATE aster_competition_entries
          SET trade_count = trade_count + 1,
              tracked_tokens = $1,
              last_updated = NOW()
        WHERE id = $2`,
      JSON.stringify(tracked),
      row.id,
    )
  } catch (e: any) {
    console.warn('[Competition] recordCompetitionTrade failed:', e?.message ?? e)
  }
}
