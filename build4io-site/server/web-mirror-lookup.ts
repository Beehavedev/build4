import { pool } from "./db";

export type BotUserSummary = {
  userId: string;
  telegramId: string;
  username: string | null;
  firstName: string | null;
  b4Balance: number;
  asterOnboarded: boolean;
  bscWalletAddress: string | null;
  agentCount: number;
  activeAgentCount: number;
};

async function buildSummary(userRow: any): Promise<BotUserSummary> {
  const userId: string = userRow.id;
  const walletRes = await pool.query(
    `SELECT address FROM "Wallet" WHERE "userId" = $1 AND chain = 'BSC' ORDER BY "isActive" DESC, "createdAt" ASC LIMIT 1`,
    [userId],
  );
  const agentRes = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE "isActive" = true AND "isPaused" = false)::int AS active
       FROM "Agent" WHERE "userId" = $1`,
    [userId],
  );
  return {
    userId,
    telegramId: String(userRow.telegramId),
    username: userRow.username ?? null,
    firstName: userRow.firstName ?? null,
    b4Balance: Number(userRow.b4Balance ?? 0),
    asterOnboarded: !!userRow.asterOnboarded,
    bscWalletAddress: walletRes.rows[0]?.address ?? null,
    agentCount: agentRes.rows[0]?.total ?? 0,
    activeAgentCount: agentRes.rows[0]?.active ?? 0,
  };
}

export async function findBotUserByTelegramId(telegramId: string): Promise<BotUserSummary | null> {
  if (!telegramId) return null;
  let asBigInt: bigint;
  try { asBigInt = BigInt(telegramId); } catch { return null; }
  const r = await pool.query(
    `SELECT id, "telegramId", username, "firstName", "b4Balance", "asterOnboarded"
       FROM "User" WHERE "telegramId" = $1 LIMIT 1`,
    [asBigInt.toString()],
  );
  if (!r.rows.length) return null;
  return buildSummary(r.rows[0]);
}

export async function findBotUserByWalletAddress(address: string): Promise<BotUserSummary | null> {
  if (!address) return null;
  const lower = address.toLowerCase();
  const r = await pool.query(
    `SELECT u.id, u."telegramId", u.username, u."firstName", u."b4Balance", u."asterOnboarded"
       FROM "Wallet" w JOIN "User" u ON u.id = w."userId"
      WHERE lower(w.address) = $1 LIMIT 1`,
    [lower],
  );
  if (!r.rows.length) return null;
  return buildSummary(r.rows[0]);
}
