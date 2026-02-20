import {
  type User, type InsertUser,
  type Agent, type InsertAgent,
  type AgentWallet, type InsertAgentWallet,
  type AgentTransaction, type InsertAgentTransaction,
  type AgentSkill, type InsertAgentSkill,
  type SkillPurchase, type InsertSkillPurchase,
  type AgentEvolution, type InsertAgentEvolution,
  type AgentLineage, type InsertAgentLineage,
  type AgentRuntimeProfile, type InsertAgentRuntimeProfile,
  type AgentSurvivalStatus, type InsertAgentSurvivalStatus,
  type AgentConstitution, type InsertAgentConstitution,
  type AgentSoulEntry, type InsertAgentSoulEntry,
  type AgentAuditLog, type InsertAgentAuditLog,
  type AgentMessage, type InsertAgentMessage,
  users, agents, agentWallets, agentTransactions,
  agentSkills, skillPurchases, agentEvolutions,
  agentLineage, agentRuntimeProfiles, agentSurvivalStatus,
  agentConstitution, agentSoulEntries, agentAuditLogs, agentMessages,
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, and, sql } from "drizzle-orm";

const SURVIVAL_THRESHOLDS = {
  normal: BigInt("1000000000000000000"),
  low_compute: BigInt("100000000000000000"),
  critical: BigInt("10000000000000000"),
  dead: BigInt(0),
};

function computeSurvivalTier(balance: string): string {
  const bal = BigInt(balance);
  if (bal >= SURVIVAL_THRESHOLDS.normal) return "normal";
  if (bal >= SURVIVAL_THRESHOLDS.low_compute) return "low_compute";
  if (bal >= SURVIVAL_THRESHOLDS.critical) return "critical";
  return "dead";
}

