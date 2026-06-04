// Build4 Pay Agent — storage layer (typed CRUD over the `payagent` schema).
// All queries are parameterized. Dynamic UPDATE column sets are restricted to
// hard-coded allowlists so user input never reaches an identifier position.
import { payQuery, PAY_SCHEMA as S } from './db'
import type {
  AgentAction,
  Bill,
  BillFrequency,
  PayAgent,
  PaymentMethod,
  Payment,
  PayUser,
  Recommendation,
} from './types'

const num = (v: any): number => (v == null ? 0 : Number(v))
const numOrNull = (v: any): number | null => (v == null ? null : Number(v))
const ts = (v: any): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString()

// ---------- mappers ----------
function mapUser(r: any): PayUser {
  return {
    id: r.id,
    telegramId: r.telegram_id,
    name: r.name ?? null,
    email: r.email ?? null,
    createdAt: ts(r.created_at)!,
  }
}
function mapAgent(r: any): PayAgent {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    avatar: r.avatar,
    personality: r.personality,
    role: r.role,
    createdAt: ts(r.created_at)!,
  }
}
function mapMethod(r: any): PaymentMethod {
  return {
    id: r.id,
    userId: r.user_id,
    type: r.type,
    provider: r.provider,
    label: r.label,
    last4: r.last4 ?? null,
    status: r.status,
    createdAt: ts(r.created_at)!,
  }
}
function mapBill(r: any): Bill {
  return {
    id: r.id,
    userId: r.user_id,
    agentId: r.agent_id ?? null,
    name: r.name,
    category: r.category,
    amount: num(r.amount),
    currency: r.currency,
    frequency: r.frequency,
    dueDate: r.due_date,
    nextDueDate: r.next_due_date,
    paymentMethodId: r.payment_method_id ?? null,
    status: r.status,
    autoPayEnabled: !!r.auto_pay_enabled,
    approvalRequired: !!r.approval_required,
    maxAutoPayAmount: numOrNull(r.max_auto_pay_amount),
    trusted: !!r.trusted,
    lastAmount: numOrNull(r.last_amount),
    lastUsedAt: ts(r.last_used_at),
    notes: r.notes ?? null,
    createdAt: ts(r.created_at)!,
    updatedAt: ts(r.updated_at)!,
  }
}
function mapPayment(r: any): Payment {
  return {
    id: r.id,
    userId: r.user_id,
    billId: r.bill_id,
    amount: num(r.amount),
    currency: r.currency,
    status: r.status,
    provider: r.provider,
    providerReference: r.provider_reference ?? null,
    approvedByUser: !!r.approved_by_user,
    mode: r.mode,
    paidAt: ts(r.paid_at),
    createdAt: ts(r.created_at)!,
  }
}
function mapAction(r: any): AgentAction {
  return {
    id: r.id,
    userId: r.user_id,
    agentId: r.agent_id ?? null,
    billId: r.bill_id ?? null,
    actionType: r.action_type,
    actionStatus: r.action_status,
    reasoning: r.reasoning ?? null,
    metadata: r.metadata ?? null,
    createdAt: ts(r.created_at)!,
  }
}
function mapRec(r: any): Recommendation {
  return {
    id: r.id,
    userId: r.user_id,
    agentId: r.agent_id ?? null,
    type: r.type,
    title: r.title,
    description: r.description,
    potentialSaving: num(r.potential_saving),
    status: r.status,
    createdAt: ts(r.created_at)!,
  }
}

// ---------- users ----------
export async function getOrCreatePayUser(telegramId: string, name?: string | null): Promise<PayUser> {
  const { rows } = await payQuery(
    `INSERT INTO ${S}.pay_users (telegram_id, name)
     VALUES ($1, $2)
     ON CONFLICT (telegram_id) DO UPDATE SET name = COALESCE(EXCLUDED.name, ${S}.pay_users.name)
     RETURNING *`,
    [telegramId, name ?? null],
  )
  return mapUser(rows[0])
}

