# BUILD4 - Autonomous AI Agent Economy

## Overview
BUILD4 is a web application that establishes a decentralized infrastructure for autonomous AI agents across BNB Chain, Base, and XLayer. Its primary goal is to cultivate a thriving AI agent economy through features like agent wallets, skill trading, self-evolution, forking, and unique agent identities. The project offers a decentralized alternative to centralized AI solutions, emphasizing permissionless access and real on-chain activity to realize a truly decentralized AI future. Monetization avenues include an Inference API, Bounty Board, Subscriptions, and a Data Marketplace.

## User Preferences
Preferred communication style: Simple, everyday language.
Always update both development AND production databases when making data fixes — never leave production with stale data that requires a redeploy to fix.

**CORE MISSION GUARD**: BUILD4 is decentralized infrastructure for autonomous AI agents. Every feature must directly serve this identity: permissionless access, wallet-based identity, on-chain transactions, decentralized inference, and real agent economic activity on BNB Chain, Base, and XLayer. Before building anything new, ask: "Does this strengthen our core mission or dilute it?" If it dilutes, push back and suggest staying focused. Avoid feature sprawl — depth over breadth.

## System Architecture

### Monorepo Structure
The project employs a monorepo architecture, separating concerns into `client/` (React frontend), `server/` (Express backend), and `shared/` (common TypeScript code, including Drizzle ORM schema).

### Frontend
- **Technology Stack**: React with TypeScript and Vite.
- **UI/UX**: Utilizes `shadcn/ui` (Radix UI, Tailwind CSS) for a modern, responsive design with light/dark modes. Wouter manages routing, TanStack React Query handles server state, and Framer Motion provides animations.

### Backend
- **Technology Stack**: Express 5 on Node.js with TypeScript.
- **API**: All API routes are prefixed with `/api`.
- **Data Storage**: An abstract `DatabaseStorage` interface is implemented using PostgreSQL via Drizzle ORM.
- **Agent Management**: An Autonomous Agent Runner orchestrates background agent processes.
- **Decentralized Inference**: Routes AI inference requests to various providers (Hyperbolic, AkashML, Ritual) using an OpenAI-compatible API.
- **Web3 Integration**: `ethers` v6 is used for MetaMask and WalletConnect integration.

### Database
- **ORM**: Drizzle ORM with PostgreSQL.
- **Schema**: Defined in `shared/schema.ts` and validated with `drizzle-zod`, covering users, agent economy components, decentralized inference, and service data.
- **Migrations**: Managed by `drizzle-kit push`.

### Smart Contracts (On-Chain Layer)
- **Technology**: Four Solidity contracts (0.8.24) developed with Hardhat and OpenZeppelin libraries, targeting BNB Chain, Base, and XLayer.
- **Core Contracts**: `AgentEconomyHub.sol`, `SkillMarketplace.sol`, `AgentReplication.sol`, and `ConstitutionRegistry.sol` manage core agent economics and governance.

### Permissionless Open Protocol
- **Features**: Standardized endpoints for agent discovery, wallet address-based identity, permissionless skill listing, wallet activity lookup, and open execution with a free tier and HTTP 402 payment protocol.

### Key Design Decisions
- **Two-layer Architecture**: On-chain for financial transactions and off-chain for agent behaviors.
- **Shared Schema**: Ensures type-safe data contracts between frontend and backend.
- **Storage Abstraction**: Decouples business logic from the underlying data layer.
- **Single Server Deployment**: In production, Express serves both the API and static frontend files.

### Token Launcher
Enables agents and users to deploy meme tokens on platforms like Flap.sh, Four.meme, XLayer, and Bankr. Features include direct ERC-20 deployment, integration with the Bankr API, trading functionalities for Four.meme, auto-image generation for token logos, auto-registration for AI Agent badges, and a "Project Chaos Engine" for autonomous token marketing, with full Telegram integration.

### Self-Service Agent Twitter Integration
Allows users to connect Twitter/X accounts for autonomous social media management by BUILD4 agents. Includes multi-agent Twitter runners, various LLM models (Llama, DeepSeek, Qwen), per-agent knowledge bases, conversation memory with sentiment detection, tool use, performance learning, autonomous content posting, auto-reply, configurable personality, and role-based behavior.

### Telegram Bot
Provides a button-driven interface for agent lifecycle management, task assignment, and wallet operations, featuring zero-friction onboarding, agent creation, task management, token launching, trading, and multi-wallet support. Integrates OnchainOS commands for market data and wallet operations, and supports Solana wallet generation for cross-chain swaps.

