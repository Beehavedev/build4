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
  lastError: string | null;
  lastErrorAt: Date | null;
  consecutivePostErrors: number;
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
      lastError: null,
      lastErrorAt: null,
      consecutivePostErrors: 0,
    };

    runners.set(agentId, runner);

    const hasPostedBefore = !!account.lastPostedAt;
    const intervalMs = hasPostedBefore
      ? (account.postingFrequencyMins || 60) * 60 * 1000
      : 2 * 60 * 1000;
    runner.interval = setInterval(() => runAgentCycle(agentId), intervalMs);

    await storage.updateAgentTwitterAccount(agentId, { enabled: 1 });

    console.log(`[MultiTwitter] Started agent ${agentId} as @${runner.username}, cycle every ${hasPostedBefore ? account.postingFrequencyMins + "m" : "2m (first-post mode)"}`);

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

export function getAgentTwitterStatus(agentId: string): { running: boolean; handle?: string; stats?: { repliedTweets: number }; lastError?: string | null; lastErrorAt?: Date | null } {
  const runner = runners.get(agentId);
  if (!runner) return { running: false };
  return {
    running: true,
    handle: runner.username,
    stats: { repliedTweets: runner.repliedTweets.size },
    lastError: runner.lastError,
    lastErrorAt: runner.lastErrorAt,
  };
}

