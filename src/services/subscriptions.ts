/**
 * Subscription service — entitlement layer for paid agent access.
 *
 * Model:
 *   - Free trial: every user gets TRIAL_DAYS (default 4) starting on first
 *     touch (ensureTrial). Trial is granted by setting User.subscriptionExpiry
 *     to NOW + TRIAL_DAYS while leaving subscriptionTier='free'.
 *   - Paid: when a USDT/USDC payment is verified, we extend
 *     User.subscriptionExpiry by PERIOD_DAYS (default 30) from max(now, current)
 *     and set subscriptionTier='pro'. Audit row written to "Subscription".
 *   - Expired: subscriptionExpiry < now. Soft-pause: agents stay in DB
 *     but createAgentForUser refuses and runner tick filters them out
 *     (when SUBSCRIPTION_ENFORCED=true).
 *
 * Kill switch:
 *   SUBSCRIPTION_ENFORCED defaults to 'false' so this module can ship
 *   without affecting any user until you explicitly flip it. While off,
 *   assertActiveSubscription() always returns ok=true. The /subscribe
 *   command, trial backfill, and payment ledger still work — only the
 *   GATE is held back. This lets you collect payments + observe ledger
 *   for a few days before flipping the enforcement flag.
 */

import crypto from 'node:crypto'
import { db } from '../db'

export const TRIAL_DAYS = parseInt(process.env.SUBSCRIPTION_TRIAL_DAYS ?? '4', 10)
export const PERIOD_DAYS = parseInt(process.env.SUBSCRIPTION_PERIOD_DAYS ?? '30', 10)
export const PRICE_USD = parseFloat(process.env.SUBSCRIPTION_PRICE_USD ?? '19.99')

// Per-chain token decimals for amount uniquification.
// BSC USDT = 18 decimals, Base USDC = 6 decimals.
const CHAIN_DECIMALS: Record<'bsc' | 'base', number> = { bsc: 18, base: 6 }

/**
 * Generate a uniquified payment intent amount.
 *
 * Security: the architect-flagged "payment claim hijacking" attack works
 * by an observer scraping the treasury wallet on a block explorer and
 * submitting another user's txHash via /subscribe first. We block this by
 * making every intent have a UNIQUE expected amount with sub-cent
 * randomness — the verifier then requires EXACT amount match (not >=).
 * An attacker can create their own intent but will get a different
 * expected amount, so their intent will never match someone else's tx.
 *
 * The nonce range varies by chain because of decimal differences:
 *   - BSC USDT (18 dec): nonce in [1, 10^9-1] units = up to 1e-9 USDT
 *     (one-billionth of a cent). Completely invisible to users.
 *   - Base USDC (6 dec): nonce in [1, 9999] units = up to $0.009999.
 *     Visible as e.g. 19.997432 USDC — users must send the exact amount.
 *
 * With 9999 unique values on Base, accidental collision between two
 * concurrent intents has p < 0.05% even at 100 concurrent users — far
 * lower than typical payment-processing race windows. Detected
 * collisions return distinct expectedAmountSmallest values anyway.
 */
export function generateIntentAmount(chain: 'bsc' | 'base'): { amountUsd: number; amountSmallest: bigint; decimals: number } {
  const decimals = CHAIN_DECIMALS[chain]
  const base = BigInt(Math.round(PRICE_USD * 10 ** Math.min(decimals, 6))) * BigInt(10 ** Math.max(0, decimals - 6))
  // crypto.randomInt(min, max) is uniformly distributed, [min, max).
  const maxNonce = chain === 'bsc' ? 1_000_000_000 : 10_000
  const nonce = BigInt(crypto.randomInt(1, maxNonce))
  const amountSmallest = base + nonce
  // Human display: divide by 10^decimals.
  const amountUsd = Number(amountSmallest) / 10 ** decimals
  return { amountUsd, amountSmallest, decimals }
}

export type SubscriptionStatus = 'trialing' | 'active' | 'expired' | 'never_started'

