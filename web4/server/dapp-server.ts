import express, { type Request, type Response, type NextFunction } from "express";
import helmet from "helmet";
import { verifyMessage } from "ethers";
import { SignJWT, jwtVerify } from "jose";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const STATIC_DIR = path.join(ROOT, "dist", "public");

const PORT = Number(process.env.DAPP_PORT || process.env.PORT || 8080);
const SESSION_SECRET = new TextEncoder().encode(
  process.env.DAPP_SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
);
const COOKIE_NAME = "build4_dapp_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

const nonces = new Map<string, { nonce: string; expiresAt: number }>();
function pruneNonces() {
  const now = Date.now();
  for (const [k, v] of nonces.entries()) if (v.expiresAt < now) nonces.delete(k);
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "256kb" }));
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "data:", "https:", "blob:"],
        connectSrc: [
          "'self'",
          "https://*.walletconnect.com",
          "wss://*.walletconnect.com",
          "https://*.walletconnect.org",
          "wss://*.walletconnect.org",
          "https://rpc.walletconnect.com",
          "https://relay.walletconnect.com",
          "wss://relay.walletconnect.com",
          "https://*.replit.dev",
          "wss://*.replit.dev",
          "https://*.replit.app",
        ],
        frameSrc: ["'self'", "https://verify.walletconnect.com", "https://verify.walletconnect.org"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(v.join("="));
  }
  return out;
}

async function getSession(req: Request): Promise<{ address: string } | null> {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, SESSION_SECRET);
    if (typeof payload.sub === "string") return { address: payload.sub };
  } catch {
    return null;
  }
  return null;
}

app.get("/api/web4/walletconnect-config", (_req, res) => {
  const projectId = process.env.WALLETCONNECT_PROJECT_ID || process.env.VITE_WALLETCONNECT_PROJECT_ID;
  if (!projectId) return res.status(404).json({ error: "WalletConnect not configured" });
  res.json({ projectId });
});

app.get("/api/web4/contracts", (_req, res) => {
  res.json({ deployments: {} });
});

