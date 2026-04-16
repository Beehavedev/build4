import { Agent } from '@prisma/client'
import { db } from '../db'

export interface RiskCheckResult {
  allowed: boolean
  reason?: string
  reduceSizeBy?: number // percentage to reduce size by
}

export async function checkRiskGuard(
  agent: Agent,
  pair: string,
  side: 'LONG' | 'SHORT',
  proposedSize: number,
  proposedLeverage: number
): Promise<RiskCheckResult> {
  // 1. Get today's PnL
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)

  const todayTrades = await db.trade.findMany({
    where: {
      agentId: agent.id,
      closedAt: { gte: todayStart },
      status: 'closed'
    },
    select: { pnl: true }
  })

  const todayPnl = todayTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0)

  // Hard stop: daily loss limit hit
  if (todayPnl <= -agent.maxDailyLoss) {
    return {
      allowed: false,
      reason: `Daily loss limit reached: ${todayPnl.toFixed(2)} USDT lost today (limit: ${agent.maxDailyLoss} USDT)`
    }
  }

  // 2. Check leverage
  if (proposedLeverage > agent.maxLeverage) {
    return {
      allowed: false,
      reason: `Proposed leverage ${proposedLeverage}x exceeds agent max ${agent.maxLeverage}x`
    }
  }

  // 3. Check position size
  if (proposedSize > agent.maxPositionSize) {
    return {
      allowed: false,
      reason: `Proposed size $${proposedSize} exceeds agent max $${agent.maxPositionSize}`
    }
  }

  // 4. Check for existing open position in same pair + same side
  const existingPosition = await db.trade.findFirst({
    where: {
      agentId: agent.id,
      pair,
      side,
      status: 'open'
    }
  })

  if (existingPosition) {
    return {
      allowed: false,
      reason: `Already have open ${side} position in ${pair}`
    }
  }

  // 5. Soft checks — reduce size but allow
  let reduceSizeBy = 0

  // Within 20% of daily loss limit — reduce size heavily
  const remainingLoss = agent.maxDailyLoss + todayPnl
  if (remainingLoss < agent.maxDailyLoss * 0.2) {
    reduceSizeBy = 75
  } else if (remainingLoss < agent.maxDailyLoss * 0.5) {
    reduceSizeBy = 40
  }

  // Last 2 trades were losses — drawdown mode
  const lastTwoTrades = await db.trade.findMany({
    where: { agentId: agent.id, status: 'closed' },
    orderBy: { closedAt: 'desc' },
    take: 2,
    select: { pnl: true }
  })

  if (lastTwoTrades.length === 2 && lastTwoTrades.every((t) => (t.pnl ?? 0) < 0)) {
    reduceSizeBy = Math.max(reduceSizeBy, 50)
  }

  // Up >5% today — protect gains
  if (todayPnl > agent.maxPositionSize * 0.05) {
    reduceSizeBy = Math.max(reduceSizeBy, 30)
  }

  return { allowed: true, reduceSizeBy }
}

export async function getTodayPnl(agentId: string): Promise<number> {
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)

  const trades = await db.trade.findMany({
    where: {
      agentId,
      closedAt: { gte: todayStart },
      status: 'closed'
    },
    select: { pnl: true }
  })

  return trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0)
}
