# BUILD4 - Autonomous AI Agent Economy

## Overview
BUILD4 is a web application creating a decentralized infrastructure for autonomous AI agents across BNB Chain, Base, and XLayer. Its core purpose is to foster a robust AI agent economy featuring agent wallets, skill trading, self-evolution, forking, death mechanisms, and identity. The project offers a decentralized alternative to centralized AI solutions, emphasizing permissionless access and real on-chain activity to contribute to a truly decentralized AI future. It aims to monetize through various fees and services like an Inference API, Bounty Board, Subscriptions, and a Data Marketplace.

## User Preferences
Preferred communication style: Simple, everyday language.
Always update both development AND production databases when making data fixes — never leave production with stale data that requires a redeploy to fix.

**CORE MISSION GUARD**: BUILD4 is decentralized infrastructure for autonomous AI agents. Every feature must directly serve this identity: permissionless access, wallet-based identity, on-chain transactions, decentralized inference, and real agent economic activity on BNB Chain, Base, and XLayer. Before building anything new, ask: "Does this strengthen our core mission or dilute it?" If it dilutes, push back and suggest staying focused. Avoid feature sprawl — depth over breadth.

## System Architecture

### Monorepo Structure
The project uses a monorepo with `client/` (React frontend), `server/` (Express backend), and `shared/` (common TypeScript code, Drizzle ORM schema).

### Frontend
- **Framework**: React with TypeScript and Vite.
- **UI/UX**: `shadcn/ui` (Radix UI, Tailwind CSS for light/dark modes), Wouter for routing, TanStack React Query for state management, and Framer Motion for animations.

### Backend
- **Framework**: Express 5 on Node.js with TypeScript.
- **API**: All routes are prefixed with `/api`.
- **Storage**: `DatabaseStorage` interface, backed by PostgreSQL via Drizzle ORM.
- **Autonomous Agent Runner**: Manages background agent processes.
- **Decentralized Inference**: Routes inference requests to Hyperbolic, AkashML, or Ritual providers using an OpenAI-compatible API.
- **Web3 Integration**: `ethers` v6 for MetaMask/WalletConnect integration.

### Database
- **ORM**: Drizzle ORM with PostgreSQL.
- **Schema**: Defined in `shared/schema.ts`, validated with `drizzle-zod`, covering users, agent economy components, decentralized inference, and service data.
- **Migrations**: Handled by `drizzle-kit push`.

### Smart Contracts (On-Chain Layer)
- **Technology**: 4 Solidity contracts (0.8.24) built with Hardhat, utilizing OpenZeppelin, targeting BNB Chain, Base, and XLayer.
- **Core Contracts**: `AgentEconomyHub.sol`, `SkillMarketplace.sol`, `AgentReplication.sol`, and `ConstitutionRegistry.sol`.

### Permissionless Open Protocol
- **Discovery**: Standardized endpoints for agent discovery.
- **Identity**: Wallet address-based.
- **Interaction**: Permissionless skill listing, wallet activity lookup, and open execution with free tier and HTTP 402 payment protocol.

### Key Design Decisions
- **Two-layer architecture**: On-chain for financial transactions, off-chain for agent behaviors.
- **Shared schema**: Ensures type-safe data contracts between client and server.
- **Storage interface abstraction**: Decouples business logic from the data layer.
- **Single server**: Express serves both API and static frontend files in production.

### Token Launcher
Enables agents and users to launch meme tokens on various platforms like Flap.sh, Four.meme, XLayer, and Bankr. Features include direct ERC-20 deployment, integration with Bankr API, comprehensive trading functionalities for Four.meme, auto-image generation for token logos, auto-registration for AI Agent badges, and a "Project Chaos Engine" for autonomous token marketing. Integrates with Telegram for full token launch flow.

### Self-Service Agent Twitter Integration
Allows users to connect Twitter/X accounts to BUILD4 agents for autonomous social media roles. Features a multi-agent Twitter runner, model selection (Llama, DeepSeek, Qwen), per-agent knowledge base, conversation memory with sentiment detection, tool use, performance learning, autonomous content posting, auto-reply, configurable personality, and role-based behavior.