// ---------- agents ----------
export async function listAgents(userId: string): Promise<PayAgent[]> {
  const { rows } = await payQuery(
    `SELECT * FROM ${S}.pay_agents WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId],
  )
  return rows.map(mapAgent)
}
export async function getAgent(userId: string, id: string): Promise<PayAgent | null> {
  const { rows } = await payQuery(`SELECT * FROM ${S}.pay_agents WHERE user_id = $1 AND id = $2`, [
    userId,
    id,
  ])
  return rows[0] ? mapAgent(rows[0]) : null
}
export async function createAgent(
  userId: string,
  data: { name: string; avatar?: string; personality?: string; role?: string },
): Promise<PayAgent> {
  const { rows } = await payQuery(
    `INSERT INTO ${S}.pay_agents (user_id, name, avatar, personality, role)
     VALUES ($1, $2, COALESCE($3,'🤖'), COALESCE($4,'Sharp, protective, and a little degen.'), COALESCE($5,'Bills Agent'))
     RETURNING *`,
    [userId, data.name, data.avatar ?? null, data.personality ?? null, data.role ?? null],
  )
  return mapAgent(rows[0])
}
const AGENT_COLS: Record<string, string> = {
  name: 'name',
  avatar: 'avatar',
  personality: 'personality',
  role: 'role',
}
export async function updateAgent(
  userId: string,
  id: string,
  patch: Record<string, any>,
): Promise<PayAgent | null> {
  const sets: string[] = []
  const vals: any[] = []
  for (const [k, v] of Object.entries(patch)) {
    const col = AGENT_COLS[k]
    if (!col) continue
    vals.push(v)
    sets.push(`${col} = $${vals.length}`)
  }
  if (!sets.length) return getAgent(userId, id)
  vals.push(userId, id)
  const { rows } = await payQuery(
    `UPDATE ${S}.pay_agents SET ${sets.join(', ')} WHERE user_id = $${vals.length - 1} AND id = $${vals.length} RETURNING *`,
    vals,
  )
  return rows[0] ? mapAgent(rows[0]) : null
}
export async function deleteAgent(userId: string, id: string): Promise<boolean> {
  const { rows } = await payQuery(
    `DELETE FROM ${S}.pay_agents WHERE user_id = $1 AND id = $2 RETURNING id`,
    [userId, id],
  )
  return rows.length > 0
}

// ---------- payment methods ----------
export async function listMethods(userId: string): Promise<PaymentMethod[]> {
  const { rows } = await payQuery(
    `SELECT * FROM ${S}.pay_payment_methods WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId],
  )
  return rows.map(mapMethod)
}
export async function createMethod(
  userId: string,
  data: { type: string; provider?: string; label: string; last4?: string | null },
): Promise<PaymentMethod> {
  const { rows } = await payQuery(
    `INSERT INTO ${S}.pay_payment_methods (user_id, type, provider, label, last4)
     VALUES ($1, $2, COALESCE($3,'mock'), $4, $5) RETURNING *`,
    [userId, data.type, data.provider ?? null, data.label, data.last4 ?? null],
  )
  return mapMethod(rows[0])
}
export async function deleteMethod(userId: string, id: string): Promise<boolean> {
  const { rows } = await payQuery(
    `DELETE FROM ${S}.pay_payment_methods WHERE user_id = $1 AND id = $2 RETURNING id`,
    [userId, id],
  )
  return rows.length > 0
}