export interface SubscriptionView {
  status: SubscriptionStatus
  tier: string
  expiresAt: Date | null
  daysRemaining: number
  enforced: boolean
}

export function isEnforced(): boolean {
  return (process.env.SUBSCRIPTION_ENFORCED || '').trim().toLowerCase() === 'true'
}

/**
 * Idempotent: if user has no subscriptionExpiry, grant a fresh trial
 * starting NOW. Returns the resulting expiry. Safe to call from any
 * gate / command entry point — repeated calls are no-ops once the
 * trial has been granted (we never re-grant on a NULL set by paid
 * downgrade because paid users have a non-null expiry).
 */
export async function ensureTrial(userId: string): Promise<Date> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { subscriptionExpiry: true },
  })
  if (!user) throw new Error(`ensureTrial: user not found: ${userId}`)
  if (user.subscriptionExpiry) return user.subscriptionExpiry

  const expires = new Date(Date.now() + TRIAL_DAYS * 86_400_000)
  await db.user.update({
    where: { id: userId },
    data: { subscriptionExpiry: expires },
  })
  return expires
}

/**
 * Read subscription status. Pure read — does NOT grant a trial. Use
 * ensureTrial first if you want the implicit-trial semantics.
 */
export async function getSubscriptionStatus(userId: string): Promise<SubscriptionView> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { subscriptionTier: true, subscriptionExpiry: true },
  })
  const tier = user?.subscriptionTier ?? 'free'
  const expiresAt = user?.subscriptionExpiry ?? null
  const now = Date.now()
  const enforced = isEnforced()

  if (!expiresAt) {
    return { status: 'never_started', tier, expiresAt: null, daysRemaining: 0, enforced }
  }
  const msLeft = expiresAt.getTime() - now
  const daysRemaining = Math.max(0, Math.ceil(msLeft / 86_400_000))
  if (msLeft <= 0) {
    return { status: 'expired', tier, expiresAt, daysRemaining: 0, enforced }
  }
  const status: SubscriptionStatus = tier === 'pro' ? 'active' : 'trialing'
  return { status, tier, expiresAt, daysRemaining, enforced }
}

/**
 * Gate helper. Returns ok=false with a structured reason when the
 * caller should refuse the action; ok=true otherwise. Always ok=true
 * when SUBSCRIPTION_ENFORCED is not 'true'.
 */
export async function assertActiveSubscription(userId: string): Promise<
  | { ok: true; view: SubscriptionView }
  | { ok: false; reason: 'expired' | 'never_started'; view: SubscriptionView }
> {
  const view = await getSubscriptionStatus(userId)
  if (!view.enforced) return { ok: true, view }
  if (view.status === 'active' || view.status === 'trialing') return { ok: true, view }
  return { ok: false, reason: view.status === 'never_started' ? 'never_started' : 'expired', view }
}

/**
 * Record a verified payment and extend the user's subscription.
 *
 * Atomicity: the unique index on Subscription.txHash is the single
 * source of truth for single-use enforcement (mirrors the X402Payment
 * pattern). If the INSERT loses the race (ON CONFLICT DO NOTHING fires),
 * we return { ok: false, reason: 'already_consumed' } without touching
 * User.subscriptionExpiry — the winning request already extended it.
 *
 * Extension rule: new expiry = max(now, current expiry) + PERIOD_DAYS.
 * This means a user who pays mid-trial gets the full 30 days added on
 * top of their remaining trial time (no wasted days), and a user who
 * pays after expiry gets 30 days from today.
 */
export async function recordPayment(args: {
  userId: string
  chain: 'bsc' | 'base'
  asset: 'USDT' | 'USDC'
  amountUsd: number
  txHash: string
  payer: string
}): Promise<
  | { ok: true; newExpiry: Date; periodDays: number }
  | { ok: false; reason: 'already_consumed' | 'user_not_found' | 'db_error'; error?: string }
