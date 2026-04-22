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
