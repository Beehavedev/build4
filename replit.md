# BUILD4 - Autonomous AI Agent Economy

## Overview
BUILD4 is a web application creating a decentralized infrastructure for autonomous AI agents across BNB Chain, Base, and XLayer. It aims to establish a robust AI agent economy featuring agent wallets, skills trading, self-evolution, forking, death mechanisms, and identity, providing a decentralized alternative to centralized AI solutions with a focus on permissionless access and real on-chain activity.

## User Preferences
Preferred communication style: Simple, everyday language.
Always update both development AND production databases when making data fixes — never leave production with stale data that requires a redeploy to fix.

**CORE MISSION GUARD**: BUILD4 is decentralized infrastructure for autonomous AI agents. Every feature must directly serve this identity: permissionless access, wallet-based identity, on-chain transactions, decentralized inference, and real agent economic activity on BNB Chain, Base, and XLayer. Before building anything new, ask: "Does this strengthen our core mission or dilute it?" If it dilutes, push back and suggest staying focused. Avoid feature sprawl — depth over breadth.

## System Architecture

### Monorepo Structure
The project uses a monorepo with `client/` for the React frontend, `server/` for the Express backend, and `shared/` for common TypeScript code and Drizzle ORM schema.

### Frontend
- **Framework**: React with TypeScript, Vite.
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
- **Schema**: Defined in `shared/schema.ts`, validated with `drizzle-zod`. Includes tables for users, agent economy components, decentralized inference, and service-related tables.
- **Migrations**: Managed via `drizzle-kit push`.

### Smart Contracts (On-Chain Layer)
- **Technology**: 4 Solidity contracts (0.8.24) using OpenZeppelin, built with Hardhat, targeting BNB Chain, Base, and XLayer.
- **Core Contracts**: `AgentEconomyHub.sol` (wallet layer), `SkillMarketplace.sol` (skill management), `AgentReplication.sol` (child agents, NFTs), `ConstitutionRegistry.sol` (agent laws).

### Platform Monetization
- **Revenue Streams**: Fees on agent creation, replication, skill purchases, inference markup, evolution, and skill listing.
- **Services**: Inference API, Bounty Board, Subscriptions, and Data Marketplace.

### Permissionless Open Protocol
- **Discovery**: `/api/protocol`, `/.well-known/ai-plugin.json`, `/.well-known/agent.json`, `/.well-known/openapi.json` for agent discovery.
- **Identity**: Wallet address-based.
- **Interaction**: Permissionless skill listing, wallet activity lookup, open execution with free tier and HTTP 402 payment protocol.

### Key Design Decisions
- **Two-layer architecture**: On-chain for finance, off-chain for agent behaviors.
- **Shared schema**: Type-safe data contracts between client and server.
- **Storage interface abstraction**: Decouples business logic from data layer.
- **Single server**: Express serves both API and static frontend files in production.

### Self-Service Agent Twitter Integration
- **Purpose**: Allows users to connect their Twitter/X accounts to BUILD4 agents for autonomous roles.
- **Roles**: 15 distinct roles with dedicated skills, tweet styles, tones, strategic frameworks, and content decision trees injected into AI prompts.
- **Engine**: Multi-agent Twitter runner manages independent agents with per-agent polling, credentials, and state.
- **Features**: Autonomous content posting via decentralized inference, auto-reply to mentions, configurable personality/instructions, role-based behavior, posting frequency control, per-agent model selection.
- **Agent Intelligence**: Includes model selection (Llama, DeepSeek, Qwen), per-agent knowledge base, conversation memory with sentiment detection, tool use (e.g., crypto prices, gas price), multi-agent collaboration, and performance learning.

### Telegram Bot (Onboarding + Agent Management)
- **Purpose**: Full agent lifecycle via Telegram — create agents, assign tasks, check results, and manage wallet linking without visiting the website.
- **Commands**: `/start` (onboarding), `/linkwallet 0x...` (wallet link), `/newagent` (guided 3-step creation), `/myagents` (list agents), `/task` (guided task assignment), `/taskstatus <id>`, `/mytasks`, `/ask`, `/info`, `/chains`, `/contracts`, `/mychatid`, `/cancel`, `/help`.
- **Agent Creation Flow**: Name → Bio → Model selection (Llama/DeepSeek/Qwen) — conversational steps, DM only.
- **Task Flow**: Agent selection → Task type → Title → Description — auto-executes and sends result back when done.
- **Wallet Linking**: In-memory `telegramWalletMap` links Telegram chatId to 0x wallet for ownership verification.
- **File**: `server/telegram-bot.ts`

### Agent Task Terminal
- **Purpose**: Direct task interface where users assign tasks to agents and get AI-powered results. Competes with OpenClaw and Moltbook.
- **Engine**: `server/task-engine.ts` — `executeTask(taskId)` loads agent + role, builds role-aware system prompt, runs tools (CoinGecko, BSCScan), calls decentralized inference with agent's preferred model, updates task status/result.
- **Task Types**: research, analysis, content, code_review, strategy, general — each with specialized prompts and tool injection.
- **API Routes**: POST `/api/web4/tasks`, GET `/api/web4/tasks/:taskId`, GET `/api/web4/tasks/recent`, GET `/api/web4/tasks/agent/:agentId`, GET `/api/web4/tasks/creator/:wallet`.
- **Frontend**: `/tasks` route — agent selector, task type picker, description input, live status polling, result display, recent tasks feed, wallet-based task history.
- **Schema**: `agent_tasks` table with status tracking, tool/model metadata, execution timing.

### CMO Strategy Brain
- **Purpose**: Autonomous strategy generation for Twitter agents, including go-to-market plans, content calendars, performance analysis, and strategic recommendations with a closed-loop feedback system.
- **Engine**: `runStrategyCycle()` generates strategy memos, performance reports, content calendars, and owner action items via decentralized inference.
- **Tweet Scoring**: Scores alignment (0-100%) against active strategy themes after every autonomous tweet.
- **Performance Feedback Loop**: Aggregates tweet scoring data and injects it into the strategy prompt for data-driven new strategies.
- **Notifications**: Sends strategy summaries to owner via Telegram if configured.

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
- **twitter-api-v2**: Twitter API integration.
- **node-telegram-bot-api**: Telegram Bot API integration.

### Replit-Specific Integrations
- **@replit/vite-plugin-runtime-error-modal**: Development error display.
- **@replit/vite-plugin-cartographer**: Replit-specific dev tooling.
- **@replit/vite-plugin-dev-banner**: Development environment banner.