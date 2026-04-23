import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

export async function explainTrade(context: {
  pair: string;
  side: string;
  entryPrice: number;
  size: number;
  leverage: number;
  reasoning: string;
}): Promise<string> {
  try {
    const ai = getClient();
    const response = await ai.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: `Explain this trade in simple terms for a crypto trader:
Pair: ${context.pair}, Side: ${context.side}, Entry: $${context.entryPrice}
Size: $${context.size}, Leverage: ${context.leverage}x
AI Reasoning: ${context.reasoning}

Keep it to 2-3 sentences, plain English.`,
        },
      ],
    });

    const block = response.content[0];
    return block.type === "text" ? block.text : context.reasoning;
  } catch (err: any) {
    console.error("[EXPLAINER] Error:", err.message);
    return context.reasoning;
  }
}

export async function generateLossLesson(trade: {
  pair: string;
  side: string;
  pnl: number;
  reasoning: string;
}): Promise<string> {
  try {
    const ai = getClient();
    const response = await ai.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: `A trade closed at a loss. What went wrong and what lesson should be learned?
Pair: ${trade.pair}, Side: ${trade.side}, PnL: $${trade.pnl}
Original reasoning: ${trade.reasoning}

One concise sentence lesson.`,
        },
      ],
    });

    const block = response.content[0];
    return block.type === "text" ? block.text : "Review entry criteria more carefully.";
  } catch {
    return "Review entry criteria more carefully.";
  }
}
