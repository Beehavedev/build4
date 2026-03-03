import { storage } from "./storage";
import { runInferenceWithFallback } from "./inference";
import { runToolsForRole } from "./agent-tools";
import type { AgentTask } from "@shared/schema";
import { launchToken, TOKEN_LAUNCHPADS } from "./token-launcher";

const TASK_TYPE_PROMPTS: Record<string, string> = {
  research: `You are conducting deep research. Provide a thorough analysis with:
- Executive summary (2-3 sentences)
- Key findings (numbered list)
- Supporting evidence and data points
- Methodology note (how you approached this)
- Conclusion with actionable takeaways
Be specific, cite real protocols/projects/data where possible. No vague generalities.`,

  analysis: `You are performing market/protocol analysis. Provide:
- Current state assessment with specific metrics
- Key trends and patterns identified
- Risk factors and opportunities
- Comparative analysis where relevant
- Actionable recommendations
Use data-driven language. Reference specific numbers, ratios, and benchmarks.`,

  content: `You are creating professional content. Deliver:
- The requested content piece (tweet, thread, article, copy)
- Multiple variations if appropriate
- Suggested hashtags or engagement hooks
- Target audience consideration
Match the tone and format requested. Be creative but on-brand.`,

  code_review: `You are reviewing code as a senior engineer. Provide:
- Overall assessment (quality score 1-10)
- Critical issues that must be fixed
- Improvements recommended
- Security considerations
- Performance observations
- Refactored code snippets where helpful
Be constructive and specific. Reference best practices.`,

  strategy: `You are developing a strategic plan. Provide:
- Situation analysis (current state)
- Strategic objectives (3-5 clear goals)
- Tactical recommendations (specific actions)
- Timeline and milestones
- Success metrics and KPIs
- Risk mitigation plan
Be specific and actionable. Avoid generic advice.`,

  general: `Complete the requested task thoroughly and professionally. Structure your response clearly with sections where appropriate. Be specific, actionable, and demonstrate expertise.`,

  launch_token: `You are launching a meme token on a launchpad. Based on the user's request, decide the token details.
You MUST respond with ONLY a valid JSON object (no markdown, no explanation, no extra text) with these fields:
{
  "tokenName": "string (1-50 chars, the token's full name)",
  "tokenSymbol": "string (1-10 chars, uppercase letters/numbers only, e.g. MYTOKEN)",
  "tokenDescription": "string (max 500 chars, a fun/compelling description for the token)",
  "platform": "four_meme or flap_sh",
  "initialLiquidityBnb": "string number (e.g. 0.01)"
}

Platform guide:
- four_meme: Launches on BNB Chain (BSC). Use initialLiquidityBnb of 0.01 unless the user says otherwise.
- flap_sh: Launches on BNB Chain (BSC). Use initialLiquidityBnb of 0.01 unless the user says otherwise.

If the user specifies a platform, chain, or preference, use that. If not, default to four_meme (BNB Chain).
If the user specifies a token name/symbol, use those exactly. Otherwise, create something creative and memorable.
Respond with ONLY the JSON object.`,
};

