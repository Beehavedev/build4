// Wallet management routes for the BUILD4 site terminal.
//
// Scope:
//   - SIWE-style sign-in: nonce → strict EIP-4361-ish verify → HMAC session cookie.
//     Sensitive actions (reveal-pk, withdraw) are gated by this cookie session,
//     not by the easily-spoofed `x-wallet-address` header.
//   - Cross-chain deposit info (the user's actual custodial address + chain catalog).
//   - Cross-chain withdraw: server signs an ERC20 transfer or native send
//     from the user's custodial wallet on BSC / Polygon / Arbitrum / X-Layer.
//   - Custodial private-key reveal (rate-limited, audit-logged).
//
// Coexists with the existing header-based `miniAppAuth` for T001-T008 terminal
// endpoints. We intentionally do NOT migrate those here — that's a separate
// site-wide pass. New routes added in this file are SIWE-only.
//
// Important: the user's connected wallet (the one that signs SIWE) may be
// distinct from the custodial wallet that actually holds funds. The custodial
// wallet was provisioned via the Telegram bot's /setup flow and is the row in
// `telegram_wallets` with an `encryptedPrivateKey`. `resolveCustodial()` walks
// the chatId chain to find it; the connected wallet is treated as the user's
// identity, the custodial wallet as the asset vault.

import type { Express, Request, Response, NextFunction } from "express";
import { ethers } from "ethers";
import crypto from "crypto";
import { storage } from "./storage";
import {
  ensureLinkTable, getLinkByWebWallet, upsertLinkToken, redeemLinkToken,
  lookupBotCustodialByTelegramId, decryptBotPk,
  type BotCustodial,
} from "./bot-wallet";

// ── Session + nonce store (in-memory; survives within a single process) ──

const SESSION_TTL_MS = 60 * 60 * 1000;          // 1 hour
const NONCE_TTL_MS = 5 * 60 * 1000;             // 5 minutes
const COOKIE_NAME = "b4_sess";

const nonces = new Map<string, number>();
function issueNonce(): string {
  const n = crypto.randomBytes(16).toString("hex");
  nonces.set(n, Date.now() + NONCE_TTL_MS);
  if (nonces.size > 5000) {
    const now = Date.now();
    nonces.forEach((v, k) => { if (v < now) nonces.delete(k); });
  }
  return n;
}
function consumeNonce(n: string): boolean {
  const exp = nonces.get(n);
  nonces.delete(n);
  return !!exp && exp > Date.now();
}

function sessionSecret(): string {
  const s = process.env.SESSION_SECRET || process.env.DAPP_SESSION_SECRET;
  if (s && s.length >= 32) return s;
  const g = globalThis as any;
  if (!g.__b4WalletSessSecret) {
    g.__b4WalletSessSecret = crypto.randomBytes(32).toString("hex");
    console.warn("[wallet-routes] SESSION_SECRET not set; using ephemeral secret. Set SESSION_SECRET in prod.");
  }
  return g.__b4WalletSessSecret;
}

function signSession(wallet: string, expiresMs: number): string {
  const payload = `${wallet.toLowerCase()}|${expiresMs}`;
  const mac = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("hex");
  return `${payload}|${mac}`;
}
function verifySession(token: string | undefined): { wallet: string } | null {
  if (!token) return null;
  const parts = token.split("|");
  if (parts.length !== 3) return null;
  const [wallet, expStr, mac] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  const expected = crypto.createHmac("sha256", sessionSecret()).update(`${wallet}|${exp}`).digest("hex");
  let ok = false;
  try { ok = crypto.timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(expected, "hex")); } catch { ok = false; }
  return ok ? { wallet } : null;
}

export const SIWE_COOKIE_NAME = COOKIE_NAME;

export function verifySiweCookie(req: Request): { wallet: string } | null {
  return verifySession(readCookie(req, COOKIE_NAME));
}

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

interface AuthedRequest extends Request {
  authedWallet?: string;
}

function requireSession(req: AuthedRequest, res: Response, next: NextFunction) {
  const sess = verifySession(readCookie(req, COOKIE_NAME));
  if (!sess) return res.status(401).json({ ok: false, error: "Sign-in required", code: "NO_SESSION" });
  req.authedWallet = sess.wallet;
  next();
}

