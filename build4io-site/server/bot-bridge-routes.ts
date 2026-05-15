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
}
