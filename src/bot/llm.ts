import Anthropic from '@anthropic-ai/sdk'
import { Bot, Context } from 'grammy'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const MODEL = 'claude-3-5-haiku-latest'
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
