import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error']
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

/**
 * Raw-SQL writer for on-chain identity columns on the Agent table.
 *
 * Why this exists: erc8004 and bap578 columns are defined in schema.prisma,
 * but the *generated* Prisma client on Render is sometimes stale (the
 * `prisma generate` step in the build can silently fall through). When
 * that happens, `db.agent.update({ data: { erc8004AgentId: ... } })`
 * throws "Unknown argument" even though the DB column exists. Raw SQL
 * bypasses the client's field whitelist entirely. The columns either
 * exist (write succeeds) or don't (write fails loudly with a clear
 * "column does not exist" — which is then a real schema-sync issue).
 *
 * Whitelisted column names only — never pass user input as keys.
 */
const ALLOWED_ONCHAIN_COLS = new Set([
  'erc8004AgentId',
  'erc8004TxHash',
  'erc8004FundTxHash',
  'erc8004Verified',
  'bap578TokenId',
  'bap578TxHash',
  'bap578Verified',
  'onchainTxHash',
  'walletAddress',
  'encryptedPK',
  'metadataUri',
  'identityStandard',
  'onchainChain'
])

export async function setAgentOnchainFields(
  agentId: string,
  fields: Record<string, string | boolean | null>
): Promise<void> {
  const keys = Object.keys(fields).filter((k) => ALLOWED_ONCHAIN_COLS.has(k))
  if (keys.length === 0) return

  const setClause = keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ')
  const values = keys.map((k) => fields[k])
  const sql = `UPDATE "Agent" SET ${setClause}, "updatedAt" = NOW() WHERE "id" = $1`

  await db.$executeRawUnsafe(sql, agentId, ...values)
}
