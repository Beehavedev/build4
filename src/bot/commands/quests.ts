import { PrismaClient } from "@prisma/client";
import type { BotContext } from "../middleware/auth.js";

const prisma = new PrismaClient();

export async function questsCommand(ctx: BotContext) {
  if (!ctx.dbUser) { await ctx.reply("Please use /start first."); return; }

  const quests = await prisma.quest.findMany({ where: { isActive: true } });
  const userQuests = await prisma.userQuest.findMany({
    where: { userId: ctx.dbUser.id },
  });

  const progressMap = new Map(userQuests.map((uq) => [uq.questId, uq]));

  if (quests.length === 0) {
    await ctx.reply("🎯 No quests available right now. Check back soon!");
    return;
  }

  let text = "🎯 *Quests & Rewards*\n\n";

  for (const q of quests) {
    const uq = progressMap.get(q.id);
    const progress = uq?.progress ?? 0;
    const req = (q.requirement as any)?.count ?? 1;
    const pct = Math.min(100, Math.round((progress / req) * 100));
    const filled = Math.round(pct / 10);
    const bar = "█".repeat(filled) + "░".repeat(10 - filled);
    const done = uq?.completed ? " ✅" : "";

    text += `*${q.title}*${done}\n`;
    text += `${q.description}\n`;
    text += `${bar} ${pct}% (${progress}/${req})\n`;
    text += `Reward: ${q.reward} $B4${uq?.completed && !uq.claimedAt ? " [Claim]" : ""}\n\n`;
  }

  await ctx.reply(text, { parse_mode: "Markdown" });
}
