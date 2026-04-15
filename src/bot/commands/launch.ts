import type { BotContext } from "../middleware/auth.js";

export async function launchCommand(ctx: BotContext) {
  await ctx.reply(
    "🚀 *Token Launch Wizard*\n\n" +
    "Launch your own token on BSC!\n\n" +
    "Step 1: What's your token name?",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "❌ Cancel", callback_data: "launch_cancel" }],
        ],
      },
    }
  );
}
