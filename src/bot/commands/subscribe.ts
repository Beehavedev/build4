import { Bot, InlineKeyboard } from 'grammy'
import { db } from '../../db'
import {
  getSubscriptionStatus,
  ensureTrial,
  recordPayment,
  generateIntentAmount,
  PRICE_USD,
  PERIOD_DAYS,
  TRIAL_DAYS,
} from '../../services/subscriptions'
import { verifySubscriptionPayment, treasuryFor, type PaymentChain } from '../../services/subscriptionPayment'

/**
 * /subscribe — user-facing subscription UI.
 *
 *   1. Shows current status (trialing / active / expired) + days left.
 *   2. Offers chain picker (BSC USDT or Base USDC).
 *   3. Shows treasury address + exact amount.
 *   4. "I've Paid" → prompts for tx hash → verifies on-chain → extends expiry.
 *
 * Session state is kept lightweight via the `awaiting_payment_*` text reply
 * pattern that other commands in this codebase use. Users tap the "I've Paid"
 * button on a specific chain, the bot remembers which chain, and the next
 * plain-text message is treated as the txhash.
 */

type AwaitingPayment = {
  userId: string
  chain: PaymentChain
  askedAt: number
  // Uniquified expected amount in the chain's smallest unit. The
  // verifier requires EXACT match against this — see
  // subscriptions.generateIntentAmount for the security rationale.
  expectedAmountSmallest: bigint
  expectedAmountHuman: string
}
const awaitingPayments = new Map<number, AwaitingPayment>()

// Stale askedAt cleanup — drop entries older than 30 minutes so a user
// who taps "I've Paid" then walks away doesn't have a random later text
// message accidentally interpreted as a txhash.
const PAYMENT_PROMPT_TTL_MS = 30 * 60 * 1000

function isPromptFresh(entry: AwaitingPayment | undefined): entry is AwaitingPayment {
  if (!entry) return false
  return Date.now() - entry.askedAt < PAYMENT_PROMPT_TTL_MS
}

function statusBlock(view: Awaited<ReturnType<typeof getSubscriptionStatus>>): string {
  if (view.status === 'active') {
    return `✅ *Status:* Active (Pro)\n📅 Renews/expires: in ${view.daysRemaining} day(s) — ${view.expiresAt?.toISOString().slice(0, 10)}`
  }
  if (view.status === 'trialing') {
    return `🆓 *Status:* Free Trial\n📅 Trial ends in ${view.daysRemaining} day(s) — ${view.expiresAt?.toISOString().slice(0, 10)}`
  }
  if (view.status === 'expired') {
    return `⚠️ *Status:* Expired on ${view.expiresAt?.toISOString().slice(0, 10)}\nAgents are paused until you renew.`
  }
  return `🆕 *Status:* Trial not yet started (${TRIAL_DAYS}-day free trial available)`
}

function pickerKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(`💵 Pay $${PRICE_USD} USDT (BNB Chain)`, 'sub_chain_bsc')
    .row()
    .text(`💵 Pay $${PRICE_USD} USDC (Base)`, 'sub_chain_base')
    .row()
    .text('📊 Check my status', 'sub_status')
}

async function renderMain(ctx: any) {
  const user = (ctx as any).dbUser
  if (!user) return
  // Grant trial on first /subscribe touch if the user has never been initialised.
  await ensureTrial(user.id).catch(() => null)
  const view = await getSubscriptionStatus(user.id)

  await ctx.reply(
    `💎 *BUILD4 Subscription*\n\n` +
      `${statusBlock(view)}\n\n` +
      `*Plan:* Pro — $${PRICE_USD}/month\n` +
      `• Unlimited AI trading agents\n` +
      `• All venues (Aster, Hyperliquid, 42.space, Topaz)\n` +
      `• Multi-LLM swarm decisions\n` +
      `• Smart-money signals + scanners\n\n` +
      (view.enforced
        ? ''
        : '_Note: enforcement is currently off — all users have full access regardless of subscription state. You can still pay early to lock in your renewal date._\n\n') +
      `Choose payment method:`,
    { parse_mode: 'Markdown', reply_markup: pickerKeyboard() },
  )
}

