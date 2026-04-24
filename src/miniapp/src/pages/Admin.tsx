import { useEffect, useState } from 'react'
import { apiFetch } from '../api'

interface CostRate {
  provider: string
  usdPer1MTokens: number
  updatedAt: string | null
  updatedBy: string | null
  isDefault: boolean
  defaultUsdPer1MTokens: number | null
}

interface BroadcastJobStatus {
  id:         string
  startedAt:  number
  finishedAt: number | null
  total:      number
  sent:       number
  blocked:    number
  failed:     number
  dryRun:     boolean
  message:    string
  buttonText: string | null
  buttonUrl:  string | null
  parseMode:  'Markdown' | 'HTML' | null
  lastError:  string | null
  cancelled:  boolean
}

function BroadcastPanel() {
  const [message, setMessage]       = useState('')
  const [parseMode, setParseMode]   = useState<'none' | 'Markdown' | 'HTML'>('Markdown')
  const [buttonText, setButtonText] = useState('')
  const [buttonUrl, setButtonUrl]   = useState('')
  const [dryRun, setDryRun]         = useState(true)
  const [job, setJob]               = useState<BroadcastJobStatus | null>(null)
  const [err, setErr]               = useState<string | null>(null)
  const [busy, setBusy]             = useState(false)

  const refresh = async () => {
    try {
      const r = await apiFetch<{ job: BroadcastJobStatus | null }>('/api/admin/broadcast/status')
      setJob(r.job)
    } catch {}
  }
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 2000)
    return () => clearInterval(t)
  }, [])

  const send = async () => {
    setErr(null)
    if (!message.trim()) return setErr('Message is required')
    if ((buttonText && !buttonUrl) || (!buttonText && buttonUrl)) {
      return setErr('Button text and URL must both be set, or both empty')
    }
    if (!dryRun && !confirm(`Send to ALL users (live)? This cannot be undone.`)) return
    setBusy(true)
    try {
      const r = await apiFetch<{ success: boolean; error?: string; job?: BroadcastJobStatus }>(
        '/api/admin/broadcast',
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message,
            parseMode:  parseMode === 'none' ? null : parseMode,
            buttonText: buttonText || null,
            buttonUrl:  buttonUrl  || null,
            dryRun,
          }),
        },
      )
      if (!r.success) {
        setErr(r.error ?? 'Broadcast failed')
      } else if (r.job) {
        setJob(r.job)
      }
    } catch (e: any) {
      setErr(e?.message ?? 'Broadcast failed')
    } finally {
      setBusy(false)
    }
  }

  const cancel = async () => {
    try {
      await apiFetch('/api/admin/broadcast/cancel', { method: 'POST' })
      await refresh()
    } catch {}
  }

  const running = job && !job.finishedAt
  const pct = job && job.total > 0
    ? Math.round(((job.sent + job.blocked + job.failed) / job.total) * 100)
    : 0

  return (
    <div
      data-testid="card-broadcast"
      style={{
        background: '#12121a', border: '1px solid #1e1e2e', borderRadius: 10,
        padding: 14, marginBottom: 20,
      }}
    >
      <h2 style={{ color: '#fff', margin: '0 0 4px', fontSize: 18 }}>📣 Broadcast</h2>
      <p style={{ color: '#94a3b8', fontSize: 12, margin: '0 0 12px' }}>
        Send a Telegram message to every user. Paced ~25/sec — full fan-out takes
        ~10 min. Blocked users are auto-skipped on future sends.
      </p>

      {err && (
        <div
          data-testid="text-broadcast-error"
          style={{
            background: '#3b1818', color: '#fca5a5',
            padding: '8px 12px', borderRadius: 6, marginBottom: 10, fontSize: 12,
          }}
        >
          {err}
        </div>
      )}

      <textarea
        data-testid="textarea-broadcast-message"
        placeholder="Your message — supports Markdown by default"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={6}
        style={{
          width: '100%', padding: 10, background: '#0a0a12',
          border: '1px solid #1e1e2e', color: '#fff', borderRadius: 6,
          fontSize: 13, fontFamily: 'inherit', resize: 'vertical',
          boxSizing: 'border-box', marginBottom: 8,
        }}
      />

      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>Format:</span>
        {(['Markdown', 'HTML', 'none'] as const).map(m => (
          <button
            key={m}
            onClick={() => setParseMode(m)}
            data-testid={`button-parsemode-${m}`}
            style={{
              padding: '4px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
              background: parseMode === m ? '#7c3aed' : '#0a0a12',
              border: `1px solid ${parseMode === m ? '#7c3aed' : '#1e1e2e'}`,
              color: '#fff',
            }}
          >
            {m}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input
          data-testid="input-broadcast-button-text"
          placeholder="Button text (optional)"
          value={buttonText}
          onChange={(e) => setButtonText(e.target.value)}
          style={{
            flex: 1, padding: '8px 10px', background: '#0a0a12',
            border: '1px solid #1e1e2e', color: '#fff', borderRadius: 6, fontSize: 13,
            boxSizing: 'border-box',
          }}
        />
        <input
          data-testid="input-broadcast-button-url"
          placeholder="Button URL (https://…)"
          value={buttonUrl}
          onChange={(e) => setButtonUrl(e.target.value)}
          style={{
            flex: 2, padding: '8px 10px', background: '#0a0a12',
            border: '1px solid #1e1e2e', color: '#fff', borderRadius: 6, fontSize: 13,
            boxSizing: 'border-box',
          }}
        />
      </div>

      <label
        style={{
          display: 'flex', alignItems: 'center', gap: 8, fontSize: 12,
          color: dryRun ? '#94a3b8' : '#ef4444', marginBottom: 12, cursor: 'pointer',
        }}
        data-testid="label-broadcast-dryrun"
      >
        <input
          type="checkbox"
          checked={dryRun}
          onChange={(e) => setDryRun(e.target.checked)}
          data-testid="checkbox-broadcast-dryrun"
        />
        {dryRun
          ? 'Dry run — counts users only, sends nothing'
          : '⚠ LIVE — will message every user'}
      </label>

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          data-testid="button-broadcast-send"
          onClick={send}
          disabled={busy || !!running}
          style={{
            flex: 1, padding: '10px', borderRadius: 6, fontSize: 13, fontWeight: 600,
            background: running ? '#1e1e2e' : dryRun ? '#3b82f6' : '#dc2626',
            border: 'none', color: '#fff',
            cursor: busy || running ? 'not-allowed' : 'pointer',
          }}
        >
          {busy ? 'Starting…' : running ? 'In progress' : dryRun ? 'Run dry count' : 'SEND LIVE'}
        </button>
        {running && (
          <button
            data-testid="button-broadcast-cancel"
            onClick={cancel}
            style={{
              padding: '10px 16px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
              background: '#1e1e2e', border: '1px solid #ef4444', color: '#ef4444',
            }}
          >
            Cancel
          </button>
        )}
      </div>

      {job && (
        <div
          data-testid="card-broadcast-status"
          style={{
            marginTop: 12, padding: 10, background: '#0a0a12',
            border: '1px solid #1e1e2e', borderRadius: 6, fontSize: 12,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ color: '#94a3b8' }}>
              {running ? '▶ Running' : '✓ Finished'}
              {job.dryRun && ' (dry run)'}
              {job.cancelled && ' (cancelled)'}
            </span>
            <span style={{ color: '#64748b', fontFamily: 'ui-monospace, monospace' }}>
              {job.id}
            </span>
          </div>
          <div style={{ height: 6, background: '#1e1e2e', borderRadius: 3, overflow: 'hidden', marginBottom: 8 }}>
            <div style={{
              width: `${pct}%`, height: '100%',
              background: running ? '#3b82f6' : '#10b981',
              transition: 'width 0.3s',
            }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#e2e8f0' }}>
            <span data-testid="text-broadcast-sent">✓ {job.sent} sent</span>
            <span data-testid="text-broadcast-blocked" style={{ color: '#94a3b8' }}>
              ⊘ {job.blocked} blocked
            </span>
            <span data-testid="text-broadcast-failed" style={{ color: job.failed > 0 ? '#ef4444' : '#94a3b8' }}>
              ✗ {job.failed} failed
            </span>
            <span style={{ color: '#64748b' }}>{job.total} total</span>
          </div>
          {job.lastError && (
            <div style={{ marginTop: 6, color: '#ef4444', fontSize: 11 }}>
              Last error: {job.lastError}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function Admin() {
  const [rates, setRates] = useState<CostRate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [newProvider, setNewProvider] = useState('')
  const [newRate, setNewRate] = useState('')

  const reload = async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<{ rates: CostRate[] }>('/api/admin/cost-rates')
      setRates(data.rates)
      setDrafts(
        Object.fromEntries(data.rates.map((r) => [r.provider, String(r.usdPer1MTokens)])),
      )
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    reload()
  }, [])

  const save = async (provider: string) => {
    const value = Number(drafts[provider])
    if (!Number.isFinite(value) || value < 0) {
      setError('Enter a non-negative number')
      return
    }
    setSaving(provider)
    setError(null)
    try {
      await apiFetch(`/api/admin/cost-rates/${encodeURIComponent(provider)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usdPer1MTokens: value }),
      })
      await reload()
    } catch (err: any) {
      setError(err?.message ?? 'Save failed')
    } finally {
      setSaving(null)
    }
  }

  const revert = async (provider: string) => {
    setSaving(provider)
    setError(null)
    try {
      await apiFetch(`/api/admin/cost-rates/${encodeURIComponent(provider)}`, {
        method: 'DELETE',
      })
      await reload()
    } catch (err: any) {
      setError(err?.message ?? 'Revert failed')
    } finally {
      setSaving(null)
    }
  }

  const addNew = async () => {
    const provider = newProvider.trim().toLowerCase()
    const value = Number(newRate)
    if (!provider) return setError('Provider required')
    if (!Number.isFinite(value) || value < 0) return setError('Enter a non-negative number')
    setSaving(provider)
    setError(null)
    try {
      await apiFetch(`/api/admin/cost-rates/${encodeURIComponent(provider)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usdPer1MTokens: value }),
      })
      setNewProvider('')
      setNewRate('')
      await reload()
    } catch (err: any) {
      setError(err?.message ?? 'Save failed')
    } finally {
      setSaving(null)
    }
  }

  return (
    <div style={{ padding: '16px 0' }} data-testid="page-admin">
      <BroadcastPanel />

      <BuybackAdminPanel />

      <h2 style={{ color: '#fff', margin: '0 0 8px' }}>AI Cost Rates</h2>
      <p style={{ color: '#94a3b8', fontSize: 13, margin: '0 0 16px' }}>
        USD per 1M tokens used to estimate spend in /swarmstats. Defaults are baked
        into the code; values you save here override them without a redeploy.
      </p>

      {error && (
        <div
          data-testid="text-admin-error"
          style={{
            background: '#3b1818',
            color: '#fca5a5',
            padding: '8px 12px',
            borderRadius: 8,
            marginBottom: 12,
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ color: '#94a3b8' }}>Loading…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rates.map((r) => (
            <div
              key={r.provider}
              data-testid={`row-cost-rate-${r.provider}`}
              style={{
                background: '#12121a',
                border: '1px solid #1e1e2e',
                borderRadius: 10,
                padding: 12,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 6,
                }}
              >
                <strong style={{ color: '#fff' }} data-testid={`text-provider-${r.provider}`}>
                  {r.provider}
                </strong>
                <span style={{ fontSize: 11, color: r.isDefault ? '#64748b' : '#7c3aed' }}>
                  {r.isDefault
                    ? `default${r.defaultUsdPer1MTokens != null ? ` ($${r.defaultUsdPer1MTokens})` : ''}`
                    : 'override'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ color: '#94a3b8', fontSize: 13 }}>$</span>
                <input
                  data-testid={`input-rate-${r.provider}`}
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={drafts[r.provider] ?? ''}
                  onChange={(e) =>
                    setDrafts((d) => ({ ...d, [r.provider]: e.target.value }))
                  }
                  style={{
                    flex: 1,
                    padding: '6px 8px',
                    background: '#0a0a12',
                    border: '1px solid #1e1e2e',
                    color: '#fff',
                    borderRadius: 6,
                    fontSize: 14,
                  }}
                />
                <span style={{ color: '#64748b', fontSize: 12 }}>/Mtok</span>
                <button
                  data-testid={`button-save-${r.provider}`}
                  onClick={() => save(r.provider)}
                  disabled={saving === r.provider}
                  style={{
                    padding: '6px 10px',
                    background: '#7c3aed',
                    border: 'none',
                    color: '#fff',
                    borderRadius: 6,
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  Save
                </button>
                {!r.isDefault && (
                  <button
                    data-testid={`button-revert-${r.provider}`}
                    onClick={() => revert(r.provider)}
                    disabled={saving === r.provider}
                    style={{
                      padding: '6px 10px',
                      background: 'transparent',
                      border: '1px solid #1e1e2e',
                      color: '#94a3b8',
                      borderRadius: 6,
                      fontSize: 12,
                      cursor: 'pointer',
                    }}
                  >
                    Revert
                  </button>
                )}
              </div>
              {r.updatedAt && (
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>
                  Updated {new Date(r.updatedAt).toLocaleString()}
                  {r.updatedBy ? ` by tg:${r.updatedBy}` : ''}
                </div>
              )}
            </div>
          ))}

          <div
            style={{
              background: '#12121a',
              border: '1px dashed #1e1e2e',
              borderRadius: 10,
              padding: 12,
              marginTop: 8,
            }}
          >
            <div style={{ color: '#94a3b8', fontSize: 12, marginBottom: 8 }}>
              Add a new provider rate
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                data-testid="input-new-provider"
                placeholder="provider"
                value={newProvider}
                onChange={(e) => setNewProvider(e.target.value)}
                style={{
                  flex: 1,
                  padding: '6px 8px',
                  background: '#0a0a12',
                  border: '1px solid #1e1e2e',
                  color: '#fff',
                  borderRadius: 6,
                  fontSize: 14,
                }}
              />
              <input
                data-testid="input-new-rate"
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                placeholder="$/Mtok"
                value={newRate}
                onChange={(e) => setNewRate(e.target.value)}
                style={{
                  width: 100,
                  padding: '6px 8px',
                  background: '#0a0a12',
                  border: '1px solid #1e1e2e',
                  color: '#fff',
                  borderRadius: 6,
                  fontSize: 14,
                }}
              />
              <button
                data-testid="button-add-rate"
                onClick={addNew}
                disabled={saving !== null}
                style={{
                  padding: '6px 12px',
                  background: '#7c3aed',
                  border: 'none',
                  color: '#fff',
                  borderRadius: 6,
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Buyback admin panel (Task #9) ─────────────────────────────────────────
// Append-only ledger of $B4 buybacks the team performs manually. Posting
// the same txHash twice is a no-op (server returns alreadyExists=true).
// Populates the public buyback card on the Home tab.

interface BuybackRow {
  id: string
  txHash: string
  chain: string
  amountB4: number
  amountUsdt: number
  note: string | null
  createdAt: string
}

interface BuybackList {
  totals: { count: number; amountB4: number; amountUsdt: number }
  recent: BuybackRow[]
}

function BuybackAdminPanel() {
  const [data, setData]   = useState<BuybackList | null>(null)
  const [err, setErr]     = useState<string | null>(null)
  const [busy, setBusy]   = useState(false)
  const [txHash, setTxHash]       = useState('')
  const [chain, setChain]         = useState<'BSC' | 'XLAYER' | 'ARBITRUM'>('BSC')
  const [amountB4, setAmountB4]   = useState('')
  const [amountUsdt, setAmountUsdt] = useState('')
  const [note, setNote]           = useState('')

  const reload = async () => {
    try {
      const r = await fetch('/api/buybacks').then((r) => r.json()) as BuybackList
      setData(r)
    } catch (e: any) {
      setErr(e?.message ?? 'load failed')
    }
  }
  useEffect(() => { reload() }, [])

  const submit = async () => {
    setErr(null)
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash.trim())) return setErr('txHash must be 0x-prefixed 64-hex')
    const b4 = Number(amountB4)
    const usdt = Number(amountUsdt)
    if (!Number.isFinite(b4) || b4 <= 0)     return setErr('amountB4 must be a positive number')
    if (!Number.isFinite(usdt) || usdt <= 0) return setErr('amountUsdt must be a positive number')
    setBusy(true)
    try {
      const r = await apiFetch<{ success: boolean; alreadyExists?: boolean; error?: string }>(
        '/api/admin/buybacks',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ txHash: txHash.trim(), chain, amountB4: b4, amountUsdt: usdt, note: note || null }),
        },
      )
      if (!r.success) {
        setErr(r.error ?? 'Save failed')
      } else {
        if (!r.alreadyExists) {
          setTxHash(''); setAmountB4(''); setAmountUsdt(''); setNote('')
        } else {
          setErr('That txHash was already posted — surfacing existing row.')
        }
        await reload()
      }
    } catch (e: any) {
      setErr(e?.message ?? 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    if (!confirm('Delete this buyback record?')) return
    setBusy(true)
    try {
      await apiFetch(`/api/admin/buybacks/${encodeURIComponent(id)}`, { method: 'DELETE' })
      await reload()
    } catch (e: any) {
      setErr(e?.message ?? 'Delete failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="panel-buyback-admin" style={{ marginBottom: 24 }}>
      <h2 style={{ color: '#fff', margin: '0 0 8px' }}>$B4 Buybacks</h2>
      <p style={{ color: '#94a3b8', fontSize: 13, margin: '0 0 12px' }}>
        Append a manual buyback. The Home tab updates within seconds. Reposting the same tx is a no-op.
      </p>

      {data && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, fontSize: 13 }} data-testid="text-buyback-totals">
          <span style={{ color: '#94a3b8' }}>Total bought back:</span>
          <strong style={{ color: '#fff' }}>{data.totals.amountB4.toLocaleString(undefined, { maximumFractionDigits: 2 })} $B4</strong>
          <span style={{ color: '#94a3b8' }}>·</span>
          <strong style={{ color: '#fff' }}>${data.totals.amountUsdt.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong>
          <span style={{ color: '#64748b' }}>({data.totals.count} txs)</span>
        </div>
      )}

      {err && (
        <div data-testid="text-buyback-error" style={{
          background: '#3b1818', color: '#fca5a5',
          padding: '8px 12px', borderRadius: 8, marginBottom: 12, fontSize: 13,
        }}>{err}</div>
      )}

      <div style={{
        background: '#12121a', border: '1px solid #1e1e2e', borderRadius: 10,
        padding: 12, marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        <input
          data-testid="input-buyback-txhash"
          placeholder="txHash (0x… 64-hex)"
          value={txHash}
          onChange={(e) => setTxHash(e.target.value)}
          style={{
            padding: '6px 8px', background: '#0a0a12', border: '1px solid #1e1e2e',
            color: '#fff', borderRadius: 6, fontSize: 13, fontFamily: 'ui-monospace, Menlo, monospace',
          }}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <select
            data-testid="select-buyback-chain"
            value={chain}
            onChange={(e) => setChain(e.target.value as any)}
            style={{
              padding: '6px 8px', background: '#0a0a12', border: '1px solid #1e1e2e',
              color: '#fff', borderRadius: 6, fontSize: 13,
            }}
          >
            <option value="BSC">BSC</option>
            <option value="XLAYER">XLayer</option>
            <option value="ARBITRUM">Arbitrum</option>
          </select>
          <input
            data-testid="input-buyback-amount-b4"
            type="number" inputMode="decimal" min="0" step="0.01" placeholder="amount $B4"
            value={amountB4}
            onChange={(e) => setAmountB4(e.target.value)}
            style={{
              flex: 1, padding: '6px 8px', background: '#0a0a12', border: '1px solid #1e1e2e',
              color: '#fff', borderRadius: 6, fontSize: 13,
            }}
          />
          <input
            data-testid="input-buyback-amount-usdt"
            type="number" inputMode="decimal" min="0" step="0.01" placeholder="USDT spent"
            value={amountUsdt}
            onChange={(e) => setAmountUsdt(e.target.value)}
            style={{
              flex: 1, padding: '6px 8px', background: '#0a0a12', border: '1px solid #1e1e2e',
              color: '#fff', borderRadius: 6, fontSize: 13,
            }}
          />
        </div>
        <input
          data-testid="input-buyback-note"
          placeholder="note (optional)"
          maxLength={280}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          style={{
            padding: '6px 8px', background: '#0a0a12', border: '1px solid #1e1e2e',
            color: '#fff', borderRadius: 6, fontSize: 13,
          }}
        />
        <button
          data-testid="button-buyback-submit"
          onClick={submit}
          disabled={busy}
          style={{
            padding: '8px 12px', background: '#7c3aed', border: 'none',
            color: '#fff', borderRadius: 6, fontSize: 13, cursor: busy ? 'wait' : 'pointer',
          }}
        >
          {busy ? 'Saving…' : 'Append buyback'}
        </button>
      </div>

      {data?.recent && data.recent.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {data.recent.map((b) => (
            <div
              key={b.id}
              data-testid={`row-admin-buyback-${b.id}`}
              style={{
                background: '#12121a', border: '1px solid #1e1e2e', borderRadius: 8,
                padding: '8px 12px', display: 'flex', justifyContent: 'space-between',
                alignItems: 'center', gap: 8, fontSize: 12,
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
                <div style={{ color: '#fff', fontWeight: 600 }}>
                  {b.amountB4.toLocaleString(undefined, { maximumFractionDigits: 2 })} $B4
                  <span style={{ color: '#94a3b8', fontWeight: 400 }}> · ${b.amountUsdt.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                  <span style={{ color: '#64748b', fontSize: 11, marginLeft: 6 }}>{b.chain}</span>
                </div>
                <div style={{
                  color: '#64748b', fontFamily: 'ui-monospace, Menlo, monospace',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{b.txHash}</div>
                {b.note && <div style={{ color: '#94a3b8' }}>{b.note}</div>}
              </div>
              <button
                data-testid={`button-buyback-delete-${b.id}`}
                onClick={() => remove(b.id)}
                disabled={busy}
                style={{
                  padding: '4px 10px', background: 'transparent',
                  border: '1px solid #1e1e2e', color: '#fca5a5', borderRadius: 6,
                  fontSize: 11, cursor: busy ? 'wait' : 'pointer',
                }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
