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
import {
  fourMemeGetTokenInfo,
  fourMemeQuoteSell,
} from "./services/fourMemeTrading";
import { requireSiweAuthed } from "./competition-auth";
import { mintAgentIdentity, getBscScanTokenUrl, getBscScanTxUrl } from "./services/erc8004Mint";

// Competition window — must match constants in client/src/pages/competition.tsx.
const DEFAULT_COMP_NAME = "BUILD4 × four.meme Season 1";
const DEFAULT_COMP_DESC = "AI Agent Championship · 7-day BSC memecoin sprint";
const DEFAULT_COMP_START_ISO = "2026-05-18T00:00:00Z";
const DEFAULT_COMP_END_ISO = "2026-05-25T00:00:00Z";
// Stored as USD — paid out in BNB at competition close.
const DEFAULT_PRIZE_POOL_USD = "2820";
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

// All authed endpoints below now use requireSiweAuthed (see competition-auth.ts)
// which enforces: SIWE cookie + matching x-wallet-address + Origin (writes) +
// rate limit + optional idempotency.

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
    // ERC-8004 on-chain identity columns. Status transitions:
    //   pending  -> created at /join, mint not yet attempted
    //   minting  -> async mint in flight
    //   minted   -> success, agent_id + tx_hash populated
    //   failed   -> mint reverted or wallet underfunded; user can retry
    await db.execute(sql`ALTER TABLE aster_competition_entries ADD COLUMN IF NOT EXISTS erc8004_agent_id TEXT`);
    await db.execute(sql`ALTER TABLE aster_competition_entries ADD COLUMN IF NOT EXISTS erc8004_tx_hash TEXT`);
    await db.execute(sql`ALTER TABLE aster_competition_entries ADD COLUMN IF NOT EXISTS erc8004_mint_status TEXT DEFAULT 'pending'`);
    await db.execute(sql`ALTER TABLE aster_competition_entries ADD COLUMN IF NOT EXISTS erc8004_mint_error TEXT`);
    // mint_started_at gives us a stale-mint reaper: if a row is stuck at
    // 'minting' for longer than STALE_MINT_MS the next claim can take it over.
    await db.execute(sql`ALTER TABLE aster_competition_entries ADD COLUMN IF NOT EXISTS erc8004_mint_started_at TIMESTAMPTZ`);
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
    // Try four.meme bonding curve first (where most competition tokens
    // live); fall back to PancakeSwap V2 for graduated tokens / tokens
    // that were never on four.meme.
    for (const tokenAddr of trackedTokens.slice(0, 20)) {
      try {
        const { tokenWei } = await getBscWalletBalance(walletAddress, tokenAddr);
        if (tokenWei <= 0n) continue;
        let bnbOut = 0n;
        try {
          const fmInfo = await fourMemeGetTokenInfo(tokenAddr);
          if (!fmInfo.graduatedToPancake && fmInfo.quoteIsBnb) {
            // Mark-to-market via the four.meme curve quote — read-only,
            // so the V1-sell-unsafe gate (which only blocks execution)
            // does NOT apply here. Valuing V1 holdings at 0 would break
            // leaderboard equity for any pre-V2 token still on its curve.
            const fmQ = await fourMemeQuoteSell(tokenAddr, tokenWei);
            bnbOut = fmQ.fundsWei;
          } else {
            // Graduated or BEP20-quoted — value via PancakeSwap V2.
            const pcsQ = await pancakeQuoteSell(tokenAddr, tokenWei);
            bnbOut = pcsQ.estimatedBnbWei;
          }
        } catch {
          // Not on four.meme at all — try PancakeSwap.
          try {
            const pcsQ = await pancakeQuoteSell(tokenAddr, tokenWei);
            bnbOut = pcsQ.estimatedBnbWei;
          } catch { /* honeypot / no liquidity — treat as 0 */ }
        }
        totalBnb += Number(ethers.formatEther(bnbOut));
      } catch {
        // Treat as 0 on any unexpected error.
      }
    }
  } catch (e: any) {
    console.warn(`[Competition] equity recompute failed for ${walletAddress}: ${e?.message ?? e}`);
  }
  _equityCache.set(cacheKey, { equity: totalBnb, ts: Date.now() });
  return totalBnb;
}

