import type { BotContext } from "../middleware/auth.js";

export async function bridgeCommand(ctx: BotContext) {
  if (!ctx.dbUser) {
    await ctx.reply("Please use /start first.");
    return;
  }

  await ctx.reply(
    `🌉 *Bridge Assets*\n\n` +
    `Bridge your assets to BSC for trading on Aster DEX.\n\n` +
    `*Supported bridges:*\n` +
    `• Ethereum → BSC\n` +
    `• Polygon → BSC\n` +
    `• Arbitrum → BSC\n\n` +
    `*How to bridge:*\n` +
    `1. Send tokens to your Build4 wallet on the source chain\n` +
    `2. Use a bridge like [Stargate](https://stargate.finance) or [cBridge](https://cbridge.celer.network)\n` +
    `3. Bridge to your BSC wallet address below\n\n` +
    `Your BSC wallet:\n` +
    `\`${await getActiveAddress(ctx)}\`\n\n` +
    `💡 We recommend bridging USDT for trading.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "💰 View Wallet", callback_data: "cmd_wallet" }],
        ],
      },
    }
  );
}

async function getActiveAddress(ctx: BotContext): Promise<string> {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  const wallet = await prisma.wallet.findFirst({
    where: { userId: ctx.dbUser!.id, chain: "BSC", isActive: true },
  });
  return wallet?.address || "Use /start to create a wallet";
}
