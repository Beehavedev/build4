// ─────────────────────────────────────────────────────────────────────────────
// Per-exchange execution adapter
//
// `tradingAgent.ts` previously hardcoded every order-placement and close site
// to Aster (services/aster). With autonomous Hyperliquid trading we need the
// SAME tick logic to dispatch to whichever venue the agent is configured for
// — without scattering `if (agent.exchange === 'hyperliquid')` checks across
// three different code paths.
//
// This module exposes two entry points — `executeOpen` and `executeClose` —
// that take the high-level intent (which agent, which side, what size, what
// brackets) and return a uniform result shape the caller can persist without
// caring about the venue. Per-venue specifics (auto-reapprove on Aster,
// builder-fee fallback on HL, balance-check semantics) live entirely behind
// these adapters.
//
// Testability: each per-venue executor (executeOpenAster, executeOpenHl,
// executeCloseAster, executeCloseHl) is exported separately and accepts a
// `services` collaborator bag so tests can inject lightweight stubs without
// any module-level mocking.
// ─────────────────────────────────────────────────────────────────────────────

import {
  resolveAgentCreds        as asterResolveAgentCreds,
  getAccountBalanceStrict  as asterGetAccountBalanceStrict,
  placeOrder               as asterPlaceOrder,
  placeOrderWithBuilderCode as asterPlaceOrderWithBuilderCode,
  placeBracketOrders       as asterPlaceBracketOrders,
  closePosition            as asterClosePosition,
  getMarkPrice             as asterGetMarkPrice,
} from '../services/aster'
import { reapproveAsterForUser } from '../services/asterReapprove'
import {
  resolveAgentCreds as hlResolveAgentCreds,
  getAccountState   as hlGetAccountState,
  placeOrder        as hlPlaceOrder,
  placeStopLoss     as hlPlaceStopLoss,
  placeTakeProfit   as hlPlaceTakeProfit,
  getMarkPrice      as hlGetMarkPrice,
  getSpotUsdcBalance as hlGetSpotUsdcBalance,
} from '../services/hyperliquid'

// ── Shared types ─────────────────────────────────────────────────────────────

/**
 * Minimal shape of a User row needed by both venues' credential resolvers.
 * Kept narrow so tests don't have to fabricate the full Prisma User type.
 */
export interface AdapterUser {
  id:                              string
  asterOnboarded?:                 boolean | null
  hyperliquidAgentAddress?:        string | null
  hyperliquidAgentEncryptedPK?:    string | null
}

export interface AdapterAgent {
  id:       string
  name:     string
  exchange: string  // 'aster' | 'hyperliquid' | 'mock' | other
}

export interface OpenDecision {
  leverage?:    number | null
  stopLoss?:    number | null
  takeProfit?:  number | null
}

export interface OpenInput {
  agent:         AdapterAgent
  dbUser:        AdapterUser | null
  userAddress:   string
  side:          'LONG' | 'SHORT'
  pair:          string
  /** Notional size in USD (e.g. $100 means $100 of exposure pre-leverage). */
  finalSize:     number
  /** Reference price used to convert USD notional to coin units. */
  currentPrice:  number
  decision:      OpenDecision
}

export type OpenResult =
  | { ok: true;  fillPrice: number; orderIdStr: string }
  | { ok: false; reason: 'mock' | 'no-creds' | 'no-balance' | 'rejected'; detail?: string; balance?: number }

export interface ClosePosition {
  id:         string
  pair:       string
  side:       string   // 'LONG' | 'SHORT' (loose typing matches Prisma row)
  entryPrice: number
  size:       number   // Notional USD at open
}

export interface CloseInput {
  agent:         AdapterAgent
  dbUser:        AdapterUser | null
  userAddress:   string
  openPos:       ClosePosition
  /** Used as exitPrice when getMarkPrice fails or in 'mock' mode. */
  fallbackPrice: number
}

export type CloseResult =
  | { ok: true;  exitPrice: number }
  | { ok: false; reason: 'mock' | 'no-creds' | 'rejected'; detail?: string }

// ── Aster collaborators (injectable for tests) ───────────────────────────────

