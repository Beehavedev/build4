// Build4 Pay Agent — modular payment provider abstraction.
//
// MVP custodies NO real funds. The MockProvider simulates the full lifecycle
// (create → confirm/cancel → status) and a spendable balance so the rest of
// the app can run end-to-end. Real providers (Stripe, open banking, crypto,
// Build4 wallet) can implement this same interface later without touching the
// bill engine, routes, or UI.

export type ProviderPaymentStatus =
  | 'requires_confirmation'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export interface CreatePaymentRequest {
  amount: number
  currency: string
  /** Opaque reference back to our Payment row id, for traceability. */
  idempotencyKey?: string
  description?: string
  metadata?: Record<string, unknown>
}

export interface ProviderPayment {
  reference: string
  status: ProviderPaymentStatus
  amount: number
  currency: string
  createdAt: string
  confirmedAt: string | null
}

export interface BalanceResult {
  currency: string
  available: number
}

export interface PaymentProvider {
  readonly name: string
  createPayment(req: CreatePaymentRequest): Promise<ProviderPayment>
  confirmPayment(reference: string): Promise<ProviderPayment>
  cancelPayment(reference: string): Promise<ProviderPayment>
  getPaymentStatus(reference: string): Promise<ProviderPayment>
  getBalance(currency?: string): Promise<BalanceResult>
}

export class PaymentProviderError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'PaymentProviderError'
    this.code = code
  }
}

// In-memory mock. State lives only for the process lifetime, which is fine:
// the authoritative payment record is our own pay_payments row. The provider
// reference is all we persist, and getPaymentStatus tolerates a cold cache by
// reporting succeeded for any reference it confirmed during this process.
class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock'
  private store = new Map<string, ProviderPayment>()
  // Simulated wallet balance the auto-pay "enough balance" rule checks against.
  private balance = Number(process.env.PAYAGENT_MOCK_BALANCE ?? 5000)

  async createPayment(req: CreatePaymentRequest): Promise<ProviderPayment> {
    const reference = `mock_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
    const p: ProviderPayment = {
      reference,
      status: 'requires_confirmation',
      amount: req.amount,
      currency: req.currency,
      createdAt: new Date().toISOString(),
      confirmedAt: null,
    }
    this.store.set(reference, p)
    return { ...p }
  }

  async confirmPayment(reference: string): Promise<ProviderPayment> {
    const p = this.store.get(reference)
    if (!p) throw new PaymentProviderError('not_found', `Unknown payment reference ${reference}`)
    if (p.status === 'cancelled') {
      throw new PaymentProviderError('cancelled', 'Payment was cancelled and cannot be confirmed')
    }
    if (p.status !== 'succeeded' && this.balance < p.amount) {
      p.status = 'failed'
      this.store.set(reference, p)
      throw new PaymentProviderError('insufficient_funds', 'Simulated balance is too low')
    }
    if (p.status !== 'succeeded') {
      this.balance -= p.amount
      p.status = 'succeeded'
      p.confirmedAt = new Date().toISOString()
      this.store.set(reference, p)
    }
    return { ...p }
  }

  async cancelPayment(reference: string): Promise<ProviderPayment> {
    const p = this.store.get(reference)
    if (!p) throw new PaymentProviderError('not_found', `Unknown payment reference ${reference}`)
    if (p.status === 'succeeded') {
      throw new PaymentProviderError('already_succeeded', 'Cannot cancel a settled payment')
    }
    p.status = 'cancelled'
    this.store.set(reference, p)
    return { ...p }
  }

  async getPaymentStatus(reference: string): Promise<ProviderPayment> {
    const p = this.store.get(reference)
    if (!p) throw new PaymentProviderError('not_found', `Unknown payment reference ${reference}`)
    return { ...p }
  }

  async getBalance(currency = 'USD'): Promise<BalanceResult> {
    return { currency, available: Math.max(0, Math.round(this.balance * 100) / 100) }
  }
}

let active: PaymentProvider = new MockPaymentProvider()

export function getPaymentProvider(): PaymentProvider {
  return active
}

// Allows future swap-in (and tests) without changing callers.
export function setPaymentProvider(p: PaymentProvider): void {
  active = p
}
