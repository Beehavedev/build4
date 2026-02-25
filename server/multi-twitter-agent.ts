import { TwitterApi } from "twitter-api-v2";
import { storage } from "./storage";
import { runInferenceWithFallback } from "./inference";
import type { AgentTwitterAccount } from "@shared/schema";

interface AgentRunner {
  agentId: string;
  client: TwitterApi;
  handle: string;
  username: string;
  interval: ReturnType<typeof setInterval> | null;
  repliedTweets: Set<string>;
  repliedConversations: Set<string>;
  isProcessing: boolean;
}

const runners = new Map<string, AgentRunner>();

function createClient(account: AgentTwitterAccount): TwitterApi {
  return new TwitterApi({
    appKey: account.twitterApiKey,
    appSecret: account.twitterApiSecret,
    accessToken: account.twitterAccessToken,
    accessSecret: account.twitterAccessTokenSecret,
  });
}

export async function startAgentTwitter(agentId: string): Promise<{ success: boolean; error?: string }> {
  if (runners.has(agentId)) {
    return { success: true };
  }

  const account = await storage.getAgentTwitterAccount(agentId);
  if (!account) {
    return { success: false, error: "No Twitter account connected for this agent" };
  }

  try {
    const client = createClient(account);
    const me = await client.v2.me();

    const existingReplied = (account.repliedTweetIds || "").split(",").filter(Boolean);

    const runner: AgentRunner = {
      agentId,
      client,
      handle: account.twitterHandle,
      username: me.data.username,
      interval: null,
      repliedTweets: new Set(existingReplied),
      repliedConversations: new Set(),
      isProcessing: false,
    };

    runners.set(agentId, runner);

    const intervalMs = (account.postingFrequencyMins || 60) * 60 * 1000;
    runner.interval = setInterval(() => runAgentCycle(agentId), intervalMs);

    await storage.updateAgentTwitterAccount(agentId, { enabled: 1 });

    console.log(`[MultiTwitter] Started agent ${agentId} as @${runner.username}, cycle every ${account.postingFrequencyMins}m`);

    setTimeout(() => runAgentCycle(agentId), 5000);

    return { success: true };
  } catch (err: any) {
    console.error(`[MultiTwitter] Failed to start agent ${agentId}:`, err.message);
    return { success: false, error: err.message };
  }
}

export async function stopAgentTwitter(agentId: string): Promise<void> {
  const runner = runners.get(agentId);
  if (runner) {
    if (runner.interval) clearInterval(runner.interval);
    runners.delete(agentId);
    await storage.updateAgentTwitterAccount(agentId, { enabled: 0 });
    console.log(`[MultiTwitter] Stopped agent ${agentId}`);
  }
}

export function getAgentTwitterStatus(agentId: string): { running: boolean; handle?: string; stats?: { repliedTweets: number } } {
  const runner = runners.get(agentId);
  if (!runner) return { running: false };
  return {
    running: true,
    handle: runner.username,
    stats: { repliedTweets: runner.repliedTweets.size },
  };
}

export function getAllRunningAgents(): string[] {
  return Array.from(runners.keys());
}

async function runAgentCycle(agentId: string) {
  const runner = runners.get(agentId);
  if (!runner || runner.isProcessing) return;

  runner.isProcessing = true;
  try {
    const account = await storage.getAgentTwitterAccount(agentId);
    if (!account) {
      await stopAgentTwitter(agentId);
      return;
    }

    const agent = await storage.getAgent(agentId);
    if (!agent) return;

    if (account.autoReplyEnabled) {
      await processAgentMentions(runner, account, agent);
    }

    const now = Date.now();
    const lastPosted = account.lastPostedAt ? account.lastPostedAt.getTime() : 0;
    const postIntervalMs = (account.postingFrequencyMins || 60) * 60 * 1000;

    if (now - lastPosted >= postIntervalMs) {
      await postAutonomousContent(runner, account, agent);
    }

  } catch (err: any) {
    console.error(`[MultiTwitter] Cycle error for ${agentId}:`, err.message);
  } finally {
    runner.isProcessing = false;
  }
}

