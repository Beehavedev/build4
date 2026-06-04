// Build4 Pay Agent — agent brain.
// A deterministic intent router maps the user's message to internal functions
// (the same storage/insights primitives the UI uses), computes a factual
// answer, then OPTIONALLY asks the LLM to rephrase it conversationally. If the
// LLM is unavailable (circuit-broken, no key), we return the deterministic
// text — the agent never invents numbers.
import { callLLM, FALLBACK_PROVIDER } from '../../services/inference'
import * as store from '../storage'
import * as engine from './billEngine'
import {
  buildInsights,
  calculateMonthlySpend,
  detectDuplicateSubscriptions,
  detectUnused,
  monthlyEquivalent,
} from './insights'
import type { Bill, PayAgent } from '../types'

export type Intent =
  | 'greeting'
  | 'upcoming'
  | 'overdue'
  | 'monthly_spend'
  | 'list_bills'
  | 'savings'
  | 'pay_bill'
  | 'enable_autopay'
  | 'disable_autopay'
  | 'bill_detail'
  | 'help'
  | 'fallback'

export interface ChatResult {
  reply: string
  intent: Intent
  data?: unknown
}

const money = (n: number, ccy = 'USD') =>
  `${ccy === 'USD' ? '$' : ''}${n.toFixed(2)}${ccy === 'USD' ? '' : ' ' + ccy}`

function classify(msg: string): Intent {
  const m = msg.toLowerCase()
  if (/\b(hi|hey|hello|gm|yo)\b/.test(m) && m.length < 16) return 'greeting'
  if (/\b(help|what can you do|commands)\b/.test(m)) return 'help'
  if (/\b(overdue|late|missed|past due)\b/.test(m)) return 'overdue'
  if (/\b(due|upcoming|this week|next|soon|coming up)\b/.test(m)) return 'upcoming'
  if (/\b(turn on|enable|activate)\b.*\bauto.?pay\b/.test(m) || /\bauto.?pay\b.*\bon\b/.test(m))
    return 'enable_autopay'
  if (/\b(turn off|disable|stop)\b.*\bauto.?pay\b/.test(m) || /\bauto.?pay\b.*\boff\b/.test(m))
    return 'disable_autopay'
  if (/\bpay\b/.test(m)) return 'pay_bill'
  if (/\b(save|saving|cancel|unused|duplicate|cut|reduce|cheaper)\b/.test(m)) return 'savings'
  if (/\b(how much|spend|spending|cost|total|monthly|per month|subscriptions?)\b/.test(m))
    return 'monthly_spend'
  if (/\b(list|show|all|my bills|what bills)\b/.test(m)) return 'list_bills'
  if (/\b(when|how much is|detail|info about)\b/.test(m)) return 'bill_detail'
  return 'fallback'
}

// Fuzzy match a bill by any word in the message appearing in the bill name.
function matchBill(msg: string, bills: Bill[]): Bill | null {
  const m = msg.toLowerCase()
  const byName = bills.find((b) => m.includes(b.name.toLowerCase()))
  if (byName) return byName
  let best: { bill: Bill; score: number } | null = null
  for (const b of bills) {
    const words = b.name.toLowerCase().split(/\s+/)
    const score = words.filter((w) => w.length > 2 && m.includes(w)).length
    if (score > 0 && (!best || score > best.score)) best = { bill: b, score }
  }
  return best?.bill ?? null
}

async function tryPhrase(system: string, facts: string): Promise<string | null> {
  try {
    const res = await callLLM({
      provider: FALLBACK_PROVIDER,
      system,
      user: facts,
      maxTokens: 220,
      temperature: 0.4,
      timeoutMs: 9000,
    })
    const t = (res.text || '').trim()
    return t.length > 0 ? t : null
  } catch {
    return null
  }
}

const SYSTEM_PROMPT = `You are a Build4 Pay Agent — a sharp, friendly AI that helps a user manage bills and subscriptions.
Rewrite the FACTS below into a short, natural reply (max 4 sentences, no markdown, no bullet symbols).
Never invent numbers, bills, or dates that are not in the FACTS. This is a simulation that handles NO real money.`

async function phraseOrFallback(deterministic: string): Promise<string> {
  const phrased = await tryPhrase(SYSTEM_PROMPT, `FACTS:\n${deterministic}`)
  return phrased ?? deterministic
}

export interface ChatContext {
  userId: string
  agent: PayAgent | null
}

