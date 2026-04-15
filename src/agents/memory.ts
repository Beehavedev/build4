import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function saveMemory(
  agentId: string,
  type: string,
  content: string,
  metadata?: any
) {
  return prisma.agentMemory.create({
    data: {
      agentId,
      type,
      content,
      embedding: [],
      metadata: metadata ?? null,
    },
  });
}

export async function getRecentMemories(agentId: string, limit = 10): Promise<string> {
  const memories = await prisma.agentMemory.findMany({
    where: { agentId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  if (memories.length === 0) return "No previous memories.";

  return memories
    .map((m) => `[${m.type}] ${m.content}`)
    .join("\n");
}

export async function buildMemoryContext(agentId: string): Promise<string> {
  const memories = await prisma.agentMemory.findMany({
    where: { agentId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  const observations = memories.filter((m) => m.type === "observation").slice(0, 5);
  const corrections = memories.filter((m) => m.type === "correction").slice(0, 5);
  const decisions = memories.filter((m) => m.type === "decision").slice(0, 5);
  const notes = memories.filter((m) => m.type === "market_note").slice(0, 3);

  let ctx = "";
  if (observations.length) ctx += `Past patterns:\n${observations.map((m) => `- ${m.content}`).join("\n")}\n\n`;
  if (corrections.length) ctx += `Mistakes to avoid:\n${corrections.map((m) => `- ${m.content}`).join("\n")}\n\n`;
  if (decisions.length) ctx += `Recent decisions:\n${decisions.map((m) => `- ${m.content}`).join("\n")}\n\n`;
  if (notes.length) ctx += `Market notes:\n${notes.map((m) => `- ${m.content}`).join("\n")}\n\n`;

  return ctx || "No memory context available.";
}

export async function pruneOldMemories(agentId: string) {
  const count = await prisma.agentMemory.count({ where: { agentId } });
  if (count <= 200) return;

  const oldest = await prisma.agentMemory.findMany({
    where: { agentId },
    orderBy: { createdAt: "asc" },
    take: count - 200,
    select: { id: true },
  });

  await prisma.agentMemory.deleteMany({
    where: { id: { in: oldest.map((m) => m.id) } },
  });
}
