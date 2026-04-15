import { PrismaClient } from "@prisma/client";
import type { BotContext } from "../middleware/auth.js";

const prisma = new PrismaClient();

export async function copyTradeCommand(ctx: BotContext) {
  if (!ctx.dbUser) { await ctx.reply("Please use /start first."); return; }

  const topTraders = await prisma.user.findMany({
    where: {
      portfolio: { totalPnl: { gt: 0 } },
    },
    include: { portfolio: true },
    orderBy: { portfolio: { totalPnl: "desc" } },
    take: 10,
  });

  if (topTraders.length === 0) {
    await ctx.reply(
      "🏆 *Copy Trading Leaderboard*\n\n" +
      "No traders on the leaderboard yet.\n" +
      "Be the first — start trading to appear here!",
      { parse_mode: "Markdown" }
    );
    return;
  }

  let text = "🏆 *Copy Trading — Top 10*\n\n";

  topTraders.forEach((trader, i) => {
    const p = trader.portfolio;
    const verified = (p?.verifiedOnChain) ? "✅" : "";
    const name = trader.username ? `@${trader.username}` : `User ${trader.telegramId.toString().slice(-4)}`;
    text += `${i + 1}. ${name} ${verified}\n`;
    text += `   PnL: $${(p?.totalPnl ?? 0).toFixed(2)} | Day: $${(p?.dayPnl ?? 0).toFixed(2)}\n\n`;
  });

  const buttons = topTraders.slice(0, 5).map((t) => [
    { text: `Follow ${t.username || "User"}`, callback_data: `copy_follow_${t.id}` },
  ]);

  await ctx.reply(text, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buttons },
  });
}
