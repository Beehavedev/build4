// Demo Day — Reddit narrative source for the four.meme launch agent.
//
// Why Reddit:
//   The agent already cross-references DexScreener trending + GNews
//   sentiment + Aster perp movers + Polymarket events. Reddit fills
//   the social-narrative gap: it's the one source that surfaces what
//   actual crypto + AI retail are TALKING ABOUT in the last hour, not
//   what's pumping or what made it onto a news wire. A great meme
//   launch often catches a reddit thread an hour before mainstream
//   crypto twitter notices.
//
// Why not the snippet the user pasted:
//   The snippet imported from a non-existent `signalScorer/` module
//   and a `NarrativeCandidate` interface this codebase doesn't have.
//   Slotting Reddit into the existing MarketContext pipeline is ~80
//   lines, zero new modules outside services/, and actually flows
//   into the LLM decision + the brain feed.
//
// Auth:
//   Reddit's public JSON endpoints (`/r/<sub>/search.json`) require
//   no key — only a non-default User-Agent (Reddit blocks the Node
//   default with 429s). All-source aggregation: 5 subs × 1 keyword
//   bundle = 5 HTTP calls per sweep, behind allSettled so any one sub
//    429ing degrades gracefully.
import axios from 'axios'

// User-selected mix: crypto + AI/AGI subs. The four.meme launch agent
// trades on the BSC meme-coin narrative, but AI-themed memes (HYPE,
// ai16z, etc.) have been a dominant cross-sub theme — including
// r/singularity + r/artificial gives the LLM a head-start on AI
// narrative shifts before they reach crypto-native subs.
const SUBREDDITS = [
  'CryptoCurrency',
  'BSC',
  'memecoin',
  'singularity',
  'artificial',
] as const

// One bundled query covers our intent — narrow enough to get hot
// posts, broad enough to catch BNB / BSC / AI memecoin chatter. We
// rely on Reddit's relevance ranking rather than running 5 separate
// keyword queries (which would 5× the request budget for marginal
// gain).
const QUERY = 'BNB OR BSC OR memecoin OR "AI agent"'

const HEADERS = {
  'User-Agent': 'BUILD4SignalBot/1.0 (autonomous trading agent)',
}

interface RedditPost {
  title: string
  score: number
  numComments: number
  url: string
  subreddit: string
  createdUtc: number
}

async function searchSubreddit(subreddit: string): Promise<RedditPost[]> {
  try {
    const { data } = await axios.get(
      `https://www.reddit.com/r/${subreddit}/search.json`,
      {
        headers: HEADERS,
        params: {
          q: QUERY,
          sort: 'new',
          // 25 keeps the page small but gives the score+comments
          // filter enough rows to surface a "hot" candidate.
          limit: 25,
          // 'hour' = posts from the last 60 min only. The launch
          // agent ticks every 60s; anything older than an hour is
          // stale narrative.
          t: 'hour',
          restrict_sr: true,
        },
        timeout: 5000,
      },
    )
    return (data?.data?.children ?? []).map((c: any) => ({
      title: String(c?.data?.title ?? '').slice(0, 280),
      score: Number(c?.data?.score ?? 0),
      numComments: Number(c?.data?.num_comments ?? 0),
      url: `https://reddit.com${c?.data?.permalink ?? ''}`,
      subreddit,
      createdUtc: Number(c?.data?.created_utc ?? 0),
    })) as RedditPost[]
  } catch {
    // Silent — caller logs aggregate health. Reddit 429s and
    // network blips should never break the launch sweep.
    return []
  }
}

export interface RedditSignal {
  // Top post across all subs by Reddit score.
  topTitle: string
  topScore: number
  topComments: number
  topSubreddit: string
  topUrl: string
  // Diagnostic — total "hot" posts (score>10 OR comments>5) across
  // all subs in the last hour. Lets the LLM gauge whether this is
  // a single viral thread vs a broad social moment.
  hotCount: number
}

// Demo Day — fetch fresh narrative from Reddit. Returns null when
// nothing crosses the relevance bar so the prompt doesn't get
// polluted with a "(reddit unavailable)" line every quiet minute.
export async function fetchRedditSignal(): Promise<RedditSignal | null> {
  const results = await Promise.allSettled(
    SUBREDDITS.map((sub) => searchSubreddit(sub)),
  )
  const all: RedditPost[] = []
  for (const r of results) if (r.status === 'fulfilled') all.push(...r.value)
  if (all.length === 0) return null

  // Hot-post filter mirrors the snippet's intent: a post is
  // "interesting" if either its score crossed 10 or it triggered >5
  // comments. Below this floor the post is effectively noise.
  const hot = all.filter((p) => p.score > 10 || p.numComments > 5)
  if (hot.length === 0) return null

  const top = hot.slice().sort((a, b) => b.score - a.score)[0]
  return {
    topTitle: top.title,
    topScore: top.score,
    topComments: top.numComments,
    topSubreddit: top.subreddit,
    topUrl: top.url,
    hotCount: hot.length,
  }
}
