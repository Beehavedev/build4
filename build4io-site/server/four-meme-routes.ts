// four.meme bonding-curve routes mounted at /api/fourmeme/*.
//
// Companion to pancakeswap-routes.ts: the /competition trade panel calls
// these first for bonding-curve tokens, and falls back to /api/pancake/*
// once a token graduates (liquidityAdded=true).
//
// Auth model identical to pancakeswap-routes.ts: requireSiweAuthed gates
// every write with SIWE cookie + matching x-wallet-address + Origin
// (writes) + per-chatId rate limiting + idempotency-key replay
// protection on trades.

import type { Express, Request, Response } from "express";
import { ethers } from "ethers";
import {
  fourMemeGetTokenInfo,
  fourMemeQuoteBuy,
  fourMemeQuoteSell,
  fourMemeBuyTokenWithBnb,
  fourMemeSellTokenForBnb,
} from "./services/fourMemeTrading";
import { getBscWalletBalance } from "./services/pancakeSwapTrading";
import { recordFourMemeTrade } from "./competition-routes";
import { requireSiweAuthed } from "./competition-auth";

export function registerFourMemeRoutes(app: Express) {
  // Public: token info (+ optional pre-trade quote). No auth — used by
  // the /competition page to show curve state before connect.
  app.get("/api/fourmeme/token/:address", async (req: Request, res: Response) => {
    try {
      const addr = ethers.getAddress(String(req.params.address));
      const info = await fourMemeGetTokenInfo(addr);
      const bnb = req.query.bnb ? String(req.query.bnb) : "";
      const sell = req.query.sell ? String(req.query.sell) : "";
      const out: any = {
        ok: true,
        info: {
          name: info.name,
          symbol: info.symbol,
          decimals: info.decimals,
          lastPriceWei: info.lastPriceWei.toString(),
          version: info.version,
          tokenManager: info.tokenManager,
          quoteIsBnb: info.quoteIsBnb,
          fundsWei: info.fundsWei.toString(),
          maxFundsWei: info.maxFundsWei.toString(),
          fillPct: info.fillPct,
          liquidityAdded: info.liquidityAdded,
          graduatedToPancake: info.graduatedToPancake,
          source: info.source,
        },
        venue: "fourMeme",
      };
      if (bnb && !info.graduatedToPancake && info.quoteIsBnb) {
        try {
          const q = await fourMemeQuoteBuy(addr, ethers.parseEther(bnb));
          out.buyQuote = {
            estimatedAmountWei: q.estimatedAmountWei.toString(),
            estimatedCostWei: q.estimatedCostWei.toString(),
            estimatedFeeWei: q.estimatedFeeWei.toString(),
            amountMsgValueWei: q.amountMsgValueWei.toString(),
          };
        } catch { /* quote optional */ }
      }
      if (sell && !info.graduatedToPancake && info.quoteIsBnb) {
        try {
          const q = await fourMemeQuoteSell(addr, ethers.parseUnits(sell, info.decimals));
          out.sellQuote = { fundsWei: q.fundsWei.toString(), feeWei: q.feeWei.toString() };
        } catch { /* quote optional */ }
      }
      res.json(out);
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err?.message ?? String(err), code: err?.code });
    }
  });

  // Connected user: BNB + ERC20 balance for a four.meme token. Mirrors
  // /api/pancake/wallet-balance — pancake's helper already returns both,
  // so we reuse it (the on-chain ERC20 doesn't care which curve owns it).
  app.get("/api/fourmeme/wallet-balance/:tokenAddress", async (req: Request, res: Response) => {
    const auth = await requireSiweAuthed(req, {
      rateLimit: { key: "fm:balance", max: 60, windowMs: 60_000 },
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

  app.post("/api/fourmeme/buy", async (req: Request, res: Response) => {
    const auth = await requireSiweAuthed(req, {
      isWrite: true,
      needPrivateKey: true,
      rateLimit: { key: "fm:buy", max: 10, windowMs: 60_000 },
      idempotency: { ttlMs: 60_000 },
    });
    if ("error" in auth) return res.status(auth.status).json({ ok: false, error: auth.error, code: auth.code });
    try {
      const { tokenAddress, bnbAmount, slippageBps } = req.body ?? {};
      if (!tokenAddress || !bnbAmount) return res.status(400).json({ ok: false, error: "tokenAddress + bnbAmount required" });
      const bnbWei = ethers.parseEther(String(bnbAmount));
      const result = await fourMemeBuyTokenWithBnb(auth.privateKey!, String(tokenAddress), bnbWei, {
        slippageBps: slippageBps != null ? Number(slippageBps) : undefined,
      });
      // Fire-and-forget competition hook — never blocks the response.
      recordFourMemeTrade({
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

  app.post("/api/fourmeme/sell", async (req: Request, res: Response) => {
    const auth = await requireSiweAuthed(req, {
      isWrite: true,
      needPrivateKey: true,
      rateLimit: { key: "fm:sell", max: 10, windowMs: 60_000 },
      idempotency: { ttlMs: 60_000 },
    });
    if ("error" in auth) return res.status(auth.status).json({ ok: false, error: auth.error, code: auth.code });
    try {
      const { tokenAddress, tokenAmount, slippageBps } = req.body ?? {};
      if (!tokenAddress || !tokenAmount) return res.status(400).json({ ok: false, error: "tokenAddress + tokenAmount required" });
      // Resolve decimals on-chain — never trust the client.
      const info = await fourMemeGetTokenInfo(String(tokenAddress));
      const tokensWei = ethers.parseUnits(String(tokenAmount), info.decimals);
      const result = await fourMemeSellTokenForBnb(auth.privateKey!, String(tokenAddress), tokensWei, {
        slippageBps: slippageBps != null ? Number(slippageBps) : undefined,
      });
      recordFourMemeTrade({
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
