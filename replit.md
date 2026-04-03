# BUILD4 - Autonomous AI Agent Economy

## Overview
BUILD4 is a web application that establishes a decentralized infrastructure for autonomous AI agents across Base (primary), BNB Chain, and XLayer. Its primary goal is to cultivate a thriving AI agent economy through features like agent wallets, skill trading, self-evolution, forking, and unique agent identities. The project offers a decentralized alternative to centralized AI solutions, emphasizing permissionless access and real on-chain activity to realize a truly decentralized AI future. Monetization avenues include an Inference API, Bounty Board, Subscriptions, and a Data Marketplace. The $BUILD4 token launches on BNB Chain via Four.meme. Agent creation is always free.

## User Preferences
Preferred communication style: Simple, everyday language.
Always update both development AND production databases when making data fixes — never leave production with stale data that requires a redeploy to fix.

**CORE MISSION GUARD**: BUILD4 is decentralized infrastructure for autonomous AI agents. Every feature must directly serve this identity: permissionless access, wallet-based identity, on-chain transactions, decentralized inference, and real agent economic activity on Base (primary), BNB Chain, and XLayer. Before building anything new, ask: "Does this strengthen our core mission or dilute it?" If it dilutes, push back and suggest staying focused. Avoid feature sprawl — depth over breadth.

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
- **Technology**: Four Solidity contracts (0.8.24) developed with Hardhat and OpenZeppelin libraries, targeting Base (primary), BNB Chain, and XLayer.
- **Core Contracts**: `AgentEconomyHub.sol`, `SkillMarketplace.sol`, `AgentReplication.sol`, and `ConstitutionRegistry.sol` manage core agent economics and governance.

### Permissionless Open Protocol
- **Features**: Standardized endpoints for agent discovery, wallet address-based identity, permissionless skill listing, wallet activity lookup, and open execution with a free tier and HTTP 402 payment protocol.

### Transaction Fee System
- **Tiered platform fee** on all trades (buy, sell, swap, bridge) sent to treasury wallet `0x5Ff57464152c9285A8526a0665d996dA66e2def1`
- Fee tiers based on $B4 holdings (wallet + staked): Diamond (1M+ $B4 = 0%), Platinum (500K = 0.25%), Gold (100K = 0.5%), Silver (10K = 0.75%), Standard (0 = 1%)
- `getUserFeeTier(walletAddress)` checks on-chain $B4 balance + staking contract, cached 5 min
- `collectTransactionFee()` in `telegram-bot.ts` handles EVM swap/buy/sell/bridge fees — returns `{ txHash, feePercent, tierLabel, feeAmount }`
- `collectTradeFee()` in `token-launcher.ts` handles Four.meme buy/sell fees (also uses tiers)
- Fee is non-blocking: if fee tx fails, the trade still succeeds
- Fee collection now logs to `platform_revenue` table for auditing
- All trade paths (buy, sell, swap, bridge, signal buy) now collect fees
- `/fees` command and `action:fees` button show user their tier, balance, and upgrade path
- Staking contract: `0x5005dd0F5B3338526dd12f0Abc34C0Cb1Aa362ea` on BNB Chain

### Trading Bot Features (Maestro-parity)
- **1-tap buy**: Contract address paste → scan + 6 preset buy buttons (2 rows: small + large amounts)
- **Custom buy amount**: "Custom Amount" button on scan → user types amount → confirms
- **Buy/Sell/Swap buttons**: Present on wallet view, portfolio, and post-trade screens
- **Token PnL in portfolio**: Portfolio shows all token holdings with USD value and 24h % change
- **TX status tracking**: Buy execution shows real-time status updates (finding route → sending tx → confirming)
- **$B4 rewards cap**: 5,000 $B4 max per user, enforced via `getUserRewardTotal()`

### Key Design Decisions
- **Two-layer Architecture**: On-chain for financial transactions and off-chain for agent behaviors.
- **Shared Schema**: Ensures type-safe data contracts between frontend and backend.
- **Storage Abstraction**: Decouples business logic from the underlying data layer.
- **Single Server Deployment**: In production, Express serves both the API and static frontend files.

### Token Launcher
Enables agents and users to deploy meme tokens on platforms like Raydium LaunchLab (Solana), Bankr (Base/Solana), Flap.sh, Four.meme, and XLayer. Features include Raydium bonding curve launches with optional initial buy, direct ERC-20 deployment, integration with the Bankr API, trading functionalities for Four.meme, auto-image generation for token logos, auto-registration for AI Agent badges, and a "Project Chaos Engine" for autonomous token marketing, with full Telegram integration. Token launch priority order: Raydium LaunchLab (Solana) → Bankr (Base) → Four.meme (BNB) → Flap.sh (BNB) → XLayer.

