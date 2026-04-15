import type { BotContext } from "../middleware/auth.js";

export async function asterCommand(ctx: BotContext) {
  if (!ctx.dbUser) {
    await ctx.reply("Please use /start first.");
    return;
  }

  await ctx.reply(
    `⭐ *Aster DEX*\n\n` +
    `Aster is a decentralized perpetual exchange on BSC.\n\n` +
    `*Features:*\n` +
    `• Up to 50x leverage on perpetuals\n` +
    `• Low fees and deep liquidity\n` +
    `• BTC, ETH, BNB and more pairs\n\n` +
    `*Trading via Build4:*\n` +
    `Your AI agents trade on Aster automatically.\n` +
    `Create an agent and it will execute trades for you.\n\n` +
    `*Quick actions:*`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🤖 Create Agent", callback_data: "cmd_newagent" },
            { text: "📊 My Agents", callback_data: "cmd_agents" },
          ],
          [
            { text: "📈 Trade Status", callback_data: "cmd_tradestatus" },
            { text: "💰 Portfolio", callback_data: "cmd_portfolio" },
          ],
        ],
      },
    }
  );
}
