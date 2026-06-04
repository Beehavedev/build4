// Build4 Pay Agent — HTTP API. Mounted under /api/pay/* by server.ts via
// registerPayAgentRoutes(app). Auth reuses the mini-app's Telegram middleware
// (requireTgUser); every request is resolved to a Pay Agent user keyed by
// telegram_id in the isolated `payagent` schema.
import type { Express, Request, Response } from 'express'
import { z } from 'zod'
import { requireTgUser } from '../services/telegramAuth'
import { ensurePayAgentSchema } from './db'
import { getPaymentProvider } from './payments/provider'
import * as store from './storage'
import * as engine from './services/billEngine'
import { buildInsights, generateRecommendations } from './services/insights'
import { handleChat } from './services/brain'
import { ensureDefaultAgent, seedDemoData } from './seed'

export const PAY_DISCLAIMER =
  'Build4 Pay Agent is a SIMULATION for demonstration. No real money moves, no real bills are paid, ' +
  'and no real payment credentials are stored. All balances and payments are mock data.'

const ymd = /^\d{4}-\d{2}-\d{2}$/

const billCreateSchema = z.object({
  name: z.string().min(1).max(120),
  category: z.string().min(1).max(60).optional(),
  amount: z.number().positive().max(1_000_000),
  currency: z.string().min(2).max(8).optional(),
  frequency: z.enum(['weekly', 'monthly', 'yearly']).optional(),
  dueDate: z.string().regex(ymd, 'dueDate must be YYYY-MM-DD'),
  paymentMethodId: z.string().uuid().nullable().optional(),
  agentId: z.string().uuid().nullable().optional(),
  autoPayEnabled: z.boolean().optional(),
  approvalRequired: z.boolean().optional(),
  maxAutoPayAmount: z.number().positive().nullable().optional(),
  trusted: z.boolean().optional(),
  notes: z.string().max(500).nullable().optional(),
})

const billUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  category: z.string().min(1).max(60).optional(),
  amount: z.number().positive().max(1_000_000).optional(),
  currency: z.string().min(2).max(8).optional(),
  frequency: z.enum(['weekly', 'monthly', 'yearly']).optional(),
  dueDate: z.string().regex(ymd).optional(),
  nextDueDate: z.string().regex(ymd).optional(),
  paymentMethodId: z.string().uuid().nullable().optional(),
  status: z.enum(['active', 'paused', 'cancelled', 'overdue', 'paid']).optional(),
  autoPayEnabled: z.boolean().optional(),
  approvalRequired: z.boolean().optional(),
  maxAutoPayAmount: z.number().positive().nullable().optional(),
  trusted: z.boolean().optional(),
  notes: z.string().max(500).nullable().optional(),
})

const agentCreateSchema = z.object({
  name: z.string().min(1).max(60),
  avatar: z.string().max(16).optional(),
  personality: z.string().max(300).optional(),
  role: z.string().max(80).optional(),
})

const methodCreateSchema = z.object({
  type: z.enum(['card', 'bank', 'crypto', 'stablecoin', 'build4']),
  label: z.string().min(1).max(80),
  last4: z.string().max(8).nullable().optional(),
  provider: z.string().max(40).optional(),
})

const chatSchema = z.object({
  message: z.string().min(1).max(2000),
  agentId: z.string().uuid().optional(),
})

type Handler = (req: Request, res: Response, userId: string) => Promise<void>

// Resolve (or create) the Pay Agent user for the authed Telegram account, then
// run the handler. Centralizes error handling so routes stay thin.
function h(fn: Handler) {
  return async (req: Request, res: Response) => {
    try {
      const u = (req as any).user
      const telegramId = String(u.telegramId)
      const name = u.username ?? u.firstName ?? null
      const payUser = await store.getOrCreatePayUser(telegramId, name)
      await fn(req, res, payUser.id)
    } catch (e: any) {
      console.error('[payagent] route error:', e?.message ?? e)
      if (!res.headersSent) {
        res.status(typeof e?.status === 'number' ? e.status : 500).json({
          error: e?.message ?? 'Pay Agent error',
        })
      }
    }
  }
}

function badRequest(res: Response, parsed: z.SafeParseError<any>) {
  res.status(400).json({ error: parsed.error.errors.map((e) => e.message).join('; ') })
}

// Reject cross-user FK injection: a bill may only reference an agent or payment
// method that belongs to the authenticated user. Returns an error string when a
// supplied id is foreign/unknown, otherwise null.
async function assertRefsOwned(
  userId: string,
  agentId?: string | null,
  paymentMethodId?: string | null,
): Promise<string | null> {
  if (agentId) {
    const agent = await store.getAgent(userId, agentId)
    if (!agent) return 'Unknown agent.'
  }
  if (paymentMethodId) {
    const owned = (await store.listMethods(userId)).some((m) => m.id === paymentMethodId)
    if (!owned) return 'Unknown payment method.'
  }
  return null
}

