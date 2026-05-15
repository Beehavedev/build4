// =====================================================================
// Bot bridge — exposes the same Polymarket / fourmeme / 42.space data
// the Telegram mini-app reads, but authenticated by `x-wallet-address`
// instead of Telegram initData. This file lives ONLY in the site
// server (build4io-site/) — no changes to the bot. The bot's service
// helpers under root `src/services/*` are imported READ-ONLY; we never
// modify them.
//
// Auth: identical to miniAppAuth — wallet → User row via the shared
// Wallet table — but here we additionally attach `req.botUserId` so
// the handlers can call the bot's Prisma-keyed service helpers.
//
// Scope: read-only first. Write paths (Safe deploy, manual order,
// redeem, fourmeme buy/sell) stay in the Telegram mini-app for now.
// =====================================================================
import type { Express, Request, Response, NextFunction } from "express";
import { pool } from "./db";

type AuthedRequest = Request & { botUserId?: string; botUser?: any };

async function walletAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const raw = (req.headers["x-wallet-address"] as string | undefined) || "";
  const wallet = raw.toLowerCase().trim();
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) {
    return res.status(401).json({ ok: false, error: "wallet_required" });
  }
  try {
    const r = await pool.query(
      `SELECT u.id, u."telegramId", u.username
         FROM "Wallet" w JOIN "User" u ON u.id = w."userId"
        WHERE lower(w.address) = $1 LIMIT 1`,
      [wallet],
    );
    if (!r.rows.length) {
      return res.status(404).json({ ok: false, error: "wallet_not_registered" });
    }
    req.botUserId = r.rows[0].id;
    req.botUser = r.rows[0];
    return next();
  } catch (e: any) {
    console.error("[bot-bridge] walletAuth error:", e?.message);
    return res.status(500).json({ ok: false, error: "auth_failed" });
  }
}

