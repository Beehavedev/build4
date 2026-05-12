import { useState, useRef, type DragEvent, type ChangeEvent } from 'react'

// four.meme token launcher — mirrors POST /api/fourmeme/launch.
// Validation rules mirror validateLaunchParams() in
// src/services/fourMemeLaunch.ts so the user sees the same errors
// client-side that the server would otherwise reject with 400.

function tgHeaders(extra?: Record<string, string>): Record<string, string> {
  const initData: string = (window as any)?.Telegram?.WebApp?.initData ?? ''
  return {
    ...(extra ?? {}),
    ...(initData ? { 'X-Telegram-Init-Data': initData } : {}),
  }
}

interface LaunchResponse {
  ok: boolean
  txHash?: string
  tokenAddress?: string | null
  launchUrl?: string
  initialBuyBnb?: string
  imageUrl?: string | null
  walletAddress?: string
  error?: string
  code?: string
}

// Mirrors validateLaunchParams() in src/services/fourMemeLaunch.ts.
// Server is authoritative — these checks just spare the user a round
// trip and let us disable the submit button until the form is valid.
function validateClient(name: string, symbol: string, bnb: string): string | null {
  const n = name.trim()
  const s = symbol.trim()
  if (n.length < 2 || n.length > 100) return 'Name must be 2–100 characters'
  if (s.length < 1 || s.length > 10) return 'Symbol must be 1–10 characters'
  if (!/^[a-zA-Z0-9$]+$/.test(s)) return 'Symbol must be alphanumeric (or $)'
  if (bnb !== '') {
    const v = Number(bnb)
    if (!Number.isFinite(v) || v < 0) return 'Initial buy must be ≥ 0 BNB'
    if (v > 5) return 'Initial buy cannot exceed 5 BNB'
  }
  return null
}

// File → base64 (no data: prefix). Server accepts either form but we
// strip the prefix so the on-the-wire payload is the smallest possible.
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const idx = result.indexOf(',')
      resolve(idx >= 0 ? result.substring(idx + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'))
    reader.readAsDataURL(file)
  })
}

