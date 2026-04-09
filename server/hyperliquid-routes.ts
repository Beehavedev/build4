import type { Express, Request, Response, NextFunction } from "express";
import { storage } from "./storage";
import { createHmac, randomBytes } from "crypto";
import {
  createHyperliquidInfoClient,
  createHyperliquidExchangeClient,
  createAgentExchangeClient,
  getMainnetConfig,
  getTestnetConfig,
  approveAgentFromPrivateKey,
} from "./hyperliquid-client";

const HL_CONFIG = getMainnetConfig();
const infoClient = createHyperliquidInfoClient(HL_CONFIG);

async function hlAuth(req: Request, res: Response, next: NextFunction) {
  const chatIdHeader = req.headers["x-telegram-chat-id"] as string;
  if (chatIdHeader && /^\d+$/.test(chatIdHeader)) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const initData = req.headers["x-telegram-init-data"] as string;
    if (initData && botToken) {
      try {
        const params = new URLSearchParams(initData);
        const hash = params.get("hash");
        if (hash) {
          params.delete("hash");
          const dataCheckArr = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`);
          const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
          const computed = createHmac("sha256", secretKey).update(dataCheckArr.join("\n")).digest("hex");
          if (computed === hash) {
            const userStr = params.get("user");
            if (userStr) { const u = JSON.parse(userStr); req.headers["x-telegram-chat-id"] = String(u.id); }
            return next();
          }
        }
      } catch {}
    }
    return next();
  }
  const walletAddress = (req.headers["x-wallet-address"] as string || "").toLowerCase().trim();
  if (walletAddress && /^0x[a-f0-9]{40}$/.test(walletAddress)) {
    try {
      const { db } = await import("./db");
      const { telegramWallets } = await import("@shared/schema");
      const { eq, sql } = await import("drizzle-orm");
      const rows = await db.select().from(telegramWallets).where(eq(telegramWallets.walletAddress, walletAddress));
      if (rows.length > 0) {
        req.headers["x-telegram-chat-id"] = rows[0].chatId;
        return next();
      }
      const { createHash } = await import("crypto");
      const hash = createHash("sha256").update("web:" + walletAddress).digest("hex");
      const syntheticChatId = "8" + hash.replace(/[^0-9]/g, "").slice(0, 14);
      req.headers["x-telegram-chat-id"] = syntheticChatId;
      return next();
    } catch {}
  }
  return next();
}

function getChatId(req: Request): string | null {
  return (req.headers["x-telegram-chat-id"] as string) || null;
}

export function registerHyperliquidRoutes(app: Express) {
  app.use("/api/hl", hlAuth);

  app.get("/api/hl/meta", async (_req: Request, res: Response) => {
    try {
      const meta = await infoClient.getMeta();
      res.json(meta);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/hl/mids", async (_req: Request, res: Response) => {
    try {
      const mids = await infoClient.getAllMids();
      res.json(mids);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/hl/meta-and-ctxs", async (_req: Request, res: Response) => {
    try {
      const data = await infoClient.getMetaAndAssetCtxs();
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/hl/l2book/:coin", async (req: Request, res: Response) => {
    try {
      const coin = req.params.coin;
      const nSigFigs = req.query.nSigFigs ? parseInt(req.query.nSigFigs as string) : undefined;
      const book = await infoClient.getL2Book(coin, nSigFigs);
      res.json(book);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/hl/candles/:coin", async (req: Request, res: Response) => {
    try {
      const coin = req.params.coin;
      const interval = (req.query.interval as string) || "1h";
      const startTime = parseInt(req.query.startTime as string) || Date.now() - 86400000;
      const endTime = req.query.endTime ? parseInt(req.query.endTime as string) : undefined;
      const candles = await infoClient.getCandleSnapshot(coin, interval, startTime, endTime);
      res.json(candles);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/hl/funding/:coin", async (req: Request, res: Response) => {
    try {
      const coin = req.params.coin;
      const startTime = parseInt(req.query.startTime as string) || Date.now() - 86400000;
      const data = await infoClient.getFundingHistory(coin, startTime);
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/hl/account", async (req: Request, res: Response) => {
    try {
      const chatId = getChatId(req);
      if (!chatId) return res.status(401).json({ error: "Not authenticated" });
      const creds = await storage.getHyperliquidCredentials(chatId);
      if (!creds) return res.json({ linked: false });
      const state = await infoClient.getUserState(creds.userAddress);
      res.json({ linked: true, userAddress: creds.userAddress, agentAddress: creds.agentAddress, ...state });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/hl/positions", async (req: Request, res: Response) => {
    try {
      const chatId = getChatId(req);
      if (!chatId) return res.status(401).json({ error: "Not authenticated" });
      const creds = await storage.getHyperliquidCredentials(chatId);
      if (!creds) return res.json([]);
      const state = await infoClient.getUserState(creds.userAddress);
      res.json(state?.assetPositions || []);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/hl/open-orders", async (req: Request, res: Response) => {
    try {
      const chatId = getChatId(req);
      if (!chatId) return res.status(401).json({ error: "Not authenticated" });
      const creds = await storage.getHyperliquidCredentials(chatId);
      if (!creds) return res.json([]);
      const orders = await infoClient.getFrontendOpenOrders(creds.userAddress);
      res.json(orders);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/hl/fills", async (req: Request, res: Response) => {
    try {
      const chatId = getChatId(req);
      if (!chatId) return res.status(401).json({ error: "Not authenticated" });
      const creds = await storage.getHyperliquidCredentials(chatId);
      if (!creds) return res.json([]);
      const fills = await infoClient.getUserFills(creds.userAddress);
      res.json(fills);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/hl/link-wallet", async (req: Request, res: Response) => {
    try {
      const chatId = getChatId(req);
      if (!chatId) return res.status(401).json({ error: "Not authenticated" });
      const { userAddress } = req.body;
      if (!userAddress || !/^0x[a-fA-F0-9]{40}$/.test(userAddress)) {
        return res.status(400).json({ error: "Invalid wallet address" });
      }
      await storage.saveHyperliquidCredentials(chatId, userAddress);
      res.json({ success: true, userAddress: userAddress.toLowerCase() });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/hl/link-agent", async (req: Request, res: Response) => {
    try {
      const chatId = getChatId(req);
      if (!chatId) return res.status(401).json({ error: "Not authenticated" });
      const { agentPrivateKey, userAddress } = req.body;
      if (!agentPrivateKey) return res.status(400).json({ error: "Agent private key required" });
      const { ethers } = await import("ethers");
      const agentWallet = new ethers.Wallet(agentPrivateKey);
      await storage.saveHyperliquidCredentials(chatId, userAddress, agentPrivateKey, agentWallet.address);
      res.json({ success: true, agentAddress: agentWallet.address });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/hl/create-agent", async (req: Request, res: Response) => {
    try {
      const chatId = getChatId(req);
      if (!chatId) return res.status(401).json({ error: "Not authenticated" });
      const creds = await storage.getHyperliquidCredentials(chatId);
      if (!creds) return res.status(400).json({ error: "Link wallet first" });
      const wallets = await storage.getTelegramWallets(chatId);
      const wallet = wallets.find((w: any) => w.walletAddress?.toLowerCase() === creds.userAddress.toLowerCase());
      if (!wallet) return res.status(400).json({ error: "Wallet not found — link an imported wallet" });
      const { resolvePrivateKey } = await import("./telegram-bot");
      const pk = await resolvePrivateKey(chatId, creds.userAddress);
      if (!pk) return res.status(400).json({ error: "Cannot resolve wallet key" });
      const result = await approveAgentFromPrivateKey(pk, HL_CONFIG, req.body.agentName);
      if (result.response?.status === "ok") {
        await storage.saveHyperliquidCredentials(chatId, creds.userAddress, result.agentPrivateKey, result.agentAddress);
        res.json({ success: true, agentAddress: result.agentAddress, agentKey: result.agentPrivateKey });
      } else {
        res.status(400).json({ error: "Agent approval failed", details: result.response });
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/hl/prepare-agent-approval", async (req: Request, res: Response) => {
    try {
      const chatId = getChatId(req);
      if (!chatId) return res.status(401).json({ error: "Not authenticated" });
      const creds = await storage.getHyperliquidCredentials(chatId);
      if (!creds) return res.status(400).json({ error: "Link wallet first" });
      const { ethers } = await import("ethers");
      const agentKey = "0x" + randomBytes(32).toString("hex");
      const agentWallet = new ethers.Wallet(agentKey);
      const nonce = Date.now();
      const typedData = {
        domain: {
          name: "HyperliquidSignTransaction",
          version: "1",
          chainId: 421614,
          verifyingContract: "0x0000000000000000000000000000000000000000",
        },
        types: {
          "HyperliquidTransaction:ApproveAgent": [
            { name: "hyperliquidChain", type: "string" },
            { name: "agentAddress", type: "address" },
            { name: "agentName", type: "string" },
            { name: "nonce", type: "uint64" },
          ],
        },
        primaryType: "HyperliquidTransaction:ApproveAgent",
        message: {
          hyperliquidChain: "Mainnet",
          agentAddress: agentWallet.address,
          agentName: req.body.agentName || "",
          nonce,
        },
      };
      res.json({
        agentAddress: agentWallet.address,
        agentKey,
        nonce,
        typedData,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/hl/submit-agent-approval", async (req: Request, res: Response) => {
    try {
      const chatId = getChatId(req);
      if (!chatId) return res.status(401).json({ error: "Not authenticated" });
      const { signature, agentKey, agentAddress, nonce, agentName } = req.body;
      if (!signature || !agentKey || !agentAddress) {
        return res.status(400).json({ error: "Missing required fields" });
      }
      const creds = await storage.getHyperliquidCredentials(chatId);
      if (!creds) return res.status(400).json({ error: "Link wallet first" });
      const { r, s, v } = JSON.parse(typeof signature === "string" ? signature : JSON.stringify(signature));
      const action: any = {
        type: "approveAgent",
        agentAddress,
        agentName: agentName || "",
        nonce,
      };
      if (!agentName) delete action.agentName;
      const response = await fetch(`${HL_CONFIG.baseUrl}/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          nonce,
          signature: { r, s, v },
          vaultAddress: null,
        }),
      });
      const result = await response.json();
      if (result?.status === "ok") {
        await storage.saveHyperliquidCredentials(chatId, creds.userAddress, agentKey, agentAddress);
        res.json({ success: true, agentAddress });
      } else {
        res.status(400).json({ error: "Approval failed", details: result });
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  async function getExchangeClient(chatId: string) {
    const creds = await storage.getHyperliquidCredentials(chatId);
    if (!creds) throw new Error("Not linked to Hyperliquid");
    if (!creds.agentKey) throw new Error("No API wallet — create one first");
    return createAgentExchangeClient(creds.agentKey, creds.userAddress, HL_CONFIG);
  }

  app.post("/api/hl/order", async (req: Request, res: Response) => {
    try {
      const chatId = getChatId(req);
      if (!chatId) return res.status(401).json({ error: "Not authenticated" });
      const { coin, isBuy, sz, limitPx, orderType, reduceOnly, grouping, builder } = req.body;
      if (!coin || sz === undefined) return res.status(400).json({ error: "Missing coin or size" });
      const client = await getExchangeClient(chatId);
      const result = await client.placeOrder(
        [{
          coin,
          isBuy: !!isBuy,
          sz: parseFloat(sz),
          limitPx: parseFloat(limitPx),
          orderType: orderType || { limit: { tif: "Gtc" } },
          reduceOnly: !!reduceOnly,
        }],
        grouping || "na",
        builder,
      );
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/hl/market-order", async (req: Request, res: Response) => {
    try {
      const chatId = getChatId(req);
      if (!chatId) return res.status(401).json({ error: "Not authenticated" });
      const { coin, isBuy, sz, slippage } = req.body;
      if (!coin || sz === undefined) return res.status(400).json({ error: "Missing coin or size" });
      const client = await getExchangeClient(chatId);
      const result = await client.marketOrder(coin, !!isBuy, parseFloat(sz), slippage ? parseFloat(slippage) : 0.05);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/hl/cancel-order", async (req: Request, res: Response) => {
    try {
      const chatId = getChatId(req);
      if (!chatId) return res.status(401).json({ error: "Not authenticated" });
      const { coin, oid } = req.body;
      if (!coin || oid === undefined) return res.status(400).json({ error: "Missing coin or oid" });
      const client = await getExchangeClient(chatId);
      const result = await client.cancelOrder(coin, parseInt(oid));
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/hl/update-leverage", async (req: Request, res: Response) => {
    try {
      const chatId = getChatId(req);
      if (!chatId) return res.status(401).json({ error: "Not authenticated" });
      const { coin, leverage, isCross } = req.body;
      if (!coin || leverage === undefined) return res.status(400).json({ error: "Missing coin or leverage" });
      const client = await getExchangeClient(chatId);
      const result = await client.updateLeverage(coin, parseInt(leverage), isCross !== false);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/hl/unlink", async (req: Request, res: Response) => {
    try {
      const chatId = getChatId(req);
      if (!chatId) return res.status(401).json({ error: "Not authenticated" });
      await storage.removeHyperliquidCredentials(chatId);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/hl/status", async (req: Request, res: Response) => {
    try {
      const chatId = getChatId(req);
      if (!chatId) return res.json({ linked: false, hasAgent: false });
      const creds = await storage.getHyperliquidCredentials(chatId);
      if (!creds) return res.json({ linked: false, hasAgent: false });
      res.json({
        linked: true,
        hasAgent: !!creds.agentKey,
        userAddress: creds.userAddress,
        agentAddress: creds.agentAddress,
        isMainnet: creds.isMainnet,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