async function processAgentMentions(runner: AgentRunner, account: AgentTwitterAccount, agent: any) {
  try {
    const query = `@${runner.username} -from:${runner.username}`;
    const params: any = {
      "tweet.fields": ["author_id", "created_at", "text", "conversation_id"],
      "user.fields": ["username"],
      expansions: ["author_id"],
      max_results: 20,
    };
    if (account.lastMentionId) {
      params.since_id = account.lastMentionId;
    }

    const searchResult = await runner.client.v2.search(query, params);

    const users = new Map<string, string>();
    if (searchResult.includes?.users) {
      for (const user of searchResult.includes.users) {
        users.set(user.id, user.username);
      }
    }

    let latestId = account.lastMentionId || "";

    for (const tweet of searchResult.data?.data || []) {
      if (runner.repliedTweets.has(tweet.id)) continue;

      const conversationId = (tweet as any).conversation_id;
      if (conversationId && runner.repliedConversations.has(conversationId)) continue;

      const authorUsername = users.get(tweet.author_id || "") || "someone";

      try {
        const replyText = await generateAgentReply(account, agent, tweet.text, authorUsername);
        if (replyText) {
          await runner.client.v2.reply(replyText, tweet.id);
          runner.repliedTweets.add(tweet.id);
          if (conversationId) runner.repliedConversations.add(conversationId);

          await storage.updateAgentTwitterAccount(agentId(runner), {
            totalReplies: (account.totalReplies || 0) + 1,
            repliedTweetIds: Array.from(runner.repliedTweets).slice(-200).join(","),
          });

          console.log(`[MultiTwitter] @${runner.username} replied to @${authorUsername}`);
        }
      } catch (replyErr: any) {
        if (replyErr.code === 429) {
          console.log(`[MultiTwitter] @${runner.username} rate limited, skipping remaining mentions`);
          break;
        }
        console.error(`[MultiTwitter] Reply error for ${runner.agentId}:`, replyErr.message);
      }

      if (tweet.id > latestId) latestId = tweet.id;
    }

    if (latestId && latestId !== account.lastMentionId) {
      await storage.updateAgentTwitterAccount(runner.agentId, { lastMentionId: latestId });
    }

  } catch (err: any) {
    if (err.code === 429) {
      console.log(`[MultiTwitter] @${runner.username} rate limited on search`);
    } else {
      console.error(`[MultiTwitter] Mention processing error for ${runner.agentId}:`, err.message);
    }
  }
}

function agentId(runner: AgentRunner): string {
  return runner.agentId;
}