app.get("/api/web4/nonce", (req, res) => {
  pruneNonces();
  const addr = String(req.query.address || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return res.status(400).json({ error: "invalid address" });
  const nonce = crypto.randomBytes(16).toString("hex");
  nonces.set(addr, { nonce, expiresAt: Date.now() + 5 * 60 * 1000 });
  res.json({ nonce });
});

type SiweFields = {
  domain: string;
  address: string;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt: Date;
  expirationTime: Date | null;
};

function parseSiweMessage(message: string): SiweFields {
  const lines = message.split("\n");
  if (lines.length < 8) throw new Error("malformed message (too few lines)");
  const m1 = lines[0].match(/^(\S+) wants you to sign in with your Ethereum account:$/);
  if (!m1) throw new Error("missing or malformed domain header");
  const domain = m1[1];
  const address = lines[1].trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("invalid address line");

  const getField = (key: string): string | null => {
    const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
    const m = message.match(re);
    return m ? m[1].trim() : null;
  };

  const uri = getField("URI");
  const version = getField("Version");
  const chainIdStr = getField("Chain ID");
  const nonce = getField("Nonce");
  const issuedAtStr = getField("Issued At");
  const expirationTimeStr = getField("Expiration Time");

  if (!uri || !version || !chainIdStr || !nonce || !issuedAtStr) {
    throw new Error("missing required SIWE field");
  }
  const chainId = Number(chainIdStr);
  if (!Number.isFinite(chainId) || chainId <= 0) throw new Error("invalid chain id");
  const issuedAt = new Date(issuedAtStr);
  if (Number.isNaN(issuedAt.getTime())) throw new Error("invalid issuedAt");
  let expirationTime: Date | null = null;
  if (expirationTimeStr) {
    expirationTime = new Date(expirationTimeStr);
    if (Number.isNaN(expirationTime.getTime())) throw new Error("invalid expirationTime");
  }
  return { domain, address, uri, version, chainId, nonce, issuedAt, expirationTime };
}

function getAllowedHosts(req: Request): string[] {
  const fromEnv = (process.env.DAPP_ALLOWED_HOSTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (fromEnv.length > 0) return fromEnv;
  const reqHost = (req.get("host") || "").toLowerCase();
  return reqHost ? [reqHost] : [];
}

app.post("/api/web4/siwe", async (req: Request, res: Response) => {
  pruneNonces();
  const { message, signature, address } = (req.body || {}) as {
    message?: string;
    signature?: string;
    address?: string;
  };
  if (!message || !signature || !address) return res.status(400).json({ error: "missing fields" });
  if (typeof message !== "string" || message.length > 4000) return res.status(400).json({ error: "invalid message" });
  if (typeof signature !== "string" || signature.length > 200) return res.status(400).json({ error: "invalid signature" });
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) return res.status(400).json({ error: "invalid address" });

  const lowered = address.toLowerCase();
  const stored = nonces.get(lowered);
  // Nonce is one-time-use: drop it now whether we succeed or fail
  nonces.delete(lowered);
  if (!stored) return res.status(400).json({ error: "no nonce — request /api/web4/nonce first" });
  if (stored.expiresAt < Date.now()) return res.status(400).json({ error: "nonce expired" });

  try {
    const allowedHosts = getAllowedHosts(req);
    if (allowedHosts.length === 0) {
      console.error("[dapp-server] no allowed hosts; refusing SIWE");
      return res.status(500).json({ error: "server misconfigured (no host)" });
    }

    // Origin/Referer check (defense in depth against cross-site POSTs)
    const origin = req.get("origin");
    if (origin) {
      let originHost: string;
      try { originHost = new URL(origin).host.toLowerCase(); } catch { return res.status(400).json({ error: "invalid origin" }); }
      if (!allowedHosts.includes(originHost)) return res.status(403).json({ error: `origin ${originHost} not allowed` });
    }

    const fields = parseSiweMessage(message);

    if (!allowedHosts.includes(fields.domain.toLowerCase())) {
      return res.status(401).json({ error: `domain ${fields.domain} not allowed` });
    }
    let uriHost: string;
    try { uriHost = new URL(fields.uri).host.toLowerCase(); } catch { return res.status(401).json({ error: "invalid URI in message" }); }
    if (!allowedHosts.includes(uriHost)) return res.status(401).json({ error: `URI host ${uriHost} not allowed` });

    if (fields.version !== "1") return res.status(401).json({ error: "unsupported SIWE version" });
    if (fields.address.toLowerCase() !== lowered) return res.status(401).json({ error: "address mismatch" });
    if (fields.nonce !== stored.nonce) return res.status(401).json({ error: "nonce mismatch" });

    const now = Date.now();
    const issuedMs = fields.issuedAt.getTime();
    if (issuedMs > now + 60_000) return res.status(401).json({ error: "issuedAt is in the future" });
    if (issuedMs < now - 10 * 60_000) return res.status(401).json({ error: "issuedAt too old" });
    if (fields.expirationTime) {
      const expMs = fields.expirationTime.getTime();
      if (expMs <= now) return res.status(401).json({ error: "message expired" });
      if (expMs > issuedMs + 60 * 60_000) return res.status(401).json({ error: "expiration too far in future" });
    }

    let recovered: string;
    try { recovered = verifyMessage(message, signature); } catch { return res.status(401).json({ error: "invalid signature" }); }
    if (recovered.toLowerCase() !== lowered) return res.status(401).json({ error: "signature does not match address" });

    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(lowered)
      .setIssuedAt()
      .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
      .sign(SESSION_SECRET);

    res.setHeader(
      "Set-Cookie",
      `${COOKIE_NAME}=${encodeURIComponent(jwt)}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
    );
    res.json({ ok: true, address: lowered });
  } catch (err: any) {
    console.error("[dapp-server] /api/web4/siwe error:", err?.message || err);
    res.status(401).json({ error: err?.message || "verification failed" });
  }
});

app.get("/api/web4/me", async (req, res) => {
  const session = await getSession(req);
  if (!session) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, address: session.address });
});

app.post("/api/web4/logout", (_req, res) => {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  res.json({ ok: true });
});

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "build4-dapp" }));

// ── /web-api/* — venue surface for the WalletConnect dApp ─────────────
//
// IDENTITY MODEL (decided Task #127, 2026-05-25):
//   Web-dApp sessions reuse the existing bot `User` row by matching the
//   SIWE-authenticated EOA against `Wallet.address` (case-insensitive) in
//   the bot DB. A `WebUser` table was considered and rejected: every
//   trading service in src/services/* keys provisioning (Aster agent PK,
//   HL agent PK, Polymarket Safe + L2 creds) off `User.id`, so duplicating
//   identity would mean either duplicating every provisioning service or
//   carrying a brittle WebUser→User join everywhere. Reusing User lets a
//   bot user who installs WalletConnect at /app immediately see the same
//   positions, balances, and Polymarket Safe they already have in
//   Telegram — zero migration.
//
//   Web-only users (WalletConnect address with no matching bot Wallet
//   row) get `{linked:false}` and are pointed at the Telegram bot for
//   first-time provisioning. Auto-creating bot Users from a SIWE
//   signature would require generating a custodial PK with no telegramId
//   (telegramId is a UNIQUE BigInt and is what every existing service
//   uses for encryption salt), which is a much larger schema change and
//   is deferred to a follow-up.
//
// All endpoints below are session-gated via getSession(). Endpoints that
// touch the bot DB lazy-import to keep the dApp boot light.

async function lookupBotUser(address: string): Promise<{
  user: any | null;
  wallet: any | null;
} > {
  const { db } = await import("../../src/db");
  const lowered = address.toLowerCase();
  // Wallet.address is stored case-sensitive in the bot DB (mix of
  // checksummed + lowercase from different code paths). Case-insensitive
  // match keeps this robust.
  const wallet = await db.wallet.findFirst({
    where: { address: { equals: lowered, mode: "insensitive" as const } },
  });
  if (!wallet) return { user: null, wallet: null };
  const user = await db.user.findUnique({ where: { id: wallet.userId } });
  return { user, wallet };
}

function requireSession(req: Request, res: Response): Promise<{ address: string } | null> {
  return getSession(req).then((s) => {
    if (!s) { res.status(401).json({ error: "not authenticated" }); return null; }
    return s;
  });
}

// ── Account linkage + summary ─────────────────────────────────────────
// Single endpoint the dashboard hits on load. Tells the UI whether the
// SIWE address has a bot User behind it and, if so, surfaces a per-venue
// summary so we don't make 7 separate calls just to paint the cards.
app.get("/web-api/account/state", async (req, res) => {
  const session = await requireSession(req, res); if (!session) return;
  try {
    const { user, wallet } = await lookupBotUser(session.address);
    if (!user) {
      return res.json({
        linked: false,
        address: session.address,
        hint: "No BUILD4 bot account is linked to this wallet. Open the Telegram bot (@build4_bot) and run /start — your bot wallet's address must match the wallet you connected here.",
      });
    }

    const { db } = await import("../../src/db");
    const [polyCreds, polyOpenCount, ftOpenCount, ftClosedCount, agentsCount] = await Promise.all([
      db.polymarketCreds.findUnique({ where: { userId: user.id } }),
      db.polymarketPosition.count({ where: { userId: user.id, status: { in: ["placed", "matched", "filled"] } } }),
      db.outcomePosition.count({ where: { userId: user.id, status: "open" } }),
      db.outcomePosition.count({ where: { userId: user.id, status: { in: ["resolved_win", "resolved_loss", "closed"] } } }),
      db.agent.count({ where: { userId: user.id, isActive: true } }),
    ]);

    res.json({
      linked: true,
      address: session.address,
      userId: user.id,
      bscWalletAddress: wallet?.address ?? null,
      agentsActive: agentsCount,
      venues: {
        aster: {
          onboarded: Boolean(user.asterOnboarded),
          agentAddress: user.asterAgentAddress ?? null,
          tradingEnabled: user.asterAgentTradingEnabled !== false,
        },
        hyperliquid: {
          onboarded: Boolean(user.hyperliquidOnboarded),
          agentAddress: user.hyperliquidAgentAddress ?? null,
          tradingEnabled: user.hyperliquidAgentTradingEnabled !== false,
          unified: Boolean(user.hyperliquidUnified),
        },
        fortytwo: {
          liveTrade: user.fortyTwoLiveTrade !== false,
          openCount: ftOpenCount,
          closedCount: ftClosedCount,
        },
        polymarket: {
          tradingEnabled: user.polymarketAgentTradingEnabled !== false,
          safeAddress: polyCreds?.safeAddress ?? null,
          safeDeployedAt: polyCreds?.safeDeployedAt ?? null,
          eoaAddress: polyCreds?.walletAddress ?? null,
          openCount: polyOpenCount,
        },
      },
    });
  } catch (e: any) {
    console.error("[dapp-server] /web-api/account/state:", e?.message || e);
    res.status(500).json({ error: "lookup_failed", detail: e?.message ?? String(e) });
  }
});

// ── Polymarket: real interactive venue ────────────────────────────────
// These proxy the existing src/services/polymarketTrading.ts entry
// points. They are the same calls the bot's HTTP /api/polymarket/*
// handlers make, so behaviour (gasless Safe, builder attribution,
// slippage cap) is identical.

app.get("/web-api/polymarket/state", async (req, res) => {
  const session = await requireSession(req, res); if (!session) return;
  try {
    const { user } = await lookupBotUser(session.address);
    if (!user) return res.status(403).json({ error: "no_linked_bot_account" });

    const poly = await import("../../src/services/polymarketTrading");
    const { db } = await import("../../src/db");

    const creds = await db.polymarketCreds.findUnique({ where: { userId: user.id } });
    let balances: any = null;
    if (creds?.safeAddress) {
      try { balances = await poly.getPolygonBalances(creds.safeAddress); }
      catch (e: any) { balances = { error: e?.message ?? "balance_read_failed" }; }
    }
    const positions = await poly.getUserPositions(user.id);
    res.json({
      safeAddress: creds?.safeAddress ?? null,
      safeDeployedAt: creds?.safeDeployedAt ?? null,
      eoaAddress: creds?.walletAddress ?? null,
      balances,
      positions,
    });
  } catch (e: any) {
    console.error("[dapp-server] /web-api/polymarket/state:", e?.message || e);
    res.status(500).json({ error: "state_failed", detail: e?.message ?? String(e) });
  }
});

app.post("/web-api/polymarket/setup", async (req, res) => {
  const session = await requireSession(req, res); if (!session) return;
  try {
    const { user } = await lookupBotUser(session.address);
    if (!user) return res.status(403).json({ error: "no_linked_bot_account" });

    const poly = await import("../../src/services/polymarketTrading");
    // Sequence mirrors the bot's /api/polymarket/setup handler:
    //   1. derive/persist L2 creds (apiKey + secret + passphrase)
    //   2. deploy gasless Safe
    //   3. batch USDC×3 + CTF×3 approvals via relayer
    await poly.getOrCreateCreds(user.id);
    const safe = await poly.deploySafeIfNeeded(user.id);
    const allowance = await poly.ensureUsdcAllowance(user.id);
    res.json({ ok: true, safe, allowance });
  } catch (e: any) {
    console.error("[dapp-server] /web-api/polymarket/setup:", e?.message || e);
    res.status(500).json({ error: "setup_failed", detail: e?.message ?? String(e) });
  }
});

app.post("/web-api/polymarket/order", async (req, res) => {
  const session = await requireSession(req, res); if (!session) return;
  try {
    const { user } = await lookupBotUser(session.address);
    if (!user) return res.status(403).json({ error: "no_linked_bot_account" });

    const { tokenId, side, amount, marketCtx, expectedPrice, maxSlippageBps } = (req.body || {}) as any;
    if (!tokenId || typeof tokenId !== "string") return res.status(400).json({ error: "missing_token_id" });
    if (side !== "BUY" && side !== "SELL") return res.status(400).json({ error: "invalid_side" });
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: "invalid_amount" });
    if (!marketCtx || typeof marketCtx !== "object") return res.status(400).json({ error: "missing_market_ctx" });
    if (!marketCtx.conditionId || !marketCtx.marketTitle || !marketCtx.outcomeLabel) {
      return res.status(400).json({ error: "incomplete_market_ctx" });
    }

    const poly = await import("../../src/services/polymarketTrading");
    const result = await poly.placeMarketOrder({
      userId: user.id,
      tokenId,
      side,
      amount: amt,
      marketCtx: {
        conditionId: String(marketCtx.conditionId),
        marketSlug: marketCtx.marketSlug ? String(marketCtx.marketSlug) : undefined,
        marketTitle: String(marketCtx.marketTitle).slice(0, 240),
        outcomeLabel: String(marketCtx.outcomeLabel).slice(0, 60),
      },
      reasoning: "web-dapp manual trade",
      expectedPrice: expectedPrice ? Number(expectedPrice) : undefined,
      maxSlippageBps: maxSlippageBps ? Number(maxSlippageBps) : 500,
    });
    res.json(result);
  } catch (e: any) {
    console.error("[dapp-server] /web-api/polymarket/order:", e?.message || e);
    res.status(500).json({ error: "order_failed", detail: e?.message ?? String(e) });
  }
});

app.post("/web-api/polymarket/redeem", async (req, res) => {
  const session = await requireSession(req, res); if (!session) return;
  try {
    const { user } = await lookupBotUser(session.address);
    if (!user) return res.status(403).json({ error: "no_linked_bot_account" });

    const { conditionId, isNegRisk } = (req.body || {}) as any;
    if (!conditionId || typeof conditionId !== "string") return res.status(400).json({ error: "missing_condition_id" });

    const poly = await import("../../src/services/polymarketTrading");
    const result = await poly.redeemPositions({ userId: user.id, conditionId, isNegRisk: Boolean(isNegRisk) });
    res.json(result);
  } catch (e: any) {
    console.error("[dapp-server] /web-api/polymarket/redeem:", e?.message || e);
    res.status(500).json({ error: "redeem_failed", detail: e?.message ?? String(e) });
  }
});

// ── 42.space: account state + positions ───────────────────────────────
app.get("/web-api/fortytwo/state", async (req, res) => {
  const session = await requireSession(req, res); if (!session) return;
  try {
    const { user, wallet } = await lookupBotUser(session.address);
    if (!user) return res.status(403).json({ error: "no_linked_bot_account" });
    const { db } = await import("../../src/db");
    const [open, recent] = await Promise.all([
      db.outcomePosition.findMany({
        where: { userId: user.id, status: "open" },
        orderBy: { openedAt: "desc" },
        take: 25,
      }),
      db.outcomePosition.findMany({
        where: { userId: user.id, status: { in: ["resolved_win", "resolved_loss", "closed"] } },
        orderBy: { openedAt: "desc" },
        take: 25,
      }),
    ]);
    res.json({
      walletAddress: wallet?.address ?? null,
      liveTrade: user.fortyTwoLiveTrade !== false,
      open,
      recent,
    });
  } catch (e: any) {
    console.error("[dapp-server] /web-api/fortytwo/state:", e?.message || e);
    res.status(500).json({ error: "list_failed", detail: e?.message ?? String(e) });
  }
});

// POST /web-api/fortytwo/buy — open a position on a 42.space outcome
// market. Mirrors the bot's /api/predictions/buy. The bot mini-app
// provides a market browser; here we expose the raw entry point so the
// dApp can pass a marketAddress + tokenId discovered from the open
// positions list (or pasted in). Market browser ships in follow-up.
app.post("/web-api/fortytwo/buy", async (req, res) => {
  const session = await requireSession(req, res); if (!session) return;
  try {
    const { user } = await lookupBotUser(session.address);
    if (!user) return res.status(403).json({ error: "no_linked_bot_account" });
    const { marketAddress, tokenId, usdtAmount } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof marketAddress !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(marketAddress)) {
      return res.status(400).json({ error: "invalid_market_address" });
    }
    const tid = Number(tokenId);
    const amt = Number(usdtAmount);
    if (!Number.isFinite(tid) || tid < 0) return res.status(400).json({ error: "invalid_token_id" });
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: "invalid_amount" });
    const { openManualPredictionPosition } = await import("../../src/services/fortyTwoExecutor");
    const result = await openManualPredictionPosition({
      userId: user.id, marketAddress, tokenId: tid, usdtAmount: amt,
    });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (e: any) {
    console.error("[dapp-server] /web-api/fortytwo/buy:", e?.message || e);
    res.status(500).json({ error: "buy_failed", detail: e?.message ?? String(e) });
  }
});

// POST /web-api/fortytwo/sell — close one open position. Mirrors
// /api/predictions/sell.
app.post("/web-api/fortytwo/sell", async (req, res) => {
  const session = await requireSession(req, res); if (!session) return;
  try {
    const { user } = await lookupBotUser(session.address);
    if (!user) return res.status(403).json({ error: "no_linked_bot_account" });
    const positionId = typeof req.body?.positionId === "string" ? req.body.positionId : "";
    if (!positionId) return res.status(400).json({ error: "invalid_position_id" });
    const { closeUserPredictionPosition } = await import("../../src/services/fortyTwoExecutor");
    const result = await closeUserPredictionPosition(user.id, positionId);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: "sell_failed", detail: e?.message ?? String(e) });
  }
});

// POST /web-api/fortytwo/claim-all — sweep resolved-winning positions.
// Mirrors /api/predictions/claim-all.
app.post("/web-api/fortytwo/claim-all", async (req, res) => {
  const session = await requireSession(req, res); if (!session) return;
  try {
    const { user } = await lookupBotUser(session.address);
    if (!user) return res.status(403).json({ error: "no_linked_bot_account" });
    const { claimAllUserResolved } = await import("../../src/services/fortyTwoExecutor");
    const result = await claimAllUserResolved(user.id);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: "claim_failed", detail: e?.message ?? String(e) });
  }
});

// Back-compat alias for the original Phase-2 positions endpoint.
app.get("/web-api/fortytwo/positions", async (req, res) => {
  const session = await requireSession(req, res); if (!session) return;
  try {
    const { user } = await lookupBotUser(session.address);
    if (!user) return res.status(403).json({ error: "no_linked_bot_account" });
    const { db } = await import("../../src/db");
    const positions = await db.outcomePosition.findMany({
      where: { userId: user.id },
      orderBy: { openedAt: "desc" },
      take: 50,
    });
    res.json({ positions });
  } catch (e: any) {
    res.status(500).json({ error: "list_failed", detail: e?.message ?? String(e) });
  }
});

// ── Aster: state, provisioning, balance, positions ────────────────────
//
// PROVISIONING MODEL (bot-linked users only):
//   The Aster activate flow requires signing EIP-712 ApproveAgent with
//   the user's BSC custodial private key (Aster's onboarding contract
//   verifies the master-account signature on-chain). For bot-linked
//   users we already have that PK (encrypted at `Wallet.encryptedPK`
//   under the user's id), so the web dApp can run the SAME flow as the
//   bot's `/api/aster/approve` handler: decrypt PK → mint fresh agent
//   keypair → call approveAgent → call approveBuilder → persist the
//   agent address + encrypted agent PK on the User row. Once
//   `asterOnboarded=true`, the existing background trading agents +
//   broker resolveAgentCreds path Just Works for this user from both
//   surfaces (bot + dApp).
//
// For WalletConnect-only users (no bot Wallet row), provisioning is
// blocked at the lookup step — they get the "link your bot account
// first" CTA. That's tracked as follow-up #133 + #134.

app.get("/web-api/aster/state", async (req, res) => {
  const session = await requireSession(req, res); if (!session) return;
  try {
    const { user, wallet } = await lookupBotUser(session.address);
    if (!user) return res.status(403).json({ error: "no_linked_bot_account" });
    res.json({
      onboarded: Boolean(user.asterOnboarded),
      agentAddress: user.asterAgentAddress ?? null,
      tradingEnabled: user.asterAgentTradingEnabled !== false,
      walletAddress: wallet?.address ?? null,
    });
  } catch (e: any) {
    res.status(500).json({ error: "state_failed", detail: e?.message ?? String(e) });
  }
});

// POST /web-api/aster/approve — bot-linked users only.
// Mirrors `app.post('/api/aster/approve', ...)` in src/server.ts. Kept
// inline (rather than calling the bot endpoint) so we don't introduce a
// cross-process HTTP hop. The actual mint + approveAgent + approveBuilder
// call chain reuses the exact same service-layer functions, so the on-
// chain effect is identical.
app.post("/web-api/aster/approve", async (req, res) => {
  const session = await requireSession(req, res); if (!session) return;
  try {
    const { user, wallet } = await lookupBotUser(session.address);
    if (!user) return res.status(403).json({ error: "no_linked_bot_account" });
    if (!wallet || !wallet.encryptedPK) return res.status(404).json({ error: "no_active_wallet" });

    const builderAddress = process.env.ASTER_BUILDER_ADDRESS;
    const feeRate = process.env.ASTER_BUILDER_FEE_RATE ?? "0.0001";
    if (!builderAddress) return res.status(500).json({ error: "platform_no_builder" });

    const { decryptPrivateKey, encryptPrivateKey } = await import("../../src/services/wallet");
    const { approveAgent, approveBuilder } = await import("../../src/services/aster");
    const { ethers } = await import("ethers");

    // Idempotent short-circuit (same logic as bot endpoint).
    if (user.asterOnboarded && user.asterAgentEncryptedPK) {
      try {
        const dec = decryptPrivateKey(user.asterAgentEncryptedPK, user.id);
        if (dec?.startsWith("0x")) {
          return res.json({ ok: true, alreadyOnboarded: true, agentAddress: user.asterAgentAddress });
        }
      } catch { /* fall through to re-approve */ }
    }

    // Decrypt custodial PK, trying both historic salt candidates.
    let userPk: string | null = null;
    for (const cand of [user.id, user.telegramId?.toString(), wallet.userId].filter(Boolean) as string[]) {
      try {
        const out = decryptPrivateKey(wallet.encryptedPK, cand);
        if (out?.startsWith("0x")) { userPk = out; break; }
      } catch { /* try next */ }
    }
    if (!userPk) return res.status(500).json({ error: "decrypt_failed" });

    // Per-user fresh agent keypair (Aster forbids agent reuse across users).
    let agentWallet: { address: string; privateKey: string };
    if (user.asterAgentEncryptedPK) {
      try {
        const dec = decryptPrivateKey(user.asterAgentEncryptedPK, user.id);
        const w = new ethers.Wallet(dec);
        agentWallet = { address: w.address, privateKey: dec };
      } catch {
        const w = ethers.Wallet.createRandom();
        agentWallet = { address: w.address, privateKey: w.privateKey };
      }
    } else {
      const w = ethers.Wallet.createRandom();
      agentWallet = { address: w.address, privateKey: w.privateKey };
    }

    const result = await approveAgent({
      userAddress: wallet.address,
      userPrivateKey: userPk,
      agentAddress: agentWallet.address,
      agentName: "BUILD4Agent",
      builderAddress,
      maxFeeRate: feeRate,
      expiredDays: 365,
    });
    if (!result.success) {
      const errStr = String(result.error ?? "").toLowerCase();
      const noAccount = errStr.includes("no aster user") || errStr.includes("user not found") || errStr.includes("account does not exist");
      // Don't run the on-chain USDT bootstrap here (bot endpoint does it);
      // web users with a brand-new Aster wallet are pointed at the bot for
      // the deposit flow since it requires gas BNB + USDT staging.
      return res.status(400).json({
        error: "approve_failed",
        detail: result.error,
        needsAsterAccount: noAccount,
        hint: noAccount ? "Your wallet has no Aster account yet. Open @build4_bot and tap Activate Aster — it will bootstrap the on-chain deposit and retry." : undefined,
      });
    }

    // approveBuilder is non-fatal (same as bot path).
    const builderResult = await approveBuilder({
      userAddress: wallet.address,
      userPrivateKey: userPk,
      builderAddress,
      maxFeeRate: feeRate,
    });
    if (!builderResult.success) {
      console.warn("[/web-api/aster/approve] approveBuilder non-fatal failure:", builderResult.error);
    }

    const agentEncryptedPK = encryptPrivateKey(agentWallet.privateKey, user.id);
    userPk = "";
    const { db } = await import("../../src/db");
    await db.user.update({
      where: { id: user.id },
      data: {
        asterOnboarded: true,
        asterAgentAddress: agentWallet.address,
        asterAgentEncryptedPK: agentEncryptedPK,
      },
    });
    res.json({ ok: true, agentAddress: agentWallet.address });
  } catch (e: any) {
    console.error("[dapp-server] /web-api/aster/approve:", e?.message || e);
    res.status(500).json({ error: "approve_failed", detail: e?.message ?? String(e) });
  }
});

// POST /web-api/aster/order — MARKET-only order entry.
// Mirrors the bot's /api/aster/order: resolves agent creds, fetches mark
// price, rounds qty to symbol filters, runs the same margin pre-check,
// then routes through placeOrderWithBuilderCode so BUILD4 earns the
// builder kickback on this fill. We deliberately don't expose LIMIT or
// the stop-loss bracket here — manual LIMIT orders + brackets are a
// follow-up; this gives web users the same "open a position at market"
// surface the mini-app default uses.
app.post("/web-api/aster/order", async (req, res) => {
  const session = await requireSession(req, res); if (!session) return;
  try {
    const { user, wallet } = await lookupBotUser(session.address);
    if (!user) return res.status(403).json({ error: "no_linked_bot_account" });
    if (!wallet) return res.status(404).json({ error: "no_wallet" });
    if (!user.asterOnboarded) return res.status(400).json({ error: "not_onboarded", needsApprove: true });

    const { pair, side, notionalUsdt, leverage } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof pair !== "string" || !pair) return res.status(400).json({ error: "pair required" });
    if (side !== "LONG" && side !== "SHORT") return res.status(400).json({ error: "side must be LONG or SHORT" });
    const notional = Number(notionalUsdt);
    if (!Number.isFinite(notional) || notional <= 0) return res.status(400).json({ error: "notionalUsdt must be > 0" });
    const lev = Math.max(1, Math.min(50, Math.floor(Number(leverage) || 1)));

    const aster = await import("../../src/services/aster");
    const creds = await aster.resolveAgentCreds(user as any, wallet.address);
    if (!creds) return res.status(400).json({ error: "no_agent_creds", needsApprove: true });

    const sym = pair.replace(/[\/\s]/g, "").toUpperCase();
    const { markPrice } = await aster.getMarkPrice(sym);
    if (!Number.isFinite(markPrice) || markPrice <= 0) return res.status(503).json({ error: "mark_price_unavailable" });

    const filters = await aster.getSymbolFilters(sym);
    const rawQty = notional / markPrice;
    let qtyStr = filters
      ? aster.roundDownToStep(rawQty, filters.stepSize, filters.quantityPrecision)
      : rawQty.toFixed(6);
    let qty = parseFloat(qtyStr);
    if (filters && filters.stepSize > 0 && filters.minNotional > 0
        && qty * markPrice < filters.minNotional && qty * markPrice > 0) {
      const bumped = parseFloat(aster.roundDownToStep(qty + filters.stepSize, filters.stepSize, filters.quantityPrecision));
      if (bumped * markPrice >= filters.minNotional) qty = bumped;
    }
    if (qty <= 0) return res.status(400).json({ error: `Order too small — need at least ~$${(filters?.stepSize ?? 0) * markPrice} USDT for ${sym}` });
    if (filters && filters.minNotional > 0 && qty * markPrice < filters.minNotional) {
      const suggest = Math.ceil(filters.minNotional * 1.1);
      return res.status(400).json({ error: `Need ≥ $${filters.minNotional} USDT notional for ${sym}; try $${suggest}.` });
    }

    // Margin pre-check (same as bot path) so we surface a friendly error
    // rather than letting Aster reject downstream with "insufficient margin".
    try {
      const bal = await aster.getAccountBalanceStrict(creds);
      if (bal.usdt <= 0) return res.status(400).json({ error: `Aster balance is ${bal.usdt.toFixed(4)} USDT — deposit first` });
      const required = notional / lev;
      if (bal.availableMargin < required * 1.02) {
        return res.status(400).json({ error: `Insufficient margin: need ~$${required.toFixed(2)} (incl. fees), have $${bal.availableMargin.toFixed(2)} available.` });
      }
    } catch (e: any) {
      console.warn("[/web-api/aster/order] margin precheck failed (non-fatal):", e?.message);
    }

    const builderAddress = process.env.ASTER_BUILDER_ADDRESS;
    const feeRate = process.env.ASTER_BUILDER_FEE_RATE ?? "0.0001";

    const result = builderAddress
      ? await aster.placeOrderWithBuilderCode({
          symbol: sym, side: side === "LONG" ? "BUY" : "SELL", type: "MARKET",
          quantity: qty, leverage: lev, builderAddress, feeRate, creds,
        })
      : await aster.placeOrder({
          symbol: sym, side: side === "LONG" ? "BUY" : "SELL", type: "MARKET",
          quantity: qty, leverage: lev, creds, positionSide: "BOTH",
        });
    res.json({ ok: true, order: result });
  } catch (e: any) {
    const { friendlyAsterError } = await import("../../src/services/aster");
    const msg = friendlyAsterError(e);
    console.error("[dapp-server] /web-api/aster/order:", msg, "(raw:", e?.message, ")");
    res.status(502).json({ error: "order_failed", detail: msg });
  }
});

// POST /web-api/aster/orders/cancel — cancel a resting order. For now
// we don't expose listing resting orders in the dApp UI (market-only),
// but the endpoint exists for parity with the bot's mini-app.
app.post("/web-api/aster/orders/cancel", async (req, res) => {
  const session = await requireSession(req, res); if (!session) return;
  try {
    const { user, wallet } = await lookupBotUser(session.address);
    if (!user) return res.status(403).json({ error: "no_linked_bot_account" });
    if (!wallet) return res.status(404).json({ error: "no_wallet" });
    const { symbol, orderId } = (req.body ?? {}) as { symbol?: string; orderId?: number | string };
    if (!symbol || !orderId) return res.status(400).json({ error: "symbol+orderId required" });
    const aster = await import("../../src/services/aster");
    const creds = await aster.resolveAgentCreds(user as any, wallet.address);
    if (!creds) return res.status(400).json({ error: "no_agent_creds" });
    await aster.cancelOrder(String(symbol), Number(orderId), creds);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(502).json({ error: "cancel_failed", detail: e?.message ?? String(e) });
  }
});

// Combined Aster balance + positions. Mirrors the read paths used by
// the mini-app wallet card and positions tab.
app.get("/web-api/aster/account", async (req, res) => {
  const session = await requireSession(req, res); if (!session) return;
  try {
    const { user, wallet } = await lookupBotUser(session.address);
    if (!user) return res.status(403).json({ error: "no_linked_bot_account" });
    if (!wallet) return res.status(404).json({ error: "no_wallet" });
    if (!user.asterOnboarded) {
      return res.json({ onboarded: false, balance: null, positions: [] });
    }
    const aster = await import("../../src/services/aster");
    const creds = await aster.resolveAgentCreds(user as any, wallet.address);
    if (!creds) return res.status(400).json({ error: "no_agent_creds" });

    const [balance, positions] = await Promise.all([
      aster.getAccountBalance(creds).catch(() => ({ usdt: 0, availableMargin: 0 })),
      aster.getPositions(creds).catch(() => []),
    ]);
    res.json({ onboarded: true, walletAddress: wallet.address, balance, positions });
  } catch (e: any) {
    console.error("[dapp-server] /web-api/aster/account:", e?.message || e);
    res.status(502).json({ error: "account_failed", detail: e?.message ?? String(e) });
  }
});

// ── Hyperliquid: state, provisioning, account ─────────────────────────
//
// PROVISIONING: bot-linked users only. Mirrors `/api/hyperliquid/approve`.
// We deliberately omit the auto-bridge-from-Arbitrum path because that
// flow can take 60-90s and the dApp UX expects a fast 200/400 — if HL
// reports the master account isn't funded, we return a clean 400 with a
// CTA pointing the user at the bot's Activate button (which has the full
// bridge + retry orchestration).

app.get("/web-api/hyperliquid/state", async (req, res) => {
  const session = await requireSession(req, res); if (!session) return;
  try {
    const { user, wallet } = await lookupBotUser(session.address);
    if (!user) return res.status(403).json({ error: "no_linked_bot_account" });
    res.json({
      onboarded: Boolean(user.hyperliquidOnboarded),
      agentAddress: user.hyperliquidAgentAddress ?? null,
      tradingEnabled: user.hyperliquidAgentTradingEnabled !== false,
      unified: Boolean(user.hyperliquidUnified),
      walletAddress: wallet?.address ?? null,
    });
  } catch (e: any) {
    res.status(500).json({ error: "state_failed", detail: e?.message ?? String(e) });
  }
});

app.post("/web-api/hyperliquid/approve", async (req, res) => {
  const session = await requireSession(req, res); if (!session) return;
  try {
    const { user, wallet } = await lookupBotUser(session.address);
    if (!user) return res.status(403).json({ error: "no_linked_bot_account" });
    if (!wallet) return res.status(404).json({ error: "no_wallet" });

    if (user.hyperliquidOnboarded && user.hyperliquidAgentAddress && user.hyperliquidAgentEncryptedPK) {
      return res.json({ ok: true, alreadyOnboarded: true, agentAddress: user.hyperliquidAgentAddress });
    }

    const { decryptPrivateKey, encryptPrivateKey } = await import("../../src/services/wallet");
    const { approveAgent, approveBuilderFee, getAccountState, getSpotUsdcBalance } = await import("../../src/services/hyperliquid");
    const { ethers } = await import("ethers");

    let userPk: string | null = null;
    for (const cand of [user.id, user.telegramId?.toString()].filter(Boolean) as string[]) {
      try {
        const out = decryptPrivateKey(wallet.encryptedPK, cand);
        if (out?.startsWith("0x")) { userPk = out; break; }
      } catch { /* try next */ }
    }
    if (!userPk) return res.status(500).json({ error: "decrypt_failed" });

    const [accountBefore, spotBefore] = await Promise.all([
      getAccountState(wallet.address),
      getSpotUsdcBalance(wallet.address),
    ]);
    const isUnified = accountBefore.abstraction === "unifiedAccount" || Boolean((user as any).hyperliquidUnified);
    const funded = accountBefore.accountValue >= 1 || (isUnified && spotBefore >= 1);
    if (!funded) {
      return res.status(400).json({
        error: "hl_account_unfunded",
        hint: "Hyperliquid requires at least $1 of USDC on the master account before approving an agent. Open @build4_bot and tap Activate Hyperliquid — it has an auto-bridge from Arbitrum that the dApp doesn't run.",
      });
    }

    const agentWallet = ethers.Wallet.createRandom();
    const agentAddress = agentWallet.address;
    const agentEncryptedPK = encryptPrivateKey(agentWallet.privateKey, user.id);

    const result = await approveAgent(userPk, agentAddress);
    if (!result.success) {
      return res.status(400).json({ error: "approve_failed", detail: result.error });
    }
    const builderResult = await approveBuilderFee(userPk);
    if (!builderResult.success) {
      console.warn("[/web-api/hyperliquid/approve] approveBuilderFee non-fatal failure:", builderResult.error);
    }
    userPk = "";

    const { db } = await import("../../src/db");
    await db.user.update({
      where: { id: user.id },
      data: {
        hyperliquidAgentAddress: agentAddress,
        hyperliquidAgentEncryptedPK: agentEncryptedPK,
        hyperliquidOnboarded: true,
      },
    });
    res.json({ ok: true, agentAddress });
  } catch (e: any) {
    console.error("[dapp-server] /web-api/hyperliquid/approve:", e?.message || e);
    res.status(500).json({ error: "approve_failed", detail: e?.message ?? String(e) });
  }
});

// POST /web-api/hyperliquid/order — MARKET-only order entry. Mirrors
// the bot's /api/hyperliquid/order minus the builder-fee self-heal
// retry loop (web users who hit a builder reject can re-tap Approve).
app.post("/web-api/hyperliquid/order", async (req, res) => {
  const session = await requireSession(req, res); if (!session) return;
  try {
    const { user, wallet } = await lookupBotUser(session.address);
    if (!user) return res.status(403).json({ error: "no_linked_bot_account" });
    if (!wallet) return res.status(404).json({ error: "no_wallet" });
    if (!user.hyperliquidOnboarded) return res.status(400).json({ error: "not_onboarded", needsApprove: true });

    const { coin, side, notionalUsdc, leverage } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof coin !== "string" || !coin) return res.status(400).json({ error: "coin required" });
    if (side !== "LONG" && side !== "SHORT") return res.status(400).json({ error: "side must be LONG or SHORT" });
    const notional = Number(notionalUsdc);
    if (!Number.isFinite(notional) || notional <= 0) return res.status(400).json({ error: "notionalUsdc must be > 0" });
    const lev = leverage ? Math.max(1, Math.min(50, Math.floor(Number(leverage)))) : undefined;

    const { resolveAgentCreds, getMarkPrice, placeOrder } = await import("../../src/services/hyperliquid");
    const creds = await resolveAgentCreds(user as any, wallet.address);
    if (!creds) return res.status(400).json({ error: "no_agent_creds", needsApprove: true });

    const sym = coin.toUpperCase().replace(/USDT?$/, "").replace(/-USD$/, "");
    const { markPrice } = await getMarkPrice(sym);
    if (markPrice <= 0) return res.status(503).json({ error: `mark_price_unavailable for ${sym}` });

    const sz = Number((notional / markPrice).toFixed(6));
    if (sz <= 0) return res.status(400).json({ error: "computed size is 0; increase notionalUsdc" });

    const result = await placeOrder(creds, { coin: sym, side: side as "LONG" | "SHORT", type: "MARKET", sz, leverage: lev });
    if (!result.success) {
      const builderReject = /(builder|must approve)/i.test(result.error ?? "");
      return res.status(400).json({ error: "order_failed", detail: result.error, needsApprove: builderReject });
    }
    res.json({ ok: true, order: result });
  } catch (e: any) {
    console.error("[dapp-server] /web-api/hyperliquid/order:", e?.message || e);
    res.status(502).json({ error: "order_failed", detail: e?.message ?? String(e) });
  }
});

app.get("/web-api/hyperliquid/account", async (req, res) => {
  const session = await requireSession(req, res); if (!session) return;
  try {
    const { user, wallet } = await lookupBotUser(session.address);
    if (!user) return res.status(403).json({ error: "no_linked_bot_account" });
    if (!wallet) return res.status(404).json({ error: "no_wallet" });
    const { getAccountState, getSpotUsdcBalance } = await import("../../src/services/hyperliquid");
    const [state, spotUsdc] = await Promise.all([
      getAccountState(wallet.address),
      getSpotUsdcBalance(wallet.address).catch(() => 0),
    ]);
    res.json({
      walletAddress: wallet.address,
      onboarded: Boolean(user.hyperliquidOnboarded),
      agentApproved: Boolean(user.hyperliquidOnboarded),
      hlAccountExists: Boolean(state.onboarded),
      accountValue: state.accountValue,
      withdrawableUsdc: state.withdrawableUsdc,
      spotUsdc,
      positions: state.positions,
      unified: state.abstraction === "unifiedAccount" || Boolean((user as any).hyperliquidUnified),
    });
  } catch (e: any) {
    console.error("[dapp-server] /web-api/hyperliquid/account:", e?.message || e);
    res.status(502).json({ error: "account_failed", detail: e?.message ?? String(e) });
  }
});

app.get("/web-api/venues/status", async (req, res) => {
  const session = await getSession(req);
  if (!session) return res.status(401).json({ error: "not authenticated" });
  const env = process.env;
  const truthy = (k: string) => (env[k] ?? "").toLowerCase() === "true";
  const present = (k: string) => !!(env[k] ?? "").trim();
  res.json({
    ok: true,
    address: session.address,
    venues: [
      {
        id: "aster",
        name: "Aster DEX",
        kind: "perp",
        chain: "BSC",
        configured: present("ASTER_API_KEY") || present("ASTER_BROKER_PK"),
        provisioned: false,
        nextStep: "Generate Aster API key (Phase 2)",
      },
      {
        id: "hyperliquid",
        name: "Hyperliquid L1",
        kind: "perp",
        chain: "Hyperliquid",
        configured: present("HL_BROKER_AGENT_KEY") || true,
        provisioned: false,
        nextStep: "Generate HL agent wallet (Phase 2)",
      },
      {
        id: "fortytwo",
        name: "42.space",
        kind: "prediction",
        chain: "BSC",
        configured: true,
        provisioned: false,
        nextStep: "Bind BSC custodial wallet (Phase 2)",
      },
      {
        id: "polymarket",
        name: "Polymarket",
        kind: "prediction",
        chain: "Polygon",
        configured: present("POLY_BUILDER_API_KEY") && present("POLY_BUILDER_SECRET") && present("POLY_BUILDER_PASSPHRASE") && present("POLY_BUILDER_CODE"),
        provisioned: false,
        nextStep: "Deploy gasless Gnosis Safe (Phase 2)",
      },
      {
        id: "fourmeme",
        name: "four.meme",
        kind: "launchpad",
        chain: "BSC",
        configured: truthy("FOUR_MEME_ENABLED") || truthy("FOUR_MEME_LAUNCH_ENABLED"),
        provisioned: false,
        nextStep: "Launch via bot for now",
      },
      {
        id: "pancakeswap",
        name: "PancakeSwap",
        kind: "spot",
        chain: "BSC",
        configured: true,
        provisioned: false,
        nextStep: "Per-user swap routing (Phase 2)",
      },
      {
        id: "topaz",
        name: "Topaz",
        kind: "spot+lp",
        chain: "BSC",
        configured: truthy("TOPAZ_ENABLED"),
        provisioned: false,
        nextStep: "Phase 1 master-wallet-only; use mini-app",
      },
    ],
  });
});

app.use(express.static(STATIC_DIR, { index: false, maxAge: "1h" }));

app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method !== "GET") return next();
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(STATIC_DIR, "index.html"));
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[dapp-server] uncaught:", err);
  res.status(500).json({ error: "internal error" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[dapp-server] listening on http://0.0.0.0:${PORT}`);
  console.log(`[dapp-server] static: ${STATIC_DIR}`);
  console.log(`[dapp-server] WalletConnect projectId: ${process.env.WALLETCONNECT_PROJECT_ID ? "set" : "MISSING"}`);
});