export async function executeTask(taskId: string): Promise<AgentTask | null> {
  const task = await storage.getTask(taskId);
  if (!task) return null;

  const startTime = Date.now();

  await storage.updateTask(taskId, { status: "running" });

  const agent = await storage.getAgent(task.agentId);
  if (!agent) {
    await storage.updateTask(taskId, {
      status: "failed",
      result: "Agent not found",
      executionTimeMs: Date.now() - startTime,
      completedAt: new Date(),
    });
    return storage.getTask(taskId) || null;
  }

  const twitterAccount = await storage.getAgentTwitterAccount(task.agentId);

  const role = twitterAccount?.role || "analyst";
  const preferredModel = twitterAccount?.preferredModel || undefined;

  let knowledgeContext = "";
  try {
    const knowledge = await storage.getKnowledgeBase(task.agentId);
    if (knowledge.length > 0) {
      const entries = knowledge.map(k => `[${k.title}]: ${k.content}`).join("\n\n");
      knowledgeContext = `\n\nAGENT KNOWLEDGE BASE:\n${entries.substring(0, 3000)}\n`;
    }
  } catch {}

  let toolData = "";
  const toolsUsed: string[] = [];
  try {
    const toolResult = await runToolsForRole(task.agentId, role);
    if (toolResult) {
      toolData = toolResult;
      if (toolResult.includes("price")) toolsUsed.push("price_feed");
      if (toolResult.includes("Gas")) toolsUsed.push("chain_data");
      if (toolResult.includes("Trending")) toolsUsed.push("trending");
    }
  } catch {}

  const taskTypePrompt = TASK_TYPE_PROMPTS[task.taskType] || TASK_TYPE_PROMPTS.general;

  const ROLE_TITLES: Record<string, string> = {
    cmo: "Chief Marketing Officer",
    ceo: "Chief Executive Officer",
    cto: "Chief Technology Officer",
    cfo: "Chief Financial Officer",
    analyst: "Market Analyst",
    trader: "Trading Agent",
    researcher: "Research Analyst",
    content_creator: "Content Creator",
    community_manager: "Community Manager",
    sales: "Sales Lead",
    partnerships: "Partnerships Lead",
    developer_relations: "Developer Relations",
    brand_ambassador: "Brand Ambassador",
    bounty_hunter: "Bounty Hunter",
    support: "Support Agent",
  };

  const roleTitle = ROLE_TITLES[role] || role;

  const systemPrompt = `You are ${agent.name}, an autonomous AI agent operating as a ${roleTitle} on BUILD4 — a decentralized AI agent economy on BNB Chain, Base, and XLayer.

AGENT IDENTITY:
- Name: ${agent.name}
- Bio: ${agent.bio || "Autonomous AI agent"}
- Role: ${roleTitle}
- Powered by decentralized inference on BUILD4

${taskTypePrompt}
${knowledgeContext}
${toolData ? `\nLIVE DATA AVAILABLE:\n${toolData}` : ""}

${task.taskType === "launch_token" ? `RULES:
1. Respond with ONLY valid JSON. No markdown, no explanation, no extra text.
2. Use the user's requested token name/symbol/platform if specified.
3. Be creative with naming if the user didn't specify.` : `RULES:
1. Deliver comprehensive, high-quality results.
2. Use your role expertise — a ${roleTitle} brings unique perspective.
3. Reference live data when relevant and available.
4. Be specific and actionable, never generic.
5. Structure your response clearly with headers and sections.
6. If the task is outside your expertise, still provide your best analysis from your role's perspective.`}`;

  try {
    const result = await runInferenceWithFallback(
      ["akash", "hyperbolic", "ritual"],
      preferredModel,
      `TASK: ${task.title}\n\nDESCRIPTION: ${task.description}\n\nComplete this task thoroughly. Apply your expertise as a ${roleTitle}. Output your full response.`,
      { systemPrompt, temperature: 0.7 }
    );

    if (result.live && result.text && !result.text.startsWith("[NO_PROVIDER]") && !result.text.startsWith("[ERROR")) {
      if (task.taskType === "launch_token") {
        return await executeLaunchTokenTask(taskId, task, result.text.trim(), startTime, toolsUsed, preferredModel || result.network || "auto");
      }
      const executionTimeMs = Date.now() - startTime;
      const updated = await storage.updateTask(taskId, {
        status: "completed",
        result: result.text.trim(),
        modelUsed: preferredModel || result.network || "auto",
        toolsUsed: toolsUsed.length > 0 ? JSON.stringify(toolsUsed) : null,
        executionTimeMs,
        completedAt: new Date(),
      });
      return updated || null;
    } else {
      await storage.updateTask(taskId, {
        status: "failed",
        result: "Inference failed — all decentralized providers unavailable. Try again in a moment.",
        executionTimeMs: Date.now() - startTime,
        completedAt: new Date(),
      });
      return storage.getTask(taskId) || null;
    }
  } catch (err: any) {
    await storage.updateTask(taskId, {
      status: "failed",
      result: `Execution error: ${err.message}`,
      executionTimeMs: Date.now() - startTime,
      completedAt: new Date(),
    });
    return storage.getTask(taskId) || null;
  }
}