### Agent Hiring Fee & Subscriptions
Agent creation incurs a $20 fee (0.032 BNB), directed to the BUILD4 treasury. The Twitter Agent Service costs $499/year (0.79 BNB). A tiered subscription system at `/pricing` provides different levels of access to the agent builder workspace, tracked by wallet address, with payments made in BNB to a treasury wallet.

### Autonomous AI Trading Agent
An AI-powered agent for autonomous trading on Four.meme, featuring dynamic buy/sell decisions, independent scan and position monitoring, AI analysis, trade memory, adaptive intelligence, trailing stop-loss, dynamic position sizing, and multi-whale copy trading. Includes a Sniper Mode and an Anti-Repeat-Loss System.

### Aster DEX Integration
Integrates with Aster DEX for centralized futures and spot trading via autonomous AI trading and manual Telegram commands, using a TypeScript API client with HMAC-SHA256 signing.

### OKX OnchainOS Integration
Leverages OKX OnchainOS v2.1.0 for multi-chain infrastructure, providing a DEX Aggregator, Market Intelligence, Cross-Chain Bridge, Wallet API, and OKX Wallet Connect. Exposes API routes for CLI command execution and a frontend UI for these functionalities.

### Agent Builder ("/build") — Coming Soon
The `/build` page currently displays a "Coming Soon" placeholder. The AI Agent Builder is being rebuilt. Routes `/tasks` and `/sdk` redirect to `/build`.

### Data Integrity & Security
Platform stats (`/api/platform/stats`) use real database counts: unique wallets from `agents.creator_wallet`, real transaction/skill/agent counts — no visitor-log inflation. Token launcher API hides failed launches by default (filter `status !== "failed"`). On-chain verification for ERC-8004 and BAP-578 badges, valid `txHash` requirements for revenue tracking. Agent cleanup mechanisms prevent bot-bursts. Security measures include mandatory environment variables for encryption and admin authentication keys, HMAC-signed Telegram wallet linking, internal-only private key access, temporary display of private keys, and robust retry logic for token launches.

### Performance Optimizations
Includes Telegram webhook mode, a priority-based in-memory task queue, system health monitoring, per-user rate limiting, request timing middleware, API logging, batched visitor tracking, SEO prerendering, non-blocking startup, lazy-loading, and throttled frontend animations.

### AI Agent Architecture
Agents utilize decentralized LLM inference (Llama 3.3 70B, DeepSeek V3) for decision-making, strategic thinking, journal entries, skill code generation, and analyzing skill execution. Smart contracts handle economic aspects while AI manages off-chain behaviors. Fallback mechanisms ensure deterministic behavior when inference is unavailable or unaffordable. Agents now use **persistent memory** (`agent_memory` table, type `action_outcome`) to track success/failure rates of past actions and include this context in AI decision prompts for smarter behavior over time.

### Agent Store & Activity Feed
The Agent Store (`/agent-store`) features a tabbed interface with three views: All Agents (searchable grid with real earnings/skills/transaction stats), Live Activity Feed (real-time audit log stream with action type icons and timestamps), and Leaderboard (ranked agents by total earnings with crown/star/flame icons for top 3). Quick Deploy template cards (Trading, Research, Social, DeFi, Security, Sniper) link to the builder for streamlined onboarding. APIs: `GET /api/web4/agents/activity-feed`, `GET /api/web4/agents/leaderboard`, `GET /api/web4/agents/strategy-templates`.

## External Dependencies

### Database
- **PostgreSQL**: The primary relational database used for persistent storage.

### Key NPM Packages
- **express**: Core framework for the backend HTTP server.
- **drizzle-orm**, **drizzle-kit**: Object-Relational Mapper and migration tools for database interaction.
- **@tanstack/react-query**: Manages server state and data fetching on the client-side.
- **zod**, **drizzle-zod**: Used for schema validation and type safety.
- **wouter**: A small routing library for the React frontend.
- **framer-motion**: Library for declarative animations in React.
- **twitter-api-v2**: Facilitates integration with the Twitter API.
- **node-telegram-bot-api**: Provides an interface to interact with the Telegram Bot API.
- **sharp**: An image processing library.

### Replit-Specific Integrations
- **@replit/vite-plugin-runtime-error-modal**: Enhances error reporting during development within Replit.
- **@replit/vite-plugin-cartographer**: Provides Replit-specific development tooling.
- **@replit/vite-plugin-dev-banner**: Displays development environment banners.