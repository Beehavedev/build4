// Build4 Pay Agent — mini-app API client. Thin typed wrappers over the
// /api/pay/* endpoints, reusing the shared apiFetch (which injects the
// Telegram initData header). All money here is SIMULATED.
import { apiFetch } from '../../api'

export type BillFrequency = 'weekly' | 'monthly' | 'yearly'
export type BillStatus = 'active' | 'paused' | 'cancelled' | 'overdue' | 'paid'
export type PaymentMode = 'manual' | 'approval' | 'auto'
export type PaymentStatus =
  | 'pending'
  | 'awaiting_approval'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
export type PaymentMethodType = 'card' | 'bank' | 'crypto' | 'stablecoin' | 'build4'
export type RecommendationType = 'duplicate' | 'increase' | 'unused' | 'savings' | 'budget'

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
  type: PaymentMethodType
  provider: string
  label: string
  last4: string | null
  status: 'active' | 'inactive'
  createdAt: string
}

export interface Bill {
  id: string
  agentId: string | null
  name: string
  category: string
  amount: number
  currency: string
  frequency: BillFrequency
  dueDate: string
  nextDueDate: string
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
  billId: string
  amount: number
  currency: string
  status: PaymentStatus
  provider: string
  approvedByUser: boolean
  mode: PaymentMode
  paidAt: string | null
  createdAt: string
}

export interface Recommendation {
  id: string
  agentId: string | null
  type: RecommendationType
  title: string
  description: string
  potentialSaving: number
  status: 'open' | 'accepted' | 'dismissed'
  createdAt: string
}

export interface AgentAction {
  id: string
  agentId: string | null
  billId: string | null
  actionType: string
  actionStatus: string
  reasoning: string | null
  createdAt: string
}

export interface CategoryBreakdown {
  category: string
  monthly: number
  count: number
}
export interface DuplicateGroup {
  category: string
  bills: Bill[]
  monthlyTotal: number
}
export interface IncreaseFlag {
  bill: Bill
  from: number
  to: number
  pct: number
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

export interface Balance {
  available: number
  currency: string
}

export interface Overview {
  insights: InsightsSummary
  upcoming: Bill[]
  recentPayments: Payment[]
  pendingApprovals: Payment[]
  recommendations: Recommendation[]
  balance: Balance
  disclaimer: string
}

export interface ChatResult {
  reply: string
  intent: string
  data?: unknown
}

const J = { 'Content-Type': 'application/json' }

export const payApi = {
  me: () =>
    apiFetch<{ userId: string; agent: PayAgent; agents: PayAgent[]; disclaimer: string }>('/api/pay/me'),
  seed: () => apiFetch<{ seeded: boolean; bills: number; recommendations: number }>('/api/pay/seed', { method: 'POST' }),
  overview: () => apiFetch<Overview>('/api/pay/overview'),
  runCheck: () => apiFetch<any>('/api/pay/run-check', { method: 'POST' }),
  balance: () => apiFetch<Balance>('/api/pay/balance'),
  actions: () => apiFetch<AgentAction[]>('/api/pay/actions'),

  // bills
  bills: () => apiFetch<Bill[]>('/api/pay/bills'),
  createBill: (body: Partial<Bill> & { name: string; amount: number; dueDate: string }) =>
    apiFetch<Bill>('/api/pay/bills', { method: 'POST', headers: J, body: JSON.stringify(body) }),
  updateBill: (id: string, body: Partial<Bill>) =>
    apiFetch<Bill>(`/api/pay/bills/${id}`, { method: 'PATCH', headers: J, body: JSON.stringify(body) }),
  deleteBill: (id: string) => apiFetch<{ ok: boolean }>(`/api/pay/bills/${id}`, { method: 'DELETE' }),
  payBill: (id: string) => apiFetch<Payment>(`/api/pay/bills/${id}/pay`, { method: 'POST' }),
  markPaid: (id: string) => apiFetch<Payment>(`/api/pay/bills/${id}/mark-paid`, { method: 'POST' }),
  setAutoPay: (id: string, enabled: boolean) =>
    apiFetch<Bill>(`/api/pay/bills/${id}/autopay`, { method: 'POST', headers: J, body: JSON.stringify({ enabled }) }),

  // payments
  payments: () => apiFetch<Payment[]>('/api/pay/payments'),
  approve: (id: string) => apiFetch<Payment>(`/api/pay/payments/${id}/approve`, { method: 'POST' }),
  cancel: (id: string) => apiFetch<Payment>(`/api/pay/payments/${id}/cancel`, { method: 'POST' }),

  // agents
  agents: () => apiFetch<PayAgent[]>('/api/pay/agents'),
  createAgent: (body: { name: string; avatar?: string; personality?: string; role?: string }) =>
    apiFetch<PayAgent>('/api/pay/agents', { method: 'POST', headers: J, body: JSON.stringify(body) }),
  updateAgent: (id: string, body: Partial<PayAgent>) =>
    apiFetch<PayAgent>(`/api/pay/agents/${id}`, { method: 'PATCH', headers: J, body: JSON.stringify(body) }),
  deleteAgent: (id: string) => apiFetch<{ ok: boolean }>(`/api/pay/agents/${id}`, { method: 'DELETE' }),

  // methods
  methods: () => apiFetch<PaymentMethod[]>('/api/pay/methods'),
  createMethod: (body: { type: PaymentMethodType; label: string; last4?: string; provider?: string }) =>
    apiFetch<PaymentMethod>('/api/pay/methods', { method: 'POST', headers: J, body: JSON.stringify(body) }),
  deleteMethod: (id: string) => apiFetch<{ ok: boolean }>(`/api/pay/methods/${id}`, { method: 'DELETE' }),

  // recommendations
  recommendations: (status?: string) =>
    apiFetch<Recommendation[]>(`/api/pay/recommendations${status ? `?status=${status}` : ''}`),
  generateRecommendations: () => apiFetch<Recommendation[]>('/api/pay/recommendations/generate', { method: 'POST' }),
  acceptRecommendation: (id: string) =>
    apiFetch<Recommendation>(`/api/pay/recommendations/${id}/accept`, { method: 'POST' }),
  dismissRecommendation: (id: string) =>
    apiFetch<Recommendation>(`/api/pay/recommendations/${id}/dismiss`, { method: 'POST' }),

  // insights
  insights: () => apiFetch<InsightsSummary>('/api/pay/insights'),

  // chat
  chat: (message: string, agentId?: string) =>
    apiFetch<ChatResult>('/api/pay/chat', { method: 'POST', headers: J, body: JSON.stringify({ message, agentId }) }),
}

export function money(n: number, ccy = 'USD'): string {
  const v = (n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return ccy === 'USD' ? `$${v}` : `${v} ${ccy}`
}

export function daysUntil(ymd: string): number {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const [y, m, d] = ymd.split('-').map(Number)
  const target = new Date(y, m - 1, d)
  return Math.round((target.getTime() - today.getTime()) / 86_400_000)
}

export function dueLabel(ymd: string): string {
  const d = daysUntil(ymd)
  if (d < 0) return `${Math.abs(d)}d overdue`
  if (d === 0) return 'Due today'
  if (d === 1) return 'Due tomorrow'
  return `Due in ${d}d`
}
