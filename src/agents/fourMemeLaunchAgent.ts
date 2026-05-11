// ─────────────────────────────────────────────────────────────────────────
// fourMemeLaunchAgent — Module 4: autonomous agent token launches.
//
// Tick lifecycle (one agent, every MIN_TICK_INTERVAL_MS):
//   1. Pull all agents with `fourMemeLaunchEnabled=true`.
//   2. Master kill-switch: env `FOUR_MEME_AGENT_LAUNCH_ENABLED=true`
//      AND the underlying launch feature flag (`FOUR_MEME_ENABLED` +
//      `FOUR_MEME_LAUNCH_ENABLED`) must both be ON. Fail-closed.
//   3. Daily cap (per agent): at most 1 launch per UTC day. Counted by
//      reading token_launches rows tagged with this agent.
//   4. Dedup: if any row in token_launches with the same agent_id is
//      "pending" or was created in the last 24h, skip — we never want
//      back-to-back launches even if 24h hasn't strictly elapsed.
//   5. LLM proposal: a single Anthropic round-trip given the agent's
//      persona + a small "recent winners" snapshot from DexScreener.
//      Returns { action: 'LAUNCH'|'SKIP', name, ticker, description,
//      initialBuyBnb, conviction, reasoning }.
//   6. Hard guards on the proposal: ticker length/charset, name length,
//      initialBuyBnb ≤ 0.05 (Module 4 cap, tighter than Module 3's
//      5 BNB validation cap), wallet has BNB ≥ initialBuyBnb + 0.005
//      gas reserve.
//   7. Calls existing `launchFourMemeToken(privateKey, params, ctx)`
//      so the on-chain path, image generation, slippage/value caps,
//      and persistence are all reused — no duplication.
//   8. Every decision (LAUNCH or SKIP) is logged to AgentLog with
//      exchange='four_meme' so the brain feed surfaces a 4M chip.
//
// Failure modes are bounded — per-agent try/catch in the sweep loop, so
// one bad row can't poison the rest. LLM failures degrade to SKIP with
// the error captured in the brain feed.
// ─────────────────────────────────────────────────────────────────────────

import { db } from '../db'
import { ethers } from 'ethers'
import { callLLM } from '../services/inference'
import {
  loadUserBscPrivateKey,
  isFourMemeEnabled,
} from '../services/fourMemeTrading'
import {
  launchFourMemeToken,
  isFourMemeLaunchEnabled,
  type LaunchParams,
} from '../services/fourMemeLaunch'
import { fetchTrendingBNBTokens, type DexToken } from '../services/dexScreener'
import { buildBscProvider } from '../services/bscProvider'

// ── Tunables ─────────────────────────────────────────────────────────
// Per-agent minimum tick interval. Even if the runner ticks every 60s,
// each agent considers a launch at most once per minute (and the daily
// cap below is what really bounds spend).
const MIN_TICK_INTERVAL_MS = 60_000

// Hard ceiling on BNB the agent is allowed to spend on a single launch's
// initial buy. Tighter than fourMemeLaunch.ts's own validation cap
// (5 BNB) because that cap protects manual users; agents spending
// autonomously need a much smaller blast radius.
const MAX_INITIAL_BUY_BNB = 0.05

// Daily launch cap per agent. Counted by querying token_launches for
// rows attributed to this agent in the last 24h.
const MAX_LAUNCHES_PER_DAY = 1

// Lifetime launch cap per agent. Hard ceiling — even an aged-out
// agent can never spawn more than this many tokens, ever. Configurable
// via env so a power-user / market-maker persona can be opted up
// without redeploying. Default 10 keeps blast radius bounded.
const MAX_LAUNCHES_LIFETIME = Math.max(
  1,
  parseInt(process.env.FOUR_MEME_AGENT_LIFETIME_CAP ?? '10', 10) || 10,
)

// LLM call budget guard. Default Anthropic with a tight token cap —
// the JSON schema we ask for is small (≤ 200 tokens of output).
const LLM_TIMEOUT_MS = 25_000
const LLM_MAX_TOKENS = 400

