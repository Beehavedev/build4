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
- Telegram messages containing private keys auto-delete after 30-60 seconds
- `DEPLOYER_PRIVATE_KEY` is COMPROMISED (March 31 2026 EIP-7702 attack) — do NOT use
- Use `ONCHAIN_PRIVATE_KEY` for on-chain agent registration (new clean key)
- Use `BOUNTY_WALLET_PRIVATE_KEY` for bounty/fee payments
- User wallet keys are encrypted in DB via `WALLET_ENCRYPTION_KEY`
- All key fallback chains: `ONCHAIN_PRIVATE_KEY || DEPLOYER_PRIVATE_KEY` (for backward compat only)

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
- **Aster DEX**: Centralized futures and spot trading integration (V1 HMAC + V3 EIP-712 signing, broker auto-onboarding API, WebSocket streams, advanced order types: SL/TP/trailing stop). Risk management system with per-user configurable limits: max daily loss, max position size, max leverage, max open positions, auto-trade toggle. Daily PnL tracked and auto-resets after 24h. Risk settings accessible via "Risk Settings" button in the Aster menu. Table: `aster_trading_limits`.