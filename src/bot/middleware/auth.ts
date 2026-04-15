import { Context, NextFunction } from "grammy";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export interface BotContext extends Context {
  dbUser?: {
    id: string;
    telegramId: bigint;
    username: string | null;
  };
}

export async function authMiddleware(ctx: BotContext, next: NextFunction) {
  console.log("[AUTH] Processing update from:", ctx.from?.id, "text:", (ctx.message as any)?.text?.substring(0, 20));
  if (!ctx.from) return next();

  try {
    let user = await prisma.user.findUnique({
      where: { telegramId: BigInt(ctx.from.id) },
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          telegramId: BigInt(ctx.from.id),
          username: ctx.from.username || null,
        },
      });
    } else if (ctx.from.username && user.username !== ctx.from.username) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { username: ctx.from.username },
      });
    }

    ctx.dbUser = {
      id: user.id,
      telegramId: user.telegramId,
      username: user.username,
    };
  } catch (err: any) {
    console.error("[AUTH] Error:", err.message, err.stack?.substring(0, 200));
  }

  console.log("[AUTH] Done, user:", ctx.dbUser?.id?.substring(0, 8), "calling next");
  return next();
}
