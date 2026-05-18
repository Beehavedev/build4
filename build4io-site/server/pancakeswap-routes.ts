// PancakeSwap V2 routes mounted at /api/pancake/*.
//
// Mirrors the bot's `/api/fourmeme/*` PCS-fallback paths so the
// /competition page (and any other site UI) can quote, buy, and sell
// BSC tokens against the V2 router using the user's existing BUILD4
// custodial wallet.
//
// Auth model: the route layer resolves the connected EVM wallet
// (from `x-wallet-address` header) to a chatId via `telegram_wallets`,
// then looks up the matching encrypted PK and decrypts it via
// `storage.getPrivateKeyByWalletAddress`. No bot edits needed; reuses
// the same Postgres rows the Telegram mini-app already writes.

import type { Express, Request, Response } from "express";
import { ethers } from "ethers";
import {
  pancakeGetTokenInfo,
  pancakeQuoteBuy,
  pancakeQuoteSell,
  pancakeBuyTokenWithBnb,
  pancakeSellTokenForBnb,
  getBscWalletBalance,
} from "./services/pancakeSwapTrading";
import { recordPancakeTrade } from "./competition-routes";
import { requireSiweAuthed } from "./competition-auth";

// All authed endpoints below use requireSiweAuthed (see competition-auth.ts):
// SIWE cookie + matching x-wallet-address + CSRF Origin check on writes +
// per-chatId rate limiting + idempotency-key replay protection on trades.

export function registerPancakeRoutes(app: Express) {
  // Public: token info (+ optional pre-trade quote). No auth required so
  // the /competition page can show name/symbol/price before connect.
  app.get("/api/pancake/token/:address", async (req: Request, res: Response) => {
    try {
      const addr = ethers.getAddress(String(req.params.address));
      const info = await pancakeGetTokenInfo(addr);
      const bnb = req.query.bnb ? String(req.query.bnb) : "";
      const sell = req.query.sell ? String(req.query.sell) : "";
      const out: any = {
        ok: true,
        info: {
          name: info.name,
          symbol: info.symbol,
          decimals: info.decimals,
          lastPriceWei: info.lastPriceWei.toString(),
          source: info.source,
        },
        venue: "pancakeV2",
      };
      if (bnb) {
        const q = await pancakeQuoteBuy(addr, ethers.parseEther(bnb));
        out.buyQuote = { estimatedAmountWei: q.estimatedAmountWei.toString(), amountInWei: q.amountInWei.toString() };
      }
      if (sell) {
        const q = await pancakeQuoteSell(addr, ethers.parseUnits(sell, info.decimals));
        out.sellQuote = { estimatedBnbWei: q.estimatedBnbWei.toString(), amountInWei: q.amountInWei.toString() };
      }
      res.json(out);
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err?.message ?? String(err), code: err?.code });
    }
  });

  // Connected user: BNB balance + ERC20 balance of a given token. Used
  // by the trade panel to power Max pre-fill.
  app.get("/api/pancake/wallet-balance/:tokenAddress", async (req: Request, res: Response) => {
    // Read-only — no PK fetch, no CSRF check, but still SIWE-gated so we
    // don't leak balances for arbitrary registered wallets.
    const auth = await requireSiweAuthed(req, {
      rateLimit: { key: "pcs:balance", max: 60, windowMs: 60_000 },
    });
    if ("error" in auth) return res.status(auth.status).json({ ok: false, error: auth.error, code: auth.code });
    try {
      const tokenAddress = ethers.getAddress(String(req.params.tokenAddress));
      const { bnbWei, tokenWei, tokenDecimals, errors } = await getBscWalletBalance(auth.walletAddress, tokenAddress);
      res.json({
        ok: true,
        address: auth.walletAddress,
        bnbWei: bnbWei.toString(),
        bnbBalance: ethers.formatEther(bnbWei),
        tokenWei: tokenWei.toString(),
        tokenBalance: ethers.formatUnits(tokenWei, tokenDecimals),
        tokenDecimals,
        error: errors.length ? errors.join("; ") : null,
      });
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err?.message ?? String(err) });
    }
  });

  app.post("/api/pancake/buy", async (req: Request, res: Response) => {
    const auth = await requireSiweAuthed(req, {
      isWrite: true,
      needPrivateKey: true,
      rateLimit: { key: "pcs:buy", max: 10, windowMs: 60_000 },
      idempotency: { ttlMs: 60_000 },
    });
    if ("error" in auth) return res.status(auth.status).json({ ok: false, error: auth.error, code: auth.code });
    try {
      const { tokenAddress, bnbAmount, slippageBps } = req.body ?? {};
      if (!tokenAddress || !bnbAmount) return res.status(400).json({ ok: false, error: "tokenAddress + bnbAmount required" });
      const bnbWei = ethers.parseEther(String(bnbAmount));
      const result = await pancakeBuyTokenWithBnb(auth.privateKey!, String(tokenAddress), bnbWei, {
        slippageBps: slippageBps != null ? Number(slippageBps) : undefined,
      });
      // Fire-and-forget competition hook — never blocks the response.
      recordPancakeTrade({
        chatId: auth.chatId,
        walletAddress: auth.walletAddress,
        tokenAddress: result.tokenAddress,
        side: "buy",
        bnbWei: result.bnbSpentWei,
      }).catch(() => {});
      res.json({
        ok: true, venue: result.venue,
        txHash: result.txHash,
        tokenAddress: result.tokenAddress,
        bnbSpentWei: result.bnbSpentWei.toString(),
        estimatedTokensWei: result.estimatedTokensWei.toString(),
        minTokensWei: result.minTokensWei.toString(),
        slippageBps: result.slippageBps,
      });
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err?.message ?? String(err), code: err?.code });
    }
  });

  app.post("/api/pancake/sell", async (req: Request, res: Response) => {
    const auth = await requireSiweAuthed(req, {
      isWrite: true,
      needPrivateKey: true,
      rateLimit: { key: "pcs:sell", max: 10, windowMs: 60_000 },
      idempotency: { ttlMs: 60_000 },
    });
    if ("error" in auth) return res.status(auth.status).json({ ok: false, error: auth.error, code: auth.code });
    try {
      const { tokenAddress, tokenAmount, slippageBps } = req.body ?? {};
      if (!tokenAddress || !tokenAmount) return res.status(400).json({ ok: false, error: "tokenAddress + tokenAmount required" });
      // Always resolve decimals on-chain — never trust the client.
      const info = await pancakeGetTokenInfo(String(tokenAddress));
      const tokensWei = ethers.parseUnits(String(tokenAmount), info.decimals);
      const result = await pancakeSellTokenForBnb(auth.privateKey!, String(tokenAddress), tokensWei, {
        slippageBps: slippageBps != null ? Number(slippageBps) : undefined,
      });
      recordPancakeTrade({
        chatId: auth.chatId,
        walletAddress: auth.walletAddress,
        tokenAddress: result.tokenAddress,
        side: "sell",
        bnbWei: result.estimatedBnbWei,
      }).catch(() => {});
      res.json({
        ok: true, venue: result.venue,
        txHash: result.txHash,
        approvalTxHash: result.approvalTxHash,
        tokenAddress: result.tokenAddress,
        tokensSoldWei: result.tokensSoldWei.toString(),
        estimatedBnbWei: result.estimatedBnbWei.toString(),
        minBnbWei: result.minBnbWei.toString(),
        slippageBps: result.slippageBps,
      });
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err?.message ?? String(err), code: err?.code });
    }
  });
}