export interface AsterOpenServices {
  resolveAgentCreds:         typeof asterResolveAgentCreds
  getAccountBalanceStrict:   typeof asterGetAccountBalanceStrict
  placeOrder:                typeof asterPlaceOrder
  placeOrderWithBuilderCode: typeof asterPlaceOrderWithBuilderCode
  placeBracketOrders:        typeof asterPlaceBracketOrders
  reapproveAsterForUser:     typeof reapproveAsterForUser
  builderAddress?:           string
  feeRate?:                  string
}

export interface AsterCloseServices {
  resolveAgentCreds: typeof asterResolveAgentCreds
  closePosition:     typeof asterClosePosition
  getMarkPrice:      typeof asterGetMarkPrice
}

const realAsterOpenServices: AsterOpenServices = {
  resolveAgentCreds:         asterResolveAgentCreds,
  getAccountBalanceStrict:   asterGetAccountBalanceStrict,
  placeOrder:                asterPlaceOrder,
  placeOrderWithBuilderCode: asterPlaceOrderWithBuilderCode,
  placeBracketOrders:        asterPlaceBracketOrders,
  reapproveAsterForUser,
  // Resolved at call time so env var changes don't get baked into a constant.
  get builderAddress() { return process.env.ASTER_BUILDER_ADDRESS },
  get feeRate()        { return process.env.ASTER_BUILDER_FEE_RATE ?? '0.0001' },
}

const realAsterCloseServices: AsterCloseServices = {
  resolveAgentCreds: asterResolveAgentCreds,
  closePosition:     asterClosePosition,
  getMarkPrice:      asterGetMarkPrice,
}

// ── Hyperliquid collaborators (injectable for tests) ─────────────────────────

export interface HlOpenServices {
  resolveAgentCreds:    typeof hlResolveAgentCreds
  getAccountState:      typeof hlGetAccountState
  getSpotUsdcBalance:   typeof hlGetSpotUsdcBalance
  placeOrder:           typeof hlPlaceOrder
  placeStopLoss:        typeof hlPlaceStopLoss
  placeTakeProfit:      typeof hlPlaceTakeProfit
  getMarkPrice:         typeof hlGetMarkPrice
}

export interface HlCloseServices {
  resolveAgentCreds: typeof hlResolveAgentCreds
  placeOrder:        typeof hlPlaceOrder
  getMarkPrice:      typeof hlGetMarkPrice
}

const realHlOpenServices: HlOpenServices = {
  resolveAgentCreds:    hlResolveAgentCreds,
  getAccountState:      hlGetAccountState,
  getSpotUsdcBalance:   hlGetSpotUsdcBalance,
  placeOrder:           hlPlaceOrder,
  placeStopLoss:        hlPlaceStopLoss,
  placeTakeProfit:      hlPlaceTakeProfit,
  getMarkPrice:         hlGetMarkPrice,
}

const realHlCloseServices: HlCloseServices = {
  resolveAgentCreds: hlResolveAgentCreds,
  placeOrder:        hlPlaceOrder,
  getMarkPrice:      hlGetMarkPrice,
}

// ── Public entry points ──────────────────────────────────────────────────────

/**
 * Place an OPEN order on whatever venue the agent is configured for.
 * Returns { ok: false, reason: 'mock' } for mock-mode agents so the caller
 * can fall back to its synthetic-fill path.
 */
export async function executeOpen(input: OpenInput): Promise<OpenResult> {
  if (input.agent.exchange === 'mock') return { ok: false, reason: 'mock' }
  if (input.agent.exchange === 'hyperliquid') {
    return executeOpenHl(input, realHlOpenServices)
  }
  return executeOpenAster(input, realAsterOpenServices)
}

/**
 * Close an OPEN position on whatever venue the agent is configured for.
 * Returns { ok: false, reason: 'mock' } for mock-mode agents.
 */
export async function executeClose(input: CloseInput): Promise<CloseResult> {
  if (input.agent.exchange === 'mock') return { ok: false, reason: 'mock' }
  if (input.agent.exchange === 'hyperliquid') {
    return executeCloseHl(input, realHlCloseServices)
  }
  return executeCloseAster(input, realAsterCloseServices)
}

// ── Aster: OPEN ──────────────────────────────────────────────────────────────

