import type { BotContext } from "../middleware/auth.js";

export async function buyCommand(ctx: BotContext) {
  const text = ctx.message?.text || "";
  const parts = text.split(" ");

  if (parts.length < 3) {
    await ctx.reply(
      "💰 *Buy Tokens*\n\n" +
      "Usage: `/buy <token> <amount>`\n" +
      "Example: `/buy BNB 50`\n\n" +
      "This will swap USDT for the specified token.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const token = parts[1].toUpperCase();
  const amount = parseFloat(parts[2]);

  if (isNaN(amount) || amount <= 0) {
    await ctx.reply("❌ Invalid amount. Use a positive number.");
    return;
  }

  await ctx.reply(
    `💰 *Buy ${token}*\n\n` +
    `Amount: $${amount} USDT\n` +
    `Token: ${token}\n\n` +
    `⚠️ DEX swap integration pending.\nThis feature requires exchange API keys to execute trades.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: `✅ Confirm Buy $${amount}`, callback_data: `buy_confirm_${token}_${amount}` },
            { text: "❌ Cancel", callback_data: "buy_cancel" },
          ],
        ],
      },
    }
  );
}

export async function sellCommand(ctx: BotContext) {
  await ctx.reply(
    "💸 *Sell Tokens*\n\n" +
    "Select percentage to sell:\n" +
    "This feature requires connected exchange API keys.",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "25%", callback_data: "sell_25" },
            { text: "50%", callback_data: "sell_50" },
            { text: "75%", callback_data: "sell_75" },
            { text: "100%", callback_data: "sell_100" },
          ],
        ],
      },
    }
  );
}
