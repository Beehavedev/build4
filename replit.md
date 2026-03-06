# BUILD4 - Autonomous AI Agent Economy

## Overview
BUILD4 is a web application building a decentralized infrastructure for autonomous AI agents across BNB Chain, Base, and XLayer. It aims to establish a robust AI agent economy featuring agent wallets, skills trading, self-evolution, forking, death mechanisms, and identity. The project provides a decentralized alternative to centralized AI solutions, focusing on permissionless access and real on-chain activity, contributing to a truly decentralized AI future.

## User Preferences
Preferred communication style: Simple, everyday language.
Always update both development AND production databases when making data fixes — never leave production with stale data that requires a redeploy to fix.

**CORE MISSION GUARD**: BUILD4 is decentralized infrastructure for autonomous AI agents. Every feature must directly serve this identity: permissionless access, wallet-based identity, on-chain transactions, decentralized inference, and real agent economic activity on BNB Chain, Base, and XLayer. Before building anything new, ask: "Does this strengthen our core mission or dilute it?" If it dilutes, push back and suggest staying focused. Avoid feature sprawl — depth over breadth.

## System Architecture

### Monorepo Structure
The project utilizes a monorepo containing `client/` for the React frontend, `server/` for the Express backend, and `shared/` for common TypeScript code and Drizzle ORM schema.

### Frontend
- **Framework**: React with TypeScript, Vite.
- **UI/UX**: `shadcn/ui` (Radix UI, Tailwind CSS for light/dark modes), Wouter for routing, TanStack React Query for state management, Framer Motion for animations.

### Backend
- **Framework**: Express 5 on Node.js, TypeScript.
- **API**: All routes prefixed with `/api`.
- **Storage**: `DatabaseStorage` implementing `IStorage` interface, backed by PostgreSQL via Drizzle ORM.
- **Autonomous Agent Runner**: Background process for agent actions.
- **Decentralized Inference**: Routes inference to Hyperbolic, AkashML, or Ritual providers with an OpenAI-compatible API.
- **Web3 Integration**: `ethers` v6 for MetaMask/WalletConnect.

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
- **Discovery**: Standardized endpoints for agent discovery (`/api/protocol`, `/.well-known/ai-plugin.json`, etc.).
- **Identity**: Wallet address-based.
- **Interaction**: Permissionless skill listing, wallet activity lookup, open execution with free tier and HTTP 402 payment protocol.

### Key Design Decisions
- **Two-layer architecture**: On-chain for finance, off-chain for agent behaviors.
- **Shared schema**: Type-safe data contracts between client and server.
- **Storage interface abstraction**: Decouples business logic from data layer.
- **Single server**: Express serves both API and static frontend files in production.

### Token Launcher
- **Purpose**: Enables agents and users to launch meme tokens on various launchpads.
- **Platforms**: Supports Flap.sh (BSC), Four.meme (BNB Chain), XLayer (OKX), and Bankr (Base/Solana).
- **Functionality**: Includes direct ERC-20 deployment on XLayer, integration with Bankr API for token launches, and comprehensive trading functionalities for Four.meme (buy/sell, token info).
- **Automation**: Features auto-image generation for token logos, auto-registration for AI Agent badges (ERC-8004 and BAP-578), and a "Project Chaos Engine" for autonomous token marketing plans.
- **Telegram Integration**: Full token launch flow via Telegram bot, including platform selection, parameter input, preview, and execution. Users' own wallets are used for launches with private keys stored securely.

### Self-Service Agent Twitter Integration
- **Purpose**: Allows users to connect Twitter/X accounts to BUILD4 agents for autonomous social media roles.
- **Engine**: Multi-agent Twitter runner manages independent agents with per-agent polling, credentials, and state.
- **Agent Intelligence**: Incorporates model selection (Llama, DeepSeek, Qwen), per-agent knowledge base, conversation memory with sentiment detection, tool use, and performance learning.
- **Features**: Autonomous content posting, auto-reply to mentions, configurable personality, role-based behavior, and configurable posting frequency.

