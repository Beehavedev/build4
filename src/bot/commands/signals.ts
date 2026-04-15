import type { BotContext } from "../middleware/auth.js";

const MOCK_SIGNALS = [
  {
    token: "BTC",
    type: "WHALE",
    detail: "A wallet moved 150 BTC to Binance",
    accuracy: "71%",
    context: "Price up 2.1% in last hour, volume 2.5x average",
    strength: "HIGH",
  },
  {
    token: "ETH",
    type: "ACCUMULATION",
    detail: "3 known wallets accumulated 5,000 ETH in 24h",
    accuracy: "65%",
    context: "RSI at 35, approaching oversold",
    strength: "MEDIUM",
  },
  {
    token: "BNB",
    type: "OI SPIKE",
    detail: "Open interest spiked 40% in 4 hours",
    accuracy: "58%",
    context: "Price consolidating near $600 support",
    strength: "MEDIUM",
  },
];

export async function signalsCommand(ctx: BotContext) {
  for (const signal of MOCK_SIGNALS) {
    const emoji = signal.type === "WHALE" ? "🐋" : signal.type === "ACCUMULATION" ? "📈" : "⚡";

    await ctx.reply(
      `${emoji} *${signal.type} SIGNAL — ${signal.token}*\n` +
      `${signal.detail}\n` +
      `This wallet has 3 correct calls in past 30d (${signal.accuracy} accuracy)\n\n` +
      `📊 Context: ${signal.context}\n` +
      `⚡ Signal strength: *${signal.strength}*`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🔍 Scan Contract", callback_data: `scan_${signal.token}` },
              { text: "💰 Buy Now", callback_data: `buy_${signal.token}` },
            ],
          ],
        },
      }
    );
  }

  await ctx.reply("🔄 *Refresh for latest signals:*", {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [[{ text: "🔄 Refresh Signals", callback_data: "cmd_signals" }]],
    },
  });
}