// ── Allowed Origins (for CSRF + SIWE domain binding) ───────────────────

function allowedHosts(req: Request): Set<string> {
  const env = process.env.SITE_ALLOWED_HOSTS || process.env.DAPP_ALLOWED_HOSTS || "";
  const list = env.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (list.length) return new Set(list);
  // Dev fallback: trust the request's Host header so local Replit previews work.
  const h = String(req.headers.host || "").toLowerCase();
  return new Set(h ? [h] : []);
}
function originHost(o: string | undefined | null): string {
  if (!o) return "";
  try { return new URL(o).host.toLowerCase(); } catch { return ""; }
}

// ── Resolve the user's actual CUSTODIAL wallet ────────────────────────
// The connected MetaMask address (req.authedWallet from SIWE) is the
// user's web identity, NOT their trading wallet. Their trading wallet
// is the BSC custodial wallet generated by the Telegram bot's /setup
// flow, which lives in the bot's "Wallet" table.
//
// Resolution chain:
//   1. web_telegram_links.web_wallet = authedWallet → telegram_id
//   2. "User"."telegramId" = telegram_id → userId
//   3. "Wallet" WHERE userId = X AND chain = 'BSC' → address + encryptedPK
//
// Returns null with one of three reasons:
//   • NO_LINK     — user has never claimed a Telegram link from the site
//   • NO_REDEMPTION — link token was issued but the user hasn't completed
//                     the bot deep-link redemption yet
//   • NO_BOT_WALLET — link is complete but the Telegram user hasn't run
//                     /setup in the bot, so there's no custodial wallet
async function resolveCustodial(authedWallet: string): Promise<
  | { ok: true; data: BotCustodial }
  | { ok: false; reason: "NO_LINK" | "NO_REDEMPTION" | "NO_BOT_WALLET" | "ERROR" }
> {
  try {
    await ensureLinkTable();
    const link = await getLinkByWebWallet(authedWallet);
    if (!link) return { ok: false, reason: "NO_LINK" };
    if (!link.telegramId || !link.linkedAt) return { ok: false, reason: "NO_REDEMPTION" };
    const cust = await lookupBotCustodialByTelegramId(link.telegramId);
    if (!cust) return { ok: false, reason: "NO_BOT_WALLET" };
    return { ok: true, data: cust };
  } catch (e: any) {
    console.error(`[wallet-routes] resolveCustodial failed for ${authedWallet}: ${e?.message}`);
    return { ok: false, reason: "ERROR" };
  }
}

function botLinkStartUrl(token: string): string {
  const handle = (process.env.BOT_USERNAME || "build4_bot").replace(/^@/, "");
  return `https://t.me/${handle}?start=link_${token}`;
}

function helpfulCustodialError(reason: "NO_LINK" | "NO_REDEMPTION" | "NO_BOT_WALLET" | "ERROR"): { status: number; body: any } {
  if (reason === "NO_LINK") return { status: 404, body: { ok: false, code: "NO_LINK", error: "Link your Telegram account to enable deposits and withdrawals." } };
  if (reason === "NO_REDEMPTION") return { status: 404, body: { ok: false, code: "NO_REDEMPTION", error: "Telegram link not completed yet. Open the bot and tap Start." } };
  if (reason === "NO_BOT_WALLET") return { status: 404, body: { ok: false, code: "NO_BOT_WALLET", error: "Run /setup in the Telegram bot to create your custodial wallet." } };
  return { status: 500, body: { ok: false, error: "Failed to resolve custodial wallet." } };
}

// ── Chain configs ─────────────────────────────────────────────────────

interface ChainCfg {
  id: number;
  name: string;
  explorer: string;
  nativeSymbol: string;
  nativeDecimals: 18;
  rpcs: string[];
  tokens: Record<string, { address: string; symbol: string; decimals: number }>;
}

