import { useState, useEffect } from 'react'
import { apiFetch } from '../api'

interface WalletInfo {
  address: string
  chain: string
  label: string
  pinProtected: boolean
  balances: { usdt: number; bnb: number; error: string | null }
  aster: { usdt: number; availableMargin: number; onboarded: boolean; error: string | null }
  qrDataUrl: string
}

// Wallet state machine — derived from server response, not stored.
//   A: not onboarded, BSC empty       → fund-only
//   B: not onboarded, BSC has USDT    → "Activate Trading Account" CTA
//   C: onboarded, Aster empty         → "Transfer to Aster" CTA
//   D: onboarded, Aster has balance   → full trading-ready UI
type WalletState = 'A' | 'B' | 'C' | 'D'

function deriveState(w: WalletInfo): WalletState {
  if (!w.aster.onboarded) {
    return w.balances.usdt > 0 ? 'B' : 'A'
  }
  return w.aster.usdt > 0 ? 'D' : 'C'
}

export default function Wallet() {
  const [w, setW] = useState<WalletInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const load = async () => {
    setLoading(true); setErr(null)
    try {
      const data = await apiFetch<WalletInfo>('/api/me/wallet')
      setW(data)
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to load wallet')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      const tg = (window as any).Telegram?.WebApp
      if (tg?.showAlert) tg.showAlert(text)
    }
  }

  if (loading) {
    return (
      <div style={{ paddingTop: 60, textAlign: 'center', color: 'var(--b4-muted)' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>💳</div>
        Loading wallet…
      </div>
    )
  }
  if (err || !w) {
    return (
      <div style={{ paddingTop: 60, textAlign: 'center' }}>
        <div style={{ color: 'var(--b4-red)', marginBottom: 12 }}>{err ?? 'No wallet'}</div>
        <button className="btn-primary" onClick={load} data-testid="button-wallet-retry">Retry</button>
      </div>
    )
  }

  const state = deriveState(w)

  const short = `${w.address.slice(0, 6)}…${w.address.slice(-4)}`

  return (
    <div style={{ paddingTop: 20 }} data-testid={`wallet-state-${state}`}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>💳 Wallet</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>{w.label}</div>
      </div>

      {/* Address strip — always visible at the top so users can fund from
          any state without hunting for the QR card. One-tap copy. */}
      <div
        className="card"
        data-testid="card-address-strip"
        style={{
          marginBottom: 14,
          padding: '10px 12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 0.4, fontWeight: 600 }}>
            DEPOSIT ADDRESS · BSC
          </div>
          <div
            data-testid="text-address-short"
            style={{
              fontSize: 13,
              fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
              color: 'var(--text-primary)',
              marginTop: 2,
            }}
          >
            {short}
          </div>
        </div>
        <button
          onClick={() => copy(w.address)}
          data-testid="button-copy-address-strip"
          style={{
            padding: '8px 12px',
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: copied ? 'rgba(0,192,118,0.16)' : 'var(--bg-elevated)',
            color: copied ? 'var(--green)' : 'var(--text-primary)',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {copied ? '✓ Copied' : '📋 Copy'}
        </button>
      </div>

      {/* Balance cards — Aster on top in onboarded states (D especially) so
          users see their tradeable equity first. */}
      {state === 'D' ? (
        <>
          <AsterPrimaryCard w={w} />
          <BscSecondaryCard w={w} />
        </>
      ) : (
        <>
          <BscPrimaryCard w={w} />
          {w.aster.onboarded && <AsterSecondaryCard w={w} onReactivated={load} />}
        </>
      )}

      {/* State-specific CTA */}
      {state === 'A' && <FundFlow w={w} copy={copy} copied={copied} onRefresh={load} />}
      {state === 'B' && <ActivateFlow onActivated={load} />}
      {state === 'C' && <TransferFlow w={w} onDone={load} initialDirection="to_aster" />}
      {state === 'D' && <TradingReadyFlow w={w} onDone={load} copy={copy} copied={copied} />}
    </div>
  )
}

// ─── Balance cards ───────────────────────────────────────────────────────────

function BscPrimaryCard({ w }: { w: WalletInfo }) {
  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--b4-muted)', marginBottom: 8 }}>ON-CHAIN (BSC)</div>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--b4-muted)' }}>USDT</div>
          <div style={{ fontSize: 20, fontWeight: 700 }} data-testid="text-balance-usdt">
            {w.balances.usdt.toFixed(2)}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 11, color: 'var(--b4-muted)' }}>BNB (gas)</div>
          <div style={{ fontSize: 20, fontWeight: 700 }} data-testid="text-balance-bnb">
            {w.balances.bnb.toFixed(5)}
          </div>
        </div>
      </div>
    </div>
  )
}

