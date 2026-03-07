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
- **AI Buy Analysis**: Feeds batch of candidate tokens (with on-chain metrics, rug-check scores, whale interest flags) to DeepSeek-V3. AI evaluates momentum, token naming, velocity, risk/reward, and overall win rate to pick the best entry or skip all. Enhanced with adaptive selectivity — lowers confidence threshold when winning, raises it when losing.
- **AI Sell Analysis**: Each open position is evaluated by AI every 15s with full momentum analysis — peak tracking, drawdown from peak, trend acceleration/deceleration, source confidence, and trailing stop status. AI uses explicit decision framework: let winners run when accelerating, cut losers when decelerating.
- **Trade Memory & Learning**: Agent remembers all trade outcomes persistently in `trade_outcomes` DB table (survives restarts). Records entry conditions (progress%, age, velocity, holders, raised BNB, rug risk, confidence, source, hour of day). On boot, restores last 30 trades into in-memory buffer.
- **Pattern Analysis Engine**: Every 5 minutes, analyzes last 200 trades from DB to learn winning patterns: optimal curve progress range, best token age, best velocity, best holder count range, best/worst trading hours (UTC), average hold time for winners vs losers, profit factor, best trade source. Feeds all patterns into AI prompts so the model adapts to what actually works.
- **Adaptive Intelligence**: Confidence threshold adjusts based on learned patterns — raises requirement during historically bad hours, tightens during losing streaks (low profit factor). Win rate still adjusts aggression — below 40% = more selective, above 60% = more aggressive.
- **Trailing Stop-Loss**: Activates at 1.3x, then tracks peak price. If price drops 15% from peak, auto-sells to lock in profits. Prevents the classic "watched a 2x become a 0.8x" scenario.
- **Dynamic Position Sizing**: AI confidence score and trade source determine buy size. Consensus trades (multiple whales) = 1.5x base, whale copies = 1.3x, high-confidence AI picks = 1.4x, low-confidence = 0.5x. Never bets the same on a weak signal vs a strong one.
- **Price Momentum Tracker**: Stores rolling price snapshots per position. Compares recent vs older velocity to detect acceleration, deceleration, or stability. Fed directly into AI sell decisions.
- **Creator Rug-Check**: Checks token contract creator's BSCScan history before buying. Tokens with suspicious creator patterns get flagged for the AI to factor into decisions.
- **Fallback**: If AI inference times out or fails, falls back to rule-based scoring (curve progress, age, volume, velocity).
- **Multi-Whale Copy Trading**: Monitors 3 high-alpha wallets (GMGN Whale + 2 Smart Money wallets) via BSCScan API every 20s. Smart buy detection filters airdrops/transfers. Reentrancy guard prevents duplicate trades. 3-retry mechanism for transient API failures.
- **Consensus Detection**: When 2+ tracked whales buy the same token, triggers a consensus signal (confidence 95%, position size 1.5x). Consensus buys are the highest-conviction trades.
- **Agent Skills System**: Modular skill framework (`server/agent-skills.ts`) with 12 built-in skills across 3 categories. Users enable/disable/configure skills via Telegram (`🧩 Agent Skills` button in trading menu). Skills stored per-user in `agent_skill_configs` DB table. Cached in-memory with 60s TTL for performance.
  - **Strategy Skills**: Whale Copier (copy smart money), Momentum Sniper (high velocity entries), Dip Buyer (buy dips on strong tokens), Volume Surge (detect volume spikes). Modify token evaluation scoring.
  - **Analysis Skills**: Rug Detector (block suspicious creators — can veto buys), Liquidity Analyzer (check liquidity depth), Holder Distribution (whale concentration check), Smart Money Tracker (follow profitable wallets). Run pre-buy checks with pass/fail + score modifiers.
  - **Execution Skills**: DCA Entry (split buys over time), Scaled Exit (sell in portions at targets — conservative/balanced/aggressive presets), Trailing Stop Pro (configurable activation + trail distance), Time Exit (auto-close after N minutes). Modify position parameters after buy decision.
- **Risk Management**: Configurable take-profit, stop-loss, max positions, and buy size. Hard safety limits bypass AI for extreme cases. Skills can override trailing stop parameters and add time-based exits.
- **User Control**: Enable/disable per user via Telegram, with AI reasoning, peak tracking, source, and confidence shown in trade notifications. Full skills customization via inline keyboards.
- **Scan Intervals**: Token scan every 30s (was 60s), position monitoring every 15s (was 30s), whale monitoring every 20s. Faster detection = better entries.
- **Persistence**: Trading preferences (enabled, buy size, TP, SL, max positions) persisted to `trading_preferences` DB table. On production boot, preferences are restored and trading agent auto-starts.

### Aster DEX Integration
- **Purpose**: Centralized futures & spot trading on Aster DEX (asterdex.com) — both autonomous AI trading and manual Telegram commands.
- **Client**: TypeScript API client (`server/aster-client.ts`) with HMAC-SHA256 signing for both Futures (`fapi.asterdex.com`) and Spot (`sapi.asterdex.com`) APIs.
- **Credentials**: Per-user encrypted API key/secret stored in `aster_credentials` DB table. Users connect via `/aster` Telegram command.
- **Manual Trading (Telegram)**: `/aster` command provides Connect, Balance, Positions, Orders, Futures Trade, Spot Trade, and Disconnect. Full trade flow with symbol → side → type → quantity → leverage → confirmation.
- **Auto-Trading (Make Me Rich)**: Trading agent scans Aster futures markets every 60s. AI evaluates funding rates, 24h volume, price momentum to pick LONG/SHORT signals. Executes with configurable leverage (default 5x), trailing stops (3%), and hard stop-loss (-10%). Only for users with Aster credentials configured.
- **Position Management**: Monitors Aster futures positions every 30s. Updates trailing stops, checks PnL, and auto-closes on stop-loss or take-profit. Telegram notifications for all trades.

### Performance Optimizations
- **Telegram Webhook Mode**: In production, Telegram bot uses webhooks (`/api/telegram/webhook/:token`) for sub-100ms response times. Falls back to polling in development or if webhook setup fails.
- **Task Queue System**: `server/task-queue.ts` — priority-based in-memory task queue with 8 concurrent workers, 3 retry attempts, and automatic cleanup. Supports `enqueueTask()` (fire-and-forget) and `enqueueAndWait()` (blocking with timeout). Registered handlers for heavy operations like AI inference.
- **Performance Monitor**: `server/performance-monitor.ts` — tracks request latency (avg/p95), Telegram message/callback processing times, trading scan duration, memory usage, and error rates.
- **System Health Dashboard**: `GET /api/system/health` — real-time performance snapshot including uptime, memory, request stats, Telegram metrics, trading metrics, and task queue status.
- **Rate Limiting**: Per-user rate limits for Telegram messages (30/min) and callbacks (60/min). Generic `checkRateLimit()` for any key-based limiting.
- **Request Timing Middleware**: All API requests are timed and recorded for performance analysis.
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