export function registerPayAgentRoutes(app: Express): void {
  const r = '/api/pay'

  // ---- system ----
  app.get(`${r}/me`, requireTgUser, h(async (req, res, userId) => {
    const agent = await ensureDefaultAgent(userId)
    const agents = await store.listAgents(userId)
    res.json({ userId, agent, agents, disclaimer: PAY_DISCLAIMER })
  }))

  app.post(`${r}/seed`, requireTgUser, h(async (_req, res, userId) => {
    const result = await seedDemoData(userId)
    res.json(result)
  }))

  app.get(`${r}/overview`, requireTgUser, h(async (_req, res, userId) => {
    const bills = await store.listBills(userId)
    const insights = buildInsights(bills)
    const payments = await store.listPayments(userId, 10)
    const pendingApprovals = (await store.listPayments(userId, 200)).filter(
      (p) => p.status === 'awaiting_approval',
    )
    const recommendations = await store.listRecommendations(userId, 'open')
    const upcoming = bills
      .filter((b) => (b.status === 'active' || b.status === 'overdue') && engine.daysUntil(b.nextDueDate) <= 14)
      .sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate))
    const balance = await getPaymentProvider().getBalance()
    res.json({
      insights,
      upcoming,
      recentPayments: payments,
      pendingApprovals,
      recommendations,
      balance,
      disclaimer: PAY_DISCLAIMER,
    })
  }))

  app.post(`${r}/run-check`, requireTgUser, h(async (_req, res, userId) => {
    const summary = await engine.runDailyCheck(userId)
    res.json(summary)
  }))

  app.get(`${r}/balance`, requireTgUser, h(async (_req, res) => {
    res.json(await getPaymentProvider().getBalance())
  }))

  app.get(`${r}/actions`, requireTgUser, h(async (_req, res, userId) => {
    res.json(await store.listActions(userId, 60))
  }))

  // ---- agents ----
  app.get(`${r}/agents`, requireTgUser, h(async (_req, res, userId) => {
    res.json(await store.listAgents(userId))
  }))
  app.post(`${r}/agents`, requireTgUser, h(async (req, res, userId) => {
    const parsed = agentCreateSchema.safeParse(req.body)
    if (!parsed.success) return badRequest(res, parsed)
    res.json(await store.createAgent(userId, parsed.data))
  }))
  app.patch(`${r}/agents/:id`, requireTgUser, h(async (req, res, userId) => {
    const parsed = agentCreateSchema.partial().safeParse(req.body)
    if (!parsed.success) return badRequest(res, parsed)
    const updated = await store.updateAgent(userId, String(req.params.id), parsed.data)
    if (!updated) return void res.status(404).json({ error: 'Agent not found' })
    res.json(updated)
  }))
  app.delete(`${r}/agents/:id`, requireTgUser, h(async (req, res, userId) => {
    const ok = await store.deleteAgent(userId, String(req.params.id))
    res.json({ ok })
  }))

  // ---- payment methods ----
  app.get(`${r}/methods`, requireTgUser, h(async (_req, res, userId) => {
    res.json(await store.listMethods(userId))
  }))
  app.post(`${r}/methods`, requireTgUser, h(async (req, res, userId) => {
    const parsed = methodCreateSchema.safeParse(req.body)
    if (!parsed.success) return badRequest(res, parsed)
    res.json(await store.createMethod(userId, parsed.data))
  }))
  app.delete(`${r}/methods/:id`, requireTgUser, h(async (req, res, userId) => {
    res.json({ ok: await store.deleteMethod(userId, String(req.params.id)) })
  }))

  // ---- bills ----
  app.get(`${r}/bills`, requireTgUser, h(async (_req, res, userId) => {
    res.json(await store.listBills(userId))
  }))
  app.get(`${r}/bills/:id`, requireTgUser, h(async (req, res, userId) => {
    const bill = await store.getBill(userId, String(req.params.id))
    if (!bill) return void res.status(404).json({ error: 'Bill not found' })
    res.json(bill)
  }))
  app.post(`${r}/bills`, requireTgUser, h(async (req, res, userId) => {
    const parsed = billCreateSchema.safeParse(req.body)
    if (!parsed.success) return badRequest(res, parsed)
    const refErr = await assertRefsOwned(userId, parsed.data.agentId, parsed.data.paymentMethodId)
    if (refErr) return void res.status(400).json({ error: refErr })
    const agent = await ensureDefaultAgent(userId)
    const bill = await store.createBill(userId, {
      ...parsed.data,
      agentId: parsed.data.agentId ?? agent.id,
    })
    await store.logAction(userId, {
      agentId: bill.agentId,
      billId: bill.id,
      actionType: 'bill_created',
      reasoning: `Added bill "${bill.name}".`,
    })
    res.json(bill)
  }))
  app.patch(`${r}/bills/:id`, requireTgUser, h(async (req, res, userId) => {
    const parsed = billUpdateSchema.safeParse(req.body)
    if (!parsed.success) return badRequest(res, parsed)
    const refErr = await assertRefsOwned(userId, null, parsed.data.paymentMethodId)
    if (refErr) return void res.status(400).json({ error: refErr })
    const updated = await store.updateBill(userId, String(req.params.id), parsed.data)
    if (!updated) return void res.status(404).json({ error: 'Bill not found' })
    res.json(updated)
  }))
  app.delete(`${r}/bills/:id`, requireTgUser, h(async (req, res, userId) => {
    res.json({ ok: await store.deleteBill(userId, String(req.params.id)) })
  }))

  // Prepare a payment that awaits user approval. Idempotent: if an approval is
  // already open for this bill, return it instead of stacking duplicates that
  // could each be approved and charged separately.
  app.post(`${r}/bills/:id/pay`, requireTgUser, h(async (req, res, userId) => {
    const bill = await store.getBill(userId, String(req.params.id))
    if (!bill) return void res.status(404).json({ error: 'Bill not found' })
    const open = (await store.listPayments(userId, 200)).find(
      (p) => p.billId === bill.id && p.status === 'awaiting_approval',
    )
    if (open) return void res.json(open)
    const payment = await engine.prepareApproval(userId, bill, 'approval', 'User requested payment.')
    res.json(payment)
  }))
  // Manual mode: record the bill as paid out-of-band and roll the due date.
  app.post(`${r}/bills/:id/mark-paid`, requireTgUser, h(async (req, res, userId) => {
    const bill = await store.getBill(userId, String(req.params.id))
    if (!bill) return void res.status(404).json({ error: 'Bill not found' })
    res.json(await engine.markBillPaidManually(userId, bill))
  }))
  // Toggle auto-pay.
  app.post(`${r}/bills/:id/autopay`, requireTgUser, h(async (req, res, userId) => {
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body)
    if (!parsed.success) return badRequest(res, parsed)
    const updated = await store.updateBill(userId, String(req.params.id), {
      autoPayEnabled: parsed.data.enabled,
    })
    if (!updated) return void res.status(404).json({ error: 'Bill not found' })
    await store.logAction(userId, {
      agentId: updated.agentId,
      billId: updated.id,
      actionType: parsed.data.enabled ? 'autopay_enabled' : 'autopay_disabled',
    })
    res.json(updated)
  }))

  // ---- payments ----
  app.get(`${r}/payments`, requireTgUser, h(async (_req, res, userId) => {
    res.json(await store.listPayments(userId, 200))
  }))
  app.post(`${r}/payments/:id/approve`, requireTgUser, h(async (req, res, userId) => {
    res.json(await engine.approvePayment(userId, String(req.params.id)))
  }))
  app.post(`${r}/payments/:id/cancel`, requireTgUser, h(async (req, res, userId) => {
    res.json(await engine.cancelPayment(userId, String(req.params.id)))
  }))

  // ---- recommendations ----
  app.get(`${r}/recommendations`, requireTgUser, h(async (req, res, userId) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined
    res.json(await store.listRecommendations(userId, status))
  }))
  app.post(`${r}/recommendations/generate`, requireTgUser, h(async (_req, res, userId) => {
    const agent = await ensureDefaultAgent(userId)
    const bills = await store.listBills(userId)
    res.json(await generateRecommendations(userId, agent.id, bills))
  }))
  app.post(`${r}/recommendations/:id/accept`, requireTgUser, h(async (req, res, userId) => {
    const rec = await store.setRecommendationStatus(userId, String(req.params.id), 'accepted')
    if (!rec) return void res.status(404).json({ error: 'Recommendation not found' })
    res.json(rec)
  }))
  app.post(`${r}/recommendations/:id/dismiss`, requireTgUser, h(async (req, res, userId) => {
    const rec = await store.setRecommendationStatus(userId, String(req.params.id), 'dismissed')
    if (!rec) return void res.status(404).json({ error: 'Recommendation not found' })
    res.json(rec)
  }))

  // ---- insights ----
  app.get(`${r}/insights`, requireTgUser, h(async (_req, res, userId) => {
    res.json(buildInsights(await store.listBills(userId)))
  }))

  // ---- chat ----
  app.post(`${r}/chat`, requireTgUser, h(async (req, res, userId) => {
    const parsed = chatSchema.safeParse(req.body)
    if (!parsed.success) return badRequest(res, parsed)
    const agents = await store.listAgents(userId)
    const agent = parsed.data.agentId
      ? agents.find((a) => a.id === parsed.data.agentId) ?? (await ensureDefaultAgent(userId))
      : await ensureDefaultAgent(userId)
    const result = await handleChat({ userId, agent }, parsed.data.message)
    res.json(result)
  }))

  console.log('[payagent] routes registered at /api/pay/*')
}

// Boot hook: ensure schema/tables exist before serving. Called from server.ts.
export async function initPayAgent(): Promise<void> {
  await ensurePayAgentSchema()
}