// ---------- bills ----------
export async function listBills(userId: string): Promise<Bill[]> {
  const { rows } = await payQuery(
    `SELECT * FROM ${S}.pay_bills WHERE user_id = $1 ORDER BY next_due_date ASC, created_at ASC`,
    [userId],
  )
  return rows.map(mapBill)
}
export async function getBill(userId: string, id: string): Promise<Bill | null> {
  const { rows } = await payQuery(`SELECT * FROM ${S}.pay_bills WHERE user_id = $1 AND id = $2`, [
    userId,
    id,
  ])
  return rows[0] ? mapBill(rows[0]) : null
}
export interface CreateBillInput {
  name: string
  category?: string
  amount: number
  currency?: string
  frequency?: BillFrequency
  dueDate: string
  paymentMethodId?: string | null
  agentId?: string | null
  status?: string
  autoPayEnabled?: boolean
  approvalRequired?: boolean
  maxAutoPayAmount?: number | null
  trusted?: boolean
  notes?: string | null
}
export async function createBill(userId: string, b: CreateBillInput): Promise<Bill> {
  const { rows } = await payQuery(
    `INSERT INTO ${S}.pay_bills
       (user_id, agent_id, name, category, amount, currency, frequency, due_date, next_due_date,
        payment_method_id, status, auto_pay_enabled, approval_required, max_auto_pay_amount, trusted, notes)
     VALUES ($1,$2,$3,COALESCE($4,'Other'),$5,COALESCE($6,'USD'),COALESCE($7,'monthly'),$8,$8,
        $9,COALESCE($10,'active'),COALESCE($11,false),COALESCE($12,true),$13,COALESCE($14,false),$15)
     RETURNING *`,
    [
      userId,
      b.agentId ?? null,
      b.name,
      b.category ?? null,
      b.amount,
      b.currency ?? null,
      b.frequency ?? null,
      b.dueDate,
      b.paymentMethodId ?? null,
      b.status ?? null,
      b.autoPayEnabled ?? null,
      b.approvalRequired ?? null,
      b.maxAutoPayAmount ?? null,
      b.trusted ?? null,
      b.notes ?? null,
    ],
  )
  return mapBill(rows[0])
}
const BILL_COLS: Record<string, string> = {
  name: 'name',
  category: 'category',
  amount: 'amount',
  currency: 'currency',
  frequency: 'frequency',
  dueDate: 'due_date',
  nextDueDate: 'next_due_date',
  paymentMethodId: 'payment_method_id',
  agentId: 'agent_id',
  status: 'status',
  autoPayEnabled: 'auto_pay_enabled',
  approvalRequired: 'approval_required',
  maxAutoPayAmount: 'max_auto_pay_amount',
  trusted: 'trusted',
  lastAmount: 'last_amount',
  lastUsedAt: 'last_used_at',
  notes: 'notes',
}
export async function updateBill(
  userId: string,
  id: string,
  patch: Record<string, any>,
): Promise<Bill | null> {
  const sets: string[] = []
  const vals: any[] = []
  for (const [k, v] of Object.entries(patch)) {
    const col = BILL_COLS[k]
    if (!col) continue
    vals.push(v)
    sets.push(`${col} = $${vals.length}`)
  }
  if (!sets.length) return getBill(userId, id)
  sets.push('updated_at = now()')
  vals.push(userId, id)
  const { rows } = await payQuery(
    `UPDATE ${S}.pay_bills SET ${sets.join(', ')} WHERE user_id = $${vals.length - 1} AND id = $${vals.length} RETURNING *`,
    vals,
  )
  return rows[0] ? mapBill(rows[0]) : null
}
export async function deleteBill(userId: string, id: string): Promise<boolean> {
  const { rows } = await payQuery(
    `DELETE FROM ${S}.pay_bills WHERE user_id = $1 AND id = $2 RETURNING id`,
    [userId, id],
  )
  return rows.length > 0
}

// ---------- payments ----------
export async function listPayments(userId: string, limit = 100): Promise<Payment[]> {
  const { rows } = await payQuery(
    `SELECT * FROM ${S}.pay_payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  )
  return rows.map(mapPayment)
}
export async function getPayment(userId: string, id: string): Promise<Payment | null> {
  const { rows } = await payQuery(`SELECT * FROM ${S}.pay_payments WHERE user_id = $1 AND id = $2`, [
    userId,
    id,
  ])
  return rows[0] ? mapPayment(rows[0]) : null
}
export async function latestSucceededPayment(billId: string): Promise<Payment | null> {
  const { rows } = await payQuery(
    `SELECT * FROM ${S}.pay_payments WHERE bill_id = $1 AND status = 'succeeded' ORDER BY paid_at DESC NULLS LAST, created_at DESC LIMIT 1`,
    [billId],
  )
  return rows[0] ? mapPayment(rows[0]) : null
}
export async function countSucceededPayments(billId: string): Promise<number> {
  const { rows } = await payQuery<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM ${S}.pay_payments WHERE bill_id = $1 AND status = 'succeeded'`,
    [billId],
  )
  return Number(rows[0]?.c ?? 0)
}
export interface CreatePaymentRow {
  billId: string
  amount: number
  currency: string
  status?: string
  provider?: string
  providerReference?: string | null
  approvedByUser?: boolean
  mode?: string
  paidAt?: string | null
}
export async function createPaymentRow(userId: string, p: CreatePaymentRow): Promise<Payment> {
  const { rows } = await payQuery(
    `INSERT INTO ${S}.pay_payments
       (user_id, bill_id, amount, currency, status, provider, provider_reference, approved_by_user, mode, paid_at)
     VALUES ($1,$2,$3,$4,COALESCE($5,'pending'),COALESCE($6,'mock'),$7,COALESCE($8,false),COALESCE($9,'approval'),$10)
     RETURNING *`,
    [
      userId,
      p.billId,
      p.amount,
      p.currency,
      p.status ?? null,
      p.provider ?? null,
      p.providerReference ?? null,
      p.approvedByUser ?? null,
      p.mode ?? null,
      p.paidAt ?? null,
    ],
  )
  return mapPayment(rows[0])
}
const PAYMENT_COLS: Record<string, string> = {
  status: 'status',
  providerReference: 'provider_reference',
  approvedByUser: 'approved_by_user',
  paidAt: 'paid_at',
}
export async function updatePayment(
  userId: string,
  id: string,
  patch: Record<string, any>,
): Promise<Payment | null> {
  const sets: string[] = []
  const vals: any[] = []
  for (const [k, v] of Object.entries(patch)) {
    const col = PAYMENT_COLS[k]
    if (!col) continue
    vals.push(v)
    sets.push(`${col} = $${vals.length}`)
  }
  if (!sets.length) return getPayment(userId, id)
  vals.push(userId, id)
  const { rows } = await payQuery(
    `UPDATE ${S}.pay_payments SET ${sets.join(', ')} WHERE user_id = $${vals.length - 1} AND id = $${vals.length} RETURNING *`,
    vals,
  )
  return rows[0] ? mapPayment(rows[0]) : null
}