function BscSecondaryCard({ w }: { w: WalletInfo }) {
  return (
    <div className="card" style={{ marginBottom: 14, opacity: 0.85 }}>
      <div style={{ fontSize: 11, color: 'var(--b4-muted)', marginBottom: 6 }}>ON-CHAIN (BSC)</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
        <span data-testid="text-balance-usdt">USDT {w.balances.usdt.toFixed(2)}</span>
        <span data-testid="text-balance-bnb">BNB {w.balances.bnb.toFixed(5)}</span>
      </div>
    </div>
  )
}

function AsterPrimaryCard({ w }: { w: WalletInfo }) {
  return (
    <div className="card" style={{
      marginBottom: 10,
      background: 'linear-gradient(135deg, #10b98122, #10b98108)',
      border: '1px solid #10b98144'
    }}>
      <div style={{ fontSize: 11, color: 'var(--b4-muted)', marginBottom: 8 }}>ASTER TRADING (LIVE)</div>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--b4-muted)' }}>Equity</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: '#10b981' }} data-testid="text-aster-usdt">
            ${w.aster.usdt.toFixed(2)}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 11, color: 'var(--b4-muted)' }}>Available margin</div>
          <div style={{ fontSize: 20, fontWeight: 700 }} data-testid="text-aster-margin">
            ${w.aster.availableMargin.toFixed(2)}
          </div>
        </div>
      </div>
    </div>
  )
}