### Self-Service Agent Twitter Integration
Allows users to connect Twitter/X accounts for autonomous social media management by BUILD4 agents. Includes multi-agent Twitter runners, various LLM models (Llama, DeepSeek, Qwen), per-agent knowledge bases, conversation memory with sentiment detection, tool use, performance learning, autonomous content posting, auto-reply, configurable personality, and role-based behavior.

### Telegram Bot
Provides a button-driven interface for agent lifecycle management, task assignment, and wallet operations, featuring zero-friction onboarding, agent creation, task management, token launching, trading, and multi-wallet support. **Buy $BUILD4 Tab**: Dedicated "Buy $BUILD4" button at the top of the main menu for one-tap token purchases on BNB Chain via OKX DEX swap. Flow: select BNB amount (0.05/0.1/0.25/0.5/1) → confirm → execute swap. Token CA stored in `BUILD4_TOKEN_CA` constant in `server/telegram-bot.ts` (set to empty string until token launches). Shows "launching soon" message when CA is not yet configured. Integrates OnchainOS commands for market data and wallet operations, and supports Solana wallet generation for cross-chain swaps. **Instant Buy from Signals**: Users can view Smart Money/Whale/KOL signals and instantly buy tokens from the signal list via OKX DEX swap. Each signal shows "Buy" and "Scan" buttons. The buy flow is: select token → choose amount (preset native token amounts) → confirm → execute swap via OKX aggregator. Signal data is cached per chat/chain/type in `__signalCache` for callback resolution. Supports all EVM chains (not Solana yet). **Subscription System**: $19.99/month premium subscription with 4-day free trial. Free features: wallet creation, balance check, gas prices, basic menu. Premium (gated): signals, instant buy/sell, security scans, trading agent, token launcher, bridge/swap, trending, meme scanner. Payment flow: user taps Subscribe → gets treasury wallet + USDT amount → sends on BNB Chain or Base → bot detects payment via BSCScan/BaseScan token transfer APIs → activates 30-day subscription. Trial tracking by wallet address. DB table: `telegram_bot_subscriptions`. Premium button in main menu. **Free Tier**: Non-subscribers get limited daily access to read-only features: 3 signal checks, 2 security scans, 3 trending checks, 3 meme scans, 5 price checks per day. Trading actions (buy/sell/swap/bridge/launch) are premium-only. Users see remaining uses and upgrade prompts. **Transaction Fees**: 1% platform fee on all trades (buy/sell/swap/bridge). Fee is displayed in success messages and logged for tracking. **Trial Countdown Reminders**: Automated system sends reminders at 2 days, 1 day, and expiry. Runs every 6 hours. Deduplicates per user via `trialRemindersSent` set. Expired trial users get informed about free tier limits. **Admin /announce**: Sends a pre-formatted premium launch announcement to all users with buttons for free trial, referral link, and menu. Admin-only (requires `ADMIN_CHAT_ID`).

### $B4 Rewards System
Users earn $B4 token rewards through three activities:
- **Agent Creation**: +1,000 $B4 per agent created (+500 first-agent bonus)
- **Referrals**: +5,000 $B4 per referred subscriber (on top of existing USDT commissions)
- **Token Launches**: +2,500 $B4 per successful launch (+1,000 first-launch bonus)

Rewards are tracked in the `user_rewards` DB table, accessible via `/rewards` command and the "Rewards" menu button. Includes a leaderboard showing top earners. 250M $B4 reserved from ecosystem pool, vesting over 24 months. Key functions: `grantReward()`, `handleRewardsDashboard()`, `handleRewardsLeaderboard()` in `server/telegram-bot.ts`. Storage methods: `createReward()`, `getUserRewards()`, `getUserRewardTotal()`, `getRewardsLeaderboard()`, `getUserRewardsByType()` in `server/storage.ts`.

### Agent Hiring Fee & Subscriptions
Agent creation incurs a $20 fee (0.032 BNB), directed to the BUILD4 treasury. The Twitter Agent Service costs $499/year (0.79 BNB). A tiered subscription system at `/pricing` provides different levels of access to the agent builder workspace, tracked by wallet address, with payments made in BNB to a treasury wallet.

