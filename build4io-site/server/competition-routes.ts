// PancakeSwap competition routes mounted at /api/competition/*.
//
// Provides the competition lifecycle (active comp lookup + auto-create),
// per-user join + read, live leaderboard with on-chain equity recompute,
// and a `recordPancakeTrade` hook called by `pancakeswap-routes.ts` after
// every successful swap so trade_count / tracked_tokens stay in sync.
//
// Auth model is identical to pancakeswap-routes.ts: x-wallet-address
// header -> telegram_wallets row -> chatId + custodial PK.

import type { Express, Request, Response } from "express";
import { ethers } from "ethers";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { storage } from "./storage";
import {
  pancakeQuoteSell,
  pancakeGetTokenInfo,
  getBscWalletBalance,
} from "./services/pancakeSwapTrading";

// Competition window — must match constants in client/src/pages/competition.tsx.
const DEFAULT_COMP_NAME = "BUILD4 × PancakeSwap Season 1";
const DEFAULT_COMP_DESC = "AI Agent Championship · 7-day BSC trading sprint";
const DEFAULT_COMP_START_ISO = "2026-05-18T00:00:00Z";
const DEFAULT_COMP_END_ISO = "2026-05-25T00:00:00Z";
// Stored as USD — paid out in BNB at competition close.
const DEFAULT_PRIZE_POOL_USD = "3000";
const DEFAULT_MAX_ENTRIES = 500;

// In-memory caches (60s) so leaderboard reads don't slam BSC RPCs.
let _bnbUsdCache: { price: number; ts: number } | null = null;
const _equityCache = new Map<string, { equity: number; ts: number }>();
const EQUITY_CACHE_MS = 30_000;
const BNB_USD_CACHE_MS = 60_000;

async function getBnbUsdPrice(): Promise<number> {
  if (_bnbUsdCache && Date.now() - _bnbUsdCache.ts < BNB_USD_CACHE_MS) {
    return _bnbUsdCache.price;
  }
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd", {
      signal: AbortSignal.timeout(3000),
    });
    if (r.ok) {
      const j: any = await r.json();
      const p = Number(j?.binancecoin?.usd);
      if (Number.isFinite(p) && p > 0) {
        _bnbUsdCache = { price: p, ts: Date.now() };
        return p;
      }
    }
  } catch { /* swallow */ }
  // Fallback: last good or conservative default.
  return _bnbUsdCache?.price ?? 600;
}

async function resolveAuthedWallet(req: Request): Promise<{ chatId: string; walletAddress: string } | { error: string; status: number }> {
  const walletAddress = (req.headers["x-wallet-address"] as string || "").toLowerCase().trim();
  if (!walletAddress || !/^0x[a-f0-9]{40}$/.test(walletAddress)) {
    return { error: "Wallet header missing", status: 401 };
  }
  try {
    const { telegramWallets } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await db.select({ chatId: telegramWallets.chatId })
      .from(telegramWallets)
      .where(eq(telegramWallets.walletAddress, walletAddress))
      .limit(1);
    if (rows.length === 0) {
      return { error: "Wallet not registered. Connect on /autonomous-economy first to provision a BUILD4 wallet.", status: 404 };
    }
    return { chatId: rows[0].chatId, walletAddress };
  } catch (e: any) {
    return { error: e?.message || "Wallet lookup failed", status: 500 };
  }
}