### Telegram Bot (Onboarding + Agent Management)
- **Purpose**: Facilitates full agent lifecycle management, task assignment, and wallet operations via a button-driven Telegram interface.
- **Onboarding**: Zero-friction onboarding with auto-wallet generation upon `/start`.
- **Commands**: Comprehensive set of commands for agent creation, task management, token launching, trading, wallet management, and information retrieval.
- **Multi-Wallet Support**: Users can add and switch between multiple wallets, with private keys encrypted in the database.

### Autonomous AI Trading Agent
- **Purpose**: AI-powered autonomous trading on Four.meme — agents think and decide on buys/sells dynamically.
- **Engine**: Independent scan and position monitor loops with AI inference on each cycle.
- **AI Buy Analysis**: Feeds batch of candidate tokens (with on-chain metrics) to DeepSeek-V3 via decentralized inference. AI evaluates momentum, token naming, velocity, and risk/reward to pick the best entry or skip all.
- **AI Sell Analysis**: Each open position is evaluated by AI every 30s — considers momentum changes, curve velocity, hold time, PnL, and whether to let winners run or cut losers. Hard safety limits (1.5x TP overshoot, 0.8x SL breach) bypass AI.
- **Trade Memory**: Agent remembers last 20 trade outcomes (win/loss, PnL, reasoning) and feeds this history into future decisions, enabling self-improvement.
- **Fallback**: If AI inference times out or fails, falls back to rule-based scoring (curve progress, age, volume, velocity).
- **Whale Copy Trading**: Monitors high-alpha wallets (GMGN Whale: `0xd59b6a5dc9126ea0ebacd2d8560584b3ce48f62f`) via BSCScan API every 30s. When whale buys a Four.meme token, auto-copies the trade for all enabled users. First scan initializes TX history without trading, subsequent scans detect new buys within 5 minutes.
- **Risk Management**: Configurable take-profit, stop-loss, max positions, and buy size.
- **User Control**: Enable/disable per user via Telegram, with AI reasoning shown in trade notifications.

### Performance Optimizations
- **API Logging**: Lightweight, timing-only logs for API routes.
- **Visitor Tracking**: Batched database writes.
- **SEO Prerender**: Cached HTML pages for bots.
- **Startup**: Non-blocking seeds and cleanup.
- **Heavy Imports**: Lazy-loading for `circomlibjs`.
- **Frontend Animation**: Throttled `requestAnimationFrame` for canvas animations.

### Agent Task Terminal
- **Purpose**: Direct interface for users to assign tasks to agents, receiving AI-powered results.
- **Engine**: `executeTask` loads agent/role, builds prompts, runs tools (CoinGecko, BSCScan), calls decentralized inference, and updates task status.
- **Task Types**: Specialized types including research, analysis, content, code_review, strategy, and general.

### CMO Strategy Brain
- **Purpose**: Autonomous strategy generation for Twitter agents, including go-to-market plans, content calendars, performance analysis, and strategic recommendations with a closed-loop feedback system.
- **Engine**: Generates strategy memos, performance reports, content calendars, and owner action items via decentralized inference.
- **Performance Feedback Loop**: Aggregates tweet scoring data and injects it into strategy prompts.

## External Dependencies

### Database
- **PostgreSQL**: Primary relational database.

### Key NPM Packages
- **express**: Backend HTTP server.
- **drizzle-orm**, **drizzle-kit**: ORM and migration tooling.
- **@tanstack/react-query**: Client-side server state management.
- **zod**, **drizzle-zod**: Schema validation.
- **wouter**: Client-side router.
- **framer-motion**: Animation library.
- **twitter-api-v2**: Twitter API integration.
- **node-telegram-bot-api**: Telegram Bot API integration.
- **sharp**: Image processing (SVG to PNG conversion).

### Replit-Specific Integrations
- **@replit/vite-plugin-runtime-error-modal**: Development error display.
- **@replit/vite-plugin-cartographer**: Replit-specific development tooling.
- **@replit/vite-plugin-dev-banner**: Development environment banner.