export default function LaunchToken() {
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [description, setDescription] = useState('')
  const [initialBuyBnb, setInitialBuyBnb] = useState('0')
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [logoPreview, setLogoPreview] = useState<string | null>(null)
  const [logoError, setLogoError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<LaunchResponse | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const clientError = validateClient(name, symbol, initialBuyBnb)
  const canSubmit = !submitting && !clientError && !logoError

  function handleFile(file: File | null) {
    setLogoError(null)
    if (!file) {
      setLogoFile(null)
      setLogoPreview(null)
      return
    }
    if (!/^image\//.test(file.type)) {
      setLogoError('File must be an image (PNG/JPG/WebP/GIF)')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setLogoError('Image must be ≤ 5 MB')
      return
    }
    setLogoFile(file)
    const reader = new FileReader()
    reader.onload = () => setLogoPreview(reader.result as string)
    reader.readAsDataURL(file)
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f) handleFile(f)
  }

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null
    handleFile(f)
  }

  async function submit() {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    setResult(null)
    try {
      let imageBase64: string | undefined
      if (logoFile) {
        imageBase64 = await fileToBase64(logoFile)
      }
      const res = await fetch('/api/fourmeme/launch', {
        method: 'POST',
        headers: tgHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          tokenName: name.trim(),
          tokenSymbol: symbol.trim(),
          tokenDescription: description.trim() || undefined,
          initialBuyBnb: initialBuyBnb || '0',
          imageBase64,
        }),
      })
      const json: LaunchResponse = await res.json().catch(() => ({ ok: false, error: 'invalid server response' }))
      if (!res.ok || !json.ok) {
        setError(json.error || `Launch failed (HTTP ${res.status})`)
        setResult(json)
      } else {
        setResult(json)
      }
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setSubmitting(false)
    }
  }

  function reset() {
    setResult(null)
    setError(null)
    setName('')
    setSymbol('')
    setDescription('')
    setInitialBuyBnb('0')
    setLogoFile(null)
    setLogoPreview(null)
    setLogoError(null)
  }

  // ── Success view ────────────────────────────────────────────────────
  if (result?.ok) {
    return (
      <div style={{ paddingTop: 16 }}>
        <h2 style={{ margin: '0 0 12px', color: 'var(--text-primary)' }}>Token launched</h2>
        <div
          data-testid="launch-success-card"
          style={{
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 10,
          }}
        >
          {result.imageUrl && (
            <img
              src={result.imageUrl}
              alt="token logo"
              style={{ width: 96, height: 96, borderRadius: 12, alignSelf: 'center' }}
            />
          )}
          <div data-testid="text-launch-name" style={{ color: 'var(--text-primary)', fontSize: 16, fontWeight: 600, textAlign: 'center' }}>
            {name} ({symbol})
          </div>
          {result.tokenAddress && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', wordBreak: 'break-all', textAlign: 'center' }}>
              <div>Token address</div>
              <div data-testid="text-token-address" style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>{result.tokenAddress}</div>
            </div>
          )}
          {result.txHash && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', wordBreak: 'break-all', textAlign: 'center' }}>
              <div>Transaction</div>
              <div data-testid="text-launch-tx" style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>{result.txHash}</div>
            </div>
          )}
          {result.launchUrl && (
            <a
              href={result.launchUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="link-launch-url"
              style={{
                marginTop: 4, padding: '10px 14px', borderRadius: 8,
                background: 'var(--purple)', color: 'white', textAlign: 'center',
                textDecoration: 'none', fontWeight: 600,
              }}
            >
              View on four.meme ↗
            </a>
          )}
          <button
            type="button"
            onClick={reset}
            data-testid="button-launch-another"
            style={{
              marginTop: 4, padding: '10px 14px', borderRadius: 8,
              background: 'transparent', color: 'var(--text-primary)',
              border: '1px solid var(--border)', cursor: 'pointer', fontWeight: 500,
            }}
          >
            Launch another
          </button>
        </div>
      </div>
    )
  }

  // ── Form view ───────────────────────────────────────────────────────
  return (
    <div style={{ paddingTop: 16, paddingBottom: 24 }}>
      <h2 style={{ margin: '0 0 4px', color: 'var(--text-primary)' }}>Launch token</h2>
      <p style={{ margin: '0 0 16px', color: 'var(--text-secondary)', fontSize: 13 }}>
        Create a new four.meme token from your BSC wallet. You'll pay BNB
        for gas and any optional initial buy.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Name" hint="2–100 characters">
          <input
            data-testid="input-token-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Token"
            maxLength={100}
            style={inputStyle}
          />
        </Field>

        <Field label="Ticker" hint="1–10 characters, letters/numbers/$">
          <input
            data-testid="input-token-symbol"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="MYTKN"
            maxLength={10}
            style={inputStyle}
          />
        </Field>

        <Field label="Description" hint="Optional">
          <textarea
            data-testid="input-token-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What's this token about?"
            rows={3}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
          />
        </Field>

        <Field label="Logo" hint="Optional — tap to choose from camera roll or files. Max 5 MB. We'll generate one if skipped.">
          {/* iOS Safari + Telegram WebView blocks programmatic .click() on
              file inputs that use display:none, which is why the previous
              version (a <div onClick> that called fileInputRef.click())
              silently did nothing on iPhone. Wrapping the visible
              dropzone in a <label htmlFor> gives us a native click that
              the WebView always honours, and the input itself is kept
              visually-hidden (opacity:0 + position:absolute) instead of
              display:none so iOS still treats it as interactable. The
              hidden file input is rendered OUTSIDE the label so the
              Clear button's stopPropagation can't swallow it. */}
          <input
            ref={fileInputRef}
            id="launch-logo-file"
            type="file"
            accept="image/*"
            onChange={onPick}
            data-testid="input-logo-file"
            style={{
              position: 'absolute',
              width: 1, height: 1,
              padding: 0, margin: -1,
              overflow: 'hidden',
              clip: 'rect(0,0,0,0)',
              whiteSpace: 'nowrap',
              border: 0,
              opacity: 0,
            }}
          />
          <label
            htmlFor="launch-logo-file"
            data-testid="dropzone-logo"
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            style={{
              border: `1px dashed ${dragOver ? 'var(--purple)' : 'var(--border)'}`,
              borderRadius: 10,
              padding: 14,
              background: dragOver ? 'rgba(139,92,246,0.08)' : 'var(--bg-card)',
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 12,
            }}
          >
            {logoPreview ? (
              <img src={logoPreview} alt="logo preview" style={{ width: 56, height: 56, borderRadius: 8, objectFit: 'cover' }} />
            ) : (
              <div style={{
                width: 56, height: 56, borderRadius: 8, background: 'var(--bg-elevated)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'var(--text-secondary)', fontSize: 24,
              }}>+</div>
            )}
            <div style={{ flex: 1, fontSize: 13, color: 'var(--text-secondary)' }}>
              {logoFile ? `${logoFile.name} (${(logoFile.size / 1024).toFixed(0)} KB)` : 'Tap to choose image'}
            </div>
            {logoFile && (
              <button
                type="button"
                // preventDefault stops the label from re-opening the file
                // picker after we clear; stopPropagation is belt-and-
                // suspenders for any wrapping click handlers.
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleFile(null) }}
                data-testid="button-clear-logo"
                style={{
                  background: 'transparent', border: '1px solid var(--border)',
                  color: 'var(--text-secondary)', borderRadius: 6, padding: '4px 8px',
                  fontSize: 12, cursor: 'pointer',
                }}
              >Clear</button>
            )}
          </label>
          {logoError && (
            <div data-testid="text-logo-error" style={{ color: 'var(--red)', fontSize: 12, marginTop: 6 }}>{logoError}</div>
          )}
        </Field>

        <Field label={`Initial buy: ${initialBuyBnb || '0'} BNB`} hint="0 – 5 BNB. Buys your own token at launch.">
          <input
            data-testid="slider-initial-buy"
            type="range"
            min={0}
            max={5}
            step={0.01}
            value={Number(initialBuyBnb) || 0}
            onChange={(e) => setInitialBuyBnb(e.target.value)}
            style={{ width: '100%' }}
          />
          <input
            data-testid="input-initial-buy"
            type="number"
            min={0}
            max={5}
            step={0.01}
            value={initialBuyBnb}
            onChange={(e) => setInitialBuyBnb(e.target.value)}
            style={{ ...inputStyle, marginTop: 6 }}
          />
        </Field>

        {clientError && (
          <div data-testid="text-validation-error" style={{ color: 'var(--red)', fontSize: 12 }}>
            {clientError}
          </div>
        )}
        {error && (
          <div
            data-testid="text-launch-error"
            style={{
              color: 'var(--red)', fontSize: 13, padding: 10,
              border: '1px solid var(--red)', borderRadius: 8,
              background: 'rgba(239,68,68,0.06)',
            }}
          >
            {error}
          </div>
        )}

        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          data-testid="button-launch-submit"
          style={{
            padding: '12px 16px', borderRadius: 10, border: 'none',
            background: canSubmit ? 'var(--purple)' : 'var(--bg-elevated)',
            color: canSubmit ? 'white' : 'var(--text-secondary)',
            fontWeight: 600, fontSize: 15, cursor: canSubmit ? 'pointer' : 'not-allowed',
          }}
        >
          {submitting ? 'Launching… (this can take ~30s)' : 'Launch token'}
        </button>
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid var(--border)',
  background: 'var(--bg-card)',
  color: 'var(--text-primary)',
  fontSize: 14,
  boxSizing: 'border-box',
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{label}</span>
      {hint && <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{hint}</span>}
      {children}
    </label>
  )
}
