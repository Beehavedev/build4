// Build4 Pay Agent — bill engine.
// Owns recurring due-date math, the auto-pay decision rules, and the payment
// lifecycle (prepare → approve/cancel, manual mark-paid, autonomous auto-pay).
// Every state change writes an audit row via storage.logAction.
import { payQuery, PAY_SCHEMA as S } from '../db'
import { getPaymentProvider, PaymentProviderError } from '../payments/provider'
import * as store from '../storage'
import type { Bill, BillFrequency, Payment, PaymentMode } from '../types'

// ---------- date helpers (UTC, no tz drift) ----------
export function todayYMD(): string {
  return new Date().toISOString().slice(0, 10)
}
function addDays(s: string, n: number): string {
  const d = new Date(s + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
function addMonths(s: string, n: number): string {
  const d = new Date(s + 'T00:00:00Z')
  d.setUTCMonth(d.getUTCMonth() + n)
  return d.toISOString().slice(0, 10)
}
function addYears(s: string, n: number): string {
  const d = new Date(s + 'T00:00:00Z')
  d.setUTCFullYear(d.getUTCFullYear() + n)
  return d.toISOString().slice(0, 10)
}
export function advanceDueDate(frequency: BillFrequency, from: string): string {
  if (frequency === 'weekly') return addDays(from, 7)
  if (frequency === 'yearly') return addYears(from, 1)
  return addMonths(from, 1)
}
export function daysUntil(ymd: string): number {
  const today = new Date(todayYMD() + 'T00:00:00Z').getTime()
  const target = new Date(ymd + 'T00:00:00Z').getTime()
  return Math.round((target - today) / 86_400_000)
}

// ---------- auto-pay rules (section 7) ----------
export interface AutoPayDecision {
  ok: boolean
  reason: string
  code:
    | 'ok'
    | 'not_active'
    | 'autopay_off'
    | 'first_payment'
    | 'over_limit'
    | 'price_increase'
    | 'insufficient_funds'
}
export async function evaluateAutoPay(bill: Bill): Promise<AutoPayDecision> {
  if (bill.status !== 'active' && bill.status !== 'overdue') {
    return { ok: false, code: 'not_active', reason: `Bill is ${bill.status}, not eligible for auto-pay.` }
  }
  if (!bill.autoPayEnabled) {
    return { ok: false, code: 'autopay_off', reason: 'Auto-pay is not enabled for this bill.' }
  }
  const succeeded = await store.countSucceededPayments(bill.id)
  if (succeeded === 0 && !bill.trusted) {
    return {
      ok: false,
      code: 'first_payment',
      reason: 'This is the first payment for this bill, so I need your confirmation before paying.',
    }
  }
  if (bill.maxAutoPayAmount != null && bill.amount > bill.maxAutoPayAmount) {
    return {
      ok: false,
      code: 'over_limit',
      reason: `Amount ${bill.amount} exceeds your auto-pay limit of ${bill.maxAutoPayAmount}.`,
    }
  }
  if (bill.lastAmount != null && bill.amount > bill.lastAmount * 1.2) {
    const pct = Math.round(((bill.amount - bill.lastAmount) / bill.lastAmount) * 100)
    return {
      ok: false,
      code: 'price_increase',
      reason: `Amount jumped ${pct}% (from ${bill.lastAmount} to ${bill.amount}) — I'll ask before paying.`,
    }
  }
  const bal = await getPaymentProvider().getBalance(bill.currency)
  if (bal.available < bill.amount) {
    return {
      ok: false,
      code: 'insufficient_funds',
      reason: `Simulated balance (${bal.available} ${bal.currency}) is below the amount due.`,
    }
  }
  return { ok: true, code: 'ok', reason: 'All auto-pay checks passed.' }
}

// ---------- payment lifecycle ----------

// Prepare a payment that waits for the user's tap. Used by approval-mode bills
// and by auto-pay bills that fail a rule (we downgrade to an approval request).
export async function prepareApproval(
  userId: string,
  bill: Bill,
  mode: PaymentMode,
  reasoning: string,
): Promise<Payment> {
  const prov = getPaymentProvider()
  const pp = await prov.createPayment({
    amount: bill.amount,
    currency: bill.currency,
    description: `Pay Agent: ${bill.name}`,
    metadata: { billId: bill.id },
  })
  const payment = await store.createPaymentRow(userId, {
    billId: bill.id,
    amount: bill.amount,
    currency: bill.currency,
    status: 'awaiting_approval',
    provider: prov.name,
    providerReference: pp.reference,
    approvedByUser: false,
    mode,
  })
  await store.logAction(userId, {
    agentId: bill.agentId,
    billId: bill.id,
    actionType: 'payment_prepared',
    actionStatus: 'awaiting_approval',
    reasoning,
    metadata: { paymentId: payment.id, amount: bill.amount },
  })
  return payment
}

async function onPaymentSucceeded(userId: string, bill: Bill): Promise<void> {
  const next = advanceDueDate(bill.frequency, bill.nextDueDate < todayYMD() ? todayYMD() : bill.nextDueDate)
  await store.updateBill(userId, bill.id, {
    nextDueDate: next,
    lastAmount: bill.amount,
    lastUsedAt: new Date().toISOString(),
    status: 'active',
  })
}

export async function approvePayment(userId: string, paymentId: string): Promise<Payment> {
  const payment = await store.getPayment(userId, paymentId)
  if (!payment) throw new Error('Payment not found')
  if (payment.status === 'succeeded') return payment
  if (payment.status === 'cancelled') throw new Error('Payment was cancelled')
  const prov = getPaymentProvider()
  let result
  try {
    result = await prov.confirmPayment(payment.providerReference!)
  } catch (e) {
    // Cold provider cache (e.g. the bot restarted between prepare and approve):
    // the in-memory mock lost the reference. Our pay_payments row is the source
    // of truth, so re-register the payment from it and confirm that instead.
    if (e instanceof PaymentProviderError && e.code === 'not_found') {
      const recreated = await prov.createPayment({
        amount: payment.amount,
        currency: payment.currency,
        description: 'Pay Agent: re-confirm after provider cache loss',
        metadata: { paymentId, billId: payment.billId },
      })
      result = await prov.confirmPayment(recreated.reference)
      await store.updatePayment(userId, paymentId, { providerReference: recreated.reference })
    } else {
      throw e
    }
  }
  const updated = await store.updatePayment(userId, paymentId, {
    status: result.status === 'succeeded' ? 'succeeded' : 'failed',
    approvedByUser: true,
    paidAt: result.confirmedAt ?? new Date().toISOString(),
  })
  const bill = await store.getBill(userId, payment.billId)
  if (bill && updated?.status === 'succeeded') await onPaymentSucceeded(userId, bill)
  await store.logAction(userId, {
    agentId: bill?.agentId ?? null,
    billId: payment.billId,
    actionType: 'payment_approved',
    actionStatus: updated?.status ?? 'unknown',
    reasoning: 'User approved the payment.',
    metadata: { paymentId },
  })
  return updated!
}

export async function cancelPayment(userId: string, paymentId: string): Promise<Payment> {
  const payment = await store.getPayment(userId, paymentId)
  if (!payment) throw new Error('Payment not found')
  if (payment.status === 'succeeded') throw new Error('Cannot cancel a settled payment')
  const prov = getPaymentProvider()
  if (payment.providerReference) {
    try {
      await prov.cancelPayment(payment.providerReference)
    } catch {
      /* provider may not know a never-confirmed ref; we still mark cancelled */
    }
  }
  const updated = await store.updatePayment(userId, paymentId, { status: 'cancelled' })
  await store.logAction(userId, {
    billId: payment.billId,
    actionType: 'payment_cancelled',
    actionStatus: 'cancelled',
    reasoning: 'User cancelled the payment.',
    metadata: { paymentId },
  })
  return updated!
}

// Manual mode: the user pays elsewhere; we just record it and roll the due date.
export async function markBillPaidManually(userId: string, bill: Bill): Promise<Payment> {
  const payment = await store.createPaymentRow(userId, {
    billId: bill.id,
    amount: bill.amount,
    currency: bill.currency,
    status: 'succeeded',
    provider: 'manual',
    approvedByUser: true,
    mode: 'manual',
    paidAt: new Date().toISOString(),
  })
  await onPaymentSucceeded(userId, bill)
  await store.logAction(userId, {
    agentId: bill.agentId,
    billId: bill.id,
    actionType: 'payment_marked_paid',
    actionStatus: 'succeeded',
    reasoning: 'User marked the bill as paid manually.',
    metadata: { paymentId: payment.id },
  })
  return payment
}

// Auto-pay path: create + confirm in one shot (no user tap).
export async function autoPayNow(userId: string, bill: Bill): Promise<Payment> {
  const prov = getPaymentProvider()
  const pp = await prov.createPayment({
    amount: bill.amount,
    currency: bill.currency,
    description: `Pay Agent auto-pay: ${bill.name}`,
    metadata: { billId: bill.id, auto: true },
  })
  const result = await prov.confirmPayment(pp.reference)
  const payment = await store.createPaymentRow(userId, {
    billId: bill.id,
    amount: bill.amount,
    currency: bill.currency,
    status: result.status === 'succeeded' ? 'succeeded' : 'failed',
    provider: prov.name,
    providerReference: pp.reference,
    approvedByUser: false,
    mode: 'auto',
    paidAt: result.confirmedAt,
  })
  if (payment.status === 'succeeded') await onPaymentSucceeded(userId, bill)
  await store.logAction(userId, {
    agentId: bill.agentId,
    billId: bill.id,
    actionType: 'payment_auto_paid',
    actionStatus: payment.status,
    reasoning: 'Auto-pay rules passed; paid automatically.',
    metadata: { paymentId: payment.id, amount: bill.amount },
  })
  return payment
}

// ---------- daily scheduler pass ----------
const DUE_SOON_DAYS = 5

async function allBillUserIds(): Promise<string[]> {
  const { rows } = await payQuery<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM ${S}.pay_bills WHERE status IN ('active','overdue')`,
  )
  return rows.map((r) => r.user_id)
}

export interface DailyCheckSummary {
  users: number
  remindersCreated: number
  approvalsCreated: number
  autoPaid: number
  markedOverdue: number
}

// Run the daily pass for one user (or all users when userId omitted). Marks
// overdue bills, raises due-soon reminders, auto-pays where allowed, and
// downgrades blocked auto-pays into approval requests.
export async function runDailyCheck(userId?: string): Promise<DailyCheckSummary> {
  const ids = userId ? [userId] : await allBillUserIds()
  const summary: DailyCheckSummary = {
    users: ids.length,
    remindersCreated: 0,
    approvalsCreated: 0,
    autoPaid: 0,
    markedOverdue: 0,
  }
  for (const uid of ids) {
    const bills = await store.listBills(uid)
    for (const bill of bills) {
      if (bill.status !== 'active' && bill.status !== 'overdue') continue
      const due = daysUntil(bill.nextDueDate)

      // Already has an open payment awaiting approval? Don't duplicate.
      const payments = await store.listPayments(uid, 200)
      const openForBill = payments.find(
        (p) => p.billId === bill.id && p.status === 'awaiting_approval',
      )

      if (due < 0 && bill.status !== 'overdue') {
        await store.updateBill(uid, bill.id, { status: 'overdue' })
        summary.markedOverdue++
      }

      const dueNowOrSoon = due <= 0
      if (bill.autoPayEnabled && dueNowOrSoon && !openForBill) {
        const decision = await evaluateAutoPay({ ...bill, status: bill.status })
        if (decision.ok) {
          await autoPayNow(uid, bill)
          summary.autoPaid++
          continue
        }
        // Blocked → downgrade to an approval request the user can action.
        await prepareApproval(uid, bill, 'approval', decision.reason)
        summary.approvalsCreated++
        continue
      }

      // Approval-mode bills due now: stage an approval request once.
      if (!bill.autoPayEnabled && bill.approvalRequired && dueNowOrSoon && !openForBill) {
        await prepareApproval(uid, bill, 'approval', `Bill "${bill.name}" is due — approve to pay.`)
        summary.approvalsCreated++
        continue
      }

      // Otherwise (manual or not-yet-due) just raise a reminder.
      if (due >= 0 && due <= DUE_SOON_DAYS) {
        const title = `${bill.name} due in ${due} day${due === 1 ? '' : 's'}`
        if (!(await store.hasOpenRecommendation(uid, 'due_soon', title))) {
          await store.createRecommendation(uid, {
            agentId: bill.agentId,
            type: 'due_soon',
            title,
            description: `${bill.name} (${bill.amount} ${bill.currency}) is due on ${bill.nextDueDate}.`,
          })
          summary.remindersCreated++
        }
      }
    }
  }
  return summary
}
