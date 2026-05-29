// ─────────────────────────────────────────────────────────────────────────
// fourMemeTrust — Task #149: trust / anti-rug scoring for four.meme launches.
//
// Pure, side-effect-free scoring. The scanner (src/services/fourMemeScanner.ts)
// feeds it on-chain curve stats; the snipe agent
// (src/agents/fourMemeSnipeAgent.ts) reads the resulting verdict.
//
// Philosophy ("Balanced" strictness, locked by the user):
//   • Reward healthy, organic-looking curves: a few minutes old, several
//     distinct buyers, dev not hoarding, steady (not vertical) fill.
//   • Punish classic farmer-dev / scam patterns: dev whale holdings,
//     dev already dumping, wash trading (many buys from few wallets),
//     vertical fill velocity (bot-pumped), and one-sided no-buyer curves.
//   • Fail toward SKIP on missing/unsupported data — we never *have* to
//     buy any given launch, so uncertainty costs trust.
//
// All thresholds are env-tunable so the dependent 50-agent volume fleet
// (Task #150) can retune without a redeploy.
// ─────────────────────────────────────────────────────────────────────────

function envNum(name: string, fallback: number): number {
  const v = process.env[name]
  if (v === undefined || v.trim() === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

// ── Tunables (Balanced defaults) ─────────────────────────────────────
export const TRUST_MIN_BUY = envNum('FOUR_MEME_TRUST_MIN_BUY', 60) // buy verdict at/above
export const TRUST_VERY_HIGH = envNum('FOUR_MEME_TRUST_VERY_HIGH', 85) // ride through migration
export const TRUST_WATCH_BAND = envNum('FOUR_MEME_TRUST_WATCH_BAND', 15) // [min-band, min) = watch
export const TRUST_MIN_AGE_SEC = envNum('FOUR_MEME_TRUST_MIN_AGE_SEC', 30) // younger = too fresh
export const TRUST_MAX_AGE_SEC = envNum('FOUR_MEME_TRUST_MAX_AGE_SEC', 6 * 3600) // older = stale
export const TRUST_MAX_FILL_ENTRY = envNum('FOUR_MEME_TRUST_MAX_FILL_ENTRY', 0.8) // don't enter past this
export const TRUST_DEV_WHALE_PCT = envNum('FOUR_MEME_TRUST_DEV_WHALE_PCT', 0.3) // dev holdings ceiling
export const TRUST_MIN_BUYERS = envNum('FOUR_MEME_TRUST_MIN_BUYERS', 5)
export const TRUST_MAX_FILL_VEL = envNum('FOUR_MEME_TRUST_MAX_FILL_VEL', 0.5) // fill fraction / minute
export const TRUST_WASH_RATIO = envNum('FOUR_MEME_TRUST_WASH_RATIO', 4) // buys per unique buyer

export interface CurveStats {
  ageSec: number
  fillPct: number // 0..1
  fundsBnb: number
  buyerCount: number | null
  buyCount: number | null
  sellCount: number | null
  devHoldsPct: number | null // 0..1 of sellable supply
  graduated: boolean
  quoteIsBnb: boolean
  version: number
}

export interface TrustResult {
  score: number // 0..100
  verdict: 'buy' | 'watch' | 'skip'
  flags: string[] // human-readable signals (good + bad)
  rug: boolean // hard rug/scam pattern present (drives immediate exit)
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/**
 * Score a launch's trustworthiness. Null stats degrade gracefully (a
 * small uncertainty penalty rather than an outright skip), so a launch
 * the scanner couldn't fully enrich can still be evaluated.
 */
export function scoreTrust(stats: CurveStats): TrustResult {
  const flags: string[] = []

  // ── Hard gates — anything here is an immediate, non-negotiable SKIP.
  // Only V2 BNB-quoted curves are tradeable through our buy/sell path
  // (sellTokenForBnb refuses V1; BEP20-quoted curves are unsupported).
  if (!stats.quoteIsBnb) {
    return { score: 0, verdict: 'skip', flags: ['unsupported:not_bnb_quoted'], rug: false }
  }
  if (stats.version !== 2) {
    return { score: 0, verdict: 'skip', flags: [`unsupported:v${stats.version}`], rug: false }
  }
  if (stats.graduated) {
    return { score: 0, verdict: 'skip', flags: ['graduated'], rug: false }
  }

  let score = 50
  let rug = false

  // ── Age ──────────────────────────────────────────────────────────
  if (stats.ageSec < TRUST_MIN_AGE_SEC) {
    flags.push('too_young')
    score -= 10
  } else if (stats.ageSec > TRUST_MAX_AGE_SEC) {
    flags.push('stale')
    score -= 15
  } else {
    score += 5
  }

  // ── Dev holdings ─────────────────────────────────────────────────
  if (stats.devHoldsPct === null) {
    flags.push('dev_holds_unknown')
    score -= 5
  } else if (stats.devHoldsPct >= 0.5) {
    flags.push('dev_whale')
    score -= 40
    rug = true
  } else if (stats.devHoldsPct >= TRUST_DEV_WHALE_PCT) {
    flags.push('dev_heavy')
    score -= 20
  } else if (stats.devHoldsPct <= 0.1) {
    flags.push('dev_light')
    score += 12
  } else {
    score += 4
  }

  // ── Buyer breadth ────────────────────────────────────────────────
  if (stats.buyerCount === null) {
    flags.push('buyers_unknown')
    score -= 5
  } else if (stats.buyerCount >= 20) {
    flags.push('many_buyers')
    score += 20
  } else if (stats.buyerCount >= 10) {
    score += 12
  } else if (stats.buyerCount >= TRUST_MIN_BUYERS) {
    score += 5
  } else {
    flags.push('few_buyers')
    score -= 15
  }

  // ── Wash trading (many buys from few unique wallets) ─────────────
  if (stats.buyCount !== null && stats.buyerCount !== null && stats.buyerCount > 0) {
    const ratio = stats.buyCount / stats.buyerCount
    if (ratio >= TRUST_WASH_RATIO) {
      flags.push('wash_trading')
      score -= 20
      rug = true
    }
  }

  // ── Sell pressure (dev/early dumping) ────────────────────────────
  if (stats.buyCount !== null && stats.sellCount !== null) {
    if (stats.sellCount > stats.buyCount && stats.sellCount > 0) {
      flags.push('heavy_selling')
      score -= 18
      rug = true
    } else if (stats.sellCount > 0 && stats.buyCount > 0 && stats.sellCount / stats.buyCount > 0.5) {
      flags.push('elevated_selling')
      score -= 8
    }
  }

  // ── Fill velocity (vertical = bot-pumped farm) ──────────────────
  const ageMin = Math.max(stats.ageSec / 60, 0.0001)
  const fillVel = stats.fillPct / ageMin
  if (stats.ageSec >= TRUST_MIN_AGE_SEC && fillVel > TRUST_MAX_FILL_VEL) {
    flags.push('too_fast')
    score -= 25
  }

  // ── Fill sweet spot (room to run, momentum present) ─────────────
  if (stats.fillPct >= 0.1 && stats.fillPct <= 0.6) {
    flags.push('healthy_fill')
    score += 10
  } else if (stats.fillPct > TRUST_MAX_FILL_ENTRY) {
    flags.push('near_migration')
    score -= 10
  }

  score = clamp(Math.round(score), 0, 100)

  // ── Verdict ──────────────────────────────────────────────────────
  let verdict: TrustResult['verdict']
  const entryAllowed =
    stats.ageSec >= TRUST_MIN_AGE_SEC &&
    stats.fillPct <= TRUST_MAX_FILL_ENTRY &&
    !rug
  if (score >= TRUST_MIN_BUY && entryAllowed) {
    verdict = 'buy'
  } else if (score >= TRUST_MIN_BUY - TRUST_WATCH_BAND && !rug) {
    verdict = 'watch'
  } else {
    verdict = 'skip'
  }

  return { score, verdict, flags, rug }
}

/** Very-high-trust curves may be held through migration → Pancake. */
export function shouldRideThrough(score: number): boolean {
  return score >= TRUST_VERY_HIGH
}