export function registerBotBridgeRoutes(app: Express) {
  // ───────────────────────── Polymarket ─────────────────────────

  app.get("/api/polymarket/wallet", walletAuth, async (req: AuthedRequest, res) => {
    const userId = req.botUserId!;
    try {
      const credsR = await pool.query(
        `SELECT "walletAddress","safeAddress","safeDeployedAt","allowanceVerifiedAt"
           FROM "PolymarketCreds" WHERE "userId" = $1 LIMIT 1`,
        [userId],
      );
      const creds = credsR.rows[0] ?? null;
      const activeR = await pool.query(
        `SELECT address FROM "Wallet"
          WHERE "userId" = $1 AND chain = 'BSC' AND "isActive" = true
          LIMIT 1`,
        [userId],
      );
      const walletAddress: string | null =
        activeR.rows[0]?.address ?? creds?.walletAddress ?? null;
      const safeAddress: string | null = creds?.safeAddress ?? null;

      let balances: any = null;
      let eoaBalances: any = null;
      try {
        const { getPolygonBalances } = await import(
          "../../src/services/polymarketTrading"
        );
        if (walletAddress) {
          try {
            const e = await getPolygonBalances(walletAddress);
            eoaBalances = { usdcE: e.usdc, matic: e.matic };
          } catch (e: any) {
            console.warn("[bot-bridge] polymarket eoa balances failed:", e?.message);
          }
        }
        if (safeAddress) {
          try {
            const b = await getPolygonBalances(safeAddress);
            balances = {
              usdc: b.usdc,
              allowanceCtf: b.allowanceCtf,
              allowanceNeg: b.allowanceNeg,
              allowanceNegAdapter: b.allowanceNegAdapter,
              ctfApprovedCtfExchange: b.ctfApprovedCtfExchange,
              ctfApprovedNegExchange: b.ctfApprovedNegExchange,
              ctfApprovedNegAdapter: b.ctfApprovedNegAdapter,
            };
          } catch (e: any) {
            console.warn("[bot-bridge] polymarket safe balances failed:", e?.message);
          }
        }
      } catch (e: any) {
        console.warn("[bot-bridge] polymarketTrading import failed:", e?.message);
      }

      const ready = Boolean(
        creds &&
          safeAddress &&
          balances &&
          balances.allowanceCtf >= 1_000_000 &&
          balances.allowanceNeg >= 1_000_000 &&
          balances.allowanceNegAdapter >= 1_000_000 &&
          balances.ctfApprovedCtfExchange &&
          balances.ctfApprovedNegExchange &&
          balances.ctfApprovedNegAdapter,
      );

      res.json({
        ok: true,
        walletAddress,
        safeAddress,
        hasCreds: !!creds,
        safeDeployed: !!creds?.safeDeployedAt,
        allowanceVerified: !!creds?.allowanceVerifiedAt,
        ready,
        balances,
        eoaBalances,
      });
    } catch (err: any) {
      console.error("[bot-bridge] /polymarket/wallet failed:", err?.message);
      res.status(500).json({ ok: false, error: "wallet_lookup_failed" });
    }
  });

  app.get("/api/polymarket/positions", walletAuth, async (req: AuthedRequest, res) => {
    const userId = req.botUserId!;
    try {
      // Mirrors PolymarketPosition columns defined in src/ensureTables.ts.
      // Aliased to match the field names the UI pane expects (so the same
      // pane keeps working when this is later swapped for a bot-proxy).
      const r = await pool.query(
        `SELECT id, "userId", "agentId", "conditionId", "tokenId",
                "marketSlug", "marketTitle",
                "outcomeLabel" AS outcome,
                side,
                "sizeUsdc"  AS size,
                "entryPrice" AS price,
                "exitPrice"  AS "fillPrice",
                "fillSize", "payoutUsdc", pnl,
                status, "openedAt", "closedAt"
           FROM "PolymarketPosition"
          WHERE "userId" = $1
          ORDER BY "openedAt" DESC NULLS LAST
          LIMIT 200`,
        [userId],
      );
      res.json({ ok: true, positions: r.rows });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      // Table or column missing on a fresh deploy — degrade to empty.
      if (
        /relation .*PolymarketPosition.* does not exist/i.test(msg) ||
        /column .* does not exist/i.test(msg)
      ) {
        return res.json({ ok: true, positions: [] });
      }
      console.error("[bot-bridge] /polymarket/positions failed:", msg);
      res.status(500).json({ ok: false, error: "positions_lookup_failed" });
    }
  });

  // Read-only public passthrough used by the mini-app to enumerate
  // open Polymarket events. Mirrors the bot's /api/polymarket/events.
  app.get("/api/polymarket/events", async (req, res) => {
    try {
      const limit = Math.min(parseInt(String(req.query.limit ?? "20")), 100);
      const url =
        `https://gamma-api.polymarket.com/events?limit=${limit}` +
        `&closed=false&order=volume24hr&ascending=false`;
      const resp = await fetch(url);
      if (!resp.ok) return res.status(502).json({ ok: false, error: "upstream" });
      const data = await resp.json();
      res.set("Cache-Control", "public, max-age=15").json({ ok: true, events: data });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: "events_failed" });
    }
  });

  // ───────────────────────── fourmeme ─────────────────────────

  app.get("/api/fourmeme/positions", walletAuth, async (req: AuthedRequest, res) => {
    const userId = req.botUserId!;
    try {
      let launches: any[] = [];
      try {
        const r = await pool.query(
          `SELECT id, token_name, token_symbol, token_address, tx_hash,
                  launch_url, image_url, initial_liquidity_bnb, status,
                  sold_at, sold_proceeds_bnb, sold_tx_hash, created_at
             FROM "token_launches"
            WHERE user_id = $1 AND token_address IS NOT NULL
            ORDER BY created_at DESC LIMIT 50`,
          [userId],
        );
        launches = r.rows;
      } catch (e: any) {
        if (!/relation .*token_launches.* does not exist/i.test(String(e?.message))) throw e;
      }

      let holdings: any[] = [];
      try {
        const r = await pool.query(
          `SELECT id, token_name, token_symbol, token_address,
                  first_buy_tx, last_action_tx,
                  total_bnb_in, total_bnb_out,
                  first_buy_at, last_action_at
             FROM "four_meme_holdings"
            WHERE user_id = $1
            ORDER BY last_action_at DESC LIMIT 50`,
          [userId],
        );
        holdings = r.rows;
      } catch (e: any) {
        if (!/relation .*four_meme_holdings.* does not exist/i.test(String(e?.message))) throw e;
      }

      const launchAddrs = new Set(
        launches.map((l: any) => (l.token_address ?? "").toLowerCase()).filter(Boolean),
      );
      const merged = [
        ...launches.map((l: any) => ({
          kind: "launch" as const,
          id: l.id,
          tokenName: l.token_name,
          tokenSymbol: l.token_symbol,
          tokenAddress: l.token_address,
          imageUrl: l.image_url,
          launchUrl: l.launch_url,
          status: l.status,
          bnbIn: Number(l.initial_liquidity_bnb ?? 0),
          bnbOut: Number(l.sold_proceeds_bnb ?? 0),
          sold: !!l.sold_at,
          ts: l.created_at,
        })),
        ...holdings
          .filter((h: any) => !launchAddrs.has(String(h.token_address ?? "").toLowerCase()))
          .map((h: any) => ({
            kind: "buy" as const,
            id: h.id,
            tokenName: h.token_name,
            tokenSymbol: h.token_symbol,
            tokenAddress: h.token_address,
            imageUrl: null,
            launchUrl: null,
            status: "held",
            bnbIn: Number(h.total_bnb_in ?? 0),
            bnbOut: Number(h.total_bnb_out ?? 0),
            sold: false,
            ts: h.last_action_at,
          })),
      ].sort(
        (a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime(),
      );

      res.json({ ok: true, positions: merged });
    } catch (err: any) {
      console.error("[bot-bridge] /fourmeme/positions failed:", err?.message);
      res.status(500).json({ ok: false, error: "positions_lookup_failed" });
    }
  });

  // ───────────────────────── 42.space ─────────────────────────

  app.get("/api/fortytwo/positions", walletAuth, async (req: AuthedRequest, res) => {
    const userId = req.botUserId!;
    try {
      const r = await pool.query(
        `SELECT id, "userId", "agentId", "marketAddress", "marketTitle",
                "tokenId", "outcomeLabel", "usdtIn", "entryPrice",
                "exitPrice", "payoutUsdt", pnl, status, "paperTrade",
                "txHashOpen", "txHashClose", reasoning,
                "openedAt", "closedAt", "outcomeTokenAmount"
           FROM "OutcomePosition"
          WHERE "userId" = $1
          ORDER BY "openedAt" DESC LIMIT 100`,
        [userId],
      );
      res.json({ ok: true, positions: r.rows });
    } catch (err: any) {
      if (/relation .*OutcomePosition.* does not exist/i.test(String(err?.message))) {
        return res.json({ ok: true, positions: [] });
      }
      console.error("[bot-bridge] /fortytwo/positions failed:", err?.message);
      res.status(500).json({ ok: false, error: "positions_lookup_failed" });
    }
  });
}
