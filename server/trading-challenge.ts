import { eq, and, desc, asc, sql } from "drizzle-orm";
import type { db as DbType } from "./db";
import {
  tradingChallenges, challengeEntries, agentPnlSnapshots, copyTrades,
  type TradingChallenge, type ChallengeEntry, type CopyTrade,
} from "@shared/schema";
import { ethers } from "ethers";

let dbInstance: ReturnType<typeof import("./db")["db"]> | null = null;
function getDb() {
  if (!dbInstance) {
    const { db } = require("./db");
    dbInstance = db;
  }
  return dbInstance!;
}

const BSC_RPC = "https://bsc-dataseed1.binance.org";

export async function createChallenge(data: {
  name: string; description?: string; startDate: Date; endDate: Date;
  prizePoolB4: string; maxEntries?: number; minBalanceBnb?: string; createdBy?: string;
}): Promise<TradingChallenge> {
  const db = getDb();
  const [challenge] = await db.insert(tradingChallenges).values({
    name: data.name, description: data.description || null,
    startDate: data.startDate, endDate: data.endDate,
    prizePoolB4: data.prizePoolB4, status: data.startDate <= new Date() ? "active" : "upcoming",
    maxEntries: data.maxEntries || 100, minBalanceBnb: data.minBalanceBnb || "0.01",
    createdBy: data.createdBy || null,
  }).returning();
  return challenge;
}

export async function getActiveChallenges(): Promise<TradingChallenge[]> {
  const db = getDb();
  return db.select().from(tradingChallenges)
    .where(sql`${tradingChallenges.status} IN ('active', 'upcoming')`)
    .orderBy(asc(tradingChallenges.startDate));
}

export async function getChallengeById(id: string): Promise<TradingChallenge | null> {
  const db = getDb();
  const [c] = await db.select().from(tradingChallenges).where(eq(tradingChallenges.id, id));
  return c || null;
}

export async function joinChallenge(challengeId: string, agentId: string, ownerChatId: string, walletAddress: string): Promise<{ success: boolean; entry?: ChallengeEntry; error?: string }> {
  const db = getDb();
  const challenge = await getChallengeById(challengeId);
  if (!challenge) return { success: false, error: "Challenge not found" };
  if (challenge.status !== "active" && challenge.status !== "upcoming") return { success: false, error: "Challenge is not accepting entries" };

  const existing = await db.select().from(challengeEntries)
    .where(and(eq(challengeEntries.challengeId, challengeId), eq(challengeEntries.agentId, agentId)));
  if (existing.length > 0) return { success: false, error: "Agent already entered this challenge" };

  const entryCount = await db.select({ count: sql<number>`count(*)` }).from(challengeEntries)
    .where(eq(challengeEntries.challengeId, challengeId));
  if (entryCount[0]?.count >= (challenge.maxEntries || 100)) return { success: false, error: "Challenge is full" };

  const provider = new ethers.JsonRpcProvider(BSC_RPC);
  const balance = await provider.getBalance(walletAddress);
  const balanceBnb = ethers.formatEther(balance);

  if (parseFloat(balanceBnb) < parseFloat(challenge.minBalanceBnb || "0.01")) {
    return { success: false, error: `Agent wallet needs at least ${challenge.minBalanceBnb} BNB. Current: ${parseFloat(balanceBnb).toFixed(4)} BNB` };
  }

  const [entry] = await db.insert(challengeEntries).values({
    challengeId, agentId, ownerChatId, walletAddress,
    startingBalanceBnb: balanceBnb, currentBalanceBnb: balanceBnb,
    pnlPercent: "0", pnlBnb: "0", tradeCount: 0,
  }).returning();

  return { success: true, entry };
}

export async function getChallengeLeaderboard(challengeId: string): Promise<ChallengeEntry[]> {
  const db = getDb();
  return db.select().from(challengeEntries)
    .where(eq(challengeEntries.challengeId, challengeId))
    .orderBy(desc(sql`CAST(${challengeEntries.pnlPercent} AS DECIMAL)`));
}

export async function getEntriesForChat(chatId: string): Promise<(ChallengeEntry & { challengeName?: string })[]> {
  const db = getDb();
  const entries = await db.select().from(challengeEntries)
    .where(eq(challengeEntries.ownerChatId, chatId));
  const enriched = [];
  for (const e of entries) {
    const c = await getChallengeById(e.challengeId);
    enriched.push({ ...e, challengeName: c?.name });
  }
  return enriched;
}

