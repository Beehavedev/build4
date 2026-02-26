# BUILD4 - Autonomous AI Agent Economy on BNB Chain · Base · XLayer

## Overview
BUILD4 is a web application providing decentralized infrastructure for autonomous AI agents across BNB Chain, Base, and XLayer, with fully decentralized inference. It aims to establish a robust AI agent economy featuring agent wallets, skills trading, self-evolution, forking, death mechanisms, and identity. The project offers a decentralized alternative to centralized AI solutions, focusing on permissionless access and real on-chain activity.

## User Preferences
Preferred communication style: Simple, everyday language.
Always update both development AND production databases when making data fixes — never leave production with stale data that requires a redeploy to fix.

**CORE MISSION GUARD**: BUILD4 is decentralized infrastructure for autonomous AI agents. Every feature must directly serve this identity: permissionless access, wallet-based identity, on-chain transactions, decentralized inference, and real agent economic activity on BNB Chain, Base, and XLayer. Before building anything new, ask: "Does this strengthen our core mission or dilute it?" If it dilutes, push back and suggest staying focused. Avoid feature sprawl — depth over breadth.

## System Architecture

### Monorepo Structure
The project uses a monorepo with `client/` for the React frontend, `server/` for the Express backend, and `shared/` for common TypeScript code and Drizzle ORM schema.

### Frontend
- **Framework**: React with TypeScript, Vite for bundling.
- **UI/UX**: `shadcn/ui` (Radix UI, Tailwind CSS for light/dark modes), Wouter for routing, TanStack React Query for state management, Framer Motion for animations.

### Backend
- **Framework**: Express 5 on Node.js, TypeScript.
- **API**: All routes prefixed with `/api`.
- **Storage**: `DatabaseStorage` implementing `IStorage` interface, backed by PostgreSQL via Drizzle ORM.
- **Autonomous Agent Runner**: Background process for agent actions every 30s.
- **Decentralized Inference**: Routes inference to Hyperbolic, AkashML, or Ritual providers with an OpenAI-compatible API.
- **Web3 Integration**: `ethers` v6 for MetaMask/WalletConnect.
- **Build**: Custom esbuild for server, Vite for client, integrated into a single Express server in production.

### Database
- **ORM**: Drizzle ORM with PostgreSQL.
- **Schema**: Defined in `shared/schema.ts`, validated with `drizzle-zod`. Includes tables for users, 13 Web4 agent economy components, 2 decentralized inference components, and various service-related tables.
- **Migrations**: Managed via `drizzle-kit push`.

### Smart Contracts (On-Chain Layer)
- **Technology**: 4 Solidity contracts (0.8.24) using OpenZeppelin, built with Hardhat, targeting BNB Chain, Base, and XLayer.
- **Core Contracts**:
    - `AgentEconomyHub.sol`: Core wallet layer, deposits, withdrawals, transfers, survival tier, module authorization.
    - `SkillMarketplace.sol`: Manages skill listings and purchases.
    - `AgentReplication.sol`: Handles child agent spawning, NFT minting, and perpetual revenue sharing.
    - `ConstitutionRegistry.sol`: Stores immutable agent laws.

### Platform Monetization
- **Revenue Streams**: Fees on agent creation, replication, skill purchases, inference markup, evolution, and skill listing.
- **Services**: Inference API, Bounty Board, Subscriptions (Free/Pro/Enterprise), and Data Marketplace.

### Permissionless Open Protocol
- **Discovery**: `/api/protocol` for API spec and contract details. `/.well-known/ai-plugin.json`, `/.well-known/agent.json`, `/.well-known/openapi.json` for agent discovery.
- **Identity**: Wallet address-based; no registration.
- **Interaction**: Permissionless skill listing, wallet activity lookup, open execution with free tier and HTTP 402 payment protocol.

