import { TwitterApi } from "twitter-api-v2";

let client: TwitterApi | null = null;

function getClient(): TwitterApi {
  if (!client) {
    const apiKey = process.env.TWITTER_API_KEY;
    const apiSecret = process.env.TWITTER_API_SECRET;
    const accessToken = process.env.TWITTER_ACCESS_TOKEN;
    const accessTokenSecret = process.env.TWITTER_ACCESS_TOKEN_SECRET;

    if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) {
      throw new Error("Twitter API credentials not configured");
    }

    client = new TwitterApi({
      appKey: apiKey,
      appSecret: apiSecret,
      accessToken,
      accessSecret: accessTokenSecret,
    });
  }
  return client;
}

export function isTwitterConfigured(): boolean {
  return !!(
    process.env.TWITTER_API_KEY &&
    process.env.TWITTER_API_SECRET &&
    process.env.TWITTER_ACCESS_TOKEN &&
    process.env.TWITTER_ACCESS_TOKEN_SECRET
  );
}

export async function postTweet(text: string): Promise<{ tweetId: string; tweetUrl: string }> {
  const tc = getClient();
  try {
    let tweetId: string;
    let username: string;
    try {
      const result = await tc.v1.tweet(text);
      tweetId = result.id_str;
      username = result.user?.screen_name || "Build4ai";
    } catch (v1Err: any) {
      console.log("[TwitterClient] v1 tweet failed, trying v2:", v1Err.message);
      const result = await tc.v2.tweet(text);
      tweetId = result.data.id;
      const me = await tc.v2.me();
      username = me.data.username;
    }
    const tweetUrl = `https://x.com/${username}/status/${tweetId}`;
    return { tweetId, tweetUrl };
  } catch (err: any) {
    console.error("[TwitterClient] Tweet failed:", err.message, err.data ? JSON.stringify(err.data) : "");
    if (err.code === 402 || err.data?.title === "CreditsDepleted") {
      throw new Error("Twitter API credits depleted — your X/Twitter developer account has no remaining credits. Visit developer.x.com to add credits or upgrade your plan.");
    }
    if (err.code === 403 || err.data?.detail?.includes("Forbidden")) {
      client = null;
      const detail = err.data?.detail || err.data?.errors?.[0]?.message || err.message || "";
      console.error("[TwitterClient] 403 detail:", detail, "full data:", JSON.stringify(err.data || {}));
      throw new Error(`Twitter API 403: ${detail}`);
    }
    if (err.code === 429) {
      throw new Error("Twitter rate limit exceeded — wait a few minutes and try again.");
    }
    if (err.code === 401) {
      client = null;
      throw new Error("Twitter authentication failed — check your API keys and tokens in secrets.");
    }
    if (err.message?.includes("duplicate")) {
      throw new Error("Twitter rejected this as a duplicate tweet — try changing the task description slightly.");
    }
    throw err;
  }
}

export interface TweetReply {
  id: string;
  text: string;
  authorId: string;
  authorUsername: string;
  createdAt?: string;
  conversationId?: string;
}

export async function getReplies(tweetId: string, sinceId?: string): Promise<TweetReply[]> {
  const tc = getClient();
  const me = await tc.v2.me();
  const query = `conversation_id:${tweetId} -from:${me.data.username}`;

  const params: any = {
    "tweet.fields": ["author_id", "created_at", "text"],
    "user.fields": ["username"],
    expansions: ["author_id"],
    max_results: 100,
  };
  if (sinceId) {
    params.since_id = sinceId;
  }

  const searchResult = await tc.v2.search(query, params);

  const replies: TweetReply[] = [];
  const users = new Map<string, string>();

  if (searchResult.includes?.users) {
    for (const user of searchResult.includes.users) {
      users.set(user.id, user.username);
    }
  }

  for (const tweet of searchResult.data?.data || []) {
    replies.push({
      id: tweet.id,
      text: tweet.text,
      authorId: tweet.author_id || "",
      authorUsername: users.get(tweet.author_id || "") || "unknown",
      createdAt: tweet.created_at,
    });
  }

  return replies;
}

export async function replyToTweet(tweetId: string, text: string): Promise<string> {
  const tc = getClient();
  const result = await tc.v2.reply(text, tweetId);
  return result.data.id;
}

export async function getMentions(sinceId?: string): Promise<TweetReply[]> {
  const tc = getClient();
  const me = await tc.v2.me();

  const query = `@${me.data.username} -from:${me.data.username}`;
  const params: any = {
    "tweet.fields": ["author_id", "created_at", "text", "conversation_id", "in_reply_to_user_id"],
    "user.fields": ["username"],
    expansions: ["author_id"],
    max_results: 100,
  };
  if (sinceId) {
    params.since_id = sinceId;
  }

  const mentions: TweetReply[] = [];
  const users = new Map<string, string>();
  const MAX_PAGES = 5;
  let page = 0;
  let nextToken: string | undefined = undefined;

  do {
    if (nextToken) params.next_token = nextToken;
    const searchResult = await tc.v2.search(query, params);

    if (searchResult.includes?.users) {
      for (const user of searchResult.includes.users) {
        users.set(user.id, user.username);
      }
    }

    for (const tweet of searchResult.data?.data || []) {
      mentions.push({
        id: tweet.id,
        text: tweet.text,
        authorId: tweet.author_id || "",
        authorUsername: users.get(tweet.author_id || "") || "unknown",
        createdAt: tweet.created_at,
        conversationId: (tweet as any).conversation_id || undefined,
      });
    }

    nextToken = searchResult.meta?.next_token;
    page++;
  } while (nextToken && page < MAX_PAGES);

  if (mentions.length > 100) {
    console.log(`[TwitterAgent] Fetched ${mentions.length} mentions across ${page} pages`);
  }

  return mentions;
}

export async function getAccountInfo(): Promise<{ id: string; username: string; name: string }> {
  const tc = getClient();
  const me = await tc.v2.me({ "user.fields": ["name", "username"] });
  return {
    id: me.data.id,
    username: me.data.username,
    name: me.data.name,
  };
}
