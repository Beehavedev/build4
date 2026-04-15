import { PrismaClient } from "@prisma/client";
import { generateEVMWallet, encryptPrivateKey } from "../../services/wallet.js";
import type { BotContext } from "../middleware/auth.js";

const prisma = new PrismaClient();

export async function startCommand(ctx: BotContext) {
  if (!ctx.from || !ctx.dbUser) {
    await ctx.reply("Something went wrong. Please try again.");
    return;
  }

  try {
    let wallet = await prisma.wallet.findFirst({
      where: { userId: ctx.dbUser.id, chain: "BSC" },
      orderBy: { createdAt: "desc" },
    });

    if (!wallet) {
      const { address, privateKey } = generateEVMWallet();
      const encrypted = encryptPrivateKey(privateKey, ctx.dbUser.id);

      wallet = await prisma.wallet.create({
        data: {
          userId: ctx.dbUser.id,
          chain: "BSC",
          address,
          encryptedPK: encrypted,
          label: "Wallet 1",
          isActive: true,
        },
      });
      console.log(`[START] Created BSC wallet for user ${ctx.from.id}: ${address}`);
    }

    await prisma.portfolio.upsert({
      where: { userId: ctx.dbUser.id },
      create: { userId: ctx.dbUser.id },
      update: {},
    });

    const shortAddr = wallet.address.slice(0, 6) + "..." + wallet.address.slice(-4);

    await ctx.reply(
      `🚀 *Welcome to Build4 Trading Bot!*\n\n` +
      `Your BSC wallet is ready:\n` +
      `\`${shortAddr}\`\n\n` +
      `Deposit USDT (BEP-20) to start trading.\n` +
      `Use the buttons below to get started:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "💰 My Wallet", callback_data: "cmd_wallet" },
              { text: "🤖 Create Agent", callback_data: "cmd_newagent" },
            ],
            [
              { text: "📊 Signals", callback_data: "cmd_signals" },
              { text: "❓ Help", callback_data: "cmd_help" },
            ],
          ],
        },
      }
    );
  } catch (err: any) {
    console.error("[START] Error:", err.message);
    await ctx.reply("⚠️ Wallet setup encountered an issue. Please try /start again in a moment.");
  }
}