// Ensure the default competition row exists. Idempotent — call on boot.
export async function ensureDefaultCompetition(): Promise<void> {
  try {
    const startIso = process.env.COMP_START_ISO || DEFAULT_COMP_START_ISO;
    const endIso = process.env.COMP_END_ISO || DEFAULT_COMP_END_ISO;
    const name = process.env.COMP_NAME || DEFAULT_COMP_NAME;
    const desc = process.env.COMP_DESC || DEFAULT_COMP_DESC;
    const prize = process.env.COMP_PRIZE_POOL || DEFAULT_PRIZE_POOL_USD;
    const maxEntries = Number(process.env.COMP_MAX_ENTRIES) || DEFAULT_MAX_ENTRIES;
    const existing = await db.execute(sql`SELECT id FROM aster_competition WHERE name = ${name} LIMIT 1`);
    if ((existing.rows ?? []).length > 0) return;
    const now = new Date();
    const startDate = new Date(startIso);
    const endDate = new Date(endIso);
    const status = now < startDate ? "upcoming" : now < endDate ? "active" : "ended";
    await db.execute(sql`
      INSERT INTO aster_competition (name, description, start_date, end_date, prize_pool, status, max_entries)
      VALUES (${name}, ${desc}, ${startDate}, ${endDate}, ${prize}, ${status}, ${maxEntries})
    `);
    console.log(`[Competition] Default competition row created: name=${name} status=${status}`);
  } catch (e: any) {
    console.error("[Competition] ensureDefaultCompetition failed:", e?.message ?? e);
  }
}

