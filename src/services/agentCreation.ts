// Shared agent-creation service. Both the Telegram bot's /newagent flow
// and the mini-app's /api/me/agents/onboard endpoint call into this so
// the on-chain registration logic exists in exactly one place.
//
// The bot UI lives in src/bot/commands/agents.ts (it formats Telegram
// messages around the result). The HTTP UI lives in the new mini-app
// Onboard page (it renders preset chips around the result). Neither
// owns any of the wallet / identity / register-on-chain plumbing —
// that is all in here, behind a single pure function.

import { db, setAgentOnchainFields } from '../db'
import { generateEVMWallet, encryptPrivateKey } from './wallet'
import { buildAgentIdentity, type AgentChain } from './agentIdentity'
import { registerAgentOnchain, XLAYER_ERC8004_REGISTRY } from './erc8004'

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? 'https://build4-1.onrender.com'

// Three preset risk profiles. The user picks one in the mini-app onboard
// flow; the values feed straight into the new agent row. Tuned so:
//   - Safe       — keeps a beginner inside small losses while they learn.
//   - Balanced   — current production default; what most users should pick.
//   - Aggressive — opt-in for users who already understand drawdowns.
//
// `dailyLossMultiplier` is applied to the user's startingCapital to set
// `maxDailyLoss`, so a $20 starter on Balanced gets $80 daily loss cap;
// a $100 starter on Aggressive gets $800. There's also a $20 floor so a
// tiny starting capital still has a sane loss cap.
export type AgentPreset = 'safe' | 'balanced' | 'aggressive'

export interface PresetValues {
  maxLeverage: number
  stopLossPct: number
  takeProfitPct: number
  dailyLossMultiplier: number
}

export const PRESETS: Record<AgentPreset, PresetValues> = {
  safe:       { maxLeverage: 3,  stopLossPct: 1.5, takeProfitPct: 2.5, dailyLossMultiplier: 2 },
  balanced:   { maxLeverage: 10, stopLossPct: 2,   takeProfitPct: 4,   dailyLossMultiplier: 4 },
  aggressive: { maxLeverage: 25, stopLossPct: 3,   takeProfitPct: 6,   dailyLossMultiplier: 8 },
}

// Single-word callsigns. We append a 4-digit suffix so collisions are
// rare even with thousands of agents. The DB has a uniqueness constraint
// on `name` (case-insensitive), so we double-check before committing.
const NAME_POOL = [
  'Falcon','Vega','Orion','Atlas','Apex','Helios','Phoenix','Lyra','Nova','Zephyr',
  'Sirius','Polaris','Argus','Cygnus','Halcyon','Triton','Aether','Nyx','Nimbus','Andromeda',
  'Perseus','Draco','Pegasus','Auriga','Castor','Pollux','Rigel','Altair','Procyon','Spica',
]

async function pickAvailableName(): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const base = NAME_POOL[Math.floor(Math.random() * NAME_POOL.length)]
    const suffix = Math.floor(Math.random() * 9000 + 1000)
    const candidate = `${base}${suffix}`
    const exists = await db.agent.findFirst({
      where: { name: { equals: candidate, mode: 'insensitive' } }
    })
    if (!exists) return candidate
  }
  // Fall back to a wall-clock ms suffix to guarantee uniqueness if we
  // somehow lost the dice 8 times in a row (we won't, but better a
  // boring name than a 500).
  return `Agent${Date.now()}`
}

export type CreateAgentResult =
  | { ok: true,  agent: any }
  | { ok: false, reason: string, partial?: boolean, agentId?: string }

/**
 * Create a fresh ERC-8004 agent for a user, end to end:
 *   1. Generate a new EVM wallet for the agent's signer.
 *   2. Build the identity payload + metadata URI.
 *   3. Insert the DB row with preset risk values pre-filled.
 *   4. Fund the agent wallet from BUILD4's registry treasury.
 *   5. Self-call register() on the IdentityRegistry as the agent.
 *   6. Persist the resulting agentId + tx hashes.
 *
 * Caller decides how to render success/failure (Telegram vs HTTP). On
 * failure we self-clean: if no funding tx ever went out, the half-baked
 * DB row is deleted so the user isn't left with a "stuck" agent. If a
 * funding tx DID go out but register failed, we keep the row marked
 * partial=true so /myagents can offer a retry path.
 */
