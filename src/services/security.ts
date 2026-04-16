import crypto from 'crypto'
import { db } from '../db'

/* ─────────── PIN hashing (PBKDF2-SHA256) ─────────── */

export function hashPin(pin: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.pbkdf2Sync(pin, salt, 100_000, 32, 'sha256').toString('hex')
  return { hash, salt }
}

export function verifyPin(pin: string, hash: string, salt: string): boolean {
  const test = crypto.pbkdf2Sync(pin, salt, 100_000, 32, 'sha256').toString('hex')
  return crypto.timingSafeEqual(Buffer.from(test, 'hex'), Buffer.from(hash, 'hex'))
}

/* ─────────── Security audit log ─────────── */

export type SecurityAction =
  | 'pk_export_success'
  | 'pk_export_denied_rate_limit'
  | 'pk_export_denied_bad_pin'
  | 'pk_export_denied_no_pin'
  | 'pin_set'
  | 'pin_changed'
  | 'pin_removed'
  | 'pin_failed'
  | 'wallet_imported'
  | 'wallet_switched'

export async function logSecurityEvent(opts: {
  userId: string
  telegramId: bigint | string | number
  action: SecurityAction
  walletId?: string
  meta?: Record<string, any>
}) {
  try {
    await db.$executeRawUnsafe(
      `INSERT INTO "SecurityLog" ("userId","telegramId","action","walletId","meta") VALUES ($1,$2,$3,$4,$5::jsonb)`,
      opts.userId,
      String(opts.telegramId),
      opts.action,
      opts.walletId ?? null,
      JSON.stringify(opts.meta ?? {})
    )
  } catch (err: any) {
    console.error('[Security] log failed:', err.message)
  }
}

/* ─────────── Rate limit (PK exports) ─────────── */

export const PK_EXPORT_LIMIT_PER_24H = 3
export const PIN_FAIL_LIMIT_PER_HOUR = 5

export async function checkExportRateLimit(userId: string): Promise<{ allowed: boolean; remaining: number }> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const rows = await db.$queryRawUnsafe<any[]>(
    `SELECT COUNT(*)::int AS n FROM "SecurityLog" WHERE "userId"=$1 AND "action"='pk_export_success' AND "createdAt">=$2`,
    userId,
    since
  )
  const used = rows[0]?.n ?? 0
  const remaining = Math.max(0, PK_EXPORT_LIMIT_PER_24H - used)
  return { allowed: used < PK_EXPORT_LIMIT_PER_24H, remaining }
}

export async function checkPinFailLimit(userId: string): Promise<{ allowed: boolean; locked: boolean }> {
  const since = new Date(Date.now() - 60 * 60 * 1000)
  const rows = await db.$queryRawUnsafe<any[]>(
    `SELECT COUNT(*)::int AS n FROM "SecurityLog" WHERE "userId"=$1 AND "action" IN ('pin_failed','pk_export_denied_bad_pin') AND "createdAt">=$2`,
    userId,
    since
  )
  const fails = rows[0]?.n ?? 0
  return { allowed: fails < PIN_FAIL_LIMIT_PER_HOUR, locked: fails >= PIN_FAIL_LIMIT_PER_HOUR }
}

/* ─────────── In-memory pending PIN prompts ─────────── */

interface PendingPinPrompt {
  walletId: string
  userId: string
  expiresAt: number
  purpose: 'export' | 'set' | 'change_old' | 'change_new' | 'remove'
  oldPin?: string // used when changing
}

const pendingPinPrompts = new Map<string, PendingPinPrompt>()

export function setPendingPinPrompt(telegramId: string | number, prompt: Omit<PendingPinPrompt, 'expiresAt'>) {
  pendingPinPrompts.set(String(telegramId), { ...prompt, expiresAt: Date.now() + 2 * 60 * 1000 })
}

export function consumePendingPinPrompt(telegramId: string | number): PendingPinPrompt | null {
  const key = String(telegramId)
  const p = pendingPinPrompts.get(key)
  if (!p) return null
  pendingPinPrompts.delete(key)
  if (Date.now() > p.expiresAt) return null
  return p
}

export function peekPendingPinPrompt(telegramId: string | number): PendingPinPrompt | null {
  const p = pendingPinPrompts.get(String(telegramId))
  if (!p || Date.now() > p.expiresAt) return null
  return p
}
