import { db } from '../db'
import { mirrorMemoryAsync } from '../services/greenfield'

export type MemoryType = 'observation' | 'decision' | 'correction' | 'market_note'

export async function saveMemory(
  agentId: string,
  type: MemoryType,
  content: string,
  metadata: Record<string, unknown> | null = null
): Promise<void> {
  try {
    const row = await db.agentMemory.create({
      data: { agentId, type, content, metadata: metadata ?? undefined }
    })
    // Phase 2 (BNBAgent SDK): mirror to BNB Greenfield for decentralized
    // long-term storage. Fire-and-forget — Postgres is the source of
    // truth, Greenfield is a verifiable mirror. Disabled by default
    // unless GREENFIELD_ENABLED=true + all required env vars set.
    mirrorMemoryAsync(
      {
        agentId,
        memoryId: row.id,
        type,
        content,
        metadata,
        createdAt: row.createdAt,
      },
      // On success, write the Greenfield ref back into the metadata JSON
      // so the row is self-describing (no schema change needed — uses
      // the existing JSON metadata column, respecting the
      // "do not change prisma/" constraint). We re-read the row in the
      // callback to avoid clobbering any concurrent metadata updates
      // that may have landed between the create and this callback —
      // the Greenfield round-trip can take seconds and we don't want
      // a stale `row.metadata` snapshot to overwrite fresh fields.
      async (ref) => {
        try {
          const fresh = await db.agentMemory.findUnique({ where: { id: row.id } })
          if (!fresh) return // row was pruned before mirror completed
          const existing =
            (typeof fresh.metadata === 'object' && fresh.metadata !== null
              ? (fresh.metadata as Record<string, unknown>)
              : {}) || {}
          await db.agentMemory.update({
            where: { id: row.id },
            data: {
              metadata: {
                ...existing,
                greenfield: {
                  bucket: ref.bucket,
                  object: ref.objectName,
                  txHash: ref.txHash,
                  mirroredAt: new Date().toISOString(),
                },
              },
            },
          })
        } catch (err) {
          console.error('[Memory] greenfield ref update failed:', err)
        }
      }
    )
    // Prune if over limit
    const count = await db.agentMemory.count({ where: { agentId } })
    if (count > 200) {
      const oldest = await db.agentMemory.findMany({
        where: { agentId },
        orderBy: { createdAt: 'asc' },
        take: count - 150,
        select: { id: true }
      })
      await db.agentMemory.deleteMany({
        where: { id: { in: oldest.map((m) => m.id) } }
      })
    }
  } catch (err) {
    console.error('[Memory] save error:', err)
  }
}

export async function getRecentMemories(agentId: string, limit: number = 15) {
  return db.agentMemory.findMany({
    where: { agentId },
    orderBy: { createdAt: 'desc' },
    take: limit
  })
}

export async function buildMemoryContext(agentId: string): Promise<string> {
  const memories = await db.agentMemory.findMany({
    where: { agentId },
    orderBy: { createdAt: 'desc' },
    take: 40
  })

  if (memories.length === 0) {
    return 'No memories yet. This agent is learning from scratch. Be cautious and start with conservative trades.'
  }

  const corrections = memories.filter((m) => m.type === 'correction')
  const observations = memories.filter((m) => m.type === 'observation')
  const marketNotes = memories.filter((m) => m.type === 'market_note')
  const decisions = memories.filter((m) => m.type === 'decision')

  let context = ''

  if (corrections.length > 0) {
    context += `MISTAKES TO LEARN FROM (weight these heavily):\n`
    corrections.slice(0, 6).forEach((c) => {
      context += `• ${c.content}\n`
    })
    context += '\n'
  }

  if (marketNotes.length > 0) {
    context += `MARKET PATTERNS NOTICED:\n`
    marketNotes.slice(0, 5).forEach((n) => {
      context += `• ${n.content}\n`
    })
    context += '\n'
  }

  if (observations.length > 0) {
    context += `RECENT OBSERVATIONS:\n`
    observations.slice(0, 5).forEach((o) => {
      context += `• ${o.content}\n`
    })
    context += '\n'
  }

  if (decisions.length > 0) {
    context += `RECENT DECISIONS:\n`
    decisions.slice(0, 3).forEach((d) => {
      context += `• ${d.content}\n`
    })
  }

  return context
}
