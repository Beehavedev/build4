/* eslint-disable @typescript-eslint/no-explicit-any */
import { db } from '../src/db'
import axios from 'axios'

const ASTER_RPC = 'https://tapi.asterdex.com/info'
const MIN_USDT = 1.0
const CONCURRENCY = 15
const PROGRESS_EVERY = 200

async function rpcGetUsdt(walletAddress: string): Promise<number> {
  try {
    const res = await axios.post(
      ASTER_RPC,
      { id: 1, jsonrpc: '2.0', method: 'aster_getBalance', params: [walletAddress, 'latest'] },
      { timeout: 8000, validateStatus: () => true }
    )
    const body: any = res.data ?? {}
    if (body.error) return 0 // "account does not exist" etc.
    const perpAssets: any[] = body.result?.perpAssets ?? []
    const usdt = perpAssets.find((a) => a?.asset === 'USDT' || a?.asset === 'USD')
    return parseFloat(usdt?.walletBalance ?? '0') || 0
  } catch {
    return 0
  }
}

async function main() {
  console.log('[Unpause] Loading paused agents with wallets…')
  const rows = await db.$queryRawUnsafe<{ userId: string; address: string }[]>(`
    SELECT DISTINCT u.id AS "userId", w.address
    FROM "User" u
    JOIN "Agent" a ON a."userId" = u.id AND a."isActive" AND a."isPaused"
    JOIN "Wallet" w ON w."userId" = u.id
    WHERE w.address IS NOT NULL
  `)
  console.log(`[Unpause] ${rows.length} (user,wallet) pairs to balance-check`)

  const balanceByUser = new Map<string, number>()
  let done = 0
  let funded = 0

  console.log(`[Unpause] Starting balance checks, concurrency=${CONCURRENCY}`)
  const startTs = Date.now()
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY)
    try {
      await Promise.all(
        batch.map(async (r) => {
          const usdt = await rpcGetUsdt(r.address)
          const cur = balanceByUser.get(r.userId) ?? 0
          balanceByUser.set(r.userId, cur + usdt)
          done++
        })
      )
    } catch (e: any) {
      console.error('[Unpause] batch error:', e?.message)
    }
    if (done % PROGRESS_EVERY < CONCURRENCY) {
      const rate = (done / ((Date.now() - startTs) / 1000)).toFixed(1)
      funded = [...balanceByUser.values()].filter((v) => v >= MIN_USDT).length
      console.log(`[Unpause] ${done}/${rows.length} (${rate}/s), ${funded} funded so far`)
    }
  }

  const fundedUserIds = [...balanceByUser.entries()]
    .filter(([, v]) => v >= MIN_USDT)
    .map(([uid]) => uid)

  console.log(`[Unpause] ${fundedUserIds.length} funded users (≥$${MIN_USDT})`)
  if (fundedUserIds.length === 0) {
    console.log('[Unpause] Nothing to unpause. Exiting.')
    process.exit(0)
  }

  const result = await db.agent.updateMany({
    where: {
      isActive: true,
      isPaused: true,
      userId: { in: fundedUserIds }
    },
    data: { isPaused: false }
  })

  console.log(`[Unpause] ✅ Unpaused ${result.count} agents across ${fundedUserIds.length} users.`)
  process.exit(0)
}

main().catch((e) => {
  console.error('[Unpause] FAILED:', e)
  process.exit(1)
})
