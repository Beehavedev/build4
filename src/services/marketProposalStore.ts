/**
 * Persistence layer for the market-creator agent's proposal queue.
 *
 * Lifecycle:
 *   researched → approved → submitted → live
 *                       ↘ rejected
 *
 * - `researched`  — created by the agent after Claude's eval pass.
 * - `approved`    — admin verified the proposal in the queue.
 * - `submitted`   — admin sent it to the 42.space team for manual creation
 *                   (until 42.space ships a creation API, this is a webhook
 *                   ping or a Telegram message; tracked here for audit).
 * - `live`        — 42.space confirmed the market exists; marketAddress filled.
 * - `rejected`    — admin or Claude declined the proposal.
 *
 * Uses raw SQL via Prisma's $queryRawUnsafe to dodge the regenerated-client
 * problem (the rest of the codebase follows the same pattern for new tables).
 */

import { db } from '../db'

export type ProposalStatus = 'researched' | 'approved' | 'submitted' | 'live' | 'rejected'

export interface ProposalScores {
  newsAuthority: number    // 0-25
  socialVolume: number     // 0-25
  financialStake: number   // 0-25
  resolvability: number    // 0-25
}

export interface MarketProposal {
  id: string
  status: ProposalStatus
  category: string | null
  sourceType: 'news' | 'token'
  question: string
  outcomes: string[]
  resolutionDate: Date | null
  resolutionCriteria: string | null
  resolutionSource: string | null
  totalScore: number
  scores: ProposalScores
  estimatedInterest: 'low' | 'medium' | 'high' | 'viral' | null
  claudeReasoning: string | null
  rawSignal: unknown
  marketAddress: string | null
  createdAt: Date
  submittedAt: Date | null
  liveAt: Date | null
}

export interface CreateProposalInput {
  status?: ProposalStatus
  category: string
  sourceType: 'news' | 'token'
  question: string
  outcomes: string[]
  resolutionDate: Date | null
  resolutionCriteria: string
  resolutionSource: string
  totalScore: number
  scores: ProposalScores
  estimatedInterest: 'low' | 'medium' | 'high' | 'viral'
  claudeReasoning: string
  rawSignal: unknown
}

/** Insert a new proposal. Returns the created row's id. */
export async function createProposal(input: CreateProposalInput): Promise<string> {
  const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `INSERT INTO "MarketProposal" (
       "status","category","sourceType","question","outcomes","resolutionDate",
       "resolutionCriteria","resolutionSource","totalScore","scores",
       "estimatedInterest","claudeReasoning","rawSignal"
     ) VALUES (
       $1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb
     ) RETURNING id`,
    input.status ?? 'researched',
    input.category,
    input.sourceType,
    input.question,
    JSON.stringify(input.outcomes),
    input.resolutionDate,
    input.resolutionCriteria,
    input.resolutionSource,
    input.totalScore,
    JSON.stringify(input.scores),
    input.estimatedInterest,
    input.claudeReasoning,
    JSON.stringify(input.rawSignal),
  )
  return rows[0].id
}

/**
 * List proposals filtered by status. Most recent first. Used by the admin
 * queue UI and Telegram digest.
 */
export async function listProposals(opts: {
  status?: ProposalStatus | ProposalStatus[]
  limit?: number
} = {}): Promise<MarketProposal[]> {
  // Clamp limit to a positive int <=200 — defensive even when callers
  // already coerce, since this value is interpolated into the SQL string
  // (raw $queryRawUnsafe doesn't bind LIMIT safely).
  const limit = Math.max(1, Math.min(200, Math.floor(Number(opts.limit ?? 50)) || 50))
  let where = ''
  const params: unknown[] = []
  if (opts.status) {
    const statuses = Array.isArray(opts.status) ? opts.status : [opts.status]
    where = `WHERE status = ANY($1::text[])`
    params.push(statuses)
  }
  const rows = await db.$queryRawUnsafe<RawProposalRow[]>(
    `SELECT id,status,category,"sourceType",question,outcomes,"resolutionDate",
            "resolutionCriteria","resolutionSource","totalScore",scores,
            "estimatedInterest","claudeReasoning","rawSignal","marketAddress",
            "createdAt","submittedAt","liveAt"
     FROM "MarketProposal"
     ${where}
     ORDER BY "createdAt" DESC
     LIMIT ${limit}`,
    ...params,
  )
  return rows.map(rowToProposal)
}