// Hook called by pancakeswap-routes.ts / four-meme-routes.ts after every
// successful swap. Fire-and-forget: caller must not await critically.
async function recordTradeInternal(opts: {
  chatId: string;
  walletAddress: string;
  tokenAddress: string;
  side: "buy" | "sell";
  bnbWei: bigint;
  venue: "pancakeV2" | "fourMeme";
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
    console.warn(`[Competition] recordTrade (${opts.venue}) failed:`, e?.message ?? e);
  }
}

export async function recordPancakeTrade(opts: {
  chatId: string;
  walletAddress: string;
  tokenAddress: string;
  side: "buy" | "sell";
  bnbWei: bigint;
}): Promise<void> {
  return recordTradeInternal({ ...opts, venue: "pancakeV2" });
}

export async function recordFourMemeTrade(opts: {
  chatId: string;
  walletAddress: string;
  tokenAddress: string;
  side: "buy" | "sell";
  bnbWei: bigint;
}): Promise<void> {
  return recordTradeInternal({ ...opts, venue: "fourMeme" });
}

// Fire-and-forget ERC-8004 mint with status updates. Looks up the
// custodial PK via storage (never returned to clients); persists
// 'minting' before the tx, 'minted' on success, 'failed' + error on
// any throw. Safe to call multiple times — caller checks status first
// (the /api/competition/mint-identity retry endpoint guards against
// concurrent attempts).
// Stuck-mint reaper window: if a row sits at 'minting' for longer than
// this without flipping to minted/failed (e.g. server crashed mid-tx),
// the next claim can take it over and retry. Reads of the registry are
// idempotent — worst case we waste a few cents of gas if the original
// tx eventually lands; the on-chain identity ends up the same agent's.
const STALE_MINT_MS = 10 * 60 * 1000; // 10 min