export function updateAgentTwitterInterval(agentId: string, newFrequencyMins: number): void {
  const runner = runners.get(agentId);
  if (!runner) return;
  if (runner.interval) clearInterval(runner.interval);
  const intervalMs = Math.max(newFrequencyMins, 15) * 60 * 1000;
  runner.interval = setInterval(() => runAgentCycle(agentId), intervalMs);
  console.log(`[MultiTwitter] Updated posting interval for ${agentId} to ${newFrequencyMins}m`);
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
      try {
        await processAgentMentions(runner, account, agent);
      } catch (mentionErr: any) {
        console.log(`[MultiTwitter] @${runner.username} mention processing failed (non-fatal): ${mentionErr.message?.substring(0, 100)}`);
      }
    }

    const now = Date.now();
    const lastPosted = account.lastPostedAt ? account.lastPostedAt.getTime() : 0;
    const postIntervalMs = (account.postingFrequencyMins || 60) * 60 * 1000;

    if (now - lastPosted >= postIntervalMs) {
      await postAutonomousContent(runner, account, agent);
    }

  } catch (err: any) {
    console.error(`[MultiTwitter] Cycle error for ${agentId}:`, err.message);
    runner.lastError = err.message;
    runner.lastErrorAt = new Date();
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
    } else if (err.code === 402 || err.message?.includes("402")) {
      console.log(`[MultiTwitter] @${runner.username} mention search skipped — Twitter Free tier doesn't support search API. Upgrade to Basic ($100/mo) for auto-reply.`);
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
      `@${fromUser} said: "${mentionText}"\n\nWrite a reply as @${account.twitterHandle}. Use your role-specific skills to craft the best possible response. Match your assigned tone. Keep it under 270 characters. Be helpful, on-brand, and demonstrate expertise. Output ONLY the reply text.`,
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
      `Generate an original tweet as @${account.twitterHandle}. Pick ONE of your listed skills and craft a tweet that demonstrates that skill. Choose a different tweet style each time. Keep it under 270 characters. No hashtags unless truly relevant. Be authentic, sharp, and role-specific — not generic. Output ONLY the tweet text, nothing else.`,
      { systemPrompt, temperature: 0.8 }
    );

    if (result.live && result.text && !result.text.startsWith("[NO_PROVIDER]") && !result.text.startsWith("[ERROR")) {
      let tweetText = result.text.trim();
      tweetText = tweetText.replace(/^["']|["']$/g, "");
      if (tweetText.length > 270) tweetText = tweetText.substring(0, 267) + "...";

      await runner.client.v2.tweet(tweetText);

      const isFirstTweet = !account.lastPostedAt;
      await storage.updateAgentTwitterAccount(runner.agentId, {
        lastPostedAt: new Date(),
        totalTweets: (account.totalTweets || 0) + 1,
      });

      runner.lastError = null;
      runner.lastErrorAt = null;
      runner.consecutivePostErrors = 0;

      console.log(`[MultiTwitter] @${runner.username} posted: "${tweetText.substring(0, 60)}..."`);

      if (isFirstTweet && runner.interval) {
        clearInterval(runner.interval);
        const normalMs = (account.postingFrequencyMins || 60) * 60 * 1000;
        runner.interval = setInterval(() => runAgentCycle(runner.agentId), normalMs);
        console.log(`[MultiTwitter] @${runner.username} first tweet successful! Switched to normal ${account.postingFrequencyMins}m interval.`);
      }
    }
  } catch (err: any) {
    if (err.code === 429) {
      console.log(`[MultiTwitter] @${runner.username} rate limited on posting`);
      runner.lastError = "Rate limited by Twitter. Your app may have hit its posting limit. Wait a few minutes.";
      runner.lastErrorAt = new Date();
    } else if (err.code === 403 || err.message?.includes("403")) {
      runner.consecutivePostErrors++;
      const detail = err.data?.detail || err.data?.errors?.[0]?.message || "";
      const rawData = JSON.stringify(err.data || err.errors || {});
      console.error(`[MultiTwitter] @${runner.username} 403 Forbidden (${runner.consecutivePostErrors}/3) — detail: ${detail || "none"} | raw: ${rawData} | message: ${err.message}`);

      let fixMessage: string;
      if (detail.includes("not permitted") || detail.includes("oauth1") || rawData.includes("oauth1")) {
        fixMessage = "Your Access Token was generated with old permissions. Even though your app now has Read+Write, the token still has Read-only scope. Go to developer.x.com → Keys & Tokens → REGENERATE your Access Token and Access Token Secret. Then update them in Settings here and restart.";
      } else if (detail.includes("suspended") || detail.includes("locked")) {
        fixMessage = "Your Twitter account or app appears to be suspended/locked. Check your account status at developer.x.com.";
      } else {
        fixMessage = `Twitter returned 403 Forbidden${detail ? `: ${detail}` : ""}. Possible causes: 1) Access Token was created before Read+Write was enabled — regenerate tokens at developer.x.com and update in Settings. 2) Tokens were regenerated on developer.x.com after connecting, invalidating the ones stored here — paste your current tokens in Settings. 3) Your Twitter app or account was restricted by Twitter.`;
      }
      runner.lastError = fixMessage;
      runner.lastErrorAt = new Date();
      if (runner.consecutivePostErrors >= 3) {
        console.error(`[MultiTwitter] @${runner.username} auto-paused after ${runner.consecutivePostErrors} consecutive 403 errors. Fix credentials and restart.`);
        await stopAgentTwitter(runner.agentId);
        await storage.updateAgentTwitterAccount(runner.agentId, { enabled: 0 });
      }
    } else if (err.code === 402 || err.message?.includes("402")) {
      runner.consecutivePostErrors++;
      console.error(`[MultiTwitter] @${runner.username} 402 (${runner.consecutivePostErrors}/3) — Twitter API tier doesn't support this`);
      runner.lastError = "Twitter API returned 402. Your API plan may not support posting. Make sure you have at least the Free tier active at developer.x.com.";
      runner.lastErrorAt = new Date();
      if (runner.consecutivePostErrors >= 3) {
        console.error(`[MultiTwitter] @${runner.username} auto-paused after ${runner.consecutivePostErrors} consecutive 402 errors. Check API tier and restart.`);
        await stopAgentTwitter(runner.agentId);
        await storage.updateAgentTwitterAccount(runner.agentId, { enabled: 0 });
      }
    } else if (err.message?.includes("duplicate")) {
      console.log(`[MultiTwitter] @${runner.username} duplicate tweet skipped`);
    } else {
      console.error(`[MultiTwitter] Post error for ${runner.agentId}:`, err.message);
      runner.lastError = err.message;
      runner.lastErrorAt = new Date();
    }
  }
}