export async function getProposalById(id: string): Promise<MarketProposal | null> {
  const rows = await db.$queryRawUnsafe<RawProposalRow[]>(
    `SELECT id,status,category,"sourceType",question,outcomes,"resolutionDate",
            "resolutionCriteria","resolutionSource","totalScore",scores,
            "estimatedInterest","claudeReasoning","rawSignal","marketAddress",
            "createdAt","submittedAt","liveAt"
     FROM "MarketProposal" WHERE id = $1 LIMIT 1`,
    id,
  )
  if (rows.length === 0) return null
  return rowToProposal(rows[0])
}

/**
 * Transition a proposal's status. `submitted` and `live` also stamp the
 * corresponding timestamp columns.
 */
export async function updateProposalStatus(
  id: string,
  status: ProposalStatus,
  opts: { marketAddress?: string } = {},
): Promise<void> {
  if (status === 'submitted') {
    await db.$executeRawUnsafe(
      `UPDATE "MarketProposal" SET status = $1, "submittedAt" = NOW() WHERE id = $2`,
      status, id,
    )
  } else if (status === 'live') {
    await db.$executeRawUnsafe(
      `UPDATE "MarketProposal"
       SET status = $1, "liveAt" = NOW(), "marketAddress" = $2
       WHERE id = $3`,
      status, opts.marketAddress ?? null, id,
    )
  } else {
    await db.$executeRawUnsafe(
      `UPDATE "MarketProposal" SET status = $1 WHERE id = $2`,
      status, id,
    )
  }
}

/**
 * Returns true if a proposal with substantially the same question already
 * exists. Used for de-dup against both our own queue and (caller-supplied)
 * 42.space's existing markets so we don't propose the same market twice.
 */
export async function findDuplicate(question: string): Promise<MarketProposal | null> {
  // Cheap normalisation: lowercase, strip punctuation, collapse whitespace.
  // Anything fuzzier (embeddings) would be overkill at this scale.
  const norm = question.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
  const rows = await db.$queryRawUnsafe<RawProposalRow[]>(
    `SELECT id,status,category,"sourceType",question,outcomes,"resolutionDate",
            "resolutionCriteria","resolutionSource","totalScore",scores,
            "estimatedInterest","claudeReasoning","rawSignal","marketAddress",
            "createdAt","submittedAt","liveAt"
     FROM "MarketProposal"
     WHERE regexp_replace(lower(question), '[^a-z0-9 ]', '', 'g') = $1
     LIMIT 1`,
    norm,
  )
  if (rows.length === 0) return null
  return rowToProposal(rows[0])
}

interface RawProposalRow {
  id: string
  status: ProposalStatus
  category: string | null
  sourceType: 'news' | 'token'
  question: string
  outcomes: unknown
  resolutionDate: Date | null
  resolutionCriteria: string | null
  resolutionSource: string | null
  totalScore: number
  scores: unknown
  estimatedInterest: 'low' | 'medium' | 'high' | 'viral' | null
  claudeReasoning: string | null
  rawSignal: unknown
  marketAddress: string | null
  createdAt: Date
  submittedAt: Date | null
  liveAt: Date | null
}

function rowToProposal(r: RawProposalRow): MarketProposal {
  return {
    ...r,
    outcomes: parseJsonStringArray(r.outcomes),
    scores: parseScores(r.scores),
  }
}

function parseJsonStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v)
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
    } catch { return [] }
  }
  return []
}

function parseScores(v: unknown): ProposalScores {
  const fallback: ProposalScores = {
    newsAuthority: 0, socialVolume: 0, financialStake: 0, resolvability: 0,
  }
  let obj: Record<string, unknown>
  if (typeof v === 'string') {
    try { obj = JSON.parse(v) } catch { return fallback }
  } else if (v && typeof v === 'object') {
    obj = v as Record<string, unknown>
  } else { return fallback }
  return {
    newsAuthority: Number(obj.newsAuthority) || 0,
    socialVolume: Number(obj.socialVolume) || 0,
    financialStake: Number(obj.financialStake) || 0,
    resolvability: Number(obj.resolvability) || 0,
  }
}
