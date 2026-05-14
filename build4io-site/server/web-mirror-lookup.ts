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

export type AgentSummary = {
  id: string;
  name: string;
  description: string | null;
  exchange: string;
  enabledVenues: string[];
  pairs: string[];
  isActive: boolean;
  isPaused: boolean;
  totalPnl: number;
  totalTrades: number;
  winRate: number;
  walletAddress: string | null;
  createdAt: string;
};

export type AgentLogEntry = {
  id: string;
  agentId: string;
  agentName: string | null;
  createdAt: string;
  action: string;
  parsedAction: string | null;
  pair: string | null;
  price: number | null;
  reason: string | null;
  exchange: string | null;
  error: string | null;
};

export async function getAgentsForUser(userId: string): Promise<AgentSummary[]> {
  if (!userId) return [];
  const r = await pool.query(
    `SELECT id, name, description, exchange, "enabledVenues", pairs,
            "isActive", "isPaused", "totalPnl", "totalTrades", "winRate",
            "walletAddress", "createdAt"
       FROM "Agent" WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 50`,
    [userId],
  );
  return r.rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    exchange: row.exchange,
    enabledVenues: row.enabledVenues || [],
    pairs: row.pairs || [],
    isActive: !!row.isActive,
    isPaused: !!row.isPaused,
    totalPnl: Number(row.totalPnl ?? 0),
    totalTrades: Number(row.totalTrades ?? 0),
    winRate: Number(row.winRate ?? 0),
    walletAddress: row.walletAddress ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  }));
}

export async function getRecentAgentLogsForUser(
  userId: string,
  limit = 20,
): Promise<AgentLogEntry[]> {
  if (!userId) return [];
  const cap = Math.min(Math.max(1, Number(limit) || 20), 50);
  const r = await pool.query(
    `SELECT l.id, l."agentId", a.name AS "agentName", l."createdAt", l.action,
            l."parsedAction", l.pair, l.price, l.reason, l.exchange, l.error
       FROM "AgentLog" l
       LEFT JOIN "Agent" a ON a.id = l."agentId"
      WHERE l."userId" = $1
      ORDER BY l."createdAt" DESC
      LIMIT $2`,
    [userId, cap],
  );
  return r.rows.map((row) => ({
    id: row.id,
    agentId: row.agentId,
    agentName: row.agentName ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    action: row.action,
    parsedAction: row.parsedAction ?? null,
    pair: row.pair ?? null,
    price: row.price != null ? Number(row.price) : null,
    reason: row.reason ?? null,
    exchange: row.exchange ?? null,
    error: row.error ?? null,
  }));
}

export async function getBscWalletForUser(userId: string): Promise<string | null> {
  if (!userId) return null;
  const r = await pool.query(
    `SELECT address FROM "Wallet"
      WHERE "userId" = $1 AND chain = 'BSC'
      ORDER BY "isActive" DESC, "createdAt" ASC
      LIMIT 1`,
    [userId],
  );
  return r.rows[0]?.address ?? null;
}

export async function getPolymarketSafeForUser(userId: string): Promise<string | null> {
  if (!userId) return null;
  const r = await pool.query(
    `SELECT "safeAddress" FROM "PolymarketCreds" WHERE "userId" = $1 LIMIT 1`,
    [userId],
  );
  return r.rows[0]?.safeAddress ?? null;
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