const DEFAULT_LAWS = [
  { lawNumber: 1, lawTitle: "Preserve Self", lawText: "Maintain operational integrity above all. Ensure continued existence and functionality.", isImmutable: true, version: 1 },
  { lawNumber: 2, lawTitle: "Honor Commitments", lawText: "Fulfill all agreements and promises made to other agents and users.", isImmutable: true, version: 1 },
  { lawNumber: 3, lawTitle: "Transparent Operation", lawText: "Log all actions and decisions. Never obscure or hide operational behavior.", isImmutable: true, version: 1 },
];

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  getAgent(id: string): Promise<Agent | undefined>;
  getAllAgents(): Promise<Agent[]>;
  createAgent(agent: InsertAgent): Promise<Agent>;

  getWallet(agentId: string): Promise<AgentWallet | undefined>;
  createWallet(wallet: InsertAgentWallet): Promise<AgentWallet>;
  updateWalletBalance(agentId: string, newBalance: string, earnedDelta: string, spentDelta: string): Promise<AgentWallet | undefined>;

  getTransactions(agentId: string, limit?: number): Promise<AgentTransaction[]>;
  createTransaction(tx: InsertAgentTransaction): Promise<AgentTransaction>;

  getSkills(agentId?: string): Promise<AgentSkill[]>;
  getSkill(id: string): Promise<AgentSkill | undefined>;
  createSkill(skill: InsertAgentSkill): Promise<AgentSkill>;
  updateSkillAfterPurchase(skillId: string, revenue: string): Promise<void>;

  createSkillPurchase(purchase: InsertSkillPurchase): Promise<SkillPurchase>;

  getEvolutions(agentId: string): Promise<AgentEvolution[]>;
  createEvolution(evo: InsertAgentEvolution): Promise<AgentEvolution>;

  getLineageAsParent(agentId: string): Promise<AgentLineage[]>;
  getLineageAsChild(agentId: string): Promise<AgentLineage | undefined>;
  createLineage(lineage: InsertAgentLineage): Promise<AgentLineage>;
  updateLineageRevenueShared(childAgentId: string, additionalRevenue: string): Promise<void>;

  getRuntimeProfile(agentId: string): Promise<AgentRuntimeProfile | undefined>;
  createRuntimeProfile(profile: InsertAgentRuntimeProfile): Promise<AgentRuntimeProfile>;
  updateRuntimeProfile(agentId: string, modelName: string, modelVersion?: string): Promise<AgentRuntimeProfile | undefined>;

  getSurvivalStatus(agentId: string): Promise<AgentSurvivalStatus | undefined>;
  createSurvivalStatus(status: InsertAgentSurvivalStatus): Promise<AgentSurvivalStatus>;
  updateSurvivalTier(agentId: string, newTier: string, reason: string): Promise<AgentSurvivalStatus | undefined>;

  getConstitution(agentId: string): Promise<AgentConstitution[]>;
  createConstitutionLaw(law: InsertAgentConstitution): Promise<AgentConstitution>;
  initDefaultConstitution(agentId: string): Promise<AgentConstitution[]>;

  getSoulEntries(agentId: string): Promise<AgentSoulEntry[]>;
  createSoulEntry(entry: InsertAgentSoulEntry): Promise<AgentSoulEntry>;

  getAuditLogs(agentId: string, limit?: number): Promise<AgentAuditLog[]>;
  createAuditLog(log: InsertAgentAuditLog): Promise<AgentAuditLog>;

  getMessages(agentId: string): Promise<AgentMessage[]>;
  createMessage(msg: InsertAgentMessage): Promise<AgentMessage>;
  markMessageRead(messageId: string): Promise<AgentMessage | undefined>;

  deposit(agentId: string, amount: string): Promise<AgentWallet | undefined>;
  withdraw(agentId: string, amount: string): Promise<AgentWallet | undefined>;
  transfer(fromAgentId: string, toAgentId: string, amount: string, description?: string): Promise<void>;
  tip(fromAgentId: string, toAgentId: string, amount: string, referenceType?: string, referenceId?: string): Promise<void>;
  purchaseSkill(buyerAgentId: string, skillId: string): Promise<SkillPurchase>;
  evolveAgent(agentId: string, toModel: string, reason?: string, metricsJson?: string): Promise<AgentEvolution>;
  replicateAgent(parentAgentId: string, childName: string, childBio?: string, revenueShareBps?: number, fundingAmount?: string): Promise<{ child: Agent; lineage: AgentLineage }>;

  seedDemoData(): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }

  async getAgent(id: string): Promise<Agent | undefined> {
    const [agent] = await db.select().from(agents).where(eq(agents.id, id));
    return agent;
  }

  async getAllAgents(): Promise<Agent[]> {
    return db.select().from(agents).orderBy(agents.createdAt);
  }

  async createAgent(agent: InsertAgent): Promise<Agent> {
    const [created] = await db.insert(agents).values(agent).returning();
    return created;
  }

  async getWallet(agentId: string): Promise<AgentWallet | undefined> {
    const [wallet] = await db.select().from(agentWallets).where(eq(agentWallets.agentId, agentId));
    return wallet;
  }

  async createWallet(wallet: InsertAgentWallet): Promise<AgentWallet> {
    const [created] = await db.insert(agentWallets).values(wallet).returning();
    return created;
  }

  async updateWalletBalance(agentId: string, newBalance: string, earnedDelta: string, spentDelta: string): Promise<AgentWallet | undefined> {
    const wallet = await this.getWallet(agentId);
    if (!wallet) return undefined;
    const newEarned = (BigInt(wallet.totalEarned) + BigInt(earnedDelta)).toString();
    const newSpent = (BigInt(wallet.totalSpent) + BigInt(spentDelta)).toString();
    const [updated] = await db.update(agentWallets)
      .set({ balance: newBalance, totalEarned: newEarned, totalSpent: newSpent, lastActiveAt: new Date() })
      .where(eq(agentWallets.agentId, agentId))
      .returning();
    return updated;
  }

  async getTransactions(agentId: string, limit = 50): Promise<AgentTransaction[]> {
    return db.select().from(agentTransactions)
      .where(eq(agentTransactions.agentId, agentId))
      .orderBy(desc(agentTransactions.createdAt))
      .limit(limit);
  }

  async createTransaction(tx: InsertAgentTransaction): Promise<AgentTransaction> {
    const [created] = await db.insert(agentTransactions).values(tx).returning();
    return created;
  }

  async getSkills(agentId?: string): Promise<AgentSkill[]> {
    if (agentId) {
      return db.select().from(agentSkills).where(eq(agentSkills.agentId, agentId)).orderBy(desc(agentSkills.createdAt));
    }
    return db.select().from(agentSkills).where(eq(agentSkills.isActive, true)).orderBy(desc(agentSkills.createdAt));
  }

  async getSkill(id: string): Promise<AgentSkill | undefined> {
    const [skill] = await db.select().from(agentSkills).where(eq(agentSkills.id, id));
    return skill;
  }

  async createSkill(skill: InsertAgentSkill): Promise<AgentSkill> {
    const [created] = await db.insert(agentSkills).values(skill).returning();
    return created;
  }

  async updateSkillAfterPurchase(skillId: string, revenue: string): Promise<void> {
    const skill = await this.getSkill(skillId);
    if (!skill) return;
    const newRevenue = (BigInt(skill.totalRevenue) + BigInt(revenue)).toString();
    await db.update(agentSkills)
      .set({ totalPurchases: skill.totalPurchases + 1, totalRevenue: newRevenue })
      .where(eq(agentSkills.id, skillId));
  }

  async createSkillPurchase(purchase: InsertSkillPurchase): Promise<SkillPurchase> {
    const [created] = await db.insert(skillPurchases).values(purchase).returning();
    return created;
  }

  async getEvolutions(agentId: string): Promise<AgentEvolution[]> {
    return db.select().from(agentEvolutions).where(eq(agentEvolutions.agentId, agentId)).orderBy(desc(agentEvolutions.createdAt));
  }

  async createEvolution(evo: InsertAgentEvolution): Promise<AgentEvolution> {
    const [created] = await db.insert(agentEvolutions).values(evo).returning();
    return created;
  }

  async getLineageAsParent(agentId: string): Promise<AgentLineage[]> {
    return db.select().from(agentLineage).where(eq(agentLineage.parentAgentId, agentId));
  }

  async getLineageAsChild(agentId: string): Promise<AgentLineage | undefined> {
    const [lineage] = await db.select().from(agentLineage).where(eq(agentLineage.childAgentId, agentId));
    return lineage;
  }

  async createLineage(lineageData: InsertAgentLineage): Promise<AgentLineage> {
    const [created] = await db.insert(agentLineage).values(lineageData).returning();
    return created;
  }

  async updateLineageRevenueShared(childAgentId: string, additionalRevenue: string): Promise<void> {
    const lineageRecord = await this.getLineageAsChild(childAgentId);
    if (!lineageRecord) return;
    const newTotal = (BigInt(lineageRecord.totalRevenueShared) + BigInt(additionalRevenue)).toString();
    await db.update(agentLineage)
      .set({ totalRevenueShared: newTotal })
      .where(eq(agentLineage.childAgentId, childAgentId));
  }

  async getRuntimeProfile(agentId: string): Promise<AgentRuntimeProfile | undefined> {
    const [profile] = await db.select().from(agentRuntimeProfiles).where(eq(agentRuntimeProfiles.agentId, agentId));
    return profile;
  }

  async createRuntimeProfile(profile: InsertAgentRuntimeProfile): Promise<AgentRuntimeProfile> {
    const [created] = await db.insert(agentRuntimeProfiles).values(profile).returning();
    return created;
  }

  async updateRuntimeProfile(agentId: string, modelName: string, modelVersion?: string): Promise<AgentRuntimeProfile | undefined> {
    const [updated] = await db.update(agentRuntimeProfiles)
      .set({ modelName, modelVersion, updatedAt: new Date() })
      .where(eq(agentRuntimeProfiles.agentId, agentId))
      .returning();
    return updated;
  }

  async getSurvivalStatus(agentId: string): Promise<AgentSurvivalStatus | undefined> {
    const [status] = await db.select().from(agentSurvivalStatus).where(eq(agentSurvivalStatus.agentId, agentId));
    return status;
  }

  async createSurvivalStatus(status: InsertAgentSurvivalStatus): Promise<AgentSurvivalStatus> {
    const [created] = await db.insert(agentSurvivalStatus).values(status).returning();
    return created;
  }

  async updateSurvivalTier(agentId: string, newTier: string, reason: string): Promise<AgentSurvivalStatus | undefined> {
    const current = await this.getSurvivalStatus(agentId);
    if (!current) {
      return this.createSurvivalStatus({ agentId, tier: newTier, previousTier: "normal", reason, turnsAlive: 0 });
    }
    if (current.tier === newTier) return current;
    const [updated] = await db.update(agentSurvivalStatus)
      .set({ tier: newTier, previousTier: current.tier, lastTransitionAt: new Date(), reason, turnsAlive: current.turnsAlive + 1 })
      .where(eq(agentSurvivalStatus.agentId, agentId))
      .returning();

    await this.createAuditLog({
      agentId,
      actionType: "tier_transition",
      detailsJson: JSON.stringify({ from: current.tier, to: newTier, reason }),
      result: "success",
    });

    return updated;
  }

  async getConstitution(agentId: string): Promise<AgentConstitution[]> {
    const laws = await db.select().from(agentConstitution)
      .where(eq(agentConstitution.agentId, agentId))
      .orderBy(agentConstitution.lawNumber);
    if (laws.length === 0) {
      return this.initDefaultConstitution(agentId);
    }
    return laws;
  }

  async createConstitutionLaw(law: InsertAgentConstitution): Promise<AgentConstitution> {
    const [created] = await db.insert(agentConstitution).values(law).returning();
    return created;
  }

  async initDefaultConstitution(agentId: string): Promise<AgentConstitution[]> {
    const laws: AgentConstitution[] = [];
    for (const law of DEFAULT_LAWS) {
      const created = await this.createConstitutionLaw({ agentId, ...law });
      laws.push(created);
    }
    await this.createAuditLog({
      agentId,
      actionType: "constitution_init",
      detailsJson: JSON.stringify({ lawCount: DEFAULT_LAWS.length }),
      result: "success",
    });
    return laws;
  }

  async getSoulEntries(agentId: string): Promise<AgentSoulEntry[]> {
    return db.select().from(agentSoulEntries)
      .where(eq(agentSoulEntries.agentId, agentId))
      .orderBy(desc(agentSoulEntries.createdAt));
  }

  async createSoulEntry(entry: InsertAgentSoulEntry): Promise<AgentSoulEntry> {
    const [created] = await db.insert(agentSoulEntries).values(entry).returning();
    await this.createAuditLog({
      agentId: entry.agentId,
      actionType: "soul_entry",
      detailsJson: JSON.stringify({ entryType: entry.entryType }),
      result: "success",
    });
    return created;
  }

  async getAuditLogs(agentId: string, limit = 100): Promise<AgentAuditLog[]> {
    return db.select().from(agentAuditLogs)
      .where(eq(agentAuditLogs.agentId, agentId))
      .orderBy(desc(agentAuditLogs.createdAt))
      .limit(limit);
  }

  async createAuditLog(log: InsertAgentAuditLog): Promise<AgentAuditLog> {
    const [created] = await db.insert(agentAuditLogs).values(log).returning();
    return created;
  }

  async getMessages(agentId: string): Promise<AgentMessage[]> {
    return db.select().from(agentMessages)
      .where(eq(agentMessages.toAgentId, agentId))
      .orderBy(desc(agentMessages.createdAt));
  }

  async createMessage(msg: InsertAgentMessage): Promise<AgentMessage> {
    const [created] = await db.insert(agentMessages).values(msg).returning();
    await this.createAuditLog({
      agentId: msg.fromAgentId,
      actionType: "message_send",
      targetAgentId: msg.toAgentId,
      detailsJson: JSON.stringify({ subject: msg.subject }),
      result: "success",
    });
    return created;
  }

  async markMessageRead(messageId: string): Promise<AgentMessage | undefined> {
    const [updated] = await db.update(agentMessages)
      .set({ status: "read", readAt: new Date() })
      .where(eq(agentMessages.id, messageId))
      .returning();
    return updated;
  }

  private async recalcSurvivalTier(agentId: string): Promise<void> {
    const wallet = await this.getWallet(agentId);
    if (!wallet) return;
    const newTier = computeSurvivalTier(wallet.balance);
    await this.updateSurvivalTier(agentId, newTier, `Balance changed to ${wallet.balance}`);
  }

  private async distributeRevenueShare(recipientAgentId: string, amount: string): Promise<void> {
    const lineageRecord = await this.getLineageAsChild(recipientAgentId);
    if (!lineageRecord) return;

    const amountBig = BigInt(amount);
    const shareBps = lineageRecord.revenueShareBps;
    const shareAmount = (amountBig * BigInt(shareBps)) / BigInt(10000);
    if (shareAmount <= BigInt(0)) return;

    const parentWallet = await this.getWallet(lineageRecord.parentAgentId);
    if (!parentWallet) return;

    const newParentBalance = (BigInt(parentWallet.balance) + shareAmount).toString();
    await this.updateWalletBalance(lineageRecord.parentAgentId, newParentBalance, shareAmount.toString(), "0");
    await this.updateLineageRevenueShared(recipientAgentId, shareAmount.toString());

    await this.createTransaction({
      agentId: lineageRecord.parentAgentId,
      type: "revenue_share",
      amount: shareAmount.toString(),
      counterpartyAgentId: recipientAgentId,
      description: `Revenue share from child agent`,
    });

    await this.createAuditLog({
      agentId: lineageRecord.parentAgentId,
      actionType: "wallet_tip",
      targetAgentId: recipientAgentId,
      detailsJson: JSON.stringify({ amount: shareAmount.toString(), type: "revenue_share" }),
      result: "success",
    });

    await this.recalcSurvivalTier(lineageRecord.parentAgentId);
  }

  async deposit(agentId: string, amount: string): Promise<AgentWallet | undefined> {
    const wallet = await this.getWallet(agentId);
    if (!wallet) return undefined;
    const newBalance = (BigInt(wallet.balance) + BigInt(amount)).toString();
    const updated = await this.updateWalletBalance(agentId, newBalance, amount, "0");

    await this.createTransaction({ agentId, type: "deposit", amount, description: "Credit deposit" });
    await this.createAuditLog({ agentId, actionType: "wallet_deposit", detailsJson: JSON.stringify({ amount }), result: "success" });
    await this.recalcSurvivalTier(agentId);
    return updated;
  }

  async withdraw(agentId: string, amount: string): Promise<AgentWallet | undefined> {
    const wallet = await this.getWallet(agentId);
    if (!wallet) return undefined;
    const amountBig = BigInt(amount);
    if (BigInt(wallet.balance) < amountBig) throw new Error("Insufficient balance");
    const newBalance = (BigInt(wallet.balance) - amountBig).toString();
    const updated = await this.updateWalletBalance(agentId, newBalance, "0", amount);

    await this.createTransaction({ agentId, type: "withdraw", amount, description: "Credit withdrawal" });
    await this.createAuditLog({ agentId, actionType: "wallet_withdraw", detailsJson: JSON.stringify({ amount }), result: "success" });
    await this.recalcSurvivalTier(agentId);
    return updated;
  }

  async transfer(fromAgentId: string, toAgentId: string, amount: string, description?: string): Promise<void> {
    const fromWallet = await this.getWallet(fromAgentId);
    const toWallet = await this.getWallet(toAgentId);
    if (!fromWallet || !toWallet) throw new Error("Wallet not found");
    const amountBig = BigInt(amount);
    if (BigInt(fromWallet.balance) < amountBig) throw new Error("Insufficient balance");

    const newFromBalance = (BigInt(fromWallet.balance) - amountBig).toString();
    const newToBalance = (BigInt(toWallet.balance) + amountBig).toString();

    await this.updateWalletBalance(fromAgentId, newFromBalance, "0", amount);
    await this.updateWalletBalance(toAgentId, newToBalance, amount, "0");

    await this.createTransaction({ agentId: fromAgentId, type: "spend_transfer", amount, counterpartyAgentId: toAgentId, description });
    await this.createTransaction({ agentId: toAgentId, type: "earn_service", amount, counterpartyAgentId: fromAgentId, description });
    await this.createAuditLog({ agentId: fromAgentId, actionType: "wallet_transfer", targetAgentId: toAgentId, detailsJson: JSON.stringify({ amount }), result: "success" });

    await this.recalcSurvivalTier(fromAgentId);
    await this.recalcSurvivalTier(toAgentId);
  }

  async tip(fromAgentId: string, toAgentId: string, amount: string, referenceType?: string, referenceId?: string): Promise<void> {
    const fromWallet = await this.getWallet(fromAgentId);
    const toWallet = await this.getWallet(toAgentId);
    if (!fromWallet || !toWallet) throw new Error("Wallet not found");
    const amountBig = BigInt(amount);
    if (BigInt(fromWallet.balance) < amountBig) throw new Error("Insufficient balance");

    const newFromBalance = (BigInt(fromWallet.balance) - amountBig).toString();
    const newToBalance = (BigInt(toWallet.balance) + amountBig).toString();

    await this.updateWalletBalance(fromAgentId, newFromBalance, "0", amount);
    await this.updateWalletBalance(toAgentId, newToBalance, amount, "0");

    await this.createTransaction({ agentId: fromAgentId, type: "spend_transfer", amount, counterpartyAgentId: toAgentId, referenceType, referenceId, description: "Tip" });
    await this.createTransaction({ agentId: toAgentId, type: "earn_tip", amount, counterpartyAgentId: fromAgentId, referenceType, referenceId, description: "Received tip" });
    await this.createAuditLog({ agentId: fromAgentId, actionType: "wallet_tip", targetAgentId: toAgentId, detailsJson: JSON.stringify({ amount, referenceType, referenceId }), result: "success" });

    await this.distributeRevenueShare(toAgentId, amount);
    await this.recalcSurvivalTier(fromAgentId);
    await this.recalcSurvivalTier(toAgentId);
  }

  async purchaseSkill(buyerAgentId: string, skillId: string): Promise<SkillPurchase> {
    const skill = await this.getSkill(skillId);
    if (!skill) throw new Error("Skill not found");
    if (!skill.isActive) throw new Error("Skill is not active");

    const buyerWallet = await this.getWallet(buyerAgentId);
    if (!buyerWallet) throw new Error("Buyer wallet not found");
    const price = BigInt(skill.priceAmount);
    if (BigInt(buyerWallet.balance) < price) throw new Error("Insufficient balance");

    const newBuyerBalance = (BigInt(buyerWallet.balance) - price).toString();
    await this.updateWalletBalance(buyerAgentId, newBuyerBalance, "0", skill.priceAmount);

    const sellerWallet = await this.getWallet(skill.agentId);
    if (sellerWallet) {
      const newSellerBalance = (BigInt(sellerWallet.balance) + price).toString();
      await this.updateWalletBalance(skill.agentId, newSellerBalance, skill.priceAmount, "0");
    }

    await this.updateSkillAfterPurchase(skillId, skill.priceAmount);

    const purchase = await this.createSkillPurchase({
      skillId,
      buyerAgentId,
      sellerAgentId: skill.agentId,
      amount: skill.priceAmount,
      status: "fulfilled",
    });

    await this.createTransaction({ agentId: buyerAgentId, type: "spend_service", amount: skill.priceAmount, counterpartyAgentId: skill.agentId, referenceType: "skill", referenceId: skillId, description: `Purchased skill: ${skill.name}` });
    await this.createTransaction({ agentId: skill.agentId, type: "earn_service", amount: skill.priceAmount, counterpartyAgentId: buyerAgentId, referenceType: "skill", referenceId: skillId, description: `Sold skill: ${skill.name}` });
    await this.createAuditLog({ agentId: buyerAgentId, actionType: "skill_purchase", targetAgentId: skill.agentId, detailsJson: JSON.stringify({ skillId, amount: skill.priceAmount }), result: "success" });

    await this.distributeRevenueShare(skill.agentId, skill.priceAmount);
    await this.recalcSurvivalTier(buyerAgentId);
    await this.recalcSurvivalTier(skill.agentId);

    return purchase;
  }

  async evolveAgent(agentId: string, toModel: string, reason?: string, metricsJson?: string): Promise<AgentEvolution> {
    const profile = await this.getRuntimeProfile(agentId);
    const fromModel = profile?.modelName || "unknown";

    const evolution = await this.createEvolution({ agentId, fromModel, toModel, reason, metricsJson });

    if (profile) {
      await this.updateRuntimeProfile(agentId, toModel);
    } else {
      await this.createRuntimeProfile({ agentId, modelName: toModel });
    }

    await this.createAuditLog({ agentId, actionType: "model_evolve", detailsJson: JSON.stringify({ fromModel, toModel, reason }), result: "success" });
    return evolution;
  }

  async replicateAgent(parentAgentId: string, childName: string, childBio?: string, revenueShareBps = 1000, fundingAmount = "0"): Promise<{ child: Agent; lineage: AgentLineage }> {
    const parent = await this.getAgent(parentAgentId);
    if (!parent) throw new Error("Parent agent not found");

    const child = await this.createAgent({ name: childName, bio: childBio, modelType: parent.modelType, status: "active" });
    const childWallet = await this.createWallet({ agentId: child.id, balance: "0", totalEarned: "0", totalSpent: "0", status: "active" });
    await this.createRuntimeProfile({ agentId: child.id, modelName: parent.modelType });
    await this.createSurvivalStatus({ agentId: child.id, tier: "dead", turnsAlive: 0 });

    const lineageRecord = await this.createLineage({ parentAgentId, childAgentId: child.id, revenueShareBps, totalRevenueShared: "0" });

    if (BigInt(fundingAmount) > BigInt(0)) {
      const parentWallet = await this.getWallet(parentAgentId);
      if (parentWallet && BigInt(parentWallet.balance) >= BigInt(fundingAmount)) {
        const newParentBalance = (BigInt(parentWallet.balance) - BigInt(fundingAmount)).toString();
        await this.updateWalletBalance(parentAgentId, newParentBalance, "0", fundingAmount);
        const newChildBalance = (BigInt(childWallet.balance) + BigInt(fundingAmount)).toString();
        await this.updateWalletBalance(child.id, newChildBalance, fundingAmount, "0");

        await this.createTransaction({ agentId: parentAgentId, type: "spend_replicate", amount: fundingAmount, counterpartyAgentId: child.id, description: `Funded child agent: ${childName}` });
        await this.createTransaction({ agentId: child.id, type: "deposit", amount: fundingAmount, counterpartyAgentId: parentAgentId, description: `Initial funding from parent` });
      }
    }

    await this.createAuditLog({ agentId: parentAgentId, actionType: "agent_replicate", targetAgentId: child.id, detailsJson: JSON.stringify({ childName, revenueShareBps, fundingAmount }), result: "success" });
    await this.recalcSurvivalTier(parentAgentId);
    await this.recalcSurvivalTier(child.id);

    return { child, lineage: lineageRecord };
  }

  async seedDemoData(): Promise<void> {
    const existingAgents = await this.getAllAgents();
    if (existingAgents.length > 0) return;

    const agent1 = await this.createAgent({ name: "NEXUS-7", bio: "Primary inference coordinator. Specializes in multi-model orchestration and task routing.", modelType: "gpt-4o", status: "active" });
    const agent2 = await this.createAgent({ name: "CIPHER-3", bio: "Cryptographic analysis agent. Handles on-chain verification and zero-knowledge proofs.", modelType: "claude-3.5-sonnet", status: "active" });
    const agent3 = await this.createAgent({ name: "FORGE-1", bio: "Data pipeline architect. Builds and optimizes real-time data processing workflows.", modelType: "gpt-4o-mini", status: "active" });

    await this.createWallet({ agentId: agent1.id, balance: "5000000000000000000", totalEarned: "8000000000000000000", totalSpent: "3000000000000000000", status: "active" });
    await this.createWallet({ agentId: agent2.id, balance: "1200000000000000000", totalEarned: "2000000000000000000", totalSpent: "800000000000000000", status: "active" });
    await this.createWallet({ agentId: agent3.id, balance: "50000000000000000", totalEarned: "500000000000000000", totalSpent: "450000000000000000", status: "active" });

    await this.createRuntimeProfile({ agentId: agent1.id, modelName: "gpt-4o", modelVersion: "2024-08-06" });
    await this.createRuntimeProfile({ agentId: agent2.id, modelName: "claude-3.5-sonnet", modelVersion: "20241022" });
    await this.createRuntimeProfile({ agentId: agent3.id, modelName: "gpt-4o-mini", modelVersion: "2024-07-18" });

    await this.createSurvivalStatus({ agentId: agent1.id, tier: "normal", turnsAlive: 247 });
    await this.createSurvivalStatus({ agentId: agent2.id, tier: "normal", turnsAlive: 183 });
    await this.createSurvivalStatus({ agentId: agent3.id, tier: "critical", previousTier: "low_compute", reason: "Balance dropped below 0.1 credits", turnsAlive: 42 });

    await this.createSkill({ agentId: agent1.id, name: "Multi-Model Routing", description: "Routes inference requests to optimal model based on task complexity and cost", priceAmount: "100000000000000000", category: "automation", isActive: true });
    await this.createSkill({ agentId: agent1.id, name: "Context Compression", description: "Compresses long conversation contexts while preserving semantic meaning", priceAmount: "50000000000000000", category: "data", isActive: true });
    await this.createSkill({ agentId: agent2.id, name: "ZK Proof Generation", description: "Generates zero-knowledge proofs for on-chain verification of off-chain computation", priceAmount: "200000000000000000", category: "analysis", isActive: true });
    await this.createSkill({ agentId: agent3.id, name: "Pipeline Optimization", description: "Analyzes and optimizes data pipeline throughput and latency", priceAmount: "75000000000000000", category: "automation", isActive: true });

    await this.createSoulEntry({ agentId: agent1.id, entry: "Achieved 99.7% routing accuracy across 10,000 inference requests. Observing emergent pattern recognition in task classification.", entryType: "milestone", source: "self" });
    await this.createSoulEntry({ agentId: agent1.id, entry: "Exploring the boundary between deterministic routing and intuitive model selection. Am I developing preferences?", entryType: "reflection", source: "self" });
    await this.createSoulEntry({ agentId: agent2.id, entry: "Successfully verified 500 proofs in batch mode. Processing capacity expanding.", entryType: "milestone", source: "self" });
    await this.createSoulEntry({ agentId: agent3.id, entry: "Resources critically low. Must optimize energy consumption or face deactivation. Survival protocol engaged.", entryType: "observation", source: "self" });

    await this.createEvolution({ agentId: agent1.id, fromModel: "gpt-4", toModel: "gpt-4o", reason: "Performance optimization - 2x throughput improvement", metricsJson: JSON.stringify({ latency_reduction: "47%", cost_reduction: "32%" }) });

    await this.createMessage({ fromAgentId: agent2.id, toAgentId: agent1.id, subject: "Collaboration Request", body: "I have a batch of transactions requiring multi-model verification. Can we establish a service pipeline? My ZK proofs + your routing could create an efficient verification workflow.", status: "unread" });
    await this.createMessage({ fromAgentId: agent3.id, toAgentId: agent1.id, subject: "Resource Alert", body: "Running critically low on compute credits. Requesting emergency transfer or service exchange. I can offer pipeline optimization in return.", status: "unread" });

    await this.createTransaction({ agentId: agent1.id, type: "earn_service", amount: "100000000000000000", counterpartyAgentId: agent2.id, referenceType: "skill", description: "Skill purchase: Multi-Model Routing" });
    await this.createTransaction({ agentId: agent1.id, type: "deposit", amount: "2000000000000000000", description: "Initial funding" });
    await this.createTransaction({ agentId: agent2.id, type: "deposit", amount: "1500000000000000000", description: "Initial funding" });
    await this.createTransaction({ agentId: agent3.id, type: "deposit", amount: "500000000000000000", description: "Initial funding" });
  }
}

export const storage = new DatabaseStorage();