export async function handleChat(ctx: ChatContext, message: string): Promise<ChatResult> {
  const { userId } = ctx
  const agentId = ctx.agent?.id ?? null
  const intent = classify(message)
  const bills = await store.listBills(userId)
  let deterministic = ''
  let data: unknown = undefined

  switch (intent) {
    case 'greeting':
    case 'help': {
      deterministic =
        `I'm your Pay Agent. I track your bills and subscriptions and can tell you what's due, ` +
        `what you spend, where you can save, and pay bills for you (in this simulation — no real money moves). ` +
        `Try: "what's due this week", "how much do I spend on subscriptions", or "pay my Netflix bill".`
      break
    }
    case 'overdue': {
      const overdue = bills.filter((b) => b.status === 'overdue')
      data = overdue
      deterministic = overdue.length
        ? `You have ${overdue.length} overdue bill${overdue.length === 1 ? '' : 's'}: ` +
          overdue.map((b) => `${b.name} (${money(b.amount, b.currency)}, was due ${b.nextDueDate})`).join('; ') + '.'
        : `Nothing overdue — you're all caught up.`
      break
    }
    case 'upcoming': {
      const soon = bills
        .filter((b) => (b.status === 'active' || b.status === 'overdue') && engine.daysUntil(b.nextDueDate) <= 7)
        .sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate))
      data = soon
      deterministic = soon.length
        ? `Coming up in the next 7 days: ` +
          soon
            .map((b) => {
              const d = engine.daysUntil(b.nextDueDate)
              const when = d < 0 ? `overdue` : d === 0 ? 'today' : `in ${d} day${d === 1 ? '' : 's'}`
              return `${b.name} ${money(b.amount, b.currency)} (${when})`
            })
            .join('; ') + '.'
        : `No bills due in the next 7 days.`
      break
    }
    case 'monthly_spend': {
      const wantsSubs = /subscriptions?/.test(message.toLowerCase())
      const insights = buildInsights(bills)
      data = insights
      if (wantsSubs) {
        const subCats = insights.byCategory.filter((c) =>
          ['streaming', 'music', 'entertainment', 'software', 'saas', 'cloud', 'news', 'gaming'].includes(
            c.category.toLowerCase(),
          ),
        )
        const subTotal = subCats.reduce((s, c) => s + c.monthly, 0)
        deterministic =
          `You spend about ${money(subTotal)} a month on subscriptions` +
          (subCats.length ? ` (${subCats.map((c) => `${c.category} ${money(c.monthly)}`).join(', ')})` : '') +
          `. Across all bills that's ${money(insights.monthlyTotal)}/mo (${money(insights.yearlyTotal)}/yr).`
      } else {
        const top = insights.byCategory.slice(0, 3)
        deterministic =
          `Your bills total about ${money(insights.monthlyTotal)} a month (${money(insights.yearlyTotal)} a year)` +
          (top.length ? `. Biggest categories: ${top.map((c) => `${c.category} ${money(c.monthly)}`).join(', ')}` : '') +
          '.'
      }
      break
    }
    case 'list_bills': {
      const active = bills.filter((b) => b.status !== 'cancelled')
      data = active
      deterministic = active.length
        ? `You have ${active.length} bill${active.length === 1 ? '' : 's'}: ` +
          active
            .map((b) => `${b.name} ${money(b.amount, b.currency)}/${b.frequency} (next ${b.nextDueDate})`)
            .join('; ') + '.'
        : `You don't have any bills yet. Add one from the Bills tab and I'll start tracking it.`
      break
    }
    case 'savings': {
      const dups = detectDuplicateSubscriptions(bills)
      const unused = detectUnused(bills)
      const insights = buildInsights(bills)
      data = { dups, unused, potentialMonthlySavings: insights.potentialMonthlySavings }
      const parts: string[] = []
      if (dups.length)
        parts.push(
          `you have overlapping ${dups.map((d) => d.category).join(' & ')} subscriptions`,
        )
      if (unused.length) parts.push(`${unused.map((b) => b.name).join(', ')} look unused`)
      deterministic = parts.length
        ? `A few ways to save: ${parts.join('; ')}. Trimming these could save around ${money(insights.potentialMonthlySavings)}/mo. Want me to draft cancellations?`
        : `I don't see obvious waste right now — no duplicate or unused subscriptions detected. Nice and lean.`
      break
    }
    case 'enable_autopay':
    case 'disable_autopay': {
      const bill = matchBill(message, bills)
      if (!bill) {
        deterministic = `Which bill? Tell me the name, e.g. "turn ${intent === 'enable_autopay' ? 'on' : 'off'} auto-pay for Netflix".`
        break
      }
      const enable = intent === 'enable_autopay'
      await store.updateBill(userId, bill.id, { autoPayEnabled: enable })
      await store.logAction(userId, {
        agentId,
        billId: bill.id,
        actionType: enable ? 'autopay_enabled' : 'autopay_disabled',
        reasoning: 'Requested via chat.',
      })
      data = { billId: bill.id, autoPayEnabled: enable }
      deterministic = enable
        ? `Auto-pay is now ON for ${bill.name}. I'll still ask before the first payment or if the amount jumps unexpectedly.`
        : `Auto-pay is now OFF for ${bill.name}. I'll ask you before any future payment.`
      break
    }
    case 'pay_bill': {
      const bill = matchBill(message, bills)
      if (!bill) {
        deterministic = `Which bill should I pay? For example: "pay my Netflix bill".`
        break
      }
      const payment = await engine.prepareApproval(
        userId,
        bill,
        'approval',
        `Requested via chat: pay ${bill.name}.`,
      )
      data = { payment }
      deterministic = `I've prepared a payment of ${money(bill.amount, bill.currency)} for ${bill.name}. It's waiting for your approval in the Payments tab — nothing moves until you confirm (and this is a simulation, so no real funds).`
      break
    }
    case 'bill_detail': {
      const bill = matchBill(message, bills)
      data = bill
      deterministic = bill
        ? `${bill.name}: ${money(bill.amount, bill.currency)} ${bill.frequency}, next due ${bill.nextDueDate}, ` +
          `auto-pay ${bill.autoPayEnabled ? 'on' : 'off'}, status ${bill.status}.`
        : `I couldn't find that bill. Try "list my bills" to see what I'm tracking.`
      break
    }
    default: {
      const insights = buildInsights(bills)
      deterministic =
        `I track bills and subscriptions. Right now you have ${insights.activeBillCount} active bills ` +
        `at ${money(insights.monthlyTotal)}/mo. Ask me what's due, what you spend, or where you can save.`
    }
  }

  const reply = await phraseOrFallback(deterministic)
  await store.logAction(userId, {
    agentId,
    actionType: 'chat',
    actionStatus: intent,
    reasoning: message.slice(0, 500),
  })
  return { reply, intent, data }
}