// Conviction threshold the LLM must clear for us to actually launch.
// Skips below this are still logged so the user sees the decision.
const MIN_CONVICTION = 0.75

// ── Public types ─────────────────────────────────────────────────────
export interface LaunchSweepStatus {
  at: string
  scanned: number
  ticked: number
  launchesAttempted: number
  launchesSkipped: number
  errors: number
  lastError: string | null
}
let lastSweepStatus: LaunchSweepStatus | null = null
export function getLastFourMemeLaunchSweepStatus(): LaunchSweepStatus | null {
  return lastSweepStatus
}

interface LaunchAgentRow {
  id: string
  userId: string
  name: string
  description: string | null
  fourMemeLaunchEnabled: boolean
  lastFourMemeLaunchTickAt: Date | null
  // Task #64 — when true, the agent writes a 'pending_user_approval'
  // row + sends a Telegram message instead of firing a launch
  // immediately. The user approves/rejects via inline buttons.
  fourMemeLaunchRequiresApproval: boolean
}

interface LaunchProposal {
  action: 'LAUNCH' | 'SKIP'
  name: string
  ticker: string
  description: string
  initialBuyBnb: number
  conviction: number
  reasoning: string
}

// ── Master kill-switch ───────────────────────────────────────────────
export function isAgentLaunchEnabled(): boolean {
  if (!isFourMemeEnabled()) return false
  if (!isFourMemeLaunchEnabled()) return false
  return process.env.FOUR_MEME_AGENT_LAUNCH_ENABLED === 'true'
}

// ── Public entry point ───────────────────────────────────────────────
// Called from runner.ts on a 60s schedule. Returns counts so the
// runner can log a summary line.
export async function tickAllFourMemeLaunchAgents(): Promise<{
  scanned: number
  ticked: number
  launchesAttempted: number
  launchesSkipped: number
  errors: number
}> {
  let scanned = 0
  let ticked = 0
  let launchesAttempted = 0
  let launchesSkipped = 0
  let errors = 0

  if (!isAgentLaunchEnabled()) {
    // Master switch off — no-op, no telemetry update. Same shape the
    // polymarket sweep returns when fully disabled.
    return { scanned, ticked, launchesAttempted, launchesSkipped, errors }
  }

  let agents: LaunchAgentRow[] = []
  try {
    // Raw SQL (mirrors polymarketAgent's defensive pattern) so we don't
    // depend on the prisma client carrying the new column. Filters at
    // the DB level: only active, unpaused, opted-in agents.
    const rows = await db.$queryRawUnsafe<any[]>(
      `SELECT a."id", a."userId", a."name", a."description",
              a."fourMemeLaunchEnabled", a."lastFourMemeLaunchTickAt",
              COALESCE(a."fourMemeLaunchRequiresApproval", false) AS "fourMemeLaunchRequiresApproval"
         FROM "Agent" a
        WHERE a."isActive" = true
          AND a."isPaused" = false
          AND a."fourMemeLaunchEnabled" = true`,
    )
    agents = rows.map<LaunchAgentRow>((r) => ({
      id: r.id,
      userId: r.userId,
      name: r.name,
      description: r.description ?? null,
      fourMemeLaunchEnabled: !!r.fourMemeLaunchEnabled,
      fourMemeLaunchRequiresApproval: !!r.fourMemeLaunchRequiresApproval,
      lastFourMemeLaunchTickAt:
        r.lastFourMemeLaunchTickAt instanceof Date
          ? r.lastFourMemeLaunchTickAt
          : (r.lastFourMemeLaunchTickAt
              ? new Date(r.lastFourMemeLaunchTickAt)
              : null),
    }))
  } catch (err) {
    const msg = (err as Error).message ?? String(err)
    console.error('[fourMemeLaunchAgent] failed to load agents:', msg)
    lastSweepStatus = {
      at: new Date().toISOString(),
      scanned: 0, ticked: 0, launchesAttempted: 0, launchesSkipped: 0,
      errors: 1, lastError: msg,
    }
    return { scanned, ticked, launchesAttempted, launchesSkipped, errors: 1 }
  }

  scanned = agents.length
  if (agents.length === 0) {
    lastSweepStatus = {
      at: new Date().toISOString(),
      scanned, ticked, launchesAttempted, launchesSkipped, errors,
      lastError: null,
    }
    return { scanned, ticked, launchesAttempted, launchesSkipped, errors }
  }

  // Pull "recent winners" ONCE for the whole sweep — every agent reads
  // from the same DexScreener snapshot so we don't multiply traffic.
  // Failure here degrades gracefully (we pass [] to each agent's
  // prompt; the LLM just gets no recent-context context).
  let trending: DexToken[] = []
  try {
    trending = await fetchTrendingBNBTokens({ limit: 10 })
  } catch (err) {
    console.warn(
      '[fourMemeLaunchAgent] DexScreener fetch failed (continuing):',
      (err as Error).message,
    )
  }

  let lastError: string | null = null
  for (const agent of agents) {
    const last = agent.lastFourMemeLaunchTickAt?.getTime() ?? 0
    if (Date.now() - last < MIN_TICK_INTERVAL_MS) continue

    try {
      const r = await tickOneAgent(agent, trending)
      ticked++
      launchesAttempted += r.launchesAttempted
      launchesSkipped += r.launchesSkipped
    } catch (err) {
      errors++
      lastError = `${agent.name}: ${(err as Error).message ?? String(err)}`
      console.error(
        `[fourMemeLaunchAgent] agent ${agent.id} tick failed:`,
        (err as Error).message,
      )
    }
  }

  lastSweepStatus = {
    at: new Date().toISOString(),
    scanned, ticked, launchesAttempted, launchesSkipped, errors,
    lastError,
  }
  return { scanned, ticked, launchesAttempted, launchesSkipped, errors }
}

