// Build4 Pay Agent — insights & recommendation generation.
// Pure analysis over a user's bills/payments plus persistence of the
// resulting recommendations (de-duplicated against existing open ones).
import * as store from '../storage'
import type { Bill, Recommendation } from '../types'

// Normalize any bill to its monthly-equivalent cost.
export function monthlyEquivalent(bill: Pick<Bill, 'amount' | 'frequency'>): number {
  if (bill.frequency === 'weekly') return (bill.amount * 52) / 12
  if (bill.frequency === 'yearly') return bill.amount / 12
  return bill.amount
}

const round2 = (n: number) => Math.round(n * 100) / 100

function activeBills(bills: Bill[]): Bill[] {
  return bills.filter((b) => b.status === 'active' || b.status === 'overdue')
}

export function calculateMonthlySpend(bills: Bill[], category?: string): number {
  return round2(
    activeBills(bills)
      .filter((b) => !category || b.category.toLowerCase() === category.toLowerCase())
      .reduce((s, b) => s + monthlyEquivalent(b), 0),
  )
}

export function calculateYearlySpend(bills: Bill[], category?: string): number {
  return round2(calculateMonthlySpend(bills, category) * 12)
}

export interface CategoryBreakdown {
  category: string
  monthly: number
  count: number
}
export function spendByCategory(bills: Bill[]): CategoryBreakdown[] {
  const map = new Map<string, { monthly: number; count: number }>()
  for (const b of activeBills(bills)) {
    const cur = map.get(b.category) ?? { monthly: 0, count: 0 }
    cur.monthly += monthlyEquivalent(b)
    cur.count++
    map.set(b.category, cur)
  }
  return [...map.entries()]
    .map(([category, v]) => ({ category, monthly: round2(v.monthly), count: v.count }))
    .sort((a, b) => b.monthly - a.monthly)
}

// Duplicate subscriptions: more than one active bill sharing a "subscription-ish"
// category, or near-identical names.
const SUBSCRIPTION_CATEGORIES = new Set([
  'streaming',
  'music',
  'entertainment',
  'software',
  'saas',
  'cloud',
  'news',
  'gaming',
])
export interface DuplicateGroup {
  category: string
  bills: Bill[]
  monthlyTotal: number
}
export function detectDuplicateSubscriptions(bills: Bill[]): DuplicateGroup[] {
  const groups = new Map<string, Bill[]>()
  for (const b of activeBills(bills)) {
    if (!SUBSCRIPTION_CATEGORIES.has(b.category.toLowerCase())) continue
    const arr = groups.get(b.category) ?? []
    arr.push(b)
    groups.set(b.category, arr)
  }
  return [...groups.entries()]
    .filter(([, arr]) => arr.length > 1)
    .map(([category, arr]) => ({
      category,
      bills: arr,
      monthlyTotal: round2(arr.reduce((s, b) => s + monthlyEquivalent(b), 0)),
    }))
}

export interface IncreaseFlag {
  bill: Bill
  from: number
  to: number
  pct: number
}
export function detectBillIncreases(bills: Bill[], thresholdPct = 10): IncreaseFlag[] {
  const out: IncreaseFlag[] = []
  for (const b of bills) {
    if (b.lastAmount != null && b.lastAmount > 0 && b.amount > b.lastAmount) {
      const pct = Math.round(((b.amount - b.lastAmount) / b.lastAmount) * 100)
      if (pct >= thresholdPct) out.push({ bill: b, from: b.lastAmount, to: b.amount, pct })
    }
  }
  return out
}

const UNUSED_AFTER_DAYS = 45
export function detectUnused(bills: Bill[]): Bill[] {
  const now = Date.now()
  return activeBills(bills).filter((b) => {
    if (!SUBSCRIPTION_CATEGORIES.has(b.category.toLowerCase())) return false
    if (!b.lastUsedAt) {
      // No usage recorded and the bill has existed a while.
      return now - new Date(b.createdAt).getTime() > UNUSED_AFTER_DAYS * 86_400_000
    }
    return now - new Date(b.lastUsedAt).getTime() > UNUSED_AFTER_DAYS * 86_400_000
  })
}

