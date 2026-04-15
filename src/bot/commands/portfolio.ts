import { PrismaClient } from "@prisma/client";
import type { BotContext } from "../middleware/auth.js";

const prisma = new PrismaClient();

export async function portfolioCommand(ctx: BotContext) {
  if (!ctx.dbUser) { await ctx.reply("Please use /start first."); return; }

  const portfolio = await prisma.portfolio.findUnique({
    where: { userId: ctx.dbUser.id },
  });

  const recentTrades = await prisma.trade.findMany({
    where: { userId: ctx.dbUser.id },
    orderBy: { openedAt: "desc" },
    take: 5,
  });

  const totalValue = portfolio?.totalValue ?? 0;
  const totalPnl = portfolio?.totalPnl ?? 0;
  const dayPnl = portfolio?.dayPnl ?? 0;
  const verified = portfolio?.verifiedOnChain ? "✅ Verified" : "⏳ Unverified";

  let text = `📊 *Your Portfolio*\n\n`;
  text += `💰 Total Value: *$${totalValue.toFixed(2)}*\n`;
  text += `📈 Total PnL: *$${totalPnl.toFixed(2)}*\n`;
  text += `📅 Today's PnL: *$${dayPnl.toFixed(2)}*\n`;
  text += `🔗 ${verified}\n\n`;

  if (recentTrades.length > 0) {
    text += `*Recent Trades*\n`;
    for (const t of recentTrades) {
      const emoji = (t.pnl ?? 0) >= 0 ? "🟢" : "🔴";
      text += `${emoji} ${t.pair} ${t.side} — $${(t.pnl ?? 0).toFixed(2)}\n`;
    }
  } else {
    text += `No trades yet. Start a trading agent!`;
  }

  await ctx.reply(text, { parse_mode: "Markdown" });
}
