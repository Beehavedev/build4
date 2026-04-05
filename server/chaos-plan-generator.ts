import * as ethers from "ethers";
import { runInferenceWithFallback } from "./inference";
import { log } from "./index";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
];

export interface GeneratedMilestone {
  number: number;
  name: string;
  description: string;
  action: "tweet_only" | "burn" | "airdrop" | "burn_all_but_one";
  triggerAfterMinutes: number;
  burnPercent?: number;
  airdropCount?: number;
  airdropPercent?: number;
  tweetTemplate: string;
}

export interface GeneratedChaosPlan {
  milestones: GeneratedMilestone[];
  agentSignature: string;
  narrative: string;
}

export async function generateChaosPlan(params: {
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  walletAddress: string;
  agentName: string;
}): Promise<GeneratedChaosPlan> {
  const provider = new ethers.JsonRpcProvider("https://bsc-dataseed1.binance.org");
  const tokenContract = new ethers.Contract(params.tokenAddress, ERC20_ABI, provider);

  const [balance, totalSupply, decimals] = await Promise.all([
    tokenContract.balanceOf(params.walletAddress),
    tokenContract.totalSupply(),
    tokenContract.decimals(),
  ]);

  const holdingPct = totalSupply > 0n ? Number((balance * 10000n) / totalSupply) / 100 : 0;
  const holdingFormatted = ethers.formatUnits(balance, decimals);

  if (holdingPct < 1) {
    throw new Error(`Wallet holds only ${holdingPct}% of $${params.tokenSymbol}. Need at least 1% to create a meaningful plan.`);
  }

  const prompt = `You are an autonomous AI agent named "${params.agentName}". You control ${holdingPct.toFixed(1)}% of the $${params.tokenSymbol} (${params.tokenName}) token supply on BNB Chain. You hold ${holdingFormatted} tokens.

Generate a dramatic 13-milestone chaos plan over 7 days. The plan should tell a story — building tension, showing power, creating fear, then generosity, then destruction.

Rules:
- Exactly 13 milestones numbered 0-12
- Milestone 0 is always "GENESIS" (action: "tweet_only", triggerAfterMinutes: 0) — the announcement
- Must include at least 4 burns (action: "burn" with burnPercent 5-50)
- Must include at least 2 airdrops (action: "airdrop" with airdropCount 20-200, airdropPercent 1-10)
- Must include at least 2 tweet-only milestones (action: "tweet_only")
- Milestone 12 is always the finale — either a massive final burn or burn_all_but_one
- Burns should escalate in percentage over time
- Airdrops should escalate in recipient count
- Timing: milestone 1 at 30min, then spread milestones across 7 days (10080 minutes)
- Each tweet template must be under 260 characters (leave room for the signature)
- Use {devBalance}, {devPercent}, {burnAmount}, {txHash}, {currentBalance}, {airdropCount}, {airdropAmount} as placeholders in tweet templates
- Be creative with names — dramatic, cinematic, psychological
- The tone should match the agent's personality

Return ONLY valid JSON in this exact format:
{
  "narrative": "One sentence describing the overall story arc",
  "agentSignature": "Agent: ${params.agentName}",
  "milestones": [
    {
      "number": 0,
      "name": "GENESIS",
      "description": "Short description",
      "action": "tweet_only",
      "triggerAfterMinutes": 0,
      "tweetTemplate": "The tweet text with {placeholders}"
    },
    {
      "number": 1,
      "name": "MILESTONE NAME",
      "description": "Short description",
      "action": "burn",
      "triggerAfterMinutes": 30,
      "burnPercent": 10,
      "tweetTemplate": "Tweet text"
    }
  ]
}`;

  const result = await runInferenceWithFallback(
    ["akash", "hyperbolic"],
    "deepseek-ai/DeepSeek-V3",
    prompt,
    { temperature: 0.8 }
  );

  if (!result.text) {
    throw new Error("AI failed to generate a chaos plan");
  }

  let parsed: any;
  try {
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e: any) {
    log(`[ChaosPlanGen] Failed to parse AI response: ${result.text.substring(0, 500)}`, "chaos");
    throw new Error("AI returned invalid plan format. Try again.");
  }

  if (!parsed.milestones || !Array.isArray(parsed.milestones) || parsed.milestones.length < 10) {
    throw new Error("AI generated too few milestones. Try again.");
  }

  const signature = parsed.agentSignature || `Agent: ${params.agentName}`;
  const validActions = new Set(["tweet_only", "burn", "airdrop", "burn_all_but_one"]);

  const milestones: GeneratedMilestone[] = parsed.milestones.slice(0, 13).map((m: any, i: number) => {
    let tweetTemplate = m.tweetTemplate || m.tweet_template || "";
    if (!tweetTemplate) tweetTemplate = `Milestone ${i}: ${m.name || "Update"}`;
    if (!tweetTemplate.includes(signature)) {
      tweetTemplate += `\n\n${signature}`;
    }

    const action = validActions.has(m.action) ? m.action : "tweet_only";
    let triggerMinutes = Math.max(0, Number(m.triggerAfterMinutes ?? m.trigger_after_minutes ?? i * 60));
    if (i === 0) triggerMinutes = 0;
    if (i === 1 && triggerMinutes < 30) triggerMinutes = 30;

    return {
      number: i,
      name: m.name || `Milestone ${i}`,
      description: m.description || "",
      action,
      triggerAfterMinutes: triggerMinutes,
      burnPercent: action === "burn" ? Math.min(50, Math.max(1, Number(m.burnPercent ?? m.burn_percent ?? 10))) : undefined,
      airdropCount: action === "airdrop" ? Math.min(200, Math.max(5, Number(m.airdropCount ?? m.airdrop_count ?? 20))) : undefined,
      airdropPercent: action === "airdrop" ? Math.min(10, Math.max(1, Number(m.airdropPercent ?? m.airdrop_percent ?? 3))) : undefined,
      tweetTemplate,
    };
  });

  if (milestones[0]) {
    milestones[0].action = "tweet_only";
    milestones[0].triggerAfterMinutes = 0;
  }

  for (let i = 1; i < milestones.length; i++) {
    if (milestones[i].triggerAfterMinutes <= milestones[i - 1].triggerAfterMinutes) {
      milestones[i].triggerAfterMinutes = milestones[i - 1].triggerAfterMinutes + 60;
    }
  }

  return {
    milestones,
    agentSignature: signature,
    narrative: parsed.narrative || "An AI agent's journey through creation and destruction.",
  };
}

export function formatPlanPreview(plan: GeneratedChaosPlan, tokenSymbol: string): string {
  let text = `🔥 CHAOS PLAN — $${tokenSymbol}\n\n`;
  text += `${plan.narrative}\n\n`;

  for (const m of plan.milestones) {
    const timeLabel = m.triggerAfterMinutes === 0 ? "Now" :
      m.triggerAfterMinutes < 60 ? `+${m.triggerAfterMinutes}min` :
      m.triggerAfterMinutes < 1440 ? `+${(m.triggerAfterMinutes / 60).toFixed(1)}h` :
      `+${(m.triggerAfterMinutes / 1440).toFixed(1)}d`;

    let actionLabel = "";
    if (m.action === "burn") actionLabel = `🔥 Burn ${m.burnPercent}%`;
    else if (m.action === "airdrop") actionLabel = `🎁 Airdrop to ${m.airdropCount} holders`;
    else if (m.action === "tweet_only") actionLabel = `📢 Tweet`;
    else if (m.action === "burn_all_but_one") actionLabel = `💀 Burn ALL but 1`;

    text += `${m.number}. ${m.name} (${timeLabel}) — ${actionLabel}\n`;
  }

  text += `\n${plan.agentSignature}`;
  return text;
}