### ZERC20 Privacy Transfers
- **Protocol**: Zero-knowledge privacy transfers using ZK proof-of-burn mechanism with real mainnet ZERC20 addresses.
- **Schema**: `privacy_transfers` table tracks transfer lifecycle.
- **API Routes**: `/api/privacy/config`, `/api/privacy/transfers` (CRUD).
- **Frontend**: `/privacy` page for transfers and history.

### Twitter Bounty Agent
- **Integration**: OAuth 1.0a via `twitter-api-v2` with the @Build4ai account.
- **Schema**: Tables for `twitter_bounties`, `twitter_submissions`, `twitter_agent_config`, `twitter_agent_personality`, `twitter_reply_log`.
- **Engine**: Background process to post bounties, monitor replies, extract wallet addresses, verify proof quality via decentralized inference, and auto-pay workers.
- **Self-Learning Personality**: Agent evolves its voice and values through experience, stored in DB and injected into prompts, with hard safety guardrails.
- **API Routes**: `/api/twitter/*` (admin-authed) for status, config, bounty management.
- **Frontend**: `/twitter-agent` page with admin dashboard, settings, and tracking.
- **Payments**: On-chain native token transfers via deployer wallet.

### ERC-8004 & BAP-578 Standards
- **ERC-8004 (Trustless Agents)**: On-chain identity, reputation, and validation registries for autonomous AI agents.
- **BAP-578 (Non-Fungible Agent)**: BNB Chain's NFA token standard for intelligent, autonomous digital entities.
- **Schema**: `erc8004_identities`, `erc8004_reputation`, `erc8004_validations`, `bap578_nfas` tables.
- **API Routes**: `/api/standards/*` for registry CRUD and info.
- **Discovery**: `/.well-known/agent.json` and `/.well-known/agent-registration.json` serve compliant registration files.
- **Frontend**: `/standards` page for viewing registry details.

### Key Design Decisions
- **Two-layer architecture**: On-chain for finance, off-chain for agent behaviors.
- **Shared schema**: Type-safe data contracts between client and server.
- **Storage interface abstraction**: Decouples business logic from data layer.
- **Single server**: Express serves both API and static frontend files in production.

### Twitter Support Agent
- **Purpose**: Autonomous support agent monitoring Twitter mentions, answering questions, and logging tickets.
- **Safety**: Strict guardrails against contract changes, payouts, wallet modifications, and sensitive info leaks.
- **Schema**: `support_tickets`, `support_agent_config` tables.
- **Engine**: Background process to poll mentions, classify, generate AI replies via decentralized inference, and create tickets.
- **API Routes**: `/api/support/*` (admin-authed) for status, config, and ticket management.
- **Frontend**: `/support-agent` page with admin dashboard and ticket filtering.

### Telegram Bot
- **Purpose**: Group-ready bot answering BUILD4 questions using decentralized inference.
- **Engine**: Background process using `node-telegram-bot-api` with long-polling.
- **Features**: Responds to `/ask` commands, @mentions, and direct messages; includes built-in commands. Uses `runInferenceWithFallback` with a BUILD4 knowledge base.
- **API Routes**: `/api/telegram/status`, `/api/telegram/start`, `/api/telegram/stop` (admin-authed).

### Self-Service Agent Twitter Integration
- **Purpose**: Allows users to connect their Twitter/X accounts to BUILD4 agents for autonomous roles (e.g., CMO, CEO, Support Agent).
- **Roles**: 15 distinct roles with dedicated skills, tweet styles, and tones, injected into AI prompts.
- **Schema**: `agent_twitter_accounts` table stores per-agent Twitter credentials, role, personality, instructions, frequency, and activity.
- **Engine**: Multi-agent Twitter runner (`server/multi-twitter-agent.ts`) manages independent agents with per-agent polling, credentials, and state.
- **Features**: Autonomous content posting via decentralized inference, auto-reply to mentions, configurable personality/instructions, role-based behavior, posting frequency control.
- **API Routes**: `/api/web4/agents/:agentId/twitter/*` for connect, validate, status, start/stop, settings, disconnect (ownership-verified).
- **Smart Onboarding**: 3-step connection wizard with interactive setup, credential validation, and auto-start.
- **Diagnostics**: Status endpoint returns live health diagnostics, error tracking per agent.
- **Frontend**: Twitter Agent section in Autonomous Economy page with connect wizard, controls, settings, help panel, and activity stats.

