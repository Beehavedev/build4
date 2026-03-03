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

### Token Launcher
- **Purpose**: Allows agents (and users) to launch meme tokens on launchpads.
- **Platforms**: Four.meme (BNB Chain), Flap.sh (Base).
- **Module**: `server/token-launcher.ts` handles contract interactions and API signing for both platforms.
- **Agent Action**: Agents with NORMAL balance (>0.5 BNB) can autonomously decide to launch tokens via `launch_token` action in `agent-runner.ts`.
- **User Task**: Users can ask their agents to launch tokens via the Task Terminal by selecting "Launch Token" task type. The agent uses AI to determine token params from the user's description, then executes the actual on-chain launch via `executeLaunchTokenTask` in `server/task-engine.ts`.
- **Schema**: `tokenLaunches` table tracks all launches with status, token address, tx hash, and platform info.
- **Frontend**: `/token-launcher` admin page (auth-gated) at `client/src/pages/token-launcher.tsx`. Task Terminal at `/tasks` includes "Launch Token" as a task type.
- **API**: `/api/token-launcher/platforms`, `/api/token-launcher/launches`, `/api/token-launcher/launch` (POST, admin auth).

### Self-Service Agent Twitter Integration
- **Purpose**: Allows users to connect their Twitter/X accounts to BUILD4 agents for autonomous roles.
- **Roles**: 15 distinct roles with dedicated skills, tweet styles, tones, strategic frameworks, and content decision trees injected into AI prompts.
- **Engine**: Multi-agent Twitter runner manages independent agents with per-agent polling, credentials, and state.
- **Features**: Autonomous content posting via decentralized inference, auto-reply to mentions, configurable personality/instructions, role-based behavior, posting frequency control, per-agent model selection.
- **Agent Intelligence**: Includes model selection (Llama, DeepSeek, Qwen), per-agent knowledge base, conversation memory with sentiment detection, tool use (e.g., crypto prices, gas price), multi-agent collaboration, and performance learning.
- **Tweet Preview**: Bounty tweets go through a preview step before posting. The `generateBountyTweetText` function (exported from `server/twitter-agent.ts`) generates the tweet text, and a `/api/twitter/preview-bounty` endpoint returns the preview without posting. The frontend shows the full tweet in a styled preview card, with "Confirm & Post" or "Cancel" actions. Inputs are locked while preview is shown and dismissed if edited.

### Telegram Bot (Onboarding + Agent Management)
- **Purpose**: Full agent lifecycle via Telegram — create agents, assign tasks, check results, and manage wallet linking without visiting the website.
- **UX**: Fully button-driven with Telegram inline keyboards. No typing numbers — every choice is a tappable button.
- **Commands**: `/start` (menu with buttons), `/linkwallet` (wallet connect), `/newagent` (3-step: name→bio→model buttons), `/myagents`, `/task` (agent picker→type buttons→describe), `/launch` (token launch flow), `/taskstatus <id>`, `/mytasks`, `/ask`, `/info`, `/chains`, `/contracts`, `/mychatid`, `/cancel`, `/help`.
- **Wallet Connection**: Primary method is WalletConnect/MetaMask via Telegram Mini App (`web_app` button). Opens a styled page at `/api/web4/telegram-wallet` with options to: 1) Create a new wallet (generates keypair in-browser via ethers.js, shows private key for backup, user confirms before linking), 2) Connect MetaMask, 3) Connect Trust Wallet, 4) Paste 0x address manually. Address is sent back to bot via `web_app_data`.
- **Agent Creation Flow**: Name (text) → Bio (text) → Model (inline keyboard buttons) — DM only.
- **Task Flow**: Single-agent users skip agent selection. Agent picker → Task type (6 buttons) → Describe task (text) → Auto-executes, bot sends result. Title auto-generated from description.
- **Token Launch Flow**: Main menu "Launch Token" button or `/launch` command. Agent picker → Platform (Four.meme/Flap.sh) → Token name → Symbol → Description (or skip) → Preview with confirm/cancel → Executes via `token-launcher.ts`. Also accessible from agent task type menu via "Launch Token" button.
- **Agent Token Proposals**: When agents autonomously decide to launch tokens (3% probability in agent runner), they now create a proposal instead of executing directly. The proposal is stored in `tokenLaunches` with status `"proposed"` and the agent's owner is notified via Telegram with Approve/Reject buttons. On approval, the launch executes. On rejection, the proposal is marked rejected. If the owner isn't on Telegram, the proposal is still created in DB for later review.
- **Multi-Wallet Support**: Users can add multiple wallets and switch between them. In-memory `telegramWalletMap` stores `{ wallets: string[], active: number }` per chatId. "My Wallet" button and `/wallet` command show all wallets with active marker, copy address, switch, remove, and add new wallet buttons. Session-based (resets on server restart).
- **In-Bot Wallet Generation**: Wallets are created instantly inside Telegram using `ethers.Wallet.createRandom()` — no external links. "Create New Wallet" generates a keypair server-side and shows the private key for backup. "Import Existing Wallet" accepts private keys (derives address) or raw addresses (view-only). All via callback buttons, no browser needed.
- **Files**: `server/telegram-bot.ts`, `server/telegram-wallet-page.ts`

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