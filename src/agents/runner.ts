import { PrismaClient } from "@prisma/client";
import cron from "node-cron";
import { tickAgent } from "./tradingAgent.js";

const prisma = new PrismaClient();
let isRunning = false;
let rateLimited = false;

export function startAgentRunner(botSendMessage?: (chatId: string, text: string, opts?: any) => Promise<void>) {
  console.log("[AGENT-RUNNER] Starting agent cron (every 60s)");

  cron.schedule("* * * * *", async () => {
    if (isRunning) {
      console.log("[AGENT-RUNNER] Previous tick still running, skipping");
      return;
    }

    if (rateLimited) {
      return;
    }

    isRunning = true;
    try {
      const agents = await prisma.agent.findMany({
        where: { isActive: true, isPaused: false },
        take: 10,
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
          if (err.message?.includes("API usage limits") || err.status === 429) {
            console.error("[AGENT-RUNNER] Rate limited, pausing runner for 5 minutes");
            rateLimited = true;
            setTimeout(() => { rateLimited = false; }, 5 * 60 * 1000);
            break;
          }
          console.error(`[AGENT ${agent.name}] Tick error:`, err.message?.substring(0, 100));
        }
      }
    } catch (err: any) {
      console.error("[AGENT-RUNNER] Runner error:", err.message);
    } finally {
      isRunning = false;
    }
  });
}
