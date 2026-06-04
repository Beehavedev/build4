// Build4 Pay Agent — demo data seeding.
// Idempotent per user: if the user already has bills we do nothing. Creates a
// default agent, two payment methods, a spread of bills (incl. a duplicate
// streaming pair, a price increase, an unused subscription and an overdue
// bill), some payment history, and derived recommendations — enough to make
// every tab feel alive on first open.
import * as store from '../payagent/storage'
import { generateRecommendations } from './services/insights'
import type { Bill } from './types'

function addDays(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
function daysAgoISO(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString()
}

export async function ensureDefaultAgent(userId: string) {
  const agents = await store.listAgents(userId)
  if (agents.length) return agents[0]
  return store.createAgent(userId, {
    name: 'Penny',
    avatar: '💸',
    personality: 'Sharp, protective, and allergic to wasted money.',
    role: 'Bills & Subscriptions Agent',
  })
}

export interface SeedResult {
  seeded: boolean
  bills: number
  recommendations: number
}

export async function seedDemoData(userId: string): Promise<SeedResult> {
  const existing = await store.listBills(userId)
  if (existing.length) return { seeded: false, bills: existing.length, recommendations: 0 }

  const agent = await ensureDefaultAgent(userId)

  const methods = await store.listMethods(userId)
  let walletMethodId: string
  if (!methods.length) {
    const wallet = await store.createMethod(userId, {
      type: 'build4',
      provider: 'mock',
      label: 'Build4 Wallet (simulated)',
    })
    await store.createMethod(userId, {
      type: 'card',
      provider: 'mock',
      label: 'Visa •••• 4242 (simulated)',
      last4: '4242',
    })
    walletMethodId = wallet.id
  } else {
    walletMethodId = methods[0].id
  }

  const defs: Array<{
    name: string
    category: string
    amount: number
    frequency: 'weekly' | 'monthly' | 'yearly'
    due: number
    autoPay?: boolean
    approval?: boolean
    trusted?: boolean
    maxAuto?: number
    lastAmount?: number
    lastUsedDaysAgo?: number
    status?: string
  }> = [
    { name: 'Netflix', category: 'Streaming', amount: 15.49, frequency: 'monthly', due: 3, approval: true },
    { name: 'Disney+', category: 'Streaming', amount: 13.99, frequency: 'monthly', due: 9, approval: false },
    {
      name: 'Spotify',
      category: 'Music',
      amount: 11.99,
      frequency: 'monthly',
      due: 5,
      autoPay: true,
      trusted: true,
      maxAuto: 25,
      lastAmount: 9.99, // 20% increase → triggers an "increase" recommendation
    },
    {
      name: 'Cloud Backup',
      category: 'Cloud',
      amount: 9.99,
      frequency: 'monthly',
      due: 20,
      approval: false,
      lastUsedDaysAgo: 60, // unused → recommendation
    },
    { name: 'Electric Utility', category: 'Utilities', amount: 92.4, frequency: 'monthly', due: 2, approval: true },
    { name: 'Rent', category: 'Housing', amount: 1800, frequency: 'monthly', due: 14, approval: true },
    { name: 'Phone Plan', category: 'Telecom', amount: 45, frequency: 'monthly', due: -1, approval: true, status: 'overdue' },
  ]

  let count = 0
  let firstBill: Bill | null = null
  for (const d of defs) {
    const bill = await store.createBill(userId, {
      name: d.name,
      category: d.category,
      amount: d.amount,
      frequency: d.frequency,
      dueDate: addDays(d.due),
      agentId: agent.id,
      paymentMethodId: walletMethodId,
      autoPayEnabled: !!d.autoPay,
      approvalRequired: d.approval ?? !d.autoPay,
      trusted: !!d.trusted,
      maxAutoPayAmount: d.maxAuto ?? null,
      status: d.status ?? 'active',
    })
    if (!firstBill) firstBill = bill
    const patch: Record<string, any> = {}
    if (d.lastAmount != null) patch.lastAmount = d.lastAmount
    if (d.lastUsedDaysAgo != null) patch.lastUsedAt = daysAgoISO(d.lastUsedDaysAgo)
    if (Object.keys(patch).length) await store.updateBill(userId, bill.id, patch)
    count++
  }

  // A little payment history so the Payments tab isn't empty.
  if (firstBill) {
    await store.createPaymentRow(userId, {
      billId: firstBill.id,
      amount: firstBill.amount,
      currency: firstBill.currency,
      status: 'succeeded',
      provider: 'mock',
      approvedByUser: true,
      mode: 'approval',
      paidAt: daysAgoISO(30),
    })
  }

  const bills = await store.listBills(userId)
  const recs = await generateRecommendations(userId, agent.id, bills)
  return { seeded: true, bills: count, recommendations: recs.length }
}
