/**
 * BUILD4 × four.meme competition — SHARED LEADERBOARD CONTRACT.
 *
 * This module is the SINGLE SOURCE OF TRUTH for the bits of competition SQL
 * that MUST stay byte-for-byte aligned between the two surfaces that read and
 * write the shared `aster_competition_entries` table:
 *
 *   - BOT  : src/services/competition.ts            (Prisma, db.$queryRawUnsafe)
 *   - WEB  : build4io-site/server/competition-routes.ts (Drizzle, sql``)
 *
 * If these two drift, a Telegram user who uses BOTH the bot and the web dApp
 * will see a DIFFERENT rank / equity / trade count on each surface for the
 * same underlying row. The three things that must never diverge are:
 *
 *   1. The leaderboard ORDERING — how rows are ranked.
 *   2. The JOIN insert SHAPE — which columns an entry is created with, and the
 *      dedup key that keeps one Telegram person to one row.
 *   3. The recordTrade UPDATE SHAPE — which columns each trade mutates.
 *
 * Why the contract lives in `src/` (the bot), not in the web:
 *   The bot deploys to Render from GitHub WITHOUT `build4io-site/`, while the
 *   web is published separately from Replit. There is no runtime module both
 *   deploy targets can import. So the bot imports these constants DIRECTLY (it
 *   therefore physically cannot drift), and the web's conformance is enforced
 *   statically by src/services/competition.integration.test.ts, which both
 *   (a) builds its web-side SQL from THESE constants instead of hand-copying,
 *   and (b) scans the real web source file to assert it still contains each
 *   canonical fragment. Change a fragment here and the bot updates with it;
 *   let the web fall out of step and the integration test fails.
 */

/**
 * Canonical leaderboard ranking. Both surfaces order entries by realised PnL
 * percent, descending, with un-ranked (NULL) entries always last. The web
 * leaderboard assigns sequential positions (rank = array index + 1); the bot's
 * getMyEntry mirrors that exact sequence with ROW_NUMBER() OVER (this ORDER BY)
 * — NOT RANK(), which would emit duplicate ranks on ties and diverge from the
 * web's 1,2,3,… numbering.
 */
export const LEADERBOARD_ORDER_BY = 'ORDER BY pnl_percent DESC NULLS LAST'

/**
 * The dedup key that guarantees one Telegram person == one leaderboard row,
 * regardless of which surface they join from or which custodial wallet each
 * surface stored. Used as the ON CONFLICT target on join.
 */
export const ENTRY_DEDUP_KEY = '(competition_id, chat_id)'

/** The full ON CONFLICT clause both join paths use. */
export const JOIN_CONFLICT_CLAUSE = `ON CONFLICT ${ENTRY_DEDUP_KEY} DO NOTHING`

/**
 * Columns an entry is created with on join, IN ORDER. Both join paths insert
 * exactly these, sourcing current_equity_usdt from the same value as
 * starting_balance_usdt (a fresh entry's equity == its snapshotted start) and
 * defaulting tracked_tokens to an empty JSON array.
 */
export const JOIN_INSERT_COLUMNS = [
  'competition_id',
  'chat_id',
  'username',
  'wallet_address',
  'starting_balance_usdt',
  'current_equity_usdt',
  'agent_name',
  'persona',
  'mode',
  'tracked_tokens',
] as const

/**
 * Columns the recordTrade UPDATE mutates on every recorded trade. Both
 * surfaces bump trade_count, rewrite tracked_tokens, and touch last_updated —
 * nothing else.
 */
export const RECORD_TRADE_MUTATED_COLUMNS = [
  'trade_count',
  'tracked_tokens',
  'last_updated',
] as const

/**
 * Columns the public leaderboard read selects, IN ORDER. The web maps these
 * positionally into the leaderboard payload, so the set and order are part of
 * the shared shape.
 */
export const LEADERBOARD_SELECT_COLUMNS = [
  'id',
  'chat_id',
  'username',
  'agent_name',
  'persona',
  'mode',
  'wallet_address',
  'starting_balance_usdt',
  'current_equity_usdt',
  'pnl_usdt',
  'pnl_percent',
  'trade_count',
  'win_count',
  'loss_count',
  'bust_out',
  'last_updated',
  'erc8004_agent_id',
] as const

/** Comma-joined column list helper for building SELECT / INSERT statements. */
export function columnList(cols: readonly string[]): string {
  return cols.join(', ')
}
