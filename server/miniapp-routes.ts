import type { Express, Request, Response, NextFunction } from "express";
import { storage } from "./storage";
import { getAsterClient, getBotWalletAsterClient, getUserWalletAddress, resolvePrivateKey } from "./telegram-bot";
import { createHmac } from "crypto";
import { getMiniAppHTML } from "./miniapp-html";
import { generatePnlCardImage } from "./pnl-image";

function validateTelegramInitData(initData: string, botToken: string): { valid: boolean; chatId?: string } {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return { valid: false };
    params.delete("hash");
    const dataCheckArr = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`);
    const dataCheckString = dataCheckArr.join("\n");
    const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
    const computedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    if (computedHash !== hash) return { valid: false };
    const userStr = params.get("user");
    if (userStr) {
      const user = JSON.parse(userStr);
      return { valid: true, chatId: String(user.id) };
    }
    return { valid: true };
  } catch {
    return { valid: false };
  }
}

async function miniAppAuth(req: Request, res: Response, next: NextFunction) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const initData = req.headers["x-telegram-init-data"] as string;
  if (initData && botToken) {
    const result = validateTelegramInitData(initData, botToken);
    if (result.valid && result.chatId) {
      req.headers["x-telegram-chat-id"] = result.chatId;
      return next();
    }
  }
  const chatId = req.headers["x-telegram-chat-id"] as string;
  if (chatId && /^\d+$/.test(chatId)) {
    return next();
  }
  const walletAddress = (req.headers["x-wallet-address"] as string || "").toLowerCase().trim();
  if (walletAddress && /^0x[a-f0-9]{40}$/.test(walletAddress)) {
    try {
      const { db } = await import("./db");
      const { telegramWallets, asterCredentials: asterCredsTable } = await import("@shared/schema");
      const { eq, sql: sqlTag } = await import("drizzle-orm");
      const rows = await db.select({ chatId: telegramWallets.chatId })
        .from(telegramWallets)
        .where(eq(telegramWallets.walletAddress, walletAddress))
        .limit(1);
      if (rows.length > 0 && rows[0].chatId) {
        req.headers["x-telegram-chat-id"] = rows[0].chatId;
        return next();
      }
      const credRows = await db.select({ chatId: asterCredsTable.chatId })
        .from(asterCredsTable)
        .where(eq(asterCredsTable.parentAddress, walletAddress))
        .limit(1);
      if (credRows.length > 0 && credRows[0].chatId) {
        req.headers["x-telegram-chat-id"] = credRows[0].chatId;
        return next();
      }
      const credRows2 = await db.select({ chatId: asterCredsTable.chatId })
        .from(asterCredsTable)
        .where(sqlTag`parent_address LIKE ${"astercode:" + walletAddress}`)
        .limit(1);
      if (credRows2.length > 0 && credRows2[0].chatId) {
        req.headers["x-telegram-chat-id"] = credRows2[0].chatId;
        return next();
      }
      const credRows3 = await db.select({ chatId: asterCredsTable.chatId })
        .from(asterCredsTable)
        .where(eq(asterCredsTable.apiKey, walletAddress))
        .limit(1);
      if (credRows3.length > 0 && credRows3[0].chatId) {
        req.headers["x-telegram-chat-id"] = credRows3[0].chatId;
        return next();
      }
    } catch (e: any) {
      console.log(`[WebAuth] wallet lookup error: ${e.message}`);
    }
    return res.status(404).json({ error: "Wallet not registered. Please activate trading first." });
  }
  return res.status(401).json({ error: "Authentication required" });
}

export function registerMiniAppRoutes(app: Express) {
  app.get("/miniapp", (_req: Request, res: Response) => {
    const html = getMiniAppHTML();
    res.status(200).set({
      "Content-Type": "text/html",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
      "Surrogate-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; connect-src 'self' https:; frame-ancestors https://web.telegram.org https://*.telegram.org; object-src 'none'; base-uri 'self'"
    }).end(html);
  });

  app.get("/miniapp-old", (_req: Request, res: Response) => {
    res.redirect("/miniapp");
  });

  const pnlImageCache = new Map<string, { buf: Buffer; ts: number }>();
  const PNL_CACHE_TTL = 600_000;

  app.get("/pnl/image", async (req: Request, res: Response) => {
    try {
      const q = req.query;
      const cacheKey = `${q.pct}|${q.pnl}|${q.sym}|${q.side}|${q.lev}|${q.ep}|${q.mp}|${q.name}|${q.w}|${q.l}`;
      const cached = pnlImageCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < PNL_CACHE_TTL) {
        return res.status(200).set({
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=600",
        }).end(cached.buf);
      }

      const imgBuf = await generatePnlCardImage({
        pnlPercent: parseFloat(q.pct as string || "0"),
        pnlUsd: parseFloat(q.pnl as string || "0"),
        symbol: decodeURIComponent(q.sym as string || "BTCUSDT"),
        side: (q.side as string || "LONG").toUpperCase(),
        leverage: parseInt(q.lev as string || "5"),
        entryPrice: parseFloat(q.ep as string || "0"),
        markPrice: parseFloat(q.mp as string || "0"),
        name: decodeURIComponent(q.name as string || "Trader"),
        ref: decodeURIComponent(q.ref as string || "build4"),
      });

      pnlImageCache.set(cacheKey, { buf: imgBuf, ts: Date.now() });
      if (pnlImageCache.size > 200) {
        const oldest = [...pnlImageCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
        for (let i = 0; i < 50; i++) pnlImageCache.delete(oldest[i][0]);
      }

      res.status(200).set({
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=600",
      }).end(imgBuf);
    } catch (e: any) {
      console.error("[pnl/image] Error:", e.message);
      res.status(500).json({ error: "Failed to generate image" });
    }
  });

  app.get("/pnl", (req: Request, res: Response) => {
    const q = req.query;
    const pnl = parseFloat(q.pnl as string || "0");
    const pos = parseInt(q.pos as string || "0");
    const name = decodeURIComponent(q.name as string || "Trader");
    const ref = decodeURIComponent(q.ref as string || "build4");
    const pctParam = q.pct as string || "0";
    const symParam = q.sym as string || "BTCUSDT";
    const sideParam = q.side as string || "LONG";
    const levParam = q.lev as string || "5";
    const epParam = q.ep as string || "0";
    const mpParam = q.mp as string || "0";
    const pnlSign = pnl >= 0 ? "+" : "";
    const pnlText = `${pnlSign}$${Math.abs(pnl).toFixed(2)}`;
    const pctVal = parseFloat(pctParam);
    const pctText = `${pctVal >= 0 ? "+" : ""}${pctVal.toFixed(2)}%`;

    const pnlColor = pnl >= 0 ? "#0ecb81" : "#f85149";
    const accentRgb = pnl >= 0 ? "14,203,129" : "248,81,73";
    const refLink = `https://t.me/BUILD4_BOT?start=${ref}`;
    const ogImageUrl = `https://build4.io/pnl/image?pct=${pctParam}&pnl=${pnl}&sym=${encodeURIComponent(symParam)}&side=${sideParam}&lev=${levParam}&ep=${epParam}&mp=${mpParam}&name=${encodeURIComponent(name)}&ref=${encodeURIComponent(ref)}`;

    const html = `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} | PnL Card — BUILD4</title>
<meta property="og:title" content="${name}'s Trading Performance">
<meta property="og:description" content="PnL: ${pnlText} (${pctText}) | Trade futures on Aster DEX via Telegram">
<meta property="og:image" content="${ogImageUrl}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${name}'s Trading Performance — BUILD4">
<meta name="twitter:description" content="PnL: ${pnlText} (${pctText}) | Trade futures on Aster DEX via Telegram">
<meta name="twitter:image" content="${ogImageUrl}">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0e11;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:20px}
.card{max-width:420px;width:100%;background:linear-gradient(145deg,#12161a,#1a1e24);border:1px solid rgba(${accentRgb},0.3);border-radius:20px;padding:32px;position:relative;overflow:hidden}
.glow{position:absolute;top:-40px;right:-40px;width:200px;height:200px;background:radial-gradient(circle,rgba(${accentRgb},0.15),transparent);border-radius:50%}
.glow2{position:absolute;bottom:-60px;left:-60px;width:180px;height:180px;background:radial-gradient(circle,rgba(${accentRgb},0.08),transparent);border-radius:50%}
.header{display:flex;align-items:center;gap:12px;margin-bottom:24px;position:relative;z-index:1}
.avatar{width:48px;height:48px;border-radius:14px;background:rgba(${accentRgb},0.15);display:flex;align-items:center;justify-content:center;font-size:24px}
.name{color:#fff;font-size:18px;font-weight:700}
.subtitle{color:#8a919e;font-size:12px;margin-top:2px}
.pnl-section{text-align:center;padding:20px 0;position:relative;z-index:1}
.pnl-label{font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#8a919e;font-weight:500}
.pnl-val{font-size:42px;font-weight:800;color:${pnlColor};font-family:'SF Mono',SFMono-Regular,Consolas,monospace;margin:8px 0;letter-spacing:-1px}
.pct-val{font-size:18px;color:${pnlColor};font-family:'SF Mono',SFMono-Regular,Consolas,monospace;opacity:0.8}
.stats{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:20px;position:relative;z-index:1}
.stat{text-align:center;padding:12px 8px;background:rgba(255,255,255,0.03);border-radius:12px;border:1px solid rgba(255,255,255,0.05)}
.stat-label{font-size:10px;color:#8a919e;text-transform:uppercase;letter-spacing:.5px;font-weight:500}
.stat-val{font-size:16px;font-weight:700;margin-top:4px;font-family:'SF Mono',SFMono-Regular,Consolas,monospace}
.green{color:#0ecb81}.red{color:#f85149}.white{color:#fff}
.ref-section{margin-top:20px;padding:16px;background:rgba(${accentRgb},0.06);border:1px solid rgba(${accentRgb},0.2);border-radius:14px;text-align:center;position:relative;z-index:1}
.ref-label{font-size:10px;color:#8a919e;text-transform:uppercase;letter-spacing:1px}
.ref-code{font-size:22px;font-weight:800;color:rgba(${accentRgb},0.9);font-family:'SF Mono',SFMono-Regular,Consolas,monospace;margin:6px 0}
.footer{margin-top:24px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:space-between;position:relative;z-index:1}
.brand{color:#8a919e;font-size:12px;font-weight:600;letter-spacing:.5px}
.powered{color:#555;font-size:10px}
.cta{margin-top:20px;text-align:center;position:relative;z-index:1}
.cta a{display:inline-block;padding:12px 32px;background:linear-gradient(135deg,rgba(${accentRgb},0.9),rgba(${accentRgb},0.6));color:${pnl >= 0 ? '#0b0e11' : '#fff'};text-decoration:none;border-radius:12px;font-weight:700;font-size:14px}
</style></head><body>
<div class="card">
<div class="glow"></div><div class="glow2"></div>
<div class="header"><div class="avatar">🤖</div><div><div class="name">${name}</div><div class="subtitle">Aster DEX Futures</div></div></div>
<div class="pnl-section">
<div class="pnl-label">PnL</div>
<div class="pnl-val">${pnlText}</div>
<div class="pct-val">${pctText}</div>
</div>
<div class="ref-section">
<div class="ref-label">Referral Code</div>
<div class="ref-code">${ref.toUpperCase()}</div>
<div style="font-size:12px;color:#8a919e;margin-top:4px">${refLink}</div>
</div>
<div class="footer"><span class="brand">BUILD4</span><span class="powered">Powered by Aster DEX</span></div>
<div class="cta"><a href="${refLink}">Start Trading on Telegram →</a></div>
</div></body></html>`;

    res.status(200).set({
      "Content-Type": "text/html",
      "Cache-Control": "public, max-age=60",
    }).end(html);
  });

  app.post("/api/miniapp/web-register", async (req: Request, res: Response) => {
    try {
      const { walletAddress } = req.body;
      if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
        return res.status(400).json({ error: "Invalid wallet address" });
      }
      const addr = walletAddress.toLowerCase();

      const { db } = await import("./db");
      const { telegramWallets, asterCredentials: asterCredsTable } = await import("@shared/schema");
      const { eq, sql: sqlTag } = await import("drizzle-orm");

      const existing = await db.select({ chatId: telegramWallets.chatId })
        .from(telegramWallets)
        .where(eq(telegramWallets.walletAddress, addr))
        .limit(1);
      if (existing.length > 0) {
        return res.json({ success: true, chatId: existing[0].chatId, alreadyRegistered: true });
      }

      let foundChatId: string | null = null;
      try {
        const cr1 = await db.select({ chatId: asterCredsTable.chatId }).from(asterCredsTable).where(eq(asterCredsTable.parentAddress, addr)).limit(1);
        if (cr1.length > 0) foundChatId = cr1[0].chatId;
        if (!foundChatId) {
          const cr2 = await db.select({ chatId: asterCredsTable.chatId }).from(asterCredsTable).where(sqlTag`parent_address LIKE ${"astercode:" + addr}`).limit(1);
          if (cr2.length > 0) foundChatId = cr2[0].chatId;
        }
        if (!foundChatId) {
          const cr3 = await db.select({ chatId: asterCredsTable.chatId }).from(asterCredsTable).where(eq(asterCredsTable.apiKey, addr)).limit(1);
          if (cr3.length > 0) foundChatId = cr3[0].chatId;
        }
      } catch {}

      if (foundChatId) {
        await storage.saveTelegramWallet(foundChatId, addr);
        await storage.setActiveTelegramWallet(foundChatId, addr);
        console.log(`[WebRegister] Auto-linked wallet ${addr.substring(0, 10)} to existing chatId=${foundChatId} via asterCredentials`);
        return res.json({ success: true, chatId: foundChatId, alreadyRegistered: true });
      }

      const { createHash } = await import("crypto");
      const hash = createHash("sha256").update(`web:${addr}`).digest("hex");
      const chatId = "8" + hash.replace(/[^0-9]/g, "").substring(0, 14).padEnd(14, "0");

      await storage.saveTelegramWallet(chatId, addr);
      await storage.setActiveTelegramWallet(chatId, addr);

      console.log(`[WebRegister] New web user: wallet=${addr.substring(0, 10)} chatId=${chatId}`);

      res.json({
        success: true,
        chatId,
        walletAddress: addr,
        asterLinked: false,
        alreadyRegistered: false,
      });
    } catch (e: any) {
      console.error("[WebRegister] Error:", e.message);
      res.status(500).json({ error: "Registration failed. Please try again." });
    }
  });

  app.get("/api/public/markets", async (_req: Request, res: Response) => {
    try {
      const symbols = [
        "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "DOGEUSDT",
        "XRPUSDT", "ADAUSDT", "AVAXUSDT", "DOTUSDT", "LINKUSDT",
        "MATICUSDT", "LTCUSDT", "UNIUSDT", "APTUSDT", "ARBUSDT",
        "OPUSDT", "SUIUSDT", "NEARUSDT",
      ];
      const prices = await Promise.all(
        symbols.map(async (sym) => {
          try {
            const resp = await fetch(`https://fapi.asterdex.com/fapi/v1/ticker/price?symbol=${sym}`);
            if (!resp.ok) return { symbol: sym, price: 0 };
            const data = await resp.json();
            return { symbol: sym, price: parseFloat(data?.price || "0") };
          } catch {
            return { symbol: sym, price: 0 };
          }
        })
      );
      res.set("Cache-Control", "public, max-age=5").json({ markets: prices });
    } catch (e: any) {
      res.status(500).json({ error: "Failed to fetch markets" });
    }
  });

  app.get("/api/public/klines", async (req: Request, res: Response) => {
    try {
      const symbol = (req.query.symbol as string) || "BTCUSDT";
      const interval = (req.query.interval as string) || "1h";
      const limit = Math.min(parseInt(req.query.limit as string) || 300, 1000);
      const resp = await fetch(`https://fapi.asterdex.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
      if (!resp.ok) return res.status(502).json({ error: "Upstream error" });
      const data = await resp.json();
      res.set("Cache-Control", "public, max-age=5").json(data);
    } catch (e: any) {
      res.status(500).json({ error: "Failed to fetch klines" });
    }
  });

  app.get("/api/public/depth", async (req: Request, res: Response) => {
    try {
      const symbol = (req.query.symbol as string) || "BTCUSDT";
      const validLimits = [5, 10, 20, 50, 100];
      const requested = parseInt(req.query.limit as string) || 20;
      const limit = validLimits.includes(requested) ? requested : 20;
      const resp = await fetch(`https://fapi.asterdex.com/fapi/v1/depth?symbol=${symbol}&limit=${limit}`);
      if (!resp.ok) return res.status(502).json({ error: "Upstream error" });
      res.set("Cache-Control", "public, max-age=2").json(await resp.json());
    } catch (e: any) {
      res.status(500).json({ error: "Failed to fetch depth" });
    }
  });

  app.get("/api/public/ticker", async (req: Request, res: Response) => {
    try {
      const symbol = req.query.symbol as string;
      const url = symbol
        ? `https://fapi.asterdex.com/fapi/v1/ticker/24hr?symbol=${symbol}`
        : `https://fapi.asterdex.com/fapi/v1/ticker/24hr`;
      const resp = await fetch(url);
      if (!resp.ok) return res.status(502).json({ error: "Upstream error" });
      res.set("Cache-Control", "public, max-age=3").json(await resp.json());
    } catch (e: any) {
      res.status(500).json({ error: "Failed to fetch ticker" });
    }
  });

  app.get("/api/public/funding", async (req: Request, res: Response) => {
    try {
      const symbol = (req.query.symbol as string) || "BTCUSDT";
      const resp = await fetch(`https://fapi.asterdex.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`);
      if (!resp.ok) return res.status(502).json({ error: "Upstream error" });
      res.set("Cache-Control", "public, max-age=10").json(await resp.json());
    } catch (e: any) {
      res.status(500).json({ error: "Failed to fetch funding" });
    }
  });

  const activationSessions = new Map<string, {
    connectedAddr: string;
    tradingAddr: string;
    tradingPk: string;
    chatId: string;
    createdAt: number;
  }>();

  setInterval(() => {
    const now = Date.now();
    for (const [id, sess] of activationSessions) {
      if (now - sess.createdAt > 10 * 60 * 1000) activationSessions.delete(id);
    }
  }, 60_000);

  app.post("/api/miniapp/activate-trading", async (req: Request, res: Response) => {
    try {
      const { walletAddress } = req.body;
      if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
        return res.status(400).json({ error: "Invalid wallet address" });
      }
      const connectedAddr = walletAddress.toLowerCase();

      const { createHash, randomBytes } = await import("crypto");
      const telegramChatId = req.headers["x-telegram-chat-id"] as string;
      let chatId: string;
      if (telegramChatId && /^\d+$/.test(telegramChatId)) {
        chatId = telegramChatId;
      } else {
        const hash = createHash("sha256").update(`web:${connectedAddr}`).digest("hex");
        chatId = "8" + hash.replace(/[^0-9]/g, "").substring(0, 14).padEnd(14, "0");
      }

      const { Wallet } = await import("ethers");

      const existingCreds = await storage.getAsterCredentials(chatId);
      if (existingCreds) {
        const parentAddr = existingCreds.parentAddress?.replace("astercode:", "") || connectedAddr;
        if (parentAddr.toLowerCase() === connectedAddr) {
          console.log(`[MiniApp] User ${connectedAddr.substring(0, 10)} already activated with correct wallet, chatId=${chatId}`);
          return res.json({ success: true, tradingWallet: connectedAddr, parentAddress: connectedAddr, alreadyActive: true });
        }
        console.log(`[MiniApp] User ${connectedAddr.substring(0, 10)} has stale creds (parent=${parentAddr.substring(0,10)}), re-activating with MetaMask wallet`);
      }

      const existingWallets = await storage.getTelegramWallets(chatId);
      if (!existingWallets || existingWallets.length === 0) {
        await storage.saveTelegramWallet(chatId, connectedAddr);
        await storage.setActiveTelegramWallet(chatId, connectedAddr);
      }

      const signerWallet = Wallet.createRandom();
      const signerAddr = signerWallet.address.toLowerCase();
      const signerPk = signerWallet.privateKey;

      const { buildEip712TypedData, getDefaultAsterCodeConfig } = await import("./aster-code");
      const codeConfig = getDefaultAsterCodeConfig();

      const agentName = `build4_${Date.now()}`;
      const expiry = Math.trunc(Date.now() / 1000 + 2 * 365 * 24 * 3600) * 1000;

      const agentTypedData = buildEip712TypedData("ApproveAgent", {
        agentName,
        agentAddress: signerWallet.address,
        ipWhitelist: "",
        expired: expiry,
        canSpotTrade: false,
        canPerpTrade: true,
        canWithdraw: false,
      }, connectedAddr);

      const builderTypedData = buildEip712TypedData("ApproveBuilder", {
        builder: codeConfig.builderAddress,
        maxFeeRate: codeConfig.maxFeeRate,
        builderName: codeConfig.builderName,
      }, connectedAddr);

      const sessionId = randomBytes(16).toString("hex");
      activationSessions.set(sessionId, {
        connectedAddr,
        tradingAddr: connectedAddr,
        tradingPk: signerPk,
        chatId,
        createdAt: Date.now(),
        signerAddr,
        signerPk,
        agentFullParams: agentTypedData.fullParams,
        builderFullParams: builderTypedData.fullParams,
      });

      console.log(`[MiniApp] Activation: user=${connectedAddr.substring(0, 10)} signer=${signerAddr.substring(0, 10)} chatId=${chatId} session=${sessionId.substring(0, 8)}`);

      res.json({
        success: true,
        phase: "sign",
        sessionId,
        signerAddress: signerAddr,
        agentTypedData: { domain: agentTypedData.domain, types: agentTypedData.types, message: agentTypedData.message, primaryType: "ApproveAgent" },
        builderTypedData: { domain: builderTypedData.domain, types: builderTypedData.types, message: builderTypedData.message, primaryType: "ApproveBuilder" },
      });
    } catch (e: any) {
      console.error("[MiniApp] activate-trading error:", e.message);
      res.status(500).json({ error: e.message || "Failed to start activation" });
    }
  });

  app.post("/api/miniapp/complete-activation", async (req: Request, res: Response) => {
    try {
      const { sessionId, agentSignature, builderSignature } = req.body;
      if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });
      if (!agentSignature) return res.status(400).json({ error: "Missing agentSignature — please sign the agent approval in MetaMask" });

      const session = activationSessions.get(sessionId);
      if (!session) return res.status(400).json({ error: "Invalid or expired session" });
      activationSessions.delete(sessionId);

      const { connectedAddr, chatId, signerAddr, signerPk, agentFullParams, builderFullParams } = session as any;

      console.log(`[MiniApp] Completing MetaMask activation for user=${connectedAddr.substring(0, 10)} signer=${signerAddr.substring(0, 10)} chatId=${chatId}`);

      const { submitSignedEip712, getDefaultAsterCodeConfig, createAsterCodeFuturesClient } = await import("./aster-code");
      const codeConfig = getDefaultAsterCodeConfig();
      const baseUrl = codeConfig.fApiUrl || "https://fapi.asterdex.com";

      const agentResult = await submitSignedEip712(baseUrl, "/fapi/v3/approveAgent", agentFullParams, agentSignature);
      console.log(`[MiniApp] approveAgent result: ${JSON.stringify(agentResult).substring(0, 200)}`);

      if (builderSignature && builderFullParams) {
        await new Promise(r => setTimeout(r, 300));
        try {
          const builderResult = await submitSignedEip712(baseUrl, "/fapi/v3/approveBuilder", builderFullParams, builderSignature);
          console.log(`[MiniApp] approveBuilder result: ${JSON.stringify(builderResult).substring(0, 200)}`);
        } catch (bErr: any) {
          console.log(`[MiniApp] approveBuilder failed (may already exist): ${bErr.message}`);
        }
      }

      await storage.saveTelegramWallet(chatId, signerAddr, signerPk);
      await storage.saveAsterCredentials(chatId, signerAddr, signerPk, `astercode:${connectedAddr}`);

      let balanceInfo: any = null;
      try {
        const client = createAsterCodeFuturesClient(connectedAddr, signerAddr, signerPk, codeConfig);
        balanceInfo = await client.balance();
        console.log(`[MiniApp] Post-activation balance: ${JSON.stringify(balanceInfo).substring(0, 300)}`);
      } catch (balErr: any) {
        console.log(`[MiniApp] Post-activation balance check: ${balErr.message}`);
      }

      res.json({
        success: true,
        tradingWallet: connectedAddr,
        parentAddress: connectedAddr,
      });
    } catch (e: any) {
      console.error("[MiniApp] complete-activation error:", e.message);
      res.status(500).json({ error: e.message || "Activation failed" });
    }
  });

  app.post("/api/miniapp/link-bot-wallet", async (req: Request, res: Response) => {
    try {
      const { walletAddress, botWalletAddress } = req.body;
      if (!walletAddress || !botWalletAddress) {
        return res.status(400).json({ error: "Missing wallet addresses" });
      }
      const metamask = walletAddress.toLowerCase().trim();
      const botWallet = botWalletAddress.toLowerCase().trim();
      if (!/^0x[a-f0-9]{40}$/.test(metamask) || !/^0x[a-f0-9]{40}$/.test(botWallet)) {
        return res.status(400).json({ error: "Invalid wallet address format" });
      }

      const { db } = await import("./db");
      const { telegramWallets, asterCredentials: asterCredsTable } = await import("@shared/schema");
      const { eq, sql: sqlTag } = await import("drizzle-orm");

      const botRows = await db.select({ chatId: telegramWallets.chatId })
        .from(telegramWallets)
        .where(eq(telegramWallets.walletAddress, botWallet))
        .limit(1);

      if (botRows.length === 0) {
        return res.status(404).json({ error: "Bot wallet not found. Make sure you copied the correct address from the Telegram bot." });
      }
      const realChatId = botRows[0].chatId;

      let creds = await storage.getAsterCredentials(realChatId);
      if (!creds) {
        const credRows = await db.select({ chatId: asterCredsTable.chatId })
          .from(asterCredsTable)
          .where(sqlTag`parent_address LIKE ${"astercode:" + botWallet}`)
          .limit(1);
        if (credRows.length > 0) {
          creds = await storage.getAsterCredentials(credRows[0].chatId);
        }
      }

      if (!creds) {
        return res.status(404).json({ error: "No Aster trading credentials found for this bot wallet. Make sure you activated trading in the Telegram miniapp first." });
      }

      await db.update(telegramWallets)
        .set({ chatId: realChatId })
        .where(eq(telegramWallets.walletAddress, metamask));

      console.log(`[LinkBotWallet] Linked MetaMask ${metamask.substring(0, 10)} → realChatId=${realChatId} (botWallet=${botWallet.substring(0, 10)})`);

      res.json({ success: true, message: "Account linked! Your balance should now appear." });
    } catch (e: any) {
      console.error("[LinkBotWallet] Error:", e.message);
      res.status(500).json({ error: "Failed to link wallet. Please try again." });
    }
  });

  app.use("/api/miniapp", miniAppAuth);

  app.post("/api/miniapp/quick-activate", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });

      const existingCreds = await storage.getAsterCredentials(chatId);
      if (existingCreds && existingCreds.apiKey && existingCreds.apiSecret) {
        console.log(`[QuickActivate] Already activated for chatId=${chatId}`);
        return res.json({ success: true, alreadyActive: true, message: "Already activated!" });
      }

      const wallets = await storage.getTelegramWallets(chatId);
      const evmWallets = wallets.filter(w => w.walletAddress && w.walletAddress.startsWith("0x"));

      let botWalletAddr: string | null = null;
      let botWalletPk: string | null = null;

      for (const w of evmWallets) {
        const pk = await storage.getTelegramWalletPrivateKey(chatId, w.walletAddress.toLowerCase());
        if (pk) {
          botWalletAddr = w.walletAddress.toLowerCase();
          botWalletPk = pk;
          break;
        }
      }

      if (!botWalletAddr || !botWalletPk) {
        const { regenerateWalletForDeposit } = await import("./telegram-bot");
        const newW = await regenerateWalletForDeposit(parseInt(chatId));
        if (newW) {
          botWalletAddr = newW.address.toLowerCase();
          botWalletPk = newW.privateKey;
          console.log(`[QuickActivate] Created new bot wallet ${botWalletAddr.substring(0, 10)} for chatId=${chatId}`);
        }
      }

      if (!botWalletAddr || !botWalletPk) {
        return res.status(500).json({ error: "Could not create trading wallet. Please try again." });
      }

      console.log(`[QuickActivate] Onboarding wallet=${botWalletAddr.substring(0, 10)} chatId=${chatId}`);

      const { asterCodeOnboard, getDefaultAsterCodeConfig, createAsterCodeFuturesClient } = await import("./aster-code");
      const codeConfig = getDefaultAsterCodeConfig();
      const codeResult = await asterCodeOnboard(botWalletPk, codeConfig);

      if (!codeResult.success || !codeResult.signerAddress || !codeResult.signerPrivateKey) {
        console.log(`[QuickActivate] Onboard failed: ${codeResult.error} debug=${codeResult.debug}`);
        let userMsg = "Activation failed";
        const combinedError = `${codeResult.error || ""} ${codeResult.debug || ""}`.toLowerCase();
        if (combinedError.includes("region")) {
          userMsg = "Aster DEX is not available in your region. Please try again later or connect manually.";
        } else if (combinedError.includes("no aster user")) {
          userMsg = "Could not register on Aster DEX. Please try again in a moment.";
        } else if (codeResult.error) {
          userMsg = `Activation failed: ${codeResult.error}`;
        }
        return res.status(500).json({ error: userMsg });
      }

      await storage.saveAsterCredentials(chatId, codeResult.signerAddress, codeResult.signerPrivateKey, `astercode:${botWalletAddr}`);
      console.log(`[QuickActivate] Saved credentials chatId=${chatId} signer=${codeResult.signerAddress.substring(0, 10)} parent=${botWalletAddr.substring(0, 10)}`);

      let balanceInfo: any = null;
      try {
        const client = createAsterCodeFuturesClient(botWalletAddr, codeResult.signerAddress, codeResult.signerPrivateKey, codeConfig);
        balanceInfo = await client.balance();
        console.log(`[QuickActivate] Post-activation balance: ${JSON.stringify(balanceInfo).substring(0, 300)}`);
      } catch (balErr: any) {
        console.log(`[QuickActivate] Post-activation balance check: ${balErr.message}`);
      }

      res.json({
        success: true,
        tradingWallet: botWalletAddr,
        signerAddress: codeResult.signerAddress,
        message: "Trading activated! Deposit USDT to start trading.",
      });
    } catch (e: any) {
      console.error("[QuickActivate] Error:", e.message);
      res.status(500).json({ error: e.message || "Activation failed. Please try again." });
    }
  });

  app.post("/api/miniapp/import-wallet", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });
      const { privateKey } = req.body;
      if (!privateKey) return res.status(400).json({ error: "Missing private key" });

      const { Wallet } = await import("ethers");
      let wallet: InstanceType<typeof Wallet>;
      try {
        wallet = new Wallet(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
      } catch {
        return res.status(400).json({ error: "Invalid private key format" });
      }

      const addr = wallet.address.toLowerCase();
      const pk = wallet.privateKey;

      await storage.saveTelegramWallet(chatId, addr, pk);
      await storage.setActiveTelegramWallet(chatId, addr);
      console.log(`[MiniApp] Wallet imported: ${addr.substring(0, 10)}... for chatId=${chatId}`);

      let asterLinked = false;
      try {
        const { asterCodeOnboard, getDefaultAsterCodeConfig } = await import("./aster-code");
        const codeConfig = getDefaultAsterCodeConfig();
        const codeResult = await asterCodeOnboard(pk, codeConfig);
        if (codeResult.success && codeResult.signerAddress && codeResult.signerPrivateKey) {
          await storage.saveAsterCredentials(chatId, codeResult.signerAddress, codeResult.signerPrivateKey, `astercode:${addr}`);
          asterLinked = true;
          console.log(`[MiniApp] Import + Aster Code onboard success for chatId=${chatId} agent=${codeResult.signerAddress.substring(0, 10)}`);
        } else {
          console.log(`[MiniApp] Import onboard failed: ${codeResult.error || 'unknown'}`);
        }
      } catch (e: any) {
        console.log(`[MiniApp] Import onboard error: ${e.message}`);
      }

      res.json({ success: true, walletAddress: addr, asterLinked });
    } catch (e: any) { res.status(500).json({ error: "Internal server error" }); }
  });

  app.post("/api/miniapp/link-aster", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });
      const { apiWalletPrivateKey } = req.body;

      const wallets = await storage.getTelegramWallets(chatId);
      const evmWallets = wallets.filter(w => w.walletAddress && w.walletAddress.startsWith("0x"));
      const activeWallet = evmWallets.find(w => w.isActive) || evmWallets[0];
      const parentAddress = activeWallet?.walletAddress?.toLowerCase() || "";

      if (!parentAddress) {
        return res.status(400).json({ error: "No wallet found. Please connect your wallet first." });
      }

      if (apiWalletPrivateKey) {
        const { Wallet } = await import("ethers");
        let apiWallet: InstanceType<typeof Wallet>;
        try {
          apiWallet = new Wallet(apiWalletPrivateKey);
        } catch (e: any) {
          return res.status(400).json({ error: "Invalid private key format" });
        }

        const apiWalletAddress = apiWallet.address.toLowerCase();
        const userParentAddress = (req.body.parentAddress || "").trim().toLowerCase();
        const effectiveParent = (userParentAddress && userParentAddress.startsWith("0x") && userParentAddress.length === 42)
          ? userParentAddress : parentAddress;
        console.log(`[MiniApp] Manual link: signer=${apiWalletAddress}, parent=${effectiveParent}, chatId=${chatId}`);
        await storage.saveAsterCredentials(chatId, apiWalletAddress, apiWalletPrivateKey, effectiveParent);
        res.json({ success: true, apiWalletAddress, parentAddress: effectiveParent });
        return;
      }

      let pk: string | null = null;
      let onboardWalletAddr = parentAddress;

      pk = await storage.getTelegramWalletPrivateKey(chatId, parentAddress);

      if (!pk) {
        for (const w of evmWallets) {
          if (w.walletAddress === parentAddress) continue;
          const wAddr = w.walletAddress.toLowerCase();
          const wPk = await storage.getTelegramWalletPrivateKey(chatId, wAddr);
          if (wPk) {
            pk = wPk;
            onboardWalletAddr = wAddr;
            console.log(`[MiniApp] Using bot wallet ${wAddr.substring(0, 10)} (active MetaMask has no key)`);
            break;
          }
        }
      }

      if (!pk) {
        return res.status(400).json({ error: "No accessible wallet key. Use the web activation flow with MetaMask." });
      }

      console.log(`[MiniApp] Auto-connecting Aster for chatId=${chatId} onboardWallet=${onboardWalletAddr.substring(0, 10)}`);

      console.log(`[MiniApp] Trying Aster Code onboard for chatId=${chatId}`);
      try {
        const { asterCodeOnboard, getDefaultAsterCodeConfig, createAsterCodeFuturesClient } = await import("./aster-code");
        const codeConfig = getDefaultAsterCodeConfig();
        const codeResult = await asterCodeOnboard(pk, codeConfig);
        console.log(`[MiniApp] Aster Code onboard result: success=${codeResult.success} agent=${codeResult.agentApproved} builder=${codeResult.builderApproved} ${codeResult.error || ''}`);

        if (codeResult.success && codeResult.signerAddress && codeResult.signerPrivateKey) {
          await storage.saveAsterCredentials(chatId, codeResult.signerAddress, codeResult.signerPrivateKey, `astercode:${onboardWalletAddr}`);
          res.json({ success: true, apiWalletAddress: codeResult.signerAddress, parentAddress: onboardWalletAddr });
          return;
        }
      } catch (codeErr: any) {
        console.log(`[MiniApp] Aster Code onboard failed: ${codeErr.message?.substring(0, 200)}`);
      }

      res.json({ success: false, error: "Activation failed. Use MetaMask signing flow on the web terminal." });
    } catch (e: any) { res.status(500).json({ error: "Internal server error" }); }
  });

  app.get("/api/miniapp/account", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });

      let client: any = null;
      let asterApiWalletAddr = "";

      const connectedWalletAddr = (req.headers["x-wallet-address"] as string || "").toLowerCase().trim();

      try {
        let creds = await storage.getAsterCredentials(chatId);

        if (!creds && connectedWalletAddr) {
          try {
            const { db: dbConn } = await import("./db");
            const { asterCredentials: asterCredsTable } = await import("@shared/schema");
            const { eq } = await import("drizzle-orm");
            const rows = await dbConn.select({ chatId: asterCredsTable.chatId }).from(asterCredsTable).where(eq(asterCredsTable.parentAddress, connectedWalletAddr)).limit(1);
            if (rows.length > 0) {
              creds = await storage.getAsterCredentials(rows[0].chatId);
              if (creds) console.log(`[MiniApp] Found Aster creds via parentAddress fallback: wallet=${connectedWalletAddr.substring(0,10)} origChatId=${rows[0].chatId}`);
            }
          } catch (e: any) {
            console.log(`[MiniApp] parentAddress fallback lookup failed: ${e.message?.substring(0, 100)}`);
          }
        }

        if (!creds && connectedWalletAddr) {
          try {
            const { db: dbConn } = await import("./db");
            const { asterCredentials: asterCredsTable } = await import("@shared/schema");
            const { sql: sqlTag } = await import("drizzle-orm");
            const rows = await dbConn.select({ chatId: asterCredsTable.chatId }).from(asterCredsTable).where(sqlTag`parent_address LIKE ${"astercode:" + connectedWalletAddr}`).limit(1);
            if (rows.length > 0) {
              creds = await storage.getAsterCredentials(rows[0].chatId);
              if (creds) console.log(`[MiniApp] Found Aster creds via astercode: prefix fallback: wallet=${connectedWalletAddr.substring(0,10)}`);
            }
          } catch (e: any) {
            console.log(`[MiniApp] astercode fallback lookup failed: ${e.message?.substring(0, 100)}`);
          }
        }

        if (creds && creds.apiKey && creds.apiSecret && creds.apiKey !== "V3_DIRECT") {
          const wallets = await storage.getTelegramWallets(creds.chatId || chatId);
          const evmWallets = wallets.filter(w => w.walletAddress && w.walletAddress.startsWith("0x"));
          const activeWallet = evmWallets.find(w => w.isActive) || evmWallets[0];
          const botWalletAddr = activeWallet?.walletAddress?.toLowerCase() || "";
          const parentAddress = creds.parentAddress || botWalletAddr;

          const isV3ApiWallet = creds.apiKey.startsWith("0x") && creds.apiKey.length === 42;

          if (isV3ApiWallet && parentAddress) {
            const isAsterCode = parentAddress.startsWith("astercode:");
            const realParent = isAsterCode ? parentAddress.replace("astercode:", "") : parentAddress;

            if (isAsterCode) {
              const { createAsterCodeFuturesClient, getDefaultAsterCodeConfig } = await import("./aster-code");
              const codeConfig = getDefaultAsterCodeConfig();
              let effectiveUser = realParent;
              const walletMismatch = connectedWalletAddr && connectedWalletAddr !== realParent.toLowerCase();
              if (walletMismatch) {
                console.log(`[MiniApp] Connected wallet ${connectedWalletAddr.substring(0,10)} differs from stored parent ${realParent.substring(0,10)} — signer may not be authorized for this wallet, will need re-activation`);
                return res.json({ connected: false, needsReactivation: true, asterApiWallet: null, bscWalletAddress: connectedWalletAddr, bscBalance: 0, bnbBalance: 0, message: "Your wallet changed. Please re-activate to link your current wallet." });
              }
              const codeFutures = createAsterCodeFuturesClient(effectiveUser, creds.apiKey, creds.apiSecret, codeConfig);
              client = { futures: codeFutures, spot: null, walletAddress: effectiveUser };
              asterApiWalletAddr = creds.apiKey;
              console.log(`[MiniApp] Aster Code client: user=${effectiveUser.substring(0,10)}, signer=${creds.apiKey.substring(0,10)}`);
            } else {
              const { createAsterV3FuturesClient } = await import("./aster-client");
              const v3Futures = createAsterV3FuturesClient({
                user: parentAddress,
                signer: creds.apiKey,
                signerPrivateKey: creds.apiSecret,
                builder: "0x06d6227e499f10fe0a9f8c8b80b3c98f964474a4",
                feeRate: 0.001,
              });
              client = { futures: v3Futures, spot: null, walletAddress: parentAddress };
              asterApiWalletAddr = creds.apiKey;
              console.log(`[MiniApp] Aster V3 client: user=${parentAddress.substring(0,10)}, signer=set`);
            }
          } else {
            const { createAsterFuturesClient } = await import("./aster-client");
            const hmacClient = createAsterFuturesClient({ apiKey: creds.apiKey, apiSecret: creds.apiSecret });
            client = { futures: hmacClient, spot: null, walletAddress: parentAddress };
            asterApiWalletAddr = "auto";
            console.log(`[MiniApp] Aster HMAC client for chatId=${chatId} (auto-onboarded)`);
          }
        }
      } catch (e: any) {
        console.log(`[MiniApp] Aster credentials lookup failed: ${e.message}`);
      }

      if (!client) {
        const wallets = await storage.getTelegramWallets(chatId);
        const evmWallets = wallets.filter(w => w.walletAddress && w.walletAddress.startsWith("0x"));
        let activeWallet = evmWallets.find(w => w.isActive) || evmWallets[0];
        let bscAddr = activeWallet?.walletAddress?.toLowerCase() || "";

        if (bscAddr && evmWallets.length > 1) {
          const hasPk = await storage.getTelegramWalletPrivateKey(chatId, bscAddr);
          if (!hasPk) {
            const fallback = evmWallets.find(w => w.walletAddress?.toLowerCase() !== bscAddr);
            if (fallback) {
              const fbPk = await storage.getTelegramWalletPrivateKey(chatId, fallback.walletAddress.toLowerCase());
              if (fbPk) {
                bscAddr = fallback.walletAddress.toLowerCase();
              }
            }
          }
        }
        if (!bscAddr && wallets.length > 0) {
          try {
            const { regenerateWalletForDeposit } = await import("./telegram-bot");
            const newW = await regenerateWalletForDeposit(parseInt(chatId));
            if (newW) { bscAddr = newW.address.toLowerCase(); console.log(`[MiniApp] Auto-created EVM wallet ${bscAddr.substring(0,10)} for chatId=${chatId} (had sol: only)`); }
          } catch (e: any) { console.log(`[MiniApp] Auto-create EVM wallet failed: ${e.message?.substring(0,80)}`); }
        }
        console.log(`[MiniApp] No Aster client for chatId=${chatId}, wallet=${bscAddr ? bscAddr.substring(0,10) : 'none'}, total=${wallets.length}, evm=${evmWallets.length}`);

        let bscBal = 0;
        let bnbBal = 0;
        if (bscAddr) {
          try {
            const ethers = await import("ethers");
            const provider = new ethers.JsonRpcProvider("https://bsc-dataseed1.binance.org");
            const usdt = new ethers.Contract(
              "0x55d398326f99059fF775485246999027B3197955",
              ["function balanceOf(address) view returns (uint256)"],
              provider
            );
            const [bal, bnb] = await Promise.all([
              usdt.balanceOf(bscAddr),
              provider.getBalance(bscAddr),
            ]);
            bscBal = parseFloat(ethers.formatUnits(bal, 18));
            bnbBal = parseFloat(ethers.formatEther(bnb));
            console.log(`[MiniApp] BSC balance (no client) ${bscAddr.substring(0,10)}: $${bscBal} USDT, ${bnbBal} BNB`);
          } catch (e: any) {
            console.log(`[MiniApp] BSC balance fetch error (no client): ${e.message?.substring(0, 100)}`);
          }
        }

        return res.json({ connected: false, asterApiWallet: null, bscWalletAddress: bscAddr || null, needsImport: !bscAddr, bscBalance: bscBal, bnbBalance: bnbBal });
      }

      const futuresClient = client.futures || client;

      console.log(`[MiniApp] Fetching Aster data for chatId=${chatId}...`);
      const [balances, accountData, positions, income] = await Promise.all([
        futuresClient.balance().catch((e: any) => { console.log(`[MiniApp] balance() error: ${e.message?.substring(0, 200)}`); return []; }),
        futuresClient.account().catch((e: any) => { console.log(`[MiniApp] account() error: ${e.message?.substring(0, 200)}`); return null; }),
        futuresClient.positions().catch((e: any) => { console.log(`[MiniApp] positions() error: ${e.message?.substring(0, 200)}`); return []; }),
        futuresClient.income("REALIZED_PNL", 20).catch((e: any) => { console.log(`[MiniApp] income() error: ${e.message?.substring(0, 200)}`); return []; }),
      ]);

      console.log(`[MiniApp] balance raw type=${typeof balances} isArr=${Array.isArray(balances)} len=${Array.isArray(balances)?balances.length:'n/a'}: ${JSON.stringify(balances).substring(0, 500)}`);
      console.log(`[MiniApp] account raw type=${typeof accountData}: ${JSON.stringify(accountData).substring(0, 500)}`);

      let availBal = 0;
      let walletBal = 0;

      function extractFromObj(obj: any): boolean {
        if (!obj || typeof obj !== "object") return false;
        const keys = Object.keys(obj);
        for (const k of keys) {
          const v = obj[k];
          if (typeof v === "string" || typeof v === "number") {
            const num = parseFloat(String(v));
            if (!isNaN(num) && num > 0) {
              const kl = k.toLowerCase();
              if (kl.includes("availablebalance") || kl === "available" || kl.includes("maxwithdraw")) {
                availBal = Math.max(availBal, num);
              } else if (kl === "balance" || kl === "walletbalance" || kl === "crosswalletbalance" || kl === "totalwalletbalance") {
                walletBal = Math.max(walletBal, num);
              }
            }
          }
        }
        return availBal > 0 || walletBal > 0;
      }

      if (Array.isArray(balances) && balances.length > 0) {
        const usdtBal = balances.find((b: any) => {
          const a = (b.asset || "").toUpperCase();
          return a === "USDT" || a === "USD";
        });
        if (usdtBal) extractFromObj(usdtBal);
      }

      if (availBal === 0 && walletBal === 0 && balances && typeof balances === "object" && !Array.isArray(balances)) {
        extractFromObj(balances);
      }

      if (accountData) {
        const acctAvail = parseFloat(accountData.availableBalance || "0");
        const acctWallet = parseFloat(accountData.totalWalletBalance || accountData.totalCrossWalletBalance || "0");
        if (acctAvail > 0 && availBal === 0) availBal = acctAvail;
        if (acctWallet > 0 && walletBal === 0) walletBal = acctWallet;
        if (availBal === 0 && walletBal === 0) {
          if (Array.isArray(accountData.assets)) {
            const usdtAsset = accountData.assets.find((a: any) => (a.asset || "").toUpperCase() === "USDT");
            if (usdtAsset) extractFromObj(usdtAsset);
          }
          if (availBal === 0 && walletBal === 0) {
            extractFromObj(accountData);
          }
        }
      }

      console.log(`[MiniApp] parsed: availBal=${availBal}, walletBal=${walletBal} for chatId=${chatId}`);

      const openPositions = Array.isArray(positions)
        ? positions.filter((p: any) => parseFloat(p.positionAmt || "0") !== 0)
        : [];

      let totalUpnl = 0;
      const positionList = openPositions.map((p: any) => {
        const amt = parseFloat(p.positionAmt || "0");
        const upnl = parseFloat(p.unRealizedProfit || "0");
        totalUpnl += upnl;
        const entryPrice = parseFloat(p.entryPrice || "0");
        const markPrice = parseFloat(p.markPrice || "0");
        const absAmt = Math.abs(amt);
        const lev = parseFloat(p.leverage || "1");
        const rawNotional = parseFloat(p.notional || "0");
        const notional = rawNotional || (absAmt * markPrice);
        const margin = lev > 0 ? Math.abs(notional) / lev : 0;
        const side = p.positionSide === "LONG" || p.positionSide === "SHORT"
          ? p.positionSide
          : rawNotional !== 0
            ? (rawNotional > 0 ? "LONG" : "SHORT")
            : (amt > 0 ? "LONG" : "SHORT");
        const roe = entryPrice > 0 ? (((markPrice - entryPrice) / entryPrice) * (side === "LONG" ? 1 : -1) * lev * 100) : 0;
        return {
          symbol: p.symbol,
          side,
          size: absAmt,
          entryPrice,
          markPrice,
          leverage: p.leverage || "1",
          unrealizedPnl: upnl,
          notional,
          margin: parseFloat(margin.toFixed(2)),
          roe: parseFloat(roe.toFixed(2)),
          liquidationPrice: parseFloat(p.liquidationPrice || "0"),
          marginType: p.marginType || "cross",
          initialMargin: parseFloat(p.initialMargin || "0"),
          maintMargin: parseFloat(p.maintMargin || "0"),
          updateTime: parseInt(p.updateTime || "0"),
        };
      });

      const totalPositionMargin = positionList.reduce((sum: number, p: any) => sum + (p.margin || 0), 0);

      let realizedPnl = 0;
      let wins = 0;
      let losses = 0;
      const incomeList: any[] = [];
      if (Array.isArray(income)) {
        for (const inc of income) {
          const amt = parseFloat(inc.income || "0");
          realizedPnl += amt;
          if (amt > 0) wins++;
          else if (amt < 0) losses++;
          incomeList.push({
            symbol: inc.symbol,
            amount: amt,
            type: inc.incomeType,
            time: inc.time,
          });
        }
      }

      if (availBal === 0 && walletBal === 0) {
        try {
          const walletRows = await storage.getTelegramWallets(chatId);
          const botWalletAddr = getUserWalletAddress(parseInt(chatId)) || (walletRows.length > 0 ? walletRows[0].walletAddress : null);

          if (botWalletAddr) {
            const pk = await resolvePrivateKey(parseInt(chatId), botWalletAddr);
            let botFc: any = null;

            if (pk) {
              const { createAsterV3FuturesClient } = await import("./aster-client");
              botFc = createAsterV3FuturesClient({ user: botWalletAddr, signer: botWalletAddr, signerPrivateKey: pk, builder: "0x06d6227e499f10fe0a9f8c8b80b3c98f964474a4", feeRate: 0.001 });
              console.log(`[MiniApp] Trying bot wallet ${botWalletAddr.substring(0, 10)} with own key`);
            } else {
              const asterPk = process.env.ASTER_PRIVATE_KEY;
              const asterSigner = process.env.ASTER_SIGNER_ADDRESS;
              if (asterPk) {
                const { createAsterV3FuturesClient } = await import("./aster-client");
                botFc = createAsterV3FuturesClient({ user: botWalletAddr, signer: asterSigner || botWalletAddr, signerPrivateKey: asterPk, builder: "0x06d6227e499f10fe0a9f8c8b80b3c98f964474a4", feeRate: 0.001 });
                console.log(`[MiniApp] Trying bot wallet ${botWalletAddr.substring(0, 10)} with ASTER_PRIVATE_KEY signer`);
              }
            }

            if (botFc) {
              const [botBal, botAcct] = await Promise.all([
                botFc.balance().catch((e: any) => { console.log(`[MiniApp] bot wallet balance err: ${e.message?.substring(0, 150)}`); return []; }),
                botFc.account().catch((e: any) => { console.log(`[MiniApp] bot wallet account err: ${e.message?.substring(0, 150)}`); return null; }),
              ]);
              console.log(`[MiniApp] Bot wallet balance raw: ${JSON.stringify(botBal).substring(0, 500)}`);
              console.log(`[MiniApp] Bot wallet account raw: ${JSON.stringify(botAcct).substring(0, 500)}`);
              if (Array.isArray(botBal) && botBal.length > 0) {
                const usdtBal = botBal.find((b: any) => (b.asset || "").toUpperCase() === "USDT" || (b.asset || "").toUpperCase() === "USD");
                if (usdtBal) extractFromObj(usdtBal);
              }
              if (availBal === 0 && walletBal === 0 && botBal && typeof botBal === "object" && !Array.isArray(botBal)) {
                extractFromObj(botBal);
              }
              if (availBal === 0 && walletBal === 0 && botAcct) {
                if (Array.isArray(botAcct.assets)) {
                  const usdtAsset = botAcct.assets.find((a: any) => (a.asset || "").toUpperCase() === "USDT");
                  if (usdtAsset) extractFromObj(usdtAsset);
                }
                if (availBal === 0 && walletBal === 0) extractFromObj(botAcct);
              }
              if (availBal > 0 || walletBal > 0) {
                console.log(`[MiniApp] Found balance via bot wallet: avail=$${availBal}, wallet=$${walletBal}`);
              }
            }
          }
        } catch (botErr: any) {
          console.log(`[MiniApp] Bot wallet balance check error: ${botErr.message?.substring(0, 150)}`);
        }
      }

      if (availBal === 0 && walletBal > 0) availBal = walletBal;
      if (walletBal === 0 && availBal > 0) walletBal = availBal;

      let spotBalance = 0;
      try {
        if (futuresClient.spotBalance) {
          const spotBalances = await futuresClient.spotBalance();
          if (Array.isArray(spotBalances)) {
            const usdtSpot = spotBalances.find((b: any) => (b.asset || "").toUpperCase() === "USDT");
            if (usdtSpot) spotBalance = parseFloat(usdtSpot.free || usdtSpot.balance || "0");
          }
          console.log(`[MiniApp] Spot balance (via futuresClient.spotBalance): $${spotBalance}`);
        }
        if (spotBalance <= 0) {
          const spotClient = client.spot;
          if (spotClient && spotClient.account) {
            const spotAcct = await spotClient.account();
            if (spotAcct && Array.isArray(spotAcct.balances)) {
              const usdtSpot = spotAcct.balances.find((b: any) => (b.asset || "").toUpperCase() === "USDT");
              if (usdtSpot) spotBalance = parseFloat(usdtSpot.free || "0");
            }
            console.log(`[MiniApp] Spot balance (via spot client): $${spotBalance}`);
          }
        }
      } catch (spotErr: any) {
        console.log(`[MiniApp] Spot balance error: ${spotErr.message?.substring(0, 100)}`);
      }

      let bscBalance = 0;
      let bnbBalance = 0;
      let walletAddr: string | null = null;
      try {
        walletAddr = getUserWalletAddress(parseInt(chatId));
        if (walletAddr && !walletAddr.startsWith("0x")) walletAddr = null;
        console.log(`[MiniApp] in-memory wallet for chatId=${chatId}: ${walletAddr}`);
        if (!walletAddr) {
          const walletRows = await storage.getTelegramWallets(chatId);
          const evmRow = walletRows.find(w => w.walletAddress && w.walletAddress.startsWith("0x"));
          walletAddr = evmRow?.walletAddress || null;
          console.log(`[MiniApp] DB wallet fallback chatId=${chatId}, found=${walletRows.length}, evm=${walletAddr ? 'yes' : 'no'}`);
          if (!walletAddr && walletRows.length > 0) {
            try {
              const { regenerateWalletForDeposit } = await import("./telegram-bot");
              const newW = await regenerateWalletForDeposit(parseInt(chatId));
              if (newW) { walletAddr = newW.address.toLowerCase(); console.log(`[MiniApp] Auto-created EVM wallet ${walletAddr.substring(0,10)} for connected user chatId=${chatId}`); }
            } catch {}
          }
        }
        if (walletAddr) {
          const ethers = await import("ethers");
          const provider = new ethers.JsonRpcProvider("https://bsc-dataseed1.binance.org");
          const usdt = new ethers.Contract(
            "0x55d398326f99059fF775485246999027B3197955",
            ["function balanceOf(address) view returns (uint256)"],
            provider
          );
          const [bal, bnbBal] = await Promise.all([
            usdt.balanceOf(walletAddr),
            provider.getBalance(walletAddr),
          ]);
          bscBalance = parseFloat(ethers.formatUnits(bal, 18));
          bnbBalance = parseFloat(ethers.formatEther(bnbBal));
          console.log(`[MiniApp] BSC balance for ${walletAddr}: $${bscBalance} USDT, ${bnbBalance} BNB`);
        }
      } catch (bscErr: any) {
        console.error(`[MiniApp] BSC balance fetch error:`, bscErr.message);
      }

      const marginBalance = walletBal + totalUpnl;

      res.json({
        connected: true,
        walletBalance: walletBal,
        availableMargin: availBal,
        marginBalance,
        spotBalance,
        bscBalance,
        bnbBalance,
        bscWalletAddress: walletAddr,
        asterApiWallet: asterApiWalletAddr || null,
        unrealizedPnl: totalUpnl,
        realizedPnl,
        wins,
        losses,
        positions: positionList,
        positionMargin: totalPositionMargin,
        recentIncome: incomeList,
      });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/miniapp/deposit", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      const { amount } = req.body;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });
      if (!amount || amount < 0.5) return res.status(400).json({ error: "Minimum deposit is $0.50" });

      console.log(`[MiniApp] deposit request chatId=${chatId}, amount=${amount}`);

      let activeWallet = getUserWalletAddress(parseInt(chatId));
      if (activeWallet && !activeWallet.startsWith("0x")) activeWallet = null;
      const walletRows = await storage.getTelegramWallets(chatId);
      const evmRow = walletRows.find(w => w.walletAddress && w.walletAddress.startsWith("0x"));
      const walletAddr = activeWallet || evmRow?.walletAddress || null;
      if (!walletAddr) return res.status(400).json({ error: "No wallet linked to this chat. Use /start in the bot first." });

      console.log(`[MiniApp] deposit: activeWallet=${activeWallet}, evmDb=${evmRow?.walletAddress}, using=${walletAddr}`);

      let rawPk = await resolvePrivateKey(parseInt(chatId), walletAddr);
      if (!rawPk) {
        console.log(`[MiniApp] deposit: key unavailable for ${walletAddr?.substring(0, 8)}, generating new wallet with working key...`);
        const { regenerateWalletForDeposit } = await import("./telegram-bot");
        const newWallet = await regenerateWalletForDeposit(parseInt(chatId));
        if (newWallet) {
          console.log(`[MiniApp] deposit: new wallet ${newWallet.address.substring(0, 10)} created, key available`);
          return res.json({
            success: false,
            needsNewWallet: true,
            newWalletAddress: newWallet.address,
            oldWalletAddress: walletAddr,
            error: `Wallet key recovered. New wallet: ${newWallet.address}\n\nSend your USDT from your old wallet (${walletAddr}) to this new address, then try deposit again.`,
          });
        }
        return res.status(400).json({ error: "Wallet key unavailable. Send USDT manually to pool wallet: 0xaac5f84303ee5cdbd19c265cee295cd5a36a26ee" });
      }

      const ethers = await import("ethers");
      const pkWallet = new ethers.Wallet(rawPk);
      const derivedAddr = pkWallet.address.toLowerCase();
      const storedAddr = walletAddr.toLowerCase();
      console.log(`[MiniApp] deposit: stored wallet=${storedAddr}, key derives to=${derivedAddr}`);

      if (derivedAddr !== storedAddr) {
        console.log(`[MiniApp] KEY MISMATCH: key belongs to ${derivedAddr}, not ${storedAddr}. Cannot auto-deposit.`);
        return res.json({
          success: false,
          error: `Auto-deposit unavailable — wallet key mismatch. Please deposit manually:\n\n1. Open your external wallet app\n2. Send $${amount} USDT (BEP-20) on BSC to:\n0xaac5f84303ee5cdbd19c265cee295cd5a36a26ee\n3. Paste the TX hash below to verify`,
        });
      }

      const { asterV3Deposit } = await import("./aster-client");

      let depositRecipient: string | undefined;
      try {
        const creds = await storage.getAsterCredentials(chatId);
        if (creds?.parentAddress) {
          const parentAddr = creds.parentAddress.startsWith("astercode:")
            ? creds.parentAddress.replace("astercode:", "")
            : creds.parentAddress;
          if (parentAddr.toLowerCase() !== derivedAddr) {
            depositRecipient = parentAddr;
            console.log(`[MiniApp] deposit: routing to Aster parent account ${parentAddr.substring(0, 10)} via depositTo`);
          }
        }
      } catch {}

      if (!depositRecipient) {
        const ownerAddr = process.env.ASTER_USER_ADDRESS || "";
        if (ownerAddr && ownerAddr.toLowerCase() !== derivedAddr) {
          depositRecipient = ownerAddr;
        }
      }

      console.log(`[MiniApp] deposit: recipient=${depositRecipient || "self (caller)"}`);
      const result = await asterV3Deposit(rawPk, amount, 0, depositRecipient);

      if (!result.success) return res.json({ success: false, error: result.error });

      console.log(`[MiniApp] deposit TX success: ${result.txHash}`);

      let spotTransferred = false;
      let futuresTransferred = false;
      try {
        const client = await getAsterClient(parseInt(chatId));
        if (client) {
          const fc = client.futures || client;
          console.log(`[MiniApp] Waiting 8s for vault credit...`);
          await new Promise(r => setTimeout(r, 8000));

          if (fc.spotToFutures) {
            try {
              await fc.spotToFutures("USDT", amount.toString());
              futuresTransferred = true;
              console.log(`[MiniApp] Spot→Futures transfer done: $${amount}`);
            } catch (stfErr: any) {
              console.log(`[MiniApp] Spot→Futures failed: ${stfErr.message?.substring(0, 100)}`);
            }
          }
        }
      } catch (postErr: any) {
        console.log(`[MiniApp] Post-deposit error: ${postErr.message?.substring(0, 100)}`);
      }

      res.json({
        success: true,
        txHash: result.txHash,
        spotTransferred: true,
        futuresTransferred,
        message: futuresTransferred
          ? `$${amount} deposited and moved to Futures — ready to trade!`
          : `$${amount} deposited to Aster Spot. Use the bot to transfer Spot→Futures when ready.`,
      });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/miniapp/withdraw", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });

      const { amount, toAddress } = req.body;
      if (!amount || amount < 1) return res.status(400).json({ error: "Minimum withdrawal is $1" });

      const activeWallet = getUserWalletAddress(parseInt(chatId));
      const withdrawTo = toAddress || activeWallet;
      if (!withdrawTo) return res.status(400).json({ error: "No withdrawal address. Provide a BSC address." });

      console.log(`[MiniApp] withdraw request: chatId=${chatId}, amount=${amount}, to=${withdrawTo}`);

      const client = await getAsterClient(parseInt(chatId));
      if (!client) return res.status(400).json({ error: "Aster not connected" });

      const fc = client.futures || client;

      try {
        console.log(`[MiniApp] Futures→Spot transfer: $${amount}`);
        await fc.futuresToSpot("USDT", amount.toString());
        console.log(`[MiniApp] Futures→Spot done`);
      } catch (ftsErr: any) {
        console.log(`[MiniApp] Futures→Spot failed: ${ftsErr.message?.substring(0, 150)}`);
        return res.json({ success: false, error: "Failed to move funds from Futures to Spot. Try again later." });
      }

      await new Promise(r => setTimeout(r, 2000));

      try {
        console.log(`[MiniApp] On-chain withdraw: $${amount} to ${withdrawTo}`);
        const result = await fc.withdrawOnChain("USDT", amount.toString(), withdrawTo, "BSC");
        console.log(`[MiniApp] Withdraw success:`, JSON.stringify(result).substring(0, 200));
        res.json({
          success: true,
          message: `Withdrawal of $${amount} USDT initiated to ${withdrawTo.substring(0, 8)}...${withdrawTo.slice(-4)}. Allow 5-10 minutes for on-chain confirmation.`,
          withdrawId: result?.id || result?.withdrawId || null,
        });
      } catch (wErr: any) {
        console.log(`[MiniApp] Withdraw failed: ${wErr.message?.substring(0, 200)}`);
        res.json({ success: false, error: "Withdrawal failed. Funds moved back to Spot — try again or withdraw manually on asterdex.com." });
      }
    } catch (e: any) {
      console.log(`[MiniApp] withdraw error: ${e.message?.substring(0, 200)}`);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/miniapp/spot-to-futures", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });

      const client = await getAsterClient(parseInt(chatId));
      if (!client) return res.status(400).json({ error: "Aster not connected" });

      const fc = client.futures || client;

      let spotBal = 0;
      try {
        if (fc.spotBalance) {
          const spotBalances = await fc.spotBalance();
          if (Array.isArray(spotBalances)) {
            const usdt = spotBalances.find((b: any) => (b.asset || "").toUpperCase() === "USDT");
            if (usdt) spotBal = parseFloat(usdt.free || usdt.balance || "0");
          }
        }
        if (spotBal <= 0) {
          const balances = await fc.balance();
          if (Array.isArray(balances)) {
            const usdt = balances.find((b: any) => (b.asset || "").toUpperCase() === "USDT");
            if (usdt) spotBal = parseFloat(usdt.balance || usdt.walletBalance || "0");
          }
        }
      } catch {}

      let amount = req.body.amount || spotBal;

      if ((!amount || amount <= 0)) {
        try {
          const walletAddr = getUserWalletAddress(parseInt(chatId));
          if (walletAddr) {
            const pk = await resolvePrivateKey(parseInt(chatId), walletAddr);
            if (pk) {
              const { createAsterV3FuturesClient } = await import("./aster-client");
              const botFc = createAsterV3FuturesClient({
                user: walletAddr,
                signer: walletAddr,
                signerPrivateKey: pk,
                builder: "0x06d6227e499f10fe0a9f8c8b80b3c98f964474a4",
                feeRate: 0.001,
              });

              let botSpot = 0;
              if (botFc.spotBalance) {
                const sbs = await botFc.spotBalance();
                if (Array.isArray(sbs)) {
                  const u = sbs.find((b: any) => (b.asset || "").toUpperCase() === "USDT");
                  if (u) botSpot = parseFloat(u.free || u.balance || "0");
                }
              }

              if (botSpot > 0) {
                console.log(`[MiniApp] Recovery: Found $${botSpot} in bot wallet ${walletAddr.substring(0, 10)} Aster spot (deposited to wrong account)`);

                if (botFc.spotToFutures) {
                  try {
                    await botFc.spotToFutures("USDT", botSpot.toString());
                    console.log(`[MiniApp] Recovery: Transferred $${botSpot} spot→futures on bot wallet directly`);
                    return res.json({ success: true, amount: botSpot, recovered: true, message: `$${botSpot} recovered from misrouted deposit and moved to Futures — ready to trade!` });
                  } catch (stfErr: any) {
                    console.log(`[MiniApp] Recovery spot→futures on bot wallet failed: ${stfErr.message?.substring(0, 150)}`);
                  }
                }

                const creds = await storage.getAsterCredentials(chatId);
                if (creds?.parentAddress) {
                  const parentAddr = creds.parentAddress.startsWith("astercode:")
                    ? creds.parentAddress.replace("astercode:", "")
                    : creds.parentAddress;

                  if (botFc.withdrawOnChain) {
                    try {
                      await botFc.withdrawOnChain("USDT", botSpot.toString(), walletAddr);
                      console.log(`[MiniApp] Recovery: Withdrew $${botSpot} from bot Aster spot to on-chain`);
                      await new Promise(r => setTimeout(r, 8000));

                      const ethers = await import("ethers");
                      const provider = new ethers.JsonRpcProvider("https://bsc-dataseed1.binance.org");
                      const bnbBal = await provider.getBalance(walletAddr);
                      if (bnbBal >= ethers.parseEther("0.0003")) {
                        const { asterV3Deposit } = await import("./aster-client");
                        const redeposit = await asterV3Deposit(pk, botSpot, 0, parentAddr);
                        if (redeposit.success) {
                          console.log(`[MiniApp] Recovery: Re-deposited $${botSpot} to parent ${parentAddr.substring(0, 10)}`);
                          await new Promise(r => setTimeout(r, 8000));
                          amount = botSpot;
                        }
                      }
                    } catch (recErr: any) {
                      console.log(`[MiniApp] Recovery withdraw/redeposit failed: ${recErr.message?.substring(0, 150)}`);
                    }
                  }
                }
              }
            }
          }
        } catch (recoveryErr: any) {
          console.log(`[MiniApp] Recovery check error: ${recoveryErr.message?.substring(0, 150)}`);
        }
      }

      if (!amount || amount <= 0) return res.json({ success: false, error: "No Spot balance available to transfer. Deposit may still be processing — wait 2-3 minutes and try again." });

      console.log(`[MiniApp] Spot→Futures transfer: $${amount}`);

      if (!fc.spotToFutures) return res.json({ success: false, error: "Spot→Futures transfer not available on this API" });

      try {
        await fc.spotToFutures("USDT", amount.toString());
        console.log(`[MiniApp] Spot→Futures done: $${amount}`);
        res.json({ success: true, amount, message: `$${amount} transferred to Futures — ready to trade!` });
      } catch (stfErr: any) {
        console.log(`[MiniApp] Spot→Futures error: ${stfErr.message?.substring(0, 150)}`);
        res.json({ success: false, error: `Transfer failed: ${stfErr.message?.substring(0, 100)}. Try again in a few minutes.` });
      }
    } catch (e: any) {
      console.log(`[MiniApp] Spot→Futures error: ${e.message?.substring(0, 150)}`);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/miniapp/agent", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });

      const { getAgentConfig, getAgentState, loadAgentConfigFromDb } = await import("./autonomous-agent");
      const config = await loadAgentConfigFromDb(chatId);
      const state = getAgentState(chatId);

      const localTrades = await storage.getAsterLocalTrades(chatId);
      let totalPnl = 0;
      let winCount = 0;
      let lossCount = 0;
      const openTrades = localTrades.filter((t: any) => !t.reduceOnly);
      const closeTrades = localTrades.filter((t: any) => t.reduceOnly);
      for (const ct of closeTrades) {
        const matchOpen = openTrades.find((ot: any) => ot.symbol === ct.symbol && !ot.reduceOnly && ot.orderId !== ct.orderId);
        if (matchOpen) {
          const entryPrice = matchOpen.avgPrice || matchOpen.price || 0;
          const exitPrice = ct.avgPrice || ct.price || 0;
          const qty = ct.executedQty || ct.quantity || 0;
          const pnl = matchOpen.side === "BUY"
            ? (exitPrice - entryPrice) * qty
            : (entryPrice - exitPrice) * qty;
          totalPnl += pnl;
          if (pnl >= 0) winCount++;
          else lossCount++;
        }
      }

      const openPositions: string[] = [];
      if (state?.openPositions) {
        for (const [sym, info] of state.openPositions) {
          const side = typeof info === 'string' ? info : info.side;
          openPositions.push(`${side} ${sym}`);
        }
      }

      const reasoningLog = (state as any)?.reasoningLog || [];
      const dailyPnl = (state as any)?.dailyPnl || 0;
      const consecutiveLosses = (state as any)?.consecutiveLosses || 0;
      const circuitBreakerUntil = (state as any)?.circuitBreakerUntil || 0;
      const lastReasoning = (state as any)?.lastReasoning || "";

      let learning: any = null;
      try {
        const { getLearningInsights } = await import("./market-intelligence");
        learning = getLearningInsights();
      } catch {}

      const positionDetails: any[] = [];
      if (state?.openPositions) {
        for (const [sym, info] of state.openPositions) {
          const i = info as any;
          positionDetails.push({
            symbol: sym,
            side: i.side,
            entryPrice: i.entryPrice,
            stopLoss: i.stopLossPct,
            takeProfit: i.takeProfitPct,
            leverage: i.leverage,
            reasoning: i.reasoning,
            openedAt: i.openedAt,
          });
        }
      }

      res.json({
        running: state?.running || false,
        config: {
          name: config?.name ?? "My Agent",
          riskPercent: config?.riskPercent ?? 1.0,
          maxLeverage: config?.maxLeverage ?? 10,
          maxOpenPositions: config?.maxOpenPositions ?? 2,
          dailyLossLimitPct: (config as any)?.dailyLossLimitPct ?? 3.0,
        },
        stats: {
          tradeCount: Math.max(state?.tradeCount || 0, openTrades.length + closeTrades.length),
          scanCount: state?.scanCount || 0,
          winCount,
          lossCount,
          totalPnl,
          dailyPnl,
          consecutiveLosses,
          circuitBreakerActive: circuitBreakerUntil > Date.now(),
          lastAction: state?.lastAction || null,
          lastReason: state?.lastReason || null,
          lastReasoning,
          openPositions,
          positionDetails,
          reasoningLog: reasoningLog.slice(-10),
        },
        learning,
      });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/miniapp/agent/preset", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });

      const { setAgentConfig, getAgentState } = await import("./autonomous-agent");
      const state = getAgentState(chatId);
      if (state?.running) return res.status(400).json({ error: "Stop the agent before changing preset" });

      const { preset } = req.body;
      const presets: Record<string, any> = {
        conservative: {
          riskPercent: 0.5,
          maxLeverage: 5,
          maxOpenPositions: 1,
          dailyLossLimitPct: 2.0,
          fundingRateFilter: true,
        },
        balanced: {
          riskPercent: 1.0,
          maxLeverage: 10,
          maxOpenPositions: 2,
          dailyLossLimitPct: 3.0,
          fundingRateFilter: true,
        },
        degen: {
          riskPercent: 1.0,
          maxLeverage: 15,
          maxOpenPositions: 3,
          dailyLossLimitPct: 5.0,
          fundingRateFilter: false,
        },
      };

      const config = presets[preset];
      if (!config) return res.status(400).json({ error: "Invalid preset. Use: conservative, balanced, or degen" });

      const result = setAgentConfig(chatId, config);
      res.json({ success: true, preset, config: result });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/miniapp/agent/config", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });

      const { setAgentConfig, getAgentConfig, getAgentState } = await import("./autonomous-agent");
      const state = getAgentState(chatId);
      if (state?.running) return res.status(400).json({ error: "Stop the agent before changing config" });

      const { name, symbol, riskPercent, leverage, maxOpenPositions, takeProfitPct, stopLossPct, trailingStopPct, fundingRateFilter, orderbookImbalanceThreshold, useConfidenceFilter, minConfidence } = req.body;
      const updates: any = {};
      if (name && typeof name === "string") {
        const cleanName = name.trim().substring(0, 24);
        if (cleanName.length >= 2) {
          try {
            const { db: dbConn } = await import("./db");
            const { sql: sqlTag } = await import("drizzle-orm");
            const existing = await dbConn.execute(sqlTag`
              SELECT chat_id FROM aster_trading_limits 
              WHERE agent_config_json::text ILIKE ${'%"name":"' + cleanName.replace(/["%\\]/g, '') + '"%'} 
              AND chat_id != ${chatId}
              LIMIT 1
            `);
            if (existing.rows && existing.rows.length > 0) {
              return res.status(400).json({ error: `Agent name "${cleanName}" is already taken. Choose a unique name.` });
            }
          } catch (e: any) {
            console.warn(`[Agent] Name uniqueness check failed: ${e.message?.substring(0, 80)}`);
          }
          updates.name = cleanName;
        }
      }
      if (symbol && typeof symbol === "string") updates.symbol = symbol.toUpperCase();
      if (riskPercent !== undefined) updates.riskPercent = Math.max(0.5, Math.min(5, parseFloat(riskPercent) || 1));
      if (leverage !== undefined) updates.maxLeverage = Math.max(1, Math.min(50, parseInt(leverage) || 10));
      if (maxOpenPositions !== undefined) updates.maxOpenPositions = Math.max(1, Math.min(10, parseInt(maxOpenPositions) || 3));
      if (takeProfitPct !== undefined) updates.takeProfitPct = Math.max(1, Math.min(50, parseFloat(takeProfitPct) || 5));
      if (stopLossPct !== undefined) updates.stopLossPct = Math.max(1, Math.min(20, parseFloat(stopLossPct) || 3));
      if (trailingStopPct !== undefined) updates.trailingStopPct = Math.max(0.5, Math.min(10, parseFloat(trailingStopPct) || 2));
      if (fundingRateFilter !== undefined) updates.fundingRateFilter = fundingRateFilter === true || fundingRateFilter === "true";
      if (orderbookImbalanceThreshold !== undefined) updates.orderbookImbalanceThreshold = Math.max(0.4, Math.min(0.8, parseFloat(orderbookImbalanceThreshold) || 0.6));
      if (useConfidenceFilter !== undefined) updates.useConfidenceFilter = useConfidenceFilter === true || useConfidenceFilter === "true";
      if (minConfidence !== undefined) updates.minConfidence = Math.max(0.3, Math.min(0.9, parseFloat(minConfidence) || 0.65));

      const config = setAgentConfig(chatId, updates);
      res.json({ success: true, config });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/miniapp/agent/toggle", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });

      const { getAgentState, startAgent, stopAgent } = await import("./autonomous-agent");
      const state = getAgentState(chatId);

      if (state?.running) {
        stopAgent(chatId);
        res.json({ running: false });
      } else {
        const client = await getAsterClient(parseInt(chatId));
        if (!client) return res.status(400).json({ error: "Aster not connected" });
        const getClientFn = () => client;
        const { getBotInstance } = await import("./telegram-bot");
        const sendMsg = async (msg: string) => {
          try {
            const bot = getBotInstance();
            if (bot) await bot.sendMessage(parseInt(chatId), msg, { parse_mode: "Markdown" });
          } catch (e: any) { console.log(`[Agent:${chatId}] sendMsg error:`, e.message?.substring(0, 100)); }
        };
        await startAgent(chatId, getClientFn, sendMsg);
        res.json({ running: true });
      }
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/miniapp/orders", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });

      const client = await getAsterClient(parseInt(chatId));
      if (!client) return res.json({ openOrders: [] });

      const futuresClient = client.futures || client;
      const orders = await futuresClient.openOrders().catch(() => []);

      res.json({
        openOrders: Array.isArray(orders) ? orders.map((o: any) => ({
          orderId: o.orderId,
          symbol: o.symbol,
          side: o.side,
          type: o.type,
          price: parseFloat(o.price || "0"),
          origQty: parseFloat(o.origQty || "0"),
          executedQty: parseFloat(o.executedQty || "0"),
          status: o.status,
          time: o.time || o.updateTime,
        })) : [],
      });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/miniapp/history", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });

      const client = await getAsterClient(parseInt(chatId));
      if (!client) {
        return res.json({
          openPositions: [],
          closedTrades: [],
          pnlSummary: {
            day1: { pnl: 0, wins: 0, losses: 0, total: 0 },
            day7: { pnl: 0, wins: 0, losses: 0, total: 0 },
            allTime: { pnl: 0, wins: 0, losses: 0, total: 0 },
          },
        });
      }

      const fc = client.futures || client;

      const [positions, incomeRaw] = await Promise.all([
        fc.positions().catch((e: any) => { console.log(`[History] positions error: ${e.message?.substring(0, 100)}`); return []; }),
        fc.income("REALIZED_PNL", 100).catch((e: any) => { console.log(`[History] income REALIZED_PNL error: ${e.message?.substring(0, 100)}`); return []; }),
      ]);

      let incomeData = Array.isArray(incomeRaw) ? incomeRaw : [];
      if (incomeData.length === 0) {
        try {
          const allIncome = await fc.income(undefined, 100).catch(() => []);
          if (Array.isArray(allIncome)) {
            incomeData = allIncome.filter((i: any) => i.incomeType === "REALIZED_PNL" || parseFloat(i.income || "0") !== 0);
          }
        } catch (e2: any) { console.log(`[History] income fallback error: ${e2.message?.substring(0, 100)}`); }
      }

      if (incomeData.length === 0) {
        try {
          const { db: dbConn } = await import("./db");
          const { sql: sqlTag } = await import("drizzle-orm");
          const dbTrades = await dbConn.execute(sqlTag`
            SELECT symbol, side, pnl, entry_price, exit_price, quantity, leverage, closed_at, status
            FROM aster_agent_trades
            WHERE chat_id = ${chatId} AND pnl IS NOT NULL
            ORDER BY closed_at DESC
            LIMIT 50
          `).catch(() => ({ rows: [] }));
          if (dbTrades.rows && dbTrades.rows.length > 0) {
            console.log(`[History] chatId=${chatId} Using DB fallback: ${dbTrades.rows.length} trades`);
            for (const t of dbTrades.rows as any[]) {
              const pnl = parseFloat(t.pnl || "0");
              const ep = parseFloat(t.entry_price || "0");
              const xp = parseFloat(t.exit_price || "0");
              const qty = parseFloat(t.quantity || "0");
              incomeData.push({
                symbol: t.symbol,
                income: String(pnl),
                incomeType: "REALIZED_PNL",
                time: String(t.closed_at ? new Date(t.closed_at).getTime() : 0),
                _dbFallback: true,
                _side: t.side,
                _entryPrice: ep,
                _exitPrice: xp,
                _qty: qty,
                _leverage: parseFloat(t.leverage || "0"),
              });
            }
          }
        } catch (e: any) { console.log(`[History] DB fallback error: ${e.message?.substring(0, 80)}`); }
      }

      console.log(`[History] chatId=${chatId} positions=${Array.isArray(positions)?positions.length:'err'} income=${incomeData.length}`);

      const leverageMap: Record<string, number> = {};
      if (Array.isArray(positions)) {
        for (const p of positions) {
          if (p.symbol) leverageMap[p.symbol] = parseFloat(p.leverage || "1");
        }
      }

      const openPositions = Array.isArray(positions)
        ? positions.filter((p: any) => parseFloat(p.positionAmt || "0") !== 0).map((p: any) => {
          const amt = parseFloat(p.positionAmt || "0");
          const entryPrice = parseFloat(p.entryPrice || "0");
          const markPrice = parseFloat(p.markPrice || "0");
          const lev = parseFloat(p.leverage || "1");
          const upnl = parseFloat(p.unRealizedProfit || "0");
          const rawNotional = parseFloat(p.notional || "0");
          return {
            symbol: p.symbol,
            side: p.positionSide === "LONG" || p.positionSide === "SHORT"
              ? p.positionSide
              : rawNotional !== 0
                ? (rawNotional > 0 ? "LONG" : "SHORT")
                : (amt > 0 ? "LONG" : "SHORT"),
            quantity: Math.abs(amt),
            entryPrice,
            markPrice,
            leverage: lev,
            unrealizedPnl: upnl,
          };
        })
        : [];

      const now = Date.now();
      const day1 = now - 24 * 60 * 60 * 1000;
      const day7 = now - 7 * 24 * 60 * 60 * 1000;

      const closedTrades: any[] = [];
      let pnl1d = 0, pnl7d = 0, pnlAll = 0;
      let wins1d = 0, losses1d = 0, wins7d = 0, losses7d = 0, winsAll = 0, lossesAll = 0;

      const uniqueSymbols = new Set<string>();
      if (Array.isArray(incomeData)) {
        for (const inc of incomeData) {
          if (inc.symbol) uniqueSymbols.add(inc.symbol);
        }
      }

      const userTradesMap: Record<string, any[]> = {};
      const symbolArr = Array.from(uniqueSymbols).slice(0, 10);
      const tradeResults = await Promise.all(
        symbolArr.map(sym => fc.userTrades(sym, 100).catch(() => []))
      );
      symbolArr.forEach((sym, i) => {
        if (Array.isArray(tradeResults[i])) userTradesMap[sym] = tradeResults[i];
      });

      if (Array.isArray(incomeData)) {
        for (const inc of incomeData) {
          const pnl = parseFloat(inc.income || "0");
          if (pnl === 0) continue;
          const ts = parseInt(inc.time || "0");
          const symbol = inc.symbol || "UNKNOWN";
          const tradeId = inc.tradeId || inc.tranId || "";

          let entryPrice = 0;
          let exitPrice = 0;
          let qty = parseFloat(inc.qty || inc.tradeQty || "0");
          let side = inc.positionSide || "";
          let lev = leverageMap[symbol] || 0;

          if (inc._dbFallback) {
            entryPrice = inc._entryPrice || 0;
            exitPrice = inc._exitPrice || 0;
            qty = inc._qty || qty;
            side = inc._side || side;
            lev = inc._leverage || lev;
          } else {
            const symTrades = userTradesMap[symbol] || [];
            const closeTrade = symTrades.find((t: any) => String(t.id) === String(tradeId) || (Math.abs(t.time - ts) < 2000 && parseFloat(t.realizedPnl || "0") !== 0));
            if (closeTrade) {
              exitPrice = parseFloat(closeTrade.price || "0");
              qty = qty || parseFloat(closeTrade.qty || "0");
              if (!side) side = closeTrade.positionSide || (closeTrade.side === "SELL" ? "LONG" : "SHORT");

              if (exitPrice > 0 && qty > 0 && pnl !== 0) {
                if (side === "LONG" || side === "BUY") {
                  entryPrice = exitPrice - (pnl / qty);
                } else {
                  entryPrice = exitPrice + (pnl / qty);
                }
              }
            }
          }

          if (!side) side = pnl > 0 ? "LONG" : "SHORT";
          const pctPnl = (entryPrice > 0 && qty > 0) ? (pnl / (entryPrice * qty) * 100) : 0;

          closedTrades.push({
            symbol,
            side,
            pnl,
            pctPnl: parseFloat(pctPnl.toFixed(2)),
            closedAt: ts,
            quantity: qty,
            entryPrice: parseFloat(entryPrice.toFixed(8)),
            exitPrice: parseFloat(exitPrice.toFixed(8)),
            leverage: lev,
            status: "Closed",
          });

          pnlAll += pnl;
          if (pnl > 0) winsAll++; else lossesAll++;

          if (ts >= day7) {
            pnl7d += pnl;
            if (pnl > 0) wins7d++; else losses7d++;
          }
          if (ts >= day1) {
            pnl1d += pnl;
            if (pnl > 0) wins1d++; else losses1d++;
          }
        }
      }

      closedTrades.sort((a: any, b: any) => b.closedAt - a.closedAt);

      res.json({
        openPositions,
        closedTrades: closedTrades.slice(0, 50),
        pnlSummary: {
          day1: { pnl: pnl1d, wins: wins1d, losses: losses1d, total: wins1d + losses1d },
          day7: { pnl: pnl7d, wins: wins7d, losses: losses7d, total: wins7d + losses7d },
          allTime: { pnl: pnlAll, wins: winsAll, losses: lossesAll, total: winsAll + lossesAll },
        },
      });
    } catch (e: any) {
      console.error("[History] Error:", e.message?.substring(0, 100));
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/miniapp/trades", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      const symbol = (req.query.symbol as string) || "BTCUSDT";
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });

      const client = await getAsterClient(parseInt(chatId));
      if (!client) return res.json({ trades: [], income: [] });

      const futuresClient = client.futures || client;
      const [trades, income] = await Promise.all([
        futuresClient.userTrades(symbol, 20).catch(() => []),
        futuresClient.income(undefined, 30).catch(() => []),
      ]);

      res.json({
        trades: Array.isArray(trades) ? trades.map((t: any) => ({
          symbol: t.symbol,
          side: t.side,
          qty: parseFloat(t.qty || "0"),
          price: parseFloat(t.price || "0"),
          realizedPnl: parseFloat(t.realizedPnl || "0"),
          time: t.time,
        })) : [],
        income: Array.isArray(income) ? income.map((i: any) => ({
          symbol: i.symbol,
          type: i.incomeType,
          amount: parseFloat(i.income || "0"),
          time: i.time,
        })) : [],
      });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/miniapp/trade", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });

      const { symbol, side, amount, leverage } = req.body;
      if (!symbol || !side || !amount) return res.status(400).json({ error: "Missing symbol, side, or amount" });
      if (!["BUY", "SELL"].includes(side)) return res.status(400).json({ error: "Side must be BUY or SELL" });
      if (amount <= 0) return res.status(400).json({ error: "Amount must be positive" });

      const client = await getAsterClient(parseInt(chatId));
      if (!client) return res.status(400).json({ error: "Aster not connected. Configure API wallet via /api command." });

      const fc = client.futures || client;
      console.log(`[MiniApp] Trade client mode=${client.mode || "unknown"} chatId=${chatId}`);

      if (leverage && leverage > 0) {
        try {
          await fc.setLeverage(symbol, Math.min(Math.max(1, Math.round(leverage)), 125));
        } catch (e: any) {
          console.log(`[MiniApp] setLeverage warning: ${e.message}`);
        }
      }

      const ticker = await fc.tickerPrice(symbol).catch(() => null);
      const price = parseFloat(ticker?.price || "0");
      if (price <= 0) return res.status(400).json({ error: `Cannot get price for ${symbol}` });

      const lev = leverage || 10;
      const notional = amount * lev;
      let qty: number;

      const stepSizes: Record<string, number> = {
        BTCUSDT: 0.001, ETHUSDT: 0.01, SOLUSDT: 0.1, BNBUSDT: 0.01,
        DOGEUSDT: 1, XRPUSDT: 0.1, ADAUSDT: 1, AVAXUSDT: 0.1,
        DOTUSDT: 0.1, MATICUSDT: 1, LINKUSDT: 0.01, LTCUSDT: 0.001,
      };
      const step = stepSizes[symbol] || 0.001;
      qty = Math.floor((notional / price) / step) * step;
      if (qty <= 0) return res.status(400).json({ error: "Amount too small for this pair" });

      const precision = step < 1 ? Math.ceil(-Math.log10(step)) : 0;
      const qtyStr = qty.toFixed(precision);

      console.log(`[MiniApp] Trade: ${side} ${qtyStr} ${symbol} @ ~$${price} (margin=$${amount}, lev=${lev}x)`);

      const order = await fc.createOrder({
        symbol,
        side,
        type: "MARKET",
        quantity: qtyStr,
      });

      res.json({
        success: true,
        orderId: order.orderId || order.orderid,
        symbol,
        side,
        quantity: qtyStr,
        price,
        leverage: lev,
        margin: amount,
        status: order.status || "FILLED",
      });
    } catch (e: any) {
      console.error(`[MiniApp] Trade error: ${e.message}`);
      const msg = e.message || "Trade failed";
      const userMsg = msg.includes("insufficient") ? "Insufficient balance for this trade" :
                      msg.includes("quantity") ? "Invalid quantity for this pair" :
                      msg.includes("price") ? "Price error — try again" :
                      msg.includes("leverage") ? "Leverage setting failed" :
                      `Trade failed: ${msg.substring(0, 120)}`;
      res.status(500).json({ error: userMsg });
    }
  });

  app.post("/api/miniapp/close", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });

      const { symbol } = req.body;
      if (!symbol) return res.status(400).json({ error: "Missing symbol" });

      const client = await getAsterClient(parseInt(chatId));
      if (!client) return res.status(400).json({ error: "Aster not connected" });

      const fc = client.futures || client;

      const positions = await fc.positions();
      const pos = Array.isArray(positions)
        ? positions.find((p: any) => p.symbol === symbol && parseFloat(p.positionAmt || "0") !== 0)
        : null;
      if (!pos) return res.status(400).json({ error: `No open position for ${symbol}` });

      const amt = parseFloat(pos.positionAmt || "0");
      const rawNot = parseFloat(pos.notional || "0");
      const isLong = pos.positionSide === "LONG" || pos.positionSide === "SHORT"
        ? pos.positionSide === "LONG"
        : rawNot !== 0 ? rawNot > 0 : amt > 0;
      const closeSide = isLong ? "SELL" : "BUY";
      const absAmt = Math.abs(amt);

      console.log(`[MiniApp] Close: ${closeSide} ${absAmt} ${symbol}`);

      const entryPrice = parseFloat(pos.entryPrice || "0");
      const markPrice = parseFloat(pos.markPrice || "0");
      const unrealizedPnl = parseFloat(pos.unRealizedProfit || pos.unrealizedPnl || "0");

      const order = await fc.createOrder({
        symbol,
        side: closeSide,
        type: "MARKET",
        quantity: absAmt.toString(),
        reduceOnly: true,
      });

      const realizedPnl = parseFloat(order.realizedPnl || order.cumQuote || "0") || unrealizedPnl;

      res.json({
        success: true,
        orderId: order.orderId || order.orderid,
        symbol,
        side: closeSide,
        quantity: absAmt,
        realizedPnl,
        entryPrice,
        closePrice: markPrice,
        status: order.status || "FILLED",
      });
    } catch (e: any) {
      console.error(`[MiniApp] Close error: ${e.message}`);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/miniapp/cancel-order", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });

      const { symbol, orderId } = req.body;
      if (!symbol || !orderId) return res.status(400).json({ error: "Missing symbol or orderId" });

      const client = await getAsterClient(parseInt(chatId));
      if (!client) return res.status(400).json({ error: "Aster not connected" });

      const fc = client.futures || client;
      const result = await fc.cancelOrder(symbol, orderId);
      res.json({ success: true, orderId: result.orderId || orderId, status: result.status || "CANCELED" });
    } catch (e: any) {
      console.error(`[MiniApp] Cancel order error: ${e.message}`);
      res.status(500).json({ error: e.message?.substring(0, 120) || "Cancel failed" });
    }
  });

  app.get("/api/miniapp/debug", async (_req: Request, res: Response) => {
    try {
      const { getAsterClient } = await import("./telegram-bot");
      const client = await getAsterClient(0);
      if (!client) return res.json({ error: "No Aster client", hasPrivateKey: !!process.env.ASTER_PRIVATE_KEY, hasUser: !!process.env.ASTER_USER_ADDRESS });
      const fc = client.futures || client;
      const [bal, acct] = await Promise.all([
        fc.balance().catch((e: any) => ({ error: e.message })),
        fc.account().catch((e: any) => ({ error: e.message })),
      ]);
      res.json({
        balanceType: typeof bal,
        balanceIsArray: Array.isArray(bal),
        balance: JSON.parse(JSON.stringify(bal)).toString !== undefined ? bal : bal,
        accountKeys: acct && typeof acct === "object" && !acct.error ? Object.keys(acct) : null,
        accountAssetsSample: acct?.assets?.slice?.(0, 2) || null,
        accountTopLevel: acct && typeof acct === "object" && !acct.error ? {
          totalWalletBalance: acct.totalWalletBalance,
          totalCrossWalletBalance: acct.totalCrossWalletBalance,
          availableBalance: acct.availableBalance,
          totalCrossUnPnl: acct.totalCrossUnPnl,
          maxWithdrawAmount: acct.maxWithdrawAmount,
        } : acct,
      });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/debug-config", async (_req: Request, res: Response) => {
    try {
      const { Wallet } = await import("ethers");
      const pk = process.env.ASTER_PRIVATE_KEY;
      const userAddr = process.env.ASTER_USER_ADDRESS;
      const signerAddr = process.env.ASTER_SIGNER_ADDRESS;

      let derivedAddr = "N/A";
      if (pk) {
        try { derivedAddr = new Wallet(pk).address; } catch { derivedAddr = "INVALID_KEY"; }
      }

      res.json({
        hasPrivateKey: !!pk,
        keyPrefix: pk ? pk.substring(0, 6) + "..." : "NOT_SET",
        userAddress: userAddr || "NOT_SET",
        signerAddress: signerAddr || "NOT_SET",
        derivedFromKey: derivedAddr,
        keyMatchesSigner: signerAddr ? derivedAddr.toLowerCase() === signerAddr.toLowerCase() : "N/A",
        env: {
          ASTER_PRIVATE_KEY: pk ? "SET" : "NOT_SET",
          ASTER_USER_ADDRESS: userAddr ? "SET" : "NOT_SET",
          ASTER_SIGNER_ADDRESS: signerAddr ? "SET" : "NOT_SET",
          ASTER_API_KEY: process.env.ASTER_API_KEY ? "SET" : "NOT_SET",
          ASTER_API_SECRET: process.env.ASTER_API_SECRET ? "SET" : "NOT_SET",
          ASTER_API_WALLET_KEY: process.env.ASTER_API_WALLET_KEY ? "SET" : "NOT_SET",
        },
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/test-order", async (_req: Request, res: Response) => {
    try {
      const { Wallet, getAddress, AbiCoder, keccak256, getBytes } = await import("ethers");

      const pk = process.env.ASTER_PRIVATE_KEY;
      const userAddr = process.env.ASTER_USER_ADDRESS;
      const signerAddr = process.env.ASTER_SIGNER_ADDRESS;

      if (!pk) return res.json({ error: "No ASTER_PRIVATE_KEY env var" });
      if (!userAddr) return res.json({ error: "No ASTER_USER_ADDRESS env var" });

      const wallet = new Wallet(pk);
      const derivedAddr = wallet.address;
      const user = getAddress(userAddr);
      const signer = signerAddr ? getAddress(signerAddr) : derivedAddr;

      const results: any = {
        config: {
          user,
          signer,
          derivedFromKey: derivedAddr,
          keyMatchesSigner: derivedAddr.toLowerCase() === signer.toLowerCase(),
        },
        variations: [],
      };

      const nowMicros = Math.trunc(Date.now() * 1000);
      const timestamp = String(Date.now());

      const queryString = `symbol=BTCUSDT&side=BUY&type=MARKET&quantity=0.001&timestamp=${timestamp}`;
      const nonce = String(nowMicros);

      const abiCoder = AbiCoder.defaultAbiCoder();
      const encoded = abiCoder.encode(
        ["string", "address", "address", "uint64"],
        [queryString, user, signer, BigInt(nonce)],
      );
      const hash = keccak256(encoded);
      const signature = await wallet.signMessage(getBytes(hash));

      const fullBody = `${queryString}&nonce=${nonce}&user=${user}&signer=${signer}&signature=${signature}`;

      const testResult: any = { queryString, nonce, signature: signature.substring(0, 40) + "..." };
      try {
        const resp = await fetch(`https://fapi.asterdex.com/fapi/v3/order`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "BUILD4/1.0",
          },
          body: fullBody,
        });
        const text = await resp.text();
        testResult.status = resp.status;
        testResult.response = text.substring(0, 500);
        try { testResult.parsed = JSON.parse(text); } catch {}
      } catch (e: any) {
        testResult.error = e.message;
      }
      results.variations.push(testResult);

      res.json(results);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/miniapp/markets", async (req: Request, res: Response) => {
    try {
      const symbols = [
        "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "DOGEUSDT",
        "XRPUSDT", "ADAUSDT", "AVAXUSDT", "DOTUSDT", "LINKUSDT",
        "MATICUSDT", "LTCUSDT", "UNIUSDT", "APTUSDT", "ARBUSDT",
        "OPUSDT", "SUIUSDT", "NEARUSDT",
      ];
      const chatId = req.headers["x-telegram-chat-id"] as string;
      const client = chatId ? await getAsterClient(parseInt(chatId)) : null;

      if (!client) {
        console.log(`[MiniApp] markets: no client (chatId=${chatId || 'missing'})`);
        return res.json({ markets: [] });
      }
      const futuresClient = client.futures || client;

      const prices = await Promise.all(
        symbols.map(async (sym) => {
          try {
            const ticker = await futuresClient.tickerPrice(sym);
            return { symbol: sym, price: parseFloat(ticker?.price || "0") };
          } catch {
            return { symbol: sym, price: 0 };
          }
        })
      );
      res.json({ markets: prices });
    } catch (e: any) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/miniapp/pool/user", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });
      const user = await storage.upsertPoolUser(chatId);
      const deposits = await storage.getPoolDeposits(chatId);
      const stats = await storage.getPoolStats();
      res.json({ user, deposits, stats });
    } catch (e: any) { res.status(500).json({ error: "Internal server error" }); }
  });

  app.post("/api/miniapp/pool/deposit", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });
      const { txHash, amount, fromAddress } = req.body;
      if (!txHash || !amount || amount <= 0) return res.status(400).json({ error: "Invalid deposit data" });

      const existing = await storage.getPoolDeposits(chatId);
      const dupe = existing.find((d: any) => d.tx_hash === txHash);
      if (dupe) return res.json({ success: true, deposit: dupe, message: "Deposit already recorded" });

      let verified = false;
      try {
        const bscRes = await fetch(`https://api.bscscan.com/api?module=proxy&action=eth_getTransactionReceipt&txhash=${txHash}&apikey=${process.env.BSCSCAN_API_KEY || 'YourApiKeyToken'}`);
        const bscData = await bscRes.json();
        if (bscData?.result?.status === "0x1") {
          verified = true;
          console.log(`[Pool] TX ${txHash.substring(0, 12)} verified on BSC for chatId=${chatId}`);
        }
      } catch (e: any) {
        console.log(`[Pool] BSC verification failed for ${txHash.substring(0, 12)}: ${e.message?.substring(0, 100)}`);
      }

      const deposit = await storage.createPoolDeposit(chatId, amount, txHash, fromAddress, "external");
      if (verified && deposit) {
        await storage.updatePoolDepositStatus(deposit.id, "verified");
      }

      let bridgeResult: any = null;
      if (verified && deposit) {
        try {
          const pk = process.env.ASTER_PRIVATE_KEY;
          const ownerAddr = process.env.ASTER_USER_ADDRESS || "0xeb0616e044c55c1ca214ed3629fee3354bbf9826";
          if (pk) {
            const { asterV3Deposit } = await import("./aster-client");
            console.log(`[Pool] Auto-bridge: forwarding $${amount} USDT from holding wallet to Aster for owner ${ownerAddr.substring(0, 10)}...`);
            bridgeResult = await asterV3Deposit(pk, amount, 0, ownerAddr);
            if (bridgeResult.success) {
              console.log(`[Pool] Auto-bridge SUCCESS: $${amount} deposited to Aster. TX: ${bridgeResult.txHash}`);
              await storage.updatePoolDepositStatus(deposit.id, "credited");
            } else {
              console.log(`[Pool] Auto-bridge failed: ${bridgeResult.error?.substring(0, 200)}`);
            }
          }
        } catch (e: any) {
          console.error(`[Pool] Auto-bridge error: ${e.message?.substring(0, 200)}`);
          bridgeResult = { success: false, error: e.message?.substring(0, 200) };
        }
      }

      const message = bridgeResult?.success
        ? "Deposit verified and forwarded to Aster trading pool!"
        : verified
          ? "Deposit verified. Auto-bridge to Aster pending."
          : "Deposit recorded, awaiting verification.";

      res.json({
        success: true,
        deposit,
        verified,
        bridged: bridgeResult?.success || false,
        bridgeTx: bridgeResult?.txHash || null,
        bridgeError: bridgeResult?.error || null,
        message,
      });
    } catch (e: any) { res.status(500).json({ error: "Internal server error" }); }
  });

  app.post("/api/miniapp/pool/credit", async (req: Request, res: Response) => {
    try {
      const chatId = req.headers["x-telegram-chat-id"] as string;
      if (!chatId) return res.status(400).json({ error: "Missing chat ID" });
      const { depositId } = req.body;
      if (!depositId) return res.status(400).json({ error: "Missing deposit ID" });
      await storage.updatePoolDepositStatus(depositId, "credited");
      res.json({ success: true });
    } catch (e: any) { res.status(500).json({ error: "Internal server error" }); }
  });

  app.get("/api/miniapp/pool/stats", async (req: Request, res: Response) => {
    try {
      const stats = await storage.getPoolStats();

      let poolBalance = 0;
      try {
        const client = await getAsterClient(0);
        if (client) {
          const fc = client.futures || client;
          const bal = await fc.balance().catch(() => []);
          if (Array.isArray(bal)) {
            const usdt = bal.find((b: any) => (b.asset || "").toUpperCase() === "USDT");
            if (usdt) {
              poolBalance = Math.max(
                parseFloat(usdt.walletBalance || "0"),
                parseFloat(usdt.availableBalance || "0"),
                parseFloat(usdt.crossWalletBalance || "0")
              );
            }
          }
        }
      } catch {}

      res.json({
        ...stats,
        poolBalance,
        totalPnl: poolBalance - stats.totalDeposits,
        pnlPercent: stats.totalDeposits > 0 ? ((poolBalance - stats.totalDeposits) / stats.totalDeposits * 100) : 0,
      });
    } catch (e: any) { res.status(500).json({ error: "Internal server error" }); }
  });

  app.post("/api/miniapp/pool/bridge-now", async (req: Request, res: Response) => {
    try {
      const pk = process.env.ASTER_PRIVATE_KEY;
      const ownerAddr = process.env.ASTER_USER_ADDRESS || "0xeb0616e044c55c1ca214ed3629fee3354bbf9826";
      if (!pk) return res.status(400).json({ error: "No ASTER_PRIVATE_KEY" });

      const { JsonRpcProvider, Wallet, Contract, formatUnits } = await import("ethers");
      const provider = new JsonRpcProvider("https://bsc-dataseed1.binance.org");
      const wallet = new Wallet(pk, provider);
      const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";
      const usdt = new Contract(BSC_USDT, ["function balanceOf(address) view returns (uint256)"], provider);
      const rawBal = await usdt.balanceOf(wallet.address);
      const usdtBal = parseFloat(formatUnits(rawBal, 18));

      if (usdtBal < 0.01) {
        return res.json({ success: false, error: `Holding wallet has $${usdtBal.toFixed(4)} USDT — nothing to bridge` });
      }

      const { asterV3Deposit } = await import("./aster-client");
      console.log(`[Bridge] Manual trigger: forwarding $${usdtBal} USDT to Aster for ${ownerAddr.substring(0, 10)}...`);
      const result = await asterV3Deposit(pk, usdtBal, 0, ownerAddr);

      if (result.success) {
        console.log(`[Bridge] SUCCESS: $${usdtBal} deposited to Aster. TX: ${result.txHash}`);
      } else {
        console.log(`[Bridge] FAILED: ${result.error}`);
      }

      res.json({ ...result, amount: usdtBal, holdingWallet: wallet.address, owner: ownerAddr });
    } catch (e: any) { res.status(500).json({ error: "Internal server error" }); }
  });

  app.get("/api/miniapp/pool/holding-balance", async (req: Request, res: Response) => {
    try {
      const pk = process.env.ASTER_PRIVATE_KEY;
      if (!pk) return res.status(400).json({ error: "No ASTER_PRIVATE_KEY" });

      const { JsonRpcProvider, Wallet, Contract, formatUnits, formatEther } = await import("ethers");
      const provider = new JsonRpcProvider("https://bsc-dataseed1.binance.org");
      const wallet = new Wallet(pk, provider);
      const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";
      const usdt = new Contract(BSC_USDT, ["function balanceOf(address) view returns (uint256)"], provider);
      const rawBal = await usdt.balanceOf(wallet.address);
      const bnbBal = await provider.getBalance(wallet.address);

      res.json({
        holdingWallet: wallet.address,
        usdtBalance: parseFloat(formatUnits(rawBal, 18)),
        bnbBalance: parseFloat(formatEther(bnbBal)),
      });
    } catch (e: any) { res.status(500).json({ error: "Internal server error" }); }
  });

}
