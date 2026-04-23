import { test } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../db'
import { getMostRecentLiveSwarmPrediction } from '../services/fortyTwoExecutor'

// We don't connect to a real database — we replace db.$queryRawUnsafe with a
// spy after import. The function only reads via $queryRawUnsafe, so this is
// sufficient to assert (a) the SQL filters correctly and (b) the row mapping
// is correct.
function withMockedQuery(
  rows: any[],
  body: (calls: { sql: string; params: any[] }[]) => Promise<void>,
): Promise<void> {
  const original = db.$queryRawUnsafe
  const calls: { sql: string; params: any[] }[] = []
  ;(db as any).$queryRawUnsafe = async (sql: string, ...params: any[]) => {
    calls.push({ sql, params })
    return rows
  }
  return body(calls).finally(() => {
    ;(db as any).$queryRawUnsafe = original
  })
}

test('getMostRecentLiveSwarmPrediction first query filters on status=open AND providers IS NOT NULL AND paperTrade=false AND txHashOpen IS NOT NULL', async () => {
  // Both queries return empty so we can inspect the full fallback chain.
  await withMockedQuery([], async (calls) => {
    const result = await getMostRecentLiveSwarmPrediction()
    assert.equal(result, null, 'returns null when neither swarm nor any-live row matches')
    // We expect TWO calls: swarm-preferred first, then any-live fallback.
    assert.equal(calls.length, 2, 'expected fallback to issue a second query')

    const sql0 = calls[0].sql.replace(/\s+/g, ' ')
    // All four swarm filters present.
    assert.match(sql0, /"providers"\s+IS NOT NULL/i, 'first query must filter providers IS NOT NULL')
    assert.match(sql0, /"paperTrade"\s*=\s*false/i, 'first query must filter paperTrade = false')
    assert.match(sql0, /"txHashOpen"\s+IS NOT NULL/i, 'first query must filter txHashOpen IS NOT NULL')
    assert.match(sql0, /status\s*=\s*'open'/i, "first query must filter status = 'open'")
    assert.match(sql0, /ORDER BY\s+"openedAt"\s+DESC/i)
    assert.match(sql0, /LIMIT\s+1/i)
    assert.match(sql0, /FROM\s+"OutcomePosition"/i)

    const sql1 = calls[1].sql.replace(/\s+/g, ' ')
    // Fallback drops the providers filter but keeps the live + open guards.
    assert.doesNotMatch(sql1, /"providers"\s+IS NOT NULL/i, 'fallback query must NOT require providers')
    assert.match(sql1, /"paperTrade"\s*=\s*false/i, 'fallback must still require live trade')
    assert.match(sql1, /"txHashOpen"\s+IS NOT NULL/i, 'fallback must still require an on-chain tx')
    assert.match(sql1, /status\s*=\s*'open'/i, "fallback must still require status = 'open'")
    assert.match(sql1, /ORDER BY\s+"openedAt"\s+DESC/i)
    assert.match(sql1, /LIMIT\s+1/i)
    assert.match(sql1, /FROM\s+"OutcomePosition"/i)
  })
})

test('getMostRecentLiveSwarmPrediction skips fallback when first (swarm-preferred) query returns rows', async () => {
  const swarmRow = {
    id: 'pos_swarm', userId: 'u', agentId: 'a', marketAddress: '0x1', marketTitle: 'q',
    tokenId: 1, outcomeLabel: 'YES', usdtIn: 1, entryPrice: 0.5, exitPrice: null, payoutUsdt: null,
    pnl: null, status: 'open', paperTrade: false, txHashOpen: '0xtx', txHashClose: null,
    reasoning: 'r', openedAt: new Date(), closedAt: null, outcomeTokenAmount: 1.5,
    providers: [{ provider: 'anthropic' }],
  }
  await withMockedQuery([swarmRow], async (calls) => {
    const result = await getMostRecentLiveSwarmPrediction()
    assert.ok(result)
    assert.equal(result!.id, 'pos_swarm')
    assert.equal(calls.length, 1, 'swarm row found → must NOT issue the fallback query')
  })
})

test('getMostRecentLiveSwarmPrediction returns the first row when one matches', async () => {
  const row = {
    id: 'pos_1',
    userId: 'u_1',
    agentId: 'a_1',
    marketAddress: '0xabc',
    marketTitle: 'Will BTC hit $80k?',
    tokenId: 1,
    outcomeLabel: 'YES',
    usdtIn: 2,
    entryPrice: 0.6,
    exitPrice: null,
    payoutUsdt: null,
    pnl: null,
    status: 'open',
    paperTrade: false,
    txHashOpen: '0xdeadbeef',
    txHashClose: null,
    reasoning: 'edge',
    openedAt: new Date(),
    closedAt: null,
    outcomeTokenAmount: 3.33,
    providers: [
      { provider: 'anthropic', model: 'claude', action: 'OPEN_LONG', reasoning: 'r', latencyMs: 5, tokensUsed: 10 },
    ],
  }
  await withMockedQuery([row, { ...row, id: 'pos_2' }], async () => {
    const result = await getMostRecentLiveSwarmPrediction()
    assert.ok(result)
    assert.equal(result!.id, 'pos_1', 'returns the first (most recent) row')
    assert.equal(result!.paperTrade, false)
    assert.equal(result!.txHashOpen, '0xdeadbeef')
    assert.ok(Array.isArray(result!.providers))
  })
})
