import { PrismaClient } from "@prisma/client";
import type { BotContext } from "../middleware/auth.js";

const prisma = new PrismaClient();

function getMiniAppUrl(): string {
  if (process.env.REPLIT_DEV_DOMAIN) return `https://${process.env.REPLIT_DEV_DOMAIN}/app`;
  if (process.env.RENDER_EXTERNAL_URL) return `${process.env.RENDER_EXTERNAL_URL}/app`;
  return "https://build4.replit.app/app";
}

export async function asterCommand(ctx: BotContext) {
  if (!ctx.dbUser) {
    await ctx.reply("Please use /start first.");
    return;
  }

  const agents = await prisma.agent.findMany({
    where: { userId: ctx.dbUser.id },
  });

  const openTrades = await prisma.trade.findMany({
    where: { userId: ctx.dbUser.id, status: "open" },
  });

  const activeAgents = agents.filter(a => a.isActive && !a.isPaused);
  const totalPnl = agents.reduce((sum, a) => sum + a.totalPnl, 0);
  const totalTrades = agents.reduce((sum, a) => sum + a.totalTrades, 0);

  let text = `⭐ *Aster DEX — Trading Hub*\n\n`;

  if (agents.length > 0) {
    text += `*Your Agents:* ${agents.length} total, ${activeAgents.length} active\n`;
    text += `*Open Positions:* ${openTrades.length}\n`;
    text += `*Total Trades:* ${totalTrades}\n`;
    text += `*Total PnL:* $${totalPnl.toFixed(2)}\n\n`;

    for (const a of agents) {
      const status = a.isActive ? (a.isPaused ? "⏸" : "▶️") : "⏹";
      text += `${status} *${a.name}* — ${a.pairs.join(", ")}\n`;
      text += `   ${a.totalTrades} trades | Win: ${(a.winRate * 100).toFixed(0)}% | PnL: $${a.totalPnl.toFixed(2)}\n`;
    }
  } else {
    text += `You have no trading agents yet.\n`;
    text += `Create an AI agent to trade autonomously on Aster DEX.\n\n`;
    text += `*How it works:*\n`;
    text += `1. Create an agent with your strategy\n`;
    text += `2. Fund your wallet with USDT\n`;
    text += `3. Start the agent — AI trades 24/7\n`;
    text += `4. Monitor positions & PnL in real time`;
  }

  const buttons: any[][] = [];

  if (activeAgents.length > 0) {
    buttons.push([
      { text: "📊 Open Positions", callback_data: "cmd_tradestatus" },
      { text: "💼 Portfolio", callback_data: "cmd_portfolio" },
    ]);
  }

  if (agents.length > 0) {
    const agentButtons = agents.slice(0, 3).map(a => ({
      text: `${a.isActive && !a.isPaused ? "⏸" : "▶️"} ${a.name}`,
      callback_data: a.isActive && !a.isPaused ? `agent_pause_${a.id}` : `agent_start_${a.id}`,
    }));
    buttons.push(agentButtons);
  }

  buttons.push([
    { text: "⭐ Trade on AsterDex", web_app: { url: getMiniAppUrl() } },
  ]);

  buttons.push([
    { text: "🤖 Create Agent", callback_data: "cmd_newagent" },
    { text: "📈 My Agents", callback_data: "cmd_agents" },
  ]);

  buttons.push([
    { text: "🌉 Bridge Assets", callback_data: "cmd_bridge" },
    { text: "💰 Wallet", callback_data: "cmd_wallet" },
  ]);

  await ctx.reply(text, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buttons },
  });
}
