import { PrismaClient } from "@prisma/client";
import type { BotContext } from "../middleware/auth.js";

const prisma = new PrismaClient();

export async function tradeCommand(ctx: BotContext) {
  if (!ctx.dbUser) { await ctx.reply("Please use /start first."); return; }

  const agents = await prisma.agent.findMany({ where: { userId: ctx.dbUser.id } });

  if (agents.length === 0) {
    await ctx.reply(
      "🤖 You don't have a trading agent yet.\n\nCreate one to start automated trading!",
      {
        reply_markup: {
          inline_keyboard: [[{ text: "🤖 Create Agent", callback_data: "cmd_newagent" }]],
        },
      }
    );
    return;
  }

  let text = "🤖 *Your Trading Agents*\n\n";
  const buttons: any[] = [];

  for (const agent of agents) {
    const status = agent.isActive ? (agent.isPaused ? "⏸ Paused" : "▶️ Active") : "⏹ Stopped";
    text += `*${agent.name}* — ${status}\n`;
    text += `Exchange: ${agent.exchange} | Pairs: ${agent.pairs.join(", ")}\n`;
    text += `PnL: $${agent.totalPnl.toFixed(2)} | Win: ${(agent.winRate * 100).toFixed(0)}%\n\n`;

    if (agent.isActive && !agent.isPaused) {
      buttons.push([{ text: `⏸ Pause ${agent.name}`, callback_data: `agent_pause_${agent.id}` }]);
    } else {
      buttons.push([{ text: `▶️ Start ${agent.name}`, callback_data: `agent_start_${agent.id}` }]);
    }
  }

  await ctx.reply(text, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buttons },
  });
}

export async function tradeStatusCommand(ctx: BotContext) {
  if (!ctx.dbUser) { await ctx.reply("Please use /start first."); return; }

  const openTrades = await prisma.trade.findMany({
    where: { userId: ctx.dbUser.id, status: "open" },
    include: { agent: true },
  });

  if (openTrades.length === 0) {
    await ctx.reply("📊 No open positions.\n\nStart a trading agent to begin.");
    return;
  }

  let text = "📊 *Open Positions*\n\n";
  let totalPnl = 0;

  for (const t of openTrades) {
    const pnl = t.pnl ?? 0;
    totalPnl += pnl;
    const emoji = pnl >= 0 ? "🟢" : "🔴";
    text += `${emoji} *${t.pair}* ${t.side}\n`;
    text += `Entry: $${t.entryPrice} | Size: $${t.size} | ${t.leverage}x\n`;
    if (t.agent) text += `Agent: ${t.agent.name}\n`;
    text += `PnL: $${pnl.toFixed(2)}\n\n`;
  }

  text += `*Today's PnL:* $${totalPnl.toFixed(2)}`;

  await ctx.reply(text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [[{ text: "🔄 Refresh", callback_data: "cmd_tradestatus" }]],
    },
  });
}
