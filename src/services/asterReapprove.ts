// ─────────────────────────────────────────────────────────────────────────────
// asterReapprove.ts
//
// Re-runs the Aster agent-approval flow for an existing user without an HTTP
// request. Used by:
//
//   1. POST /api/admin/aster/reactivate-user  — manual re-activation by admin
//   2. tradingAgent.ts order-execution catch  — autonomous self-heal when
//      Aster returns -1000 "No agent found" (the registered agent address
//      doesn't match what's on file, e.g. broker rotation or a stale
//      asterAgentAddress from a partial earlier flow).
//
// What this DOES NOT do (kept intentionally narrow vs /api/aster/approve):
//   - No on-chain USDT bootstrap. We assume the user already has an Aster
//     account (otherwise we'd be hitting "no aster user", not "no agent").
//   - No "already-onboarded short-circuit". The whole point of calling this
//     is that the on-file agent is broken — we WANT to mint a fresh one.
//
// Always mints a NEW agent keypair so we don't keep retrying the same
// Aster-rejected address. Persists the new asterAgentAddress and encrypted
// PK on success. Builder enrollment is best-effort (fee attribution),
// non-fatal.
// ─────────────────────────────────────────────────────────────────────────────

import { db } from '../db'

export interface ReapproveResult {
  success: boolean
  agentAddress?: string
  builderEnrolled?: boolean
  error?: string
}

// Detect Aster's "fee rate exceeds builder-approved max" rejection. Used by
// every Aster order path (autonomous agent + manual API + dApp API) to decide
// whether to lazy-fire reapproveAsterForUser. Any user whose signed
// maxFeeRate no longer matches the current env rate (0.002) hits this.
//
// Detection strategy: prefer Aster's structured signals (code -4400 with
// fee/max wording in the message) over loose text matching, then fall back
// to known message fragments. Keep fallback narrow to avoid false positives
// on unrelated rejects.
export function isAsterFeeOverMaxError(err: any): boolean {
  const respBody = err?.response?.data
  const code = typeof respBody === 'object' && respBody !== null
    ? Number((respBody as any).code)
    : NaN
  const msgFromBody = typeof respBody === 'object' && respBody !== null
    ? String((respBody as any).msg ?? '')
    : typeof respBody === 'string' ? respBody : ''
  const combined = `${err?.message ?? ''} ${msgFromBody}`.toLowerCase()
  // Structured: Aster fee-related rejections cluster around -4400. Require
  // both the code AND a fee/max keyword so unrelated -4400s don't trigger.
  if (code === -4400 && /\bfee\b|\bmax\b|builder/.test(combined)) return true
  // Text-fallback: known phrasings observed in Aster responses. Narrowed
  // to require BOTH a fee/max token AND an "exceed/over" verb to keep
  // false positives off paths like "insufficient balance".
  const hasFeeMaxToken = /maxfeerate|fee.?rate.*max|builder.*max.?fee|fee.*approved|builder.*approved/.test(combined)
  const hasExceedVerb  = /exceed|over.*max|greater.*than/.test(combined)
  if (hasFeeMaxToken && hasExceedVerb) return true
  return false
}

// In-memory per-user lock. Prevents duplicate re-mints when multiple agents
// owned by the same user tick simultaneously and all hit -1000 in the same
// window. Without this, we'd register N fresh agent addresses against Aster
// in parallel and only the last DB write would "win" — wasted Aster calls
// and possible nonce contention. The lock is process-local; if a user's
// agents run on different instances this guard is best-effort, but in
// practice the agent runner pins all of a user's agents to one process.
const _inflight = new Map<string, Promise<ReapproveResult>>()

export async function reapproveAsterForUser(user: {
  id: string
  telegramId?: bigint | number | string | null
  asterAgentEncryptedPK?: string | null
  asterAgentAddress?: string | null
  asterOnboarded?: boolean
}): Promise<ReapproveResult> {
  const existing = _inflight.get(user.id)
  if (existing) return existing
  const job = _runReapprove(user)
  _inflight.set(user.id, job)
  try { return await job } finally { _inflight.delete(user.id) }
}

async function _runReapprove(user: {
  id: string
  telegramId?: bigint | number | string | null
  asterAgentEncryptedPK?: string | null
  asterAgentAddress?: string | null
  asterOnboarded?: boolean
}): Promise<ReapproveResult> {
  // Builder fees fully removed — this self-heal only re-mints + re-approves a
  // fresh agent. No builder address, no fee, no approveBuilder step.
  const wallet = await db.wallet.findFirst({ where: { userId: user.id, isActive: true } })
  if (!wallet?.encryptedPK) return { success: false, error: 'no_active_wallet' }

  const { decryptPrivateKey, encryptPrivateKey } = await import('./wallet')
  const { approveAgent } = await import('./aster')
  const { ethers } = await import('ethers')

  // Try every plausible decryption candidate — mirrors /api/aster/approve.
  // Wallets in production were encrypted by different historical paths
  // (some with user.id, some with bare telegramId, some legacy migrations
  // under wallet.userId).
  const idCandidates = Array.from(new Set(
    [user.id, user.telegramId?.toString(), wallet.userId]
      .filter((v): v is string => Boolean(v))
  ))
  let userPk: string | null = null
  let lastErr: any = null
  for (const candidate of idCandidates) {
    try {
      const out = decryptPrivateKey(wallet.encryptedPK, candidate)
      if (out?.startsWith('0x')) { userPk = out; break }
    } catch (e) { lastErr = e }
  }
  if (!userPk) {
    return {
      success: false,
      error: `wallet_pk_undecryptable: ${lastErr?.message ?? 'unknown'} (tried ${idCandidates.length})`,
    }
  }

  // Wrap remaining work in try/finally so userPk is always zeroed,
  // including on unexpected throws between approveAgent and approveBuilder.
  try {
    // Always mint a fresh agent. The existing asterAgentAddress is what
    // Aster is rejecting; reusing it would just hit -1000 again.
    const fresh = ethers.Wallet.createRandom()
    const agentWallet = { address: fresh.address, privateKey: fresh.privateKey }

    let approveResult: { success: boolean; error?: string }
    try {
      approveResult = await approveAgent({
        userAddress:    wallet.address,
        userPrivateKey: userPk,
        agentAddress:   agentWallet.address,
        agentName:      'BUILD4Agent',
        expiredDays:    365,
      })
    } catch (e: any) {
      return { success: false, error: `approve_threw: ${e?.message ?? 'unknown'}` }
    }

    if (!approveResult.success) {
      return { success: false, error: approveResult.error ?? 'approve_failed' }
    }

    // Persist BEFORE attempting builder enrollment — if the process dies
    // mid-builder we still have the working agent saved and can re-enroll
    // the builder later without re-minting.
    const encryptedAgentPk = encryptPrivateKey(agentWallet.privateKey, user.id)
    // Cast: `asterAgentEncryptedPK` exists in the production DB column but
    // is not yet reflected in prisma/schema.prisma. The existing
    // /api/aster/approve handler in server.ts uses the same untyped write,
    // so this matches the codebase's de-facto convention.
    await db.user.update({
      where: { id: user.id },
      data: {
        asterAgentAddress:     agentWallet.address,
        asterAgentEncryptedPK: encryptedAgentPk,
        asterOnboarded:        true,
      } as any,
    })

    // Builder enrollment removed — no fee, so no approveBuilder step. Keep
    // builderEnrolled=false in the result shape for backwards-compatible
    // callers/tests that still read the field.
    const builderEnrolled = false

    return { success: true, agentAddress: agentWallet.address, builderEnrolled }
  } finally {
    userPk = ''
  }
}