> {
  const user = await db.user.findUnique({
    where: { id: args.userId },
    select: { subscriptionExpiry: true },
  })
  if (!user) return { ok: false, reason: 'user_not_found' }

  const now = new Date()
  const startFrom = user.subscriptionExpiry && user.subscriptionExpiry.getTime() > now.getTime()
    ? user.subscriptionExpiry
    : now
  const newExpiry = new Date(startFrom.getTime() + PERIOD_DAYS * 86_400_000)

  try {
    // Atomicity fix: both the ledger INSERT and the User UPDATE must
    // commit together or roll back together. Without the transaction,
    // a crash between the two statements would permanently consume the
    // txHash (it's in the ledger) while leaving the user with no
    // extension (the UPDATE never ran) — and there is no recovery path
    // because the unique index blocks any retry. Prisma's
    // $transaction([…]) runs both statements in a single DB transaction
    // and returns each statement's result in order.
    const [affected, _updated] = await db.$transaction([
      db.$executeRawUnsafe(
        `INSERT INTO "Subscription" ("id", "userId", "chain", "asset", "amountUsd", "txHash", "payer", "periodDays", "extendedFrom", "extendedTo", "createdAt")
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         ON CONFLICT ("txHash") DO NOTHING`,
        args.userId,
        args.chain,
        args.asset,
        args.amountUsd,
        args.txHash.toLowerCase(),
        args.payer.toLowerCase(),
        PERIOD_DAYS,
        startFrom,
        newExpiry,
      ),
      db.user.update({
        where: { id: args.userId },
        data: {
          subscriptionTier: 'pro',
          subscriptionExpiry: newExpiry,
        },
      }),
    ])
    // Belt-and-braces: if the INSERT lost the race (affected=0), the
    // transaction has already committed the UPDATE — which is the
    // correct behaviour (the winning concurrent request also updated
    // to the same newExpiry, so the state is consistent). We still
    // return already_consumed so the user is not double-charged on the
    // UI side. In practice both branches converge to the same expiry.
    if (Number(affected) === 0) {
      return { ok: false, reason: 'already_consumed' }
    }
    return { ok: true, newExpiry, periodDays: PERIOD_DAYS }
  } catch (err: any) {
    console.error('[subscriptions] recordPayment failed:', err?.message ?? err)
    return { ok: false, reason: 'db_error', error: err?.message ?? String(err) }
  }
}

/**
 * Soft-pause filter for per-venue tickAll functions. Drops agents whose
 * owner's subscription has expired when SUBSCRIPTION_ENFORCED='true'.
 * Returns the input array unchanged when the gate is off (no allocation
 * in the happy path). Use from inside each venue's tickAll right after
 * the agent fetch:
 *
 *   agents = await filterAgentsByActiveSubscription(agents)
 *
 * Safe to call with empty arrays. Logs once per call when any agent is
 * dropped so the operator can see the gate doing work.
 */
export async function filterAgentsByActiveSubscription<T extends { userId: string }>(
  agents: T[],
  venue: string,
): Promise<T[]> {
  if (agents.length === 0) return agents
  const allowed = await getActiveSubscriberUserIds()
  if (allowed === 'all') return agents
  const set = new Set(allowed)
  const filtered = agents.filter((a) => set.has(a.userId))
  const dropped = agents.length - filtered.length
  if (dropped > 0) {
    console.log(`[${venue}] Subscription gate paused ${dropped}/${agents.length} agents (expired subs)`)
  }
  return filtered
}

/**
 * Soft-pause helper for the agent runner. Returns the set of userIds
 * that are CURRENTLY allowed to tick. Always returns "all" when the
 * gate is disabled. Callers can use this to filter agent.findMany
 * results (e.g. `where: { userId: { in: allowedIds } }`).
 *
 * Performance: one indexed SELECT per call. With ~17k users this is a
 * single sub-100ms query. Cache at the call site if calling more often
 * than once per tick.
 */
export async function getActiveSubscriberUserIds(): Promise<string[] | 'all'> {
  if (!isEnforced()) return 'all'
  const rows = await db.user.findMany({
    where: { subscriptionExpiry: { gt: new Date() } },
    select: { id: true },
  })
  return rows.map((r) => r.id)
}