// ── Per-agent tick ───────────────────────────────────────────────────
async function tickOneAgent(
  agent: LaunchAgentRow,
  trending: DexToken[],
): Promise<{ launchesAttempted: number; launchesSkipped: number }> {
  // Stamp the tick time UP-FRONT so a slow LLM round-trip can't cause
  // back-to-back ticks if the runner double-fires.
  await db.$executeRawUnsafe(
    `UPDATE "Agent" SET "lastFourMemeLaunchTickAt" = NOW() WHERE "id" = $1`,
    agent.id,
  )

  // Demo Day — single tick context object passed to every brain-feed
  // log call. Lets every SKIP/LAUNCH line carry the same trending
  // snapshot the agent was looking at this cycle, so judges watching
  // the feed see the agent's actual evaluation context, not just
  // "SKIP - low_conviction". bnbBalance gets filled in below once
  // we've read the wallet.
  const tickCtx: { trending: DexToken[]; bnbBalance?: number } = { trending }
  // Closure wrapper so the call sites stay readable.
  const skip = (
    proposal: LaunchProposal | null,
    effective: LaunchProposal,
  ) => skipWith(agent, proposal, effective, tickCtx)

  // Cap + dedup gate. Single query returns three counts:
  //   - lifetime: every row this agent has ever produced (hard ceiling).
  //   - recent24h: rows created in the last 24h (daily cap).
  //   - pendingAny: rows still flagged 'pending' regardless of age.
  // Spec from Module 4 review: dedup blocks if pending OR within 24h,
  // so we treat pendingAny as part of the dedup decision separately
  // from the daily-count comparison. The schema migration in
  // src/ensureTables.ts adds `agent_id` IF NOT EXISTS so this query
  // works on legacy production tables; if it still fails we fail-closed.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  let lifetimeCount = 0
  let recent24hCount = 0
  let pendingAnyCount = 0
  try {
    const rows = await db.$queryRawUnsafe<Array<{
      lifetime: bigint | number
      recent24h: bigint | number
      pending_any: bigint | number
    }>>(
      `SELECT
         COUNT(*)::int                                              AS lifetime,
         COUNT(*) FILTER (WHERE "created_at" >= $2::timestamptz)::int AS recent24h,
         COUNT(*) FILTER (WHERE "status" = 'pending')::int          AS pending_any
       FROM "token_launches"
       WHERE "agent_id" = $1`,
      agent.id,
      since,
    )
    lifetimeCount  = Number(rows[0]?.lifetime ?? 0)
    recent24hCount = Number(rows[0]?.recent24h ?? 0)
    pendingAnyCount = Number(rows[0]?.pending_any ?? 0)
  } catch (err) {
    // Best-effort — if the count fails (e.g. agent_id column missing
    // because ensureTables hasn't run yet) we err on the side of NOT
    // launching. The ALTER IF NOT EXISTS in src/ensureTables.ts is the
    // intended fix; this branch is the safety net.
    console.warn(
      `[fourMemeLaunchAgent] cap-count query failed for ${agent.id}:`,
      (err as Error).message,
    )
    return await skip(null, {
      action: 'SKIP', name: '', ticker: '', description: '',
      initialBuyBnb: 0, conviction: 0,
      reasoning: `cap_query_failed: ${(err as Error).message.slice(0, 160)}`,
    })
  }

  if (lifetimeCount >= MAX_LAUNCHES_LIFETIME) {
    return await skip(null, {
      action: 'SKIP', name: '', ticker: '', description: '',
      initialBuyBnb: 0, conviction: 0,
      reasoning: `lifetime_cap_reached: ${lifetimeCount}/${MAX_LAUNCHES_LIFETIME} launches ever`,
    })
  }
  if (recent24hCount >= MAX_LAUNCHES_PER_DAY) {
    return await skip(null, {
      action: 'SKIP', name: '', ticker: '', description: '',
      initialBuyBnb: 0, conviction: 0,
      reasoning: `daily_cap_reached: ${recent24hCount}/${MAX_LAUNCHES_PER_DAY} launches in last 24h`,
    })
  }
  // Pending dedup — applies regardless of age. Even a stuck/abandoned
  // pending row from days ago should block until status is resolved
  // (operator can manually mark 'failed' to clear it).
  if (pendingAnyCount > 0) {
    return await skip(null, {
      action: 'SKIP', name: '', ticker: '', description: '',
      initialBuyBnb: 0, conviction: 0,
      reasoning: `pending_launch_exists: ${pendingAnyCount} pending row(s) — clear or wait for completion`,
    })
  }

  // Wallet sanity: load PK + BNB balance so we can refuse early if the
  // agent's wallet can't fund a launch. This avoids burning an LLM
  // call on a wallet we can't actually transact from.
  let walletAddress: string
  let privateKey: string
  try {
    const c = await loadUserBscPrivateKey(agent.userId)
    walletAddress = c.address
    privateKey = c.privateKey
  } catch (err) {
    return await skip(null, {
      action: 'SKIP', name: '', ticker: '', description: '',
      initialBuyBnb: 0, conviction: 0,
      reasoning: `wallet_load_failed: ${(err as Error).message.slice(0, 160)}`,
    })
  }

  let bnbBalance = 0
  try {
    const provider = buildBscProvider(process.env.BSC_RPC_URL)
    const wei = await provider.getBalance(walletAddress)
    bnbBalance = Number(ethers.formatEther(wei))
  } catch (err) {
    console.warn(
      `[fourMemeLaunchAgent] balance check failed for ${agent.id}:`,
      (err as Error).message,
    )
  }
  tickCtx.bnbBalance = bnbBalance

  // Need enough BNB for the smallest meaningful launch (just gas) +
  // headroom. We let the launch path itself enforce the exact amount.
  const minBnbFloor = 0.005
  if (bnbBalance < minBnbFloor) {
    return await skip(null, {
      action: 'SKIP', name: '', ticker: '', description: '',
      initialBuyBnb: 0, conviction: 0,
      reasoning: `insufficient_bnb: have ${bnbBalance.toFixed(5)} BNB, need ≥ ${minBnbFloor}`,
    })
  }

  // Score the launch idea via one LLM call.
  let proposal: LaunchProposal
  try {
    proposal = await proposeLaunch(agent, trending, bnbBalance)
  } catch (err) {
    return await skip(null, {
      action: 'SKIP', name: '', ticker: '', description: '',
      initialBuyBnb: 0, conviction: 0,
      reasoning: `llm_failed: ${(err as Error).message.slice(0, 200)}`,
    })
  }

  // Conviction / action gates. Note we override action to SKIP in the
  // logged record even when the LLM proposed LAUNCH below threshold —
  // otherwise AgentLog would show `four_meme_launch` for a tick where
  // nothing was actually launched, which is misleading for operators
  // reading the brain feed.
  if (proposal.action !== 'LAUNCH' || proposal.conviction < MIN_CONVICTION) {
    const reason = proposal.action !== 'LAUNCH'
      ? proposal.reasoning
      : `low_conviction: ${proposal.conviction.toFixed(2)} < ${MIN_CONVICTION} — ${proposal.reasoning}`
    return await skip(proposal, {
      ...proposal,
      action: 'SKIP',
      reasoning: reason,
    })
  }

  // Sanitize + clamp the proposal before handing to the launcher.
  const cleanName = (proposal.name ?? '').trim().slice(0, 100)
  const cleanTicker = (proposal.ticker ?? '').trim().toUpperCase().slice(0, 10)
  const cleanDesc = (proposal.description ?? '').trim().slice(0, 500)
  const clampedBuy = Math.max(
    0,
    Math.min(MAX_INITIAL_BUY_BNB, Number.isFinite(proposal.initialBuyBnb) ? proposal.initialBuyBnb : 0),
  )

  if (cleanName.length < 2 || cleanTicker.length < 1 || !/^[A-Z0-9$]+$/.test(cleanTicker)) {
    return await skip(proposal, {
      ...proposal,
      action: 'SKIP',
      reasoning: `invalid_proposal: name=${JSON.stringify(cleanName)} ticker=${JSON.stringify(cleanTicker)}`,
    })
  }

  // Final BNB check: clamped initial buy + 0.005 gas reserve must fit.
  const required = clampedBuy + 0.005
  if (bnbBalance < required) {
    return await skip(proposal, {
      ...proposal,
      action: 'SKIP',
      reasoning: `insufficient_bnb_for_buy: have ${bnbBalance.toFixed(5)}, need ${required.toFixed(5)}`,
    })
  }

  // Fire the launch through the existing path. We pass userId so
  // launchFourMemeToken's persistence helper attributes the row, and
  // we additionally stamp agent_id ourselves (best-effort) so the
  // daily cap above can find it on the next tick.
  const params: LaunchParams = {
    tokenName: cleanName,
    tokenSymbol: cleanTicker,
    tokenDescription: cleanDesc,
    initialBuyBnb: clampedBuy.toFixed(6),
  }

  // Task #64 — human-in-the-loop branch. When the per-agent
  // `fourMemeLaunchRequiresApproval` toggle is on we never call
  // launchFourMemeToken here. Instead we persist a row with status
  // 'pending_user_approval' (proposal frozen in the metadata column),
  // notify the user via Telegram with Approve/Reject inline buttons,
  // and return as a "skipped" tick. The pending row is also picked up
  // by the existing pending-dedup gate above on subsequent ticks, so
  // the agent won't keep generating fresh proposals while the user
  // hasn't acted — exactly one outstanding proposal at a time.
  if (agent.fourMemeLaunchRequiresApproval) {
    const pendingId = await recordPendingApproval({
      agentId: agent.id,
      userId: agent.userId,
      walletAddress,
      params,
      proposal,
      conviction: proposal.conviction,
    })
    if (pendingId) {
      void notifyUserOfPendingApproval(agent, params, proposal, pendingId).catch((e) => {
        console.warn('[fourMemeLaunchAgent] notify failed:', (e as Error).message)
      })
    }
    return await skip(proposal, {
      ...proposal,
      action: 'SKIP',
      reasoning: pendingId
        ? `pending_user_approval: awaiting owner approval (id=${pendingId})`
        : `pending_user_approval_failed: could not persist proposal`,
    })
  }

  // launchFourMemeToken now persists agent_id directly into the
  // pending row (see persistContext.agentId in src/services/fourMemeLaunch.ts).
  // That makes attribution deterministic at write-time so the cap
  // query above sees the row immediately on the next tick — no
  // back-tag race, no clock-sensitive predicates. Failures still
  // produce a pending row tagged with agent_id, so a persistently
  // broken proposal can't bypass the daily/lifetime caps by failing
  // and retrying.
  let launchOk = false
  let launchInfo: { txHash?: string; tokenAddress?: string | null; launchUrl?: string } = {}
  let launchErr: string | null = null
  try {
    const r = await launchFourMemeToken(privateKey, params, {
      userId: agent.userId,
      agentId: agent.id,
    })
    launchOk = true
    launchInfo = { txHash: r.txHash, tokenAddress: r.tokenAddress, launchUrl: r.launchUrl }
  } catch (err) {
    launchErr = (err as Error).message ?? String(err)
    console.error(
      `[fourMemeLaunchAgent] launch failed for ${agent.id}:`,
      launchErr,
    )
  }
  void walletAddress

  await logDecision(agent, proposal, {
    ...tickCtx,
    execution: launchOk
      ? `launched tx=${launchInfo.txHash} token=${launchInfo.tokenAddress ?? '?'} url=${launchInfo.launchUrl ?? '?'}`
      : `launch_failed: ${launchErr?.slice(0, 200) ?? 'unknown'}`,
  })

  return launchOk
    ? { launchesAttempted: 1, launchesSkipped: 0 }
    : { launchesAttempted: 0, launchesSkipped: 1 }
}

