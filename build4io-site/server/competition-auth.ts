// Hardened auth middleware for competition + pancake trade endpoints.
//
// Replaces the header-only `x-wallet-address` model with defense-in-depth:
//   1. SIWE cookie session (HMAC-signed, 1h TTL, set by /api/auth/siwe)
//   2. x-wallet-address header must match the SIWE wallet (prevents
//      confused-deputy where one user's session is replayed against
//      another's wallet)
//   3. CSRF: writes require Origin/Referer in SITE_ALLOWED_HOSTS
//   4. Per-chatId rate limit (in-memory leaky bucket via performance-monitor)
//   5. Optional idempotency key (X-Idempotency-Key) — same key from same
//      chatId within window returns 409 instead of re-executing the action
//   6. Custodial PK is only fetched when explicitly requested
//      (needPrivateKey: true) and never returned to the response

import type { Request, Response } from "express";
import { db } from "./db";
import { storage } from "./storage";
import { verifySiweCookie } from "./wallet-routes";
import { checkRateLimit } from "./performance-monitor";

export type AuthSuccess = {
  chatId: string;
  walletAddress: string;
  privateKey?: string;
};
export type AuthFailure = { error: string; status: number; code?: string };

interface AuthOpts {
  needPrivateKey?: boolean;
  isWrite?: boolean;
  rateLimit?: { key: string; max: number; windowMs: number };
  idempotency?: { ttlMs: number };
}

function allowedHosts(req: Request): Set<string> {
  const env = process.env.SITE_ALLOWED_HOSTS || process.env.DAPP_ALLOWED_HOSTS || "";
  const list = env.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (list.length) return new Set(list);
  // PRODUCTION: fail closed. An empty allow-list with a Host-header fallback
  // is a DNS-rebinding / spoofed-Host CSRF risk. Force operator to set
  // SITE_ALLOWED_HOSTS explicitly before any write endpoint will accept the
  // request. Without this guard the dev fallback below would silently trust
  // whatever Host the attacker can get to land on the server.
  if (process.env.NODE_ENV === "production") {
    console.error("[competition-auth] SITE_ALLOWED_HOSTS is REQUIRED in production. Refusing all writes.");
    return new Set(["__no_host_will_ever_match__"]);
  }
  // Dev fallback only: trust the request's Host (Replit preview hosts are
  // workspace-unique).
  const h = String(req.headers.host || "").toLowerCase();
  return new Set(h ? [h] : []);
}
function originHost(o: string | undefined | null): string {
  if (!o) return "";
  try { return new URL(o).host.toLowerCase(); } catch { return ""; }
}

// In-memory idempotency cache: chatId:key → expiry. Lazy GC on insert.
const _idemCache = new Map<string, number>();
function recordIdempotency(chatId: string, key: string, ttlMs: number): boolean {
  const k = `${chatId}:${key}`;
  const now = Date.now();
  if (_idemCache.size > 5000) {
    for (const [kk, exp] of _idemCache) {
      if (exp < now) _idemCache.delete(kk);
      if (_idemCache.size < 4000) break;
    }
  }
  const existing = _idemCache.get(k);
  if (existing && existing > now) return false; // duplicate
  _idemCache.set(k, now + ttlMs);
  return true;
}

