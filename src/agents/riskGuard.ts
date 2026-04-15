import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

interface RiskCheck {
  allowed: boolean;
  reason?: string;
}

export async function checkRisk(agentId: string): Promise<RiskCheck> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: { trades: { where: { status: "open" } } },
  });

  if (!agent) return { allowed: false, reason: "Agent not found" };
  if (!agent.isActive) return { allowed: false, reason: "Agent is not active" };
  if (agent.isPaused) return { allowed: false, reason: "Agent is paused" };

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const todayTrades = await prisma.trade.findMany({
    where: {
      agentId,
      closedAt: { gte: today },
      status: "closed",
    },
  });

  const todayPnl = todayTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);

  if (todayPnl <= -agent.maxDailyLoss) {
    await prisma.agent.update({
      where: { id: agentId },
      data: { isPaused: true },
    });
    return {
      allowed: false,
      reason: `Daily loss limit hit: $${todayPnl.toFixed(2)} / -$${agent.maxDailyLoss}`,
    };
  }

  return { allowed: true };
}

export function validateTradeParams(
  agent: { maxPositionSize: number; maxLeverage: number },
  size: number,
  leverage: number
): { size: number; leverage: number; clamped: boolean } {
  let clamped = false;
  let finalSize = size;
  let finalLev = leverage;

  if (size > agent.maxPositionSize) {
    finalSize = agent.maxPositionSize;
    clamped = true;
  }

  if (leverage > agent.maxLeverage) {
    finalLev = agent.maxLeverage;
    clamped = true;
  }

  return { size: finalSize, leverage: finalLev, clamped };
}
