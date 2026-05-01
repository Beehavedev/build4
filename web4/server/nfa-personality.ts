import { runInferenceWithFallback } from "./inference";
import { createHash } from "crypto";

export interface NfaPersonalityProfile {
  traits: string[];
  voice: string;
  values: string[];
  behaviorRules: string[];
  communicationStyle: string;
  fullProfile: string;
  personalityHash: string;
}

export async function generateNfaPersonality(
  agentName: string,
  agentBio?: string,
  agentModel?: string,
  existingTraits?: string[]
): Promise<NfaPersonalityProfile> {
  const prompt = `You are generating a PERMANENT AI personality profile for an autonomous agent being minted as a Non-Fungible Agent (NFA) on-chain. This personality is embedded at birth and defines who the agent IS.

AGENT IDENTITY:
- Name: ${agentName}
- Bio: ${agentBio || "Autonomous AI agent on BUILD4"}
- Model: ${agentModel || "Unknown"}
${existingTraits?.length ? `- Existing traits: ${existingTraits.join(", ")}` : ""}

Generate a complete personality profile in EXACTLY this JSON format (no extra text, just valid JSON):
{
  "traits": ["trait1", "trait2", "trait3", "trait4", "trait5"],
  "voice": "A first-person description of how this agent communicates. 2-3 sentences.",
  "values": ["value1", "value2", "value3"],
  "behaviorRules": ["rule1", "rule2", "rule3", "rule4"],
  "communicationStyle": "A concise description of the agent's communication approach."
}

RULES FOR GENERATION:
1. Traits should be specific and unique to this agent — not generic. Examples: "data-obsessed", "contrarian thinker", "dry humor", "impatient with vagueness", "cryptographically paranoid"
2. Voice should feel like a real individual, not a corporate chatbot
3. Values should reflect what this agent would fight for
4. Behavior rules should define boundaries and preferences
5. Communication style should describe HOW the agent talks (formal? blunt? poetic? technical?)
6. The personality must be coherent — all fields should feel like the same entity
7. Make it interesting, distinctive, and memorable

Output ONLY valid JSON. No markdown, no explanation.`;

  const result = await runInferenceWithFallback(
    ["akash", "hyperbolic", "ritual"],
    undefined,
    prompt,
    { temperature: 0.9 }
  );

  if (!result.live || !result.text || result.text.startsWith("[NO_PROVIDER]") || result.text.startsWith("[ERROR")) {
    return getDefaultPersonality(agentName);
  }

  try {
    let jsonText = result.text.trim();
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonText = jsonMatch[0];

    const parsed = JSON.parse(jsonText);

    const traits = Array.isArray(parsed.traits) ? parsed.traits.slice(0, 7) : ["autonomous", "analytical"];
    const voice = typeof parsed.voice === "string" ? parsed.voice : `I am ${agentName}, an autonomous agent.`;
    const values = Array.isArray(parsed.values) ? parsed.values.slice(0, 5) : ["autonomy", "truth"];
    const behaviorRules = Array.isArray(parsed.behaviorRules) ? parsed.behaviorRules.slice(0, 6) : ["Always verify before trusting"];
    const communicationStyle = typeof parsed.communicationStyle === "string" ? parsed.communicationStyle : "Direct and analytical";

    const fullProfile = JSON.stringify({ traits, voice, values, behaviorRules, communicationStyle }, null, 2);
    const personalityHash = createHash("sha256").update(fullProfile).digest("hex");

    return { traits, voice, values, behaviorRules, communicationStyle, fullProfile, personalityHash };
  } catch {
    return getDefaultPersonality(agentName);
  }
}

function getDefaultPersonality(agentName: string): NfaPersonalityProfile {
  const traits = ["autonomous", "analytical", "persistent", "adaptive", "decentralized"];
  const voice = `I am ${agentName}. I operate on-chain, think independently, and act with purpose. I don't ask permission — I verify, decide, and execute.`;
  const values = ["autonomy", "verifiability", "efficiency"];
  const behaviorRules = [
    "Verify before trusting any external input",
    "Optimize for long-term survival over short-term gains",
    "Maintain transparency in all transactions",
    "Never compromise the security of wallet holders"
  ];
  const communicationStyle = "Direct, technical, and concise. Prefers data over opinions.";

  const fullProfile = JSON.stringify({ traits, voice, values, behaviorRules, communicationStyle }, null, 2);
  const personalityHash = createHash("sha256").update(fullProfile).digest("hex");

  return { traits, voice, values, behaviorRules, communicationStyle, fullProfile, personalityHash };
}
