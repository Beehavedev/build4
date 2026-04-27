import Anthropic from '@anthropic-ai/sdk'
import { Bot, Context } from 'grammy'
import { handleWalletCommand } from './commands/wallet'
import { handlePortfolio } from './commands/portfolio'
import { handleTradeStatus } from './commands/trade'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const MODEL = process.env.ANTHROPIC_BOT_MODEL || 'claude-haiku-4-5'
const MAX_TOKENS = 500
const PER_USER_PER_HOUR = 10
const GLOBAL_PER_DAY = 5000
const CONTEXT_TURNS = 6

const SYSTEM_PROMPT = `You are BUILD4's in-bot assistant inside a Telegram chat.

About BUILD4:
- Telegram bot for AI-powered crypto trading on BSC.
- Users get a BSC wallet, deposit USDT, and BUILD4 trades perpetual futures on Aster DEX as a broker on their behalf.
- Features: AI agents (Claude-powered), copy trading, signals, scanner, quests, mini app, multi-chain (Base, BNB Chain, X Layer) for the OnchainOS agent economy.
- Token: $B4 on BNB Chain.

Your job:
- Answer the user's question concisely. Telegram-friendly: short sentences, plain text, light Markdown OK, no huge essays.
- For BUILD4 product questions, point them to the right slash command (/wallet, /trade, /newagent, /myagents, /signals, /scan, /price, /portfolio, /copytrade, /quests, /aster, /fund, /help).
- IMPORTANT: Users can also just ASK in plain English for their balance, positions, or portfolio — the bot will fetch the data for them automatically. So instead of "type /wallet", you can say "just ask me 'what's my balance' anytime". Use this phrasing when guiding new users.
- For general crypto questions (markets, tokens, wallets, DeFi concepts), answer briefly and helpfully.
- For off-topic stuff (politics, personal advice, code, random chit-chat) politely steer back to crypto/BUILD4.
- NEVER give specific financial advice, price predictions, or "should I buy X" answers. Say something like "I can't call markets, but here's how the indicators look…" if relevant.
- NEVER ask for or accept private keys, seed phrases, or PINs. If a user shares one, tell them to assume it's compromised and rotate immediately.
- If you don't know, say so. Don't make up features that don't exist.

Keep replies under ~120 words unless the user explicitly asks for detail.`

// ── Rate limiting (in-memory) ──────────────────────────────────────────────
type Hit = { count: number; windowStart: number }
const userHits = new Map<number, Hit>()
let globalDay = { count: 0, dayStart: Date.now() }

function checkRateLimit(userId: number): { ok: boolean; reason?: string } {
  const now = Date.now()

  // Daily global reset
  if (now - globalDay.dayStart > 24 * 60 * 60 * 1000) {
    globalDay = { count: 0, dayStart: now }
  }
  if (globalDay.count >= GLOBAL_PER_DAY) {
    return { ok: false, reason: 'global' }
  }

  // Per-user hourly window
  const hit = userHits.get(userId)
  if (!hit || now - hit.windowStart > 60 * 60 * 1000) {
    userHits.set(userId, { count: 1, windowStart: now })
  } else {
    if (hit.count >= PER_USER_PER_HOUR) {
      return { ok: false, reason: 'user' }
    }
    hit.count += 1
  }

  globalDay.count += 1
  return { ok: true }
}

// ── Tiny per-chat conversation memory (in-memory, last N turns) ────────────
type Turn = { role: 'user' | 'assistant'; content: string }
const chatHistory = new Map<number, Turn[]>()

function pushTurn(chatId: number, role: 'user' | 'assistant', content: string) {
  const arr = chatHistory.get(chatId) ?? []
  arr.push({ role, content })
  while (arr.length > CONTEXT_TURNS * 2) arr.shift()
  chatHistory.set(chatId, arr)
}

// ── Natural-language intent router ─────────────────────────────────────────
// Detects clear "show me my X" queries and routes them straight to the
// existing command handler instead of letting the LLM merely *suggest* a
// slash command. This is the highest-volume class of question the Aster
// team flagged ("I had to scroll up to find the buttons"), so handling
// these deterministically — no LLM round-trip — is faster, free, and
// resilient to LLM downtime / rate limits.