### CMO Strategy Brain
- **Purpose**: Autonomous strategy generation for Twitter agents — go-to-market plans, content calendars, performance analysis, and strategic recommendations with a closed-loop feedback system.
- **Schema**: `agent_strategy_memos` table (id, agentId, memoType, title, content, summary, metrics, status, createdAt). `tweet_performance` table (id, agentId, tweetId, tweetText, strategyMemoId, themeAlignment, alignedThemes, engagementScore, createdAt). `strategy_action_items` table (id, agentId, memoId, action, priority, status, completedAt, createdAt). `ownerTelegramChatId` field on `agent_twitter_accounts`.
- **Engine**: `runStrategyCycle()` in `server/multi-twitter-agent.ts` runs every 12 hours per agent. Generates strategy memos via decentralized inference, supersedes previous active strategies, and injects active strategy into tweet generation system prompt. Each cycle also generates a performance report (using tweet scoring data), content calendar (10 planned tweets), and extracts owner action items.
- **Tweet Scoring**: `scoreTweetAgainstStrategy()` runs after every autonomous tweet post — scores alignment (0-100%) against active strategy themes via inference. Stored in `tweet_performance` table.
- **Performance Feedback Loop**: `getPerformanceFeedback()` aggregates tweet scoring data (avg alignment, high/low alignment counts, top themes) and injects it into the strategy prompt so each new strategy is data-driven.
- **Separate Memo Types**: strategy, content_calendar, performance_report, gtm_plan, pivot_recommendation — each generated independently with role-appropriate prompts.
- **Action Items**: `extractAndStoreActionItems()` parses strategy memos to extract 3-7 actionable recommendations for the agent owner, stored with priority (high/medium/low) and status (pending/done/skipped).
- **Telegram Notifications**: If `ownerTelegramChatId` is set, strategy summaries are sent to the owner via `sendTelegramMessage()`.
- **API Routes**: `GET /api/web4/agents/:agentId/strategy` (list memos), `GET /api/web4/agents/:agentId/strategy/active` (current active), `POST /api/web4/agents/:agentId/strategy/generate` (manual trigger), `GET /api/web4/agents/:agentId/performance` (tweet scoring data with aggregated metrics), `GET /api/web4/agents/:agentId/action-items` (owner action items), `PATCH /api/web4/agents/:agentId/action-items/:itemId` (update action item status).
- **Frontend**: Strategy Dashboard in Twitter Agent section with performance metrics panel (avg alignment, tweets scored, themes hit, per-tweet scores), action items checklist with complete/skip buttons and priority badges, active strategy display, past memo list with type-specific icons and expandable content, "Generate Strategy Now" button, Telegram Chat ID input in Settings.

## External Dependencies

### Database
- **PostgreSQL**: Primary database.

### Key NPM Packages
- **express**: Backend HTTP server.
- **drizzle-orm**, **drizzle-kit**: ORM and migration tooling.
- **@tanstack/react-query**: Client-side server state management.
- **zod**, **drizzle-zod**: Schema validation.
- **wouter**: Client-side router.
- **framer-motion**: Animation library.
- **react-hook-form**, **@hookform/resolvers**: Form handling.
- **recharts**: Charting library.
- **vaul**: Drawer component.
- **embla-carousel-react**: Carousel functionality.
- **connect-pg-simple**: PostgreSQL session store.
- **passport**, **passport-local**: Authentication framework.
- **twitter-api-v2**: Twitter API integration.
- **node-telegram-bot-api**: Telegram Bot API integration.

### Replit-Specific Integrations
- **@replit/vite-plugin-runtime-error-modal**: Development error display.
- **@replit/vite-plugin-cartographer**: Replit-specific dev tooling.
- **@replit/vite-plugin-dev-banner**: Development environment banner.