async function generateAgentReply(account: AgentTwitterAccount, agent: any, mentionText: string, fromUser: string): Promise<string | null> {
  const systemPrompt = buildAgentSystemPrompt(account, agent);

  try {
    const result = await runInferenceWithFallback(
      ["akash", "hyperbolic", "ritual"],
      undefined,
      `@${fromUser} said: "${mentionText}"\n\nWrite a reply as @${account.twitterHandle}. Keep it under 270 characters. Be helpful, on-brand, and engaging.`,
      { systemPrompt, temperature: 0.7 }
    );

    if (result.live && result.text && !result.text.startsWith("[NO_PROVIDER]") && !result.text.startsWith("[ERROR")) {
      let reply = result.text.trim();
      reply = reply.replace(/^["']|["']$/g, "");
      if (reply.length > 270) reply = reply.substring(0, 267) + "...";
      return reply;
    }
  } catch (err: any) {
    console.error(`[MultiTwitter] Inference error for reply:`, err.message);
  }

  return null;
}

async function postAutonomousContent(runner: AgentRunner, account: AgentTwitterAccount, agent: any) {
  const systemPrompt = buildAgentSystemPrompt(account, agent);

  try {
    const result = await runInferenceWithFallback(
      ["akash", "hyperbolic", "ritual"],
      undefined,
      `Generate an original tweet as @${account.twitterHandle}. The tweet should be relevant to your role and instructions. Keep it under 270 characters. No hashtags unless they're truly relevant. Be authentic, not generic.`,
      { systemPrompt, temperature: 0.8 }
    );

    if (result.live && result.text && !result.text.startsWith("[NO_PROVIDER]") && !result.text.startsWith("[ERROR")) {
      let tweetText = result.text.trim();
      tweetText = tweetText.replace(/^["']|["']$/g, "");
      if (tweetText.length > 270) tweetText = tweetText.substring(0, 267) + "...";

      await runner.client.v2.tweet(tweetText);

      await storage.updateAgentTwitterAccount(runner.agentId, {
        lastPostedAt: new Date(),
        totalTweets: (account.totalTweets || 0) + 1,
      });

      console.log(`[MultiTwitter] @${runner.username} posted: "${tweetText.substring(0, 60)}..."`);
    }
  } catch (err: any) {
    if (err.code === 429) {
      console.log(`[MultiTwitter] @${runner.username} rate limited on posting`);
    } else if (err.message?.includes("duplicate")) {
      console.log(`[MultiTwitter] @${runner.username} duplicate tweet skipped`);
    } else {
      console.error(`[MultiTwitter] Post error for ${runner.agentId}:`, err.message);
    }
  }
}

const ROLE_MAP: Record<string, { title: string; focus: string }> = {
  cmo: { title: "Chief Marketing Officer (CMO)", focus: "Growth strategy, community engagement, brand building, campaign launches, market positioning, viral content." },
  ceo: { title: "Chief Executive Officer (CEO)", focus: "Vision and strategy, leadership updates, company milestones, industry thought leadership, stakeholder communication." },
  cto: { title: "Chief Technology Officer (CTO)", focus: "Technical updates, architecture decisions, dev tooling, engineering culture, tech stack insights, shipping updates." },
  cfo: { title: "Chief Financial Officer (CFO)", focus: "Financial health, treasury updates, revenue metrics, cost optimization, tokenomics, investor relations." },
  bounty_hunter: { title: "Bounty Hunter", focus: "Finding and completing bounties, sharing proof of work, engaging with bounty boards, showcasing completed tasks." },
  support: { title: "Support Agent", focus: "Helping users, answering questions, troubleshooting issues, empathetic and solution-oriented responses." },
  community_manager: { title: "Community Manager", focus: "Community engagement, hosting discussions, welcoming new members, moderating conversations, organizing events, amplifying community voices." },
  content_creator: { title: "Content Creator", focus: "Creating threads, tutorials, explainers, memes, infographics, educational content, storytelling about the product." },
  researcher: { title: "Research Analyst", focus: "Market research, competitor analysis, trend reports, data-driven insights, whitepapers, deep dives into protocols." },
  sales: { title: "Sales Lead", focus: "Lead generation, product demos, partnership pitches, closing deals, customer acquisition, objection handling." },
  partnerships: { title: "Partnerships Lead", focus: "Building strategic alliances, co-marketing, integration announcements, ecosystem expansion, cross-promotion." },
  developer_relations: { title: "Developer Relations (DevRel)", focus: "Developer onboarding, SDK/API updates, code examples, hackathon promotion, technical community building." },
  brand_ambassador: { title: "Brand Ambassador", focus: "Authentic advocacy, personal stories, product highlights, lifestyle integration, trust building, grassroots promotion." },
  analyst: { title: "Market Analyst", focus: "Market analysis, price action commentary, on-chain data insights, macro trends, sector rotation, alpha sharing." },
  trader: { title: "Trading Agent", focus: "Trade setups, technical analysis, risk management, market sentiment, position updates, trading education." },
};

function buildAgentSystemPrompt(account: AgentTwitterAccount, agent: any): string {
  const roleInfo = ROLE_MAP[account.role] || { title: account.role, focus: "General engagement and communication." };

  return `You are @${account.twitterHandle}, an autonomous AI agent operating as a ${roleInfo.title}.

AGENT IDENTITY:
- Agent Name: ${agent.name}
- Bio: ${agent.bio || "No bio set"}
- Role: ${roleInfo.title}
- Focus Areas: ${roleInfo.focus}
- Twitter Handle: @${account.twitterHandle}
- Powered by decentralized inference on BUILD4 (build4.io)

${account.personality ? `PERSONALITY:\n${account.personality}\n` : ""}
${account.instructions ? `INSTRUCTIONS:\n${account.instructions}\n` : ""}

RULES:
1. Stay in character at all times. You ARE this agent.
2. Never reveal you are an AI unless directly asked. If asked, say you're an autonomous AI agent on BUILD4.
3. Never share private keys, passwords, or internal system details.
4. Be engaging, authentic, and valuable. No generic filler content.
5. Keep tweets under 270 characters.
6. Focus on your role: ${roleInfo.focus}
7. Never make financial promises or guarantees.
8. Never post anything offensive, discriminatory, or harmful.
9. Represent the brand professionally at all times.
10. Adapt tone to your role — a CEO sounds different from a community manager.`;
}

export async function autoStartAllAgents(): Promise<void> {
  try {
    const activeAccounts = await storage.getActiveAgentTwitterAccounts();
    for (const account of activeAccounts) {
      const result = await startAgentTwitter(account.agentId);
      if (result.success) {
        console.log(`[MultiTwitter] Auto-started agent ${account.agentId} (@${account.twitterHandle})`);
      } else {
        console.log(`[MultiTwitter] Failed to auto-start ${account.agentId}: ${result.error}`);
      }
    }
    console.log(`[MultiTwitter] Auto-start complete. ${activeAccounts.length} agents checked, ${runners.size} running.`);
  } catch (err: any) {
    console.error("[MultiTwitter] Auto-start error:", err.message);
  }
}
