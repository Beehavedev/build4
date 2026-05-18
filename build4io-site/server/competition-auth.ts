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

  // 4. Resolve chatId from telegram_wallets (and confirm PK presence if needed)
  let chatId: string;
  let hasKey = false;
  try {
    const { telegramWallets } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await db
      .select({ chatId: telegramWallets.chatId, encryptedPrivateKey: telegramWallets.encryptedPrivateKey })
      .from(telegramWallets)
      .where(eq(telegramWallets.walletAddress, headerAddr))
      .limit(1);
    if (rows.length === 0) {
      return { error: "Wallet not registered. Connect on /autonomous-economy first to provision a BUILD4 wallet.", status: 404, code: "NOT_REGISTERED" };
    }
    chatId = rows[0].chatId;
    hasKey = !!rows[0].encryptedPrivateKey;
  } catch (e: any) {
    console.error("[competition-auth] wallet lookup failed:", e?.message ?? e);
    return { error: "Authentication lookup failed.", status: 500, code: "LOOKUP_FAIL" };
  }

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

  // 7. PK fetch (only when needed; never returned to response by callers)
  let privateKey: string | undefined;
  if (opts.needPrivateKey) {
    if (!hasKey) {
      return { error: "Wallet has no custodial private key on file (view-only).", status: 403, code: "VIEW_ONLY" };
    }
    const pk = await storage.getPrivateKeyByWalletAddress(headerAddr);
    if (!pk) {
      return { error: "Failed to decrypt wallet key.", status: 500, code: "DECRYPT_FAIL" };
    }
    privateKey = pk;
  }

  return { chatId, walletAddress: headerAddr, privateKey };
}
