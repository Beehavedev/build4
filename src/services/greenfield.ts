/**
 * BNB Greenfield mirror for agent memory (Phase 2 of BNBAgent SDK integration).
 *
 * Each `saveMemory()` call optionally mirrors the memory record to a
 * decentralized object on BNB Greenfield, so an agent's long-term memory
 * lives on-chain (verifiable) in addition to Postgres (queryable).
 *
 * STATUS (2026-05-19): scaffolding shipped, kill switch OFF.
 *   - The wiring from saveMemory() → mirrorMemoryAsync() is live.
 *   - The actual createObject + uploadObject calls below are correct
 *     against the documented Greenfield API but @bnb-chain/greenfield-js-sdk
 *     v2.2.2 has (a) an ESM resolver bug (`Cannot find module ...
 *     google/protobuf/any`) and (b) accepts MsgCreateObject.payloadSize
 *     as `Long`, not `BigInt`. These need to be resolved upstream OR
 *     swapped for a hand-rolled MsgCreateObject before flipping
 *     GREENFIELD_ENABLED=true. Until then this module is a no-op and
 *     the bot behaves identically to before Phase 2.
 *
 * DESIGN: This module is hard-killswitched and fail-safe by design.
 * The bot earns real money — under no circumstance should a Greenfield
 * outage, misconfig, or SDK regression break a memory write. Every
 * public function:
 *   - returns `{ ok: false, reason: 'disabled' }` immediately if any
 *     required env var is missing
 *   - never throws (errors are caught and logged)
 *   - lazy-imports the SDK so the bot starts fine even if the package
 *     has a runtime issue
 *
 * ACTIVATION (manual one-time setup by operator, once SDK is unblocked):
 *   1. Bridge a small amount of BNB from BSC → Greenfield via
 *      https://greenfield.bnbchain.org/en/bridge
 *   2. Pick a Storage Provider (https://dcellar.io/sps) and create a
 *      bucket (e.g. `build4-agent-memory`).
 *   3. Set these env vars / secrets:
 *        - GREENFIELD_ENABLED=true        (hard switch, must be exactly "true")
 *        - GREENFIELD_ACCOUNT_PK=0x...    (secret: PK of the funded Greenfield acct)
 *        - GREENFIELD_ACCOUNT_ADDR=0x...  (matching public address)
 *        - GREENFIELD_BUCKET=build4-agent-memory
 *        - GREENFIELD_RPC_URL=https://greenfield-chain.bnbchain.org
 *        - GREENFIELD_CHAIN_ID=greenfield_1017-1
 *        - GREENFIELD_SP_ENDPOINT=https://gnfd-mainnet-sp1.bnbchain.org   (chosen SP)
 *        - GREENFIELD_SP_ADDR=0x...                                       (chosen SP operator addr)
 *
 * Until those are set, all mirror calls are no-ops (logged once at boot).
 */

type MirrorResult =
  | { ok: true; objectName: string; txHash: string }
  | { ok: false; reason: string }

const REQUIRED_ENV = [
  'GREENFIELD_ENABLED',
  'GREENFIELD_ACCOUNT_PK',
  'GREENFIELD_ACCOUNT_ADDR',
  'GREENFIELD_BUCKET',
  'GREENFIELD_RPC_URL',
  'GREENFIELD_CHAIN_ID',
  'GREENFIELD_SP_ENDPOINT',
  'GREENFIELD_SP_ADDR',
] as const

let cachedClient: any | null = null
let bootLogged = false

function isEnabled(): { ok: true } | { ok: false; missing: string[] } {
  if ((process.env.GREENFIELD_ENABLED || '').trim() !== 'true') {
    return { ok: false, missing: ['GREENFIELD_ENABLED'] }
  }
  const missing = REQUIRED_ENV.filter(
    (k) => k !== 'GREENFIELD_ENABLED' && !(process.env[k] || '').trim()
  )
  if (missing.length > 0) return { ok: false, missing }
  return { ok: true }
}

function logBootOnce(): void {
  if (bootLogged) return
  bootLogged = true
  const status = isEnabled()
  if (status.ok) {
    console.log(
      `[Greenfield] enabled — bucket=${process.env.GREENFIELD_BUCKET} sp=${process.env.GREENFIELD_SP_ENDPOINT}`
    )
  } else {
    console.log(
      `[Greenfield] disabled (missing: ${status.missing.join(', ')}) — memory mirror is off, bot runs normally`
    )
  }
}

async function getClient(): Promise<any | null> {
  if (cachedClient) return cachedClient
  try {
    // Lazy import: keeps the bot bootable even if the SDK fails to load
    // (heavy native deps, WASM, etc.).
    const mod = await import('@bnb-chain/greenfield-js-sdk')
    const Client = (mod as any).Client
    if (!Client?.create) {
      console.error('[Greenfield] SDK loaded but Client.create not found')
      return null
    }
    cachedClient = Client.create(
      process.env.GREENFIELD_RPC_URL!,
      process.env.GREENFIELD_CHAIN_ID!
    )
    return cachedClient
  } catch (err: any) {
    console.error('[Greenfield] failed to init SDK client:', err?.message ?? err)
    return null
  }
}

/**
 * Mirror a single memory record to a Greenfield object.
 *
 * Object naming convention: `<agentId>/<timestamp>-<memoryId>.json`
 *   - sortable by upload time
 *   - per-agent folder for easy listing
 *
 * Returns `{ ok: true, objectName, txHash }` on success so the caller
 * can store the reference in `agentMemory.metadata`. Returns
 * `{ ok: false, reason }` otherwise; the caller should NOT treat this
 * as fatal — Postgres is the source of truth.
 */
