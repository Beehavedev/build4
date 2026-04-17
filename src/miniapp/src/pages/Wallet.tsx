import { useState, useEffect } from 'react'
import { apiFetch } from '../api'

interface WalletInfo {
  address: string
  chain: string
  label: string
  pinProtected: boolean
  balances: { usdt: number; bnb: number; error: string | null }
  aster: { usdt: number; availableMargin: number; error: string | null } | null
  qrDataUrl: string
}

type Tab = 'fund' | 'withdraw'

export default function Wallet() {
  const [tab, setTab] = useState<Tab>('fund')
  const [w, setW] = useState<WalletInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const load = async () => {
    setLoading(true)
    setErr(null)
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

  return (
    <div style={{ paddingTop: 20 }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>💳 Wallet</div>
        <div style={{ fontSize: 13, color: 'var(--b4-muted)', marginTop: 2 }}>{w.label}</div>
      </div>

      {/* On-chain wallet balances */}
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

      {/* Aster trading account balance */}
      {w.aster && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: 'var(--b4-muted)', marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
            <span>ASTER TRADING</span>
            {w.aster.error && <span style={{ color: 'var(--b4-red)' }}>unavailable</span>}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--b4-muted)' }}>Equity</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#10b981' }} data-testid="text-aster-usdt">
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
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {(['fund', 'withdraw'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            data-testid={`tab-${t}`}
            style={{
              flex: 1, padding: '10px 0',
              borderRadius: 8, border: '1px solid var(--b4-border)',
              background: tab === t ? 'var(--b4-accent)' : 'var(--b4-surface)',
              color: tab === t ? 'white' : 'var(--b4-text)',
              fontWeight: 600, fontSize: 14, cursor: 'pointer'
            }}
          >
            {t === 'fund' ? '⬇ Fund' : '⬆ Withdraw'}
          </button>
        ))}
      </div>

      {tab === 'fund'
        ? <FundView w={w} copy={copy} copied={copied} onRefresh={load} />
        : <WithdrawView w={w} onSent={load} />}
    </div>
  )
}

function FundView({ w, copy, copied, onRefresh }:
  { w: WalletInfo; copy: (s: string) => void; copied: boolean; onRefresh: () => void }) {
  return (
    <div>
      <div style={{
        background: '#3f1d1d', border: '1px solid #7f1d1d',
        borderRadius: 10, padding: 12, marginBottom: 14, fontSize: 12, lineHeight: 1.5
      }}>
        ⚠️ Send <b>USDT (BEP-20)</b> on <b>BNB Smart Chain only</b>.<br />
        Wrong network = lost funds. No exceptions.
      </div>

      <div className="card" style={{ textAlign: 'center', marginBottom: 14 }}>
        <img
          src={w.qrDataUrl}
          alt="Deposit QR"
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

    setSubmitting(true)
    setResult(null)
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
        <div style={{
          background: '#3f2d10', border: '1px solid #92400e',
          borderRadius: 10, padding: 12, marginBottom: 14, fontSize: 12, lineHeight: 1.5
        }}>
          ⚠️ You need a small amount of <b>BNB</b> in this wallet to pay gas.
          Send ~0.001 BNB to your deposit address before withdrawing.
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
            onClick={() => setAmount(Math.max(0, w.balances.usdt).toFixed(2))}
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
