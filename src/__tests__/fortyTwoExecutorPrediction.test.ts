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

test('getMostRecentLiveSwarmPrediction filters to status=open AND providers IS NOT NULL AND paperTrade=false AND txHashOpen IS NOT NULL', async () => {
  await withMockedQuery([], async (calls) => {
    const result = await getMostRecentLiveSwarmPrediction()
    assert.equal(result, null, 'returns null when no rows match')
    assert.equal(calls.length, 1)
    const sql = calls[0].sql.replace(/\s+/g, ' ')
    // All four filters must be present — regression-protect each individually.
    assert.match(sql, /"providers"\s+IS NOT NULL/i, 'must filter providers IS NOT NULL')
    assert.match(sql, /"paperTrade"\s*=\s*false/i, 'must filter paperTrade = false')
    assert.match(sql, /"txHashOpen"\s+IS NOT NULL/i, 'must filter txHashOpen IS NOT NULL')
    assert.match(sql, /status\s*=\s*'open'/i, "must filter status = 'open'")
    // Most-recent ordering and single-row limit.
    assert.match(sql, /ORDER BY\s+"openedAt"\s+DESC/i, 'must order by openedAt DESC')
    assert.match(sql, /LIMIT\s+1/i, 'must limit to 1 row')
    // Reads from the right table.
    assert.match(sql, /FROM\s+"OutcomePosition"/i)
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
