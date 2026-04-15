import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function updatePortfolio(userId: string) {
  const trades = await prisma.trade.findMany({
    where: { userId, status: "closed" },
  });

  const totalPnl = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayTrades = trades.filter((t) => t.closedAt && t.closedAt >= today);
  const dayPnl = todayTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);

  const verifiedCount = trades.filter((t) => t.txHash).length;
  const verifiedOnChain = trades.length > 0 && verifiedCount / trades.length > 0.8;

  await prisma.portfolio.upsert({
    where: { userId },
    create: {
      userId,
      totalPnl,
      dayPnl,
      verifiedOnChain,
    },
    update: {
      totalPnl,
      dayPnl,
      verifiedOnChain,
      lastUpdated: new Date(),
    },
  });
}