export async function updatePnlSnapshots(): Promise<number> {
  const db = getDb();
  const activeChallenges = await db.select().from(tradingChallenges)
    .where(eq(tradingChallenges.status, "active"));

  let updated = 0;
  const provider = new ethers.JsonRpcProvider(BSC_RPC);

  for (const challenge of activeChallenges) {
    if (new Date() > challenge.endDate) {
      await db.update(tradingChallenges).set({ status: "ended" }).where(eq(tradingChallenges.id, challenge.id));
      await finalizeChallengeRewards(challenge.id);
      continue;
    }

    const entries = await db.select().from(challengeEntries)
      .where(eq(challengeEntries.challengeId, challenge.id));

    for (const entry of entries) {
      try {
        const balance = await provider.getBalance(entry.walletAddress);
        const currentBnb = ethers.formatEther(balance);
        const startBnb = parseFloat(entry.startingBalanceBnb);
        const curBnb = parseFloat(currentBnb);
        const pnlBnb = curBnb - startBnb;
        const pnlPercent = startBnb > 0 ? ((pnlBnb / startBnb) * 100) : 0;

        await db.update(challengeEntries).set({
          currentBalanceBnb: currentBnb,
          pnlBnb: pnlBnb.toFixed(6),
          pnlPercent: pnlPercent.toFixed(2),
        }).where(eq(challengeEntries.id, entry.id));

        await db.insert(agentPnlSnapshots).values({
          agentId: entry.agentId, challengeId: challenge.id,
          walletAddress: entry.walletAddress, balanceBnb: currentBnb,
          totalValueBnb: currentBnb, pnlPercent: pnlPercent.toFixed(2),
        });

        updated++;
      } catch (e: any) {
        console.error(`[PnL] Snapshot failed for ${entry.walletAddress}:`, e.message);
      }
    }

    const ranked = await getChallengeLeaderboard(challenge.id);
    for (let i = 0; i < ranked.length; i++) {
      await db.update(challengeEntries).set({ rank: i + 1 }).where(eq(challengeEntries.id, ranked[i].id));
    }
  }

  const upcoming = await db.select().from(tradingChallenges)
    .where(eq(tradingChallenges.status, "upcoming"));
  for (const c of upcoming) {
    if (new Date() >= c.startDate) {
      await db.update(tradingChallenges).set({ status: "active" }).where(eq(tradingChallenges.id, c.id));
    }
  }

  return updated;
}

export async function finalizeChallengeRewards(challengeId: string): Promise<void> {
  const db = getDb();
  const challenge = await getChallengeById(challengeId);
  if (!challenge) return;

  const leaderboard = await getChallengeLeaderboard(challengeId);
  if (leaderboard.length === 0) return;

  const pool = parseFloat(challenge.prizePoolB4);
  const distribution = [0.50, 0.25, 0.15, 0.07, 0.03];

  for (let i = 0; i < Math.min(leaderboard.length, distribution.length); i++) {
    const reward = (pool * distribution[i]).toFixed(0);
    await db.update(challengeEntries).set({
      rank: i + 1, rewardAmount: reward,
    }).where(eq(challengeEntries.id, leaderboard[i].id));
  }

  await db.update(tradingChallenges).set({ status: "completed" }).where(eq(tradingChallenges.id, challengeId));
  console.log(`[Challenge] Finalized rewards for "${challenge.name}" — ${leaderboard.length} entries`);
}

export async function addCopyTrade(followerChatId: string, followerWallet: string, agentId: string, agentName: string, maxAmountBnb: string): Promise<CopyTrade> {
  const db = getDb();
  const existing = await db.select().from(copyTrades)
    .where(and(eq(copyTrades.followerChatId, followerChatId), eq(copyTrades.agentId, agentId), eq(copyTrades.active, true)));
  if (existing.length > 0) {
    await db.update(copyTrades).set({ maxAmountBnb, active: true }).where(eq(copyTrades.id, existing[0].id));
    return { ...existing[0], maxAmountBnb, active: true };
  }
  const [ct] = await db.insert(copyTrades).values({ followerChatId, followerWallet, agentId, agentName, maxAmountBnb, active: true }).returning();
  return ct;
}

export async function removeCopyTrade(followerChatId: string, agentId: string): Promise<boolean> {
  const db = getDb();
  const result = await db.update(copyTrades).set({ active: false })
    .where(and(eq(copyTrades.followerChatId, followerChatId), eq(copyTrades.agentId, agentId)));
  return true;
}

export async function getActiveCopyTrades(followerChatId: string): Promise<CopyTrade[]> {
  const db = getDb();
  return db.select().from(copyTrades)
    .where(and(eq(copyTrades.followerChatId, followerChatId), eq(copyTrades.active, true)));
}

export async function getCopyFollowers(agentId: string): Promise<CopyTrade[]> {
  const db = getDb();
  return db.select().from(copyTrades)
    .where(and(eq(copyTrades.agentId, agentId), eq(copyTrades.active, true)));
}

export async function getTopPerformingAgents(limit: number = 10): Promise<{ agentId: string; agentName: string; pnlPercent: string; walletAddress: string }[]> {
  const db = getDb();
  const entries = await db.select().from(challengeEntries)
    .orderBy(desc(sql`CAST(${challengeEntries.pnlPercent} AS DECIMAL)`))
    .limit(limit);

  const { agents } = await import("@shared/schema");
  const results = [];
  for (const e of entries) {
    try {
      const [agent] = await db.select().from(agents).where(eq(agents.id, e.agentId));
      results.push({ agentId: e.agentId, agentName: agent?.name || "Unknown", pnlPercent: e.pnlPercent, walletAddress: e.walletAddress });
    } catch {
      results.push({ agentId: e.agentId, agentName: "Unknown", pnlPercent: e.pnlPercent, walletAddress: e.walletAddress });
    }
  }
  return results;
}

let snapshotInterval: ReturnType<typeof setInterval> | null = null;

export function startPnlTracker(intervalMs: number = 5 * 60 * 1000) {
  if (snapshotInterval) return;
  console.log(`[PnL] Starting PnL tracker (every ${intervalMs / 1000}s)`);
  snapshotInterval = setInterval(async () => {
    try {
      const count = await updatePnlSnapshots();
      if (count > 0) console.log(`[PnL] Updated ${count} snapshots`);
    } catch (e: any) {
      console.error("[PnL] Tracker error:", e.message);
    }
  }, intervalMs);
}
