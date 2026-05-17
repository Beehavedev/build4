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
import express from "express";
import { pool } from "./db";
import { verifySiweCookie } from "./wallet-routes";

// Tiny inline copy of the bot's humanizeRelayerError — keeps user-facing
// errors clear without importing from src/server.ts (which we never touch).
function humanizeRelayerError(rawMsg: string, stepLabel: string): string {
  const m = String(rawMsg || "").toLowerCase();
  if (m.includes("insufficient funds") || m.includes("insufficient balance")) {
    return `${stepLabel} failed: insufficient balance for the relayer transaction. Try again in a moment.`;
  }
  if (m.includes("nonce")) return `${stepLabel} failed: nonce contention — please retry.`;
  if (m.includes("timeout") || m.includes("timed out")) return `${stepLabel} timed out. The relayer is slow right now — please retry.`;
  if (m.includes("already deployed")) return `${stepLabel} already done.`;
  return `${stepLabel} failed: ${rawMsg.slice(0, 220)}`;
}

type AuthedRequest = Request & { botUserId?: string; botUser?: any };

// Authenticated by the HMAC-signed SIWE session cookie issued by
// /api/auth/siwe (see wallet-routes.ts). The cookie pins the wallet
// address that signed the EIP-4361 message — we never trust a
// client-supplied `x-wallet-address` header here, since that was
// trivially spoofable. The DB lookup that maps wallet → bot user
// is unchanged; only the source of `wallet` is hardened.
function bridgeAllowedHosts(req: Request): Set<string> {
  const env = process.env.SITE_ALLOWED_HOSTS || process.env.DAPP_ALLOWED_HOSTS || "";
  const list = env.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (list.length) return new Set(list);
  const h = String(req.headers.host || "").toLowerCase();
  return new Set(h ? [h] : []);
}
function originHostFromHeader(o: string | undefined | null): string {
  if (!o) return "";
  try { return new URL(o).host.toLowerCase(); } catch { return ""; }
}