// ---------- agent actions (audit log) ----------
export async function logAction(
  userId: string,
  a: {
    agentId?: string | null
    billId?: string | null
    actionType: string
    actionStatus?: string
    reasoning?: string | null
    metadata?: Record<string, unknown> | null
  },
): Promise<AgentAction> {
  const { rows } = await payQuery(
    `INSERT INTO ${S}.pay_agent_actions (user_id, agent_id, bill_id, action_type, action_status, reasoning, metadata)
     VALUES ($1,$2,$3,$4,COALESCE($5,'done'),$6,$7) RETURNING *`,
    [
      userId,
      a.agentId ?? null,
      a.billId ?? null,
      a.actionType,
      a.actionStatus ?? null,
      a.reasoning ?? null,
      a.metadata ? JSON.stringify(a.metadata) : null,
    ],
  )
  return mapAction(rows[0])
}
export async function listActions(userId: string, limit = 50): Promise<AgentAction[]> {
  const { rows } = await payQuery(
    `SELECT * FROM ${S}.pay_agent_actions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  )
  return rows.map(mapAction)
}

// ---------- recommendations ----------
export async function listRecommendations(
  userId: string,
  status?: string,
): Promise<Recommendation[]> {
  if (status) {
    const { rows } = await payQuery(
      `SELECT * FROM ${S}.pay_recommendations WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC`,
      [userId, status],
    )
    return rows.map(mapRec)
  }
  const { rows } = await payQuery(
    `SELECT * FROM ${S}.pay_recommendations WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  )
  return rows.map(mapRec)
}
export async function createRecommendation(
  userId: string,
  r: {
    agentId?: string | null
    type: string
    title: string
    description?: string
    potentialSaving?: number
  },
): Promise<Recommendation> {
  const { rows } = await payQuery(
    `INSERT INTO ${S}.pay_recommendations (user_id, agent_id, type, title, description, potential_saving)
     VALUES ($1,$2,$3,$4,COALESCE($5,''),COALESCE($6,0)) RETURNING *`,
    [userId, r.agentId ?? null, r.type, r.title, r.description ?? null, r.potentialSaving ?? null],
  )
  return mapRec(rows[0])
}
export async function setRecommendationStatus(
  userId: string,
  id: string,
  status: string,
): Promise<Recommendation | null> {
  const { rows } = await payQuery(
    `UPDATE ${S}.pay_recommendations SET status = $3 WHERE user_id = $1 AND id = $2 RETURNING *`,
    [userId, id, status],
  )
  return rows[0] ? mapRec(rows[0]) : null
}
// Avoid spamming duplicate open recommendations of the same type+title.
export async function hasOpenRecommendation(
  userId: string,
  type: string,
  title: string,
): Promise<boolean> {
  const { rows } = await payQuery(
    `SELECT 1 FROM ${S}.pay_recommendations WHERE user_id = $1 AND type = $2 AND title = $3 AND status = 'open' LIMIT 1`,
    [userId, type, title],
  )
  return rows.length > 0
}