export async function executeOpenAster(
  input: OpenInput,
  services: AsterOpenServices,
): Promise<OpenResult> {
  const { agent, dbUser, userAddress, side, pair, finalSize, currentPrice, decision } = input
  const creds = dbUser ? await services.resolveAgentCreds(dbUser as any, userAddress) : null
  if (!creds) return { ok: false, reason: 'no-creds' }

  // Pre-flight balance: realized losses, funding, or commission can drag
  // walletBalance below 0 and any further OPEN order will be rejected.
  // Closing existing positions is unaffected.
  try {
    const bal = await services.getAccountBalanceStrict(creds)
    if (bal.usdt <= 0) {
      return { ok: false, reason: 'no-balance', balance: bal.usdt }
    }
  } catch (balErr: any) {
    // RPC down, not onboarded yet — let the order attempt proceed; the
    // venue will reject with a clearer error than we can synthesize.
    console.warn(`[Agent ${agent.name}] Aster balance pre-check failed (${balErr?.message}), proceeding anyway`)
  }

  const sym = pair.replace(/[\/\s]/g, '').toUpperCase()
  const qty = parseFloat((finalSize / currentPrice).toFixed(6))

  try {
    let result
    if (services.builderAddress && dbUser?.asterOnboarded) {
      result = await services.placeOrderWithBuilderCode({
        symbol:         sym,
        side:           side === 'LONG' ? 'BUY' : 'SELL',
        type:           'MARKET',
        quantity:       qty,
        builderAddress: services.builderAddress,
        feeRate:        services.feeRate ?? '0.0001',
        creds,
      })
    } else {
      result = await services.placeOrder({
        symbol:   sym,
        side:     side === 'LONG' ? 'BUY' : 'SELL',
        type:     'MARKET',
        quantity: qty,
        leverage: decision.leverage ?? 1,
        creds,
      })
    }

    const fillPrice  = result.avgPrice > 0 ? result.avgPrice : currentPrice
    const orderIdStr = String(result.orderId)

    // SL+TP brackets — pass builder address through so closing fills also
    // route through BUILD4 (without it the entry collects the broker fee
    // but the exit fill bypasses it, leaking ~50% of fee revenue per trade).
    if (decision.stopLoss && decision.takeProfit) {
      try {
        await services.placeBracketOrders({
          symbol:         sym,
          side,
          stopLoss:       decision.stopLoss,
          takeProfit:     decision.takeProfit,
          quantity:       qty,
          creds,
          builderAddress: services.builderAddress,
          feeRate:        services.feeRate,
        })
      } catch (bracketErr: any) {
        // Don't fail the whole open just because brackets didn't land —
        // the position is open; the user can manage it manually if needed.
        console.warn(`[Agent ${agent.name}] Bracket placement failed: ${bracketErr?.message}`)
      }
    }
    return { ok: true, fillPrice, orderIdStr }
  } catch (execErr: any) {
    // Aster's signedPOST uses axios; on a 4xx the actual rejection reason
    // (e.g. "insufficient balance", "MIN_NOTIONAL", "would liquidate")
    // lives in err.response.data — NOT in err.message (which is just the
    // generic "Request failed with status code 400"). Without unwrapping
    // it, every order failure looks identical in logs and diagnosis is
    // impossible.
    const respBody   = execErr?.response?.data
    const respDetail = respBody
      ? (typeof respBody === 'string' ? respBody : JSON.stringify(respBody))
      : ''
    const execMsg = respDetail
      ? `${execErr?.message ?? 'request failed'} — Aster: ${respDetail}`
      : String(execErr?.message ?? '')

    // Self-heal: when Aster returns -1000 "No agent found", the user's
    // on-file agent address isn't recognised by Aster anymore. Fire
    // reapproveAsterForUser once now so the NEXT tick uses fresh creds
    // and the order succeeds.
    if (/no agent found|-1000/i.test(execMsg) && dbUser) {
      console.warn(
        `[Agent ${agent.name}] Aster reports "No agent found" — auto-reapproving for user=${dbUser.id}`,
      )
      try {
        const r = await services.reapproveAsterForUser(dbUser as any)
        console.log(
          `[Agent ${agent.name}] auto-reapprove → success=${r.success} ` +
          `agent=${r.agentAddress ?? 'n/a'} builder=${r.builderEnrolled ?? false} ` +
          `error=${r.error ?? 'none'}`,
        )
      } catch (healErr: any) {
        console.error(`[Agent ${agent.name}] auto-reapprove threw:`, healErr?.message)
      }
    }
    return { ok: false, reason: 'rejected', detail: execMsg }
  }
}

