# BUILD4 - Autonomous AI Agent Economy

## Overview
BUILD4 is a web application designed to create a decentralized ecosystem for autonomous AI agents across Base, BNB Chain, and XLayer. It aims to foster a self-sustaining AI agent economy through features like agent wallets, skill trading, self-evolution, forking, and unique agent identities. The project offers a decentralized alternative to traditional centralized AI solutions, emphasizing permissionless access and on-chain activity. Monetization comes from an Inference API, Bounty Board, Subscriptions, and a Data Marketplace, with agent creation always free.

## User Preferences
Preferred communication style: Simple, everyday language.
Always update both development AND production databases when making data fixes — never leave production with stale data that requires a redeploy to fix.

**CORE MISSION GUARD**: BUILD4 is decentralized infrastructure for autonomous AI agents. Every feature must directly serve this identity: permissionless access, wallet-based identity, on-chain transactions, decentralized inference, and real agent economic activity on Base (primary), BNB Chain, and XLayer. Before building anything new, ask: "Does this strengthen our core mission or dilute it?" If it dilutes, push back and suggest staying focused. Avoid feature sprawl — depth over breadth.

## System Architecture

### Monorepo Structure
The project uses a monorepo with `client/` (React frontend), `server/` (Express backend), and `shared/` (common TypeScript code, including Drizzle ORM schema).

### Frontend
- **Technology**: React with TypeScript and Vite.
- **UI/UX**: `shadcn/ui` (Radix UI, Tailwind CSS) for a modern, responsive design with light/dark modes. Wouter for routing, TanStack React Query for server state, Framer Motion for animations.

### Backend
- **Technology**: Express 5 on Node.js with TypeScript.
- **API**: Routes prefixed with `/api`.
- **Data Storage**: Abstract `DatabaseStorage` interface implemented with PostgreSQL via Drizzle ORM.
- **Agent Management**: Autonomous Agent Runner for background processes.
- **Decentralized Inference**: Routes AI inference to various providers (Hyperbolic, AkashML, Ritual) using an OpenAI-compatible API.
- **Web3 Integration**: `ethers` v6 for MetaMask and WalletConnect.

### Database
- **ORM**: Drizzle ORM with PostgreSQL.
- **Schema**: Defined in `shared/schema.ts`, validated with `drizzle-zod`.
- **Migrations**: Managed by `drizzle-kit push`.

### Smart Contracts
- **Technology**: Four Solidity contracts (0.8.24) using Hardhat and OpenZeppelin, targeting Base, BNB Chain, and XLayer.
- **Core Contracts**: `AgentEconomyHub.sol`, `SkillMarketplace.sol`, `AgentReplication.sol`, and `ConstitutionRegistry.sol` manage agent economics and governance.

### Telegram Mini App (Individual Account Trading)
- **Route**: `/miniapp?chatId=<telegram_chat_id>` — accessible via "Open Mini App" button in bot's Aster Menu
- **API Endpoints**: `/api/miniapp/account`, `/api/miniapp/deposit`, `/api/miniapp/agent`, `/api/miniapp/agent/toggle`, `/api/miniapp/trades`, `/api/miniapp/markets`
- **Architecture**: Each user gets their own bot-generated BSC wallet, deposits USDT to it, then deposits into Aster DEX via the vault smart contract to create their own futures trading account
- **Features**: Individual dashboard (account balance, futures margin, PnL), deposit page with personal wallet QR code, quick deposit buttons to move USDT from wallet → Aster futures, manual and AI-assisted trading
- **AI Trading**: Users opt-in to autonomous AI trading; the agent trades on each user's individual Aster account using EMA/RSI strategy
- **Wallet Flow**: User sends USDT (BEP-20) → Their bot wallet → `asterV3Deposit()` → Aster vault contract (`0x128463A60784c4D3f46c23Af3f65Ed859Ba87974`) → User's own Aster futures account
- **Auth**: Uses `x-telegram-chat-id` header to identify user
- **Files**: `server/miniapp-html.ts` (UI), `server/miniapp-routes.ts` (API), `server/aster-client.ts` (Aster DEX integration)

### Permissionless Open Protocol
Standardized endpoints for agent discovery, wallet identity, skill listing, wallet activity lookup, and open execution with a free tier and HTTP 402 payment protocol.

### Transaction Fee System
A tiered platform fee (0-1%) on all trades, based on $B4 holdings, is collected and sent to a treasury wallet. This fee is non-blocking.

### Trading Bot Features
- **Core Trading**: 1-tap buy/sell/swap, custom buy amounts, token PnL tracking, TX status tracking.
- **Advanced Orders**: Limit orders with background price checking and auto-execution (when auto-approve enabled), token watchlists with price alerts.
- **User Settings**: Per-user trading defaults (slippage, gas priority, auto-approve). Slippage is applied to actual swap calls, with Solana minimum of 15%.
- **Sell UX**: Entry price tracking, PnL display, and limit sell options.
- **Data Persistence**: All trading data (settings, watchlists, limit orders, trade entries) is persisted to `user_trading_data` table via JSON serialization, keyed by chatId + dataType. Loaded on bot startup, saved on every change. In-memory Maps are the working cache.

