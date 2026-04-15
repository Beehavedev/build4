import { PrismaClient } from "@prisma/client";
import type { BotContext } from "../middleware/auth.js";

const prisma = new PrismaClient();

export async function agentsCommand(ctx: BotContext) {
  if (!ctx.dbUser) { await ctx.reply("Please use /start first."); return; }

  const agents = await prisma.agent.findMany({
    where: { userId: ctx.dbUser.id },
    orderBy: { createdAt: "desc" },
  });

  if (agents.length === 0) {
    await ctx.reply(
      "🤖 No agents yet.\n\nCreate your first AI trading agent!",
      {
        reply_markup: {
          inline_keyboard: [[{ text: "🤖 Create Agent", callback_data: "cmd_newagent" }]],
        },
      }
    );
    return;
  }

  let text = "🤖 *Your Agents*\n\n";

  for (const a of agents) {
    const status = a.isActive ? (a.isPaused ? "⏸" : "▶️") : "⏹";
    text += `${status} *${a.name}*\n`;
    if (a.description) text += `_${a.description}_\n`;
    text += `Exchange: ${a.exchange} | ${a.pairs.join(", ")}\n`;
    text += `Trades: ${a.totalTrades} | Win: ${(a.winRate * 100).toFixed(0)}% | PnL: $${a.totalPnl.toFixed(2)}\n`;
    text += `Risk: ${a.maxLeverage}x lev, $${a.maxPositionSize} max, $${a.maxDailyLoss} daily loss\n`;

    const registry: string[] = [];
    if (a.erc8004Registered) registry.push(`ERC-8004 ✅ (${a.erc8004Chain || "bnb"} #${a.erc8004TokenId || "?"})`);
    if (a.bap578Registered) registry.push("BAP-578 ✅");
    if (a.onchainRegistered) registry.push("On-chain ✅");

    if (registry.length > 0) {
      text += `🔗 Registry: ${registry.join(" | ")}\n`;
    }
    if (a.erc8004TxHash) {
      const shortTx = a.erc8004TxHash.slice(0, 10) + "..." + a.erc8004TxHash.slice(-6);
      text += `📜 Tx: \`${shortTx}\`\n`;
    }
    if (a.creatorWallet) {
      const shortWallet = a.creatorWallet.slice(0, 6) + "..." + a.creatorWallet.slice(-4);
      text += `👤 Creator: \`${shortWallet}\`\n`;
    }
    text += "\n";
  }

  const buttons = agents.map((a) => [
    {
      text: `${a.isActive && !a.isPaused ? "⏸" : "▶️"} ${a.name}`,
      callback_data: a.isActive && !a.isPaused ? `agent_pause_${a.id}` : `agent_start_${a.id}`,
    },
  ]);
  buttons.push([{ text: "➕ New Agent", callback_data: "cmd_newagent" }]);

  await ctx.reply(text, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buttons },
  });
}

export async function handleNewAgent(ctx: BotContext) {
  if (!ctx.dbUser) return;

  await ctx.reply(
    "🤖 *Create Trading Agent*\n\n" +
    "Let's set up your AI trading agent.\n" +
    "What would you like to name it?",
    { parse_mode: "Markdown" }
  );
}

export async function handleAgentToggle(ctx: BotContext, agentId: string, action: "start" | "pause") {
  if (!ctx.dbUser) return;

  const agent = await prisma.agent.findFirst({
    where: { id: agentId, userId: ctx.dbUser.id },
  });

  if (!agent) {
    await ctx.answerCallbackQuery({ text: "Agent not found." });
    return;
  }

  if (action === "start") {
    await prisma.agent.update({
      where: { id: agentId },
      data: { isActive: true, isPaused: false },
    });
    await ctx.answerCallbackQuery({ text: `${agent.name} started!` });
  } else {
    await prisma.agent.update({
      where: { id: agentId },
      data: { isPaused: true },
    });
    await ctx.answerCallbackQuery({ text: `${agent.name} paused.` });
  }

  await agentsCommand(ctx);
}
