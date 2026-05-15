// Bot-side wallet bridge.
//
// The site and the Telegram bot share one Postgres database (DATABASE_URL),
// but use different ORMs and different table layouts for wallet storage:
//
//   bot:  Prisma → "User" + "Wallet" (PascalCase, quoted)
//   site: Drizzle → telegram_wallets   (snake_case, separate, web-only)
//
// When a web-terminal user links their MetaMask wallet to a Telegram
// account via the deep-link claim flow (see /api/wallet/link-telegram/*),
// the site needs to resolve their actual on-chain custodial wallet that
// the bot generated for them on /setup. That custodial wallet lives in
// the bot's "Wallet" table — never in telegram_wallets.
//
// This module exposes:
//   • lookupBotCustodial(telegramId) → { userId, address, encryptedPK } | null
//   • decryptBotPk(encryptedPK, userId, pin?) → string
//
// The decryption mirrors src/services/wallet.ts in the bot. We DO NOT
// import that file because (a) the constraint says don't touch root src/,
// and importing from src/ would couple the site to the bot's build, and
// (b) crypto-js is already a root dep so we just re-implement the decrypt
// path here. PIN-protected wallets are not supported via the web — those
// users opted into a stronger flow that intentionally requires the bot's
// /pin prompt; the site returns a friendly message redirecting them.

import CryptoJS from "crypto-js";
import { pool } from "./db";

const MASTER_KEY = process.env.MASTER_ENCRYPTION_KEY ?? process.env.WALLET_ENCRYPTION_KEY ?? "default_dev_key_change_in_prod_32c";
const LEGACY_MASTER = process.env.WALLET_ENCRYPTION_KEY ?? process.env.MASTER_ENCRYPTION_KEY ?? "default-dev-key-change-me-32chars!";
const HISTORICAL_DEFAULT_MODERN = "default_dev_key_change_in_prod_32c";
const HISTORICAL_DEFAULT_LEGACY = "default-dev-key-change-me-32chars!";

export interface BotCustodial {
  userId: string;
  telegramId: string;
  address: string;
  encryptedPK: string | null;
}

export async function lookupBotCustodialByTelegramId(telegramId: string): Promise<BotCustodial | null> {
  if (!telegramId || !/^\d+$/.test(telegramId)) return null;
  const userRes = await pool.query(
    `SELECT id, "telegramId" FROM "User" WHERE "telegramId" = $1 LIMIT 1`,
    [telegramId],
  );
  if (!userRes.rows.length) return null;
  const userId: string = userRes.rows[0].id;
  const walletRes = await pool.query(
    `SELECT address, "encryptedPK" FROM "Wallet"
       WHERE "userId" = $1 AND chain = 'BSC'
       ORDER BY "isActive" DESC, "createdAt" ASC LIMIT 1`,
    [userId],
  );
  if (!walletRes.rows.length) return null;
  return {
    userId,
    telegramId: String(userRes.rows[0].telegramId),
    address: walletRes.rows[0].address,
    encryptedPK: walletRes.rows[0].encryptedPK ?? null,
  };
}

// Mirrors src/services/wallet.ts decryptPrivateKey() — CryptoJS path only.
// Legacy ':'-delimited Node-crypto AES-CBC payloads are NOT decoded here;
// any production payload that hits this code path is the modern CryptoJS
// AES form (base64 starting with "U2FsdGVkX1"). PIN-protected payloads
// throw — caller handles that with a "use Telegram /wallet" message.
export function decryptBotPk(encrypted: string, userId: string, pin?: string): string {
  if (!encrypted) throw new Error("empty payload");
  if (encrypted.includes(":")) {
    // Legacy Node-crypto format — bot still supports this on its side, but
    // we deliberately don't ship the legacy decryptor in the site to keep
    // the attack surface small. These users are extremely rare; route them
    // back to Telegram /wallet for export.
    throw new Error("legacy_format_use_telegram");
  }
  const candidates = Array.from(new Set([
    MASTER_KEY, LEGACY_MASTER, HISTORICAL_DEFAULT_MODERN, HISTORICAL_DEFAULT_LEGACY,
  ].filter(Boolean)));
  let lastErr: Error | null = null;
  for (const master of candidates) {
    try {
      const keyMaterial = pin ? master + userId + ":" + pin : master + userId;
      const key = CryptoJS.SHA256(keyMaterial).toString();
      const bytes = CryptoJS.AES.decrypt(encrypted, key);
      const out = bytes.toString(CryptoJS.enc.Utf8);
      if (out && out.startsWith("0x") && out.length >= 64) return out;
    } catch (e: any) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("decrypt_failed");
}

// Idempotent table init for the web↔telegram link mapping.
let initPromise: Promise<void> | null = null;
export function ensureLinkTable(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS web_telegram_links (
        web_wallet text PRIMARY KEY,
        telegram_id text,
        link_token text UNIQUE,
        token_expires_at bigint,
        linked_at bigint,
        created_at bigint NOT NULL
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS web_telegram_links_token_idx ON web_telegram_links(link_token)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS web_telegram_links_telegram_id_idx ON web_telegram_links(telegram_id)`);
  })().catch((e) => {
    initPromise = null;
    throw e;
  });
  return initPromise;
}

export async function getLinkByWebWallet(webWallet: string): Promise<{ telegramId: string | null; linkedAt: number | null } | null> {
  const r = await pool.query(
    `SELECT telegram_id, linked_at FROM web_telegram_links WHERE web_wallet = $1 LIMIT 1`,
    [webWallet.toLowerCase()],
  );
  if (!r.rows.length) return null;
  return { telegramId: r.rows[0].telegram_id, linkedAt: r.rows[0].linked_at != null ? Number(r.rows[0].linked_at) : null };
}

export async function upsertLinkToken(webWallet: string, token: string, expiresAtMs: number): Promise<void> {
  const lower = webWallet.toLowerCase();
  await pool.query(
    `INSERT INTO web_telegram_links (web_wallet, link_token, token_expires_at, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (web_wallet) DO UPDATE SET link_token = EXCLUDED.link_token, token_expires_at = EXCLUDED.token_expires_at`,
    [lower, token, expiresAtMs, Date.now()],
  );
}

export async function redeemLinkToken(token: string, telegramId: string): Promise<{ ok: true; webWallet: string } | { ok: false; reason: string }> {
  if (!token || !/^[a-f0-9]{32}$/.test(token)) return { ok: false, reason: "bad_token" };
  if (!/^\d+$/.test(telegramId)) return { ok: false, reason: "bad_telegram_id" };
  const r = await pool.query(
    `SELECT web_wallet, token_expires_at FROM web_telegram_links WHERE link_token = $1 LIMIT 1`,
    [token],
  );
  if (!r.rows.length) return { ok: false, reason: "unknown_token" };
  const exp = Number(r.rows[0].token_expires_at);
  if (!Number.isFinite(exp) || exp < Date.now()) return { ok: false, reason: "expired" };
  const webWallet: string = r.rows[0].web_wallet;
  await pool.query(
    `UPDATE web_telegram_links
        SET telegram_id = $1, linked_at = $2, link_token = NULL, token_expires_at = NULL
      WHERE web_wallet = $3`,
    [telegramId, Date.now(), webWallet],
  );
  return { ok: true, webWallet };
}
