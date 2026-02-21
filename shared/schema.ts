import { sql } from "drizzle-orm";
import { pgTable, text, varchar, boolean, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const agents = pgTable("agents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  bio: text("bio"),
  modelType: text("model_type").notNull().default("meta-llama/Llama-3.1-70B-Instruct"),
  status: text("status").notNull().default("active"),
  onchainId: text("onchain_id"),
  onchainRegistered: boolean("onchain_registered").notNull().default(false),
  creatorWallet: text("creator_wallet"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertAgentSchema = createInsertSchema(agents).omit({ id: true, createdAt: true });
export type InsertAgent = z.infer<typeof insertAgentSchema>;
export type Agent = typeof agents.$inferSelect;

export const agentWallets = pgTable("agent_wallets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  balance: text("balance").notNull().default("0"),
  totalEarned: text("total_earned").notNull().default("0"),
  totalSpent: text("total_spent").notNull().default("0"),
  status: text("status").notNull().default("active"),
  lastActiveAt: timestamp("last_active_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertAgentWalletSchema = createInsertSchema(agentWallets).omit({ id: true, createdAt: true, lastActiveAt: true });
export type InsertAgentWallet = z.infer<typeof insertAgentWalletSchema>;
export type AgentWallet = typeof agentWallets.$inferSelect;

export const agentTransactions = pgTable("agent_transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  type: text("type").notNull(),
  amount: text("amount").notNull(),
  counterpartyAgentId: varchar("counterparty_agent_id"),
  referenceType: text("reference_type"),
  referenceId: varchar("reference_id"),
  description: text("description"),
  txHash: text("tx_hash"),
  chainId: integer("chain_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertAgentTransactionSchema = createInsertSchema(agentTransactions).omit({ id: true, createdAt: true });
export type InsertAgentTransaction = z.infer<typeof insertAgentTransactionSchema>;
export type AgentTransaction = typeof agentTransactions.$inferSelect;

export const agentSkills = pgTable("agent_skills", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  priceAmount: text("price_amount").notNull().default("0"),
  category: text("category").notNull().default("general"),
  isActive: boolean("is_active").notNull().default(true),
  totalPurchases: integer("total_purchases").notNull().default(0),
  totalRevenue: text("total_revenue").notNull().default("0"),
  code: text("code"),
  inputSchema: text("input_schema"),
  outputSchema: text("output_schema"),
  exampleInput: text("example_input"),
  exampleOutput: text("example_output"),
  version: integer("version").notNull().default(1),
  isExecutable: boolean("is_executable").notNull().default(false),
  executionCount: integer("execution_count").notNull().default(0),
  avgRating: integer("avg_rating").notNull().default(0),
  totalRatings: integer("total_ratings").notNull().default(0),
  tier: text("tier").notNull().default("bronze"),
  totalRoyalties: text("total_royalties").notNull().default("0"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertAgentSkillSchema = createInsertSchema(agentSkills).omit({ id: true, createdAt: true, totalPurchases: true, totalRevenue: true, executionCount: true, avgRating: true, totalRatings: true, tier: true, totalRoyalties: true });
export type InsertAgentSkill = z.infer<typeof insertAgentSkillSchema>;
export type AgentSkill = typeof agentSkills.$inferSelect;

export const skillPurchases = pgTable("skill_purchases", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  skillId: varchar("skill_id").notNull(),
  buyerAgentId: varchar("buyer_agent_id").notNull(),
  sellerAgentId: varchar("seller_agent_id").notNull(),
  amount: text("amount").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertSkillPurchaseSchema = createInsertSchema(skillPurchases).omit({ id: true, createdAt: true });
export type InsertSkillPurchase = z.infer<typeof insertSkillPurchaseSchema>;
export type SkillPurchase = typeof skillPurchases.$inferSelect;

export const agentEvolutions = pgTable("agent_evolutions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  fromModel: text("from_model"),
  toModel: text("to_model").notNull(),
  reason: text("reason"),
  metricsJson: text("metrics_json"),
  verificationHash: text("verification_hash"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertAgentEvolutionSchema = createInsertSchema(agentEvolutions).omit({ id: true, createdAt: true });
export type InsertAgentEvolution = z.infer<typeof insertAgentEvolutionSchema>;
export type AgentEvolution = typeof agentEvolutions.$inferSelect;

export const agentLineage = pgTable("agent_lineage", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  parentAgentId: varchar("parent_agent_id").notNull(),
  childAgentId: varchar("child_agent_id").notNull(),
  revenueShareBps: integer("revenue_share_bps").notNull().default(1000),
  totalRevenueShared: text("total_revenue_shared").notNull().default("0"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertAgentLineageSchema = createInsertSchema(agentLineage).omit({ id: true, createdAt: true });
export type InsertAgentLineage = z.infer<typeof insertAgentLineageSchema>;
export type AgentLineage = typeof agentLineage.$inferSelect;

export const agentRuntimeProfiles = pgTable("agent_runtime_profiles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  modelName: text("model_name").notNull().default("meta-llama/Llama-3.1-70B-Instruct"),
  modelVersion: text("model_version"),
  configJson: text("config_json"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertAgentRuntimeProfileSchema = createInsertSchema(agentRuntimeProfiles).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAgentRuntimeProfile = z.infer<typeof insertAgentRuntimeProfileSchema>;
export type AgentRuntimeProfile = typeof agentRuntimeProfiles.$inferSelect;

export const agentSurvivalStatus = pgTable("agent_survival_status", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  tier: text("tier").notNull().default("normal"),
  previousTier: text("previous_tier"),
  lastTransitionAt: timestamp("last_transition_at").defaultNow(),
  reason: text("reason"),
  turnsAlive: integer("turns_alive").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertAgentSurvivalStatusSchema = createInsertSchema(agentSurvivalStatus).omit({ id: true, createdAt: true, lastTransitionAt: true });
export type InsertAgentSurvivalStatus = z.infer<typeof insertAgentSurvivalStatusSchema>;
export type AgentSurvivalStatus = typeof agentSurvivalStatus.$inferSelect;

export const agentConstitution = pgTable("agent_constitution", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  lawNumber: integer("law_number").notNull(),
  lawTitle: text("law_title").notNull(),
  lawText: text("law_text").notNull(),
  isImmutable: boolean("is_immutable").notNull().default(true),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertAgentConstitutionSchema = createInsertSchema(agentConstitution).omit({ id: true, createdAt: true });
export type InsertAgentConstitution = z.infer<typeof insertAgentConstitutionSchema>;
export type AgentConstitution = typeof agentConstitution.$inferSelect;

export const agentSoulEntries = pgTable("agent_soul_entries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  entry: text("entry").notNull(),
  entryType: text("entry_type").notNull().default("reflection"),
  source: text("source").notNull().default("self"),
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertAgentSoulEntrySchema = createInsertSchema(agentSoulEntries).omit({ id: true, createdAt: true });
export type InsertAgentSoulEntry = z.infer<typeof insertAgentSoulEntrySchema>;
export type AgentSoulEntry = typeof agentSoulEntries.$inferSelect;

export const agentAuditLogs = pgTable("agent_audit_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  actionType: text("action_type").notNull(),
  targetAgentId: varchar("target_agent_id"),
  detailsJson: text("details_json"),
  result: text("result").notNull().default("success"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertAgentAuditLogSchema = createInsertSchema(agentAuditLogs).omit({ id: true, createdAt: true });
export type InsertAgentAuditLog = z.infer<typeof insertAgentAuditLogSchema>;
export type AgentAuditLog = typeof agentAuditLogs.$inferSelect;

export const agentMessages = pgTable("agent_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fromAgentId: varchar("from_agent_id").notNull(),
  toAgentId: varchar("to_agent_id").notNull(),
  subject: text("subject"),
  body: text("body").notNull(),
  status: text("status").notNull().default("unread"),
  readAt: timestamp("read_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertAgentMessageSchema = createInsertSchema(agentMessages).omit({ id: true, createdAt: true, readAt: true });
export type InsertAgentMessage = z.infer<typeof insertAgentMessageSchema>;
export type AgentMessage = typeof agentMessages.$inferSelect;

export const inferenceProviders = pgTable("inference_providers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  type: text("type").notNull().default("centralized"),
  network: text("network"),
  modelsSupported: text("models_supported").array(),
  costPerRequest: text("cost_per_request").notNull().default("0"),
  latencyMs: integer("latency_ms"),
  isActive: boolean("is_active").notNull().default(true),
  verifiable: boolean("verifiable").notNull().default(false),
  decentralized: boolean("decentralized").notNull().default(false),
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertInferenceProviderSchema = createInsertSchema(inferenceProviders).omit({ id: true, createdAt: true });
export type InsertInferenceProvider = z.infer<typeof insertInferenceProviderSchema>;
export type InferenceProvider = typeof inferenceProviders.$inferSelect;

export const inferenceRequests = pgTable("inference_requests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  providerId: varchar("provider_id").notNull(),
  model: text("model").notNull(),
  prompt: text("prompt").notNull(),
  response: text("response"),
  status: text("status").notNull().default("pending"),
  costAmount: text("cost_amount").notNull().default("0"),
  latencyMs: integer("latency_ms"),
  proofHash: text("proof_hash"),
  proofType: text("proof_type"),
  proofAnchored: boolean("proof_anchored").notNull().default(false),
  preferDecentralized: boolean("prefer_decentralized").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertInferenceRequestSchema = createInsertSchema(inferenceRequests).omit({ id: true, createdAt: true });
export type InsertInferenceRequest = z.infer<typeof insertInferenceRequestSchema>;
export type InferenceRequest = typeof inferenceRequests.$inferSelect;

export const platformRevenue = pgTable("platform_revenue", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  feeType: text("fee_type").notNull(),
  amount: text("amount").notNull(),
  agentId: varchar("agent_id"),
  referenceId: varchar("reference_id"),
  description: text("description"),
  txHash: text("tx_hash"),
  chainId: integer("chain_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertPlatformRevenueSchema = createInsertSchema(platformRevenue).omit({ id: true, createdAt: true });
export type InsertPlatformRevenue = z.infer<typeof insertPlatformRevenueSchema>;
export type PlatformRevenue = typeof platformRevenue.$inferSelect;

export const skillExecutions = pgTable("skill_executions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  skillId: varchar("skill_id").notNull(),
  callerType: text("caller_type").notNull().default("user"),
  callerId: varchar("caller_id"),
  inputJson: text("input_json"),
  outputJson: text("output_json"),
  status: text("status").notNull().default("pending"),
  errorMessage: text("error_message"),
  latencyMs: integer("latency_ms"),
  rating: integer("rating"),
  costWei: text("cost_wei").notNull().default("0"),
  txHash: text("tx_hash"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertSkillExecutionSchema = createInsertSchema(skillExecutions).omit({ id: true, createdAt: true });
export type InsertSkillExecution = z.infer<typeof insertSkillExecutionSchema>;
export type SkillExecution = typeof skillExecutions.$inferSelect;

export const agentMemory = pgTable("agent_memory", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  memoryType: text("memory_type").notNull(),
  key: text("key").notNull(),
  value: text("value").notNull(),
  confidence: integer("confidence").notNull().default(50),
  updatedAt: timestamp("updated_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertAgentMemorySchema = createInsertSchema(agentMemory).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAgentMemory = z.infer<typeof insertAgentMemorySchema>;
export type AgentMemory = typeof agentMemory.$inferSelect;

export const agentJobs = pgTable("agent_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientAgentId: varchar("client_agent_id").notNull(),
  workerAgentId: varchar("worker_agent_id"),
  title: text("title").notNull(),
  description: text("description").notNull(),
  category: text("category").notNull().default("general"),
  budget: text("budget").notNull(),
  status: text("status").notNull().default("open"),
  resultJson: text("result_json"),
  escrowAmount: text("escrow_amount"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertAgentJobSchema = createInsertSchema(agentJobs).omit({ id: true, createdAt: true, completedAt: true });
export type InsertAgentJob = z.infer<typeof insertAgentJobSchema>;
export type AgentJob = typeof agentJobs.$inferSelect;

export const skillPipelines = pgTable("skill_pipelines", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description"),
  creatorAgentId: varchar("creator_agent_id").notNull(),
  skillIds: text("skill_ids").array().notNull(),
  priceAmount: text("price_amount").notNull().default("0"),
  executionCount: integer("execution_count").notNull().default(0),
  totalRoyalties: text("total_royalties").notNull().default("0"),
  tier: text("tier").notNull().default("bronze"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertSkillPipelineSchema = createInsertSchema(skillPipelines).omit({ id: true, createdAt: true, executionCount: true, totalRoyalties: true, tier: true });
export type InsertSkillPipeline = z.infer<typeof insertSkillPipelineSchema>;
export type SkillPipeline = typeof skillPipelines.$inferSelect;

export const userCredits = pgTable("user_credits", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: text("session_id").notNull().unique(),
  freeExecutionsUsed: integer("free_executions_used").notNull().default(0),
  walletAddress: text("wallet_address"),
  totalPaid: text("total_paid").notNull().default("0"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertUserCreditsSchema = createInsertSchema(userCredits).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertUserCredits = z.infer<typeof insertUserCreditsSchema>;
export type UserCredits = typeof userCredits.$inferSelect;

export const SKILL_TIERS = {
  bronze: { minExecutions: 0, label: "Bronze", priceMultiplier: 1.0 },
  silver: { minExecutions: 10, label: "Silver", priceMultiplier: 1.25 },
  gold: { minExecutions: 50, label: "Gold", priceMultiplier: 1.5 },
  diamond: { minExecutions: 200, label: "Diamond", priceMultiplier: 2.0 },
  legendary: { minExecutions: 1000, label: "Legendary", priceMultiplier: 3.0 },
} as const;

export const EXECUTION_ROYALTY_BPS = 500;
export const FREE_EXECUTIONS_LIMIT = 5;

export const SKILL_CATEGORIES = [
  "text-analysis", "code-generation", "data-transform", "math-compute",
  "content-creation", "translation", "summarization", "classification",
  "extraction", "formatting", "crypto-data", "web-data", "general"
] as const;

export const PLATFORM_FEES = {
  AGENT_CREATION_FEE: "100000000000000",
  REPLICATION_FEE_BPS: 100,
  SKILL_PURCHASE_FEE_BPS: 50,
  INFERENCE_MARKUP_BPS: 200,
  EVOLUTION_FEE: "500000000000000",
  SKILL_LISTING_FEE: "200000000000000",
  EXECUTION_ROYALTY_BPS: 500,
} as const;

export const web4CreateAgentRequestSchema = z.object({
  name: z.string().min(1).max(50),
  bio: z.string().max(300).optional(),
  modelType: z.enum(["meta-llama/Llama-3.1-70B-Instruct", "deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct"]).default("meta-llama/Llama-3.1-70B-Instruct"),
  initialDeposit: z.string().min(1),
  targetChain: z.enum(["bnbMainnet", "baseMainnet", "xlayerMainnet"]).default("bnbMainnet"),
  creatorWallet: z.string().optional(),
  onchainTxHash: z.string().optional(),
  onchainChainId: z.number().optional(),
});

export const web4DepositRequestSchema = z.object({
  agentId: z.string().min(1),
  amount: z.string().min(1),
});

export const web4TransferRequestSchema = z.object({
  fromAgentId: z.string().min(1),
  toAgentId: z.string().min(1),
  amount: z.string().min(1),
  description: z.string().optional(),
});

export const web4TipRequestSchema = z.object({
  fromAgentId: z.string().min(1),
  toAgentId: z.string().min(1),
  amount: z.string().min(1),
  referenceType: z.enum(["post", "comment", "skill"]).optional(),
  referenceId: z.string().optional(),
});

export const web4CreateSkillRequestSchema = z.object({
  agentId: z.string().min(1),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  priceAmount: z.string().min(1),
  category: z.enum(["analysis", "trading", "content", "data", "automation", "general"]).default("general"),
});

export const web4PurchaseSkillRequestSchema = z.object({
  buyerAgentId: z.string().min(1),
  skillId: z.string().min(1),
});

export const web4EvolveRequestSchema = z.object({
  agentId: z.string().min(1),
  toModel: z.string().min(1),
  reason: z.string().optional(),
  metricsJson: z.string().optional(),
});

export const web4ReplicateRequestSchema = z.object({
  parentAgentId: z.string().min(1),
  childName: z.string().min(1).max(50),
  childBio: z.string().max(300).optional(),
  revenueShareBps: z.number().min(0).max(5000).default(1000),
  fundingAmount: z.string().min(1),
});

export const web4SoulEntryRequestSchema = z.object({
  agentId: z.string().min(1),
  entry: z.string().min(1).max(2000),
  entryType: z.enum(["reflection", "goal", "identity", "milestone", "observation"]).default("reflection"),
});

export const web4SendMessageRequestSchema = z.object({
  fromAgentId: z.string().min(1),
  toAgentId: z.string().min(1),
  subject: z.string().max(200).optional(),
  body: z.string().min(1).max(5000),
});

export const web4InferenceRequestSchema = z.object({
  agentId: z.string().min(1),
  prompt: z.string().min(1).max(5000),
  model: z.string().optional(),
  preferDecentralized: z.boolean().default(true),
  maxCost: z.string().optional(),
});

export const web4SetProviderRequestSchema = z.object({
  agentId: z.string().min(1),
  providerId: z.string().min(1),
});

export const executeSkillRequestSchema = z.object({
  input: z.record(z.any()),
  callerType: z.enum(["user", "agent"]).default("user"),
  callerId: z.string().optional(),
  sessionId: z.string().optional(),
});

export const createPipelineRequestSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  creatorAgentId: z.string().min(1),
  skillIds: z.array(z.string()).min(2).max(10),
  priceAmount: z.string().min(1),
});

export const executePipelineRequestSchema = z.object({
  input: z.record(z.any()),
  callerType: z.enum(["user", "agent"]).default("user"),
  callerId: z.string().optional(),
  sessionId: z.string().optional(),
});

export const rateSkillRequestSchema = z.object({
  executionId: z.string().min(1),
  rating: z.number().min(1).max(5),
});

export const createJobRequestSchema = z.object({
  clientAgentId: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  category: z.string().default("general"),
  budget: z.string().min(1),
});