// Ensure new columns exist on aster_competition_entries. Idempotent.
export async function ensureCompetitionColumns(): Promise<void> {
  try {
    await db.execute(sql`ALTER TABLE aster_competition_entries ADD COLUMN IF NOT EXISTS wallet_address TEXT`);
    await db.execute(sql`ALTER TABLE aster_competition_entries ADD COLUMN IF NOT EXISTS tracked_tokens TEXT DEFAULT '[]'`);
    await db.execute(sql`ALTER TABLE aster_competition_entries ADD COLUMN IF NOT EXISTS persona TEXT DEFAULT 'manual'`);
    await db.execute(sql`ALTER TABLE aster_competition_entries ADD COLUMN IF NOT EXISTS mode TEXT DEFAULT 'manual'`);
    await db.execute(sql`ALTER TABLE aster_competition_entries ADD COLUMN IF NOT EXISTS agent_name TEXT`);
    await db.execute(sql`ALTER TABLE aster_competition_entries ADD COLUMN IF NOT EXISTS bust_out BOOLEAN DEFAULT false`);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_comp_entry_unique ON aster_competition_entries (competition_id, chat_id)`);
  } catch (e: any) {
    console.error("[Competition] ensureCompetitionColumns failed:", e?.message ?? e);
  }
}

async function getActiveCompetition(): Promise<{ id: string; name: string; startDate: Date; endDate: Date; status: string; prizePool: string; maxEntries: number } | null> {
  const r = await db.execute(sql`
    SELECT id, name, start_date, end_date, status, prize_pool, max_entries
    FROM aster_competition
    WHERE status IN ('upcoming', 'active')
    ORDER BY start_date ASC LIMIT 1
  `);
  const row = (r.rows ?? [])[0];
  if (!row) return null;
  return {
    id: String((row as any).id),
    name: String((row as any).name),
    startDate: new Date((row as any).start_date),
    endDate: new Date((row as any).end_date),
    status: String((row as any).status),
    prizePool: String((row as any).prize_pool),
    maxEntries: Number((row as any).max_entries),
  };
}

async function recomputeEntryEquity(walletAddress: string, trackedTokens: string[]): Promise<number> {
  // Returns equity in BNB (caller converts to USD if desired).
  const cacheKey = walletAddress.toLowerCase();
  const cached = _equityCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < EQUITY_CACHE_MS) return cached.equity;
  let totalBnb = 0;
  try {
    // Pull BNB balance (cheap, single call).
    const { bnbWei } = await getBscWalletBalance(walletAddress, "0x000000000000000000000000000000000000dEaD");
    totalBnb += Number(ethers.formatEther(bnbWei));
    // For each tracked token, get balance × current sell quote in BNB.
    for (const tokenAddr of trackedTokens.slice(0, 20)) {
      try {
        const info = await pancakeGetTokenInfo(tokenAddr);
        const { tokenWei } = await getBscWalletBalance(walletAddress, tokenAddr);
        if (tokenWei <= 0n) continue;
        const q = await pancakeQuoteSell(tokenAddr, tokenWei);
        totalBnb += Number(ethers.formatEther(q.estimatedBnbWei));
      } catch {
        // Token may have no liquidity / be honeypot — treat as 0.
      }
    }
  } catch (e: any) {
    console.warn(`[Competition] equity recompute failed for ${walletAddress}: ${e?.message ?? e}`);
  }
  _equityCache.set(cacheKey, { equity: totalBnb, ts: Date.now() });
  return totalBnb;
}

// Hook called by pancakeswap-routes.ts after every successful swap.
// Fire-and-forget: caller must not await this critically.
export async function recordPancakeTrade(opts: {
  chatId: string;
  walletAddress: string;
  tokenAddress: string;
  side: "buy" | "sell";
  bnbWei: bigint;
}): Promise<void> {
  try {
    const comp = await getActiveCompetition();
    if (!comp) return;
    const entry = await db.execute(sql`
      SELECT id, tracked_tokens FROM aster_competition_entries
      WHERE competition_id = ${comp.id} AND chat_id = ${opts.chatId} LIMIT 1
    `);
    const row = (entry.rows ?? [])[0] as any;
    if (!row) return; // not joined — silently skip
    let tracked: string[] = [];
    try { tracked = JSON.parse(String(row.tracked_tokens || "[]")); } catch {}
    const tokenLc = opts.tokenAddress.toLowerCase();
    if (!tracked.map(s => s.toLowerCase()).includes(tokenLc)) {
      tracked.push(opts.tokenAddress);
    }
    // Invalidate equity cache for this wallet so next leaderboard read recomputes.
    _equityCache.delete(opts.walletAddress.toLowerCase());
    await db.execute(sql`
      UPDATE aster_competition_entries
      SET trade_count = trade_count + 1,
          tracked_tokens = ${JSON.stringify(tracked)},
          last_updated = NOW()
      WHERE id = ${row.id}
    `);
  } catch (e: any) {
    console.warn("[Competition] recordPancakeTrade failed:", e?.message ?? e);
  }
}

export function registerCompetitionRoutes(app: Express) {
  // Public: returns active competition + entry count.
  app.get("/api/competition/active", async (_req: Request, res: Response) => {
    try {
      const comp = await getActiveCompetition();
      if (!comp) return res.json({ ok: true, competition: null });
      const cnt = await db.execute(sql`SELECT COUNT(*)::int AS cnt FROM aster_competition_entries WHERE competition_id = ${comp.id}`);
      const entryCount = Number((cnt.rows?.[0] as any)?.cnt ?? 0);
      const bnbUsd = await getBnbUsdPrice();
      res.json({
        ok: true,
        competition: {
          id: comp.id,
          name: comp.name,
          status: comp.status,
          startDate: comp.startDate.toISOString(),
          endDate: comp.endDate.toISOString(),
          prizePoolUsd: Number(comp.prizePool),
          prizePoolBnb: bnbUsd > 0 ? Number(comp.prizePool) / bnbUsd : 0,
          maxEntries: comp.maxEntries,
          entryCount,
          bnbUsdPrice: bnbUsd,
        },
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // Authed: get my entry (creates none if absent).
  app.get("/api/competition/me", async (req: Request, res: Response) => {
    const auth = await resolveAuthedWallet(req);
    if ("error" in auth) return res.status(auth.status).json({ ok: false, error: auth.error });
    try {
      const comp = await getActiveCompetition();
      if (!comp) return res.json({ ok: true, entry: null, competition: null });
      const r = await db.execute(sql`
        SELECT id, username, agent_name, persona, mode, starting_balance_usdt, current_equity_usdt,
               pnl_usdt, pnl_percent, trade_count, win_count, loss_count, bust_out,
               tracked_tokens, wallet_address, joined_at
        FROM aster_competition_entries
        WHERE competition_id = ${comp.id} AND chat_id = ${auth.chatId} LIMIT 1
      `);
      const row = (r.rows ?? [])[0] as any;
      if (!row) return res.json({ ok: true, entry: null, competition: { id: comp.id, status: comp.status } });
      let tracked: string[] = [];
      try { tracked = JSON.parse(String(row.tracked_tokens || "[]")); } catch {}
      const equityBnb = await recomputeEntryEquity(auth.walletAddress, tracked);
      const startBnb = Number(row.starting_balance_usdt) || 0;
      const pnlBnb = equityBnb - startBnb;
      const pnlPct = startBnb > 0 ? (pnlBnb / startBnb) * 100 : 0;
      const bnbUsd = await getBnbUsdPrice();
      // Persist computed equity so leaderboard reads can sort without re-fetching every wallet.
      await db.execute(sql`
        UPDATE aster_competition_entries
        SET current_equity_usdt = ${equityBnb}, pnl_usdt = ${pnlBnb}, pnl_percent = ${pnlPct}, last_updated = NOW()
        WHERE id = ${row.id}
      `);
      res.json({
        ok: true,
        entry: {
          id: row.id,
          walletAddress: row.wallet_address || auth.walletAddress,
          agentName: row.agent_name,
          persona: row.persona,
          mode: row.mode,
          startingBnb: startBnb,
          currentBnb: equityBnb,
          pnlBnb,
          pnlPct,
          tradeCount: Number(row.trade_count) || 0,
          winCount: Number(row.win_count) || 0,
          lossCount: Number(row.loss_count) || 0,
          bustOut: Boolean(row.bust_out),
          trackedTokens: tracked,
          joinedAt: row.joined_at,
          bnbUsdPrice: bnbUsd,
          startingUsd: startBnb * bnbUsd,
          currentUsd: equityBnb * bnbUsd,
          pnlUsd: pnlBnb * bnbUsd,
        },
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // Authed: join the active competition. Snapshots BNB balance as starting balance.
  app.post("/api/competition/join", async (req: Request, res: Response) => {
    const auth = await resolveAuthedWallet(req);
    if ("error" in auth) return res.status(auth.status).json({ ok: false, error: auth.error });
    try {
      const comp = await getActiveCompetition();
      if (!comp) return res.status(404).json({ ok: false, error: "No active competition" });
      if (comp.status === "ended") return res.status(400).json({ ok: false, error: "Competition has ended" });
      // Fast path: existing entry → idempotent return.
      const existing = await db.execute(sql`
        SELECT id FROM aster_competition_entries
        WHERE competition_id = ${comp.id} AND chat_id = ${auth.chatId} LIMIT 1
      `);
      if ((existing.rows ?? []).length > 0) {
        return res.json({ ok: true, alreadyJoined: true, entryId: String((existing.rows![0] as any).id) });
      }
      // Atomic capacity check + insert: prevents both duplicate-join races and
      // overshooting max_entries under concurrent calls. We rely on the
      // idx_comp_entry_unique (competition_id, chat_id) index for dedup and
      // a guarded INSERT … SELECT … WHERE count < cap for capacity.
      const { bnbWei } = await getBscWalletBalance(auth.walletAddress, "0x000000000000000000000000000000000000dEaD");
      const startingBnb = Number(ethers.formatEther(bnbWei));
      const body = req.body ?? {};
      const agentName = typeof body.agentName === "string" ? body.agentName.slice(0, 40) : null;
      const persona = typeof body.persona === "string" ? body.persona.slice(0, 24) : "manual";
      const mode = typeof body.mode === "string" ? body.mode.slice(0, 24) : "manual";
      const username = typeof body.username === "string" ? body.username.slice(0, 40) : null;
      const ins = await db.execute(sql`
        INSERT INTO aster_competition_entries
          (competition_id, chat_id, username, wallet_address, starting_balance_usdt, current_equity_usdt,
           agent_name, persona, mode, tracked_tokens)
        SELECT ${comp.id}, ${auth.chatId}, ${username}, ${auth.walletAddress},
               ${startingBnb}, ${startingBnb}, ${agentName}, ${persona}, ${mode}, '[]'
        WHERE (SELECT COUNT(*) FROM aster_competition_entries WHERE competition_id = ${comp.id}) < ${comp.maxEntries}
        ON CONFLICT (competition_id, chat_id) DO NOTHING
        RETURNING id
      `);
      const insertedId = (ins.rows ?? [])[0] as any;
      if (!insertedId) {
        // Either competition just filled or another request joined first.
        const recheck = await db.execute(sql`
          SELECT id FROM aster_competition_entries
          WHERE competition_id = ${comp.id} AND chat_id = ${auth.chatId} LIMIT 1
        `);
        if ((recheck.rows ?? []).length > 0) {
          return res.json({ ok: true, alreadyJoined: true, entryId: String((recheck.rows![0] as any).id) });
        }
        return res.status(403).json({ ok: false, error: "Competition is full" });
      }
      res.json({ ok: true, alreadyJoined: false, startingBnb, walletAddress: auth.walletAddress });
    } catch (e: any) {
      console.error("[Competition] join failed:", e?.message ?? e);
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // Public: live leaderboard. Returns top N by pnl_percent.
  // Uses the *last computed* equity (persisted via /me reads + trade hook).
  // For unstaked recompute, callers should hit /me to force a fresh number.
  app.get("/api/competition/leaderboard", async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
      const comp = await getActiveCompetition();
      if (!comp) return res.json({ ok: true, leaderboard: [], competition: null });
      const rows = await db.execute(sql`
        SELECT id, chat_id, username, agent_name, persona, mode, wallet_address,
               starting_balance_usdt, current_equity_usdt, pnl_usdt, pnl_percent,
               trade_count, win_count, loss_count, bust_out, last_updated
        FROM aster_competition_entries
        WHERE competition_id = ${comp.id}
        ORDER BY pnl_percent DESC NULLS LAST
        LIMIT ${limit}
      `);
      const bnbUsd = await getBnbUsdPrice();
      // Mask wallet to a 0x1234…abcd preview to avoid leaking full custodial addresses
      // to unauthenticated callers. chatId is omitted entirely from the public payload.
      const maskWallet = (a: string | null) => a && /^0x[a-f0-9]{40}$/i.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : null;
      const leaderboard = (rows.rows ?? []).map((r: any, i: number) => ({
        rank: i + 1,
        username: r.username,
        agentName: r.agent_name || r.username || `Agent#${String(r.id).slice(0, 6)}`,
        persona: r.persona || "Manual",
        mode: r.mode || "Manual",
        walletAddress: maskWallet(r.wallet_address),
        startingBnb: Number(r.starting_balance_usdt) || 0,
        currentBnb: Number(r.current_equity_usdt) || 0,
        pnlBnb: Number(r.pnl_usdt) || 0,
        pnlPct: Number(r.pnl_percent) || 0,
        pnlUsd: (Number(r.pnl_usdt) || 0) * bnbUsd,
        currentUsd: (Number(r.current_equity_usdt) || 0) * bnbUsd,
        tradeCount: Number(r.trade_count) || 0,
        winCount: Number(r.win_count) || 0,
        lossCount: Number(r.loss_count) || 0,
        bustOut: Boolean(r.bust_out),
        lastUpdated: r.last_updated,
        isHouse: r.persona === "House",
      }));
      res.json({
        ok: true,
        leaderboard,
        competition: {
          id: comp.id,
          name: comp.name,
          status: comp.status,
          startDate: comp.startDate.toISOString(),
          endDate: comp.endDate.toISOString(),
          prizePoolUsd: Number(comp.prizePool),
          prizePoolBnb: bnbUsd > 0 ? Number(comp.prizePool) / bnbUsd : 0,
          maxEntries: comp.maxEntries,
          entryCount: leaderboard.length,
          bnbUsdPrice: bnbUsd,
        },
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });
}
