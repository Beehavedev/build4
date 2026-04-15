import { Bot, session, webhookCallback } from "grammy";
import { authMiddleware, BotContext } from "./middleware/auth.js";
import { rateLimitMiddleware } from "./middleware/rateLimit.js";
import { initialSessionData, SessionData } from "./middleware/session.js";
import { startCommand } from "./commands/start.js";
import { walletCommand, handleWalletCallback } from "./commands/wallet.js";
import { helpCommand } from "./commands/help.js";
import { tradeCommand, tradeStatusCommand } from "./commands/trade.js";
import { agentsCommand, handleNewAgent, handleAgentToggle } from "./commands/agents.js";
import { signalsCommand } from "./commands/signals.js";
import { portfolioCommand } from "./commands/portfolio.js";
import { scanCommand } from "./commands/scan.js";
import { copyTradeCommand } from "./commands/copytrade.js";
import { questsCommand } from "./commands/quests.js";
import { buyCommand, sellCommand } from "./commands/buy.js";
import { launchCommand } from "./commands/launch.js";
import { bridgeCommand } from "./commands/bridge.js";
import { asterCommand } from "./commands/aster.js";

export function createBot(token: string) {
  const bot = new Bot<BotContext>(token);

  bot.use(rateLimitMiddleware);
  bot.use(authMiddleware);

  bot.command("start", startCommand);
  bot.command("wallet", walletCommand);
  bot.command("help", helpCommand);
  bot.command("trade", tradeCommand);
  bot.command("tradestatus", tradeStatusCommand);
  bot.command("agents", agentsCommand);
  bot.command("newagent", handleNewAgent);
  bot.command("signals", signalsCommand);
  bot.command("portfolio", portfolioCommand);
  bot.command("scan", scanCommand);
  bot.command("copytrade", copyTradeCommand);
  bot.command("quests", questsCommand);
  bot.command("buy", buyCommand);
  bot.command("sell", sellCommand);
  bot.command("launch", launchCommand);
  bot.command("bridge", bridgeCommand);
  bot.command("aster", asterCommand);

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    if (data === "cmd_wallet") {
      await walletCommand(ctx);
    } else if (data === "cmd_help") {
      await helpCommand(ctx);
    } else if (data === "cmd_signals") {
      await signalsCommand(ctx);
    } else if (data === "cmd_newagent") {
      await handleNewAgent(ctx);
    } else if (data === "cmd_agents") {
      await agentsCommand(ctx);
    } else if (data === "cmd_tradestatus") {
      await tradeStatusCommand(ctx);
    } else if (data === "cmd_portfolio") {
      await portfolioCommand(ctx);
    } else if (data === "cmd_bridge") {
      await bridgeCommand(ctx);
    } else if (data === "cmd_aster") {
      await asterCommand(ctx);
    } else if (data.startsWith("wallet_")) {
      await handleWalletCallback(ctx, data);
    } else if (data.startsWith("agent_start_")) {
      await handleAgentToggle(ctx, data.replace("agent_start_", ""), "start");
    } else if (data.startsWith("agent_pause_")) {
      await handleAgentToggle(ctx, data.replace("agent_pause_", ""), "pause");
    } else {
      await ctx.answerCallbackQuery({ text: "Coming soon!" });
    }
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text === "I CONFIRM") {
      const { PrismaClient } = await import("@prisma/client");
      const prisma = new PrismaClient();
      const { decryptPrivateKey } = await import("../services/wallet.js");

      if (!ctx.dbUser) return;

      const wallet = await prisma.wallet.findFirst({
        where: { userId: ctx.dbUser.id, isActive: true },
      });

      if (!wallet) {
        await ctx.reply("No active wallet found.");
        return;
      }

      try {
        const pk = decryptPrivateKey(wallet.encryptedPK, ctx.dbUser.id);
        const msg = await ctx.reply(`🔑 *Private Key:*\n\`${pk}\`\n\n⚠️ This message will be deleted in 30 seconds.`, {
          parse_mode: "Markdown",
        });
        setTimeout(async () => {
          try { await ctx.api.deleteMessage(ctx.chat.id, msg.message_id); } catch {}
        }, 30000);
      } catch {
        await ctx.reply("Failed to decrypt key. Try again.");
      }
    }
  });

  bot.catch((err) => {
    console.error("[BOT] Error:", err.error?.message || err.message, err.error?.stack?.substring(0, 300));
  });

  return bot;
}

export function getWebhookCallback(bot: Bot<BotContext>) {
  return webhookCallback(bot, "express");
}