function AsterSecondaryCard({ w, onReactivated }: { w: WalletInfo; onReactivated?: () => void }) {
  // For users whose per-user agent PK can't be decrypted (legacy
  // encryption mismatch, env-key rotation, etc.) the only recovery
  // path is re-running /api/aster/approve. The Home tab's Activate
  // button is hidden once asterOnboarded=true, so we surface a
  // Re-activate button here whenever we detect 'no_agent_credentials'.
  const [reactivating, setReactivating] = useState(false)
  const [reactivateMsg, setReactivateMsg] = useState<string | null>(null)
  const reactivate = async () => {
    if (reactivating) return
    setReactivating(true); setReactivateMsg(null)
    const fmtDebug = (d: any): string =>
      d ? ` [fmt=${d.fmt} len=${d.totalLen} parts=${d.partLens} head=${d.head} tried=${d.tried}${d.reason ? ' reason=' + d.reason : ''}]` : ''
    try {
      const r = await apiFetch<{
        success: boolean
        error?: string
        debug?: { fmt?: string; totalLen?: number; partLens?: string; head?: string; tried?: number; reason?: string }
      }>(
        '/api/aster/approve',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
      )
      if (r.success) {
        setReactivateMsg('Re-activated. Refreshing balance…')
        setTimeout(() => onReactivated?.(), 600)
      } else {
        setReactivateMsg((r.error ?? 'Re-activation failed') + fmtDebug(r.debug))
      }
    } catch (e: any) {
      // apiFetch throws ApiError with body attached on non-2xx responses.
      // The /api/aster/approve handler returns rich diagnostics in `debug`
      // when wallet decryption fails — surface them so the user (and we)
      // can triage why their wallet PK can't be decrypted.
      const base = e?.message ?? 'Re-activation failed'
      const dbg  = fmtDebug(e?.body?.debug)
      setReactivateMsg(base + dbg)
    } finally {
      setReactivating(false)
    }
  }

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, color: 'var(--b4-muted)', marginBottom: 8 }}>ASTER TRADING</div>
      {w.aster.error ? (
        <div data-testid="text-aster-error">
          <div style={{ fontSize: 12, color: 'var(--b4-red)', lineHeight: 1.45 }}>
            ⚠️ {
              w.aster.error === 'no_agent_credentials'
                ? 'Aster trading agent needs to be re-authorised. Tap below to re-activate — your USDT in Aster is safe and stays put.'
                : w.aster.error === 'not_onboarded'
                  ? 'No Aster account found. Deposit USDT to get started.'
                  : w.aster.error === 'aster_unavailable' || w.aster.error.includes('rpc')
                    ? 'Aster temporarily unavailable. Refreshing in a moment.'
                    : `Aster error: ${w.aster.error}`
            }
          </div>
          {w.aster.error === 'no_agent_credentials' && (
            <>
              <button
                onClick={reactivate}
                disabled={reactivating}
                data-testid="button-aster-reactivate"
                style={{
                  marginTop: 10, width: '100%', padding: '10px 14px',
                  background: '#7c3aed', color: 'white', border: 0, borderRadius: 8,
                  fontSize: 13, fontWeight: 600,
                  cursor: reactivating ? 'wait' : 'pointer', opacity: reactivating ? 0.7 : 1
                }}
              >
                {reactivating ? 'Re-activating…' : '🔄 Re-activate Aster'}
              </button>
              {reactivateMsg && (
                <div
                  data-testid="text-aster-reactivate-msg"
                  style={{ marginTop: 8, fontSize: 11, color: 'var(--b4-muted)' }}
                >
                  {reactivateMsg}
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--b4-muted)' }}>Equity</div>
            <div style={{ fontSize: 18, fontWeight: 700 }} data-testid="text-aster-usdt">
              ${w.aster.usdt.toFixed(2)}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: 'var(--b4-muted)' }}>Available</div>
            <div style={{ fontSize: 18, fontWeight: 700 }} data-testid="text-aster-margin">
              ${w.aster.availableMargin.toFixed(2)}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── State A: not onboarded, BSC empty — show fund only ──────────────────────

function FundFlow({ w, copy, copied, onRefresh }:
  { w: WalletInfo; copy: (s: string) => void; copied: boolean; onRefresh: () => void }) {
  return (
    <div data-testid="flow-fund">
      <div style={{
        background: '#3f1d1d', border: '1px solid #7f1d1d',
        borderRadius: 10, padding: 12, marginBottom: 14, fontSize: 12, lineHeight: 1.5
      }}>
        ⚠️ Send <b>USDT (BEP-20)</b> on <b>BNB Smart Chain only</b>.<br />
        Wrong network = lost funds. No exceptions.
      </div>

      <div style={{ fontSize: 13, color: 'var(--b4-muted)', marginBottom: 12, lineHeight: 1.5 }}>
        Send USDT to your wallet to get started. Once it lands, you'll be able to activate
        your Aster trading account in one tap — no leaving the app.
      </div>

      <div className="card" style={{ textAlign: 'center', marginBottom: 14 }}>
        <img
          src={w.qrDataUrl} alt="Deposit QR"
          style={{ width: 220, height: 220, borderRadius: 8, background: 'white', padding: 6 }}
          data-testid="img-qr"
        />
        <div style={{
          marginTop: 14, padding: 10, background: '#0a0a0f',
          borderRadius: 8, fontSize: 12, fontFamily: 'monospace',
          wordBreak: 'break-all', color: 'var(--b4-text)'
        }} data-testid="text-address">
          {w.address}
        </div>
        <button
          className="btn-primary"
          style={{ marginTop: 10 }}
          onClick={() => copy(w.address)}
          data-testid="button-copy-address"
        >
          {copied ? '✓ Copied' : '📋 Copy Address'}
        </button>
      </div>

      <button
        onClick={onRefresh}
        data-testid="button-check-balance"
        style={{
          width: '100%', padding: 12, borderRadius: 8,
          background: 'var(--b4-surface)', border: '1px solid var(--b4-border)',
          color: 'var(--b4-text)', fontSize: 14, cursor: 'pointer'
        }}
      >
        🔄 Check Balance
      </button>
    </div>
  )
}

// ─── State B: BSC has USDT, not onboarded — Activate Trading Account ─────────

function ActivateFlow({ onActivated }: { onActivated: () => void }) {
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [needsBnb, setNeedsBnb] = useState(false)
  const [depositTx, setDepositTx] = useState<string | null>(null)

  const activate = async () => {
    if (submitting) return
    setSubmitting(true); setErr(null); setNeedsBnb(false); setDepositTx(null)
    try {
      const r = await apiFetch<{
        success: boolean; error?: string; message?: string;
        needsBnb?: boolean; needsAsterAccount?: boolean;
        depositTx?: string; approveTx?: string
      }>('/api/aster/approve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      })
      if (r.success) {
        setTimeout(onActivated, 250)
      } else {
        setErr(r.error ?? 'Activation failed')
        setNeedsBnb(!!r.needsBnb)
        if (r.depositTx) setDepositTx(r.depositTx)
      }
    } catch (e: any) {
      setErr(e?.message ?? 'Activation failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div data-testid="flow-activate">
      <div style={{
        background: 'linear-gradient(135deg, #7c3aed22, #7c3aed11)',
        border: '1px solid #7c3aed44', borderRadius: 12, padding: 16, marginBottom: 14
      }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>
          🚀 One-tap activation
        </div>
        <div style={{ fontSize: 12, color: 'var(--b4-muted)', marginBottom: 14, lineHeight: 1.5 }}>
          This will deposit your full USDT balance into your Aster trading
          account and authorise BUILD4 to trade on your behalf. Takes ~15
          seconds. Requires a small amount of BNB for gas (~0.001 BNB).
          You can withdraw any time.
        </div>
        <button
          onClick={activate}
          disabled={submitting}
          data-testid="button-activate-aster"
          style={{
            width: '100%', padding: 14, borderRadius: 8, border: 'none',
            background: submitting ? '#5b21b6' : '#7c3aed',
            color: 'white', fontSize: 15, fontWeight: 600,
            cursor: submitting ? 'wait' : 'pointer'
          }}
        >
          {submitting ? 'Depositing & activating…' : '⚡ Deposit & Activate'}
        </button>
      </div>

      {err && (
        <div data-testid="text-activate-error" style={{
          padding: 12, borderRadius: 10, fontSize: 12, lineHeight: 1.5,
          background: needsBnb ? 'rgba(245, 158, 11, 0.10)' : '#ef444415',
          border: needsBnb ? '1px solid rgba(245, 158, 11, 0.40)' : '1px solid #ef444444',
          color: needsBnb ? 'var(--amber)' : '#fca5a5'
        }}>
          {needsBnb ? (
            <>
              ⛽ <b>Needs a tiny bit of BNB for gas.</b> Send ~0.001 BNB
              (≈ $0.50) to your wallet address above, then tap Activate again.
              Any BSC wallet or exchange withdrawal works.
            </>
          ) : depositTx ? (
            <>
              ⚠️ Your deposit landed but activation is still indexing on Aster.
              <br /><br />
              Deposit tx: <a
                href={`https://bscscan.com/tx/${depositTx}`}
                target="_blank" rel="noreferrer"
                style={{ color: '#a78bfa', textDecoration: 'underline' }}
              >{depositTx.slice(0, 10)}…{depositTx.slice(-8)}</a>
              <br /><br />
              Wait ~30 seconds and tap Activate again. Your USDT is safely on
              Aster — only the agent authorisation needs to retry.
            </>
          ) : (
            <>❌ {err}</>
          )}
        </div>
      )}
    </div>
  )
}

// ─── State C: onboarded, Aster empty — Transfer to Aster ─────────────────────
// ─── State D shares this same TransferFlow for the Fund button ──────────────

function TransferFlow(
  { w, onDone, initialDirection }:
  { w: WalletInfo; onDone: () => void; initialDirection: 'to_aster' | 'to_bsc' }
) {
  const [direction, setDirection] = useState<'to_aster' | 'to_bsc'>(initialDirection)
  const [amount, setAmount] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)

  const sourceBal = direction === 'to_aster' ? w.balances.usdt : w.aster.availableMargin
  const valid = Number(amount) > 0 && Number(amount) <= sourceBal

  const send = async () => {
    if (!valid || submitting) return
    setSubmitting(true); setResult(null)
    try {
      const r = await apiFetch<{ success: boolean; tranId?: string; error?: string }>(
        '/api/aster/transfer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount, direction })
        }
      )
      if (r.success) {
        setResult({ ok: true, msg: `Transferred ${amount} USDT. Refreshing balance…` })
        setAmount('')
        setTimeout(onDone, 1500)
      } else {
        setResult({ ok: false, msg: r.error ?? 'Transfer failed' })
      }
    } catch (e: any) {
      setResult({ ok: false, msg: e?.message ?? 'Transfer failed' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div data-testid="flow-transfer">
      <div style={{
        background: '#1e293b', border: '1px solid #334155',
        borderRadius: 12, padding: 14, marginBottom: 14
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
          🔁 Move USDT
        </div>

        {/* Direction toggle */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          {([
            { v: 'to_aster' as const, label: 'BSC → Aster' },
            { v: 'to_bsc'   as const, label: 'Aster → BSC' }
          ]).map(d => (
            <button
              key={d.v}
              onClick={() => { setDirection(d.v); setAmount(''); setResult(null) }}
              data-testid={`button-direction-${d.v}`}
              style={{
                flex: 1, padding: '8px 0', fontSize: 12, fontWeight: 600,
                borderRadius: 6, cursor: 'pointer',
                border: direction === d.v ? '1px solid #7c3aed' : '1px solid var(--b4-border)',
                background: direction === d.v ? '#7c3aed22' : 'transparent',
                color: 'var(--b4-text)'
              }}
            >
              {d.label}
            </button>
          ))}
        </div>

        <label style={{ fontSize: 11, color: 'var(--b4-muted)', display: 'block', marginBottom: 6 }}>
          Amount (USDT) · Available: {sourceBal.toFixed(2)}
        </label>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            value={amount}
            onChange={e => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
            placeholder="0.00"
            inputMode="decimal"
            data-testid="input-transfer-amount"
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            onClick={() => setAmount((Math.floor(Math.max(0, sourceBal) * 100) / 100).toFixed(2))}
            data-testid="button-transfer-max"
            style={{
              padding: '0 14px', borderRadius: 8, border: '1px solid var(--b4-border)',
              background: 'var(--b4-surface)', color: 'var(--b4-text)',
              fontSize: 12, fontWeight: 600, cursor: 'pointer'
            }}
          >MAX</button>
        </div>

        <button
          onClick={send}
          disabled={!valid || submitting}
          data-testid="button-transfer-send"
          style={{
            width: '100%', padding: 13, borderRadius: 8, border: 'none',
            background: valid && !submitting ? 'var(--b4-accent)' : '#1e1e2e',
            color: 'white', fontSize: 14, fontWeight: 600,
            cursor: valid && !submitting ? 'pointer' : 'not-allowed'
          }}
        >
          {submitting ? 'Transferring…' : (direction === 'to_aster' ? '⚡ Transfer to Aster' : '↩ Transfer to BSC')}
        </button>

        {result && (
          <div
            data-testid={result.ok ? 'text-transfer-success' : 'text-transfer-error'}
            style={{
              marginTop: 12, padding: 10, borderRadius: 8, fontSize: 12,
              background: result.ok ? '#10b98120' : '#ef444420',
              border: `1px solid ${result.ok ? '#10b981' : '#ef4444'}`,
              color: result.ok ? '#10b981' : '#ef4444'
            }}>
            {result.msg}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── State D: trading-ready — Transfer + Withdraw tabs ───────────────────────

function TradingReadyFlow(
  { w, onDone, copy, copied }:
  { w: WalletInfo; onDone: () => void; copy: (s: string) => void; copied: boolean }
) {
  const [tab, setTab] = useState<'transfer' | 'fund' | 'withdraw'>('transfer')

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {([
          { v: 'transfer' as const, label: '🔁 Transfer' },
          { v: 'fund'     as const, label: '⬇ Fund (BSC)' },
          { v: 'withdraw' as const, label: '⬆ Withdraw' }
        ]).map(t => (
          <button
            key={t.v}
            onClick={() => setTab(t.v)}
            data-testid={`tab-${t.v}`}
            style={{
              flex: 1, padding: '10px 0',
              borderRadius: 8, border: '1px solid var(--b4-border)',
              background: tab === t.v ? 'var(--b4-accent)' : 'var(--b4-surface)',
              color: tab === t.v ? 'white' : 'var(--b4-text)',
              fontWeight: 600, fontSize: 12, cursor: 'pointer'
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'transfer' && <TransferFlow w={w} onDone={onDone} initialDirection="to_aster" />}
      {tab === 'fund'     && <FundFlow w={w} copy={copy} copied={copied} onRefresh={onDone} />}
      {tab === 'withdraw' && <WithdrawView w={w} onSent={onDone} />}
    </div>
  )
}

// ─── On-chain BSC withdraw (unchanged from previous version) ─────────────────

function WithdrawView({ w, onSent }: { w: WalletInfo; onSent: () => void }) {
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [pin, setPin] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string; url?: string } | null>(null)

  const valid = /^0x[a-fA-F0-9]{40}$/.test(to) &&
    Number(amount) >= 1 && Number(amount) <= w.balances.usdt &&
    (!w.pinProtected || /^\d{4,8}$/.test(pin))

  const send = async () => {
    if (!valid || submitting) return
    const tg = (window as any).Telegram?.WebApp
    const confirmMsg = `Send ${amount} USDT to\n${to}\n\nThis cannot be undone. Continue?`
    const confirmed = await new Promise<boolean>(resolve => {
      if (tg?.showConfirm) tg.showConfirm(confirmMsg, (ok: boolean) => resolve(ok))
      else resolve(window.confirm(confirmMsg))
    })
    if (!confirmed) return

    setSubmitting(true); setResult(null)
    try {
      const r = await apiFetch<{ success: boolean; txHash: string; explorerUrl: string }>(
        '/api/me/withdraw',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to, amount: Number(amount), pin: pin || undefined })
        }
      )
      setResult({
        ok: true,
        msg: `Sent! Tx: ${r.txHash.slice(0, 10)}…${r.txHash.slice(-8)}`,
        url: r.explorerUrl
      })
      setAmount(''); setTo(''); setPin('')
      setTimeout(onSent, 2000)
    } catch (e: any) {
      setResult({ ok: false, msg: e?.message ?? 'Withdrawal failed' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      {w.balances.bnb < 0.0003 && (
        <div data-testid="banner-needs-gas" style={{
          background: 'rgba(245, 158, 11, 0.10)',
          border: '1px solid rgba(245, 158, 11, 0.40)',
          borderRadius: 10, padding: 12, marginBottom: 14,
          fontSize: 12, lineHeight: 1.5, color: 'var(--amber)'
        }}>
          ⛽ Needs a tiny bit of <b>BNB for gas</b>. Send ~0.001 BNB
          (≈ $0.50) to your deposit address before withdrawing.
        </div>
      )}

      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: 'var(--b4-muted)', display: 'block', marginBottom: 6 }}>
          Destination address (BSC)
        </label>
        <input
          value={to}
          onChange={e => setTo(e.target.value.trim())}
          placeholder="0x..."
          data-testid="input-to-address"
          style={inputStyle}
        />
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: 'var(--b4-muted)', display: 'block', marginBottom: 6 }}>
          Amount (USDT) · Available: {w.balances.usdt.toFixed(2)}
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={amount}
            onChange={e => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
            placeholder="0.00"
            inputMode="decimal"
            data-testid="input-amount"
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            onClick={() => setAmount((Math.floor(Math.max(0, w.balances.usdt) * 100) / 100).toFixed(2))}
            data-testid="button-max"
            style={{
              padding: '0 14px', borderRadius: 8, border: '1px solid var(--b4-border)',
              background: 'var(--b4-surface)', color: 'var(--b4-text)',
              fontSize: 12, fontWeight: 600, cursor: 'pointer'
            }}
          >MAX</button>
        </div>
      </div>

      {w.pinProtected && (
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: 'var(--b4-muted)', display: 'block', marginBottom: 6 }}>
            Wallet PIN
          </label>
          <input
            type="password"
            value={pin}
            onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
            placeholder="••••"
            inputMode="numeric"
            data-testid="input-pin"
            style={inputStyle}
          />
        </div>
      )}

      <button
        onClick={send}
        disabled={!valid || submitting}
        data-testid="button-send"
        style={{
          width: '100%', padding: 14, borderRadius: 8, border: 'none',
          background: valid && !submitting ? 'var(--b4-accent)' : '#1e1e2e',
          color: 'white', fontSize: 15, fontWeight: 600,
          cursor: valid && !submitting ? 'pointer' : 'not-allowed'
        }}
      >
        {submitting ? 'Sending…' : `Send ${amount || '0'} USDT`}
      </button>

      {result && (
        <div
          data-testid={result.ok ? 'text-success' : 'text-error'}
          style={{
            marginTop: 14, padding: 12, borderRadius: 10, fontSize: 13,
            background: result.ok ? '#10b98120' : '#ef444420',
            border: `1px solid ${result.ok ? '#10b981' : '#ef4444'}`,
            color: result.ok ? '#10b981' : '#ef4444',
            wordBreak: 'break-all'
          }}>
          {result.msg}
          {result.url && (
            <div style={{ marginTop: 6 }}>
              <a href={result.url} target="_blank" rel="noreferrer"
                 style={{ color: '#7c3aed', textDecoration: 'underline' }}>
                View on BscScan →
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '12px 14px', borderRadius: 8,
  background: 'var(--b4-surface)', border: '1px solid var(--b4-border)',
  color: 'var(--b4-text)', fontSize: 14, fontFamily: 'monospace',
  boxSizing: 'border-box', outline: 'none'
}