async function renderChainPrompt(ctx: any, chain: PaymentChain) {
  const user = (ctx as any).dbUser
  if (!user) return
  const t = treasuryFor(chain)
  if (!t.ok) {
    await ctx.reply(`⚠️ Payment temporarily unavailable: ${t.reason}\nPlease try the other chain or contact support.`)
    return
  }

  const asset = chain === 'bsc' ? 'USDT (BEP-20)' : 'USDC'
  const network = chain === 'bsc' ? 'BNB Smart Chain' : 'Base'

  // Generate a uniquified intent amount so an attacker observing the
  // treasury on-chain can't redeem another user's tx (see
  // subscriptions.generateIntentAmount for the threat model).
  const intent = generateIntentAmount(chain)
  // Trim trailing zeros so we don't show "19.997432000000000000" for
  // BSC's 18-decimal token. Number(...) → String drops trailing zeros.
  const humanAmount = String(intent.amountUsd)

  awaitingPayments.set(Number(user.telegramId), {
    userId: user.id,
    chain,
    askedAt: Date.now(),
    expectedAmountSmallest: intent.amountSmallest,
    expectedAmountHuman: humanAmount,
  })

  await ctx.reply(
    `💸 *Pay ${humanAmount} ${asset} on ${network}*\n\n` +
      `*Send to:* \`${t.address}\`\n` +
      `*Amount:* exactly \`${humanAmount}\` ${asset.split(' ')[0]}\n` +
      `*Network:* ${network}\n\n` +
      `⚠️ *Important:*\n` +
      `• Send the *EXACT* amount above (the trailing digits matter — they're your unique payment ID).\n` +
      `• Use the *EXACT* network. Other networks (Ethereum, Polygon, Tron, etc.) won't be detected.\n` +
      `• A round-number payment like ${PRICE_USD} will be rejected.\n\n` +
      `Once your transaction is confirmed on-chain, reply to this message with your *transaction hash* (the 0x… string from your wallet or block explorer).`,
    { parse_mode: 'Markdown' },
  )
}

/**
 * Handle a plain-text reply that may be a transaction hash for a
 * pending payment prompt. Returns true if it consumed the message.
 * Wired from src/bot/index.ts message:text handler — must run before
 * the LLM fallback.
 */
export async function handlePaymentTxReply(ctx: any): Promise<boolean> {
  const user = (ctx as any).dbUser
  if (!user) return false
  const tgId = Number(user.telegramId)
  const pending = awaitingPayments.get(tgId)
  if (!isPromptFresh(pending)) {
    if (pending) awaitingPayments.delete(tgId)
    return false
  }

  const text = String(ctx.message?.text ?? '').trim()
  // Only consume the message if it actually looks like a txhash. Lets
  // the user keep chatting with the LLM without losing the prompt.
  if (!/^0x[0-9a-fA-F]{64}$/.test(text)) return false

  // Optimistic clear — even on failure we drop the pending entry so a
  // typo doesn't lock the user out of other commands. They can /subscribe
  // again to retry.
  awaitingPayments.delete(tgId)

  await ctx.reply('🔍 Verifying your payment on-chain… this takes a few seconds.')

  try {
    const verify = await verifySubscriptionPayment({
      chain: pending.chain,
      txHash: text,
      expectedAmountSmallest: pending.expectedAmountSmallest,
    })
    if (!verify.ok || !verify.payer || !verify.asset || verify.amountUsd === undefined) {
      await ctx.reply(
        `❌ Payment verification failed: ${verify.reason}\n\nTry /subscribe again, or contact support if you believe this is an error.`,
      )
      return true
    }

    const result = await recordPayment({
      userId: user.id,
      chain: pending.chain,
      asset: verify.asset,
      amountUsd: verify.amountUsd,
      txHash: text,
      payer: verify.payer,
    })
    if (!result.ok) {
      const msg =
        result.reason === 'already_consumed'
          ? 'This transaction hash has already been used to extend a subscription. Each payment can only be redeemed once.'
          : result.reason === 'user_not_found'
            ? 'Could not match your Telegram account — please contact support.'
            : `Database error: ${result.error ?? 'unknown'}`
      await ctx.reply(`⚠️ ${msg}`)
      return true
    }

    await ctx.reply(
      `✅ *Payment confirmed!*\n\n` +
        `+${result.periodDays} days added to your subscription.\n` +
        `📅 New expiry: ${result.newExpiry.toISOString().slice(0, 10)}\n\n` +
        `Welcome to BUILD4 Pro 💎`,
      { parse_mode: 'Markdown' },
    )
    return true
  } catch (err: any) {
    console.error('[subscribe] payment handler error:', err?.message ?? err)
    await ctx.reply(`⚠️ Unexpected error verifying payment. Please try /subscribe again or contact support.`)
    return true
  }
}

export function registerSubscribe(bot: Bot) {
  bot.command('subscribe', renderMain)
  bot.command('billing', renderMain)

  bot.callbackQuery('sub_chain_bsc', async (ctx) => {
    await ctx.answerCallbackQuery()
    await renderChainPrompt(ctx, 'bsc')
  })

  bot.callbackQuery('sub_chain_base', async (ctx) => {
    await ctx.answerCallbackQuery()
    await renderChainPrompt(ctx, 'base')
  })

  bot.callbackQuery('sub_status', async (ctx) => {
    await ctx.answerCallbackQuery()
    const user = (ctx as any).dbUser
    if (!user) return
    const view = await getSubscriptionStatus(user.id)
    await ctx.reply(statusBlock(view), { parse_mode: 'Markdown' })
  })
}