const CHAINS: Record<string, ChainCfg> = {
  bsc: {
    id: 56, name: "BNB Smart Chain", explorer: "https://bscscan.com", nativeSymbol: "BNB", nativeDecimals: 18,
    rpcs: [
      process.env.BSC_RPC_URL || "",
      "https://bsc-dataseed.binance.org",
      "https://bsc.publicnode.com",
      "https://bsc.drpc.org",
      "https://1rpc.io/bnb",
    ].filter(Boolean),
    tokens: {
      USDT: { address: "0x55d398326f99059fF775485246999027B3197955", symbol: "USDT", decimals: 18 },
      USDC: { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", symbol: "USDC", decimals: 18 },
    },
  },
  polygon: {
    id: 137, name: "Polygon", explorer: "https://polygonscan.com", nativeSymbol: "POL", nativeDecimals: 18,
    rpcs: [
      process.env.POLYGON_RPC || "",
      "https://polygon-bor-rpc.publicnode.com",
      "https://polygon.drpc.org",
      "https://1rpc.io/matic",
    ].filter(Boolean),
    tokens: {
      USDT: { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", symbol: "USDT", decimals: 6 },
      USDC: { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", symbol: "USDC", decimals: 6 },
      "USDC.e": { address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", symbol: "USDC.e", decimals: 6 },
    },
  },
  arbitrum: {
    id: 42161, name: "Arbitrum One", explorer: "https://arbiscan.io", nativeSymbol: "ETH", nativeDecimals: 18,
    rpcs: [
      process.env.ARBITRUM_RPC || "",
      "https://arb1.arbitrum.io/rpc",
      "https://arbitrum.drpc.org",
      "https://1rpc.io/arb",
    ].filter(Boolean),
    tokens: {
      USDT: { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", symbol: "USDT", decimals: 6 },
      USDC: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", symbol: "USDC", decimals: 6 },
    },
  },
  xlayer: {
    id: 196, name: "X Layer", explorer: "https://www.oklink.com/xlayer", nativeSymbol: "OKB", nativeDecimals: 18,
    rpcs: [
      process.env.XLAYER_RPC || "",
      "https://rpc.xlayer.tech",
      "https://xlayerrpc.okx.com",
    ].filter(Boolean),
    tokens: {
      USDT: { address: "0x1E4a5963aBFD975d8c9021ce480b42188849D41d", symbol: "USDT", decimals: 6 },
      USDC: { address: "0x74b7F16337b8972027F6196A17a631aC6dE26d22", symbol: "USDC", decimals: 6 },
    },
  },
};

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

function buildProvider(cfg: ChainCfg): ethers.AbstractProvider {
  const network = new ethers.Network(cfg.name, BigInt(cfg.id));
  if (cfg.rpcs.length === 1) {
    return new ethers.JsonRpcProvider(cfg.rpcs[0], network, { staticNetwork: network });
  }
  const configs = cfg.rpcs.map((url, i) => ({
    provider: new ethers.JsonRpcProvider(url, network, { staticNetwork: network }),
    priority: i + 1,
    weight: 1,
    stallTimeout: 2500,
  }));
  return new ethers.FallbackProvider(configs, network, { quorum: 1 });
}

// ── Rate limiting ─────────────────────────────────────────────────────

const revealLimiter = new Map<string, number[]>();
function checkRevealRate(wallet: string): boolean {
  const now = Date.now();
  const arr = (revealLimiter.get(wallet) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (arr.length >= 5) return false;
  arr.push(now);
  revealLimiter.set(wallet, arr);
  return true;
}

// ── Strict EIP-4361-ish parser ────────────────────────────────────────
// We don't pull the `siwe` package; this parser extracts the fields we
// actually validate so we can enforce domain / URI / chain / nonce binding.
interface ParsedSiwe {
  domain: string;
  address: string;
  uri: string;
  version: string;
  chainId: string;
  nonce: string;
  issuedAt: string;
  expirationTime?: string;
}
function parseSiwe(message: string): ParsedSiwe | null {
  try {
    const lines = message.split("\n");
    if (lines.length < 6) return null;
    const head = lines[0].match(/^(\S+) wants you to sign in/);
    if (!head) return null;
    const domain = head[1];
    const address = lines[1].trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return null;
    const fields: Record<string, string> = {};
    for (const line of lines) {
      const m = line.match(/^([A-Za-z ]+):\s*(.+)$/);
      if (m) fields[m[1].trim()] = m[2].trim();
    }
    const need = ["URI", "Version", "Chain ID", "Nonce", "Issued At"];
    for (const k of need) if (!fields[k]) return null;
    return {
      domain, address,
      uri: fields["URI"], version: fields["Version"], chainId: fields["Chain ID"],
      nonce: fields["Nonce"], issuedAt: fields["Issued At"], expirationTime: fields["Expiration Time"],
    };
  } catch { return null; }
}

// Wraps a sensitive handler so we never leak provider/internal error text.
function safeHandler(fn: (req: AuthedRequest, res: Response) => Promise<void>, label: string) {
  return async (req: AuthedRequest, res: Response) => {
    try { await fn(req, res); }
    catch (e: any) {
      console.error(`[wallet-routes] ${label} failed:`, e?.shortMessage || e?.info?.error?.message || e?.message || e);
      if (!res.headersSent) res.status(500).json({ ok: false, error: `${label} failed. Please try again.` });
    }
  };
}

// ── Routes ──────────────────────────────────────────────────────────────

export function registerWalletRoutes(app: Express) {
  // 1. SIWE: hand out a nonce.
  app.get("/api/auth/nonce", (_req, res) => {
    res.json({ nonce: issueNonce(), expiresInMs: NONCE_TTL_MS });
  });

  // 2. SIWE: verify signature with strict origin/domain/URI binding,
  //    then issue an HMAC session cookie.
  app.post("/api/auth/siwe", async (req, res) => {
    try {
      const { message, signature, wallet } = req.body ?? {};
      if (typeof message !== "string" || typeof signature !== "string" || typeof wallet !== "string") {
        return res.status(400).json({ ok: false, error: "message + signature + wallet required" });
      }
      if (message.length > 4096 || signature.length > 200) {
        return res.status(400).json({ ok: false, error: "Payload too large" });
      }

      // Origin binding: reject cross-origin POSTs.
      const hosts = allowedHosts(req);
      const reqOrigin = originHost(req.headers.origin as string | undefined);
      if (hosts.size > 0 && reqOrigin && !hosts.has(reqOrigin)) {
        const list: string[] = []; hosts.forEach((h) => list.push(h));
        console.warn(`[wallet-routes] SIWE origin rejected: ${reqOrigin} not in ${list.join(",")}`);
        return res.status(403).json({ ok: false, error: "Origin not allowed" });
      }

      const parsed = parseSiwe(message);
      if (!parsed) return res.status(400).json({ ok: false, error: "Malformed sign-in message" });

      // Domain binding: parsed `domain` and parsed `URI` host must match
      // an allowed host (or the request's Host as dev fallback).
      const uriHost = originHost(parsed.uri);
      if (hosts.size > 0) {
        if (!hosts.has(parsed.domain.toLowerCase())) return res.status(400).json({ ok: false, error: "Sign-in domain mismatch" });
        if (!hosts.has(uriHost)) return res.status(400).json({ ok: false, error: "Sign-in URI host mismatch" });
      }
      if (parsed.version !== "1") return res.status(400).json({ ok: false, error: "Unsupported sign-in version" });
      if (parsed.address.toLowerCase() !== wallet.toLowerCase()) {
        return res.status(400).json({ ok: false, error: "Wallet address mismatch" });
      }

      const issuedAtMs = Date.parse(parsed.issuedAt);
      const now = Date.now();
      if (!Number.isFinite(issuedAtMs) || issuedAtMs > now + 60_000 || issuedAtMs < now - 10 * 60_000) {
        return res.status(401).json({ ok: false, error: "Sign-in expired or clock skewed" });
      }
      if (parsed.expirationTime) {
        const expMs = Date.parse(parsed.expirationTime);
        if (!Number.isFinite(expMs) || expMs <= now) return res.status(401).json({ ok: false, error: "Sign-in expired" });
        if (expMs - issuedAtMs > 60 * 60 * 1000) return res.status(400).json({ ok: false, error: "Expiration too far in the future" });
      }

      // Verify signature BEFORE burning the nonce (so a bad signer can't
      // exhaust nonces).
      let recovered: string;
      try { recovered = ethers.verifyMessage(message, signature); }
      catch { return res.status(401).json({ ok: false, error: "Signature invalid" }); }
      if (recovered.toLowerCase() !== wallet.toLowerCase()) {
        return res.status(401).json({ ok: false, error: "Signature address mismatch" });
      }
      if (!consumeNonce(parsed.nonce)) {
        return res.status(401).json({ ok: false, error: "Nonce invalid or already used" });
      }

      const expires = Date.now() + SESSION_TTL_MS;
      const token = signSession(recovered, expires);
      const isProd = process.env.NODE_ENV === "production";
      const cookieParts = [
        `${COOKIE_NAME}=${encodeURIComponent(token)}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      ];
      if (isProd) cookieParts.push("Secure");
      res.setHeader("Set-Cookie", cookieParts.join("; "));
      res.json({ ok: true, wallet: recovered.toLowerCase(), expiresMs: expires });
    } catch (e: any) {
      console.error("[wallet-routes] SIWE error:", e?.message);
      res.status(500).json({ ok: false, error: "Sign-in failed. Please try again." });
    }
  });

  app.get("/api/auth/session", (req, res) => {
    const sess = verifySession(readCookie(req, COOKIE_NAME));
    res.json({ ok: true, authenticated: !!sess, wallet: sess?.wallet ?? null });
  });

  app.post("/api/auth/logout", (_req, res) => {
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });

  // ── Telegram-link claim flow ────────────────────────────────────────
  // Site issues a one-time token bound to the SIWE'd web wallet. User
  // taps the deep link → opens @build4_bot with start=link_<token>. The
  // bot's start handler POSTs back to /redeem with the token + the
  // tapper's Telegram ID + the shared bearer secret. We then know
  // (web wallet, telegram ID) and resolveCustodial() can find the
  // user's bot wallet on every subsequent request.

  app.post("/api/wallet/link-telegram/start", requireSession, safeHandler(async (req: AuthedRequest, res: Response) => {
    await ensureLinkTable();
    // Re-issuing always rotates the token (5-min TTL). Existing linkage
    // is preserved — telegram_id is only updated on successful redeem.
    const token = crypto.randomBytes(16).toString("hex");
    const expires = Date.now() + 5 * 60 * 1000;
    await upsertLinkToken(req.authedWallet!, token, expires);
    res.json({
      ok: true,
      url: botLinkStartUrl(token),
      token,
      expiresAt: expires,
      botUsername: (process.env.BOT_USERNAME || "build4_bot").replace(/^@/, ""),
    });
  }, "Link start"));

  app.get("/api/wallet/link-telegram/status", requireSession, safeHandler(async (req: AuthedRequest, res: Response) => {
    await ensureLinkTable();
    const link = await getLinkByWebWallet(req.authedWallet!);
    if (!link || !link.telegramId || !link.linkedAt) {
      res.json({ ok: true, linked: false });
      return;
    }
    const cust = await lookupBotCustodialByTelegramId(link.telegramId);
    res.json({
      ok: true,
      linked: true,
      telegramId: link.telegramId,
      linkedAt: link.linkedAt,
      custodialAddress: cust?.address ?? null,
      custodialReady: !!cust,
    });
  }, "Link status"));

  // Bot → site server-to-server callback. Authed by a shared bearer.
  app.post("/api/wallet/link-telegram/redeem", async (req, res) => {
    try {
      const auth = String(req.headers.authorization || "");
      const expectedSecret = process.env.LINK_SHARED_SECRET;
      if (!expectedSecret || expectedSecret.length < 16) {
        console.error("[wallet-routes] LINK_SHARED_SECRET missing or too short — rejecting redeem");
        return res.status(503).json({ ok: false, error: "link_disabled" });
      }
      const expected = `Bearer ${expectedSecret}`;
      // Constant-time compare to avoid timing oracles.
      const ok = auth.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
      if (!ok) return res.status(401).json({ ok: false, error: "unauthorized" });

      const { token, telegramId } = req.body ?? {};
      if (typeof token !== "string" || typeof telegramId !== "string") {
        return res.status(400).json({ ok: false, error: "token+telegramId required" });
      }
      await ensureLinkTable();
      const result = await redeemLinkToken(token.toLowerCase(), telegramId);
      if (!result.ok) return res.status(400).json({ ok: false, error: result.reason });
      console.log(`[wallet-routes] LINK_REDEEMED webWallet=${result.webWallet} telegramId=${telegramId}`);
      res.json({ ok: true, webWallet: result.webWallet });
    } catch (e: any) {
      console.error("[wallet-routes] redeem error:", e?.message);
      res.status(500).json({ ok: false, error: "redeem_failed" });
    }
  });


  // 3. Deposit info — returns the user's CUSTODIAL address (not the
  //    connected EOA) and the chain catalog. Same EVM address works on
  //    every supported chain.
  app.get("/api/wallet/deposit-info", requireSession, safeHandler(async (req: AuthedRequest, res: Response) => {
    const r = await resolveCustodial(req.authedWallet!);
    if (!r.ok) {
      const err = helpfulCustodialError(r.reason);
      res.status(err.status).json(err.body);
      return;
    }
    res.json({
      ok: true,
      address: r.data.address,
      telegramId: r.data.telegramId,
      chains: Object.entries(CHAINS).map(([key, c]) => ({
        key, id: c.id, name: c.name, explorer: c.explorer, nativeSymbol: c.nativeSymbol,
        tokens: Object.entries(c.tokens).map(([sym, t]) => ({ symbol: sym, address: t.address, decimals: t.decimals })),
      })),
      note: "Same address on every EVM chain. Send only on the chain you select — funds sent on the wrong chain may be unrecoverable.",
    });
  }, "Deposit info"));

  // 4. Balance probe — native + listed ERC20s on the selected chain.
  app.get("/api/wallet/balance", requireSession, safeHandler(async (req: AuthedRequest, res: Response) => {
    const chainKey = String(req.query.chain || "").toLowerCase();
    const cfg = CHAINS[chainKey];
    if (!cfg) { res.status(400).json({ ok: false, error: "Unknown chain" }); return; }
    const r = await resolveCustodial(req.authedWallet!);
    if (!r.ok) { const err = helpfulCustodialError(r.reason); res.status(err.status).json(err.body); return; }
    const provider = buildProvider(cfg);
    const owner = ethers.getAddress(r.data.address);
    const native = await provider.getBalance(owner).catch(() => BigInt(0));
    const tokens: any[] = [];
    for (const [sym, t] of Object.entries(cfg.tokens)) {
      try {
        const c = new ethers.Contract(t.address, ERC20_ABI, provider);
        const bal: bigint = await c.balanceOf(owner);
        tokens.push({ symbol: sym, decimals: t.decimals, balance: ethers.formatUnits(bal, t.decimals), wei: bal.toString() });
      } catch {
        tokens.push({ symbol: sym, decimals: t.decimals, balance: "0", wei: "0", error: "rpc unavailable" });
      }
    }
    res.json({
      ok: true, chain: chainKey, address: owner,
      native: { symbol: cfg.nativeSymbol, balance: ethers.formatEther(native), wei: native.toString() },
      tokens,
    });
  }, "Balance"));

  // 5. Reveal custodial private key — most sensitive action on the site.
  app.post("/api/wallet/reveal-pk", requireSession, safeHandler(async (req: AuthedRequest, res: Response) => {
    const wallet = req.authedWallet!;
    if (!checkRevealRate(wallet)) { res.status(429).json({ ok: false, error: "Too many reveal attempts. Try again later." }); return; }
    const r = await resolveCustodial(wallet);
    if (!r.ok) { const err = helpfulCustodialError(r.reason); res.status(err.status).json(err.body); return; }
    if (!r.data.encryptedPK) { res.status(404).json({ ok: false, error: "No encrypted key on file for this wallet." }); return; }
    let pk: string;
    try { pk = decryptBotPk(r.data.encryptedPK, r.data.userId); }
    catch (e: any) {
      const reason = e?.message === "legacy_format_use_telegram"
        ? "This wallet uses an older format. Please export it from the Telegram bot via /wallet → Export Private Key."
        : "This wallet is PIN-protected. Please export it from the Telegram bot via /wallet → Export Private Key.";
      res.status(409).json({ ok: false, error: reason, code: "USE_TELEGRAM_EXPORT" });
      return;
    }
    console.warn(`[wallet-routes] PK_REVEALED authed=${wallet} custodial=${r.data.address} telegramId=${r.data.telegramId} ts=${new Date().toISOString()} ip=${req.ip}`);
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      privateKey: pk,
      address: r.data.address,
      warning: "This is your custodial private key. Never share it. We won't show it again automatically.",
    });
  }, "Reveal"));

  // 6. Cross-chain withdraw from the custodial wallet.
  app.post("/api/wallet/withdraw", requireSession, safeHandler(async (req: AuthedRequest, res: Response) => {
    const { chain, token, amount, toAddress } = req.body ?? {};
    const cfg = CHAINS[String(chain || "").toLowerCase()];
    if (!cfg) { res.status(400).json({ ok: false, error: "Unknown chain" }); return; }
    if (!amount || Number(amount) <= 0) { res.status(400).json({ ok: false, error: "Amount must be > 0" }); return; }
    let to: string;
    try { to = ethers.getAddress(String(toAddress)); }
    catch { res.status(400).json({ ok: false, error: "Invalid recipient address" }); return; }

    const r = await resolveCustodial(req.authedWallet!);
    if (!r.ok) { const err = helpfulCustodialError(r.reason); res.status(err.status).json(err.body); return; }
    if (!r.data.encryptedPK) { res.status(404).json({ ok: false, error: "No encrypted key on file." }); return; }
    let pk: string;
    try { pk = decryptBotPk(r.data.encryptedPK, r.data.userId); }
    catch {
      res.status(409).json({ ok: false, error: "This wallet is PIN-protected. Please withdraw via the Telegram bot.", code: "USE_TELEGRAM_WITHDRAW" });
      return;
    }

    const provider = buildProvider(cfg);
    const signer = new ethers.Wallet(pk, provider);
    const tokenKey = String(token || "native").trim();
    console.log(`[wallet-routes] WITHDRAW authed=${req.authedWallet} from=${r.data.address} chain=${chain} token=${tokenKey} amount=${amount} to=${to}`);

    try {
      if (tokenKey.toLowerCase() === "native") {
        const value = ethers.parseEther(String(amount));
        const tx = await signer.sendTransaction({ to, value });
        const receipt = await tx.wait();
        res.json({ ok: true, txHash: tx.hash, blockNumber: receipt?.blockNumber, explorer: `${cfg.explorer}/tx/${tx.hash}` });
        return;
      }
      const meta = cfg.tokens[tokenKey];
      if (!meta) { res.status(400).json({ ok: false, error: `Unknown token ${tokenKey} on ${cfg.name}` }); return; }
      const c = new ethers.Contract(meta.address, ERC20_ABI, signer);
      let dec = meta.decimals;
      try { dec = Number(await c.decimals()); } catch {}
      const wei = ethers.parseUnits(String(amount), dec);
      const tx = await c.transfer(to, wei);
      const receipt = await tx.wait();
      res.json({ ok: true, txHash: tx.hash, blockNumber: receipt?.blockNumber, explorer: `${cfg.explorer}/tx/${tx.hash}` });
    } catch (e: any) {
      // Sanitize: log details server-side, return a safe summary to the client.
      const raw = e?.shortMessage || e?.info?.error?.message || e?.message || "unknown";
      console.error(`[wallet-routes] WITHDRAW raw error: ${raw}`);
      let friendly = "Withdraw failed. Check your custodial gas balance and try again.";
      if (/insufficient funds|gas required exceeds/i.test(raw)) friendly = "Insufficient gas in your custodial wallet on this chain.";
      else if (/transfer amount exceeds balance|ERC20: transfer amount/i.test(raw)) friendly = "Insufficient token balance in your custodial wallet.";
      else if (/nonce/i.test(raw)) friendly = "Network is busy. Please wait a moment and retry.";
      res.status(400).json({ ok: false, error: friendly });
    }
  }, "Withdraw"));
}
