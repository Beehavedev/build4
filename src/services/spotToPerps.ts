// Pure, dependency-injected logic for the POST /api/hyperliquid/spot-to-perps
// endpoint. Lives here (not inline in server.ts) so the four interesting
// branches — concurrency lock, decrypt-candidate loop, amount resolution,
// transferSpotPerp success/failure — are testable without booting Express
// or shipping a real Hyperliquid SDK call.
//
// The route handler in server.ts is now a thin wrapper around `runSpotToPerps`
// that just maps Express req → args and the result → res.status().json().
// Keep behavior changes here (NOT in server.ts) so tests stay the source of
// truth.

export interface SpotToPerpsWallet {
  address:      string
  encryptedPK:  string
  // Some legacy wallets were encrypted under wallet.userId rather than the
  // current User.id. We pass it through so the candidate loop matches the
  // /hyperliquid/approve endpoint exactly.
  userId:       string
}

export interface SpotToPerpsUser {
  id:          string
  // Telegram numeric ID — historical encryption convention. Stringified
  // before being added to the candidate set.
  telegramId?: string | number | null
}

export interface SpotToPerpsDeps {
  findActiveWallet:     (userId: string) => Promise<SpotToPerpsWallet | null>
  // decryptPrivateKey may throw (bad key / wrong candidate); the loop
  // catches and tries the next candidate.
  decryptPrivateKey:    (encrypted: string, candidate: string) => string
  getSpotUsdcBalance:   (address: string) => Promise<number>
  transferSpotPerp:     (pk: string, amountUsd: number, toPerp: boolean)
                          => Promise<{ success: boolean; error?: string; unifiedAccount?: boolean }>
  // Called once when HL rejects the transfer with "Action disabled when
  // unified account is active". Best-effort persistence — failures are
  // swallowed so the user still gets the error response. Optional so
  // tests don't have to wire it.
  markUnifiedAccount?:  (userId: string) => Promise<void>
}

export interface SpotToPerpsResult {
  status: number
  body: {
    success:        boolean
    amount?:        number
    error?:         string
    // Surfaced to the mini-app so the wallet-recovery banner can light up
    // instead of just toasting a generic error.
    needsRecovery?: boolean
    // Surfaced to the mini-app so it can immediately suppress the
    // move-to-perps CTA for the rest of the session without waiting for
    // the next /account poll to pick up the persisted flag.
    unifiedAccount?: boolean
  }
}

// Per-user mutex set. Module-scoped so the same lock backs both the live
// Express route and any tests that exercise concurrent calls. Exported only
// for tests that want to assert it was released.
export const HL_SPOT_TRANSFER_LOCKS = new Set<string>()

export async function runSpotToPerps(args: {
  user:       SpotToPerpsUser
  // Raw request body value. May be undefined / null / 0 / number / string.
  // Normalised inside.
  rawAmount:  unknown
  deps:       SpotToPerpsDeps
}): Promise<SpotToPerpsResult> {
  const { user, rawAmount, deps } = args

  // ── Per-user mutex ────────────────────────────────────────────────────
  // The "Move to Perps" button is async + easy to double-tap in Telegram's
  // webview. Without this guard, the second tap would read the same
  // `available` balance and fire a second transfer with a different nonce
  // — burning gas/time and sometimes causing HL to reject the second mid-
  // flight. 429 (rather than 409) so the mini-app's existing "rate-limited,
  // retry shortly" toast handler picks it up automatically.
  if (HL_SPOT_TRANSFER_LOCKS.has(user.id)) {
    return {
      status: 429,
      body: {
        success: false,
        error:   'Transfer already in progress. Hold on a few seconds and try again.',
      },
    }
  }
  HL_SPOT_TRANSFER_LOCKS.add(user.id)
  try {
    const wallet = await deps.findActiveWallet(user.id)
    if (!wallet) {
      return { status: 404, body: { success: false, error: 'No active wallet' } }
    }

    // ── Master-PK decrypt candidate loop ──────────────────────────────
    // Use the *full* candidate set (user.id, telegramId, wallet.userId) so
    // users encrypted under any historical convention can use this. A
    // failure on every candidate means the wallet is in the broken-
    // encryption set → surface needsRecovery so the mini-app can show the
    // wallet-recovery banner instead of a generic 500 toast.
    const idCandidates = Array.from(new Set([
      user.id,
      user.telegramId != null ? String(user.telegramId) : null,
      wallet.userId,
    ].filter((v): v is string => Boolean(v))))
    let userPk: string | null = null
    for (const candidate of idCandidates) {
      try {
        const out = deps.decryptPrivateKey(wallet.encryptedPK, candidate)
        if (out?.startsWith('0x')) { userPk = out; break }
      } catch { /* try next candidate */ }
    }
    if (!userPk) {
      console.error(
        `[/hyperliquid/spot-to-perps] decrypt wallet PK failed user=${user.id} ` +
        `tg=${user.telegramId} wallet=${wallet.address}`,
      )
      return {
        status: 400,
        body: {
          success:        false,
          needsRecovery:  true,
          error: 'Could not decrypt wallet. Use Admin → Wallet recovery to re-encrypt your private key, then try again.',
        },
      }
    }

    // ── Resolve transfer amount ───────────────────────────────────────
    // omit / 0 → move full available spot USDC. Cap requested to available
    // so we never send a request HL will reject. Validate the input is a
    // finite number (defensive — `transferSpotPerp` also guards).
    const requested = rawAmount == null ? 0 : Number(rawAmount)
    if (!Number.isFinite(requested) || requested < 0) {
      return {
        status: 400,
        body: { success: false, error: 'amount must be a non-negative number' },
      }
    }
    const available = await deps.getSpotUsdcBalance(wallet.address)
    if (available < 0.01) {
      return {
        status: 400,
        body: {
          success: false,
          error: `No USDC on the HL spot account (${wallet.address}). Bridge USDC into Hyperliquid first.`,
        },
      }
    }
    const amount = requested > 0 ? Math.min(requested, available) : available

    const result = await deps.transferSpotPerp(userPk, amount, true)
    if (!result.success) {
      // HL refused — was it the unified-account block? If so, persist the
      // flag so the UI stops offering the CTA on the next /account poll
      // even if the user never retries the transfer. Best-effort; a DB
      // hiccup mustn't swallow the user's actual error response.
      if (result.unifiedAccount && deps.markUnifiedAccount) {
        try { await deps.markUnifiedAccount(user.id) }
        catch (e: any) {
          console.warn(`[/hyperliquid/spot-to-perps] markUnifiedAccount failed user=${user.id}: ${e?.message}`)
        }
      }
      return {
        status: 502,
        body: {
          success:        false,
          error:          result.error ?? 'transfer failed',
          unifiedAccount: result.unifiedAccount || undefined,
        },
      }
    }

    console.log(
      `[/hyperliquid/spot-to-perps] user=${user.id} tg=${user.telegramId} ` +
      `wallet=${wallet.address} moved=$${amount.toFixed(2)} (of $${available.toFixed(2)} available)`,
    )
    return { status: 200, body: { success: true, amount } }
  } finally {
    HL_SPOT_TRANSFER_LOCKS.delete(user.id)
  }
}