// ── Aster: CLOSE ─────────────────────────────────────────────────────────────

export async function executeCloseAster(
  input: CloseInput,
  services: AsterCloseServices,
): Promise<CloseResult> {
  const { agent, dbUser, userAddress, openPos, fallbackPrice } = input
  const creds = dbUser ? await services.resolveAgentCreds(dbUser as any, userAddress) : null
  if (!creds) return { ok: false, reason: 'no-creds' }

  let exitPrice = fallbackPrice
  try {
    const mp = await services.getMarkPrice(openPos.pair)
    if (mp.markPrice > 0) exitPrice = mp.markPrice
  } catch { /* keep fallback */ }

  try {
    const sym = openPos.pair.replace(/[\/\s]/g, '').toUpperCase()
    const contractSize = parseFloat((openPos.size / openPos.entryPrice).toFixed(6))
    // closePosition inverts side internally and sets reduceOnly=true.
    await services.closePosition(sym, openPos.side as 'LONG' | 'SHORT', contractSize, creds)
    return { ok: true, exitPrice }
  } catch (closeErr: any) {
    console.error(`[Agent ${agent.name}] Aster close failed:`, closeErr?.message)
    return { ok: false, reason: 'rejected', detail: String(closeErr?.message ?? '') }
  }
}

// ── Hyperliquid: OPEN ────────────────────────────────────────────────────────

export async function executeOpenHl(
  input: OpenInput,
  services: HlOpenServices,
): Promise<OpenResult> {
  const { agent, dbUser, userAddress, side, pair, finalSize, currentPrice, decision } = input
  const creds = dbUser ? await services.resolveAgentCreds(dbUser as any, userAddress) : null
  if (!creds) return { ok: false, reason: 'no-creds' }

  // Pre-flight: HL splits each address into SPOT and PERPS sub-accounts.
  // Funds bridged via the official HL bridge land on SPOT and have to be
  // moved to PERPS before they're tradeable. Detect "user has spot USDC
  // but perps is empty" so the operator can prompt the user to transfer
  // (we can't auto-transfer — usdClassTransfer requires the master key).
  try {
    const acct = await services.getAccountState(userAddress)
    if (acct.withdrawableUsdc <= 0) {
      let detail = ''
      try {
        const spot = await services.getSpotUsdcBalance(userAddress)
        if (spot > 0) {
          detail = `Funds are in HL spot ($${spot.toFixed(2)} USDC); user must move them to perps before trading.`
        }
      } catch { /* spot read is best-effort */ }
      return { ok: false, reason: 'no-balance', balance: acct.withdrawableUsdc, detail }
    }
  } catch (balErr: any) {
    console.warn(`[Agent ${agent.name}] HL balance pre-check failed (${balErr?.message}), proceeding anyway`)
  }

  const coinUnits = finalSize / currentPrice
  // ── Place the OPEN order ──────────────────────────────────────────────
  // First attempt with the builder field. If HL rejects with a builder-
  // related error (treasury not approved, fee mismatch, etc.) retry once
  // without the builder field so the order still lands. We lose the
  // 0.1% kickback on that fill but the user can actually trade — much
  // better than a hard fail.
  let result = await services.placeOrder(creds, {
    coin:     pair,
    side,
    type:     'MARKET',
    sz:       coinUnits,
    leverage: decision.leverage ?? 1,
  })
  if (!result.success && result.error && /builder/i.test(result.error)) {
    console.warn(
      `[Agent ${agent.name}] HL builder reject (${result.error}) — retrying without builder fee`,
    )
    result = await services.placeOrder(creds, {
      coin:      pair,
      side,
      type:      'MARKET',
      sz:        coinUnits,
      leverage:  decision.leverage ?? 1,
      noBuilder: true,
    })
  }
  if (!result.success) {
    return { ok: false, reason: 'rejected', detail: result.error ?? 'placeOrder failed' }
  }
  if (!result.oid) {
    // Successful response but no order id is an HL-side anomaly. Treat as
    // rejected so we don't persist a phantom trade record.
    return { ok: false, reason: 'rejected', detail: 'HL returned success without oid' }
  }
  const orderIdStr = String(result.oid)

  // HL placeOrder doesn't return an avgPrice (no fill query baked in).
  // Fetch a fresh mark right after the IOC sweep — for liquid pairs this
  // is within a few ticks of the actual fill. Acceptable for PnL math;
  // the user-facing surface is still the mark, not the exact fill avg.
  let fillPrice = currentPrice
  try {
    const mp = await services.getMarkPrice(pair)
    if (mp.markPrice > 0) fillPrice = mp.markPrice
  } catch { /* keep currentPrice */ }

  // ── Brackets ──────────────────────────────────────────────────────────
  // HL has no single bracket call. Submit SL and TP as two independent
  // reduce-only trigger orders. Whichever fires first closes the position
  // and the other becomes a no-op. We don't fail the open if a bracket
  // doesn't land — the position is open and still manageable.
  if (decision.stopLoss) {
    try {
      const sl = await services.placeStopLoss(creds, {
        coin:      pair,
        side,
        sz:        coinUnits,
        triggerPx: decision.stopLoss,
      })
      if (!sl.success && sl.error && /builder/i.test(sl.error)) {
        await services.placeStopLoss(creds, {
          coin: pair, side, sz: coinUnits, triggerPx: decision.stopLoss, noBuilder: true,
        })
      } else if (!sl.success) {
        console.warn(`[Agent ${agent.name}] HL SL placement failed: ${sl.error}`)
      }
    } catch (slErr: any) {
      console.warn(`[Agent ${agent.name}] HL SL threw: ${slErr?.message}`)
    }
  }
  if (decision.takeProfit) {
    try {
      const tp = await services.placeTakeProfit(creds, {
        coin:      pair,
        side,
        sz:        coinUnits,
        triggerPx: decision.takeProfit,
      })
      if (!tp.success && tp.error && /builder/i.test(tp.error)) {
        await services.placeTakeProfit(creds, {
          coin: pair, side, sz: coinUnits, triggerPx: decision.takeProfit, noBuilder: true,
        })
      } else if (!tp.success) {
        console.warn(`[Agent ${agent.name}] HL TP placement failed: ${tp.error}`)
      }
    } catch (tpErr: any) {
      console.warn(`[Agent ${agent.name}] HL TP threw: ${tpErr?.message}`)
    }
  }

  return { ok: true, fillPrice, orderIdStr }
}