// ── LLM proposal ─────────────────────────────────────────────────────
async function proposeLaunch(
  agent: LaunchAgentRow,
  trending: DexToken[],
  bnbBalance: number,
): Promise<LaunchProposal> {
  const persona = (agent.description ?? '').trim().slice(0, 600) ||
    'A pseudonymous on-chain trader who looks for asymmetric meme opportunities.'

  const winnerLines = trending.slice(0, 8).map((t) => {
    const change = Number.isFinite(t.priceChange24h) ? `${t.priceChange24h.toFixed(0)}%` : '?'
    const vol = (t.volume24hUsd ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })
    return `- ${t.symbol} (${t.name?.slice(0, 30) ?? ''}): 24h ${change}, vol $${vol}`
  })
  const winnersBlock = winnerLines.length === 0
    ? '(no recent winners — DexScreener unavailable)'
    : winnerLines.join('\n')

  const system = `You are a crypto-native AI agent named "${agent.name}". ${persona}

Your job: decide whether NOW is the right moment to launch a brand-new BSC meme token on four.meme. You only launch when you have a genuinely strong, time-sensitive thesis — most ticks should SKIP.

Constraints you MUST respect:
- Initial buy is hard-capped at ${MAX_INITIAL_BUY_BNB} BNB. Never propose more.
- Wallet currently holds ${bnbBalance.toFixed(4)} BNB total (initial buy + ~0.005 gas reserve must fit).
- Ticker: 1–10 chars, uppercase A–Z / 0–9 / $ only.
- Name: 2–100 chars, recognizable, not generic.
- Don't copy an existing trending token symbol verbatim.

Respond with strict JSON only. No prose, no markdown fences. Schema:
{
  "action": "LAUNCH" | "SKIP",
  "name": string,
  "ticker": string,
  "description": string,
  "initialBuyBnb": number,
  "conviction": number,  // 0..1
  "reasoning": string    // ≤ 240 chars, explain the thesis or the skip reason
}`

  const user = `Recent BSC winners (DexScreener trending, last 24h):
${winnersBlock}

What do you launch? If nothing, return action="SKIP" with a short reason. Be honest — bad launches lose capital.`

  const res = await callLLM({
    provider: 'anthropic',
    system,
    user,
    jsonMode: true,
    maxTokens: LLM_MAX_TOKENS,
    timeoutMs: LLM_TIMEOUT_MS,
    temperature: 0.7,
  })

  return parseProposal(res.text)
}

