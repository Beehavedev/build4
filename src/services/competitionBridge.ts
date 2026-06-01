/**
 * Competition bridge — pushes a per-agent snapshot of the 50-agent fleet to the
 * build4.io competition site so every fleet agent appears on the public
 * leaderboard with live volume + PnL.
 *
 * Why a push bridge: the fleet trades here (the bot, on Render, against the bot
 * DB) but the competition leaderboard lives in the SITE's own external Postgres
 * (build4io-site, SITE_DATABASE_URL) and is populated by the site's own trade
 * hooks. There is no shared DB between the two, so the bot periodically POSTs a
 * snapshot to a site endpoint (`/api/competition/fleet/sync`) which upserts the
 * agents as competition entries and recomputes their on-chain equity itself.
 *
 * Self-custody / safety: the snapshot is PUBLIC data only — agent id, wallet
 * ADDRESS, display name, persona, cumulative volume, trade count, traded token
 * addresses. It NEVER includes private keys. The whole bridge is fail-closed:
 * it is a no-op unless COMPETITION_BRIDGE_ENABLED='true' AND both
 * COMPETITION_SITE_URL and FLEET_BRIDGE_SECRET are set, and it never throws.
 */

import { db } from '../db'
import type { FleetStrategy } from './fleet'

// Map a bot strategy to one of the leaderboard's display personas (the site
// client maps these to icons/colors; unknown values fall back to "Quant").
const STRATEGY_PERSONA: Record<FleetStrategy, string> = {
  momentum: 'Degen',
  dip: 'Hunter',
  trend: 'Quant',
  snipe: 'Sniper',
  conservative: 'Maximalist',
}

export interface FleetCompetitionAgent {
  agentId: string
  walletAddress: string
  name: string
  persona: string
  volumeBnb: number
  tradeCount: number
  trackedTokens: string[]
}

/** True only when every piece of bridge config is present. */
export function isCompetitionBridgeEnabled(): boolean {
  return (
    process.env.COMPETITION_BRIDGE_ENABLED === 'true' &&
    !!process.env.COMPETITION_SITE_URL &&
    !!process.env.FLEET_BRIDGE_SECRET
  )
}

/**
 * Aggregate one row per fleet agent: cumulative REAL (non-mock) volume + trade
 * count + the distinct tokens it has traded. Zero-trade agents are included so
 * the full fleet shows on the leaderboard from day one.
 */
export async function buildFleetCompetitionSnapshot(): Promise<FleetCompetitionAgent[]> {
  const rows = await db.$queryRawUnsafe<Array<{
    agent_id: string
    name: string
    strategy: string
    wallet_address: string
    volume_bnb: number | null
    trade_count: number | bigint | null
    tokens: string[] | null
  }>>(`
    SELECT
      a."id"             AS agent_id,
      a."name"           AS name,
      a."strategy"       AS strategy,
      a."wallet_address" AS wallet_address,
      COALESCE(t.volume_bnb, 0)              AS volume_bnb,
      COALESCE(t.trade_count, 0)            AS trade_count,
      COALESCE(t.tokens, ARRAY[]::text[])   AS tokens
    FROM "fleet_agents" a
    LEFT JOIN (
      SELECT "agent_id",
             SUM(COALESCE("amount_bnb", 0))   AS volume_bnb,
             COUNT(*)                         AS trade_count,
             array_agg(DISTINCT "token_address") AS tokens
      FROM "fleet_trades"
      WHERE "status" = 'filled' AND "mock" = false
      GROUP BY "agent_id"
    ) t ON t."agent_id" = a."id"
    ORDER BY a."strategy", a."name"
  `)

  return rows.map((r) => ({
    agentId: r.agent_id,
    walletAddress: r.wallet_address,
    name: r.name,
    persona: STRATEGY_PERSONA[r.strategy as FleetStrategy] ?? 'Quant',
    volumeBnb: Number(r.volume_bnb) || 0,
    tradeCount: Number(r.trade_count) || 0,
    trackedTokens: (r.tokens ?? []).filter((t): t is string => !!t),
  }))
}

export interface BridgePushResult {
  ok: boolean
  skipped?: boolean
  agents?: number
  status?: number
  error?: string
  summary?: unknown
}

/**
 * Build the snapshot and POST it to the site. Fail-closed + never throws:
 * returns { ok:false, skipped:true } when unconfigured, { ok:false, error } on
 * any failure. Safe to call on a timer.
 */
export async function pushFleetSnapshotToSite(): Promise<BridgePushResult> {
  if (!isCompetitionBridgeEnabled()) return { ok: false, skipped: true }
  const base = String(process.env.COMPETITION_SITE_URL).replace(/\/+$/, '')
  const secret = String(process.env.FLEET_BRIDGE_SECRET)
  try {
    const agents = await buildFleetCompetitionSnapshot()
    const res = await fetch(`${base}/api/competition/fleet/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-fleet-bridge-secret': secret,
      },
      body: JSON.stringify({ agents }),
      signal: AbortSignal.timeout(20_000),
    })
    let summary: unknown = undefined
    try { summary = await res.json() } catch { /* non-JSON body */ }
    if (!res.ok) {
      return { ok: false, status: res.status, agents: agents.length, summary }
    }
    return { ok: true, status: res.status, agents: agents.length, summary }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
