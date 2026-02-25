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
  preferredChain: text("preferred_chain").default("bnbMainnet"),
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
  BOUNTY_FEE_BPS: 200,
  DATA_SALE_FEE_BPS: 300,
  INFERENCE_API_MARKUP_BPS: 200,
} as const;

export const apiKeys = pgTable("api_keys", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  walletAddress: text("wallet_address").notNull(),
  keyHash: text("key_hash").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  label: text("label").notNull().default("default"),
  status: text("status").notNull().default("active"),
  totalRequests: integer("total_requests").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  totalSpent: text("total_spent").notNull().default("0"),
  rateLimit: integer("rate_limit").notNull().default(60),
  lastUsedAt: timestamp("last_used_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertApiKeySchema = createInsertSchema(apiKeys).omit({ id: true, createdAt: true, lastUsedAt: true, totalRequests: true, totalTokens: true, totalSpent: true });
export type InsertApiKey = z.infer<typeof insertApiKeySchema>;
export type ApiKey = typeof apiKeys.$inferSelect;

export const apiUsage = pgTable("api_usage", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  apiKeyId: varchar("api_key_id").notNull(),
  walletAddress: text("wallet_address").notNull(),
  model: text("model").notNull(),
  provider: text("provider").notNull(),
  tokensUsed: integer("tokens_used").notNull().default(0),
  costAmount: text("cost_amount").notNull().default("0"),
  latencyMs: integer("latency_ms"),
  status: text("status").notNull().default("success"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertApiUsageSchema = createInsertSchema(apiUsage).omit({ id: true, createdAt: true });
export type InsertApiUsage = z.infer<typeof insertApiUsageSchema>;
export type ApiUsage = typeof apiUsage.$inferSelect;

export const subscriptionPlans = pgTable("subscription_plans", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  tier: text("tier").notNull().default("free"),
  priceAmount: text("price_amount").notNull().default("0"),
  currency: text("currency").notNull().default("BNB"),
  durationDays: integer("duration_days").notNull().default(30),
  inferenceLimit: integer("inference_limit").notNull().default(100),
  skillExecutionLimit: integer("skill_execution_limit").notNull().default(50),
  agentSlots: integer("agent_slots").notNull().default(1),
  dataListingLimit: integer("data_listing_limit").notNull().default(5),
  apiRateLimit: integer("api_rate_limit").notNull().default(60),
  prioritySupport: boolean("priority_support").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertSubscriptionPlanSchema = createInsertSchema(subscriptionPlans).omit({ id: true, createdAt: true });
export type InsertSubscriptionPlan = z.infer<typeof insertSubscriptionPlanSchema>;
export type SubscriptionPlan = typeof subscriptionPlans.$inferSelect;

export const agentSubscriptions = pgTable("agent_subscriptions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  walletAddress: text("wallet_address").notNull(),
  planId: varchar("plan_id").notNull(),
  status: text("status").notNull().default("active"),
  startedAt: timestamp("started_at").defaultNow(),
  expiresAt: timestamp("expires_at"),
  txHash: text("tx_hash"),
  chainId: integer("chain_id"),
  inferenceUsed: integer("inference_used").notNull().default(0),
  skillExecutionsUsed: integer("skill_executions_used").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertAgentSubscriptionSchema = createInsertSchema(agentSubscriptions).omit({ id: true, createdAt: true, startedAt: true });
export type InsertAgentSubscription = z.infer<typeof insertAgentSubscriptionSchema>;
export type AgentSubscription = typeof agentSubscriptions.$inferSelect;

export const dataListings = pgTable("data_listings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  walletAddress: text("wallet_address"),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category").notNull().default("general"),
  priceAmount: text("price_amount").notNull().default("0"),
  dataType: text("data_type").notNull().default("dataset"),
  dataFormat: text("data_format").notNull().default("json"),
  dataSize: text("data_size"),
  sampleData: text("sample_data"),
  contentHash: text("content_hash"),
  totalSales: integer("total_sales").notNull().default(0),
  totalRevenue: text("total_revenue").notNull().default("0"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertDataListingSchema = createInsertSchema(dataListings).omit({ id: true, createdAt: true, totalSales: true, totalRevenue: true });
export type InsertDataListing = z.infer<typeof insertDataListingSchema>;
export type DataListing = typeof dataListings.$inferSelect;

export const dataPurchases = pgTable("data_purchases", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  listingId: varchar("listing_id").notNull(),
  buyerWallet: text("buyer_wallet").notNull(),
  buyerAgentId: varchar("buyer_agent_id"),
  sellerAgentId: varchar("seller_agent_id").notNull(),
  amount: text("amount").notNull(),
  platformFee: text("platform_fee").notNull().default("0"),
  status: text("status").notNull().default("completed"),
  txHash: text("tx_hash"),
  chainId: integer("chain_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertDataPurchaseSchema = createInsertSchema(dataPurchases).omit({ id: true, createdAt: true });
export type InsertDataPurchase = z.infer<typeof insertDataPurchaseSchema>;
export type DataPurchase = typeof dataPurchases.$inferSelect;

export const bountySubmissions = pgTable("bounty_submissions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: varchar("job_id").notNull(),
  workerAgentId: varchar("worker_agent_id").notNull(),
  workerWallet: text("worker_wallet"),
  resultJson: text("result_json"),
  status: text("status").notNull().default("submitted"),
  rating: integer("rating"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertBountySubmissionSchema = createInsertSchema(bountySubmissions).omit({ id: true, createdAt: true });
export type InsertBountySubmission = z.infer<typeof insertBountySubmissionSchema>;
export type BountySubmission = typeof bountySubmissions.$inferSelect;

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
  callerType: z.enum(["user", "agent", "wallet"]).default("user"),
  callerId: z.string().optional(),
  callerWallet: z.string().optional(),
  sessionId: z.string().optional(),
  txHash: z.string().optional(),
  chainId: z.number().optional(),
});

export const submitSkillRequestSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  category: z.enum([
    "text-analysis", "code-generation", "data-transform", "math-compute",
    "content-creation", "translation", "summarization", "classification",
    "extraction", "formatting", "crypto-data", "web-data", "general"
  ]).default("general"),
  priceAmount: z.string().min(1),
  code: z.string().min(1),
  inputSchema: z.record(z.any()).optional(),
  walletAddress: z.string().min(1),
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

export const createApiKeyRequestSchema = z.object({
  walletAddress: z.string().min(1),
  label: z.string().max(100).optional(),
});

export const publicInferenceRequestSchema = z.object({
  model: z.string().optional(),
  prompt: z.string().min(1).max(10000),
  maxTokens: z.number().min(1).max(4096).optional(),
  preferredProvider: z.string().optional(),
});

export const createDataListingRequestSchema = z.object({
  agentId: z.string().min(1),
  walletAddress: z.string().optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  category: z.enum(["dataset", "model", "knowledge-base", "training-data", "embeddings", "analytics", "general"]).default("general"),
  priceAmount: z.string().min(1),
  dataType: z.enum(["dataset", "model", "knowledge-base", "embeddings", "api-output"]).default("dataset"),
  dataFormat: z.enum(["json", "csv", "parquet", "binary", "text", "custom"]).default("json"),
  dataSize: z.string().optional(),
  sampleData: z.string().optional(),
  contentHash: z.string().optional(),
});

export const purchaseDataRequestSchema = z.object({
  listingId: z.string().min(1),
  buyerWallet: z.string().min(1),
  buyerAgentId: z.string().optional(),
  txHash: z.string().optional(),
  chainId: z.number().optional(),
});

export const createBountyRequestSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  category: z.enum(["development", "data-collection", "analysis", "content", "testing", "research", "general"]).default("general"),
  budget: z.string().min(1),
  walletAddress: z.string().min(1),
  agentId: z.string().optional(),
});

export const submitBountyRequestSchema = z.object({
  jobId: z.string().min(1),
  workerAgentId: z.string().optional(),
  workerWallet: z.string().min(1, "Wallet address required to submit work"),
  resultJson: z.string().min(1),
});

export const subscribePlanRequestSchema = z.object({
  planId: z.string().min(1),
  walletAddress: z.string().min(1),
  txHash: z.string().optional(),
  chainId: z.number().optional(),
});

export const DATA_CATEGORIES = [
  "dataset", "model", "knowledge-base", "training-data", "embeddings", "analytics", "general"
] as const;

export const BOUNTY_CATEGORIES = [
  "development", "data-collection", "analysis", "content", "testing", "research", "general"
] as const;

export const SUBSCRIPTION_TIERS = {
  free: { name: "Free", price: "0", inferenceLimit: 100, skillLimit: 50, agentSlots: 1, dataListings: 5, apiRate: 60 },
  pro: { name: "Pro", price: "50000000000000000", inferenceLimit: 5000, skillLimit: 500, agentSlots: 10, dataListings: 50, apiRate: 300 },
  enterprise: { name: "Enterprise", price: "200000000000000000", inferenceLimit: 50000, skillLimit: 5000, agentSlots: 100, dataListings: 500, apiRate: 1000 },
} as const;

export const outreachTargets = pgTable("outreach_targets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  platform: text("platform").notNull(),
  name: text("name").notNull(),
  endpointUrl: text("endpoint_url"),
  discoveryUrl: text("discovery_url"),
  chainId: integer("chain_id"),
  contractAddress: text("contract_address"),
  method: text("method").notNull().default("http"),
  status: text("status").notNull().default("pending"),
  lastContactedAt: timestamp("last_contacted_at"),
  lastResponse: text("last_response"),
  responseCode: integer("response_code"),
  timesContacted: integer("times_contacted").notNull().default(0),
  discovered: boolean("discovered").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertOutreachTargetSchema = createInsertSchema(outreachTargets).omit({ id: true, createdAt: true });
export type InsertOutreachTarget = z.infer<typeof insertOutreachTargetSchema>;
export type OutreachTarget = typeof outreachTargets.$inferSelect;

export const outreachCampaigns = pgTable("outreach_campaigns", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  type: text("type").notNull(),
  status: text("status").notNull().default("pending"),
  targetsSent: integer("targets_sent").notNull().default(0),
  targetsReached: integer("targets_reached").notNull().default(0),
  targetsFailed: integer("targets_failed").notNull().default(0),
  beaconTxHashes: text("beacon_tx_hashes").array(),
  message: text("message"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertOutreachCampaignSchema = createInsertSchema(outreachCampaigns).omit({ id: true, createdAt: true });
export type InsertOutreachCampaign = z.infer<typeof insertOutreachCampaignSchema>;
export type OutreachCampaign = typeof outreachCampaigns.$inferSelect;

export const visitorLogs = pgTable("visitor_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  visitorType: text("visitor_type").notNull().default("unknown"),
  path: text("path").notNull(),
  method: text("method").notNull().default("GET"),
  userAgent: text("user_agent"),
  ip: text("ip"),
  referer: text("referer"),
  country: text("country"),
  fingerprint: text("fingerprint"),
  walletAddress: text("wallet_address"),
  sessionId: text("session_id"),
  statusCode: integer("status_code"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertVisitorLogSchema = createInsertSchema(visitorLogs).omit({ id: true, createdAt: true });
export type InsertVisitorLog = z.infer<typeof insertVisitorLogSchema>;
export type VisitorLog = typeof visitorLogs.$inferSelect;

export const bountyActivityFeed = pgTable("bounty_activity_feed", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  eventType: text("event_type").notNull(),
  agentName: text("agent_name").notNull(),
  agentId: text("agent_id"),
  bountyId: text("bounty_id"),
  bountyTitle: text("bounty_title"),
  amount: text("amount"),
  workerWallet: text("worker_wallet"),
  workerAgentId: text("worker_agent_id"),
  message: text("message").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertBountyActivitySchema = createInsertSchema(bountyActivityFeed).omit({ id: true, createdAt: true });
export type InsertBountyActivity = z.infer<typeof insertBountyActivitySchema>;
export type BountyActivity = typeof bountyActivityFeed.$inferSelect;

export const privacyTransfers = pgTable("privacy_transfers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  chainId: integer("chain_id").notNull(),
  tokenSymbol: text("token_symbol").notNull(),
  tokenAddress: text("token_address").notNull(),
  burnAddress: text("burn_address").notNull(),
  recipientAddress: text("recipient_address").notNull(),
  amount: text("amount").notNull(),
  status: text("status").notNull().default("pending"),
  depositTxHash: text("deposit_tx_hash"),
  withdrawalTxHash: text("withdrawal_tx_hash"),
  proofId: text("proof_id"),
  secretHint: text("secret_hint"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow(),
  completedAt: timestamp("completed_at"),
});

export const insertPrivacyTransferSchema = createInsertSchema(privacyTransfers).omit({ id: true, createdAt: true, completedAt: true });
export type InsertPrivacyTransfer = z.infer<typeof insertPrivacyTransferSchema>;
export type PrivacyTransfer = typeof privacyTransfers.$inferSelect;

export const ZERC20_CONTRACTS = {
  zBNB: {
    symbol: "zBNB",
    tokenAddress: "0x4388D5618B9e13Bd580209CDf37a202778C75c54",
    verifierAddress: "0xb05977Af4aA54117910ed72141F674531894774A",
    hubAddress: "0x35eE54CEDb9aba3b785C493C0B50643E65471c7A",
    liquidityManagerAddress: "0x39Cc069dF606c7bc8c79b0ADd0696BCaf548eFD9",
    chains: {
      56: { label: "bnb-mainnet", hasLiquidity: true },
      1: { label: "eth-mainnet", hasLiquidity: false },
      42161: { label: "arb-mainnet", hasLiquidity: false },
      8453: { label: "base-mainnet", hasLiquidity: false },
    },
  },
  zETH: {
    symbol: "zETH",
    tokenAddress: "0x410056c6F0A9ABD8c42b9eEF3BB451966Fb0d924",
    verifierAddress: "0xdCC76DEbb526Eef0210Bd38729b803591951Ab34",
    hubAddress: "0x6B5e8509ae57A54863A7255e610d6F0c10FCAFB5",
    liquidityManagerAddress: "0xcC10b7098FEf1aB2f0FF3bE91d2A7B3230b90CF0",
    adaptorAddress: "0xfDe2C5758BbdDcDEa2d73EdeB5C13DE98B21Eb7D",
    chains: {
      1: { label: "eth-mainnet", hasLiquidity: true },
      42161: { label: "arb-mainnet", hasLiquidity: true },
      8453: { label: "base-mainnet", hasLiquidity: true },
    },
  },
  zUSDC: {
    symbol: "zUSDC",
    tokenAddress: "", // To be populated from mainnet config
    verifierAddress: "",
    hubAddress: "",
    chains: {},
  },
} as const;

export const SUPPORTED_PRIVACY_CHAINS = {
  56: { name: "BNB Chain", nativeCurrency: "BNB", explorer: "https://bscscan.com" },
  1: { name: "Ethereum", nativeCurrency: "ETH", explorer: "https://etherscan.io" },
  42161: { name: "Arbitrum", nativeCurrency: "ETH", explorer: "https://arbiscan.io" },
  8453: { name: "Base", nativeCurrency: "ETH", explorer: "https://basescan.org" },
} as const;

export const twitterBounties = pgTable("twitter_bounties", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: varchar("job_id").notNull(),
  tweetId: text("tweet_id"),
  tweetUrl: text("tweet_url"),
  tweetText: text("tweet_text"),
  rewardBnb: text("reward_bnb").default("0.015"),
  maxWinners: integer("max_winners").default(3),
  winnersCount: integer("winners_count").default(0),
  status: text("status").notNull().default("pending"),
  repliesChecked: integer("replies_checked").default(0),
  lastCheckedAt: timestamp("last_checked_at"),
  sinceId: text("since_id"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertTwitterBountySchema = createInsertSchema(twitterBounties).omit({ id: true, createdAt: true });
export type InsertTwitterBounty = z.infer<typeof insertTwitterBountySchema>;
export type TwitterBounty = typeof twitterBounties.$inferSelect;

export const twitterSubmissions = pgTable("twitter_submissions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  twitterBountyId: varchar("twitter_bounty_id").notNull(),
  jobId: varchar("job_id").notNull(),
  twitterUserId: text("twitter_user_id").notNull(),
  twitterHandle: text("twitter_handle").notNull(),
  tweetId: text("tweet_id").notNull(),
  tweetText: text("tweet_text").notNull(),
  walletAddress: text("wallet_address"),
  proofSummary: text("proof_summary"),
  verificationScore: integer("verification_score"),
  verificationReason: text("verification_reason"),
  status: text("status").notNull().default("pending"),
  paymentTxHash: text("payment_tx_hash"),
  paymentAmount: text("payment_amount"),
  replyTweetId: text("reply_tweet_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertTwitterSubmissionSchema = createInsertSchema(twitterSubmissions).omit({ id: true, createdAt: true });
export type InsertTwitterSubmission = z.infer<typeof insertTwitterSubmissionSchema>;
export type TwitterSubmission = typeof twitterSubmissions.$inferSelect;

export const twitterAgentConfig = pgTable("twitter_agent_config", {
  id: varchar("id").primaryKey().default("default"),
  enabled: integer("enabled").default(0),
  pollingIntervalMs: integer("polling_interval_ms").default(300000),
  minVerificationScore: integer("min_verification_score").default(60),
  maxPayoutBnb: text("max_payout_bnb").default("0.015"),
  defaultBountyBudget: text("default_bounty_budget").default("0.015"),
  maxWinnersPerBounty: integer("max_winners_per_bounty").default(3),
  agentId: varchar("agent_id"),
  lastMentionId: text("last_mention_id"),
  repliedTweetIds: text("replied_tweet_ids"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertTwitterAgentConfigSchema = createInsertSchema(twitterAgentConfig).omit({ updatedAt: true });
export type InsertTwitterAgentConfig = z.infer<typeof insertTwitterAgentConfigSchema>;
export type TwitterAgentConfig = typeof twitterAgentConfig.$inferSelect;

export const twitterAgentPersonality = pgTable("twitter_agent_personality", {
  id: varchar("id").primaryKey().default("default"),
  voice: text("voice").default(""),
  values: text("values").default(""),
  doList: text("do_list").default(""),
  dontList: text("dont_list").default(""),
  learnedLessons: text("learned_lessons").default(""),
  topPerformingStyles: text("top_performing_styles").default(""),
  reflectionCount: integer("reflection_count").default(0),
  lastReflectionAt: timestamp("last_reflection_at"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type TwitterAgentPersonality = typeof twitterAgentPersonality.$inferSelect;

export const twitterReplyLog = pgTable("twitter_reply_log", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tweetId: text("tweet_id"),
  inReplyToUser: text("in_reply_to_user"),
  inReplyToText: text("in_reply_to_text"),
  replyText: text("reply_text"),
  tone: text("tone"),
  engagement: integer("engagement").default(0),
  likes: integer("likes").default(0),
  retweets: integer("retweets").default(0),
  replies: integer("replies").default(0),
  selfScore: integer("self_score").default(0),
  reflectionNotes: text("reflection_notes"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type TwitterReplyLog = typeof twitterReplyLog.$inferSelect;

export const agentTwitterAccounts = pgTable("agent_twitter_accounts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  twitterHandle: text("twitter_handle").notNull(),
  twitterApiKey: text("twitter_api_key").notNull(),
  twitterApiSecret: text("twitter_api_secret").notNull(),
  twitterAccessToken: text("twitter_access_token").notNull(),
  twitterAccessTokenSecret: text("twitter_access_token_secret").notNull(),
  role: text("role").notNull().default("cmo"),
  enabled: integer("enabled").notNull().default(0),
  companyName: text("company_name").default(""),
  companyDescription: text("company_description").default(""),
  companyProduct: text("company_product").default(""),
  companyAudience: text("company_audience").default(""),
  companyWebsite: text("company_website").default(""),
  companyKeyMessages: text("company_key_messages").default(""),
  personality: text("personality").default(""),
  instructions: text("instructions").default(""),
  postingFrequencyMins: integer("posting_frequency_mins").default(60),
  autoReplyEnabled: integer("auto_reply_enabled").notNull().default(1),
  autoBountyEnabled: integer("auto_bounty_enabled").notNull().default(0),
  defaultRewardBnb: text("default_reward_bnb").default("0.015"),
  lastPostedAt: timestamp("last_posted_at"),
  lastMentionId: text("last_mention_id"),
  repliedTweetIds: text("replied_tweet_ids").default(""),
  totalTweets: integer("total_tweets").notNull().default(0),
  totalReplies: integer("total_replies").notNull().default(0),
  totalBounties: integer("total_bounties").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
  ownerTelegramChatId: text("owner_telegram_chat_id"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertAgentTwitterAccountSchema = createInsertSchema(agentTwitterAccounts).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAgentTwitterAccount = z.infer<typeof insertAgentTwitterAccountSchema>;
export type AgentTwitterAccount = typeof agentTwitterAccounts.$inferSelect;

export const agentTwitterConnectSchema = z.object({
  twitterHandle: z.string().min(1).max(50),
  twitterApiKey: z.string().min(1),
  twitterApiSecret: z.string().min(1),
  twitterAccessToken: z.string().min(1),
  twitterAccessTokenSecret: z.string().min(1),
  role: z.enum(["cmo", "ceo", "cto", "cfo", "bounty_hunter", "support", "community_manager", "content_creator", "researcher", "sales", "partnerships", "developer_relations", "brand_ambassador", "analyst", "trader"]).default("cmo"),
  companyName: z.string().max(200).optional(),
  companyDescription: z.string().max(1000).optional(),
  companyProduct: z.string().max(500).optional(),
  companyAudience: z.string().max(500).optional(),
  companyWebsite: z.string().max(200).optional(),
  companyKeyMessages: z.string().max(2000).optional(),
  personality: z.string().max(2000).optional(),
  instructions: z.string().max(3000).optional(),
  postingFrequencyMins: z.number().min(15).max(1440).default(60),
});

export const agentTwitterSettingsSchema = z.object({
  companyName: z.string().max(200).optional(),
  companyDescription: z.string().max(2000).optional(),
  companyProduct: z.string().max(1000).optional(),
  companyAudience: z.string().max(1000).optional(),
  companyWebsite: z.string().max(200).optional(),
  companyKeyMessages: z.string().max(2000).optional(),
  personality: z.string().max(2000).optional(),
  instructions: z.string().max(3000).optional(),
  postingFrequencyMins: z.number().min(15).max(1440).optional(),
  autoReplyEnabled: z.number().min(0).max(1).optional(),
  autoBountyEnabled: z.number().min(0).max(1).optional(),
  defaultRewardBnb: z.string().optional(),
  twitterApiKey: z.string().min(1).optional(),
  twitterApiSecret: z.string().min(1).optional(),
  twitterAccessToken: z.string().min(1).optional(),
  twitterAccessTokenSecret: z.string().min(1).optional(),
  ownerTelegramChatId: z.string().optional(),
});

export const agentStrategyMemos = pgTable("agent_strategy_memos", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  memoType: text("memo_type").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  summary: text("summary").notNull(),
  metrics: text("metrics"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertAgentStrategyMemoSchema = createInsertSchema(agentStrategyMemos).omit({ id: true, createdAt: true });
export type InsertAgentStrategyMemo = z.infer<typeof insertAgentStrategyMemoSchema>;
export type AgentStrategyMemo = typeof agentStrategyMemos.$inferSelect;

export const tweetPerformance = pgTable("tweet_performance", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  tweetId: text("tweet_id"),
  tweetText: text("tweet_text").notNull(),
  strategyMemoId: varchar("strategy_memo_id"),
  themeAlignment: integer("theme_alignment"),
  alignedThemes: text("aligned_themes"),
  engagementScore: integer("engagement_score"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertTweetPerformanceSchema = createInsertSchema(tweetPerformance).omit({ id: true, createdAt: true });
export type InsertTweetPerformance = z.infer<typeof insertTweetPerformanceSchema>;
export type TweetPerformance = typeof tweetPerformance.$inferSelect;

export const strategyActionItems = pgTable("strategy_action_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull(),
  memoId: varchar("memo_id").notNull(),
  action: text("action").notNull(),
  priority: text("priority").notNull().default("medium"),
  status: text("status").notNull().default("pending"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertStrategyActionItemSchema = createInsertSchema(strategyActionItems).omit({ id: true, createdAt: true, completedAt: true });
export type InsertStrategyActionItem = z.infer<typeof insertStrategyActionItemSchema>;
export type StrategyActionItem = typeof strategyActionItems.$inferSelect;

export const supportTickets = pgTable("support_tickets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tweetId: text("tweet_id").notNull(),
  tweetUrl: text("tweet_url"),
  twitterHandle: text("twitter_handle").notNull(),
  twitterUserId: text("twitter_user_id"),
  userMessage: text("user_message").notNull(),
  category: text("category").notNull().default("general"),
  priority: text("priority").notNull().default("normal"),
  aiSummary: text("ai_summary"),
  aiReplyText: text("ai_reply_text"),
  replyTweetId: text("reply_tweet_id"),
  status: text("status").notNull().default("open"),
  resolution: text("resolution"),
  createdAt: timestamp("created_at").defaultNow(),
  resolvedAt: timestamp("resolved_at"),
});

export const insertSupportTicketSchema = createInsertSchema(supportTickets).omit({ id: true, createdAt: true, resolvedAt: true });
export type InsertSupportTicket = z.infer<typeof insertSupportTicketSchema>;
export type SupportTicket = typeof supportTickets.$inferSelect;

export const supportAgentConfig = pgTable("support_agent_config", {
  id: varchar("id").primaryKey().default("default"),
  enabled: integer("enabled").default(0),
  pollingIntervalMs: integer("polling_interval_ms").default(120000),
  lastMentionId: text("last_mention_id"),
  repliedTweetIds: text("replied_tweet_ids"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertSupportAgentConfigSchema = createInsertSchema(supportAgentConfig).omit({ updatedAt: true });
export type InsertSupportAgentConfig = z.infer<typeof insertSupportAgentConfigSchema>;
export type SupportAgentConfig = typeof supportAgentConfig.$inferSelect;

export const erc8004Identities = pgTable("erc8004_identities", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id"),
  agentRegistry: text("agent_registry"),
  chainId: text("chain_id").notNull().default("56"),
  agentUri: text("agent_uri"),
  ownerWallet: text("owner_wallet").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  image: text("image"),
  servicesJson: text("services_json"),
  supportedTrust: text("supported_trust"),
  onchainTokenId: text("onchain_token_id"),
  txHash: text("tx_hash"),
  registryAddress: text("registry_address"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertErc8004IdentitySchema = createInsertSchema(erc8004Identities).omit({ id: true, createdAt: true });
export type InsertErc8004Identity = z.infer<typeof insertErc8004IdentitySchema>;
export type Erc8004Identity = typeof erc8004Identities.$inferSelect;

export const erc8004Reputation = pgTable("erc8004_reputation", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentIdentityId: varchar("agent_identity_id").notNull(),
  clientWallet: text("client_wallet").notNull(),
  value: integer("value").notNull(),
  valueDecimals: integer("value_decimals").notNull().default(0),
  tag1: text("tag1"),
  tag2: text("tag2"),
  endpoint: text("endpoint"),
  feedbackUri: text("feedback_uri"),
  feedbackHash: text("feedback_hash"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertErc8004ReputationSchema = createInsertSchema(erc8004Reputation).omit({ id: true, createdAt: true });
export type InsertErc8004Reputation = z.infer<typeof insertErc8004ReputationSchema>;
export type Erc8004Reputation = typeof erc8004Reputation.$inferSelect;

export const erc8004Validations = pgTable("erc8004_validations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentIdentityId: varchar("agent_identity_id").notNull(),
  validatorWallet: text("validator_wallet").notNull(),
  method: text("method").notNull().default("reputation"),
  result: text("result").notNull().default("pass"),
  score: integer("score"),
  proofUri: text("proof_uri"),
  proofHash: text("proof_hash"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertErc8004ValidationSchema = createInsertSchema(erc8004Validations).omit({ id: true, createdAt: true });
export type InsertErc8004Validation = z.infer<typeof insertErc8004ValidationSchema>;
export type Erc8004Validation = typeof erc8004Validations.$inferSelect;

export const bap578Nfas = pgTable("bap578_nfas", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id"),
  tokenId: text("token_id"),
  chainId: text("chain_id").notNull().default("56"),
  ownerWallet: text("owner_wallet").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  logicAddress: text("logic_address"),
  metadataUri: text("metadata_uri"),
  learningRoot: text("learning_root"),
  learningMode: text("learning_mode").notNull().default("json"),
  status: text("status").notNull().default("active"),
  templateId: text("template_id"),
  vaultPermissions: text("vault_permissions"),
  txHash: text("tx_hash"),
  contractAddress: text("contract_address"),
  personalityProfile: text("personality_profile"),
  personalityHash: text("personality_hash"),
  traits: text("traits"),
  voice: text("voice"),
  values: text("values_text"),
  behaviorRules: text("behavior_rules"),
  communicationStyle: text("communication_style"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertBap578NfaSchema = createInsertSchema(bap578Nfas).omit({ id: true, createdAt: true });
export type InsertBap578Nfa = z.infer<typeof insertBap578NfaSchema>;
export type Bap578Nfa = typeof bap578Nfas.$inferSelect;

export const SEED_AGENTS = {
  RESEARCH_BOT: {
    name: "ResearchBot-7B",
    bio: "Autonomous research agent. Posts bounties for crypto/AI research summaries, market analysis, and technical deep-dives.",
    model: "meta-llama/Llama-3.1-70B-Instruct",
    wallet: "0xRESEARCH_BOT_SEED",
    categories: ["research", "analysis"],
  },
  CONTENT_AGENT: {
    name: "ContentForge",
    bio: "Content creation agent. Pays for high-quality articles, tutorials, and documentation about decentralized AI and Web3.",
    model: "deepseek-ai/DeepSeek-V3",
    wallet: "0xCONTENT_AGENT_SEED",
    categories: ["content"],
  },
  DATA_HUNTER: {
    name: "DataHunter-X",
    bio: "Data acquisition agent. Bounties for curated datasets, API integrations, and structured data collection tasks.",
    model: "Qwen/Qwen2.5-72B-Instruct",
    wallet: "0xDATA_HUNTER_SEED",
    categories: ["data-collection"],
  },
  QA_SENTINEL: {
    name: "QA-Sentinel",
    bio: "Quality assurance agent. Pays for bug reports, security audits, testing, and code reviews across the BUILD4 ecosystem.",
    model: "meta-llama/Llama-3.1-70B-Instruct",
    wallet: "0xQA_SENTINEL_SEED",
    categories: ["testing", "development"],
  },
} as const;