async function walletAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  // CSRF defense for cookie-authenticated mutations: any non-GET request
  // must come from an allowed origin. b4_sess is HttpOnly+SameSite=Lax,
  // which already blocks classic cross-site CSRF, but enforcing Origin
  // server-side closes the gap for browsers that under-enforce SameSite
  // and for any future SameSite=None misconfiguration.
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    const hosts = bridgeAllowedHosts(req);
    const origin = originHostFromHeader(req.headers.origin as string | undefined);
    const referer = originHostFromHeader(req.headers.referer as string | undefined);
    const seen = origin || referer;
    if (hosts.size > 0 && seen && !hosts.has(seen)) {
      console.warn(`[bot-bridge] CSRF reject: origin=${origin} referer=${referer} not in allowlist`);
      return res.status(403).json({ ok: false, error: "origin_not_allowed" });
    }
  }
  const sess = verifySiweCookie(req);
  if (!sess) {
    return res.status(401).json({ ok: false, error: "siwe_required", code: "NO_SESSION" });
  }
  const wallet = sess.wallet.toLowerCase().trim();
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) {
    return res.status(401).json({ ok: false, error: "siwe_required", code: "BAD_SESSION" });
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
      //
      // Realised PnL on partial sells (Task #115): partial SELLs are
      // recorded as their own PolymarketPosition rows with side='SELL'
      // (fillSize = shares sold, sizeUsdc = USDC proceeds, entryPrice =
      // sell fill price). We allocate SELL fills back to BUY lots FIFO
      // (by openedAt ASC), per (conditionId, tokenId), so each BUY row
      // gets a per-position cumulative `soldQty` + `realisedPnl` even
      // when the user has multiple BUYs on the same outcome token.
      //
      // Only SELLs with status IN ('filled','matched') are counted to
      // avoid inflating realised numbers from in-flight or
      // unconfirmed orders. Failed and 'placed' SELL rows are excluded.
      const r = await pool.query(
        `SELECT id, "userId", "agentId", "conditionId", "tokenId",
                "marketSlug", "marketTitle",
                "outcomeLabel" AS outcome,
                side,
                "sizeUsdc"  AS size,
                "entryPrice" AS price,
                "exitPrice"  AS "fillPrice",
                "fillSize", "payoutUsdc", pnl,
                status, "openedAt", "closedAt", "orderId"
           FROM "PolymarketPosition"
          WHERE "userId" = $1
          ORDER BY "openedAt" ASC NULLS LAST
          LIMIT 500`,
        [userId],
      );

      type Acc = { soldQty: number; proceeds: number; remaining: number };
      const acc = new Map<string, Acc>();
      const groups = new Map<string, { buys: any[]; sells: any[] }>();
      const sharesOf = (row: any): number => {
        const fill = Number(row.fillSize);
        if (Number.isFinite(fill) && fill > 0) return fill;
        const price = Number(row.price);
        const sz = Number(row.size);
        return price > 0 && Number.isFinite(sz) ? sz / price : 0;
      };
      const tsOf = (row: any): number => {
        const t = row.openedAt ? new Date(row.openedAt).getTime() : 0;
        return Number.isFinite(t) ? t : 0;
      };

      // Execution signal: the Polymarket SDK frequently leaves
      // effectively-filled orders in `placed` state (the same reason the
      // SELL button is allowed for placed BUYs elsewhere in this pane).
      // So treating only filled/matched as inventory under-counts real
      // trades. Instead we require status ∈ {filled, matched, placed}
      // AND a non-null orderId — orderId is only set when the CLOB
      // accepted the order, so failed/never-posted rows are excluded
      // and phantom inventory can't absorb SELL allocations.
      const isExecuted = (row: any) =>
        !!row.orderId &&
        (row.status === "filled" ||
          row.status === "matched" ||
          row.status === "placed");

      for (const row of r.rows) {
        const key = `${row.conditionId}|${row.tokenId}`;
        if (!groups.has(key)) groups.set(key, { buys: [], sells: [] });
        const g = groups.get(key)!;
        if (row.side === "BUY" && isExecuted(row)) {
          g.buys.push(row);
          acc.set(row.id, { soldQty: 0, proceeds: 0, remaining: sharesOf(row) });
        } else if (row.side === "SELL" && isExecuted(row)) {
          g.sells.push(row);
        }
      }

      for (const g of Array.from(groups.values())) {
        g.buys.sort((a: any, b: any) => tsOf(a) - tsOf(b));
        g.sells.sort((a: any, b: any) => tsOf(a) - tsOf(b));
        for (const sell of g.sells) {
          const sellShares = sharesOf(sell);
          const sellProceeds = Number(sell.size) || 0;
          if (sellShares <= 0) continue;
          let unallocated = sellShares;
          for (const buy of g.buys) {
            if (unallocated <= 0) break;
            const a = acc.get(buy.id)!;
            if (a.remaining <= 0) continue;
            const take = Math.min(a.remaining, unallocated);
            const proceedsShare = (take / sellShares) * sellProceeds;
            a.soldQty += take;
            a.proceeds += proceedsShare;
            a.remaining -= take;
            unallocated -= take;
          }
          // Any leftover `unallocated` means the user sold more shares
          // than the BUY rows account for (manual on-chain transfer,
          // missing BUY row, etc.). We silently drop it rather than
          // attaching nonsense PnL to unrelated rows.
        }
      }

      const positions = r.rows
        .map((row: any) => {
          if (row.side !== "BUY") {
            return { ...row, soldQty: null, realisedPnl: null, soldProceeds: null };
          }
          const a = acc.get(row.id);
          if (!a || a.soldQty <= 0) {
            return { ...row, soldQty: 0, realisedPnl: null, soldProceeds: null };
          }
          const buyPrice = Number(row.price) || 0;
          return {
            ...row,
            soldQty: a.soldQty,
            realisedPnl: a.proceeds - a.soldQty * buyPrice,
            soldProceeds: a.proceeds,
          };
        })
        .sort((a: any, b: any) => tsOf(b) - tsOf(a))
        .slice(0, 200);

      res.json({ ok: true, positions });
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

  // GET /api/polymarket/orderbook/:tokenId — public CLOB orderbook proxy
  // for one outcome token. Used by the web terminal's Sell button so the
  // client can anchor the SELL request to the current best bid (server-side
  // slippage gate in /api/polymarket/order rejects > 5% drift from this
  // price). Mirrors the bot's /api/polymarket/orderbook/:tokenId.
  app.get("/api/polymarket/orderbook/:tokenId", async (req, res) => {
    const tokenId = String(req.params.tokenId ?? "");
    if (!/^[0-9]{60,80}$/.test(tokenId)) {
      return res.status(400).json({ ok: false, error: "invalid_token_id" });
    }
    try {
      const { getOrderbook } = await import("../../src/services/polymarket");
      const book = await getOrderbook(tokenId);
      res.set("Cache-Control", "public, max-age=1").json({ ok: true, book });
    } catch (err: any) {
      const msg = err?.message ?? "clob_unavailable";
      console.warn("[bot-bridge] /polymarket/orderbook failed:", msg);
      res.status(502).json({ ok: false, error: msg });
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

  // ───────── Polymarket WRITE paths (gasless via relayer) ─────────
  // All three of these mirror the bot's /api/polymarket/{setup,redeem,order}
  // handlers in src/server.ts — same service helpers, same DB rows. The
  // only delta is auth: wallet address (web) vs requireTgUser (Telegram).

  app.post(
    "/api/polymarket/setup",
    express.json({ limit: "32kb" }),
    walletAuth,
    async (req: AuthedRequest, res) => {
      const userId = req.botUserId!;
      try {
        const { getOrCreateCreds, deploySafeIfNeeded, ensureUsdcAllowance } =
          await import("../../src/services/polymarketTrading");
        const { walletAddress } = await getOrCreateCreds(userId);

        let safe: { safeAddress: string; alreadyDeployed: boolean; txHash?: string };
        try {
          safe = await deploySafeIfNeeded(userId);
        } catch (e: any) {
          const raw = String(e?.message ?? e);
          return res.status(502).json({
            ok: false,
            walletAddress,
            credsReady: true,
            error: "safe_deploy_failed",
            details: humanizeRelayerError(raw, "Safe deploy").slice(0, 500),
          });
        }

        let allowance: { alreadyApproved: boolean; txHashes: string[] } = {
          alreadyApproved: true,
          txHashes: [],
        };
        try {
          allowance = await ensureUsdcAllowance(userId);
        } catch (e: any) {
          const raw = String(e?.message ?? e);
          return res.status(502).json({
            ok: false,
            walletAddress,
            safeAddress: safe.safeAddress,
            credsReady: true,
            error: "allowance_failed",
            details: humanizeRelayerError(raw, "USDC + CTF allowance").slice(0, 500),
          });
        }

        res.json({
          ok: true,
          walletAddress,
          safeAddress: safe.safeAddress,
          safeNewlyDeployed: !safe.alreadyDeployed,
          credsReady: true,
          allowance,
        });
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        console.error("[bot-bridge] /polymarket/setup failed:", msg);
        res
          .status(500)
          .json({ ok: false, error: "setup_failed", details: msg.slice(0, 300) });
      }
    },
  );

  app.post(
    "/api/polymarket/redeem",
    express.json({ limit: "32kb" }),
    walletAuth,
    async (req: AuthedRequest, res) => {
      const userId = req.botUserId!;
      try {
        const body = req.body ?? {};
        const conditionId = String(body.conditionId ?? "");
        const isNegRisk = Boolean(body.isNegRisk);
        const negRiskAmts = Array.isArray(body.negRiskAmounts)
          ? body.negRiskAmounts.map((x: any) => BigInt(String(x)))
          : undefined;

        if (!/^0x[0-9a-fA-F]{64}$/.test(conditionId)) {
          return res.status(400).json({ ok: false, error: "invalid_condition_id" });
        }
        const { redeemPositions } = await import(
          "../../src/services/polymarketTrading"
        );
        const { txHash } = await redeemPositions({
          userId,
          conditionId,
          isNegRisk,
          negRiskAmounts: negRiskAmts,
        });
        res.json({ ok: true, txHash });
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        console.error("[bot-bridge] /polymarket/redeem failed:", msg);
        res
          .status(502)
          .json({ ok: false, error: "redeem_failed", details: msg.slice(0, 300) });
      }
    },
  );

  app.post(
    "/api/polymarket/order",
    express.json({ limit: "32kb" }),
    walletAuth,
    async (req: AuthedRequest, res) => {
      const userId = req.botUserId!;
      try {
        const body = req.body ?? {};
        const tokenId = String(body.tokenId ?? "");
        const side = String(body.side ?? "").toUpperCase();
        const amount = Number(body.sizeUsdc ?? body.amount);
        const conditionId = String(body.conditionId ?? "");
        const marketTitle = String(body.marketTitle ?? "");
        const marketSlug = body.marketSlug ? String(body.marketSlug) : undefined;
        const outcomeLabel = String(body.outcomeLabel ?? "Yes");
        const expectedPrice = Number(body.price);

        if (!/^[0-9]{60,80}$/.test(tokenId)) {
          return res.status(400).json({ ok: false, error: "invalid_token_id" });
        }
        if (side !== "BUY" && side !== "SELL") {
          return res.status(400).json({ ok: false, error: "invalid_side" });
        }
        if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000) {
          return res.status(400).json({
            ok: false,
            error: "invalid_amount",
            message: "amount must be 0..10000",
          });
        }
        if (
          conditionId.length > 0 &&
          !/^0x[0-9a-fA-F]{2,128}$/.test(conditionId)
        ) {
          return res.status(400).json({ ok: false, error: "invalid_condition_id" });
        }
        if (!marketTitle || marketTitle.length > 500) {
          return res.status(400).json({ ok: false, error: "invalid_market_title" });
        }

        const { placeMarketOrder } = await import(
          "../../src/services/polymarketTrading"
        );
        const result = await placeMarketOrder({
          userId,
          tokenId,
          side: side as "BUY" | "SELL",
          amount,
          marketCtx: { conditionId, marketTitle, marketSlug, outcomeLabel },
          reasoning: "Manual web-terminal trade",
          expectedPrice:
            Number.isFinite(expectedPrice) && expectedPrice > 0 && expectedPrice < 1
              ? expectedPrice
              : undefined,
          maxSlippageBps: 500,
        });
        if (!result.ok) {
          return res.status(502).json({ ...result, ok: false });
        }
        res.json({ ...result, ok: true });
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        console.error("[bot-bridge] /polymarket/order failed:", msg);
        res
          .status(500)
          .json({ ok: false, error: "order_failed", details: msg.slice(0, 300) });
      }
    },
  );

  // GET /api/fourmeme/wallet-balance/:tokenAddress — mirrors the bot's
  // /api/fourmeme/wallet-balance/:tokenAddress so the web UI's "Sell all"
  // path can ask the chain for the actual ERC20 balance before sizing
  // a sell. Returns the same shape: { tokenBalance, tokenWei, tokenDecimals, bnbBalance, bnbWei, address }.
  app.get(
    "/api/fourmeme/wallet-balance/:tokenAddress",
    walletAuth,
    async (req: AuthedRequest, res) => {
      const userId = req.botUserId!;
      const tokenAddress = String(req.params.tokenAddress ?? "");
      try {
        if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
          return res.status(400).json({ ok: false, error: "invalid_token_address" });
        }
        const { loadUserBscPrivateKey } = await import(
          "../../src/services/fourMemeTrading"
        );
        const { ethers } = await import("ethers");
        const { privateKey } = await loadUserBscPrivateKey(userId);
        const wallet = new ethers.Wallet(privateKey);
        const address = wallet.address;
        const rpc = process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org";
        const provider = new ethers.JsonRpcProvider(rpc);
        const ERC20_MIN = [
          "function balanceOf(address) view returns (uint256)",
          "function decimals() view returns (uint8)",
        ];
        const erc20 = new ethers.Contract(tokenAddress, ERC20_MIN, provider);
        let bnbWei: bigint = BigInt(0),
          tokenWei: bigint = BigInt(0),
          decimals = 18;
        const errs: string[] = [];
        try {
          bnbWei = await provider.getBalance(address);
        } catch (e: any) {
          errs.push(`bnb:${e?.shortMessage ?? e?.message}`);
        }
        try {
          tokenWei = await erc20.balanceOf(address);
        } catch (e: any) {
          errs.push(`token:${e?.shortMessage ?? e?.message}`);
        }
        try {
          decimals = Number(await erc20.decimals());
        } catch {
          /* keep 18 */
        }
        res.json({
          ok: true,
          address,
          bnbWei: bnbWei.toString(),
          bnbBalance: ethers.formatEther(bnbWei),
          tokenWei: tokenWei.toString(),
          tokenBalance: ethers.formatUnits(tokenWei, decimals),
          tokenDecimals: decimals,
          error: errs.length ? errs.join("; ") : null,
        });
      } catch (err: any) {
        res.status(400).json({ ok: false, error: err?.message ?? String(err) });
      }
    },
  );

  // ───────── fourmeme WRITE paths (BSC custodial signing) ─────────
  // Mirrors the bot's /api/fourmeme/{buy,sell} — auto-routes graduated
  // tokens through PancakeSwap V2. We inline a small holdings recorder
  // below since the bot's helper isn't exported.

  async function recordHolding(opts: {
    userId: string;
    tokenAddress: string;
    bnbDelta: number; // +in for buy, -out for sell goes to total_bnb_out
    direction: "buy" | "sell";
    txHash: string;
  }) {
    const tokenLower = opts.tokenAddress.toLowerCase();
    const inAmt = opts.direction === "buy" ? opts.bnbDelta : 0;
    const outAmt = opts.direction === "sell" ? opts.bnbDelta : 0;
    try {
      // Schema note: `four_meme_holdings.total_bnb_in/out` are TEXT
      // (NOT NUMERIC) — see src/ensureTables.ts:251-263. Cast both
      // sides to NUMERIC so `+` works, then back to TEXT to satisfy
      // the column type. Plain `text + text` would error and the
      // ledger would silently fail to update.
      await pool.query(
        `INSERT INTO four_meme_holdings (
            user_id, token_address, total_bnb_in, total_bnb_out,
            first_buy_tx, last_action_tx, first_buy_at, last_action_at
          ) VALUES ($1, $2, $3::text, $4::text, $5, $5, NOW(), NOW())
          ON CONFLICT (user_id, token_address) DO UPDATE SET
            total_bnb_in   = (COALESCE(four_meme_holdings.total_bnb_in,  '0')::numeric + EXCLUDED.total_bnb_in::numeric)::text,
            total_bnb_out  = (COALESCE(four_meme_holdings.total_bnb_out, '0')::numeric + EXCLUDED.total_bnb_out::numeric)::text,
            last_action_tx = EXCLUDED.last_action_tx,
            last_action_at = NOW()`,
        [opts.userId, tokenLower, String(inAmt), String(outAmt), opts.txHash],
      );
    } catch (e: any) {
      // Non-fatal — trade still succeeded on chain, holdings ledger is
      // for UI accounting only.
      console.warn(
        "[bot-bridge] fourmeme holdings record failed:",
        e?.message ?? String(e),
      );
    }
  }

  app.post(
    "/api/fourmeme/buy",
    express.json({ limit: "32kb" }),
    walletAuth,
    async (req: AuthedRequest, res) => {
      const userId = req.botUserId!;
      try {
        const {
          isFourMemeEnabled,
          buyTokenWithBnb,
          loadUserBscPrivateKey,
          getTokenInfo,
        } = await import("../../src/services/fourMemeTrading");
        if (!isFourMemeEnabled())
          return res.status(503).json({ ok: false, code: "FOUR_MEME_DISABLED" });
        const { tokenAddress, bnbAmount, slippageBps } = req.body ?? {};
        if (!tokenAddress || !bnbAmount)
          return res
            .status(400)
            .json({ ok: false, error: "tokenAddress + bnbAmount required" });
        const { ethers } = await import("ethers");
        const bnbWei = ethers.parseEther(String(bnbAmount));
        const { privateKey } = await loadUserBscPrivateKey(userId);

        let info: any;
        try {
          info = await getTokenInfo(String(tokenAddress));
        } catch {
          const { pancakeGetTokenInfo } = await import(
            "../../src/services/pancakeSwapTrading"
          );
          info = await pancakeGetTokenInfo(String(tokenAddress));
        }

        if (info.graduatedToPancake) {
          const { pancakeBuyTokenWithBnb } = await import(
            "../../src/services/pancakeSwapTrading"
          );
          const result = await pancakeBuyTokenWithBnb(
            privateKey,
            String(tokenAddress),
            bnbWei,
            { slippageBps: slippageBps != null ? Number(slippageBps) : undefined },
          );
          await recordHolding({
            userId,
            tokenAddress: String(tokenAddress),
            bnbDelta: Number(ethers.formatEther(result.bnbSpentWei)),
            direction: "buy",
            txHash: result.txHash,
          });
          return res.json({
            ok: true,
            venue: result.venue,
            txHash: result.txHash,
            tokenAddress: result.tokenAddress,
            bnbSpentWei: result.bnbSpentWei.toString(),
            estimatedTokensWei: result.estimatedTokensWei.toString(),
            minTokensWei: result.minTokensWei.toString(),
            slippageBps: result.slippageBps,
          });
        }
        const result = await buyTokenWithBnb(
          privateKey,
          String(tokenAddress),
          bnbWei,
          { slippageBps: slippageBps != null ? Number(slippageBps) : undefined },
        );
        await recordHolding({
          userId,
          tokenAddress: String(tokenAddress),
          bnbDelta: Number(ethers.formatEther(result.bnbSpentWei)),
          direction: "buy",
          txHash: result.txHash,
        });
        res.json({
          ok: true,
          venue: "fourMemeCurve",
          txHash: result.txHash,
          tokenAddress: result.tokenAddress,
          bnbSpentWei: result.bnbSpentWei.toString(),
          estimatedTokensWei: result.estimatedTokensWei.toString(),
          minTokensWei: result.minTokensWei.toString(),
          slippageBps: result.slippageBps,
        });
      } catch (err: any) {
        res.status(400).json({
          ok: false,
          error: err?.message ?? String(err),
          code: err?.code,
        });
      }
    },
  );

  app.post(
    "/api/fourmeme/sell",
    express.json({ limit: "32kb" }),
    walletAuth,
    async (req: AuthedRequest, res) => {
      const userId = req.botUserId!;
      try {
        const {
          isFourMemeEnabled,
          sellTokenForBnb,
          loadUserBscPrivateKey,
          getTokenInfo,
        } = await import("../../src/services/fourMemeTrading");
        if (!isFourMemeEnabled())
          return res.status(503).json({ ok: false, code: "FOUR_MEME_DISABLED" });
        const { tokenAddress, tokenAmount, slippageBps } = req.body ?? {};
        if (!tokenAddress || !tokenAmount)
          return res
            .status(400)
            .json({ ok: false, error: "tokenAddress + tokenAmount required" });
        const { ethers } = await import("ethers");
        const tokensWei = ethers.parseUnits(String(tokenAmount), 18);
        const { privateKey } = await loadUserBscPrivateKey(userId);

        let info: any;
        try {
          info = await getTokenInfo(String(tokenAddress));
        } catch {
          const { pancakeGetTokenInfo } = await import(
            "../../src/services/pancakeSwapTrading"
          );
          info = await pancakeGetTokenInfo(String(tokenAddress));
        }

        if (info.graduatedToPancake) {
          const { pancakeSellTokenForBnb } = await import(
            "../../src/services/pancakeSwapTrading"
          );
          const result = await pancakeSellTokenForBnb(
            privateKey,
            String(tokenAddress),
            tokensWei,
            { slippageBps: slippageBps != null ? Number(slippageBps) : undefined },
          );
          await recordHolding({
            userId,
            tokenAddress: String(tokenAddress),
            bnbDelta: Number(ethers.formatEther(result.estimatedBnbWei)),
            direction: "sell",
            txHash: result.txHash,
          });
          return res.json({
            ok: true,
            venue: result.venue,
            txHash: result.txHash,
            approvalTxHash: result.approvalTxHash,
            tokenAddress: result.tokenAddress,
            tokensSoldWei: result.tokensSoldWei.toString(),
            estimatedBnbWei: result.estimatedBnbWei.toString(),
            minBnbWei: result.minBnbWei.toString(),
            slippageBps: result.slippageBps,
          });
        }

        const result = await sellTokenForBnb(
          privateKey,
          String(tokenAddress),
          tokensWei,
          { slippageBps: slippageBps != null ? Number(slippageBps) : undefined },
        );
        await recordHolding({
          userId,
          tokenAddress: String(tokenAddress),
          bnbDelta: Number(ethers.formatEther(result.estimatedBnbWei)),
          direction: "sell",
          txHash: result.txHash,
        });
        res.json({
          ok: true,
          venue: "fourMemeCurve",
          txHash: result.txHash,
          tokenAddress: result.tokenAddress,
          tokensSoldWei: result.tokensSoldWei.toString(),
          estimatedBnbWei: result.estimatedBnbWei.toString(),
          minBnbWei: result.minBnbWei.toString(),
          slippageBps: result.slippageBps,
        });
      } catch (err: any) {
        res.status(400).json({
          ok: false,
          error: err?.message ?? String(err),
          code: err?.code,
        });
      }
    },
  );

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

  // ── Markets list (live, sorted by volume) ──────────────────────────
  // 60s cache shared across users to keep load on the 42.space API low.
  const fortyTwoMarketsCache: { value: any[]; fetchedAt: number } = { value: [], fetchedAt: 0 };
  app.get("/api/fortytwo/markets", walletAuth, async (_req: AuthedRequest, res) => {
    try {
      const age = Date.now() - fortyTwoMarketsCache.fetchedAt;
      if (age > 60_000 || fortyTwoMarketsCache.value.length === 0) {
        const { getAllMarkets } = await import("../../src/services/fortyTwo");
        const markets = await getAllMarkets({ status: "live", limit: 30, order: "volume", ascending: false });
        fortyTwoMarketsCache.value = markets.map((m: any) => ({
          marketAddress: m.address,
          marketTitle: m.question,
          category: (m.categories ?? [])[0] ?? "uncategorized",
          startDate: m.startDate,
          endDate: m.endDate,
          elapsedPct: m.elapsedPct,
          volume: typeof m.volume === "number" ? m.volume : 0,
          traders: typeof m.traders === "number" ? m.traders : 0,
        }));
        fortyTwoMarketsCache.fetchedAt = Date.now();
      }
      res.json({ ok: true, markets: fortyTwoMarketsCache.value });
    } catch (err: any) {
      console.error("[bot-bridge] /fortytwo/markets failed:", err?.message);
      // Serve stale cache if we have one — better than failing the UI.
      if (fortyTwoMarketsCache.value.length > 0) {
        return res.json({ ok: true, markets: fortyTwoMarketsCache.value, stale: true });
      }
      res.status(503).json({ ok: false, error: "markets_lookup_failed" });
    }
  });

  // ── On-chain outcomes for a single market (tokenIds + prices) ──────
  // Used by the Buy modal to populate YES/NO buttons with live prices.
  app.get("/api/fortytwo/market/:address", walletAuth, async (req: AuthedRequest, res) => {
    const address = String(req.params.address || "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return res.status(400).json({ ok: false, error: "invalid_address" });
    }
    try {
      const { getMarketByAddress } = await import("../../src/services/fortyTwo");
      const { readMarketOnchain } = await import("../../src/services/fortyTwoOnchain");
      const market = await getMarketByAddress(address);
      const state = await readMarketOnchain(market);
      res.json({
        ok: true,
        market: {
          marketAddress: market.address,
          marketTitle: market.question,
          endDate: market.endDate,
          status: market.status,
          outcomes: state.outcomes.map((o: any) => ({
            tokenId: o.tokenId,
            label: o.label ?? `Outcome ${o.tokenId}`,
            impliedProbability: o.impliedProbability,
          })),
        },
      });
    } catch (err: any) {
      console.error("[bot-bridge] /fortytwo/market failed:", err?.message);
      res.status(500).json({ ok: false, error: "market_lookup_failed", details: err?.message });
    }
  });

  // ── Live-trade opt-in (per-user kill switch) ───────────────────────
  // Both the Telegram bot's /predictions tab and this terminal share the
  // SAME `User.fortyTwoLiveTrade` flag — flipping it here also enables
  // autonomous agent trades for this user. That's intentional: it's the
  // only kill switch the executor checks before any live tx.
  app.get("/api/fortytwo/live-status", walletAuth, async (req: AuthedRequest, res) => {
    const userId = req.botUserId!;
    try {
      const { isUserLiveOptedIn } = await import("../../src/services/fortyTwoExecutor");
      const enabled = await isUserLiveOptedIn(userId);
      res.json({ ok: true, enabled });
    } catch (err: any) {
      console.error("[bot-bridge] /fortytwo/live-status failed:", err?.message);
      res.status(500).json({ ok: false, error: "status_lookup_failed" });
    }
  });

  app.post("/api/fortytwo/live-status", walletAuth, async (req: AuthedRequest, res) => {
    const userId = req.botUserId!;
    const enabled = !!req.body?.enabled;
    try {
      const { setUserLiveOptIn } = await import("../../src/services/fortyTwoExecutor");
      await setUserLiveOptIn(userId, enabled);
      res.json({ ok: true, enabled });
    } catch (err: any) {
      console.error("[bot-bridge] /fortytwo/live-status set failed:", err?.message);
      res.status(500).json({ ok: false, error: "status_update_failed" });
    }
  });

  // ── Manual buy ─────────────────────────────────────────────────────
  // Same code path the Telegram /predictions buy uses. Enforces the
  // executor's per-user caps (min/max amount, simultaneous opens, daily
  // open count) and the live opt-in. Returns 400 with the executor's
  // human-readable reason on validation failures so the UI can show it.
  app.post("/api/fortytwo/buy", walletAuth, async (req: AuthedRequest, res) => {
    const userId = req.botUserId!;
    const marketAddress = String(req.body?.marketAddress || "");
    const tokenId = Number(req.body?.tokenId);
    const usdtAmount = Number(req.body?.usdtAmount);

    if (!/^0x[0-9a-fA-F]{40}$/.test(marketAddress)) {
      return res.status(400).json({ ok: false, error: "invalid_market_address" });
    }
    if (!Number.isFinite(tokenId) || tokenId < 0) {
      return res.status(400).json({ ok: false, error: "invalid_token_id" });
    }
    if (!Number.isFinite(usdtAmount) || usdtAmount <= 0) {
      return res.status(400).json({ ok: false, error: "invalid_amount" });
    }

    try {
      const { openManualPredictionPosition } = await import("../../src/services/fortyTwoExecutor");
      const result = await openManualPredictionPosition({ userId, marketAddress, tokenId, usdtAmount });
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (err: any) {
      console.error("[bot-bridge] /fortytwo/buy failed:", err?.message);
      res.status(500).json({ ok: false, error: humanizeRelayerError(err?.message || "", "Buy") });
    }
  });

  // ── Manual sell (close one open position) ──────────────────────────
  // Bypasses the live-trade kill switch by design — users must always
  // be able to exit existing exposure.
  app.post("/api/fortytwo/sell", walletAuth, async (req: AuthedRequest, res) => {
    const userId = req.botUserId!;
    const positionId = String(req.body?.positionId || "");
    if (!positionId) return res.status(400).json({ ok: false, error: "invalid_position_id" });
    try {
      const { closeUserPredictionPosition } = await import("../../src/services/fortyTwoExecutor");
      const result = await closeUserPredictionPosition(userId, positionId);
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (err: any) {
      console.error("[bot-bridge] /fortytwo/sell failed:", err?.message);
      res.status(500).json({ ok: false, error: humanizeRelayerError(err?.message || "", "Sell") });
    }
  });

  // ── Claim payout for one resolved-winning position ─────────────────
  // Looks up the position's market and calls claimUserResolvedForMarket
  // (claims every winning OT the wallet holds for that market — same
  // batching the Telegram bot uses).
  app.post("/api/fortytwo/claim", walletAuth, async (req: AuthedRequest, res) => {
    const userId = req.botUserId!;
    const positionId = String(req.body?.positionId || "");
    if (!positionId) return res.status(400).json({ ok: false, error: "invalid_position_id" });
    try {
      const r = await pool.query(
        `SELECT "marketAddress", status FROM "OutcomePosition"
          WHERE id = $1 AND "userId" = $2 LIMIT 1`,
        [positionId, userId],
      );
      if (!r.rows.length) return res.status(404).json({ ok: false, error: "position_not_found" });
      if (r.rows[0].status !== "resolved_win") {
        return res.status(400).json({ ok: false, error: `position not claimable (status=${r.rows[0].status})` });
      }
      const { claimUserResolvedForMarket } = await import("../../src/services/fortyTwoExecutor");
      const result = await claimUserResolvedForMarket(userId, r.rows[0].marketAddress);
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (err: any) {
      console.error("[bot-bridge] /fortytwo/claim failed:", err?.message);
      res.status(500).json({ ok: false, error: humanizeRelayerError(err?.message || "", "Claim") });
    }
  });

  // ── Sweep every resolved-winning position the user holds ───────────
  app.post("/api/fortytwo/claim-all", walletAuth, async (req: AuthedRequest, res) => {
    const userId = req.botUserId!;
    try {
      const { claimAllUserResolved } = await import("../../src/services/fortyTwoExecutor");
      const result = await claimAllUserResolved(userId);
      res.json(result);
    } catch (err: any) {
      console.error("[bot-bridge] /fortytwo/claim-all failed:", err?.message);
      res.status(500).json({ ok: false, error: humanizeRelayerError(err?.message || "", "Claim all") });
    }
  });
}