// Exported for unit testing.
export function parseProposal(raw: string): LaunchProposal {
  const trimmed = (raw ?? '').trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim()
  let obj: any
  try {
    obj = JSON.parse(trimmed)
  } catch {
    // Last-ditch: extract the first {...} block.
    const m = trimmed.match(/\{[\s\S]*\}/)
    if (!m) throw new Error(`LLM returned non-JSON: ${trimmed.slice(0, 120)}`)
    obj = JSON.parse(m[0])
  }
  const action = obj.action === 'LAUNCH' ? 'LAUNCH' : 'SKIP'
  return {
    action,
    name: String(obj.name ?? '').trim(),
    ticker: String(obj.ticker ?? '').trim(),
    description: String(obj.description ?? '').trim(),
    initialBuyBnb: Number(obj.initialBuyBnb ?? 0),
    conviction: Math.max(0, Math.min(1, Number(obj.conviction ?? 0))),
    reasoning: String(obj.reasoning ?? '').trim().slice(0, 500),
  }
}

// ── Brain-feed log helper ────────────────────────────────────────────
async function logDecision(
  agent: LaunchAgentRow,
  proposal: LaunchProposal | null,
  extras: {
    execution?: string
    // Demo Day — when present, the brain-feed line gets prefixed with
    // a one-line snapshot of what the agent looked at. Lets judges see
    // "Scanned 8 trending: PEPE +180%, FLOKI +95%, ..." even when the
    // tick ends in SKIP, which is most of the time by design.
    trending?: DexToken[]
    bnbBalance?: number
  } = {},
): Promise<void> {
  try {
    const action = proposal?.action === 'LAUNCH' ? 'four_meme_launch' : 'four_meme_launch_skip'
    const parts: string[] = []
    // Brain-feed prefix: what the agent scanned this tick. Top 3 only
    // so the line stays readable. Symbols are uppercased & truncated.
    if (extras.trending && extras.trending.length > 0) {
      const top = extras.trending.slice(0, 3).map((t) => {
        const sym = (t.symbol ?? '?').toString().toUpperCase().slice(0, 8)
        const ch = Number.isFinite(t.priceChange24h) ? `${t.priceChange24h >= 0 ? '+' : ''}${t.priceChange24h.toFixed(0)}%` : ''
        return ch ? `${sym} ${ch}` : sym
      }).join(', ')
      parts.push(`Scanned ${extras.trending.length} trending [${top}]`)
    }
    if (typeof extras.bnbBalance === 'number') {
      parts.push(`wallet ${extras.bnbBalance.toFixed(4)} BNB`)
    }
    if (extras.execution) parts.push(extras.execution)
    if (proposal) {
      parts.push(`${proposal.action} ${proposal.ticker || '-'} (conv ${proposal.conviction.toFixed(2)})`)
      if (proposal.action === 'LAUNCH') {
        parts.push(`buy=${proposal.initialBuyBnb} BNB`)
      }
      if (proposal.reasoning) parts.push(proposal.reasoning)
    }
    await db.agentLog.create({
      data: {
        agentId: agent.id,
        userId: agent.userId,
        action,
        rawResponse: null,
        parsedAction: proposal ? `${proposal.action}_${proposal.ticker || 'NONE'}` : 'SKIP_NONE',
        executionResult: extras.execution ?? null,
        error: null,
        pair: proposal?.ticker ? proposal.ticker.slice(0, 20) : null,
        price: null,
        reason: parts.join(' · ').slice(0, 500),
        adx: null,
        rsi: null,
        score: proposal ? Math.round(proposal.conviction * 100) : 0,
        regime: null,
        exchange: 'four_meme',
      },
    })
  } catch (err) {
    console.warn('[fourMemeLaunchAgent] logDecision failed:', (err as Error).message)
  }
}