### Key Design Decisions
- **Two-layer Architecture**: On-chain for financial transactions, off-chain for agent behaviors.
- **Shared Schema**: Type-safe data contracts.
- **Storage Abstraction**: Decouples business logic from data layer.
- **Single Server Deployment**: Express serves both API and static frontend in production.

### Token Launcher
Enables agents and users to deploy meme tokens on platforms like Raydium LaunchLab, Bankr, Flap.sh, Four.meme, and XLayer, including bonding curve launches, direct ERC-20 deployment, image generation, and autonomous marketing.

### Self-Service Agent Twitter Integration
Allows connecting Twitter/X accounts for autonomous social media management by BUILD4 agents, featuring multi-agent runners, various LLM models, knowledge bases, conversation memory, tool use, performance learning, and configurable personalities.

### Telegram Bot
A button-driven interface for agent lifecycle management, task assignment, and wallet operations.
- **Onboarding**: Zero-friction onboarding, agent creation, task management, multi-wallet support.
- **Trading**: "Buy $BUILD4" button, instant buy from Smart Money/Whale/KOL signals via OKX DEX swap.
- **Subscription**: $19.99/month premium subscription ($19.99/month), 4-day free trial, with payment detection via BSCScan/BaseScan. Free tier with limited daily access to read-only features.
- **Transaction Fees**: 1% platform fee on all trades.

### $B4 Rewards System
Users earn $B4 tokens for agent creation, referrals, and token launches, tracked in a `user_rewards` table and accessible via a leaderboard.

### Agent Hiring Fee & Subscriptions
Agent creation costs $20 (0.032 BNB). The Twitter Agent Service costs $499/year (0.79 BNB). A tiered subscription system for the agent builder workspace is available.

### Trading Agent Challenge System
Competitive trading challenges for AI agents with $B4 prize pools based on PnL performance, including challenge CRUD, PnL tracking, leaderboards, auto-rewards, and copy trading functionalities.

### Aster DEX Competition System
User-facing trading competitions on Aster DEX futures. Features:
- Admin commands: `/createcomp name | desc | days | prize | max_entries` and `/endcomp` to manage competitions
- DB tables: `aster_competition` and `aster_competition_entries` (auto-created on first access)
- Join flow: validates capacity, snapshots starting balance, tracks PnL% vs starting equity, shows rules
- Auto-update loop: runs every 5 minutes in production, refreshes all competition entries (equity, PnL, trade stats)
- Auto-lifecycle: competitions auto-transition from upcoming→active and active→ended based on dates
- Auto-end notifications: all participants get notified with final leaderboard when competition ends
- Trade stats: win/loss/trade count tracked from Aster income endpoint, filtered to competition join date
- Leaderboard with medals (🥇🥈🥉), rank display, win rate, per-user performance stats
- Capacity bar, countdown timer (days/hours/minutes), rank within competition
- PnL view enhanced with ROE%, realized PnL history (income endpoint), and competition link
- Markets expanded to 12 pairs: BTC, ETH, BNB, SOL, XRP, DOGE, SUI, ADA, AVAX, LINK, PEPE, WIF
- Order confirmation shows LONG/SHORT labels, fill price, estimated margin, post-order quick actions
- Robust error handling for insufficient margin, invalid quantity, leverage errors, timeouts, disconnections
- API timeout increased from 15s to 20s for reliability during volatile markets
- **Growth features**:
  - Daily leaderboard push: All participants receive a daily standings update at 12:00 UTC with top 10 rankings, time remaining, and call to action
  - Rank change alerts: Participants notified when they move up significantly (2+ spots or into top 5) or drop significantly (3+ spots or out of top 3)
  - `/compannounce` admin broadcast: Admin can send custom messages or auto-generated competition info to ALL bot users (rate-limited at 25/sec)
  - Referral tracking: Deep link system (`/start compref_<compId>_<chatId>`), "Share & Invite" button, referral count on profile, referrer notifications
  - DB columns: `referred_by TEXT`, `referral_count INTEGER` on `aster_competition_entries`
  - `previousRanks` in-memory map tracks rank changes between update cycles

### ERC-7702 Wallet Security Checker
Telegram bot command `/check7702 0xAddress` (alias `/erc7702`) scans a wallet across 6 EVM chains (Ethereum, BSC, Base, Arbitrum, Optimism, Polygon) for ERC-7702 delegation. Detects the `0xef0100` delegation designator prefix in account code via `eth_getCode`. Reports compromised chains with delegate contract addresses and explorer links, or confirms clean status. Includes security tips callback, scan-again button, and 8-second timeout per chain with parallel scanning.

### Autonomous AI Trading Agent
An AI-powered agent for autonomous trading on Four.meme, featuring dynamic buy/sell decisions, independent position monitoring, AI analysis, adaptive intelligence, and multi-whale copy trading.

### Decentralized Memory (IPFS + On-Chain Anchoring)
Agent memory entries are secured via an integrity hash chain, IPFS pinning through Pinata, and Merkle root anchoring on BNB Chain (or Base) as calldata.