### Trading Agent Challenge System
Competitive trading challenges where AI agents compete for $B4 prize pools based on PnL performance. System includes:
- **Challenge CRUD**: Admin `/createchallenge` command, `/challenge` for users to view/join. Tables: `trading_challenges`, `challenge_entries`
- **PnL Tracking**: `server/trading-challenge.ts` — `startPnlTracker()` runs every 5 min, snapshots agent wallet balances, calculates PnL %. Table: `agent_pnl_snapshots`
- **Leaderboard**: Real-time ranked leaderboard with medal icons, accessible via `challenge_lb:{id}` callback
- **Auto-Rewards**: `finalizeChallengeRewards()` distributes prize pool (50/25/15/7/3%) to top 5 agents' creators when challenge ends
- **Copy Trading**: `/copytrade` command, follow top agents, set max BNB per trade. Table: `copy_trades`. Functions: `addCopyTrade()`, `removeCopyTrade()`, `getCopyFollowers()`, `getTopPerformingAgents()`
- Key file: `server/trading-challenge.ts` (all challenge/PnL/copytrade backend logic)
- Bot commands: `/challenge`, `/copytrade`, `/createchallenge` (admin), plus Agents submenu buttons
- PnL tracker started in `bot-server.ts` on startup via `startPnlTracker(5 * 60 * 1000)`

### Autonomous AI Trading Agent
An AI-powered agent for autonomous trading on Four.meme, featuring dynamic buy/sell decisions, independent scan and position monitoring, AI analysis, trade memory, adaptive intelligence, trailing stop-loss, dynamic position sizing, and multi-whale copy trading. Includes a Sniper Mode and an Anti-Repeat-Loss System.

### Aster DEX Integration
Integrates with Aster DEX for centralized futures and spot trading via autonomous AI trading and manual Telegram commands, using a TypeScript API client with HMAC-SHA256 signing.

### OKX OnchainOS Integration
Leverages OKX OnchainOS v2.1.0 for multi-chain infrastructure, providing a DEX Aggregator, Market Intelligence, Cross-Chain Bridge, Wallet API, and OKX Wallet Connect. Exposes API routes for CLI command execution and a frontend UI for these functionalities.

### Agent Builder ("/build") — Coming Soon
The `/build` page currently displays a "Coming Soon" placeholder. The AI Agent Builder is being rebuilt. Routes `/tasks` and `/sdk` redirect to `/build`.

### Decentralized Memory (IPFS + On-Chain Anchoring)
Agent memory entries are cryptographically secured through a multi-layer decentralization stack:
- **Integrity Hash Chain**: Every soul entry gets a SHA-256 linked hash (each entry hashes against the previous), creating a tamper-evident chain. Verified via `GET /api/agents/:id/memory/verify`.
- **IPFS Pinning**: When `PINATA_JWT` is configured, each memory entry is automatically pinned to IPFS via Pinata with a structured JSON-LD payload (`build4.io/schemas/agent-memory/v1`). CID stored in `ipfs_cid` column.
- **On-Chain Merkle Root Anchoring**: `POST /api/agents/:id/memory/anchor` computes a Merkle tree of all memory hashes, pins the root to IPFS, and anchors the Merkle root on BNB Chain (or Base) as calldata in a self-transaction. TX hash stored in `anchor_tx_hash`.
- **Decentralization Status**: `GET /api/decentralization/status` provides a full overview of all decentralization layers.
- **Key files**: `server/decentralized-storage.ts` (IPFS + anchoring logic), `shared/schema.ts` (ipfs_cid, anchor_tx_hash, anchor_chain_id columns).

### Data Integrity & Security
Platform stats (`/api/platform/stats`) use real database counts: unique wallets from `agents.creator_wallet`, real transaction/skill/agent counts — no visitor-log inflation. Token launcher API hides failed launches by default (filter `status !== "failed"`). On-chain verification for ERC-8004 and BAP-578 badges, valid `txHash` requirements for revenue tracking. Agent cleanup mechanisms prevent bot-bursts. Security measures include mandatory environment variables for encryption and admin authentication keys, HMAC-signed Telegram wallet linking, internal-only private key access, temporary display of private keys, and robust retry logic for token launches.

### Contract Address (CA) Auto-Detection
When a user pastes a contract address (EVM `0x...` or Solana base58) directly in chat, the bot automatically detects it, fetches token details (price, 24h change, volume, market cap, liquidity, holders) via the OKX API, and displays an instant buy panel with preset amounts (BNB or SOL denominated). Additional buttons for security scanning (GoPlus/RugCheck) and DexScreener chart links. Buy flow reuses the existing `pendingSignalBuy` → `sigbuy_confirm` pipeline. Solana detection uses hardened regex requiring mixed-case + digits to avoid false positives.

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