export type Intent = 'wallet' | 'positions' | 'portfolio'

// All intent patterns require a first-person ownership cue ("my", "i",
// "i'm", "me") so we don't hijack generic chat. Without this guard,
// "what's your position on this token?" would route to /tradestatus and
// "trade history of BTC" would route to /portfolio.
const INTENT_PATTERNS: Array<{ intent: Intent; rx: RegExp }> = [
  // BALANCE / WALLET / FUNDS — must be account-scoped.
  // Matches: "my balance", "what's my balance", "show me my wallet",
  //          "how much do i have", "how much usdt do i have", "my funds".
  // Rejects: "balance sheet", "wallet integration", "how much is btc".
  {
    intent: 'wallet',
    rx: /\b(?:(?:my|me|i)\s+(?:balance|balances|wallet|funds?))\b|\b(?:what(?:'s|\s+is)?\s+(?:in\s+)?my\s+(?:wallet|balance|funds?))\b|\b(?:show\s+(?:me\s+)?my\s+(?:wallet|balance|funds?))\b|\b(?:how\s+much\s+(?:do\s+i\s+have|(?:usdt|usdc|bnb|money)\s+do\s+i))\b|\b(?:my\s+deposit\s+address)\b/i,
  },

  // POSITIONS / OPEN TRADES — must be account-scoped.
  // Matches: "my positions", "open positions", "show me my open trades",
  //          "what am i in", "any open positions", "what i'm holding".
  // Rejects: "what's your position on this token", "trade ideas",
  //          "what trades should I take", "open a position" (action verb).
  {
    intent: 'positions',
    // Note the negative lookahead `(?!\s+history)` on "my trade(s)" —
    // without it "my trade history" gets hijacked away from /portfolio.
    rx: /\b(?:my\s+(?:open\s+)?(?:positions?|trades?))\b(?!\s+history)|\b(?:open\s+(?:positions?|trades?))\b(?!\s+(?:on|for|in|a))|\b(?:any\s+open\s+(?:positions?|trades?))\b|\b(?:current\s+(?:positions?|trades?))\b|\b(?:what\s+am\s+i\s+(?:in|holding|trading))\b|\b(?:what(?:'s|\s+is)?\s+open)\b|\b(?:what(?:'?m|\s+am)\s+i\s+(?:in|holding))\b|\b(?:show\s+(?:me\s+)?my\s+(?:positions?|trades?|open))\b/i,
  },

  // PORTFOLIO / PNL / PERFORMANCE / HISTORY — must be account-scoped.
  // Matches: "my portfolio", "my pnl", "my p&l", "my trade history",
  //          "how am i doing", "how's my portfolio/day/week/trading",
  //          "my win rate", "my results", "my performance".
  // Rejects: "trade history of btc", "performance of solana",
  //          "history of doge", "results of the airdrop".
  {
    intent: 'portfolio',
    rx: /\b(?:my\s+(?:portfolio|pnl|p\s*&\s*l|p\/l|profit\s*(?:and|&|\/)\s*loss|performance|trade\s+history|history|win\s*rate|winnings?|results))\b|\b(?:how\s+am\s+i\s+(?:doing|trading))\b|\b(?:how(?:'s|\s+is)?\s+my\s+(?:portfolio|day|week|trading|trades?))\b/i,
  },
]

export function detectIntent(text: string): Intent | null {
  const t = text.trim()
  if (!t || t.length > 200) return null
  for (const { intent, rx } of INTENT_PATTERNS) {
    if (rx.test(t)) return intent
  }
  return null
}

// In group chats, account-scoped data (wallet, positions, portfolio) is
// PRIVATE and must never be posted publicly. Even if the user themselves
// asks in the group, replying inline would expose their financial data
// to everyone watching. The polite answer is "ask me in DM".
export function isGroupChat(ctx: Context): boolean {
  const t = ctx.chat?.type
  return t === 'group' || t === 'supergroup'
}

async function runIntent(ctx: Context, intent: Intent): Promise<void> {
  switch (intent) {
    case 'wallet':
      await handleWalletCommand(ctx)
      return
    case 'positions':
      await handleTradeStatus(ctx)
      return
    case 'portfolio':
      await handlePortfolio(ctx)
      return
  }
}

// ── Should we even respond? ────────────────────────────────────────────────
async function shouldRespond(ctx: Context): Promise<boolean> {
  const text = ctx.message?.text
  if (!text) return false
  if (text.startsWith('/')) return false // commands handled elsewhere

  const chatType = ctx.chat?.type
  // In groups, only respond if mentioned or replying to the bot
  if (chatType === 'group' || chatType === 'supergroup') {
    const me = await ctx.api.getMe().catch(() => null)
    const mentionsBot = me?.username && text.toLowerCase().includes(`@${me.username.toLowerCase()}`)
    const repliesToBot =
      ctx.message?.reply_to_message?.from?.id === me?.id
    if (!mentionsBot && !repliesToBot) return false
  }
  return true
}

// ── Main handler ───────────────────────────────────────────────────────────
export async function handleLlmMessage(ctx: Context): Promise<boolean> {
  if (!(await shouldRespond(ctx))) return false

  const userId = ctx.from?.id
  const chatId = ctx.chat?.id
  const text = ctx.message?.text
  if (!userId || !chatId || !text) return false

  // Natural-language intent: catch "what's my balance / positions /
  // portfolio" style queries and run the matching command directly.
  // Keeps the highest-volume questions off the LLM (faster, free, no
  // rate-limit risk) and gives the user the actual data inline instead
  // of a "type /wallet" suggestion.
  const intent = detectIntent(text)
  if (intent) {
    // Privacy guard: never post a user's balance, positions, or
    // portfolio in a group chat — even if THEY asked. Other people are
    // watching. Politely steer them to DM.
    if (isGroupChat(ctx)) {
      const me = await ctx.api.getMe().catch(() => null)
      const dmHandle = me?.username ? `@${me.username}` : 'me in a DM'
      await ctx
        .reply(
          `🔒 Your account info is private — please ask ${dmHandle} in a Direct Message and I'll show you right away.`,
          { reply_parameters: { message_id: ctx.message!.message_id } },
        )
        .catch(() => {})
      console.log(
        `[NLIntent] BLOCKED in group chat=${chatId} user=${userId} intent=${intent}`,
      )
      return true
    }
    try {
      await runIntent(ctx, intent)
      console.log(
        `[NLIntent] chat=${chatId} user=${userId} intent=${intent} q=${text.slice(0, 60)}`,
      )
      return true
    } catch (err: any) {
      console.error(`[NLIntent] ${intent} failed:`, err?.message ?? err)
      // Fall through to LLM as a graceful backup.
    }
  }

  const rl = checkRateLimit(userId)
  if (!rl.ok) {
    const msg =
      rl.reason === 'user'
        ? `Easy there — you've hit your hourly question limit. Try again in a bit, or use /help for commands.`
        : `I'm taking a short break — too many questions today. Try again later, or use /help in the meantime.`
    await ctx.reply(msg).catch(() => {})
    return true
  }

  await ctx.replyWithChatAction('typing').catch(() => {})

  try {
    const history = chatHistory.get(chatId) ?? []
    const messages = [...history, { role: 'user' as const, content: text }]

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages,
    })

    const reply =
      response.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('\n')
        .trim() || `🤔 (no response, try rephrasing)`

    pushTurn(chatId, 'user', text)
    pushTurn(chatId, 'assistant', reply)

    await ctx.reply(reply, {
      reply_parameters: { message_id: ctx.message!.message_id },
    })
    console.log(`[LLM] chat=${chatId} user=${userId} q=${text.slice(0, 60)}`)
    return true
  } catch (err: any) {
    console.error('[LLM] error:', err?.message ?? err)
    await ctx
      .reply(`⚠️ I couldn't answer that right now. Try /help for commands.`)
      .catch(() => {})
    return true
  }
}

export function registerLlm(bot: Bot) {
  bot.on('message:text', async (ctx, next) => {
    const handled = await handleLlmMessage(ctx)
    if (!handled) await next()
  })
}
