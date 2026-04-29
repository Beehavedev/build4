// ─────────────────────────────────────────────────────────────────────────────
// Aster open-trade reconciliation
//
// When Aster closes a position via SL/TP/liquidation/manual-on-venue, we
// don't always get a callback — the next agent tick may not run for many
// seconds, and the user opens the mini-app to see ghost "open" rows that
// no longer exist on the venue. This module reconciles DB Trade rows
// (status='open', exchange='aster') against a live getPositions snapshot
// and marks any that are missing as closed.
//
// Safety guards:
//   • Only acts when the caller has a SUCCESSFUL live snapshot. Caller
//     passes `liveLookupOk=false` on transient API errors so we don't
//     close every position during an Aster outage.
//   • Skips trades opened in the last 60s — protects against a race
//     where positionRisk hasn't yet reflected a brand-new fill.
//   • Best-effort exit price from Aster mark; falls back to entryPrice
//     so PnL is at least defined.
// ─────────────────────────────────────────────────────────────────────────────
import { db } from '../db'
import { getMarkPrice } from './aster'

export interface LivePositionLike {
  symbol: string
  side: string  // 'LONG' | 'SHORT'
}

const FRESH_TRADE_GRACE_MS = 60_000

export async function reconcileStaleAsterTrades(
  userId: string,
  livePositions: LivePositionLike[],
  liveLookupOk: boolean,
): Promise<{ closed: number }> {
  if (!liveLookupOk) return { closed: 0 }

  const openAsterTrades = await db.trade.findMany({
    where: { userId, status: 'open', exchange: 'aster' },
  })
  if (openAsterTrades.length === 0) return { closed: 0 }

  const liveKeySet = new Set(
    livePositions.map((lp) => `${lp.symbol.toUpperCase()}|${lp.side}`),
  )

  const now = Date.now()
  const stale = openAsterTrades.filter((t) => {
    const ageMs = now - new Date(t.openedAt).getTime()
    if (ageMs < FRESH_TRADE_GRACE_MS) return false
    const key = `${t.pair.toUpperCase()}|${t.side}`
    return !liveKeySet.has(key)
  })
  if (stale.length === 0) return { closed: 0 }

  // Best-effort mark lookup per unique pair, in parallel. We tolerate
  // mark failures — falling back to entryPrice keeps PnL at 0 instead
  // of failing the whole reconcile.
  const uniquePairs = Array.from(new Set(stale.map((t) => t.pair.toUpperCase())))
  const markByPair = new Map<string, number>()
  await Promise.all(
    uniquePairs.map(async (p) => {
      try {
        const m = await getMarkPrice(p)
        if (Number.isFinite(m.markPrice)) markByPair.set(p, m.markPrice)
      } catch { /* ignore — we'll fall back to entry */ }
    }),
  )

  let closedCount = 0
  for (const t of stale) {
    const exitPrice = markByPair.get(t.pair.toUpperCase()) ?? t.entryPrice
    const dir = t.side === 'LONG' ? 1 : -1
    const pnl = (exitPrice - t.entryPrice) * t.size * dir
    const pnlPct =
      t.entryPrice > 0
        ? ((exitPrice - t.entryPrice) / t.entryPrice) * dir * (t.leverage || 1) * 100
        : 0
    try {
      await db.trade.update({
        where: { id: t.id },
        data: {
          status: 'closed',
          exitPrice,
          pnl,
          pnlPct,
          closedAt: new Date(),
          aiReasoning:
            (t.aiReasoning ? t.aiReasoning + ' ' : '') +
            '[auto-reconciled: position no longer live on Aster — likely closed by SL/TP, manual exit on venue, or liquidation]',
        },
      })
      closedCount++
    } catch (err: any) {
      console.warn(
        `[asterReconcile] failed to close stale trade ${t.id} ${t.pair} ${t.side}: ${err?.message ?? err}`,
      )
    }
  }
  if (closedCount > 0) {
    console.log(
      `[asterReconcile] user=${userId} closed ${closedCount} stale Aster trade(s) ` +
        `(no longer present in live positions snapshot)`,
    )
  }
  return { closed: closedCount }
}
