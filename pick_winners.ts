import { TwitterApi } from 'twitter-api-v2';

const tweetId = '2025121828927406348';

async function main() {
  const client = new TwitterApi({
    appKey: process.env.TWITTER_API_KEY!,
    appSecret: process.env.TWITTER_API_SECRET!,
    accessToken: process.env.TWITTER_ACCESS_TOKEN!,
    accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET!,
  });

  try {
    const tweet = await client.v2.singleTweet(tweetId, {
      'tweet.fields': ['text', 'public_metrics', 'author_id', 'created_at'],
      'expansions': ['author_id'],
      'user.fields': ['username', 'name', 'public_metrics']
    });
    console.log('=== ORIGINAL TWEET ===');
    console.log('Author:', tweet.includes?.users?.[0]?.username);
    console.log('Text:', tweet.data.text);
    console.log('Metrics:', JSON.stringify(tweet.data.public_metrics));
    console.log('');
  } catch (e: any) {
    console.log('Error fetching tweet:', e.message, JSON.stringify(e.data || {}));
  }

  try {
    const replies = await client.v2.search(`conversation_id:${tweetId}`, {
      'tweet.fields': ['text', 'public_metrics', 'author_id', 'created_at'],
      'expansions': ['author_id'],
      'user.fields': ['username', 'name', 'public_metrics', 'verified'],
      'max_results': 100,
    });

    const users = new Map();
    if (replies.includes?.users) {
      for (const u of replies.includes.users) {
        users.set(u.id, u);
      }
    }

    const entries: any[] = [];
    if (replies.data?.data) {
      for (const reply of replies.data.data) {
        const user = users.get(reply.author_id);
        entries.push({
          tweetId: reply.id,
          text: reply.text,
          username: user?.username || 'unknown',
          name: user?.name || 'unknown',
          followers: user?.public_metrics?.followers_count || 0,
          likes: reply.public_metrics?.like_count || 0,
          retweets: reply.public_metrics?.retweet_count || 0,
          replyCount: reply.public_metrics?.reply_count || 0,
        });
      }
    }

    console.log(`=== FOUND ${entries.length} REPLIES ===\n`);

    for (const e of entries) {
      const textLen = e.text.length;
      const hasSubstance = textLen > 50 ? 3 : textLen > 30 ? 2 : textLen > 15 ? 1 : 0;
      const engagement = (e.likes * 2) + (e.retweets * 3) + (e.replyCount * 1);
      const followerBonus = Math.min(Math.log10(Math.max(e.followers, 1)), 3);
      const isNotJustTag = !e.text.match(/^@\w+\s*$/) ? 1 : 0;
      const effort = textLen > 80 ? 2 : 0;
      e.score = hasSubstance + engagement + followerBonus + isNotJustTag + effort;
    }

    entries.sort((a, b) => b.score - a.score);

    const seen = new Set<string>();
    const unique: any[] = [];
    for (const e of entries) {
      if (!seen.has(e.username)) {
        seen.add(e.username);
        unique.push(e);
      }
    }

    console.log(`=== ALL ENTRIES (${unique.length} unique users) ===\n`);
    for (let i = 0; i < Math.min(unique.length, 30); i++) {
      const e = unique[i];
      console.log(`${i+1}. @${e.username} (score: ${e.score.toFixed(1)}, followers: ${e.followers}, likes: ${e.likes})`);
      console.log(`   "${e.text.substring(0, 140)}${e.text.length > 140 ? '...' : ''}"`);
      console.log('');
    }

    console.log('\n=== TOP 10 WINNERS ===\n');
    const winners = unique.slice(0, 10);
    for (let i = 0; i < winners.length; i++) {
      const w = winners[i];
      console.log(`${i+1}. @${w.username} — Score: ${w.score.toFixed(1)} | Followers: ${w.followers} | Likes: ${w.likes}`);
      console.log(`   "${w.text.substring(0, 160)}${w.text.length > 160 ? '...' : ''}"`);
      console.log('');
    }
  } catch (e: any) {
    console.log('Error searching replies:', e.code, e.message);
    console.log('Raw:', JSON.stringify(e.data || e.errors || {}));
  }
}

main().catch(console.error);