export async function requireSiweAuthed(
  req: Request,
  opts: AuthOpts = {},
): Promise<AuthSuccess | AuthFailure> {
  // 1. SIWE cookie session
  const sess = verifySiweCookie(req);
  if (!sess) {
    return { error: "Sign in to your wallet to continue.", status: 401, code: "NO_SESSION" };
  }

  // 2. x-wallet-address header must match SIWE wallet
  const headerAddr = String(req.headers["x-wallet-address"] || "").toLowerCase().trim();
  if (!headerAddr || !/^0x[a-f0-9]{40}$/.test(headerAddr)) {
    return { error: "Wallet header missing.", status: 401, code: "NO_HEADER" };
  }
  if (sess.wallet.toLowerCase() !== headerAddr) {
    return { error: "Wallet header does not match signed-in wallet.", status: 403, code: "WALLET_MISMATCH" };
  }

  // 3. CSRF Origin/Referer binding for writes
  if (opts.isWrite) {
    const hosts = allowedHosts(req);
    const origin = originHost(req.headers.origin as string | undefined)
                || originHost(req.headers.referer as string | undefined);
    if (hosts.size > 0) {
      if (!origin) return { error: "Missing Origin header.", status: 403, code: "NO_ORIGIN" };
      if (!hosts.has(origin)) {
        console.warn(`[competition-auth] Origin rejected: ${origin}`);
        return { error: "Origin not allowed.", status: 403, code: "BAD_ORIGIN" };
      }
    }
  }

  // 4. Resolve chatId via the MetaMask identity row, then resolve the
  //    *custodial* (the chatId's row that holds an encrypted PK).
  //
  //    Web user model:
  //      - identity row:  walletAddress = MetaMask (header),  PK = null
  //      - custodial row: walletAddress = fresh BSC EOA,      PK = encrypted
  //
  //    Telegram /setup user model (legacy):
  //      - single row:    walletAddress = custodial,          PK = encrypted
  //      In that case the header MetaMask wouldn't resolve here unless the
  //      user has *also* linked via /api/miniapp/web-register, which adds
  //      the identity row.
  //
  //    The returned walletAddress is ALWAYS the custodial — that's what
  //    holds funds, what the agent signs from, and what gets stored in the
  //    competition entry row. Header binding (SIWE wallet === header) is
  //    enforced above for *identity*, not for the custodial.
  let chatId: string;
  let custodialAddress: string = headerAddr;
  let custodialHasKey = false;
  try {
    const { telegramWallets } = await import("@shared/schema");
    const { eq, and, isNotNull, desc } = await import("drizzle-orm");
    const identityRows = await db
      .select({ chatId: telegramWallets.chatId })
      .from(telegramWallets)
      .where(eq(telegramWallets.walletAddress, headerAddr))
      .limit(1);
    if (identityRows.length === 0) {
      return { error: "Wallet not registered. Reconnect on /competition to provision your BUILD4 trading wallet.", status: 404, code: "NOT_REGISTERED" };
    }
    chatId = identityRows[0].chatId;

    const custodialRows = await db
      .select({ walletAddress: telegramWallets.walletAddress, isActive: telegramWallets.isActive })
      .from(telegramWallets)
      .where(and(eq(telegramWallets.chatId, chatId), isNotNull(telegramWallets.encryptedPrivateKey)))
      .orderBy(desc(telegramWallets.isActive))
      .limit(1);
    if (custodialRows.length > 0) {
      custodialAddress = String(custodialRows[0].walletAddress).toLowerCase();
      custodialHasKey = true;
    }
  } catch (e: any) {
    console.error("[competition-auth] wallet lookup failed:", e?.message ?? e);
    return { error: "Authentication lookup failed.", status: 500, code: "LOOKUP_FAIL" };
  }
  const hasKey = custodialHasKey;

  // 5. Per-chatId rate limit
  if (opts.rateLimit) {
    const key = `${opts.rateLimit.key}:${chatId}`;
    if (!checkRateLimit(key, opts.rateLimit.max, opts.rateLimit.windowMs)) {
      return { error: "Too many requests. Slow down and try again shortly.", status: 429, code: "RATE_LIMITED" };
    }
  }

  // 6. Idempotency — same key from same chatId within window blocks replay
  if (opts.idempotency) {
    const rawKey = req.headers["x-idempotency-key"];
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    if (key && typeof key === "string") {
      if (key.length > 128 || !/^[a-zA-Z0-9._-]+$/.test(key)) {
        return { error: "Invalid idempotency key.", status: 400, code: "BAD_IDEMPOTENCY" };
      }
      if (!recordIdempotency(chatId, key, opts.idempotency.ttlMs)) {
        return { error: "Duplicate request (idempotency key already used).", status: 409, code: "DUPLICATE" };
      }
    }
  }

  // 7. PK fetch (only when needed; never returned to response by callers).
  //    Always fetched by the CUSTODIAL address, never the identity address.
  let privateKey: string | undefined;
  if (opts.needPrivateKey) {
    if (!hasKey) {
      return { error: "No trading wallet provisioned. Reconnect on /competition to set one up.", status: 403, code: "NO_CUSTODIAL" };
    }
    const pk = await storage.getPrivateKeyByWalletAddress(custodialAddress);
    if (!pk) {
      return { error: "Failed to decrypt trading wallet key.", status: 500, code: "DECRYPT_FAIL" };
    }
    privateKey = pk;
  }

  // walletAddress returned is the CUSTODIAL — every downstream caller
  // (getBscWalletBalance, recordPancakeTrade, pancakeBuyTokenWithBnb) uses
  // it to read/spend funds. The user's MetaMask identity is verified above
  // and otherwise not exposed.
  return { chatId, walletAddress: custodialAddress, privateKey };
}
