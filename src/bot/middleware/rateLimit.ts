import { Context, NextFunction } from "grammy";

const userCounts = new Map<number, { count: number; resetAt: number }>();

const MAX_PER_MINUTE = 30;

export async function rateLimitMiddleware(ctx: Context, next: NextFunction) {
  if (!ctx.from) return next();

  const userId = ctx.from.id;
  const now = Date.now();
  let entry = userCounts.get(userId);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 60_000 };
    userCounts.set(userId, entry);
  }

  entry.count++;
  if (entry.count > MAX_PER_MINUTE) {
    await ctx.reply("⏳ You're sending too many commands. Please wait a moment.");
    return;
  }

  return next();
}
