import { PrismaClient } from "@prisma/client";
import Anthropic from "@anthropic-ai/sdk";
import { checkRisk, validateTradeParams } from "./riskGuard.js";
import { saveMemory, buildMemoryContext } from "./memory.js";

const prisma = new PrismaClient();

interface TradeDecision {
  action: "OPEN_LONG" | "OPEN_SHORT" | "CLOSE" | "HOLD";
  pair: string;
  size: number;
  leverage: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  reasoning: string;
  memoryUpdate: string | null;
}

function generateMockOHLCV(pair: string) {
  const base = pair.includes("BTC") ? 65000 : pair.includes("ETH") ? 3200 : 600;
  const variance = base * 0.02;
  return {
    pair,
    price: base + (Math.random() - 0.5) * variance,
    high24h: base + Math.random() * variance,
    low24h: base - Math.random() * variance,
    volume24h: Math.round(Math.random() * 1000000),
    change24h: (Math.random() - 0.5) * 5,
  };
}

export async function tickAgent(agentId: string, botSendMessage?: (chatId: string, text: string, opts?: any) => Promise<void>) {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: { user: true },
  });

  if (!agent || !agent.isActive || agent.isPaused) return;

  const riskCheck = await checkRisk(agentId);
  if (!riskCheck.allowed) {
    console.log(`[AGENT ${agent.name}] Risk block: ${riskCheck.reason}`);
    if (riskCheck.reason?.includes("Daily loss") && botSendMessage) {
      await botSendMessage(
        agent.user.telegramId.toString(),
        `⚠️ Agent *${agent.name}* paused: ${riskCheck.reason}`,
        { parse_mode: "Markdown" }
      );
    }
    return;
  }

  const openPositions = await prisma.trade.findMany({
    where: { agentId, status: "open" },
  });

  const memoryContext = await buildMemoryContext(agentId);

  const marketData = agent.pairs.map(generateMockOHLCV);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayTrades = await prisma.trade.findMany({
    where: { agentId, closedAt: { gte: today }, status: "closed" },
  });
  const todayPnl = todayTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);

  try {
    const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const systemPrompt = `You are an expert crypto perpetual futures trading agent. You analyze market data and make precise trading decisions. You must respond ONLY with valid JSON matching the schema exactly.

Your personality: disciplined, risk-aware, patient. You prefer high-probability setups over frequent trades. You never revenge trade. You always respect stop losses.

You have access to this agent's memory which contains observations about past trades, market patterns you've noticed, and corrections from previous mistakes. Use this memory to improve decisions.

Current agent config:
- Max position size: ${agent.maxPositionSize} USDT
- Max leverage: ${agent.maxLeverage}x
- Stop loss: ${agent.stopLossPct}%
- Take profit: ${agent.takeProfitPct}%
- Max daily loss: ${agent.maxDailyLoss} USDT
- Today's PnL so far: ${todayPnl} USDT

Respond with exactly this JSON schema:
{
  "action": "OPEN_LONG" | "OPEN_SHORT" | "CLOSE" | "HOLD",
  "pair": "BTC/USDT",
  "size": 100,
  "leverage": 3,
  "stopLoss": 42000,
  "takeProfit": 44000,
  "confidence": 0.72,
  "reasoning": "Plain English 2-3 sentence explanation",
  "memoryUpdate": "One sentence observation to remember, or null"
}`;

    const userMessage = `Market Data:\n${JSON.stringify(marketData, null, 2)}\n\nOpen Positions: ${JSON.stringify(openPositions.map((p) => ({ pair: p.pair, side: p.side, entry: p.entryPrice, size: p.size })))}\n\nAgent Memory:\n${memoryContext}`;

    const response = await ai.messages.create({
      model: "claude-sonnet-4-5-20250514",
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    const text = response.content[0];
    if (text.type !== "text") return;

    const jsonMatch = text.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const decision: TradeDecision = JSON.parse(jsonMatch[0]);

    if (decision.memoryUpdate) {
      await saveMemory(agentId, "observation", decision.memoryUpdate);
    }

    if (decision.action === "HOLD") {
      if (decision.confidence >= 0.3) {
        await saveMemory(agentId, "observation", `HOLD: ${decision.reasoning}`);
      }
      return;
    }

    if (decision.action === "CLOSE") {
      for (const pos of openPositions.filter((p) => p.pair === decision.pair)) {
        const mockExitPrice = generateMockOHLCV(pos.pair).price;
        const pnlMultiplier = pos.side === "LONG" ? 1 : -1;
        const pnl = ((mockExitPrice - pos.entryPrice) / pos.entryPrice) * pos.size * pos.leverage * pnlMultiplier;

        await prisma.trade.update({
          where: { id: pos.id },
          data: {
            status: "closed",
            exitPrice: mockExitPrice,
            pnl,
            pnlPct: (pnl / pos.size) * 100,
            closedAt: new Date(),
          },
        });

        await saveMemory(agentId, "decision", `Closed ${pos.pair} ${pos.side} at $${mockExitPrice.toFixed(2)}, PnL: $${pnl.toFixed(2)}. ${decision.reasoning}`);

        if (botSendMessage) {
          const emoji = pnl >= 0 ? "🟢" : "🔴";
          await botSendMessage(
            agent.user.telegramId.toString(),
            `${emoji} Agent *${agent.name}* closed ${pos.side} ${pos.pair}\n` +
            `Exit: $${mockExitPrice.toFixed(2)} | PnL: $${pnl.toFixed(2)}\n\n` +
            `💭 ${decision.reasoning}`,
            { parse_mode: "Markdown" }
          );
        }
      }
      return;
    }

    const { size, leverage, clamped } = validateTradeParams(agent, decision.size, decision.leverage);
    const entryPrice = generateMockOHLCV(decision.pair).price;

    await prisma.trade.create({
      data: {
        userId: agent.userId,
        agentId: agent.id,
        exchange: agent.exchange,
        pair: decision.pair,
        side: decision.action === "OPEN_LONG" ? "LONG" : "SHORT",
        entryPrice,
        size,
        leverage,
        status: "open",
        aiReasoning: decision.reasoning,
      },
    });

    await saveMemory(agentId, "decision", `Opened ${decision.action} ${decision.pair} at $${entryPrice.toFixed(2)}, size $${size}, ${leverage}x. ${decision.reasoning}`);

    await prisma.agent.update({
      where: { id: agentId },
      data: {
        totalTrades: { increment: 1 },
        lastTickAt: new Date(),
      },
    });

    if (botSendMessage) {
      const side = decision.action === "OPEN_LONG" ? "LONG" : "SHORT";
      await botSendMessage(
        agent.user.telegramId.toString(),
        `🤖 Agent *${agent.name}* opened ${side} ${decision.pair}\n` +
        `Entry: $${entryPrice.toFixed(2)} | Size: $${size} | ${leverage}x\n` +
        `SL: $${decision.stopLoss} | TP: $${decision.takeProfit}\n\n` +
        `💭 ${decision.reasoning}\n\n` +
        `Confidence: ${(decision.confidence * 100).toFixed(0)}%${clamped ? "\n⚠️ Position clamped to risk limits" : ""}`,
        { parse_mode: "Markdown" }
      );
    }
  } catch (err: any) {
    console.error(`[AGENT ${agent.name}] Tick error:`, err.message);
    await saveMemory(agentId, "observation", `Tick failed: ${err.message?.substring(0, 100)}`);
  }

  await prisma.agent.update({
    where: { id: agentId },
    data: { lastTickAt: new Date() },
  });
}