export interface InsightsSummary {
  monthlyTotal: number
  yearlyTotal: number
  byCategory: CategoryBreakdown[]
  activeBillCount: number
  upcomingCount: number
  overdueCount: number
  duplicates: DuplicateGroup[]
  increases: IncreaseFlag[]
  unused: Bill[]
  potentialMonthlySavings: number
}
export function buildInsights(bills: Bill[]): InsightsSummary {
  const active = activeBills(bills)
  const today = new Date().toISOString().slice(0, 10)
  const duplicates = detectDuplicateSubscriptions(bills)
  const increases = detectBillIncreases(bills)
  const unused = detectUnused(bills)
  // Rough savings estimate: drop the cheaper duplicate in each group + all unused.
  const dupSavings = duplicates.reduce((s, g) => {
    const sorted = [...g.bills].sort((a, b) => monthlyEquivalent(a) - monthlyEquivalent(b))
    return s + monthlyEquivalent(sorted[0])
  }, 0)
  const unusedSavings = unused.reduce((s, b) => s + monthlyEquivalent(b), 0)
  return {
    monthlyTotal: calculateMonthlySpend(bills),
    yearlyTotal: calculateYearlySpend(bills),
    byCategory: spendByCategory(bills),
    activeBillCount: active.length,
    upcomingCount: active.filter((b) => b.nextDueDate >= today).length,
    overdueCount: bills.filter((b) => b.status === 'overdue').length,
    duplicates,
    increases,
    unused,
    potentialMonthlySavings: round2(dupSavings + unusedSavings),
  }
}

// Persist recommendations derived from the current bill set. De-dupes against
// open recs so repeated runs (e.g. daily cron) don't pile up.
export async function generateRecommendations(
  userId: string,
  agentId: string | null,
  bills: Bill[],
): Promise<Recommendation[]> {
  const created: Recommendation[] = []
  const insights = buildInsights(bills)

  for (const g of insights.duplicates) {
    const names = g.bills.map((b) => b.name).join(', ')
    const title = `Possible duplicate ${g.category} subscriptions`
    if (await store.hasOpenRecommendation(userId, 'duplicate', title)) continue
    created.push(
      await store.createRecommendation(userId, {
        agentId,
        type: 'duplicate',
        title,
        description: `You have ${g.bills.length} active ${g.category} subscriptions (${names}) totalling ${g.monthlyTotal}/mo. Consider keeping just one.`,
        potentialSaving: round2(g.monthlyTotal - Math.min(...g.bills.map(monthlyEquivalent))),
      }),
    )
  }

  for (const inc of insights.increases) {
    const title = `${inc.bill.name} went up ${inc.pct}%`
    if (await store.hasOpenRecommendation(userId, 'increase', title)) continue
    created.push(
      await store.createRecommendation(userId, {
        agentId,
        type: 'increase',
        title,
        description: `${inc.bill.name} rose from ${inc.from} to ${inc.to} (${inc.pct}%). Review whether it's still worth it.`,
        potentialSaving: round2(monthlyEquivalent({ amount: inc.to - inc.from, frequency: inc.bill.frequency })),
      }),
    )
  }

  for (const b of insights.unused) {
    const title = `${b.name} looks unused`
    if (await store.hasOpenRecommendation(userId, 'unused', title)) continue
    created.push(
      await store.createRecommendation(userId, {
        agentId,
        type: 'unused',
        title,
        description: `No recent activity on ${b.name} (${b.amount} ${b.currency}/${b.frequency}). Cancelling could save ${round2(monthlyEquivalent(b))}/mo.`,
        potentialSaving: round2(monthlyEquivalent(b)),
      }),
    )
  }

  return created
}
