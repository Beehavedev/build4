import { PrismaClient } from "@prisma/client";
import cron from "node-cron";
import { tickAgent } from "./tradingAgent.js";

const prisma = new PrismaClient();
let isRunning = false;

export function startAgentRunner(botSendMessage?: (chatId: string, text: string, opts?: any) => Promise<void>) {
  console.log("[AGENT-RUNNER] Starting agent cron (every 60s)");

  cron.schedule("* * * * *", async () => {
    if (isRunning) {
      console.log("[AGENT-RUNNER] Previous tick still running, skipping");
      return;
    }

    isRunning = true;
    try {
      const agents = await prisma.agent.findMany({
        where: { isActive: true, isPaused: false },
      });

      if (agents.length === 0) {
        isRunning = false;
        return;
      }

      console.log(`[AGENT-RUNNER] Ticking ${agents.length} agents`);

      for (const agent of agents) {
        try {
          await tickAgent(agent.id, botSendMessage);
        } catch (err: any) {
          console.error(`[AGENT-RUNNER] Error ticking agent ${agent.name}:`, err.message);
        }
      }
    } catch (err: any) {
      console.error("[AGENT-RUNNER] Runner error:", err.message);
    } finally {
      isRunning = false;
    }
  });
}
