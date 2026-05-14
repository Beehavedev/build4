// Regular (non-campaign) 42.space scan tick. Owns the */10 cron path
// so the generic Aster/HL runAllAgents loop no longer scans 42.space.
// Excludes FT_CAMPAIGN_AGENT_ID via the DB filter; the campaign agent
// runs only on its dedicated +5m/+1h30m/+3h/+3h45m scheduler.
//
// Dispatches via the existing runAgentTick path so trade execution and
// brain-feed logging stay identical to the legacy generic-loop
// behavior. The crypto+price filter lives inside that path.

import type { Agent } from '@prisma/client'
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

  let agents: Agent[] = []
  try {
    agents = await db.agent.findMany({
      where: {
        isActive: true,
        isPaused: false,
        ...(campaignAgentId ? { id: { not: campaignAgentId } } : {}),
        OR: [
          { enabledVenues: { has: '42' } },
          { enabledVenues: { has: 'fortytwo' } },
          { exchange: 'fortytwo' },
          { exchange: '42' },
        ],
      },
    })
  } catch (err) {
    console.warn('[fortyTwoAgent] agent fetch failed:', (err as Error).message)
    return result
  }

  for (const agent of agents) {
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
    const unitAgent: Agent = { ...agent, exchange: 'fortytwo' }
    runAgentTick(unitAgent)
      .catch((err: unknown) =>
        console.error(`[fortyTwoAgent] ${agent.name} error:`, err instanceof Error ? err.message : String(err)),
      )
      .finally(() => runningAgents.delete(inflightKey))
    result.dispatched++
  }

  return result
}
