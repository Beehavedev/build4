/**
 * BUILD4 × four.meme competition — BOT ↔ WEB shared-leaderboard SMOKE TEST.
 *
 * Why this exists: src/services/competition.test.ts unit-tests the bot side in
 * isolation (DB stubbed). Nothing proved END-TO-END that a Telegram user who
 * joins via the BOT shows up as the SAME single leaderboard row when the WEB
 * dApp reads it. The one place a mismatch could hide — a chat_id formatting
 * drift, a schema/ordering drift, or the two surfaces pointing at different
 * databases — is exactly this bot↔web boundary, so we exercise BOTH stacks
 * against ONE physical Postgres here.
 *
 * How it stays faithful without standing up the full Express + SIWE server:
 *   - BOT side: the REAL functions from ./competition (Prisma, db.$queryRawUnsafe).
 *   - WEB side: a SECOND client — pg.Pool + drizzle-orm, mirroring
 *     build4io-site/server/db.ts — running the EXACT SQL from
 *     build4io-site/server/competition-routes.ts (leaderboard, /me, join,
 *     recordTradeInternal). Using a separate connection also proves the two
 *     surfaces see each other's committed rows across the process boundary.
 *
 * Shared-DB invariant: in production the bot (Render, DATABASE_URL) and the web
 * (Replit, SITE_DATABASE_URL) converge on the SAME Postgres. To reproduce that
 * convergence the WEB client here is pointed at the bot's DATABASE_URL (the URL
 * Prisma also uses) — NOT SITE_DATABASE_URL, which in dev is a different DB.
 *
 * Skips cleanly (never fails) when no DB is reachable or the shared competition
 * schema is absent, so it is safe in environments without Postgres.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import { db as prismaDb } from '../db'
import {
  __testDeps,
  getActiveCompetition,
  getMyEntry,
  joinCompetition,
  recordCompetitionTrade,
} from './competition'
import {
  LEADERBOARD_ORDER_BY,
  LEADERBOARD_SELECT_COLUMNS,
  JOIN_INSERT_COLUMNS,
  JOIN_CONFLICT_CLAUSE,
  RECORD_TRADE_MUTATED_COLUMNS,
  ENTRY_DEDUP_KEY,
  columnList,
} from './competitionLeaderboardContract'

// Same URL Prisma uses, so the WEB client and the BOT client share one DB —
// mirroring the production convergence (see header). We deliberately do NOT
// read SITE_DATABASE_URL here.
const DB_URL = process.env.DATABASE_URL

// Sentinel so we can find + clean up only our own rows, never real data.
const COMP_NAME = `__itest__ shared-leaderboard ${process.pid}`
// A Telegram id well outside any real range; the crux is that BOTH surfaces
// key on chat_id = String(telegramId), so a drift here would split the row.
const TELEGRAM_ID = 999000111222n
const CHAT_ID = String(TELEGRAM_ID)
// Distinct wallets per surface: the dedup MUST key on (competition_id, chat_id)
// alone, so the same person on both surfaces is one row even if the stored
// custodial wallet differs.
const BOT_WALLET = '0x' + 'a'.repeat(40)
const WEB_WALLET = '0x' + 'b'.repeat(40)
const START_BNB = 3.5

function makeWebClient() {
  const isSSL = !!DB_URL && (DB_URL.includes('render.com') || DB_URL.includes('neon.tech'))
  const pool = new pg.Pool({
    connectionString: DB_URL,
    ssl: isSSL ? { rejectUnauthorized: false } : false,
  })
  return { pool, db: drizzle(pool) }
}

async function ensureSchema(web: ReturnType<typeof makeWebClient>) {
  // Self-provisioning + idempotent so the smoke test runs on a fresh DB too.
  // Mirrors the shape the web owns (ensureDefaultCompetition / ensureCompetitionColumns).
  try { await web.db.execute(sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`) } catch { /* may lack perms; gen_random_uuid often built-in */ }
  await web.db.execute(sql`
    CREATE TABLE IF NOT EXISTS aster_competition (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      name text, description text,
      start_date timestamp, end_date timestamp,
      prize_pool text DEFAULT '0', status text DEFAULT 'upcoming',
      max_entries integer DEFAULT 500, created_at timestamp DEFAULT now()
    )`)
  await web.db.execute(sql`
    CREATE TABLE IF NOT EXISTS aster_competition_entries (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      competition_id varchar, chat_id text, username text,
      starting_balance_usdt double precision DEFAULT 0,
      current_equity_usdt double precision DEFAULT 0,
      pnl_usdt double precision DEFAULT 0, pnl_percent double precision DEFAULT 0,
      trade_count integer DEFAULT 0, win_count integer DEFAULT 0, loss_count integer DEFAULT 0,
      joined_at timestamp DEFAULT now(), last_updated timestamp DEFAULT now(),
      wallet_address text, tracked_tokens text DEFAULT '[]',
      persona text DEFAULT 'manual', mode text DEFAULT 'manual', agent_name text,
      bust_out boolean DEFAULT false
    )`)
  await web.db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_comp_entry_unique ON aster_competition_entries (competition_id, chat_id)`)
}

async function reachable(web: ReturnType<typeof makeWebClient>): Promise<boolean> {
  if (!DB_URL) return false
  try {
    await web.db.execute(sql`SELECT 1`)
    return true
  } catch {
    return false
  }
}

// Count rows for our user in our comp via the WEB client — the assertion that
// guards against duplicate rows across the two surfaces.
async function webRowCount(web: ReturnType<typeof makeWebClient>, compId: string): Promise<number> {
  const r = await web.db.execute(sql`
    SELECT COUNT(*)::int AS n FROM aster_competition_entries
    WHERE competition_id = ${compId} AND chat_id = ${CHAT_ID}`)
  return Number((r.rows?.[0] as any)?.n ?? 0)
}

test('bot and web players land on ONE shared leaderboard row end-to-end', async (t) => {
  const web = makeWebClient()

  if (!(await reachable(web))) {
    await web.pool.end().catch(() => {})
    t.skip('No reachable Postgres (DATABASE_URL) — shared-leaderboard smoke test skipped')
    return
  }

  try {
    await ensureSchema(web)
  } catch (e: any) {
    await web.pool.end().catch(() => {})
    t.skip(`Shared competition schema unavailable (${e?.message ?? e}) — skipped`)
    return
  }

  // Stub the bot's on-chain balance read so joinCompetition snapshots a
  // deterministic starting balance without hitting a BSC RPC.
  const origBal = __testDeps.getWalletBalances
  __testDeps.getWalletBalances = async () => ({
    usdt: 0,
    native: START_BNB,
    nativeSymbol: 'BNB',
    error: null,
  })

  let compId = ''
  try {
    // ── Arrange: WEB provisions the competition (it owns the schema/lifecycle).
    // start_date in the far past guarantees getActiveCompetition() (ORDER BY
    // start_date ASC) selects OURS over any unrelated active comp in the DB.
    await web.db.execute(sql`DELETE FROM aster_competition WHERE name = ${COMP_NAME}`)
    const ins = await web.db.execute(sql`
      INSERT INTO aster_competition (name, description, start_date, end_date, prize_pool, status, max_entries)
      VALUES (${COMP_NAME}, 'integration smoke test', '2000-01-01T00:00:00Z',
              ${new Date(Date.now() + 7 * 864e5)}, '0', 'active', 500)
      RETURNING id`)
    compId = String((ins.rows?.[0] as any).id)
    // Defensive: clear any stale entry for our sentinel user in this comp.
    await web.db.execute(sql`DELETE FROM aster_competition_entries WHERE competition_id = ${compId} AND chat_id = ${CHAT_ID}`)

    // Sanity: the BOT (Prisma) resolves the SAME competition the WEB just made.
    await t.test('bot and web agree on the active competition', async () => {
      const botComp = await getActiveCompetition()
      assert.ok(botComp, 'bot should see an active competition')
      assert.equal(botComp!.id, compId, 'bot and web must resolve the same competition id')
    })

    // ── Act 1: user joins via the BOT (real Prisma write).
    await t.test('bot join creates exactly one row keyed on the telegram id', async () => {
      const r = await joinCompetition({
        chatId: CHAT_ID,
        walletAddress: BOT_WALLET,
        username: 'itest-bot',
      })
      assert.equal(r.ok, true)
      assert.equal((r as any).alreadyJoined, false)
      assert.equal((r as any).startingBnb, START_BNB)
      assert.equal(await webRowCount(web, compId), 1, 'exactly one row after bot join')
    })

    // ── Assert: the WEB leaderboard read sees that SAME single row, with the
    // chat_id and starting balance the bot wrote (the core promise).
    await t.test('web leaderboard shows the bot player as the same row', async () => {
      // Built from the shared contract (NOT hand-copied), so the columns and
      // ordering this test exercises are exactly what both surfaces promise.
      const rows = await web.db.execute(sql`
        SELECT ${sql.raw(columnList(LEADERBOARD_SELECT_COLUMNS))}
        FROM aster_competition_entries
        WHERE competition_id = ${compId}
        ${sql.raw(LEADERBOARD_ORDER_BY)}
        LIMIT 100`)
      const mine = (rows.rows ?? []).filter((r: any) => String(r.chat_id) === CHAT_ID)
      assert.equal(mine.length, 1, 'web leaderboard must contain exactly one row for the user')
      const row = mine[0] as any
      assert.equal(String(row.chat_id), CHAT_ID, 'chat_id must equal String(telegramId) — no formatting drift')
      assert.equal(Number(row.starting_balance_usdt), START_BNB, 'web reads the balance the bot snapshotted')
      assert.equal(String(row.wallet_address), BOT_WALLET)
    })

    // ── Assert: the WEB "/me" read resolves the same row for this chat_id.
    await t.test('web /me read returns the same single entry', async () => {
      // Verbatim mirror of competition-routes.ts GET /api/competition/me SQL.
      const r = await web.db.execute(sql`
        SELECT id, username, agent_name, persona, mode, starting_balance_usdt, current_equity_usdt,
               pnl_usdt, pnl_percent, trade_count, win_count, loss_count, bust_out,
               tracked_tokens, wallet_address, joined_at
        FROM aster_competition_entries
        WHERE competition_id = ${compId} AND chat_id = ${CHAT_ID} LIMIT 1`)
      const row = (r.rows ?? [])[0] as any
      assert.ok(row, 'web /me must find the entry the bot created')
      assert.equal(Number(row.starting_balance_usdt), START_BNB)
    })

    // ── Assert: the BOT's own getMyEntry reads the same row + ranks it.
    await t.test('bot getMyEntry reads back the same row', async () => {
      const e = await getMyEntry(CHAT_ID)
      assert.ok(e, 'bot getMyEntry must find the row')
      assert.equal(e!.startingBnb, START_BNB)
      assert.equal(e!.tradeCount, 0)
      assert.equal(e!.rank, 1, 'sole entry ranks #1')
      assert.equal(e!.totalEntries, 1)
    })

    // ── Act 2: the SAME person now uses the WEB and "joins" there too.
    // The web join is a verbatim mirror of POST /api/competition/join — its
    // ON CONFLICT (competition_id, chat_id) DO NOTHING must keep it ONE row,
    // even with a different custodial wallet on the web surface.
    await t.test('web join for the same user does NOT create a duplicate row', async () => {
      await web.db.execute(sql`
        INSERT INTO aster_competition_entries
          (${sql.raw(columnList(JOIN_INSERT_COLUMNS))})
        SELECT ${compId}, ${CHAT_ID}, ${'itest-web'}, ${WEB_WALLET},
               ${START_BNB}, ${START_BNB}, ${null}, ${'manual'}, ${'manual'}, '[]'
        WHERE (SELECT COUNT(*) FROM aster_competition_entries WHERE competition_id = ${compId}) < 500
        ${sql.raw(JOIN_CONFLICT_CLAUSE)}
        RETURNING id`)
      assert.equal(await webRowCount(web, compId), 1, 'still exactly one row after web join')

      // And a second BOT join is idempotent too.
      const again = await joinCompetition({ chatId: CHAT_ID, walletAddress: BOT_WALLET })
      assert.equal(again.ok, true)
      assert.equal((again as any).alreadyJoined, true)
      assert.equal(await webRowCount(web, compId), 1, 'still one row after repeat bot join')
    })

    // ── Act 3: trades from BOTH surfaces land on the one shared row.
    await t.test('trades from both surfaces accumulate on the same row', async () => {
      // BOT trade (real fire-and-forget recorder).
      await recordCompetitionTrade({ chatId: CHAT_ID, tokenAddress: '0xTOKENBOT' })

      // WEB trade — verbatim mirror of recordTradeInternal in competition-routes.ts.
      const entry = await web.db.execute(sql`
        SELECT id, tracked_tokens FROM aster_competition_entries
        WHERE competition_id = ${compId} AND chat_id = ${CHAT_ID} LIMIT 1`)
      const row = (entry.rows ?? [])[0] as any
      assert.ok(row, 'web must find the shared row to record its trade')
      let tracked: string[] = []
      try { tracked = JSON.parse(String(row.tracked_tokens || '[]')) } catch { /* default [] */ }
      const tokenLc = '0xtokenweb'
      if (!tracked.map((s) => s.toLowerCase()).includes(tokenLc)) tracked.push('0xTOKENWEB')
      await web.db.execute(sql`
        UPDATE aster_competition_entries
        SET trade_count = trade_count + 1, tracked_tokens = ${JSON.stringify(tracked)}, last_updated = NOW()
        WHERE id = ${row.id}`)

      // The BOT now sees BOTH trades on the one row.
      const e = await getMyEntry(CHAT_ID)
      assert.ok(e)
      assert.equal(e!.tradeCount, 2, 'bot trade + web trade both counted on one row')
      assert.ok(e!.trackedTokens.map((s) => s.toLowerCase()).includes('0xtokenbot'))
      assert.ok(e!.trackedTokens.map((s) => s.toLowerCase()).includes('0xtokenweb'))

      // Still a single row after all the cross-surface writes.
      assert.equal(await webRowCount(web, compId), 1, 'one row after trades from both surfaces')
    })
  } finally {
    // Cleanup: remove ONLY our sentinel rows so we never shadow the real
    // active competition or leave test data behind.
    __testDeps.getWalletBalances = origBal
    try {
      if (compId) {
        await web.db.execute(sql`DELETE FROM aster_competition_entries WHERE competition_id = ${compId}`)
      }
      await web.db.execute(sql`DELETE FROM aster_competition WHERE name = ${COMP_NAME}`)
    } catch { /* best-effort cleanup */ }
    await web.pool.end().catch(() => {})
  }
})

// ───────────────────────────────────────────────────────────────────────────
// STATIC DRIFT GUARD — needs no database.
//
// The end-to-end test above proves the bot and web AGREE *today*. This test is
// what stops the WEB from silently DIVERGING tomorrow: it reads the real web
// source file and asserts it still contains every canonical fragment from the
// shared contract (src/services/competitionLeaderboardContract.ts). The bot
// can't drift — it imports the contract directly — so guarding the web here
// closes the loop. Change a fragment in the contract and the bot moves with
// it; let the web fall out of step and this test fails with a precise message.
//
// Skips cleanly if the web source isn't present (e.g. the bot's Render deploy,
// which ships without build4io-site/), so it never blocks the bot's CI.
// ───────────────────────────────────────────────────────────────────────────
test('web competition source conforms to the shared leaderboard contract', async (t) => {
  const webSrcUrl = new URL(
    '../../build4io-site/server/competition-routes.ts',
    import.meta.url,
  )
  let src: string
  try {
    src = await readFile(webSrcUrl, 'utf8')
  } catch {
    t.skip('Web source (build4io-site/server/competition-routes.ts) not present — drift guard skipped')
    return
  }

  // Normalise whitespace so multi-line SQL in the web source matches our
  // single-line canonical fragments (the web wraps long SELECTs across lines).
  const flat = src.replace(/\s+/g, ' ')

  // 1) Leaderboard ordering — the single most drift-prone line.
  assert.ok(
    flat.includes(LEADERBOARD_ORDER_BY),
    `web source must order the leaderboard by the canonical "${LEADERBOARD_ORDER_BY}"`,
  )

  // 2) Leaderboard SELECT column set + order.
  assert.ok(
    flat.includes(columnList(LEADERBOARD_SELECT_COLUMNS)),
    'web leaderboard SELECT must use the canonical column list (set + order) from the contract',
  )

  // 3) Join INSERT shape: the column list and the dedup conflict clause.
  assert.ok(
    flat.includes(columnList(JOIN_INSERT_COLUMNS)),
    'web join INSERT must use the canonical column list from the contract',
  )
  assert.ok(
    flat.includes(JOIN_CONFLICT_CLAUSE),
    `web join must dedup with the canonical "${JOIN_CONFLICT_CLAUSE}"`,
  )
  assert.ok(
    flat.includes(`ON CONFLICT ${ENTRY_DEDUP_KEY}`),
    `web join must key dedup on the canonical entry key "${ENTRY_DEDUP_KEY}"`,
  )

  // 4) recordTrade UPDATE: must mutate exactly the canonical columns.
  await t.test('web recordTrade UPDATE mutates the canonical columns', () => {
    // Isolate the recordTradeInternal UPDATE so we don't match unrelated
    // UPDATEs (e.g. the equity persist in /me).
    const m = flat.match(/UPDATE aster_competition_entries SET trade_count[^;]*?WHERE id =/)
    assert.ok(m, 'web source must contain the recordTrade UPDATE on aster_competition_entries')
    const updateClause = m![0]
    for (const col of RECORD_TRADE_MUTATED_COLUMNS) {
      assert.ok(
        updateClause.includes(col),
        `web recordTrade UPDATE must mutate the canonical column "${col}"`,
      )
    }
  })
})