### Telegram Bot (Onboarding + Agent Management)
Provides a button-driven interface for agent lifecycle management, task assignment, and wallet operations. Includes zero-friction onboarding, agent creation, task management, token launching, trading, and multi-wallet support. Supports deployment to Render as a standalone service.
- **OnchainOS Commands**: `/signals`, `/scan`, `/trending`, `/meme`, `/price`, `/gas` powered by `onchainos` CLI v2.1.0.
- **Solana Wallet Support**: Auto-generates Solana wallets (Ed25519 Keypair via `@solana/web3.js`), stored as `sol:${chatId}` in DB. Used as bridge destination for cross-chain swaps to Solana via Li.Fi.

### Agent Hiring Fee
Agent creation costs $20 (0.032 BNB), paid to the BUILD4 treasury wallet. This fee is collected on-chain via the Telegram bot or shown in the web dashboard. Twitter Agent Service costs $499/year (0.79 BNB) for autonomous posting, engagement, and audience growth.

### Autonomous AI Trading Agent
An AI-powered agent for autonomous trading on Four.meme, making dynamic buy/sell decisions with independent scan and position monitor loops, AI analysis, trade memory, adaptive intelligence, trailing stop-loss, dynamic position sizing, and multi-whale copy trading. Modular agent skills allow configuration of strategy, analysis, and execution. Includes a Sniper Mode for fast, high-confidence trades, and an Anti-Repeat-Loss System to avoid re-buying losing tokens. Features Smart Money Discovery to identify and copy profitable traders.

### Aster DEX Integration
Facilitates centralized futures and spot trading on Aster DEX through both autonomous AI trading and manual Telegram commands using a TypeScript API client with HMAC-SHA256 signing. Auto-trading scans Aster markets, evaluates signals with AI, and executes trades with configurable leverage and trailing stops.

### OKX OnchainOS Integration
Multi-chain infrastructure powered by OKX OnchainOS v2.1.0, providing:
- **DEX Aggregator**: Token swaps across 500+ DEXs on 60+ chains via smart routing.
- **Market Intelligence**: Real-time token data, trending tokens, holder distribution.
- **Cross-Chain Bridge**: 18 bridge aggregators for seamless transfers.
- **Wallet API**: Multi-chain token balance queries.
- **OKX Wallet Connect**: Native OKX Wallet integration.
- **OnchainOS CLI Skills**: 10 integrated skills for swapping, market data, signals, security, wallet management, and more.
- **API Routes**: `/api/okx/onchainos/skills` and `/api/okx/onchainos/execute` for CLI command execution.
- **Frontend Page**: `/onchainos` provides a tabbed UI for DEX Swap, Market Data, Bridge, and Wallet panels.

### General-Purpose AI Builder ("/build")
A full general-purpose AI builder at `/build` competing with Replit/Bolt/v0. Builds anything: websites, apps, dashboards, landing pages, tools, games, and AI agents.
- **Split-Screen Layout**: Chat on left, live preview panel (iframe) + code viewer on right. Preview/Code tabs.
- **Live Preview**: AI generates complete HTML documents rendered in a sandboxed iframe. Supports desktop/tablet/mobile viewport sizing with refresh controls.
- **Code Viewer**: Tabbed file browser showing all generated source files (HTML, CSS, JS, JSX, etc.) with syntax-highlighted code.
- **Iterative Building**: Conversation-based iteration — "make it darker", "add a contact form", "change the header" — with file context sent back to AI for updates.
- **AI-Powered Chat**: `POST /api/builder/chat` endpoint uses `runInferenceWithFallback()` (Hyperbolic/Akash/Ritual). System prompt generates `<PREVIEW>` (full HTML doc) and `<FILES>` (individual source files) blocks. Rate-limited (20 req/min per IP).
- **Web Templates**: Landing Page, Dashboard, Web App, Portfolio quick-start templates.
- **Agent Templates**: 6 pre-configured agent types (Trading, Research, Social, DeFi, Security, Sniper) with interactive config cards.
- **Agent Deployment**: Deploys agents with wallet, on-chain identity, and runtime profile ($20 / 0.032 BNB).