export async function createAgentForUser(opts: {
  userId: string
  ownerAddress: string
  preset: AgentPreset
  startingCapital: number
  name?: string
  chain?: AgentChain
  onProgress?: (event: { step: string; txHash?: string }) => Promise<void> | void
}): Promise<CreateAgentResult> {
  const preset = PRESETS[opts.preset]
  if (!preset) return { ok: false, reason: `unknown preset: ${opts.preset}` }

  // XLayer is the campaign default when its registry is configured;
  // otherwise we fall back to BSC so the bot never offers a broken option.
  const chain: AgentChain = opts.chain ?? (XLAYER_ERC8004_REGISTRY ? 'xlayer' : 'bsc')
  const dbChain = chain === 'xlayer' ? 'XLAYER' : 'BSC'

  // Aster's min notional is ~$5.50, so we floor the per-trade size there.
  // Users can scale UP later in Agent Studio without re-creating.
  const capital = Math.max(5.5, Number(opts.startingCapital) || 5.5)
  const maxDailyLoss = Math.max(20, capital * preset.dailyLossMultiplier)

  const { address, privateKey } = generateEVMWallet()
  const encryptedPK = encryptPrivateKey(privateKey, opts.userId, undefined)

  // Concurrency-safe name + create. The name uniqueness check + create is
  // a TOCTOU race when many users onboard at once — two workers can both
  // pre-check "Falcon3517 is free" and one will lose at insert time with
  // a Prisma P2002 unique violation. We catch that, regenerate the name,
  // and retry up to 5 times before giving up. For an explicit user-supplied
  // name we surface the conflict immediately (so the legacy bot text flow
  // doesn't silently rename).
  let agent: any = null
  let name = opts.name ?? await pickAvailableName()
  let identity = buildAgentIdentity({
    name,
    agentAddress: address,
    ownerAddress: opts.ownerAddress,
    publicBaseUrl: PUBLIC_BASE_URL,
    chain,
  })
  // Validate the supplied name (only relevant for the bot's legacy text
  // flow — the auto-generated names always pass).
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(name)) {
    return { ok: false, reason: 'Name must be 3-24 letters/numbers/underscore' }
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      agent = await db.agent.create({
        data: {
          userId: opts.userId,
          name,
          walletAddress: address,
          encryptedPK,
          onchainChain: dbChain,
          learningModel: identity.model,
          learningRoot: identity.learningRoot,
          metadataUri: identity.metadataUri,
          identityStandard: identity.standard,
          exchange: 'aster',
          pairs: ['AUTO'],
          maxPositionSize: capital,
          maxDailyLoss,
          maxLeverage: preset.maxLeverage,
          stopLossPct: preset.stopLossPct,
          takeProfitPct: preset.takeProfitPct,
          isActive: true,
        },
      })
      break
    } catch (e: any) {
      // Prisma surfaces unique-constraint failures as code P2002. Anything
      // else is fatal — we re-throw so the caller's 500 path sees it.
      const isUnique = e?.code === 'P2002' || /unique/i.test(e?.message ?? '')
      if (!isUnique) throw e
      // If the user explicitly supplied a name, don't silently rename
      // them — that would surprise the bot's text flow user. Surface it.
      if (opts.name) {
        return { ok: false, reason: `Name "${opts.name}" is already taken on-chain` }
      }
      // Auto-generated path: pick a different name and rebuild identity
      // (metadataUri is keyed on agent address, so it stays the same; only
      // the name changes), then retry the insert.
      name = await pickAvailableName()
      identity = buildAgentIdentity({
        name,
        agentAddress: address,
        ownerAddress: opts.ownerAddress,
        publicBaseUrl: PUBLIC_BASE_URL,
        chain,
      })
    }
  }
  if (!agent) {
    return { ok: false, reason: 'Could not allocate a unique agent name after 5 tries — try again' }
  }
  try { await opts.onProgress?.({ step: 'agent_created' }) } catch {}

  const reg = await registerAgentOnchain({
    chain,
    agentWalletPK: privateKey,
    agentAddress: address,
    metadataURI: identity.metadataUri,
    onAgentFunded: async (h) => {
      await setAgentOnchainFields(agent.id, { erc8004FundTxHash: h })
      try { await opts.onProgress?.({ step: 'funded', txHash: h }) } catch {}
    },
    onRegisterTxSent: async (h) => {
      await setAgentOnchainFields(agent.id, { erc8004TxHash: h, onchainTxHash: h })
      try { await opts.onProgress?.({ step: 'register_sent', txHash: h }) } catch {}
    },
  })

  if (!reg.success || !reg.agentId) {
    // Self-clean: only delete the row if we never spent gas. We trust
    // the registerAgentOnchain return value (`reg.fundTxHash`) FIRST
    // because the DB write inside the onAgentFunded hook can fail
    // transiently — falling back to the DB read alone could orphan a
    // funded agent wallet by deleting its row. Belt-and-braces: also
    // re-read the DB column in case the funding tx hash was persisted
    // by some other code path we don't know about.
    const fresh = await db.agent.findUnique({ where: { id: agent.id } })
    const wasFunded = Boolean(reg.fundTxHash) || Boolean(fresh?.erc8004FundTxHash)
    if (!wasFunded) {
      await db.agent.delete({ where: { id: agent.id } })
      return { ok: false, reason: reg.reason ?? 'on-chain register failed' }
    }
    // If reg returned a fundTxHash but our hook didn't manage to persist
    // it, do so now so /myagents can offer a retry path.
    if (reg.fundTxHash && !fresh?.erc8004FundTxHash) {
      try { await setAgentOnchainFields(agent.id, { erc8004FundTxHash: reg.fundTxHash }) } catch {}
    }
    return {
      ok: false,
      reason: reg.reason ?? 'on-chain register failed',
      partial: true,
      agentId: agent.id,
    }
  }

  await setAgentOnchainFields(agent.id, {
    erc8004AgentId: reg.agentId,
    erc8004TxHash: reg.txHash ?? null,
    onchainTxHash: reg.txHash ?? null,
    erc8004Verified: true,
  })
  try { await opts.onProgress?.({ step: 'registered' }) } catch {}

  const final = await db.agent.findUnique({ where: { id: agent.id } })
  return { ok: true, agent: final }
}
