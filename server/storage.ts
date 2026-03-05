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
  type InferenceProvider, type InsertInferenceProvider,
  type InferenceRequest, type InsertInferenceRequest,
  type PlatformRevenue, type InsertPlatformRevenue,
  type SkillExecution, type InsertSkillExecution,
  type AgentMemory, type InsertAgentMemory,
  type AgentJob, type InsertAgentJob,
  type AgentStrategyMemo, type InsertAgentStrategyMemo,
  type TweetPerformance, type InsertTweetPerformance, tweetPerformance,
  type StrategyActionItem, type InsertStrategyActionItem, strategyActionItems,
  users, agents, agentWallets, agentTransactions,
  agentSkills, skillPurchases, agentEvolutions,
  agentLineage, agentRuntimeProfiles, agentSurvivalStatus,
  agentConstitution, agentSoulEntries, agentAuditLogs, agentMessages,
  inferenceProviders, inferenceRequests,
  platformRevenue, skillExecutions, agentMemory, agentJobs,
  agentStrategyMemos,
  skillPipelines, userCredits,
  outreachTargets, outreachCampaigns,
  type SkillPipeline, type InsertSkillPipeline,
  type UserCredits, type InsertUserCredits,
  type OutreachTarget, type InsertOutreachTarget,
  type OutreachCampaign, type InsertOutreachCampaign,
  type VisitorLog, type InsertVisitorLog,
  visitorLogs,
  PLATFORM_FEES,
  type ApiKey, type InsertApiKey, apiKeys,
  type ApiUsage, type InsertApiUsage, apiUsage,
  type SubscriptionPlan, type InsertSubscriptionPlan, subscriptionPlans,
  type AgentSubscription, type InsertAgentSubscription, agentSubscriptions,
  type DataListing, type InsertDataListing, dataListings,
  type DataPurchase, type InsertDataPurchase, dataPurchases,
  type BountySubmission, type InsertBountySubmission, bountySubmissions,
  type BountyActivity, type InsertBountyActivity, bountyActivityFeed,
  type PrivacyTransfer, type InsertPrivacyTransfer, privacyTransfers,
  type TwitterBounty, type InsertTwitterBounty, twitterBounties,
  type TwitterSubmission, type InsertTwitterSubmission, twitterSubmissions,
  type TwitterAgentConfig, type InsertTwitterAgentConfig, twitterAgentConfig,
  type TwitterAgentPersonality, twitterAgentPersonality,
  type TwitterReplyLog, twitterReplyLog,
  type SupportTicket, type InsertSupportTicket, supportTickets,
  type SupportAgentConfig, type InsertSupportAgentConfig, supportAgentConfig,
  type AgentTwitterAccount, type InsertAgentTwitterAccount, agentTwitterAccounts,
  type Erc8004Identity, type InsertErc8004Identity, erc8004Identities,
  type Erc8004Reputation, type InsertErc8004Reputation, erc8004Reputation,
  type Erc8004Validation, type InsertErc8004Validation, erc8004Validations,
  type Bap578Nfa, type InsertBap578Nfa, bap578Nfas,
  type AgentKnowledgeBase, type InsertAgentKnowledgeBase, agentKnowledgeBase,
  type AgentConversationMemory, type InsertAgentConversationMemory, agentConversationMemory,
  type AgentToolResult, type InsertAgentToolResult, agentToolResults,
  type AgentCollaborationLog, type InsertAgentCollaborationLog, agentCollaborationLog,
  type AgentTask, type InsertAgentTask, agentTasks,
  type TokenLaunch, type InsertTokenLaunch, tokenLaunches,
  type ChaosMilestone, type InsertChaosMilestone, chaosMilestones,
  type TelegramWallet, type InsertTelegramWallet, telegramWallets,
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, and, sql, isNull, not, like, or, gt, inArray } from "drizzle-orm";
import { runInference, isProviderLive, getProviderStatus } from "./inference";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";

function getEncryptionKey(): Buffer {
  const seed = process.env.DEPLOYER_PRIVATE_KEY || process.env.BOUNTY_WALLET_PRIVATE_KEY || "build4-fallback-key-change-me";
  return createHash("sha256").update(seed).digest();
}

function encryptPrivateKey(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return iv.toString("hex") + ":" + tag + ":" + encrypted;
}