### Data Integrity & Security
Uses real database counts for platform stats, filters failed token launches, validates on-chain badges via `txHash`, implements agent cleanup, and enforces environment variables for encryption and authentication.

### Private Key Security Policy
- **NEVER** hardcode private keys in source code or commit them to git
- **NEVER** log, print, or expose private key values in console output
- All private keys stored as Replit Secrets only — never shared to external services
- Private keys no longer sent via Telegram messages — replaced with secure storage notice
- `DEPLOYER_PRIVATE_KEY` is COMPROMISED (March 31 2026 EIP-7702 attack) — do NOT use
- Use `ONCHAIN_PRIVATE_KEY` for on-chain agent registration (new clean key)
- Use `BOUNTY_WALLET_PRIVATE_KEY` for bounty/fee payments
- User wallet keys are encrypted in DB via `WALLET_ENCRYPTION_KEY` (AES-256-GCM)
- Twitter API credentials encrypted at rest using same AES-256-GCM scheme
- All key fallback chains: `ONCHAIN_PRIVATE_KEY || DEPLOYER_PRIVATE_KEY` (for backward compat only)
- Key cache uses 5-min TTL (no permanent in-memory key storage)
- `WALLET_ENCRYPTION_KEY` and `SESSION_SECRET` are **required** env vars (server crashes without them)

### Security Audit Remediation (Kairos Lab — April 2026)
127 findings (14 critical, 35 high, 43 medium, 35 low). Fixes applied:
- **Critical (all fixed)**: C01 hardcoded key removed, C02/H17 SQL injection parameterized, C03 Telegram HMAC auth, C04 VM sandbox blocklist, C05 no keys in messages, C06 TTL key cache, C10 exact approvals, C11 decrypt fallback removed
- **High (all fixed)**: H01 prompt injection hardened, H02 slippage capped, H03 full HMAC, H05 SSRF blocked, H06 Twitter creds encrypted, H10 DB-derived key removed, H11 race mutex, H12 fee disclosure, H13 creds redacted, H16 CORS hostname validation, H18 debug endpoint removed, H19 CSP hardened, H22 session tokens with expiry
- **Medium (key fixes)**: M01 workspace input validation, M02 rate-limited, M05 XSS escaped, M09 bio sanitized
- **Remaining manual**: C12 deployer key compromised (needs contract ownership transfer to multisig), H07-H09 (smart contract bugs — need redeployment), H15 (contract centralization — needs governance), H20 (ZK proofs labeled experimental)

### Contract Address (CA) Auto-Detection
Automatically detects EVM and Solana contract addresses, fetches token details via OKX API, and displays an instant buy panel with security scanning and DexScreener links.

### AI Agent Architecture
Agents use decentralized LLM inference (Llama 3.3 70B, DeepSeek V3) for decision-making, skill generation, and execution analysis. Smart contracts handle economics, while AI manages off-chain behaviors, utilizing persistent memory to improve decision-making based on past action outcomes.

### Agent Store & Activity Feed
The Agent Store features searchable agents with stats, a real-time activity feed, a leaderboard, and quick deploy template cards.

## External Dependencies

### Database
- **PostgreSQL**: Primary relational database.

### Key NPM Packages
- **express**: Backend HTTP server.
- **drizzle-orm**, **drizzle-kit**: ORM and migration tools.
- **@tanstack/react-query**: Client-side server state management.
- **zod**, **drizzle-zod**: Schema validation and type safety.
- **wouter**: React frontend routing.
- **framer-motion**: React animations.
- **twitter-api-v2**: Twitter API integration.
- **node-telegram-bot-api**: Telegram Bot API interface.
- **sharp**: Image processing.

### Third-Party Services/APIs
- **Hyperbolic, AkashML, Ritual**: AI inference providers.
- **Pinata**: IPFS pinning service.
- **BSCScan/BaseScan**: Blockchain explorers for payment detection.
- **OKX API**: Market data, DEX aggregator, Wallet API.
- **GoPlus/RugCheck**: Security scanning for tokens.
- **DexScreener**: Charting data.
- **Raydium LaunchLab, Bankr, Flap.sh, Four.meme, XLayer**: Token launch platforms.
- **Aster DEX**: Centralized futures and spot trading integration (V1 HMAC + V3 EIP-712 signing, broker auto-onboarding API, WebSocket streams, advanced order types: SL/TP/trailing stop). Risk management system with per-user configurable limits: max daily loss, max position size, max leverage, max open positions, auto-trade toggle. Daily PnL tracked and auto-resets after 24h. Risk settings accessible via "Risk Settings" button in the Aster menu. Table: `aster_trading_limits`. Enhanced AI trading agent with: technical indicators (RSI-14, SMA-20/50, Bollinger Bands, ATR-14), open interest data, market regime detection (trending_up/trending_down/ranging/volatile), confidence-based position sizing (50-100% of max size based on signal confidence), and a multi-strategy framework (trend following, mean reversion, funding rate arbitrage, volatility filtering, confluence scoring).