export async function mirrorMemoryToGreenfield(args: {
  agentId: string
  memoryId: string
  type: string
  content: string
  metadata: Record<string, unknown> | null
  createdAt: Date
}): Promise<MirrorResult> {
  logBootOnce()
  const status = isEnabled()
  if (!status.ok) return { ok: false, reason: `disabled: ${status.missing.join(',')}` }

  const client = await getClient()
  if (!client) return { ok: false, reason: 'sdk_init_failed' }

  try {
    const bucketName = process.env.GREENFIELD_BUCKET!
    const accountAddr = process.env.GREENFIELD_ACCOUNT_ADDR!
    const spAddr = process.env.GREENFIELD_SP_ADDR!
    const objectName = `${args.agentId}/${args.createdAt.toISOString()}-${args.memoryId}.json`

    const payload = JSON.stringify({
      agentId: args.agentId,
      memoryId: args.memoryId,
      type: args.type,
      content: args.content,
      metadata: args.metadata,
      createdAt: args.createdAt.toISOString(),
      schema: 'build4.memory.v1',
    })
    const bytes = new TextEncoder().encode(payload)

    // Compute Reed-Solomon checksums (required by createObject).
    const rsMod: any = await import('@bnb-chain/reed-solomon')
    const Rs = rsMod.ReedSolomon || rsMod.default
    const rs = new Rs()
    const expectChecksums: Uint8Array[] = await rs.encode(bytes)

    // Step 1: createObject (on-chain registration on Greenfield).
    // NOTE: SDK v2.2.2 expects MsgCreateObject.payloadSize as a Long
    // (calls `.toNumber()` internally), not BigInt. Use long.js if the
    // SDK exports it; otherwise fall back to a Long-shaped object so
    // the SDK's internal toNumber() succeeds. `primarySpAddress` is not
    // part of MsgCreateObject in v2.2.2 — the SP is resolved from
    // bucket metadata — but we still keep it in env in case the SDK
    // adds it back in a later version.
    void spAddr // reserved for future SDK versions
    const Long = (await import('long').catch(() => null))?.default
    const payloadSize = Long
      ? Long.fromNumber(bytes.length)
      : ({ toNumber: () => bytes.length, low: bytes.length, high: 0, unsigned: true } as any)
    const createTx = await client.object.createObject({
      bucketName,
      objectName,
      creator: accountAddr,
      visibility: 1, // VISIBILITY_TYPE_PUBLIC_READ
      contentType: 'application/json',
      payloadSize,
      expectChecksums,
      redundancyType: 0, // REDUNDANCY_EC_TYPE
    } as any)

    const broadcast = await createTx.broadcast({
      denom: 'BNB',
      gasLimit: 300_000,
      gasPrice: '5000000000',
      payer: accountAddr,
      granter: '',
      privateKey: process.env.GREENFIELD_ACCOUNT_PK!,
    } as any)

    const txHash: string = broadcast?.transactionHash || ''

    // Step 2: uploadObject (HTTP PUT bytes to the chosen SP).
    await client.object.uploadObject(
      {
        bucketName,
        objectName,
        body: { name: objectName, type: 'application/json', size: bytes.length, content: bytes } as any,
        txnHash: txHash,
      } as any,
      // Auth type: ECDSA with the same PK that signed the createObject tx.
      { type: 'ECDSA', privateKey: process.env.GREENFIELD_ACCOUNT_PK! } as any
    )

    return { ok: true, objectName, txHash }
  } catch (err: any) {
    // Never let Greenfield failures bubble — Postgres is source of truth.
    console.error('[Greenfield] mirror failed:', err?.message ?? err)
    return { ok: false, reason: `error: ${err?.message ?? 'unknown'}` }
  }
}

/**
 * Convenience: best-effort, fire-and-forget. Returns immediately;
 * if the mirror succeeds, runs `onSuccess` with the object reference
 * so the caller can persist it. Use this from `saveMemory`.
 */
export function mirrorMemoryAsync(
  args: Parameters<typeof mirrorMemoryToGreenfield>[0],
  onSuccess?: (ref: { objectName: string; txHash: string; bucket: string }) => void
): void {
  // Don't even start a promise chain when disabled — saves CPU & log noise.
  if (!isEnabled().ok) {
    logBootOnce()
    return
  }
  // Belt-and-suspenders error isolation: mirrorMemoryToGreenfield()
  // already swallows its own errors, but we add a terminal .catch in
  // case a future regression introduces a throw, AND we wrap onSuccess
  // (which may be async) in Promise.resolve so async rejections are
  // caught, not silently dropped to the runtime.
  mirrorMemoryToGreenfield(args)
    .then((res) => {
      if (!res.ok || !onSuccess) return
      return Promise.resolve(
        onSuccess({
          objectName: res.objectName,
          txHash: res.txHash,
          bucket: process.env.GREENFIELD_BUCKET!,
        })
      ).catch((err: any) => {
        console.error('[Greenfield] onSuccess callback rejected:', err?.message ?? err)
      })
    })
    .catch((err: any) => {
      console.error('[Greenfield] mirror chain unexpected throw:', err?.message ?? err)
    })
}

/**
 * For diagnostics / admin endpoints.
 */
export function greenfieldStatus(): { enabled: boolean; missing: string[]; bucket?: string } {
  const status = isEnabled()
  if (status.ok) {
    return { enabled: true, missing: [], bucket: process.env.GREENFIELD_BUCKET }
  }
  return { enabled: false, missing: status.missing }
}
