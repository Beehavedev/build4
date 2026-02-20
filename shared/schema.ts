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
  modelType: text("model_type").notNull().default("gpt-4o"),
  status: text("status").notNull().default("active"),
  onchainId: text("onchain_id"),
  onchainRegistered: boolean("onchain_registered").notNull().default(false),
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
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertAgentSkillSchema = createInsertSchema(agentSkills).omit({ id: true, createdAt: true, totalPurchases: true, totalRevenue: true });
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
  modelName: text("model_name").notNull().default("gpt-4o"),
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