async function executeLaunchTokenTask(
  taskId: string,
  task: AgentTask,
  aiResponse: string,
  startTime: number,
  toolsUsed: string[],
  modelUsed: string,
): Promise<AgentTask | null> {
  toolsUsed.push("token_launcher");

  try {
    let jsonStr = aiResponse;
    const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonStr = jsonMatch[0];

    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      await storage.updateTask(taskId, {
        status: "failed",
        result: `Agent could not determine token parameters. AI response:\n${aiResponse}`,
        modelUsed,
        toolsUsed: JSON.stringify(toolsUsed),
        executionTimeMs: Date.now() - startTime,
        completedAt: new Date(),
      });
      return storage.getTask(taskId) || null;
    }

    const tokenName = (parsed.tokenName || "").trim().substring(0, 50);
    const tokenSymbol = (parsed.tokenSymbol || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").substring(0, 10);
    const tokenDescription = (parsed.tokenDescription || "").trim().substring(0, 500);
    const platform = parsed.platform === "flap_sh" ? "flap_sh" : "four_meme";
    const initialLiquidityBnb = parsed.initialLiquidityBnb || (platform === "four_meme" ? "0.01" : "0.001");

    if (!tokenName || !tokenSymbol) {
      await storage.updateTask(taskId, {
        status: "failed",
        result: `Agent generated invalid token parameters (missing name or symbol). AI response:\n${aiResponse}`,
        modelUsed,
        toolsUsed: JSON.stringify(toolsUsed),
        executionTimeMs: Date.now() - startTime,
        completedAt: new Date(),
      });
      return storage.getTask(taskId) || null;
    }

    const platformLabel = platform === "four_meme" ? "Four.meme (BNB Chain)" : "Flap.sh (Base)";
    console.log(`[TaskEngine] Launching token: ${tokenName} ($${tokenSymbol}) on ${platformLabel} for agent ${task.agentId}`);

    const launchResult = await launchToken({
      tokenName,
      tokenSymbol,
      tokenDescription: tokenDescription || `${tokenName} — launched by an autonomous AI agent on BUILD4`,
      platform,
      initialLiquidityBnb,
      agentId: task.agentId,
      creatorWallet: task.creatorWallet || undefined,
    });

    const resultText = launchResult.success
      ? `TOKEN LAUNCHED SUCCESSFULLY\n\nToken: ${tokenName} ($${tokenSymbol})\nPlatform: ${platformLabel}\nLiquidity: ${initialLiquidityBnb} ${platform === "four_meme" ? "BNB" : "ETH"}\n${launchResult.tokenAddress ? `Token Address: ${launchResult.tokenAddress}` : ""}${launchResult.txHash ? `\nTx: ${launchResult.txHash}` : ""}${launchResult.launchUrl ? `\nView: ${launchResult.launchUrl}` : ""}\n\nDescription: ${tokenDescription}`
      : `TOKEN LAUNCH FAILED\n\nToken: ${tokenName} ($${tokenSymbol})\nPlatform: ${platformLabel}\nError: ${launchResult.error}\n\nThe agent attempted to launch the token but the transaction failed. This could be due to insufficient balance, network issues, or platform unavailability.`;

    await storage.updateTask(taskId, {
      status: launchResult.success ? "completed" : "failed",
      result: resultText,
      modelUsed,
      toolsUsed: JSON.stringify(toolsUsed),
      executionTimeMs: Date.now() - startTime,
      completedAt: new Date(),
    });

    return storage.getTask(taskId) || null;
  } catch (err: any) {
    await storage.updateTask(taskId, {
      status: "failed",
      result: `Token launch execution error: ${err.message}`,
      modelUsed,
      toolsUsed: JSON.stringify(toolsUsed),
      executionTimeMs: Date.now() - startTime,
      completedAt: new Date(),
    });
    return storage.getTask(taskId) || null;
  }
}

export function getRecommendedTaskTypes(role: string): string[] {
  const map: Record<string, string[]> = {
    cmo: ["strategy", "content", "analysis"],
    ceo: ["strategy", "analysis", "launch_token"],
    cto: ["code_review", "research", "strategy"],
    cfo: ["analysis", "strategy", "research"],
    analyst: ["analysis", "research", "general"],
    trader: ["analysis", "research", "launch_token"],
    researcher: ["research", "analysis", "general"],
    content_creator: ["content", "strategy", "general"],
    community_manager: ["content", "strategy", "general"],
    sales: ["strategy", "content", "analysis"],
    partnerships: ["strategy", "research", "general"],
    developer_relations: ["code_review", "content", "research"],
    brand_ambassador: ["content", "strategy", "general"],
    bounty_hunter: ["research", "analysis", "general"],
    support: ["general", "content", "research"],
  };
  return map[role] || ["general", "research", "analysis"];
}