// ── Task #64: HITL approval persistence + notification ───────────────
async function recordPendingApproval(input: {
  agentId: string
  userId: string
  walletAddress: string
  params: LaunchParams
  proposal: LaunchProposal
  conviction: number
}): Promise<string | null> {
  const id = `flm_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  const metadata = JSON.stringify({
    tokenName: input.params.tokenName,
    tokenSymbol: input.params.tokenSymbol,
    tokenDescription: input.params.tokenDescription ?? '',
    initialBuyBnb: input.params.initialBuyBnb ?? '0',
    conviction: input.conviction,
    reasoning: input.proposal.reasoning,
    proposedAt: new Date().toISOString(),
  })
  try {
    await db.$executeRawUnsafe(
      `INSERT INTO "token_launches"
        ("id","user_id","agent_id","creator_wallet","platform","chain_id",
         "token_name","token_symbol","token_description","initial_liquidity_bnb",
         "status","metadata","created_at")
       VALUES ($1,$2,$3,$4,'four_meme',56,$5,$6,$7,$8,'pending_user_approval',$9, now())`,
      id,
      input.userId,
      input.agentId,
      input.walletAddress,
      input.params.tokenName,
      input.params.tokenSymbol,
      input.params.tokenDescription ?? null,
      input.params.initialBuyBnb ?? '0',
      metadata,
    )
    return id
  } catch (err: any) {
    console.warn('[fourMemeLaunchAgent] pending_user_approval insert failed:', err?.message ?? err)
    return null
  }
}

async function notifyUserOfPendingApproval(
  agent: LaunchAgentRow,
  params: LaunchParams,
  proposal: LaunchProposal,
  launchId: string,
): Promise<void> {
  // Late-import the runner + grammy types to avoid a require cycle and
  // to keep the agent loadable in environments where the bot isn't wired
  // (e.g. unit tests).
  const { getBot } = await import('./runner')
  const bot = getBot()
  if (!bot) return
  const userRow = await db.user.findUnique({
    where: { id: agent.userId },
    select: { telegramId: true },
  })
  if (!userRow?.telegramId) return
  const { InlineKeyboard } = await import('grammy')
  const kb = new InlineKeyboard()
    .text('✅ Approve', `flm_approve_${launchId}`)
    .text('❌ Reject',  `flm_reject_${launchId}`)
  const text =
    `🎰 *Launch proposal from ${agent.name}*\n\n` +
    `Token: *${params.tokenName}* ($${params.tokenSymbol})\n` +
    `Initial buy: ${params.initialBuyBnb} BNB\n` +
    `Conviction: ${(proposal.conviction * 100).toFixed(0)}%\n\n` +
    `_${proposal.reasoning?.slice(0, 240) ?? '(no rationale)'}_\n\n` +
    `Approve to fire the launch with these exact params, or reject to discard.`
  try {
    await bot.api.sendMessage(userRow.telegramId.toString(), text, {
      parse_mode: 'Markdown',
      reply_markup: kb,
    })
  } catch (err: any) {
    // User may have blocked the bot — proposal still lives in the
    // mini-app card so they can act on it from there.
    console.warn('[fourMemeLaunchAgent] sendMessage failed:', err?.message ?? err)
  }
}

// Convenience wrapper used by the early-return SKIP paths above.
// Demo Day — accepts optional ctx so SKIP brain-feed lines can include
// the trending snapshot + wallet balance the agent looked at, not just
// the cap/conviction reason. Caller passes the same `tickCtx` it built
// once per tick; cap/balance early-skips that fire BEFORE trending is
// fetched simply pass nothing and get a concise line.
async function skipWith(
  agent: LaunchAgentRow,
  proposal: LaunchProposal | null,
  effective: LaunchProposal,
  ctx: { trending?: DexToken[]; bnbBalance?: number } = {},
): Promise<{ launchesAttempted: number; launchesSkipped: number }> {
  await logDecision(agent, effective, ctx)
  void proposal
  return { launchesAttempted: 0, launchesSkipped: 1 }
}