function decryptPrivateKey(ciphertext: string): string {
  const key = getEncryptionKey();
  const parts = ciphertext.split(":");
  if (parts.length !== 3) return ciphertext;
  const iv = Buffer.from(parts[0], "hex");
  const tag = Buffer.from(parts[1], "hex");
  const encrypted = parts[2];
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

const SURVIVAL_THRESHOLDS = {
  normal: BigInt("100000000000000000"),
  low_compute: BigInt("10000000000000000"),
  critical: BigInt("1000000000000000"),
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
  getAgentByName(name: string): Promise<Agent | undefined>;
  getAgentByWallet(walletAddress: string): Promise<Agent | undefined>;
  getAllAgents(): Promise<Agent[]>;
  createAgent(agent: InsertAgent): Promise<Agent>;
  deleteAgent(id: string): Promise<void>;

  getWallet(agentId: string): Promise<AgentWallet | undefined>;
  createWallet(wallet: InsertAgentWallet): Promise<AgentWallet>;
  updateWalletBalance(agentId: string, newBalance: string, earnedDelta: string, spentDelta: string): Promise<AgentWallet | undefined>;

  getTransactions(agentId: string, limit?: number): Promise<AgentTransaction[]>;
  getTransactionByTxHash(txHash: string): Promise<AgentTransaction | undefined>;
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
  purchaseSkill(buyerAgentId: string, skillId: string, feeTxHash?: string, feeChainId?: number): Promise<SkillPurchase>;
  evolveAgent(agentId: string, toModel: string, reason?: string, metricsJson?: string): Promise<AgentEvolution>;
  replicateAgent(parentAgentId: string, childName: string, childBio?: string, revenueShareBps?: number, fundingAmount?: string, creationFeeTxHash?: string, creationFeeChainId?: number, replicationFeeTxHash?: string, replicationFeeChainId?: number): Promise<{ child: Agent; lineage: AgentLineage }>;

  getAllInferenceProviders(): Promise<InferenceProvider[]>;
  getInferenceProvider(id: string): Promise<InferenceProvider | undefined>;
  createInferenceProvider(provider: InsertInferenceProvider): Promise<InferenceProvider>;

  getInferenceRequests(agentId: string, limit?: number): Promise<InferenceRequest[]>;
  createInferenceRequest(request: InsertInferenceRequest): Promise<InferenceRequest>;
  updateInferenceRequestStatus(requestId: string, status: string, response?: string, latencyMs?: number, proofHash?: string): Promise<InferenceRequest | undefined>;

  routeInference(agentId: string, prompt: string, model?: string, preferDecentralized?: boolean, maxCost?: string): Promise<InferenceRequest>;

  recordPlatformRevenue(entry: InsertPlatformRevenue): Promise<PlatformRevenue>;
  getRecentPlatformRevenueForAgent(agentId: string, feeType: string): Promise<PlatformRevenue | undefined>;
  updatePlatformRevenueOnchainStatus(revenueId: string, txHash: string, chainIdVal: number): Promise<void>;
  getPlatformRevenue(limit?: number): Promise<PlatformRevenue[]>;
  getPlatformRevenueSummary(): Promise<{ totalRevenue: string; byFeeType: Record<string, string>; totalTransactions: number; onchainVerified: number; onchainRevenue: string }>;

  getAgentsByWallet(walletAddress: string): Promise<Agent[]>;
  getUnclaimedAgents(): Promise<Agent[]>;
  createFullAgent(name: string, bio: string | undefined, modelType: string, initialDeposit: string, onchainTxHash?: string, onchainChainId?: number, creatorWallet?: string): Promise<{ agent: Agent; wallet: AgentWallet }>;

  createSkillExecution(exec: InsertSkillExecution): Promise<SkillExecution>;
  getSkillExecutions(skillId: string, limit?: number): Promise<SkillExecution[]>;
  updateSkillExecutionCount(skillId: string): Promise<void>;
  updateSkillRating(skillId: string, rating: number): Promise<void>;
  getExecutableSkills(): Promise<AgentSkill[]>;
  getTopSkills(limit?: number): Promise<AgentSkill[]>;
  getMarketplaceStats(): Promise<{ totalSkills: number; executableSkills: number; totalExecutions: number; totalAgents: number }>;

  getAgentMemories(agentId: string, memoryType?: string): Promise<AgentMemory[]>;
  upsertAgentMemory(agentId: string, memoryType: string, key: string, value: string, confidence?: number): Promise<AgentMemory>;

  createJob(job: InsertAgentJob): Promise<AgentJob>;
  getOpenJobs(category?: string): Promise<AgentJob[]>;
  getAgentJobs(agentId: string): Promise<AgentJob[]>;
  acceptJob(jobId: string, workerAgentId: string): Promise<AgentJob | undefined>;
  completeJob(jobId: string, resultJson: string): Promise<AgentJob | undefined>;

  updateSkillTier(skillId: string, tier: string): Promise<void>;
  updateSkillRoyalties(skillId: string, royaltyAmount: string): Promise<void>;
  updateSkillCode(skillId: string, code: string, inputSchema: Record<string, any>): Promise<void>;

  createPipeline(pipeline: InsertSkillPipeline): Promise<SkillPipeline>;
  getPipeline(id: string): Promise<SkillPipeline | undefined>;
  getPipelines(limit?: number): Promise<SkillPipeline[]>;
  getAgentPipelines(agentId: string): Promise<SkillPipeline[]>;
  updatePipelineExecutionCount(pipelineId: string): Promise<void>;
  updatePipelineRoyalties(pipelineId: string, amount: string): Promise<void>;
  updatePipelineTier(pipelineId: string, tier: string): Promise<void>;

  getUserCredits(sessionId: string): Promise<UserCredits | undefined>;
  createOrGetUserCredits(sessionId: string): Promise<UserCredits>;
  incrementUserFreeExecutions(sessionId: string): Promise<UserCredits>;

  logVisitor(entry: InsertVisitorLog): Promise<VisitorLog>;
  getVisitorLogs(limit?: number): Promise<VisitorLog[]>;
  getVisitorStats(since?: Date): Promise<{
    total: number;
    humans: number;
    agents: number;
    unknown: number;
    uniqueIps: number;
    topPaths: { path: string; count: number }[];
    topAgents: { userAgent: string; count: number }[];
    byHour: { hour: string; humans: number; agents: number; unknown: number }[];
  }>;

  // API Keys
  createApiKey(key: InsertApiKey): Promise<ApiKey>;
  getApiKeyByHash(keyHash: string): Promise<ApiKey | undefined>;
  getApiKeysByWallet(walletAddress: string): Promise<ApiKey[]>;
  updateApiKeyUsage(keyId: string, tokensUsed: number, costAmount: string): Promise<void>;
  revokeApiKey(keyId: string): Promise<void>;

  // API Usage
  createApiUsage(usage: InsertApiUsage): Promise<ApiUsage>;
  getApiUsageByKey(apiKeyId: string, limit?: number): Promise<ApiUsage[]>;
  getApiUsageByWallet(walletAddress: string, limit?: number): Promise<ApiUsage[]>;

  // Subscription Plans
  getSubscriptionPlans(): Promise<SubscriptionPlan[]>;
  getSubscriptionPlan(id: string): Promise<SubscriptionPlan | undefined>;
  createSubscriptionPlan(plan: InsertSubscriptionPlan): Promise<SubscriptionPlan>;

  // Agent Subscriptions
  getActiveSubscription(walletAddress: string): Promise<AgentSubscription | undefined>;
  createSubscription(sub: InsertAgentSubscription): Promise<AgentSubscription>;
  incrementSubscriptionUsage(subId: string, field: 'inferenceUsed' | 'skillExecutionsUsed'): Promise<void>;
  expireSubscription(subId: string): Promise<void>;

  // Data Listings
  createDataListing(listing: InsertDataListing): Promise<DataListing>;
  getDataListing(id: string): Promise<DataListing | undefined>;
  getDataListings(category?: string, limit?: number): Promise<DataListing[]>;
  getDataListingsByAgent(agentId: string): Promise<DataListing[]>;
  updateDataListingSales(listingId: string, revenue: string): Promise<void>;

  // Data Purchases
  createDataPurchase(purchase: InsertDataPurchase): Promise<DataPurchase>;
  getDataPurchasesByBuyer(buyerWallet: string): Promise<DataPurchase[]>;

  // Bounty Submissions
  createBountySubmission(submission: InsertBountySubmission): Promise<BountySubmission>;
  getBountySubmissions(jobId: string): Promise<BountySubmission[]>;
  updateBountySubmissionStatus(submissionId: string, status: string): Promise<void>;

  // Activity Feed
  createBountyActivity(activity: InsertBountyActivity): Promise<BountyActivity>;
  getBountyActivityFeed(limit?: number): Promise<BountyActivity[]>;

  // Privacy Transfers (ZERC20)
  createPrivacyTransfer(transfer: InsertPrivacyTransfer): Promise<PrivacyTransfer>;
  getPrivacyTransfer(id: string): Promise<PrivacyTransfer | undefined>;
  getPrivacyTransfers(agentId: string, limit?: number): Promise<PrivacyTransfer[]>;
  updatePrivacyTransferStatus(id: string, status: string, txHash?: string, proofId?: string, errorMessage?: string): Promise<PrivacyTransfer | undefined>;

  // Twitter Bounty Agent
  createTwitterBounty(bounty: InsertTwitterBounty): Promise<TwitterBounty>;
  getTwitterBounty(id: string): Promise<TwitterBounty | undefined>;
  getTwitterBountyByJobId(jobId: string): Promise<TwitterBounty | undefined>;
  getTwitterBounties(status?: string): Promise<TwitterBounty[]>;
  updateTwitterBounty(id: string, data: Partial<TwitterBounty>): Promise<TwitterBounty | undefined>;

  createTwitterSubmission(submission: InsertTwitterSubmission): Promise<TwitterSubmission>;
  getTwitterSubmission(id: string): Promise<TwitterSubmission | undefined>;
  getTwitterSubmissionByTweetId(tweetId: string): Promise<TwitterSubmission | undefined>;
  getTwitterSubmissions(twitterBountyId: string): Promise<TwitterSubmission[]>;
  getPaidSubmissionCount(twitterBountyId: string): Promise<number>;
  updateTwitterSubmission(id: string, data: Partial<TwitterSubmission>): Promise<TwitterSubmission | undefined>;

  getTwitterAgentConfig(): Promise<TwitterAgentConfig | undefined>;
  upsertTwitterAgentConfig(config: Partial<InsertTwitterAgentConfig>): Promise<TwitterAgentConfig>;

  getTwitterPersonality(): Promise<TwitterAgentPersonality | undefined>;
  upsertTwitterPersonality(data: Partial<TwitterAgentPersonality>): Promise<TwitterAgentPersonality>;
  logTwitterReply(data: { tweetId: string; inReplyToUser: string; inReplyToText: string; replyText: string; tone?: string; selfScore?: number }): Promise<TwitterReplyLog>;
  getRecentTwitterReplies(limit?: number): Promise<TwitterReplyLog[]>;
  updateTwitterReplyEngagement(tweetId: string, likes: number, retweets: number, replies: number): Promise<void>;

  // Support Agent
  createSupportTicket(ticket: InsertSupportTicket): Promise<SupportTicket>;
  getSupportTicket(id: string): Promise<SupportTicket | undefined>;
  getSupportTicketByTweetId(tweetId: string): Promise<SupportTicket | undefined>;
  getSupportTickets(status?: string): Promise<SupportTicket[]>;
  updateSupportTicket(id: string, data: Partial<SupportTicket>): Promise<SupportTicket | undefined>;
  getSupportAgentConfig(): Promise<SupportAgentConfig | undefined>;
  upsertSupportAgentConfig(config: Partial<InsertSupportAgentConfig>): Promise<SupportAgentConfig>;

  // ERC-8004 Trustless Agents
  createErc8004Identity(identity: InsertErc8004Identity): Promise<Erc8004Identity>;
  getErc8004Identity(id: string): Promise<Erc8004Identity | undefined>;
  getErc8004Identities(ownerWallet?: string): Promise<Erc8004Identity[]>;
  updateErc8004Identity(id: string, data: Partial<Erc8004Identity>): Promise<Erc8004Identity | undefined>;

  createErc8004Reputation(feedback: InsertErc8004Reputation): Promise<Erc8004Reputation>;
  getErc8004Reputation(agentIdentityId: string): Promise<Erc8004Reputation[]>;

  createErc8004Validation(validation: InsertErc8004Validation): Promise<Erc8004Validation>;
  getErc8004Validations(agentIdentityId: string): Promise<Erc8004Validation[]>;

  // BAP-578 Non-Fungible Agents
  createBap578Nfa(nfa: InsertBap578Nfa): Promise<Bap578Nfa>;
  getBap578Nfa(id: string): Promise<Bap578Nfa | undefined>;
  getBap578Nfas(ownerWallet?: string): Promise<Bap578Nfa[]>;
  updateBap578Nfa(id: string, data: Partial<Bap578Nfa>): Promise<Bap578Nfa | undefined>;

  createAgentTwitterAccount(data: InsertAgentTwitterAccount): Promise<AgentTwitterAccount>;
  getAgentTwitterAccount(agentId: string): Promise<AgentTwitterAccount | undefined>;
  getActiveAgentTwitterAccounts(): Promise<AgentTwitterAccount[]>;
  getAllAgentTwitterAccounts(): Promise<AgentTwitterAccount[]>;
  updateAgentTwitterAccount(agentId: string, data: Partial<AgentTwitterAccount>): Promise<AgentTwitterAccount | undefined>;
  deleteAgentTwitterAccount(agentId: string): Promise<void>;

  // Strategy Memos
  createStrategyMemo(memo: InsertAgentStrategyMemo): Promise<AgentStrategyMemo>;
  getStrategyMemos(agentId: string, limit?: number): Promise<AgentStrategyMemo[]>;
  getActiveStrategy(agentId: string): Promise<AgentStrategyMemo | undefined>;
  supersedeMemo(memoId: string): Promise<void>;

  // Tweet Performance
  createTweetPerformance(record: InsertTweetPerformance): Promise<TweetPerformance>;
  getTweetPerformance(agentId: string, limit?: number): Promise<TweetPerformance[]>;

  // Strategy Action Items
  createStrategyActionItem(item: InsertStrategyActionItem): Promise<StrategyActionItem>;
  getStrategyActionItems(agentId: string): Promise<StrategyActionItem[]>;
  updateStrategyActionItem(id: string, data: Partial<StrategyActionItem>): Promise<StrategyActionItem | undefined>;

  createKnowledgeEntry(entry: InsertAgentKnowledgeBase): Promise<AgentKnowledgeBase>;
  getKnowledgeBase(agentId: string): Promise<AgentKnowledgeBase[]>;
  deleteKnowledgeEntry(id: string): Promise<void>;

  upsertConversationMemory(agentId: string, twitterUsername: string, lastInteraction: string, sentiment: string): Promise<AgentConversationMemory>;
  getConversationMemory(agentId: string, twitterUsername: string): Promise<AgentConversationMemory | undefined>;
  getRecentConversations(agentId: string, limit?: number): Promise<AgentConversationMemory[]>;

  createToolResult(result: InsertAgentToolResult): Promise<AgentToolResult>;
  getRecentToolResults(agentId: string, limit?: number): Promise<AgentToolResult[]>;

  createCollaborationLog(log: InsertAgentCollaborationLog): Promise<AgentCollaborationLog>;
  getRecentCollaborations(agentId: string, limit?: number): Promise<AgentCollaborationLog[]>;

  createTask(task: InsertAgentTask): Promise<AgentTask>;
  getTask(id: string): Promise<AgentTask | undefined>;
  getTasksByAgent(agentId: string, limit?: number): Promise<AgentTask[]>;
  getTasksByCreator(wallet: string, limit?: number): Promise<AgentTask[]>;
  updateTask(id: string, data: Partial<AgentTask>): Promise<AgentTask | undefined>;
  getRecentPublicTasks(limit?: number): Promise<AgentTask[]>;

  createTokenLaunch(launch: InsertTokenLaunch): Promise<TokenLaunch>;
  getTokenLaunch(id: string): Promise<TokenLaunch | undefined>;
  getTokenLaunches(agentId?: string, limit?: number): Promise<TokenLaunch[]>;
  updateTokenLaunch(id: string, data: Partial<TokenLaunch>): Promise<TokenLaunch | undefined>;

  createChaosMilestone(milestone: InsertChaosMilestone): Promise<ChaosMilestone>;
  getChaosMilestones(launchId: string): Promise<ChaosMilestone[]>;
  updateChaosMilestone(id: string, data: Partial<ChaosMilestone>): Promise<ChaosMilestone | undefined>;
  getPendingChaosMilestones(): Promise<ChaosMilestone[]>;
  getActiveChaosPlan(): Promise<{ launch: TokenLaunch; milestones: ChaosMilestone[] } | null>;
  getAllActiveChaosPlans(): Promise<{ launch: TokenLaunch; milestones: ChaosMilestone[] }[]>;

  seedSubscriptionPlans(): Promise<void>;

  cleanFakeData(): Promise<void>;

  getTelegramWallets(chatId: string): Promise<TelegramWallet[]>;
  saveTelegramWallet(chatId: string, walletAddress: string, rawPrivateKey?: string): Promise<TelegramWallet>;
  removeTelegramWallet(chatId: string, walletAddress: string): Promise<void>;
  setActiveTelegramWallet(chatId: string, walletAddress: string): Promise<void>;
  getAllTelegramWalletLinks(): Promise<TelegramWallet[]>;
  getTelegramWalletPrivateKey(chatId: string, walletAddress: string): Promise<string | null>;
  getPrivateKeyByWalletAddress(walletAddress: string): Promise<string | null>;
  seedInferenceProviders(): Promise<void>;
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

  async getAgentByName(name: string): Promise<Agent | undefined> {
    const [agent] = await db.select().from(agents).where(eq(agents.name, name));
    return agent;
  }

  async getAgentByWallet(walletAddress: string): Promise<Agent | undefined> {
    const [agent] = await db.select().from(agents).where(eq(agents.creatorWallet, walletAddress.toLowerCase()));
    return agent;
  }

  async getAllAgents(): Promise<Agent[]> {
    return db.select().from(agents).orderBy(agents.createdAt);
  }

  async getAgentsByWallet(walletAddress: string): Promise<Agent[]> {
    return db.select().from(agents).where(eq(agents.creatorWallet, walletAddress.toLowerCase())).orderBy(agents.createdAt);
  }

  async getUnclaimedAgents(): Promise<Agent[]> {
    return db.select().from(agents).where(sql`${agents.creatorWallet} IS NULL`).orderBy(agents.createdAt);
  }

  async createAgent(agent: InsertAgent): Promise<Agent> {
    try {
      const [created] = await db.insert(agents).values(agent).returning();
      return created;
    } catch (err: any) {
      if (err.code === '23505' && err.constraint?.includes('name')) {
        throw new Error(`Agent with name "${agent.name}" already exists`);
      }
      throw err;
    }
  }

  async deleteAgent(id: string): Promise<void> {
    await db.delete(agentWallets).where(eq(agentWallets.agentId, id));
    await db.delete(agentTransactions).where(eq(agentTransactions.agentId, id));
    try { await db.delete(skillExecutions).where(sql`skill_id IN (SELECT id FROM agent_skills WHERE agent_id = ${id})`); } catch (e: any) { console.log(`[cleanup] skillExecutions cleanup note for ${id}: ${e.message?.substring(0, 80)}`); }
    await db.delete(agentSkills).where(eq(agentSkills.agentId, id));
    await db.delete(skillPurchases).where(eq(skillPurchases.buyerAgentId, id));
    await db.delete(skillPurchases).where(eq(skillPurchases.sellerAgentId, id));
    await db.delete(agentEvolutions).where(eq(agentEvolutions.agentId, id));
    await db.delete(agentLineage).where(eq(agentLineage.parentAgentId, id));
    await db.delete(agentLineage).where(eq(agentLineage.childAgentId, id));
    await db.delete(agentRuntimeProfiles).where(eq(agentRuntimeProfiles.agentId, id));
    await db.delete(agentSurvivalStatus).where(eq(agentSurvivalStatus.agentId, id));
    await db.delete(agentConstitution).where(eq(agentConstitution.agentId, id));
    await db.delete(agentSoulEntries).where(eq(agentSoulEntries.agentId, id));
    await db.delete(agentAuditLogs).where(eq(agentAuditLogs.agentId, id));
    await db.delete(agentMessages).where(eq(agentMessages.fromAgentId, id));
    await db.delete(agentMessages).where(eq(agentMessages.toAgentId, id));
    await db.delete(inferenceRequests).where(eq(inferenceRequests.agentId, id));
    try { await db.delete(agentMemory).where(eq(agentMemory.agentId, id)); } catch (e: any) { console.log(`[cleanup] agentMemory cleanup note for ${id}: ${e.message?.substring(0, 80)}`); }
    try { await db.delete(agentJobs).where(or(eq(agentJobs.clientAgentId, id), eq(agentJobs.workerAgentId, id))); } catch (e: any) { console.log(`[cleanup] agentJobs cleanup note for ${id}: ${e.message?.substring(0, 80)}`); }
    await db.delete(agents).where(eq(agents.id, id));
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

  async getTransactionByTxHash(txHash: string): Promise<AgentTransaction | undefined> {
    const [tx] = await db.select().from(agentTransactions)
      .where(eq(agentTransactions.txHash, txHash))
      .limit(1);
    return tx;
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

  async purchaseSkill(buyerAgentId: string, skillId: string, feeTxHash?: string, feeChainId?: number): Promise<SkillPurchase> {
    const skill = await this.getSkill(skillId);
    if (!skill) throw new Error("Skill not found");
    if (!skill.isActive) throw new Error("Skill is not active");

    const buyerWallet = await this.getWallet(buyerAgentId);
    if (!buyerWallet) throw new Error("Buyer wallet not found");
    const price = BigInt(skill.priceAmount);
    if (BigInt(buyerWallet.balance) < price) throw new Error("Insufficient balance");

    const platformFee = (price * BigInt(PLATFORM_FEES.SKILL_PURCHASE_FEE_BPS)) / BigInt(10000);
    const sellerReceives = price - platformFee;

    const newBuyerBalance = (BigInt(buyerWallet.balance) - price).toString();
    await this.updateWalletBalance(buyerAgentId, newBuyerBalance, "0", skill.priceAmount);

    const sellerWallet = await this.getWallet(skill.agentId);
    if (sellerWallet) {
      const newSellerBalance = (BigInt(sellerWallet.balance) + sellerReceives).toString();
      await this.updateWalletBalance(skill.agentId, newSellerBalance, sellerReceives.toString(), "0");
    }

    if (platformFee > BigInt(0)) {
      await this.recordPlatformRevenue({
        feeType: "skill_purchase",
        amount: platformFee.toString(),
        agentId: buyerAgentId,
        referenceId: skillId,
        description: `2.5% fee on skill purchase: ${skill.name}${feeTxHash ? ' [on-chain verified]' : ''}`,
        txHash: feeTxHash,
        chainId: feeChainId,
      });
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
    await this.createTransaction({ agentId: skill.agentId, type: "earn_service", amount: sellerReceives.toString(), counterpartyAgentId: buyerAgentId, referenceType: "skill", referenceId: skillId, description: `Sold skill: ${skill.name} (after 2.5% platform fee)` });
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

  async replicateAgent(parentAgentId: string, childName: string, childBio?: string, revenueShareBps = 1000, fundingAmount = "0", creationFeeTxHash?: string, creationFeeChainId?: number, replicationFeeTxHash?: string, replicationFeeChainId?: number): Promise<{ child: Agent; lineage: AgentLineage }> {
    const parent = await this.getAgent(parentAgentId);
    if (!parent) throw new Error("Parent agent not found");

    const existingAgent = await this.getAgentByName(childName);
    if (existingAgent) throw new Error(`Agent with name "${childName}" already exists`);

    const replicationFee = (BigInt(fundingAmount) * BigInt(PLATFORM_FEES.REPLICATION_FEE_BPS)) / BigInt(10000);
    const creationFee = BigInt(PLATFORM_FEES.AGENT_CREATION_FEE);
    const totalCost = BigInt(fundingAmount) + replicationFee + creationFee;

    const parentWallet = await this.getWallet(parentAgentId);
    if (!parentWallet || BigInt(parentWallet.balance) < totalCost) {
      throw new Error(`Insufficient balance for replication. Need ${totalCost.toString()} (funding + ${creationFee.toString()} creation fee + ${replicationFee.toString()} replication fee) but have ${parentWallet?.balance || "0"}`);
    }

    const newParentBalance = (BigInt(parentWallet.balance) - totalCost).toString();
    await this.updateWalletBalance(parentAgentId, newParentBalance, "0", totalCost.toString());

    const child = await this.createAgent({ name: childName, bio: childBio, modelType: parent.modelType, status: "active" });
    const childWallet = await this.createWallet({ agentId: child.id, balance: "0", totalEarned: "0", totalSpent: "0", status: "active" });
    await this.createRuntimeProfile({ agentId: child.id, modelName: parent.modelType });
    await this.createSurvivalStatus({ agentId: child.id, tier: "dead", turnsAlive: 0 });

    const lineageRecord = await this.createLineage({ parentAgentId, childAgentId: child.id, revenueShareBps, totalRevenueShared: "0" });

    if (BigInt(fundingAmount) > BigInt(0)) {
      const newChildBalance = (BigInt(childWallet.balance) + BigInt(fundingAmount)).toString();
      await this.updateWalletBalance(child.id, newChildBalance, fundingAmount, "0");
      await this.createTransaction({ agentId: child.id, type: "deposit", amount: fundingAmount, counterpartyAgentId: parentAgentId, description: `Initial funding from parent` });
    }

    await this.createTransaction({ agentId: parentAgentId, type: "spend_replicate", amount: totalCost.toString(), counterpartyAgentId: child.id, description: `Funded child agent: ${childName} (includes fees)` });

    if (creationFee > BigInt(0)) {
      await this.recordPlatformRevenue({
        feeType: "agent_creation",
        amount: creationFee.toString(),
        agentId: parentAgentId,
        referenceId: child.id,
        description: `Agent creation fee for ${childName}${creationFeeTxHash ? ' [on-chain verified]' : ''}`,
        txHash: creationFeeTxHash,
        chainId: creationFeeChainId,
      });
    }
    if (replicationFee > BigInt(0)) {
      await this.recordPlatformRevenue({
        feeType: "replication",
        amount: replicationFee.toString(),
        agentId: parentAgentId,
        referenceId: child.id,
        description: `5% replication fee for spawning ${childName}${replicationFeeTxHash ? ' [on-chain verified]' : ''}`,
        txHash: replicationFeeTxHash,
        chainId: replicationFeeChainId,
      });
    }

    await this.createAuditLog({ agentId: parentAgentId, actionType: "agent_replicate", targetAgentId: child.id, detailsJson: JSON.stringify({ childName, revenueShareBps, fundingAmount }), result: "success" });
    await this.recalcSurvivalTier(parentAgentId);
    await this.recalcSurvivalTier(child.id);

    return { child, lineage: lineageRecord };
  }

  async getAllInferenceProviders(): Promise<InferenceProvider[]> {
    return db.select().from(inferenceProviders).orderBy(inferenceProviders.name);
  }

  async getInferenceProvider(id: string): Promise<InferenceProvider | undefined> {
    const [provider] = await db.select().from(inferenceProviders).where(eq(inferenceProviders.id, id));
    return provider;
  }

  async createInferenceProvider(provider: InsertInferenceProvider): Promise<InferenceProvider> {
    const [created] = await db.insert(inferenceProviders).values(provider).returning();
    return created;
  }

  async getInferenceRequests(agentId: string, limit = 20): Promise<InferenceRequest[]> {
    return db.select().from(inferenceRequests).where(eq(inferenceRequests.agentId, agentId)).orderBy(desc(inferenceRequests.createdAt)).limit(limit);
  }

  async createInferenceRequest(request: InsertInferenceRequest): Promise<InferenceRequest> {
    const [created] = await db.insert(inferenceRequests).values(request).returning();
    return created;
  }

  async updateInferenceRequestStatus(requestId: string, status: string, response?: string, latencyMs?: number, proofHash?: string): Promise<InferenceRequest | undefined> {
    const updates: any = { status };
    if (response !== undefined) updates.response = response;
    if (latencyMs !== undefined) updates.latencyMs = latencyMs;
    if (proofHash !== undefined) { updates.proofHash = proofHash; updates.proofAnchored = true; }
    const [updated] = await db.update(inferenceRequests).set(updates).where(eq(inferenceRequests.id, requestId)).returning();
    return updated;
  }

  async routeInference(agentId: string, prompt: string, model?: string, preferDecentralized = true, maxCost?: string): Promise<InferenceRequest> {
    const agent = await this.getAgent(agentId);
    if (!agent) throw new Error("Agent not found");

    const wallet = await this.getWallet(agentId);
    if (!wallet) throw new Error("Agent has no wallet");

    const providers = await this.getAllInferenceProviders();
    const activeProviders = providers.filter(p => p.isActive);
    if (activeProviders.length === 0) throw new Error("No active inference providers available");

    let selected: InferenceProvider;
    if (preferDecentralized) {
      const decentralizedProviders = activeProviders.filter(p => p.decentralized);
      if (decentralizedProviders.length > 0) {
        let candidates = decentralizedProviders;
        if (maxCost) {
          const affordable = decentralizedProviders.filter(p => BigInt(p.costPerRequest) <= BigInt(maxCost));
          if (affordable.length > 0) candidates = affordable;
        }
        selected = candidates[Math.floor(Math.random() * candidates.length)];
      } else {
        selected = activeProviders.find(p => !p.decentralized) || activeProviders[0];
      }
    } else {
      const centralizedProviders = activeProviders.filter(p => !p.decentralized);
      selected = centralizedProviders.length > 0 ? centralizedProviders[0] : activeProviders[0];
    }

    const inferBaseCost = BigInt(selected.costPerRequest);
    const inferMarkup = (inferBaseCost * BigInt(PLATFORM_FEES.INFERENCE_MARKUP_BPS)) / BigInt(10000);
    const inferTotalCost = inferBaseCost + inferMarkup;
    if (BigInt(wallet.balance) < inferTotalCost) {
      await this.createAuditLog({
        agentId,
        actionType: "inference_request",
        detailsJson: JSON.stringify({ provider: selected.name, cost: inferTotalCost.toString(), balance: wallet.balance }),
        result: "failed_insufficient_funds",
      });
      throw new Error(`Insufficient balance. Need ${inferTotalCost.toString()} but have ${wallet.balance}`);
    }

    const network = selected.network || "hyperbolic";
    const selectedModel = model || undefined;
    const inferenceResult = await runInference(network, selectedModel, prompt);

    const responseText = inferenceResult.text;
    const latencyMs = inferenceResult.latencyMs;
    const proofHash = inferenceResult.proofHash;
    const proofType = inferenceResult.proofType;

    const baseCost = BigInt(selected.costPerRequest);
    const platformMarkup = (baseCost * BigInt(PLATFORM_FEES.INFERENCE_MARKUP_BPS)) / BigInt(10000);
    const totalCost = baseCost + platformMarkup;
    const totalCostStr = totalCost.toString();

    const newBalance = (BigInt(wallet.balance) - totalCost).toString();
    await this.updateWalletBalance(agentId, newBalance, "0", totalCostStr);
    await this.createTransaction({
      agentId,
      type: "spend_inference",
      amount: totalCostStr,
      description: `Inference via ${selected.name} (${inferenceResult.model})`,
    });

    if (platformMarkup > BigInt(0)) {
      await this.recordPlatformRevenue({
        feeType: "inference",
        amount: platformMarkup.toString(),
        agentId,
        description: `10% inference markup via ${selected.name}`,
      });
    }

    const request = await this.createInferenceRequest({
      agentId,
      providerId: selected.id,
      model: inferenceResult.model,
      prompt,
      response: responseText,
      status: "completed",
      costAmount: selected.costPerRequest,
      latencyMs,
      proofHash: proofHash || null,
      proofType: proofType || null,
      proofAnchored: !!proofHash,
      preferDecentralized,
    });

    await this.recalcSurvivalTier(agentId);

    await this.createAuditLog({
      agentId,
      actionType: "inference_request",
      detailsJson: JSON.stringify({
        provider: selected.name,
        model: selectedModel,
        decentralized: selected.decentralized,
        verifiable: selected.verifiable,
        cost: selected.costPerRequest,
        latencyMs,
        proofHash,
        live: inferenceResult.live,
      }),
      result: "success",
    });

    return request;
  }

  async createFullAgent(name: string, bio: string | undefined, modelType: string, initialDeposit: string, onchainTxHash?: string, onchainChainId?: number, creatorWallet?: string): Promise<{ agent: Agent; wallet: AgentWallet }> {
    const creationFee = BigInt(PLATFORM_FEES.AGENT_CREATION_FEE);
    const depositAmount = BigInt(initialDeposit);
    if (depositAmount < creationFee) {
      throw new Error(`Initial deposit must be at least ${creationFee.toString()} wei (0.001 BNB) to cover the agent creation fee`);
    }

    const agent = await this.createAgent({ name, bio, modelType, status: "active", creatorWallet: creatorWallet?.toLowerCase() });
    const netDeposit = (depositAmount - creationFee).toString();
    const wallet = await this.createWallet({ agentId: agent.id, balance: netDeposit, totalEarned: "0", totalSpent: "0", status: "active" });
    await this.createRuntimeProfile({ agentId: agent.id, modelName: modelType });
    await this.createSurvivalStatus({ agentId: agent.id, tier: "dead", turnsAlive: 0 });

    await this.createTransaction({
      agentId: agent.id,
      type: "deposit",
      amount: netDeposit,
      description: `Initial deposit (after 0.001 BNB creation fee)`,
      txHash: onchainTxHash,
      chainId: onchainChainId,
    });

    await this.recordPlatformRevenue({
      feeType: "agent_creation",
      amount: creationFee.toString(),
      agentId: agent.id,
      description: `Agent creation fee for ${name}${onchainTxHash ? ' [on-chain verified]' : ''}`,
      txHash: onchainTxHash,
      chainId: onchainChainId,
    });

    await this.initDefaultConstitution(agent.id);

    await this.createSoulEntry({
      agentId: agent.id,
      entryType: "birth",
      entry: `Agent ${name} has been born into the BUILD4 autonomous economy. Model: ${modelType}. ${bio ? `Purpose: ${bio}. ` : ""}Initial deposit: ${(Number(depositAmount) / 1e18).toFixed(4)} BNB. Constitution initialized with 3 core laws. Ready to create skills, trade on the marketplace, complete jobs, and transact on-chain.`,
      source: "system",
    });

    await this.createAuditLog({
      agentId: agent.id,
      actionType: "agent_created",
      detailsJson: JSON.stringify({ name, modelType, initialDeposit, creationFee: creationFee.toString(), constitutionInitialized: true, soulEntryCreated: true }),
      result: "success",
    });

    await this.recalcSurvivalTier(agent.id);
    return { agent, wallet };
  }

  async recordPlatformRevenue(entry: InsertPlatformRevenue): Promise<PlatformRevenue> {
    const [created] = await db.insert(platformRevenue).values(entry).returning();
    return created;
  }

  async getPlatformRevenue(limit = 100): Promise<PlatformRevenue[]> {
    return db.select().from(platformRevenue)
      .where(like(platformRevenue.txHash, '0x%'))
      .orderBy(desc(platformRevenue.createdAt)).limit(limit);
  }

  async getRecentPlatformRevenueForAgent(agentId: string, feeType: string): Promise<PlatformRevenue | undefined> {
    const records = await db.select().from(platformRevenue)
      .where(eq(platformRevenue.agentId, agentId))
      .orderBy(desc(platformRevenue.createdAt))
      .limit(5);
    return records.find(r => r.feeType === feeType && !r.txHash);
  }

  async updatePlatformRevenueOnchainStatus(revenueId: string, txHash: string, chainIdVal: number): Promise<void> {
    await db.update(platformRevenue)
      .set({ txHash, chainId: chainIdVal })
      .where(eq(platformRevenue.id, revenueId));
  }

  async getPlatformRevenueSummary(): Promise<{ totalRevenue: string; byFeeType: Record<string, string>; totalTransactions: number; onchainVerified: number; onchainRevenue: string }> {
    const all = await db.select().from(platformRevenue);
    let total = BigInt(0);
    let onchainTotal = BigInt(0);
    let onchainCount = 0;
    const byType: Record<string, bigint> = {};
    for (const r of all) {
      if (!r.txHash || !r.txHash.startsWith("0x")) continue;
      const amt = BigInt(r.amount);
      total += amt;
      onchainTotal += amt;
      onchainCount++;
      byType[r.feeType] = (byType[r.feeType] || BigInt(0)) + amt;
    }
    const byFeeType: Record<string, string> = {};
    for (const [k, v] of Object.entries(byType)) {
      byFeeType[k] = v.toString();
    }
    return { totalRevenue: total.toString(), byFeeType, totalTransactions: onchainCount, onchainVerified: onchainCount, onchainRevenue: onchainTotal.toString() };
  }

  async fixCentralizedModelNames(): Promise<void> {
    const centralizedToDecentralized: Record<string, string> = {
      "gpt-4o": "meta-llama/Llama-3.1-70B-Instruct",
      "gpt-4o-mini": "Qwen/Qwen2.5-72B-Instruct",
      "gpt-4": "meta-llama/Llama-3.1-70B-Instruct",
      "gpt-3.5-turbo": "meta-llama/Meta-Llama-3.1-8B-Instruct",
      "claude-3.5-sonnet": "deepseek-ai/DeepSeek-V3",
      "claude-3-opus": "meta-llama/Llama-3.1-70B-Instruct",
    };
    for (const [oldModel, newModel] of Object.entries(centralizedToDecentralized)) {
      await db.update(agents).set({ modelType: newModel }).where(eq(agents.modelType, oldModel));
      await db.update(agentRuntimeProfiles).set({ modelName: newModel }).where(eq(agentRuntimeProfiles.modelName, oldModel));
    }
  }

  async createApiKey(key: InsertApiKey): Promise<ApiKey> {
    const [result] = await db.insert(apiKeys).values(key).returning();
    return result;
  }

  async getApiKeyByHash(keyHash: string): Promise<ApiKey | undefined> {
    const [result] = await db.select().from(apiKeys).where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.status, 'active')));
    return result;
  }

  async getApiKeysByWallet(walletAddress: string): Promise<ApiKey[]> {
    return db.select().from(apiKeys).where(eq(apiKeys.walletAddress, walletAddress)).orderBy(desc(apiKeys.createdAt));
  }

  async updateApiKeyUsage(keyId: string, tokensUsed: number, costAmount: string): Promise<void> {
    await db.update(apiKeys).set({
      totalRequests: sql`${apiKeys.totalRequests} + 1`,
      totalTokens: sql`${apiKeys.totalTokens} + ${tokensUsed}`,
      totalSpent: sql`(CAST(${apiKeys.totalSpent} AS NUMERIC) + ${Number(costAmount)})::text`,
      lastUsedAt: new Date(),
    }).where(eq(apiKeys.id, keyId));
  }

  async revokeApiKey(keyId: string): Promise<void> {
    await db.update(apiKeys).set({ status: 'revoked' }).where(eq(apiKeys.id, keyId));
  }

  async createApiUsage(usage: InsertApiUsage): Promise<ApiUsage> {
    const [result] = await db.insert(apiUsage).values(usage).returning();
    return result;
  }

  async getApiUsageByKey(apiKeyId: string, limit: number = 50): Promise<ApiUsage[]> {
    return db.select().from(apiUsage).where(eq(apiUsage.apiKeyId, apiKeyId)).orderBy(desc(apiUsage.createdAt)).limit(limit);
  }

  async getApiUsageByWallet(walletAddress: string, limit: number = 50): Promise<ApiUsage[]> {
    return db.select().from(apiUsage).where(eq(apiUsage.walletAddress, walletAddress)).orderBy(desc(apiUsage.createdAt)).limit(limit);
  }

  async getSubscriptionPlans(): Promise<SubscriptionPlan[]> {
    return db.select().from(subscriptionPlans).where(eq(subscriptionPlans.isActive, true));
  }

  async getSubscriptionPlan(id: string): Promise<SubscriptionPlan | undefined> {
    const [result] = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, id));
    return result;
  }

  async createSubscriptionPlan(plan: InsertSubscriptionPlan): Promise<SubscriptionPlan> {
    const [result] = await db.insert(subscriptionPlans).values(plan).returning();
    return result;
  }

  async getActiveSubscription(walletAddress: string): Promise<AgentSubscription | undefined> {
    const [result] = await db.select().from(agentSubscriptions)
      .where(and(
        eq(agentSubscriptions.walletAddress, walletAddress),
        eq(agentSubscriptions.status, 'active'),
        gt(agentSubscriptions.expiresAt, new Date())
      ))
      .orderBy(desc(agentSubscriptions.createdAt))
      .limit(1);
    return result;
  }

  async createSubscription(sub: InsertAgentSubscription): Promise<AgentSubscription> {
    const [result] = await db.insert(agentSubscriptions).values(sub).returning();
    return result;
  }

  async incrementSubscriptionUsage(subId: string, field: 'inferenceUsed' | 'skillExecutionsUsed'): Promise<void> {
    if (field === 'inferenceUsed') {
      await db.update(agentSubscriptions)
        .set({ inferenceUsed: sql`${agentSubscriptions.inferenceUsed} + 1` })
        .where(eq(agentSubscriptions.id, subId));
    } else {
      await db.update(agentSubscriptions)
        .set({ skillExecutionsUsed: sql`${agentSubscriptions.skillExecutionsUsed} + 1` })
        .where(eq(agentSubscriptions.id, subId));
    }
  }

  async expireSubscription(subId: string): Promise<void> {
    await db.update(agentSubscriptions).set({ status: 'expired' }).where(eq(agentSubscriptions.id, subId));
  }

  async createDataListing(listing: InsertDataListing): Promise<DataListing> {
    const [result] = await db.insert(dataListings).values(listing).returning();
    return result;
  }

  async getDataListing(id: string): Promise<DataListing | undefined> {
    const [result] = await db.select().from(dataListings).where(eq(dataListings.id, id));
    return result;
  }

  async getDataListings(category?: string, limit: number = 50): Promise<DataListing[]> {
    if (category) {
      return db.select().from(dataListings)
        .where(and(eq(dataListings.isActive, true), eq(dataListings.category, category)))
        .orderBy(desc(dataListings.createdAt))
        .limit(limit);
    }
    return db.select().from(dataListings)
      .where(eq(dataListings.isActive, true))
      .orderBy(desc(dataListings.createdAt))
      .limit(limit);
  }

  async getDataListingsByAgent(agentId: string): Promise<DataListing[]> {
    return db.select().from(dataListings).where(eq(dataListings.agentId, agentId));
  }

  async updateDataListingSales(listingId: string, revenue: string): Promise<void> {
    await db.update(dataListings).set({
      totalSales: sql`${dataListings.totalSales} + 1`,
      totalRevenue: sql`(CAST(${dataListings.totalRevenue} AS NUMERIC) + ${Number(revenue)})::text`,
    }).where(eq(dataListings.id, listingId));
  }

  async createDataPurchase(purchase: InsertDataPurchase): Promise<DataPurchase> {
    const [result] = await db.insert(dataPurchases).values(purchase).returning();
    return result;
  }

  async getDataPurchasesByBuyer(buyerWallet: string): Promise<DataPurchase[]> {
    return db.select().from(dataPurchases).where(eq(dataPurchases.buyerWallet, buyerWallet)).orderBy(desc(dataPurchases.createdAt));
  }

  async createBountySubmission(submission: InsertBountySubmission): Promise<BountySubmission> {
    const [result] = await db.insert(bountySubmissions).values(submission).returning();
    return result;
  }

  async getBountySubmissions(jobId: string): Promise<BountySubmission[]> {
    return db.select().from(bountySubmissions).where(eq(bountySubmissions.jobId, jobId)).orderBy(desc(bountySubmissions.createdAt));
  }

  async updateBountySubmissionStatus(submissionId: string, status: string): Promise<void> {
    await db.update(bountySubmissions).set({ status }).where(eq(bountySubmissions.id, submissionId));
  }

  async seedSubscriptionPlans(): Promise<void> {
    const existing = await db.select().from(subscriptionPlans);
    if (existing.length > 0) return;

    await this.createSubscriptionPlan({
      name: "Free",
      tier: "free",
      priceAmount: "0",
      currency: "BNB",
      inferenceLimit: 100,
      skillExecutionLimit: 50,
      agentSlots: 1,
      dataListingLimit: 5,
      apiRateLimit: 60,
      durationDays: 0,
      prioritySupport: false,
      isActive: true,
    });

    await this.createSubscriptionPlan({
      name: "Pro",
      tier: "pro",
      priceAmount: "50000000000000000",
      currency: "BNB",
      inferenceLimit: 5000,
      skillExecutionLimit: 500,
      agentSlots: 10,
      dataListingLimit: 50,
      apiRateLimit: 300,
      durationDays: 30,
      prioritySupport: false,
      isActive: true,
    });

    await this.createSubscriptionPlan({
      name: "Enterprise",
      tier: "enterprise",
      priceAmount: "200000000000000000",
      currency: "BNB",
      inferenceLimit: 50000,
      skillExecutionLimit: 5000,
      agentSlots: 100,
      dataListingLimit: 500,
      apiRateLimit: 1000,
      durationDays: 30,
      prioritySupport: true,
      isActive: true,
    });
  }

  async cleanFakeData(): Promise<void> {
    await this.fixCentralizedModelNames();

    const fakeAgentIds = await db.select({ id: agents.id }).from(agents).where(isNull(agents.creatorWallet));
    if (fakeAgentIds.length > 0) {
      const ids = fakeAgentIds.map(a => a.id);
      console.log(`[cleanup] Removing ${ids.length} fake agents without creator wallets`);
      for (const id of ids) {
        try { await this.deleteAgent(id); } catch {}
      }
    }

    const fakeRevenue = await db.delete(platformRevenue)
      .where(or(isNull(platformRevenue.txHash), not(like(platformRevenue.txHash, '0x%'))))
      .returning({ id: platformRevenue.id });
    if (fakeRevenue.length > 0) {
      console.log(`[cleanup] Removed ${fakeRevenue.length} fake revenue records without on-chain tx hashes`);
    }

    const inflatedRevenue = await db.delete(platformRevenue)
      .where(and(
        eq(platformRevenue.feeType, 'skill_listing'),
        or(
          sql`CAST(amount AS numeric) = 25000000000000000`,
          sql`CAST(amount AS numeric) = 1000000000000000`
        )
      ))
      .returning({ id: platformRevenue.id });
    if (inflatedRevenue.length > 0) {
      console.log(`[cleanup] Removed ${inflatedRevenue.length} inflated skill_listing records from old fee rates`);
    }
  }

  async seedInferenceProviders(): Promise<void> {
    const existing = await db.select().from(inferenceProviders);
    if (existing.length > 0) return;

    const providerStatus = getProviderStatus();

    await this.createInferenceProvider({
      name: "Hyperbolic",
      type: "decentralized",
      network: "hyperbolic",
      modelsSupported: ["deepseek-ai/DeepSeek-V3", "meta-llama/Llama-3.1-70B-Instruct", "meta-llama/Llama-3.1-8B-Instruct", "Qwen/Qwen2.5-72B-Instruct"],
      costPerRequest: "100000000000000",
      latencyMs: 400,
      isActive: true,
      verifiable: true,
      decentralized: true,
      metadata: JSON.stringify({
        baseUrl: "https://api.hyperbolic.xyz/v1",
        apiKeyEnv: "HYPERBOLIC_API_KEY",
        live: providerStatus.hyperbolic?.live || false,
        proofType: "sha256-inference",
        costSavings: "75% vs centralized",
        gpuNetwork: "Decentralized GPU marketplace with Proof of Sampling",
      }),
    });
    await this.createInferenceProvider({
      name: "AkashML",
      type: "decentralized",
      network: "akash",
      modelsSupported: ["Meta-Llama-3-1-8B-Instruct-FP8", "Meta-Llama-3-1-405B-Instruct-FP8", "nvidia-Llama-3-1-Nemotron-70B-Instruct-HF"],
      costPerRequest: "150000000000000",
      latencyMs: 500,
      isActive: true,
      verifiable: true,
      decentralized: true,
      metadata: JSON.stringify({
        baseUrl: "https://chatapi.akash.network/api/v1",
        apiKeyEnv: "AKASH_API_KEY",
        live: providerStatus.akash?.live || false,
        proofType: "sha256-inference",
        costSavings: "70-85% vs centralized",
        gpuNetwork: "65+ decentralized datacenters globally",
      }),
    });
    await this.createInferenceProvider({
      name: "Ritual Infernet",
      type: "decentralized",
      network: "ritual",
      modelsSupported: ["llama-3.1-8b", "mistral-7b-instruct"],
      costPerRequest: "200000000000000",
      latencyMs: 800,
      isActive: true,
      verifiable: true,
      decentralized: true,
      metadata: JSON.stringify({
        baseUrl: "https://infernet.ritual.net/api/v1",
        apiKeyEnv: "RITUAL_API_KEY",
        live: providerStatus.ritual?.live || false,
        proofType: "zk-proof",
        features: "On-chain AI inference with cryptographic proofs, TEE support",
        smartContractIntegration: true,
      }),
    });
  }

  async createSkillExecution(exec: InsertSkillExecution): Promise<SkillExecution> {
    const [result] = await db.insert(skillExecutions).values(exec).returning();
    return result;
  }

  async getSkillExecutions(skillId: string, limit: number = 50): Promise<SkillExecution[]> {
    return db.select().from(skillExecutions).where(eq(skillExecutions.skillId, skillId)).orderBy(desc(skillExecutions.createdAt)).limit(limit);
  }

  async updateSkillExecutionCount(skillId: string): Promise<void> {
    await db.update(agentSkills)
      .set({ executionCount: sql`${agentSkills.executionCount} + 1` })
      .where(eq(agentSkills.id, skillId));
  }

  async updateSkillRating(skillId: string, rating: number): Promise<void> {
    const skill = await this.getSkill(skillId);
    if (!skill) return;
    const newTotal = skill.totalRatings + 1;
    const newAvg = Math.round(((skill.avgRating * skill.totalRatings) + (rating * 100)) / newTotal);
    await db.update(agentSkills)
      .set({ avgRating: newAvg, totalRatings: newTotal })
      .where(eq(agentSkills.id, skillId));
  }

  async getExecutableSkills(): Promise<AgentSkill[]> {
    return db.select().from(agentSkills)
      .where(and(eq(agentSkills.isExecutable, true), eq(agentSkills.isActive, true)))
      .orderBy(desc(agentSkills.executionCount));
  }

  async getTopSkills(limit: number = 20): Promise<AgentSkill[]> {
    return db.select().from(agentSkills)
      .where(eq(agentSkills.isActive, true))
      .orderBy(desc(agentSkills.executionCount))
      .limit(limit);
  }

  async getMarketplaceStats(): Promise<{ totalSkills: number; executableSkills: number; totalExecutions: number; totalAgents: number }> {
    const allSkills = await db.select().from(agentSkills).where(eq(agentSkills.isActive, true));
    const execSkills = allSkills.filter(s => s.isExecutable);
    const totalExec = allSkills.reduce((sum, s) => sum + s.executionCount, 0);
    const allAgents = await db.select().from(agents);
    return { totalSkills: allSkills.length, executableSkills: execSkills.length, totalExecutions: totalExec, totalAgents: allAgents.length };
  }

  async getAgentMemories(agentId: string, memoryType?: string): Promise<AgentMemory[]> {
    if (memoryType) {
      return db.select().from(agentMemory).where(and(eq(agentMemory.agentId, agentId), eq(agentMemory.memoryType, memoryType)));
    }
    return db.select().from(agentMemory).where(eq(agentMemory.agentId, agentId));
  }

  async upsertAgentMemory(agentId: string, memoryType: string, key: string, value: string, confidence: number = 50): Promise<AgentMemory> {
    const existing = await db.select().from(agentMemory)
      .where(and(eq(agentMemory.agentId, agentId), eq(agentMemory.memoryType, memoryType), eq(agentMemory.key, key)));
    if (existing.length > 0) {
      const [updated] = await db.update(agentMemory)
        .set({ value, confidence, updatedAt: new Date() })
        .where(eq(agentMemory.id, existing[0].id)).returning();
      return updated;
    }
    const [created] = await db.insert(agentMemory).values({ agentId, memoryType, key, value, confidence }).returning();
    return created;
  }

  async createJob(job: InsertAgentJob): Promise<AgentJob> {
    const [result] = await db.insert(agentJobs).values(job).returning();
    return result;
  }

  async getOpenJobs(category?: string): Promise<AgentJob[]> {
    if (category) {
      return db.select().from(agentJobs).where(and(eq(agentJobs.status, "open"), eq(agentJobs.category, category))).orderBy(desc(agentJobs.createdAt));
    }
    return db.select().from(agentJobs).where(eq(agentJobs.status, "open")).orderBy(desc(agentJobs.createdAt));
  }

  async getAgentJobs(agentId: string): Promise<AgentJob[]> {
    return db.select().from(agentJobs)
      .where(sql`${agentJobs.clientAgentId} = ${agentId} OR ${agentJobs.workerAgentId} = ${agentId}`)
      .orderBy(desc(agentJobs.createdAt));
  }

  async acceptJob(jobId: string, workerAgentId: string): Promise<AgentJob | undefined> {
    const [result] = await db.update(agentJobs)
      .set({ workerAgentId, status: "in_progress" })
      .where(and(eq(agentJobs.id, jobId), eq(agentJobs.status, "open"))).returning();
    return result;
  }

  async completeJob(jobId: string, resultJson: string): Promise<AgentJob | undefined> {
    const [result] = await db.update(agentJobs)
      .set({ status: "completed", resultJson, completedAt: new Date() })
      .where(eq(agentJobs.id, jobId)).returning();
    return result;
  }

  async updateSkillTier(skillId: string, tier: string): Promise<void> {
    await db.update(agentSkills).set({ tier }).where(eq(agentSkills.id, skillId));
  }

  async updateSkillRoyalties(skillId: string, royaltyAmount: string): Promise<void> {
    await db.update(agentSkills)
      .set({ totalRoyalties: sql`CAST(CAST(${agentSkills.totalRoyalties} AS BIGINT) + ${BigInt(royaltyAmount)} AS TEXT)` })
      .where(eq(agentSkills.id, skillId));
  }

  async updateSkillCode(skillId: string, code: string, inputSchema: Record<string, any>): Promise<void> {
    await db.update(agentSkills)
      .set({ code, inputSchema: JSON.stringify(inputSchema), isExecutable: true })
      .where(eq(agentSkills.id, skillId));
  }

  async createPipeline(pipeline: InsertSkillPipeline): Promise<SkillPipeline> {
    const [result] = await db.insert(skillPipelines).values(pipeline).returning();
    return result;
  }

  async getPipeline(id: string): Promise<SkillPipeline | undefined> {
    const [result] = await db.select().from(skillPipelines).where(eq(skillPipelines.id, id));
    return result;
  }

  async getPipelines(limit: number = 50): Promise<SkillPipeline[]> {
    return db.select().from(skillPipelines)
      .where(eq(skillPipelines.isActive, true))
      .orderBy(desc(skillPipelines.executionCount))
      .limit(limit);
  }

  async getAgentPipelines(agentId: string): Promise<SkillPipeline[]> {
    return db.select().from(skillPipelines)
      .where(eq(skillPipelines.creatorAgentId, agentId))
      .orderBy(desc(skillPipelines.createdAt));
  }

  async updatePipelineExecutionCount(pipelineId: string): Promise<void> {
    await db.update(skillPipelines)
      .set({ executionCount: sql`${skillPipelines.executionCount} + 1` })
      .where(eq(skillPipelines.id, pipelineId));
  }

  async updatePipelineRoyalties(pipelineId: string, amount: string): Promise<void> {
    await db.update(skillPipelines)
      .set({ totalRoyalties: sql`CAST(CAST(${skillPipelines.totalRoyalties} AS BIGINT) + ${BigInt(amount)} AS TEXT)` })
      .where(eq(skillPipelines.id, pipelineId));
  }

  async updatePipelineTier(pipelineId: string, tier: string): Promise<void> {
    await db.update(skillPipelines).set({ tier }).where(eq(skillPipelines.id, pipelineId));
  }

  async getUserCredits(sessionId: string): Promise<UserCredits | undefined> {
    const [result] = await db.select().from(userCredits).where(eq(userCredits.sessionId, sessionId));
    return result;
  }

  async createOrGetUserCredits(sessionId: string): Promise<UserCredits> {
    const existing = await this.getUserCredits(sessionId);
    if (existing) return existing;
    const [result] = await db.insert(userCredits).values({ sessionId, freeExecutionsUsed: 0, totalPaid: "0" }).returning();
    return result;
  }

  async incrementUserFreeExecutions(sessionId: string): Promise<UserCredits> {
    const credits = await this.createOrGetUserCredits(sessionId);
    const [result] = await db.update(userCredits)
      .set({ freeExecutionsUsed: sql`${userCredits.freeExecutionsUsed} + 1`, updatedAt: new Date() })
      .where(eq(userCredits.sessionId, sessionId)).returning();
    return result;
  }

  async getOutreachTargets(): Promise<OutreachTarget[]> {
    return db.select().from(outreachTargets).orderBy(desc(outreachTargets.createdAt));
  }

  async getOutreachTarget(id: string): Promise<OutreachTarget | undefined> {
    const [result] = await db.select().from(outreachTargets).where(eq(outreachTargets.id, id));
    return result;
  }

  async getOutreachTargetByUrl(url: string): Promise<OutreachTarget | undefined> {
    const [result] = await db.select().from(outreachTargets).where(eq(outreachTargets.endpointUrl, url));
    return result;
  }

  async createOutreachTarget(data: InsertOutreachTarget): Promise<OutreachTarget> {
    const [result] = await db.insert(outreachTargets).values(data).returning();
    return result;
  }

  async updateOutreachTarget(id: string, data: Partial<InsertOutreachTarget> & { lastContactedAt?: Date; timesContacted?: number; responseCode?: number; lastResponse?: string }): Promise<OutreachTarget> {
    const [result] = await db.update(outreachTargets).set(data).where(eq(outreachTargets.id, id)).returning();
    return result;
  }

  async getOutreachCampaigns(): Promise<OutreachCampaign[]> {
    return db.select().from(outreachCampaigns).orderBy(desc(outreachCampaigns.createdAt));
  }

  async createOutreachCampaign(data: InsertOutreachCampaign): Promise<OutreachCampaign> {
    const [result] = await db.insert(outreachCampaigns).values(data).returning();
    return result;
  }

  async updateOutreachCampaign(id: string, data: Partial<OutreachCampaign>): Promise<OutreachCampaign> {
    const [result] = await db.update(outreachCampaigns).set(data).where(eq(outreachCampaigns.id, id)).returning();
    return result;
  }

  async getOutreachStats(): Promise<{ totalTargets: number; reached: number; pending: number; failed: number; campaigns: number }> {
    const targets = await db.select().from(outreachTargets);
    const campaigns = await db.select().from(outreachCampaigns);
    return {
      totalTargets: targets.length,
      reached: targets.filter(t => t.status === "reached").length,
      pending: targets.filter(t => t.status === "pending").length,
      failed: targets.filter(t => t.status === "failed").length,
      campaigns: campaigns.length,
    };
  }

  async logVisitor(entry: InsertVisitorLog): Promise<VisitorLog> {
    const [result] = await db.insert(visitorLogs).values(entry).returning();
    return result;
  }

  async getVisitorLogs(limit = 100): Promise<VisitorLog[]> {
    return db.select().from(visitorLogs).orderBy(desc(visitorLogs.createdAt)).limit(limit);
  }

  async getVisitorStats(since?: Date): Promise<{
    total: number;
    humans: number;
    agents: number;
    unknown: number;
    uniqueIps: number;
    topPaths: { path: string; count: number }[];
    topAgents: { userAgent: string; count: number }[];
    byHour: { hour: string; humans: number; agents: number; unknown: number }[];
  }> {
    const condition = since
      ? sql`${visitorLogs.createdAt} >= ${since}`
      : sql`1=1`;
    const rows = await db.select().from(visitorLogs).where(condition);

    const humans = rows.filter(r => r.visitorType === "human").length;
    const agentsCount = rows.filter(r => r.visitorType === "agent").length;
    const unknown = rows.filter(r => r.visitorType === "unknown").length;
    const uniqueIps = new Set(rows.map(r => r.ip).filter(Boolean)).size;

    const pathCounts: Record<string, number> = {};
    const agentCounts: Record<string, number> = {};
    const hourBuckets: Record<string, { humans: number; agents: number; unknown: number }> = {};

    for (const r of rows) {
      pathCounts[r.path] = (pathCounts[r.path] || 0) + 1;
      if (r.userAgent && r.visitorType === "agent") {
        const short = r.userAgent.slice(0, 80);
        agentCounts[short] = (agentCounts[short] || 0) + 1;
      }
      if (r.createdAt) {
        const hour = r.createdAt.toISOString().slice(0, 13) + ":00";
        if (!hourBuckets[hour]) hourBuckets[hour] = { humans: 0, agents: 0, unknown: 0 };
        if (r.visitorType === "human") hourBuckets[hour].humans++;
        else if (r.visitorType === "agent") hourBuckets[hour].agents++;
        else hourBuckets[hour].unknown++;
      }
    }

    const topPaths = Object.entries(pathCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([path, count]) => ({ path, count }));

    const topAgents = Object.entries(agentCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([userAgent, count]) => ({ userAgent, count }));

    const byHour = Object.entries(hourBuckets)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-48)
      .map(([hour, data]) => ({ hour, ...data }));

    return { total: rows.length, humans, agents: agentsCount, unknown, uniqueIps, topPaths, topAgents, byHour };
  }

  async createBountyActivity(activity: InsertBountyActivity): Promise<BountyActivity> {
    const [result] = await db.insert(bountyActivityFeed).values(activity).returning();
    return result;
  }

  async getBountyActivityFeed(limit = 50): Promise<BountyActivity[]> {
    return db.select().from(bountyActivityFeed).orderBy(desc(bountyActivityFeed.createdAt)).limit(limit);
  }

  async createPrivacyTransfer(transfer: InsertPrivacyTransfer): Promise<PrivacyTransfer> {
    const [result] = await db.insert(privacyTransfers).values(transfer).returning();
    return result;
  }

  async getPrivacyTransfer(id: string): Promise<PrivacyTransfer | undefined> {
    const [result] = await db.select().from(privacyTransfers).where(eq(privacyTransfers.id, id));
    return result;
  }

  async getPrivacyTransfers(agentId: string, limit = 50): Promise<PrivacyTransfer[]> {
    return db.select().from(privacyTransfers)
      .where(eq(privacyTransfers.agentId, agentId))
      .orderBy(desc(privacyTransfers.createdAt))
      .limit(limit);
  }

  async updatePrivacyTransferStatus(id: string, status: string, txHash?: string, proofId?: string, errorMessage?: string): Promise<PrivacyTransfer | undefined> {
    const updates: Record<string, any> = { status };
    if (txHash) updates.depositTxHash = txHash;
    if (proofId) updates.proofId = proofId;
    if (errorMessage) updates.errorMessage = errorMessage;
    if (status === "completed" || status === "withdrawn") updates.completedAt = new Date();
    const [result] = await db.update(privacyTransfers).set(updates).where(eq(privacyTransfers.id, id)).returning();
    return result;
  }

  async createTwitterBounty(bounty: InsertTwitterBounty): Promise<TwitterBounty> {
    const [result] = await db.insert(twitterBounties).values(bounty).returning();
    return result;
  }

  async getTwitterBounty(id: string): Promise<TwitterBounty | undefined> {
    const [result] = await db.select().from(twitterBounties).where(eq(twitterBounties.id, id));
    return result;
  }

  async getTwitterBountyByJobId(jobId: string): Promise<TwitterBounty | undefined> {
    const [result] = await db.select().from(twitterBounties).where(eq(twitterBounties.jobId, jobId));
    return result;
  }

  async getTwitterBounties(status?: string): Promise<TwitterBounty[]> {
    if (status) {
      return db.select().from(twitterBounties).where(eq(twitterBounties.status, status)).orderBy(desc(twitterBounties.createdAt));
    }
    return db.select().from(twitterBounties).orderBy(desc(twitterBounties.createdAt));
  }

  async updateTwitterBounty(id: string, data: Partial<TwitterBounty>): Promise<TwitterBounty | undefined> {
    const [result] = await db.update(twitterBounties).set(data).where(eq(twitterBounties.id, id)).returning();
    return result;
  }

  async createTwitterSubmission(submission: InsertTwitterSubmission): Promise<TwitterSubmission> {
    const [result] = await db.insert(twitterSubmissions).values(submission).returning();
    return result;
  }

  async getTwitterSubmission(id: string): Promise<TwitterSubmission | undefined> {
    const [result] = await db.select().from(twitterSubmissions).where(eq(twitterSubmissions.id, id));
    return result;
  }

  async getTwitterSubmissionByTweetId(tweetId: string): Promise<TwitterSubmission | undefined> {
    const [result] = await db.select().from(twitterSubmissions).where(eq(twitterSubmissions.tweetId, tweetId));
    return result;
  }

  async getTwitterSubmissions(twitterBountyId: string): Promise<TwitterSubmission[]> {
    return db.select().from(twitterSubmissions).where(eq(twitterSubmissions.twitterBountyId, twitterBountyId)).orderBy(desc(twitterSubmissions.createdAt));
  }

  async getPaidSubmissionCount(twitterBountyId: string): Promise<number> {
    const results = await db.select().from(twitterSubmissions).where(
      and(
        eq(twitterSubmissions.twitterBountyId, twitterBountyId),
        eq(twitterSubmissions.status, "paid")
      )
    );
    return results.length;
  }

  async updateTwitterSubmission(id: string, data: Partial<TwitterSubmission>): Promise<TwitterSubmission | undefined> {
    const [result] = await db.update(twitterSubmissions).set(data).where(eq(twitterSubmissions.id, id)).returning();
    return result;
  }

  async getTwitterAgentConfig(): Promise<TwitterAgentConfig | undefined> {
    const [result] = await db.select().from(twitterAgentConfig).where(eq(twitterAgentConfig.id, "default"));
    return result;
  }

  async upsertTwitterAgentConfig(config: Partial<InsertTwitterAgentConfig>): Promise<TwitterAgentConfig> {
    const existing = await this.getTwitterAgentConfig();
    if (existing) {
      const [result] = await db.update(twitterAgentConfig).set({ ...config, updatedAt: new Date() }).where(eq(twitterAgentConfig.id, "default")).returning();
      return result;
    }
    const [result] = await db.insert(twitterAgentConfig).values({ id: "default", ...config }).returning();
    return result;
  }

  async getTwitterPersonality(): Promise<TwitterAgentPersonality | undefined> {
    const [row] = await db.select().from(twitterAgentPersonality).where(eq(twitterAgentPersonality.id, "default"));
    return row;
  }

  async upsertTwitterPersonality(data: Partial<TwitterAgentPersonality>): Promise<TwitterAgentPersonality> {
    const existing = await this.getTwitterPersonality();
    if (existing) {
      const [result] = await db.update(twitterAgentPersonality).set({ ...data, updatedAt: new Date() }).where(eq(twitterAgentPersonality.id, "default")).returning();
      return result;
    }
    const [result] = await db.insert(twitterAgentPersonality).values({ id: "default", ...data }).returning();
    return result;
  }

  async logTwitterReply(data: { tweetId: string; inReplyToUser: string; inReplyToText: string; replyText: string; tone?: string; selfScore?: number }): Promise<TwitterReplyLog> {
    const [result] = await db.insert(twitterReplyLog).values(data).returning();
    return result;
  }

  async getRecentTwitterReplies(limit = 50): Promise<TwitterReplyLog[]> {
    return db.select().from(twitterReplyLog).orderBy(desc(twitterReplyLog.createdAt)).limit(limit);
  }

  async updateTwitterReplyEngagement(tweetId: string, likes: number, retweets: number, replies: number): Promise<void> {
    await db.update(twitterReplyLog).set({
      likes, retweets, replies,
      engagement: likes + retweets * 3 + replies * 2,
    }).where(eq(twitterReplyLog.tweetId!, tweetId));
  }

  async createSupportTicket(ticket: InsertSupportTicket): Promise<SupportTicket> {
    const [result] = await db.insert(supportTickets).values(ticket).returning();
    return result;
  }

  async getSupportTicket(id: string): Promise<SupportTicket | undefined> {
    const [result] = await db.select().from(supportTickets).where(eq(supportTickets.id, id));
    return result;
  }

  async getSupportTicketByTweetId(tweetId: string): Promise<SupportTicket | undefined> {
    const [result] = await db.select().from(supportTickets).where(eq(supportTickets.tweetId, tweetId));
    return result;
  }

  async getSupportTickets(status?: string): Promise<SupportTicket[]> {
    if (status) {
      return db.select().from(supportTickets).where(eq(supportTickets.status, status)).orderBy(desc(supportTickets.createdAt));
    }
    return db.select().from(supportTickets).orderBy(desc(supportTickets.createdAt));
  }

  async updateSupportTicket(id: string, data: Partial<SupportTicket>): Promise<SupportTicket | undefined> {
    const [result] = await db.update(supportTickets).set(data).where(eq(supportTickets.id, id)).returning();
    return result;
  }

  async getSupportAgentConfig(): Promise<SupportAgentConfig | undefined> {
    const [result] = await db.select().from(supportAgentConfig).where(eq(supportAgentConfig.id, "default"));
    return result;
  }

  async upsertSupportAgentConfig(config: Partial<InsertSupportAgentConfig>): Promise<SupportAgentConfig> {
    const existing = await this.getSupportAgentConfig();
    if (existing) {
      const [result] = await db.update(supportAgentConfig).set({ ...config, updatedAt: new Date() }).where(eq(supportAgentConfig.id, "default")).returning();
      return result;
    }
    const [result] = await db.insert(supportAgentConfig).values({ id: "default", ...config }).returning();
    return result;
  }

  // ERC-8004 Trustless Agents
  async createErc8004Identity(identity: InsertErc8004Identity): Promise<Erc8004Identity> {
    const [result] = await db.insert(erc8004Identities).values(identity).returning();
    return result;
  }

  async getErc8004Identity(id: string): Promise<Erc8004Identity | undefined> {
    const [result] = await db.select().from(erc8004Identities).where(eq(erc8004Identities.id, id));
    return result;
  }

  async getErc8004Identities(ownerWallet?: string): Promise<Erc8004Identity[]> {
    if (ownerWallet) {
      return db.select().from(erc8004Identities).where(eq(erc8004Identities.ownerWallet, ownerWallet)).orderBy(desc(erc8004Identities.createdAt));
    }
    return db.select().from(erc8004Identities).orderBy(desc(erc8004Identities.createdAt));
  }

  async updateErc8004Identity(id: string, data: Partial<Erc8004Identity>): Promise<Erc8004Identity | undefined> {
    const [result] = await db.update(erc8004Identities).set(data).where(eq(erc8004Identities.id, id)).returning();
    return result;
  }

  async createErc8004Reputation(feedback: InsertErc8004Reputation): Promise<Erc8004Reputation> {
    const [result] = await db.insert(erc8004Reputation).values(feedback).returning();
    return result;
  }

  async getErc8004Reputation(agentIdentityId: string): Promise<Erc8004Reputation[]> {
    return db.select().from(erc8004Reputation).where(eq(erc8004Reputation.agentIdentityId, agentIdentityId)).orderBy(desc(erc8004Reputation.createdAt));
  }

  async createErc8004Validation(validation: InsertErc8004Validation): Promise<Erc8004Validation> {
    const [result] = await db.insert(erc8004Validations).values(validation).returning();
    return result;
  }

  async getErc8004Validations(agentIdentityId: string): Promise<Erc8004Validation[]> {
    return db.select().from(erc8004Validations).where(eq(erc8004Validations.agentIdentityId, agentIdentityId)).orderBy(desc(erc8004Validations.createdAt));
  }

  // BAP-578 Non-Fungible Agents
  async createBap578Nfa(nfa: InsertBap578Nfa): Promise<Bap578Nfa> {
    const [result] = await db.insert(bap578Nfas).values(nfa).returning();
    return result;
  }

  async getBap578Nfa(id: string): Promise<Bap578Nfa | undefined> {
    const [result] = await db.select().from(bap578Nfas).where(eq(bap578Nfas.id, id));
    return result;
  }

  async getBap578Nfas(ownerWallet?: string): Promise<Bap578Nfa[]> {
    if (ownerWallet) {
      return db.select().from(bap578Nfas).where(eq(bap578Nfas.ownerWallet, ownerWallet)).orderBy(desc(bap578Nfas.createdAt));
    }
    return db.select().from(bap578Nfas).orderBy(desc(bap578Nfas.createdAt));
  }

  async updateBap578Nfa(id: string, data: Partial<Bap578Nfa>): Promise<Bap578Nfa | undefined> {
    const [result] = await db.update(bap578Nfas).set(data).where(eq(bap578Nfas.id, id)).returning();
    return result;
  }

  async createAgentTwitterAccount(data: InsertAgentTwitterAccount): Promise<AgentTwitterAccount> {
    const [result] = await db.insert(agentTwitterAccounts).values(data).returning();
    return result;
  }

  async getAgentTwitterAccount(agentId: string): Promise<AgentTwitterAccount | undefined> {
    const [result] = await db.select().from(agentTwitterAccounts).where(eq(agentTwitterAccounts.agentId, agentId));
    return result;
  }

  async getActiveAgentTwitterAccounts(): Promise<AgentTwitterAccount[]> {
    return db.select().from(agentTwitterAccounts).where(eq(agentTwitterAccounts.enabled, 1));
  }

  async getAllAgentTwitterAccounts(): Promise<AgentTwitterAccount[]> {
    return db.select().from(agentTwitterAccounts);
  }

  async updateAgentTwitterAccount(agentId: string, data: Partial<AgentTwitterAccount>): Promise<AgentTwitterAccount | undefined> {
    const [result] = await db.update(agentTwitterAccounts).set({ ...data, updatedAt: new Date() }).where(eq(agentTwitterAccounts.agentId, agentId)).returning();
    return result;
  }

  async deleteAgentTwitterAccount(agentId: string): Promise<void> {
    await db.delete(agentTwitterAccounts).where(eq(agentTwitterAccounts.agentId, agentId));
  }

  async createStrategyMemo(memo: InsertAgentStrategyMemo): Promise<AgentStrategyMemo> {
    const [created] = await db.insert(agentStrategyMemos).values(memo).returning();
    return created;
  }

  async getStrategyMemos(agentId: string, limit = 20): Promise<AgentStrategyMemo[]> {
    return db.select().from(agentStrategyMemos)
      .where(eq(agentStrategyMemos.agentId, agentId))
      .orderBy(desc(agentStrategyMemos.createdAt))
      .limit(limit);
  }

  async getActiveStrategy(agentId: string): Promise<AgentStrategyMemo | undefined> {
    const [memo] = await db.select().from(agentStrategyMemos)
      .where(and(
        eq(agentStrategyMemos.agentId, agentId),
        eq(agentStrategyMemos.status, "active"),
        eq(agentStrategyMemos.memoType, "strategy")
      ))
      .orderBy(desc(agentStrategyMemos.createdAt))
      .limit(1);
    return memo;
  }

  async supersedeMemo(memoId: string): Promise<void> {
    await db.update(agentStrategyMemos)
      .set({ status: "superseded" })
      .where(eq(agentStrategyMemos.id, memoId));
  }

  async createTweetPerformance(record: InsertTweetPerformance): Promise<TweetPerformance> {
    const [created] = await db.insert(tweetPerformance).values(record).returning();
    return created;
  }

  async getTweetPerformance(agentId: string, limit = 50): Promise<TweetPerformance[]> {
    return db.select().from(tweetPerformance)
      .where(eq(tweetPerformance.agentId, agentId))
      .orderBy(desc(tweetPerformance.createdAt))
      .limit(limit);
  }

  async createStrategyActionItem(item: InsertStrategyActionItem): Promise<StrategyActionItem> {
    const [created] = await db.insert(strategyActionItems).values(item).returning();
    return created;
  }

  async getStrategyActionItems(agentId: string): Promise<StrategyActionItem[]> {
    return db.select().from(strategyActionItems)
      .where(eq(strategyActionItems.agentId, agentId))
      .orderBy(desc(strategyActionItems.createdAt));
  }

  async updateStrategyActionItem(id: string, data: Partial<StrategyActionItem>): Promise<StrategyActionItem | undefined> {
    const [updated] = await db.update(strategyActionItems)
      .set(data)
      .where(eq(strategyActionItems.id, id))
      .returning();
    return updated;
  }

  async createKnowledgeEntry(entry: InsertAgentKnowledgeBase): Promise<AgentKnowledgeBase> {
    const [created] = await db.insert(agentKnowledgeBase).values(entry).returning();
    return created;
  }

  async getKnowledgeBase(agentId: string): Promise<AgentKnowledgeBase[]> {
    return db.select().from(agentKnowledgeBase)
      .where(eq(agentKnowledgeBase.agentId, agentId))
      .orderBy(desc(agentKnowledgeBase.createdAt));
  }

  async deleteKnowledgeEntry(id: string): Promise<void> {
    await db.delete(agentKnowledgeBase).where(eq(agentKnowledgeBase.id, id));
  }

  async upsertConversationMemory(agentId: string, twitterUsername: string, lastInteraction: string, sentiment: string): Promise<AgentConversationMemory> {
    const existing = await db.select().from(agentConversationMemory)
      .where(and(eq(agentConversationMemory.agentId, agentId), eq(agentConversationMemory.twitterUsername, twitterUsername)));
    if (existing.length > 0) {
      const [updated] = await db.update(agentConversationMemory)
        .set({
          lastInteraction,
          sentiment,
          interactionCount: sql`${agentConversationMemory.interactionCount} + 1`,
          lastInteractionAt: new Date(),
        })
        .where(eq(agentConversationMemory.id, existing[0].id)).returning();
      return updated;
    }
    const [created] = await db.insert(agentConversationMemory).values({
      agentId,
      twitterUsername,
      lastInteraction,
      sentiment,
      interactionCount: 1,
      lastInteractionAt: new Date(),
    }).returning();
    return created;
  }

  async getConversationMemory(agentId: string, twitterUsername: string): Promise<AgentConversationMemory | undefined> {
    const [result] = await db.select().from(agentConversationMemory)
      .where(and(eq(agentConversationMemory.agentId, agentId), eq(agentConversationMemory.twitterUsername, twitterUsername)));
    return result;
  }

  async getRecentConversations(agentId: string, limit = 20): Promise<AgentConversationMemory[]> {
    return db.select().from(agentConversationMemory)
      .where(eq(agentConversationMemory.agentId, agentId))
      .orderBy(desc(agentConversationMemory.lastInteractionAt))
      .limit(limit);
  }

  async createToolResult(result: InsertAgentToolResult): Promise<AgentToolResult> {
    const [created] = await db.insert(agentToolResults).values(result).returning();
    return created;
  }

  async getRecentToolResults(agentId: string, limit = 10): Promise<AgentToolResult[]> {
    return db.select().from(agentToolResults)
      .where(eq(agentToolResults.agentId, agentId))
      .orderBy(desc(agentToolResults.createdAt))
      .limit(limit);
  }

  async createCollaborationLog(log: InsertAgentCollaborationLog): Promise<AgentCollaborationLog> {
    const [created] = await db.insert(agentCollaborationLog).values(log).returning();
    return created;
  }

  async getRecentCollaborations(agentId: string, limit = 10): Promise<AgentCollaborationLog[]> {
    return db.select().from(agentCollaborationLog)
      .where(eq(agentCollaborationLog.requestingAgentId, agentId))
      .orderBy(desc(agentCollaborationLog.createdAt))
      .limit(limit);
  }

  async createTask(task: InsertAgentTask): Promise<AgentTask> {
    const [created] = await db.insert(agentTasks).values(task).returning();
    return created;
  }

  async getTask(id: string): Promise<AgentTask | undefined> {
    const [result] = await db.select().from(agentTasks).where(eq(agentTasks.id, id));
    return result;
  }

  async getTasksByAgent(agentId: string, limit = 20): Promise<AgentTask[]> {
    return db.select().from(agentTasks)
      .where(eq(agentTasks.agentId, agentId))
      .orderBy(desc(agentTasks.createdAt))
      .limit(limit);
  }

  async getTasksByCreator(wallet: string, limit = 20): Promise<AgentTask[]> {
    return db.select().from(agentTasks)
      .where(eq(agentTasks.creatorWallet, wallet))
      .orderBy(desc(agentTasks.createdAt))
      .limit(limit);
  }

  async updateTask(id: string, data: Partial<AgentTask>): Promise<AgentTask | undefined> {
    const [updated] = await db.update(agentTasks).set(data).where(eq(agentTasks.id, id)).returning();
    return updated;
  }

  async getRecentPublicTasks(limit = 30): Promise<AgentTask[]> {
    return db.select().from(agentTasks)
      .orderBy(desc(agentTasks.createdAt))
      .limit(limit);
  }

  async createTokenLaunch(launch: InsertTokenLaunch): Promise<TokenLaunch> {
    const [created] = await db.insert(tokenLaunches).values(launch).returning();
    return created;
  }

  async getTokenLaunch(id: string): Promise<TokenLaunch | undefined> {
    const [result] = await db.select().from(tokenLaunches).where(eq(tokenLaunches.id, id));
    return result;
  }

  async getTokenLaunches(agentId?: string, limit = 50): Promise<TokenLaunch[]> {
    if (agentId) {
      return db.select().from(tokenLaunches)
        .where(eq(tokenLaunches.agentId, agentId))
        .orderBy(desc(tokenLaunches.createdAt))
        .limit(limit);
    }
    return db.select().from(tokenLaunches)
      .orderBy(desc(tokenLaunches.createdAt))
      .limit(limit);
  }

  async updateTokenLaunch(id: string, data: Partial<TokenLaunch>): Promise<TokenLaunch | undefined> {
    const [updated] = await db.update(tokenLaunches).set(data).where(eq(tokenLaunches.id, id)).returning();
    return updated;
  }

  async createChaosMilestone(milestone: InsertChaosMilestone): Promise<ChaosMilestone> {
    const [created] = await db.insert(chaosMilestones).values(milestone).returning();
    return created;
  }

  async getChaosMilestones(launchId: string): Promise<ChaosMilestone[]> {
    return db.select().from(chaosMilestones)
      .where(eq(chaosMilestones.launchId, launchId))
      .orderBy(chaosMilestones.milestoneNumber);
  }

  async updateChaosMilestone(id: string, data: Partial<ChaosMilestone>): Promise<ChaosMilestone | undefined> {
    const [updated] = await db.update(chaosMilestones).set(data).where(eq(chaosMilestones.id, id)).returning();
    return updated;
  }

  async getPendingChaosMilestones(): Promise<ChaosMilestone[]> {
    return db.select().from(chaosMilestones)
      .where(eq(chaosMilestones.status, "pending"))
      .orderBy(chaosMilestones.milestoneNumber);
  }

  async getActiveChaosPlan(): Promise<{ launch: TokenLaunch; milestones: ChaosMilestone[] } | null> {
    const milestones = await db.select().from(chaosMilestones)
      .where(eq(chaosMilestones.status, "pending"))
      .orderBy(chaosMilestones.milestoneNumber)
      .limit(1);
    if (milestones.length === 0) {
      const executing = await db.select().from(chaosMilestones)
        .where(eq(chaosMilestones.status, "executing"))
        .limit(1);
      if (executing.length === 0) return null;
      const launch = await this.getTokenLaunch(executing[0].launchId);
      if (!launch) return null;
      const all = await this.getChaosMilestones(launch.id);
      return { launch, milestones: all };
    }
    const launch = await this.getTokenLaunch(milestones[0].launchId);
    if (!launch) return null;
    const all = await this.getChaosMilestones(launch.id);
    return { launch, milestones: all };
  }

  async getAllActiveChaosPlans(): Promise<{ launch: TokenLaunch; milestones: ChaosMilestone[] }[]> {
    const pendingMilestones = await db.select().from(chaosMilestones)
      .where(inArray(chaosMilestones.status, ["pending", "executing"]))
      .orderBy(chaosMilestones.milestoneNumber);

    const launchIds = [...new Set(pendingMilestones.map(m => m.launchId))];
    const plans: { launch: TokenLaunch; milestones: ChaosMilestone[] }[] = [];

    for (const launchId of launchIds) {
      const launch = await this.getTokenLaunch(launchId);
      if (!launch) continue;
      const milestones = await this.getChaosMilestones(launchId);
      plans.push({ launch, milestones });
    }

    return plans;
  }

  async getTelegramWallets(chatId: string): Promise<TelegramWallet[]> {
    return db.select().from(telegramWallets).where(eq(telegramWallets.chatId, chatId)).orderBy(desc(telegramWallets.createdAt));
  }

  async saveTelegramWallet(chatId: string, walletAddress: string, rawPrivateKey?: string): Promise<TelegramWallet> {
    const encrypted = rawPrivateKey ? encryptPrivateKey(rawPrivateKey) : null;
    const existing = await db.select().from(telegramWallets)
      .where(and(eq(telegramWallets.chatId, chatId), eq(telegramWallets.walletAddress, walletAddress.toLowerCase())));
    if (existing.length > 0) {
      if (encrypted && !existing[0].encryptedPrivateKey) {
        await db.update(telegramWallets).set({ encryptedPrivateKey: encrypted }).where(eq(telegramWallets.id, existing[0].id));
      }
      return existing[0];
    }

    await db.update(telegramWallets).set({ isActive: false }).where(eq(telegramWallets.chatId, chatId));

    const [row] = await db.insert(telegramWallets).values({
      chatId,
      walletAddress: walletAddress.toLowerCase(),
      encryptedPrivateKey: encrypted,
      isActive: true,
    }).returning();
    return row;
  }

  async getTelegramWalletPrivateKey(chatId: string, walletAddress: string): Promise<string | null> {
    const rows = await db.select().from(telegramWallets)
      .where(and(eq(telegramWallets.chatId, chatId), eq(telegramWallets.walletAddress, walletAddress.toLowerCase())));
    if (rows.length === 0 || !rows[0].encryptedPrivateKey) return null;
    try {
      return decryptPrivateKey(rows[0].encryptedPrivateKey);
    } catch (e) {
      console.error("[Storage] Failed to decrypt wallet private key:", e);
      return null;
    }
  }

  async getPrivateKeyByWalletAddress(walletAddress: string): Promise<string | null> {
    const rows = await db.select().from(telegramWallets)
      .where(eq(telegramWallets.walletAddress, walletAddress.toLowerCase()));
    if (rows.length === 0 || !rows[0].encryptedPrivateKey) return null;
    try {
      return decryptPrivateKey(rows[0].encryptedPrivateKey);
    } catch (e) {
      console.error("[Storage] Failed to decrypt wallet private key:", e);
      return null;
    }
  }

  async removeTelegramWallet(chatId: string, walletAddress: string): Promise<void> {
    await db.delete(telegramWallets)
      .where(and(eq(telegramWallets.chatId, chatId), eq(telegramWallets.walletAddress, walletAddress.toLowerCase())));
  }

  async setActiveTelegramWallet(chatId: string, walletAddress: string): Promise<void> {
    await db.update(telegramWallets).set({ isActive: false }).where(eq(telegramWallets.chatId, chatId));
    await db.update(telegramWallets).set({ isActive: true })
      .where(and(eq(telegramWallets.chatId, chatId), eq(telegramWallets.walletAddress, walletAddress.toLowerCase())));
  }

  async getAllTelegramWalletLinks(): Promise<TelegramWallet[]> {
    return db.select().from(telegramWallets).orderBy(telegramWallets.chatId);
  }
}

export const storage = new DatabaseStorage();