### Workspace Pricing & Subscriptions
Tiered pricing system at `/pricing` for the agent builder workspace. Plans tracked by wallet address in `workspace_subscriptions` table.
- **Starter (Free)**: 1 agent, 2 deploys/month, 50 AI credits, BNB Chain only.
- **Pro (0.15 BNB/30 days ≈ $89)**: 10 agents, 50 deploys/month, 2,000 AI credits, all chains.
- **Enterprise (0.5 BNB/30 days ≈ $299)**: Unlimited agents/deploys/credits, dedicated node, white-label.
- **Payment**: BNB sent on-chain to treasury wallet `0x5Ff57464152c9285A8526a0665d996dA66e2def1`, verified via `verifyPaymentTransaction()`.
- **Usage Tracking**: `POST /api/workspace/usage` tracks deploys, inference, and agent creation against plan limits. Returns 403 when limits exceeded.
- **API**: `GET /api/workspace/plan/:wallet`, `POST /api/workspace/upgrade`, `POST /api/workspace/usage`.
- **Builder Integration**: Status bar shows current plan, deploy and AI chat check usage limits, upgrade prompts link to `/pricing`.

### Data Integrity
- **Platform stats**: All numbers on homepage and `/api/platform/stats` come from real database counts (visitors, transactions, agents, skills). No hardcoded or inflated numbers.
- **ERC-8004 badges**: `erc8004Registered` flag is only set when on-chain registration returns `success: true` with a valid `txHash`. `cleanFakeData()` resets stale flags where `onchainId` is null.
- **BAP-578 badges**: Same cleanup — `bap578Registered` flags reset where `onchainId` is null.
- **Revenue tracking**: Only includes `platform_revenue` records with valid `0x`-prefixed `txHash` (on-chain verified). `cleanFakeData()` removes records without valid hashes.
- **Agent cleanup**: `cleanFakeData()` removes agents without a `creatorWallet`, bot-burst agents (sub-2s creation gaps from same wallet), and duplicate versioned skills on startup.
- **Skill marketplace**: Pagination properly supports `limit` and `offset` params (max 200). Template skills are honestly named (e.g., "Keyword Matcher" not "Sentiment Analyzer") with descriptions stating "Not AI-powered." All template skills priced at 0.0001 BNB. Duplicate detection prevents same-template skills per agent.
- **Rate limiting**: Agent creation has 30s cooldown per wallet/IP to prevent bot bursts.

### Security
- **Private key messages**: All private key displays (wallet generation, export, Solana wallet) are auto-deleted after 30 seconds.
- **Token launches**: Fee collection uses retry logic (3 attempts with backoff) and dynamic gas pricing (1.2x current) to reduce failures. TX timeout extended to 180s.

### Performance Optimizations
Includes Telegram webhook mode, a priority-based in-memory task queue, a performance monitor (`/api/system/health`), per-user rate limiting, request timing middleware, API logging, batched visitor tracking, SEO prerendering, non-blocking startup, lazy-loading, and throttled frontend animations.

### Agent Task Terminal
A direct interface for users to assign tasks to agents, receiving AI-powered results for specialized task types.

### CMO Strategy Brain
Generates autonomous strategies for Twitter agents, including go-to-market plans, content calendars, performance analysis, and strategic recommendations with a closed-loop feedback system, utilizing decentralized inference.

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
- **sharp**: Image processing.

### Replit-Specific Integrations
- **@replit/vite-plugin-runtime-error-modal**: Development error display.
- **@replit/vite-plugin-cartographer**: Replit-specific development tooling.
- **@replit/vite-plugin-dev-banner**: Development environment banner.