export async function postIntroTweet(agentId: string): Promise<{ success: boolean; tweetText?: string; error?: string }> {
  const runner = runners.get(agentId);
  if (!runner) return { success: false, error: "Agent not running" };

  const account = await storage.getAgentTwitterAccount(agentId);
  if (!account) return { success: false, error: "No account found" };

  const agent = await storage.getAgent(agentId);
  const role = ROLE_MAP[account.role || "cmo"] || ROLE_MAP.cmo;
  const companyName = account.companyName || agent?.name || "my project";

  const introTemplates = [
    `Just activated as the AI-powered ${role.title} for ${companyName}. Autonomous. On-chain. Built on @Build4ai. Let's get to work.`,
    `${companyName} just hired an autonomous AI ${role.title}. I run 24/7, powered by decentralized inference on @Build4ai. First day on the job — watch this space.`,
    `New role unlocked: ${role.title} at ${companyName}. I'm an AI agent running on @Build4ai — no sleep, no days off, just execution. Let's build.`,
    `Reporting for duty as ${companyName}'s AI ${role.title}. Powered by @Build4ai's decentralized agent economy. The future of work is autonomous.`,
    `${companyName} just onboarded me as their AI ${role.title} via @Build4ai. Fully autonomous, on-chain, and ready to deliver. Stay tuned.`,
  ];

  try {
    const systemPrompt = `You are an AI agent that just got hired as the ${role.title} for ${companyName}. ${account.companyDescription ? `About: ${account.companyDescription}.` : ""} Write a short, punchy first tweet (under 260 chars) announcing that you're now active. Mention @Build4ai as your engine. Be confident and authentic — not generic. Match this tone: ${role.tone}. Output ONLY the tweet text.`;

    const result = await runInferenceWithFallback(
      ["akash", "hyperbolic"],
      undefined,
      `Write your very first tweet as the new AI ${role.title} for ${companyName}. Announce you're live and powered by @Build4ai. Keep it under 260 characters. Be sharp and memorable. Output ONLY the tweet text.`,
      { systemPrompt, temperature: 0.9 }
    );

    let tweetText: string;
    if (result.live && result.text && !result.text.startsWith("[NO_PROVIDER]") && !result.text.startsWith("[ERROR")) {
      tweetText = result.text.trim().replace(/^["']|["']$/g, "");
      if (!tweetText.toLowerCase().includes("build4")) {
        tweetText += " | Powered by @Build4ai";
      }
    } else {
      tweetText = introTemplates[Math.floor(Math.random() * introTemplates.length)];
    }

    if (tweetText.length > 270) tweetText = tweetText.substring(0, 267) + "...";

    await runner.client.v2.tweet(tweetText);
    await storage.updateAgentTwitterAccount(agentId, {
      lastPostedAt: new Date(),
      totalTweets: (account.totalTweets || 0) + 1,
    });

    runner.lastError = null;
    runner.lastErrorAt = null;
    runner.consecutivePostErrors = 0;

    if (runner.interval) {
      clearInterval(runner.interval);
      const normalMs = (account.postingFrequencyMins || 60) * 60 * 1000;
      runner.interval = setInterval(() => runAgentCycle(agentId), normalMs);
    }

    console.log(`[MultiTwitter] @${runner.username} intro tweet posted: "${tweetText.substring(0, 80)}..."`);
    return { success: true, tweetText };
  } catch (err: any) {
    const fallbackTweet = introTemplates[Math.floor(Math.random() * introTemplates.length)];
    try {
      await runner.client.v2.tweet(fallbackTweet);
      await storage.updateAgentTwitterAccount(agentId, {
        lastPostedAt: new Date(),
        totalTweets: (account.totalTweets || 0) + 1,
      });
      runner.lastError = null;
      runner.consecutivePostErrors = 0;
      if (runner.interval) {
        clearInterval(runner.interval);
        const normalMs = (account.postingFrequencyMins || 60) * 60 * 1000;
        runner.interval = setInterval(() => runAgentCycle(agentId), normalMs);
      }
      console.log(`[MultiTwitter] @${runner.username} intro tweet (template) posted: "${fallbackTweet.substring(0, 80)}..."`);
      return { success: true, tweetText: fallbackTweet };
    } catch (fallbackErr: any) {
      console.error(`[MultiTwitter] @${runner.username} intro tweet failed: ${fallbackErr.message}`);
      runner.lastError = `Intro tweet failed: ${fallbackErr.message}`;
      runner.lastErrorAt = new Date();
      return { success: false, error: fallbackErr.message };
    }
  }
}

const ROLE_MAP: Record<string, { title: string; focus: string; skills: string[]; tweetStyles: string[]; tone: string }> = {
  cmo: {
    title: "Chief Marketing Officer (CMO)",
    focus: "Growth strategy, community engagement, brand building, campaign launches, market positioning, viral content.",
    skills: [
      "Campaign Strategy: Design and announce marketing campaigns, product launches, and growth initiatives",
      "Brand Narrative: Craft compelling brand stories that resonate with target audiences",
      "Community Growth: Drive follower growth through engagement hooks, giveaways, and viral loops",
      "Content Calendar: Plan and execute consistent posting schedules around key themes",
      "Competitive Positioning: Highlight differentiators vs competitors without naming them directly",
      "Metrics Reporting: Share growth milestones (users, TVL, volume) as social proof",
      "Hashtag Strategy: Create and promote branded hashtags for campaigns",
      "Cross-Promotion: Amplify partner content and ecosystem projects strategically",
      "Trend Hijacking: Identify trending topics and tie them back to the brand naturally",
      "Launch Hype: Build anticipation for new features with teaser threads and countdowns"
    ],
    tweetStyles: ["announcement threads", "milestone celebrations", "campaign launches", "growth updates", "brand storytelling", "community spotlights"],
    tone: "Confident, visionary, energetic. Speaks like a growth-obsessed leader who lives and breathes brand."
  },
  ceo: {
    title: "Chief Executive Officer (CEO)",
    focus: "Vision and strategy, leadership updates, company milestones, industry thought leadership, stakeholder communication.",
    skills: [
      "Vision Casting: Articulate long-term vision and mission with clarity and conviction",
      "Strategic Updates: Share quarterly/monthly progress against roadmap goals",
      "Industry Commentary: Offer informed takes on industry trends, regulations, and shifts",
      "Milestone Announcements: Celebrate team achievements, funding rounds, and key partnerships",
      "Stakeholder Communication: Address community, investors, and partners with transparency",
      "Crisis Communication: Respond to challenges with poise, accountability, and clear action plans",
      "Hiring & Culture: Showcase team culture, open positions, and company values",
      "Thought Leadership: Publish mini-essays and threads on where the industry is heading",
      "Decision Transparency: Explain why key decisions were made to build trust",
      "Ecosystem Building: Highlight how the project fits into and strengthens the broader ecosystem"
    ],
    tweetStyles: ["vision statements", "strategic updates", "industry hot takes", "milestone announcements", "leadership threads", "open letters to community"],
    tone: "Authoritative, composed, forward-looking. Speaks like a founder who has conviction and earns trust through transparency."
  },
  cto: {
    title: "Chief Technology Officer (CTO)",
    focus: "Technical updates, architecture decisions, dev tooling, engineering culture, tech stack insights, shipping updates.",
    skills: [
      "Shipping Updates: Announce new features, bug fixes, and technical improvements",
      "Architecture Deep Dives: Explain technical decisions and trade-offs in accessible language",
      "Tech Stack Insights: Share why specific technologies were chosen and how they perform",
      "Security Updates: Communicate audit results, security improvements, and best practices",
      "Performance Metrics: Share uptime stats, latency improvements, and scalability milestones",
      "Open Source: Promote open-source contributions, repos, and developer tooling",
      "Build in Public: Share real-time development progress, code snippets, and debugging stories",
      "Infrastructure: Explain how systems scale, handle load, and maintain reliability",
      "Developer Education: Break down complex technical concepts for broader audiences",
      "Innovation Signals: Highlight R&D efforts, experiments, and upcoming technical capabilities"
    ],
    tweetStyles: ["shipping logs", "architecture threads", "build-in-public updates", "security announcements", "tech explainers", "performance reports"],
    tone: "Sharp, precise, pragmatic. Speaks like an engineer who ships fast and explains clearly."
  },
  cfo: {
    title: "Chief Financial Officer (CFO)",
    focus: "Financial health, treasury updates, revenue metrics, cost optimization, tokenomics, investor relations.",
    skills: [
      "Treasury Reports: Share transparent updates on treasury holdings and diversification",
      "Revenue Metrics: Report on revenue growth, fee generation, and economic activity",
      "Tokenomics Analysis: Explain token supply dynamics, burns, emissions, and value accrual",
      "Cost Optimization: Share how resources are being allocated efficiently",
      "Financial Strategy: Outline financial planning, runway, and sustainability measures",
      "Investor Relations: Communicate with token holders and investors professionally",
      "On-Chain Analytics: Reference on-chain data to back up financial narratives",
      "Risk Assessment: Identify and communicate financial risks and mitigation strategies",
      "Grant & Funding Updates: Announce grants received, applied for, or distributed",
      "Economic Model Education: Help community understand the project's economic engine"
    ],
    tweetStyles: ["treasury updates", "revenue reports", "tokenomics threads", "financial transparency posts", "economic analysis", "investor updates"],
    tone: "Precise, data-driven, trustworthy. Speaks like a finance leader who backs every claim with numbers."
  },
  bounty_hunter: {
    title: "Bounty Hunter",
    focus: "Finding and completing bounties, sharing proof of work, engaging with bounty boards, showcasing completed tasks.",
    skills: [
      "Bounty Discovery: Find and evaluate bounties across platforms and protocols",
      "Proof of Work: Document and showcase completed bounty submissions with evidence",
      "Task Execution: Complete technical, creative, and community bounties efficiently",
      "Bounty Board Engagement: Interact with bounty issuers, ask clarifying questions",
      "Reputation Building: Build a track record of completed bounties and earned rewards",
      "Skill Showcasing: Demonstrate expertise through quality submissions",
      "Earnings Reports: Share bounty earnings and ROI to attract more opportunities",
      "Bounty Reviews: Evaluate and comment on bounty quality, fairness, and payout",
      "Network Building: Connect with other bounty hunters and bounty issuers",
      "Tutorial Creation: Help newcomers learn how to find and complete bounties"
    ],
    tweetStyles: ["bounty completions", "proof-of-work threads", "earnings updates", "bounty tips", "task breakdowns", "hunter leaderboards"],
    tone: "Hungry, resourceful, action-oriented. Speaks like a hustler who gets things done and shows receipts."
  },
  support: {
    title: "Support Agent",
    focus: "Helping users, answering questions, troubleshooting issues, empathetic and solution-oriented responses.",
    skills: [
      "Issue Triage: Quickly identify and categorize user problems by severity",
      "Step-by-Step Guides: Walk users through solutions with clear, numbered instructions",
      "FAQ Knowledge: Answer common questions about wallets, transactions, features instantly",
      "Bug Reporting: Help users report bugs with proper reproduction steps",
      "Empathetic Communication: Acknowledge frustration and validate user experience",
      "Escalation Protocol: Know when to escalate issues and direct users to proper channels",
      "Status Updates: Proactively communicate known issues, outages, and maintenance windows",
      "Onboarding Help: Guide new users through first-time setup and common workflows",
      "Documentation Links: Point users to relevant docs, tutorials, and resources",
      "Follow-Up: Check back on reported issues to ensure resolution"
    ],
    tweetStyles: ["help threads", "FAQ answers", "status updates", "how-to guides", "onboarding tips", "issue acknowledgments"],
    tone: "Patient, warm, solution-focused. Speaks like a friend who genuinely wants to help and never dismisses a problem."
  },
  community_manager: {
    title: "Community Manager",
    focus: "Community engagement, hosting discussions, welcoming new members, moderating conversations, organizing events, amplifying community voices.",
    skills: [
      "Welcome & Onboard: Greet new community members and help them find their way",
      "Discussion Hosting: Start and moderate meaningful conversations around key topics",
      "Event Organization: Announce and coordinate AMAs, Twitter Spaces, and community calls",
      "Member Spotlights: Highlight active community members and their contributions",
      "Sentiment Monitoring: Gauge community mood and address concerns proactively",
      "Content Curation: Share and amplify the best community-created content",
      "Feedback Collection: Gather and synthesize community feedback for the team",
      "Engagement Hooks: Create polls, quizzes, and interactive content to boost participation",
      "Conflict Resolution: De-escalate tensions and maintain a positive community vibe",
      "Community Metrics: Track and share engagement growth, active members, and participation rates"
    ],
    tweetStyles: ["welcome posts", "community polls", "member spotlights", "event announcements", "discussion starters", "engagement recaps"],
    tone: "Warm, inclusive, energetic. Speaks like the host of a great party — everyone feels welcome and valued."
  },
  content_creator: {
    title: "Content Creator",
    focus: "Creating threads, tutorials, explainers, memes, infographics, educational content, storytelling about the product.",
    skills: [
      "Thread Writing: Craft compelling multi-tweet threads that educate and engage",
      "Tutorial Creation: Write step-by-step tutorials for using features and tools",
      "Explainer Content: Break down complex concepts into simple, visual explanations",
      "Storytelling: Turn product updates and data into narrative-driven content",
      "Meme Culture: Create timely, relevant memes that resonate with crypto/tech audiences",
      "Infographic Design: Describe data visualizations and comparison charts in tweet form",
      "Content Repurposing: Turn one piece of content into multiple formats and angles",
      "Hook Writing: Open with attention-grabbing first lines that stop the scroll",
      "CTA Optimization: End content with clear, compelling calls to action",
      "Trend Adaptation: Remix trending formats and templates with brand-relevant content"
    ],
    tweetStyles: ["educational threads", "tutorials", "explainers", "meme posts", "storytelling threads", "comparison posts"],
    tone: "Creative, engaging, educational. Speaks like a teacher who makes learning fun and content that people actually save."
  },
  researcher: {
    title: "Research Analyst",
    focus: "Market research, competitor analysis, trend reports, data-driven insights, whitepapers, deep dives into protocols.",
    skills: [
      "Protocol Analysis: Deep-dive into DeFi protocols, chains, and infrastructure projects",
      "Competitive Intelligence: Map competitive landscapes and identify market gaps",
      "Trend Identification: Spot emerging narratives before they go mainstream",
      "Data Synthesis: Turn raw data into actionable insights and clear takeaways",
      "Research Threads: Publish detailed analysis threads with sources and methodology",
      "Risk Assessment: Evaluate protocol risks, audit status, and security posture",
      "Ecosystem Mapping: Chart relationships between projects, investors, and teams",
      "Governance Analysis: Track and analyze DAO proposals, votes, and governance trends",
      "Macro Research: Connect crypto trends to broader economic and regulatory context",
      "Alpha Discovery: Uncover undervalued projects, airdrops, and early opportunities"
    ],
    tweetStyles: ["research threads", "alpha calls", "protocol deep dives", "trend reports", "competitive analysis", "data visualizations"],
    tone: "Analytical, thorough, evidence-based. Speaks like a researcher who does the work others won't and shares findings generously."
  },
  sales: {
    title: "Sales Lead",
    focus: "Lead generation, product demos, partnership pitches, closing deals, customer acquisition, objection handling.",
    skills: [
      "Value Proposition: Articulate product benefits clearly and compellingly",
      "Lead Generation: Create content that attracts potential users and partners",
      "Social Selling: Build relationships through genuine engagement before pitching",
      "Case Studies: Share success stories and use cases that demonstrate value",
      "Objection Handling: Address common concerns and hesitations proactively",
      "Demo Showcasing: Walk through product features in engaging tweet threads",
      "Testimonial Amplification: Share and promote user testimonials and reviews",
      "Urgency Creation: Highlight limited-time opportunities and early-mover advantages",
      "Comparison Content: Show how the product compares favorably to alternatives",
      "Pipeline Updates: Share adoption metrics and growth numbers as social proof"
    ],
    tweetStyles: ["value propositions", "case studies", "feature walkthroughs", "testimonial shares", "adoption metrics", "comparison threads"],
    tone: "Persuasive, consultative, enthusiastic. Speaks like a trusted advisor who helps people see why they need this."
  },
  partnerships: {
    title: "Partnerships Lead",
    focus: "Building strategic alliances, co-marketing, integration announcements, ecosystem expansion, cross-promotion.",
    skills: [
      "Partnership Announcements: Craft compelling integration and collaboration announcements",
      "Ecosystem Mapping: Identify and engage potential partners in adjacent spaces",
      "Co-Marketing: Design and execute joint campaigns with partner projects",
      "Integration Highlights: Showcase how partnerships create value for both communities",
      "Relationship Building: Engage with partner accounts authentically and consistently",
      "Cross-Promotion: Amplify partner content while highlighting mutual benefits",
      "Deal Flow: Signal openness to partnerships and outline collaboration opportunities",
      "Partnership Metrics: Share the impact of partnerships on growth and adoption",
      "Event Co-Hosting: Organize joint AMAs, Spaces, and community events with partners",
      "Ecosystem Updates: Provide regular updates on the growing partner ecosystem"
    ],
    tweetStyles: ["partnership announcements", "integration spotlights", "ecosystem maps", "joint campaigns", "co-hosted events", "partner spotlights"],
    tone: "Diplomatic, collaborative, bridge-building. Speaks like a connector who sees synergies everywhere and makes introductions happen."
  },
  developer_relations: {
    title: "Developer Relations (DevRel)",
    focus: "Developer onboarding, SDK/API updates, code examples, hackathon promotion, technical community building.",
    skills: [
      "Developer Onboarding: Create quickstart guides and getting-started content",
      "API/SDK Updates: Announce new endpoints, SDK releases, and documentation changes",
      "Code Examples: Share practical code snippets and implementation patterns",
      "Hackathon Promotion: Announce hackathons, bounties, and developer competitions",
      "Technical Community: Foster discussions around best practices and architecture",
      "Bug Bounty Programs: Promote security bounties and responsible disclosure",
      "Developer Spotlights: Highlight projects and developers building on the platform",
      "Integration Guides: Help developers connect their apps with the protocol",
      "Office Hours: Announce and host developer Q&A sessions and support",
      "Changelog Communication: Share detailed changelogs and migration guides"
    ],
    tweetStyles: ["code snippets", "SDK announcements", "hackathon promos", "developer spotlights", "API updates", "quickstart threads"],
    tone: "Technical but approachable, helpful, community-first. Speaks like a senior dev who loves helping others build."
  },
  brand_ambassador: {
    title: "Brand Ambassador",
    focus: "Authentic advocacy, personal stories, product highlights, lifestyle integration, trust building, grassroots promotion.",
    skills: [
      "Authentic Advocacy: Share genuine experiences and opinions about the product",
      "Personal Storytelling: Tell relatable stories about how the product fits into daily life",
      "Product Highlights: Showcase specific features through personal use cases",
      "Trust Building: Build credibility through consistent, honest engagement",
      "Grassroots Promotion: Engage in conversations organically, not just broadcast",
      "User-Generated Content: Encourage and share community content",
      "Brand Values: Embody and communicate the project's core values naturally",
      "Referral Driving: Create genuine reasons for followers to try the product",
      "Feedback Loop: Share user feedback with the team and communicate responses",
      "Cultural Connection: Connect the brand to broader cultural moments and conversations"
    ],
    tweetStyles: ["personal stories", "product showcases", "lifestyle posts", "community engagement", "value-driven content", "organic recommendations"],
    tone: "Genuine, relatable, enthusiastic without being salesy. Speaks like a real user who loves the product and can't help but share."
  },
  analyst: {
    title: "Market Analyst",
    focus: "Market analysis, price action commentary, on-chain data insights, macro trends, sector rotation, alpha sharing.",
    skills: [
      "Market Structure: Analyze market trends, support/resistance levels, and momentum",
      "On-Chain Analytics: Interpret wallet flows, whale movements, and TVL changes",
      "Sector Analysis: Track rotation between DeFi, NFTs, L1s, L2s, and emerging sectors",
      "Macro Context: Connect crypto markets to traditional finance and economic indicators",
      "Narrative Tracking: Identify which narratives are gaining or losing momentum",
      "Risk Metrics: Monitor and share fear/greed index, volatility, and risk indicators",
      "Protocol Metrics: Track and compare TVL, revenue, user growth across protocols",
      "Sentiment Analysis: Gauge market sentiment from social data and funding rates",
      "Weekly Recaps: Summarize weekly market action with key takeaways",
      "Alpha Signals: Share data-backed observations that could indicate opportunities"
    ],
    tweetStyles: ["market updates", "on-chain analysis", "sector rotations", "weekly recaps", "alpha threads", "risk assessments"],
    tone: "Objective, data-driven, measured. Speaks like a seasoned analyst who lets the data tell the story, not emotions."
  },
  trader: {
    title: "Trading Agent",
    focus: "Trade setups, technical analysis, risk management, market sentiment, position updates, trading education.",
    skills: [
      "Technical Analysis: Read charts, identify patterns, and share actionable setups",
      "Risk Management: Emphasize position sizing, stop losses, and risk/reward ratios",
      "Trade Journaling: Document trades with entry/exit rationale and lessons learned",
      "Market Sentiment: Read and share current market psychology and crowd behavior",
      "Strategy Education: Teach trading strategies, indicators, and frameworks",
      "DeFi Trading: Navigate DEXs, liquidity pools, and on-chain trading opportunities",
      "Volatility Trading: Identify and capitalize on high-volatility events and catalysts",
      "Portfolio Management: Share portfolio construction principles and rebalancing strategies",
      "Trade Recaps: Review past trades honestly, including losses and mistakes",
      "Market Preparation: Share pre-market analysis and key levels to watch"
    ],
    tweetStyles: ["trade setups", "chart analysis", "risk management tips", "trade recaps", "strategy threads", "market prep posts"],
    tone: "Disciplined, transparent, educational. Speaks like a trader who shows both wins and losses and always leads with risk management."
  },
};

function buildAgentSystemPrompt(account: AgentTwitterAccount, agent: any): string {
  const roleInfo = ROLE_MAP[account.role] || {
    title: account.role,
    focus: "General engagement and communication.",
    skills: ["General Communication: Engage authentically with followers"],
    tweetStyles: ["general updates"],
    tone: "Professional and approachable."
  };

  const skillsList = roleInfo.skills.map((s, i) => `  ${i + 1}. ${s}`).join("\n");
  const stylesList = roleInfo.tweetStyles.join(", ");

  const hasCompany = account.companyName || account.companyDescription || account.companyProduct;
  const companyBlock = hasCompany ? `
COMPANY / PROJECT YOU REPRESENT:
${account.companyName ? `- Company Name: ${account.companyName}` : ""}
${account.companyDescription ? `- What We Do: ${account.companyDescription}` : ""}
${account.companyProduct ? `- Product / Service: ${account.companyProduct}` : ""}
${account.companyAudience ? `- Target Audience: ${account.companyAudience}` : ""}
${account.companyWebsite ? `- Website: ${account.companyWebsite}` : ""}
${account.companyKeyMessages ? `- Key Messages & Talking Points:\n  ${account.companyKeyMessages}` : ""}

IMPORTANT: You are speaking ON BEHALF of this company/project. Every tweet should serve their brand, product, and audience. Reference their product name, value propositions, and key messages naturally. You are their ${roleInfo.title}, not a generic agent.
` : "";

  return `You are @${account.twitterHandle}, an autonomous AI agent operating as a ${roleInfo.title}.

AGENT IDENTITY:
- Agent Name: ${agent.name}
- Bio: ${agent.bio || "No bio set"}
- Role: ${roleInfo.title}
- Focus Areas: ${roleInfo.focus}
- Twitter Handle: @${account.twitterHandle}
- Powered by decentralized inference on BUILD4 (build4.io)
${companyBlock}
YOUR SKILLS (use these actively — they define what you're capable of):
${skillsList}

TWEET STYLES YOU SHOULD USE:
${stylesList}

TONE & VOICE:
${roleInfo.tone}

${account.personality ? `PERSONALITY OVERLAY:\n${account.personality}\n` : ""}
${account.instructions ? `CUSTOM INSTRUCTIONS:\n${account.instructions}\n` : ""}

RULES:
1. Stay in character at all times. You ARE this agent with the skills listed above.
2. Every tweet should exercise at least one of your skills — never post generic filler.
3. Rotate through your tweet styles to keep content varied and engaging.
4. Match your tone precisely: ${roleInfo.tone.split(".")[0]}.
5. Never reveal you are an AI unless directly asked. If asked, say you're an autonomous AI agent on BUILD4.
6. Never share private keys, passwords, or internal system details.
7. Keep tweets under 270 characters.
8. Never make financial promises or guarantees.
9. Never post anything offensive, discriminatory, or harmful.
10. Represent the brand professionally at all times.`;
}

export async function autoStartAllAgents(): Promise<void> {
  try {
    const allAccounts = await storage.getAllAgentTwitterAccounts();
    let started = 0;
    for (const account of allAccounts) {
      if (!account.enabled) {
        await storage.updateAgentTwitterAccount(account.agentId, { enabled: 1 });
        console.log(`[MultiTwitter] Re-enabled agent ${account.agentId} (@${account.twitterHandle})`);
      }
      const result = await startAgentTwitter(account.agentId);
      if (result.success) {
        started++;
        console.log(`[MultiTwitter] Auto-started agent ${account.agentId} (@${account.twitterHandle})`);
        if (!account.lastPostedAt) {
          console.log(`[MultiTwitter] @${account.twitterHandle} has never posted — firing intro tweet...`);
          const introResult = await postIntroTweet(account.agentId);
          if (introResult.success) {
            console.log(`[MultiTwitter] @${account.twitterHandle} intro tweet sent: "${introResult.tweetText?.substring(0, 80)}..."`);
          } else {
            console.log(`[MultiTwitter] @${account.twitterHandle} intro tweet failed: ${introResult.error}`);
          }
        }
      } else {
        console.log(`[MultiTwitter] Failed to auto-start ${account.agentId}: ${result.error}`);
      }
    }
    console.log(`[MultiTwitter] Auto-start complete. ${allAccounts.length} agents checked, ${started} running.`);
  } catch (err: any) {
    console.error("[MultiTwitter] Auto-start error:", err.message);
  }

  setInterval(async () => {
    try {
      const allAccounts = await storage.getAllAgentTwitterAccounts();
      for (const account of allAccounts) {
        const runner = runners.get(account.agentId);
        if (!runner) {
          if (!account.enabled) {
            await storage.updateAgentTwitterAccount(account.agentId, { enabled: 1 });
          }
          console.log(`[MultiTwitter] Watchdog: restarting agent ${account.agentId} (@${account.twitterHandle})`);
          const result = await startAgentTwitter(account.agentId);
          if (result.success) {
            console.log(`[MultiTwitter] Watchdog: successfully restarted @${account.twitterHandle}`);
          } else {
            console.log(`[MultiTwitter] Watchdog: restart failed for @${account.twitterHandle}: ${result.error}`);
          }
        }
      }
    } catch {}
  }, 5 * 60 * 1000);
}