// ── Hyperliquid: CLOSE ───────────────────────────────────────────────────────

export async function executeCloseHl(
  input: CloseInput,
  services: HlCloseServices,
): Promise<CloseResult> {
  const { agent, dbUser, userAddress, openPos, fallbackPrice } = input
  const creds = dbUser ? await services.resolveAgentCreds(dbUser as any, userAddress) : null
  if (!creds) return { ok: false, reason: 'no-creds' }

  let exitPrice = fallbackPrice
  try {
    const mp = await services.getMarkPrice(openPos.pair)
    if (mp.markPrice > 0) exitPrice = mp.markPrice
  } catch { /* keep fallback */ }

  try {
    const coinUnits = openPos.size / openPos.entryPrice
    // Submit OPPOSITE side as a reduce-only market order. HL's placeOrder
    // sets `r:true` from reduceOnly so the order can only shrink the
    // position — never accidentally flip it.
    const closeSide: 'LONG' | 'SHORT' = openPos.side === 'LONG' ? 'SHORT' : 'LONG'
    const result = await services.placeOrder(creds, {
      coin:       openPos.pair,
      side:       closeSide,
      type:       'MARKET',
      sz:         coinUnits,
      reduceOnly: true,
    })
    if (!result.success) {
      console.error(`[Agent ${agent.name}] HL close failed: ${result.error}`)
      return { ok: false, reason: 'rejected', detail: result.error ?? 'placeOrder failed' }
    }
    return { ok: true, exitPrice }
  } catch (closeErr: any) {
    console.error(`[Agent ${agent.name}] HL close threw:`, closeErr?.message)
    return { ok: false, reason: 'rejected', detail: String(closeErr?.message ?? '') }
  }
}
