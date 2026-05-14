// ─────────────────────────────────────────────────────────────────────────
// fortyTwoAgent — regular (non-campaign) 42.space scan tick.
//
// Owns the */10 cron path so the generic Aster/HL runAllAgents loop
// no longer scans 42.space. Excludes FT_CAMPAIGN_AGENT_ID at the
// scheduler level — the campaign agent runs only on its dedicated
// +5m/+1h30m/+3h/+3h45m scheduler.
//
// Dispatches via the existing runAgentTick path with exchange='fortytwo'
// so trade execution and brain-feed logging stay byte-for-byte identical
// to the legacy generic-loop behavior. Crypto+Price filtering happens
// inside that path (see tradingAgent.ts 42.space branch).
// ─────────────────────────────────────────────────────────────────────────

import { db } from '../db'
import { runAgentTick } from './tradingAgent'
import { runningAgents } from './runner'

interface FortyTwoSweepResult {
  dispatched: number
  skippedCampaign: number
  skippedInflight: number
}

export async function tickAllFortyTwoAgents(): Promise<FortyTwoSweepResult> {
  const result: FortyTwoSweepResult = {
    dispatched: 0, skippedCampaign: 0, skippedInflight: 0,
  }

  const campaignAgentId = process.env.FT_CAMPAIGN_AGENT_ID ?? ''

  let agents: Array<{
    id: string; userId: string; name: string; exchange: string;
    enabledVenues: string[] | null;
  }> = []
  try {
    agents = await db.agent.findMany({
      where: {
        isActive: true,
        ...(campaignAgentId ? { id: { not: campaignAgentId } } : {}),
        OR: [{ enabledVenues: { has: '42' } }, { enabledVenues: { has: 'fortytwo' } }, { exchange: 'fortytwo' }],
      },
      select: { id: true, userId: true, name: true, exchange: true, enabledVenues: true } as any,
    }) as any
  } catch (err) {
    console.warn('[fortyTwoAgent] agent fetch failed:', (err as Error).message)
    return result
  }

  for (const agent of agents) {
    // Defensive: if Postgres returned the campaign row despite the
    // findMany filter (e.g. env var was set after process boot), skip.
    if (campaignAgentId && agent.id === campaignAgentId) {
      result.skippedCampaign++
      continue
    }
    const inflightKey = `${agent.id}:fortytwo`
    if (runningAgents.has(inflightKey)) {
      result.skippedInflight++
      continue
    }
    runningAgents.add(inflightKey)
    const unitAgent = { ...agent, exchange: 'fortytwo' }
    runAgentTick(unitAgent as any)
      .catch((err) => console.error(`[fortyTwoAgent] ${agent.name} error:`, (err as Error).message ?? err))
      .finally(() => runningAgents.delete(inflightKey))
    result.dispatched++
  }

  return result
}
