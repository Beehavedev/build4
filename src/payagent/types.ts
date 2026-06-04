// Build4 Pay Agent — shared domain types.
//
// This module is fully self-contained and lives in its OWN Postgres schema
// (`payagent`) on its OWN connection (PAYAGENT_DATABASE_URL, falling back to
// DATABASE_URL in dev). It never imports the bot's Prisma client and is never
// touched by the bot's `prisma db push`. See src/payagent/db.ts.

export const PAYMENT_MODES = ['manual', 'approval', 'auto'] as const
export type PaymentMode = (typeof PAYMENT_MODES)[number]

export const BILL_STATUSES = ['active', 'paused', 'cancelled', 'overdue', 'paid'] as const
export type BillStatus = (typeof BILL_STATUSES)[number]

export const BILL_FREQUENCIES = ['weekly', 'monthly', 'yearly'] as const
export type BillFrequency = (typeof BILL_FREQUENCIES)[number]

export const PAYMENT_STATUSES = [
  'pending',
  'awaiting_approval',
  'processing',
  'succeeded',
  'failed',
  'cancelled',
] as const
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number]

export const PAYMENT_METHOD_TYPES = ['card', 'bank', 'crypto', 'stablecoin', 'build4'] as const
export type PaymentMethodType = (typeof PAYMENT_METHOD_TYPES)[number]

export const RECOMMENDATION_STATUSES = ['open', 'accepted', 'dismissed'] as const
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number]

export const RECOMMENDATION_TYPES = [
  'duplicate',
  'increase',
  'unused',
  'savings',
  'due_soon',
  'overspend',
  'general',
] as const
export type RecommendationType = (typeof RECOMMENDATION_TYPES)[number]

export interface PayUser {
  id: string
  telegramId: string
  name: string | null
  email: string | null
  createdAt: string
}

export interface PayAgent {
  id: string
  userId: string
  name: string
  avatar: string
  personality: string
  role: string
  createdAt: string
}

export interface PaymentMethod {
  id: string
  userId: string
  type: PaymentMethodType
  provider: string
  label: string
  last4: string | null
  status: 'active' | 'inactive'
  createdAt: string
}

export interface Bill {
  id: string
  userId: string
  agentId: string | null
  name: string
  category: string
  amount: number
  currency: string
  frequency: BillFrequency
  dueDate: string // ISO date (YYYY-MM-DD)
  nextDueDate: string // ISO date (YYYY-MM-DD)
  paymentMethodId: string | null
  status: BillStatus
  autoPayEnabled: boolean
  approvalRequired: boolean
  maxAutoPayAmount: number | null
  trusted: boolean
  lastAmount: number | null
  lastUsedAt: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
}

export interface Payment {
  id: string
  userId: string
  billId: string
  amount: number
  currency: string
  status: PaymentStatus
  provider: string
  providerReference: string | null
  approvedByUser: boolean
  mode: PaymentMode
  paidAt: string | null
  createdAt: string
}

export interface AgentAction {
  id: string
  userId: string
  agentId: string | null
  billId: string | null
  actionType: string
  actionStatus: string
  reasoning: string | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

export interface Recommendation {
  id: string
  userId: string
  agentId: string | null
  type: RecommendationType
  title: string
  description: string
  potentialSaving: number
  status: RecommendationStatus
  createdAt: string
}

// Derive the effective payment mode from a bill's flags. auto_pay wins; then
// approval_required; otherwise manual. (Rules in billEngine still force the
// FIRST payment of an auto bill through approval — see canAutoPay.)
export function modeOf(bill: Pick<Bill, 'autoPayEnabled' | 'approvalRequired'>): PaymentMode {
  if (bill.autoPayEnabled) return 'auto'
  if (bill.approvalRequired) return 'approval'
  return 'manual'
}