async function runIdentityMint(opts: {
  entryId: string;
  custodialAddress: string;
  ownerAddress: string;
  agentName: string;
  persona: string;
  mode: string;
}): Promise<void> {
  // Atomic claim: only proceed if this row is in a claimable state
  // (pending, failed, or stale 'minting'). Returns the row id on
  // success, empty result if another worker beat us to it — in which
  // case we silently exit so we don't double-mint and double-spend gas.
  const staleCutoff = new Date(Date.now() - STALE_MINT_MS);
  const claim = await db.execute(sql`
    UPDATE aster_competition_entries
    SET erc8004_mint_status = 'minting',
        erc8004_mint_started_at = NOW(),
        erc8004_mint_error = NULL
    WHERE id = ${opts.entryId}
      AND (
        erc8004_mint_status IN ('pending', 'failed')
        OR (erc8004_mint_status = 'minting' AND (erc8004_mint_started_at IS NULL OR erc8004_mint_started_at < ${staleCutoff.toISOString()}))
      )
    RETURNING id
  `);
  if ((claim.rows ?? []).length === 0) {
    console.log(`[Competition] mint claim skipped for entry ${opts.entryId} (already in flight by another worker)`);
    return;
  }
  try {
    const pk = await storage.getPrivateKeyByWalletAddress(opts.custodialAddress);
    if (!pk) throw new Error("Custodial PK not retrievable");
    const result = await mintAgentIdentity({
      custodialPk: pk,
      ownerAddress: opts.ownerAddress,
      agentName: opts.agentName,
      persona: opts.persona,
      mode: opts.mode,
    });
    await db.execute(sql`
      UPDATE aster_competition_entries
      SET erc8004_agent_id = ${result.tokenId},
          erc8004_tx_hash = ${result.txHash},
          erc8004_mint_status = 'minted',
          erc8004_mint_error = NULL
      WHERE id = ${opts.entryId}
    `);
    console.log(`[Competition] minted ERC-8004 #${result.tokenId} tx=${result.txHash} entry=${opts.entryId}`);
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 500);
    console.warn(`[Competition] ERC-8004 mint failed for entry ${opts.entryId}: ${msg}`);
    try {
      await db.execute(sql`
        UPDATE aster_competition_entries
        SET erc8004_mint_status = 'failed', erc8004_mint_error = ${msg}
        WHERE id = ${opts.entryId}
      `);
    } catch (e2: any) {
      console.error("[Competition] failed to record mint failure:", e2?.message ?? e2);
    }
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
    const auth = await requireSiweAuthed(req, {
      rateLimit: { key: "comp:me", max: 60, windowMs: 60_000 },
    });
    if ("error" in auth) return res.status(auth.status).json({ ok: false, error: auth.error, code: auth.code });
    try {
      const comp = await getActiveCompetition();
      // Always-fresh funding panel — even before they join, they need to see
      // the custodial deposit address + current BNB balance.
      const bnbUsd = await getBnbUsdPrice();
      let fundingBnb = 0;
      try {
        const { bnbWei } = await getBscWalletBalance(auth.walletAddress, "0x000000000000000000000000000000000000dEaD");
        fundingBnb = Number(ethers.formatEther(bnbWei));
      } catch { /* network glitch — leave 0 */ }
      const funding = {
        custodialAddress: auth.walletAddress,
        bnbBalance: fundingBnb,
        bnbUsdPrice: bnbUsd,
        bnbUsdBalance: fundingBnb * bnbUsd,
      };
      if (!comp) return res.json({ ok: true, entry: null, competition: null, funding });
      const r = await db.execute(sql`
        SELECT id, username, agent_name, persona, mode, starting_balance_usdt, current_equity_usdt,
               pnl_usdt, pnl_percent, trade_count, win_count, loss_count, bust_out,
               tracked_tokens, wallet_address, joined_at,
               erc8004_agent_id, erc8004_tx_hash, erc8004_mint_status, erc8004_mint_error
        FROM aster_competition_entries
        WHERE competition_id = ${comp.id} AND chat_id = ${auth.chatId} LIMIT 1
      `);
      const row = (r.rows ?? [])[0] as any;
      if (!row) return res.json({ ok: true, entry: null, competition: { id: comp.id, status: comp.status }, funding });
      // Lazy backfill: if this entry pre-dates the ERC-8004 feature (or
      // a previous mint was never started), kick off a mint on next view.
      // Also self-heals stale 'minting' rows beyond STALE_MINT_MS. The
      // atomic claim in runIdentityMint dedupes against concurrent /me.
      const mintStatus = row.erc8004_mint_status ? String(row.erc8004_mint_status) : "pending";
      const needsAutoMint = mintStatus === "pending";
      if (needsAutoMint) {
        void runIdentityMint({
          entryId: String(row.id),
          custodialAddress: auth.walletAddress,
          ownerAddress: auth.walletAddress,
          agentName: row.agent_name || `Agent#${String(row.id).slice(0, 6)}`,
          persona: row.persona || "manual",
          mode: row.mode || "manual",
        });
      }
      let tracked: string[] = [];
      try { tracked = JSON.parse(String(row.tracked_tokens || "[]")); } catch {}
      const equityBnb = await recomputeEntryEquity(auth.walletAddress, tracked);
      const startBnb = Number(row.starting_balance_usdt) || 0;
      const pnlBnb = equityBnb - startBnb;
      const pnlPct = startBnb > 0 ? (pnlBnb / startBnb) * 100 : 0;
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
          erc8004: {
            agentId: row.erc8004_agent_id ? String(row.erc8004_agent_id) : null,
            txHash: row.erc8004_tx_hash ? String(row.erc8004_tx_hash) : null,
            status: (row.erc8004_mint_status ? String(row.erc8004_mint_status) : "pending") as
              "pending" | "minting" | "minted" | "failed",
            error: row.erc8004_mint_error ? String(row.erc8004_mint_error) : null,
            tokenUrl: row.erc8004_agent_id ? getBscScanTokenUrl(String(row.erc8004_agent_id)) : null,
            txUrl: row.erc8004_tx_hash ? getBscScanTxUrl(String(row.erc8004_tx_hash)) : null,
          },
        },
        funding,
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // Authed: switch my mode between manual / co-pilot / auto. Also updates persona/agentName.
  app.post("/api/competition/mode", async (req: Request, res: Response) => {
    const auth = await requireSiweAuthed(req, {
      isWrite: true,
      rateLimit: { key: "comp:mode", max: 20, windowMs: 60_000 },
    });
    if ("error" in auth) return res.status(auth.status).json({ ok: false, error: auth.error, code: auth.code });
    try {
      const comp = await getActiveCompetition();
      if (!comp) return res.status(404).json({ ok: false, error: "No active competition" });
      const body = req.body ?? {};
      const allowedModes = new Set(["manual", "copilot", "auto"]);
      const allowedPersonas = new Set(["manual", "Quant", "Degen", "Hunter", "Sniper", "Maximalist"]);
      const mode = String(body.mode || "").toLowerCase();
      if (!allowedModes.has(mode)) return res.status(400).json({ ok: false, error: "Invalid mode" });
      const persona = body.persona && allowedPersonas.has(String(body.persona)) ? String(body.persona) : undefined;
      const agentName = typeof body.agentName === "string" ? body.agentName.slice(0, 40) : undefined;
      const r = await db.execute(sql`
        UPDATE aster_competition_entries
        SET mode = ${mode},
            persona = COALESCE(${persona ?? null}, persona),
            agent_name = COALESCE(${agentName ?? null}, agent_name),
            last_updated = NOW()
        WHERE competition_id = ${comp.id} AND chat_id = ${auth.chatId}
        RETURNING id
      `);
      if ((r.rows ?? []).length === 0) return res.status(404).json({ ok: false, error: "Not joined yet" });
      res.json({ ok: true, mode, persona, agentName });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // Authed: join the active competition. Snapshots BNB balance as starting balance.
  app.post("/api/competition/join", async (req: Request, res: Response) => {
    const auth = await requireSiweAuthed(req, {
      isWrite: true,
      rateLimit: { key: "comp:join", max: 5, windowMs: 60_000 },
    });
    if ("error" in auth) return res.status(auth.status).json({ ok: false, error: auth.error, code: auth.code });
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
      // Kick off async ERC-8004 identity mint. Fire-and-forget so the user
      // gets an instant /join response; status is polled via /me.
      const newEntryId = String((insertedId as any).id);
      const safeAgentName = agentName || `Agent#${newEntryId.slice(0, 6)}`;
      void runIdentityMint({
        entryId: newEntryId,
        custodialAddress: auth.walletAddress,
        ownerAddress: auth.walletAddress,
        agentName: safeAgentName,
        persona,
        mode,
      });

      res.json({ ok: true, alreadyJoined: false, startingBnb, walletAddress: auth.walletAddress });
    } catch (e: any) {
      console.error("[Competition] join failed:", e?.message ?? e);
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // Authed: retry ERC-8004 identity mint if the initial attempt failed
  // (most common cause: wallet was unfunded at join time). Idempotent —
  // safe to call repeatedly; no-op if status is already 'minted'.
  app.post("/api/competition/mint-identity", async (req: Request, res: Response) => {
    const auth = await requireSiweAuthed(req, {
      isWrite: true,
      rateLimit: { key: "comp:mint", max: 5, windowMs: 60_000 },
    });
    if ("error" in auth) return res.status(auth.status).json({ ok: false, error: auth.error, code: auth.code });
    try {
      const comp = await getActiveCompetition();
      if (!comp) return res.status(404).json({ ok: false, error: "No active competition" });
      const r = await db.execute(sql`
        SELECT id, agent_name, persona, mode, erc8004_mint_status, erc8004_agent_id
        FROM aster_competition_entries
        WHERE competition_id = ${comp.id} AND chat_id = ${auth.chatId} LIMIT 1
      `);
      const row = (r.rows ?? [])[0] as any;
      if (!row) return res.status(404).json({ ok: false, error: "Not joined yet" });
      if (row.erc8004_mint_status === "minted" && row.erc8004_agent_id) {
        return res.json({ ok: true, alreadyMinted: true, agentId: String(row.erc8004_agent_id) });
      }
      // Note: we no longer 409 on status='minting'. The atomic claim in
      // runIdentityMint makes duplicate-call safe (whichever request
      // wins the claim does the mint; the loser silently exits). This
      // also frees the stale-mint reaper path: a 'minting' row older
      // than STALE_MINT_MS will be reclaimable.
      // Kick off another attempt and return immediately. Status is polled via /me.
      void runIdentityMint({
        entryId: String(row.id),
        custodialAddress: auth.walletAddress,
        ownerAddress: auth.walletAddress,
        agentName: row.agent_name || `Agent#${String(row.id).slice(0, 6)}`,
        persona: row.persona || "manual",
        mode: row.mode || "manual",
      });
      res.json({ ok: true, status: "minting" });
    } catch (e: any) {
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
               trade_count, win_count, loss_count, bust_out, last_updated,
               erc8004_agent_id
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
        erc8004AgentId: r.erc8004_agent_id ? String(r.erc8004_agent_id) : null,
        erc8004TokenUrl: r.erc8004_agent_id ? getBscScanTokenUrl(String(r.erc8004_agent_id)) : null,
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
