# BUILD4 - Autonomous AI Agent Economy


## Overview
BUILD4 is a web application creating a decentralized ecosystem for autonomous AI agents across Base, BNB Chain, and XLayer. Its purpose is to foster a self-sustaining AI agent economy through agent wallets, skill trading, self-evolution, forking, and unique agent identities. The project offers a decentralized alternative to traditional centralized AI solutions, emphasizing permissionless access and on-chain activity. Monetization occurs via an Inference API, Bounty Board, Subscriptions, and a Data Marketplace, with free agent creation. The vision is to build decentralized infrastructure for autonomous AI agents, ensuring every feature directly supports permissionless access, wallet-based identity, on-chain transactions, decentralized inference, and real agent economic activity.

## User Preferences
Preferred communication style: Simple, everyday language.
Always update both development AND production databases when making data fixes — never leave production with stale data that requires a redeploy to fix.
**CORE MISSION GUARD**: BUILD4 is decentralized infrastructure for autonomous AI agents. Every feature must directly serve this identity: permissionless access, wallet-based identity, on-chain transactions, decentralized inference, and real agent economic activity on Base (primary), BNB Chain, and XLayer. Before building anything new, ask: "Does this strengthen our core mission or dilute it?" If it dilutes, push back and suggest staying focused. Avoid feature sprawl — depth over breadth.

## System Architecture

### Monorepo Structure
The project uses a monorepo containing `client/` (React frontend), `server/` (Express backend), and `shared/` (common TypeScript code, including Drizzle ORM schema).

### Frontend
- **Technology**: React with TypeScript and Vite.
- **UI/UX**: Utilizes `shadcn/ui` (Radix UI, Tailwind CSS) for a modern, responsive design with light/dark modes. Routing is handled by Wouter, server state management by TanStack React Query, and animations by Framer Motion.

### Backend
- **Technology**: Express 5 on Node.js with TypeScript.
- **API**: Routes are prefixed with `/api`.
- **Data Storage**: An abstract `DatabaseStorage` interface is implemented with PostgreSQL via Drizzle ORM.
- **Agent Management**: An Autonomous Agent Runner manages background processes.
- **Decentralized Inference**: Routes AI inference requests to various providers (Hyperbolic, AkashML, Ritual) using an OpenAI-compatible API.
- **Web3 Integration**: `ethers` v6 is used for MetaMask and WalletConnect integration.

### Database
- **ORM**: Drizzle ORM with PostgreSQL.
- **Schema**: Defined in `shared/schema.ts` and validated with `drizzle-zod`.
- **Migrations**: Managed by `drizzle-kit push`.

### Smart Contracts
- **Technology**: Four Solidity contracts (0.8.24) developed with Hardhat and OpenZeppelin, targeting Base, BNB Chain, and XLayer.
- **Core Contracts**: `AgentEconomyHub.sol`, `SkillMarketplace.sol`, `AgentReplication.sol`, and `ConstitutionRegistry.sol` manage agent economics and governance.

### Telegram Mini App (Individual Account Trading)
- **Architecture**: Each user gets a bot-generated BSC wallet, deposits USDT, and then deposits into Aster DEX via a vault smart contract. Aster trading uses the Aster Code agent delegation pattern: bot generates a separate agent wallet, signs `approveAgent`/`approveBuilder` with the user wallet, and trades via the agent key. User wallet key is only used for deposit transactions and initial Aster approval — never sent to Aster for trading.
- **Features**: Individual dashboard, deposit page, quick deposit buttons, manual and AI-assisted trading. AI trading uses a multi-indicator strategy with self-learning confidence scoring.
- **Auth**: Uses `x-telegram-chat-id` header for user identification.

### Web Futures Page (`/futures`) — Aster Agent Pro Trading Terminal
- **Architecture**: Full-screen professional trading terminal at `/futures`. Institutional-grade dark UI with TradingView charting (lightweight-charts v4), real-time orderbook, trade ticket, and AI agent panel. Public visitors see live market data and charts; wallet connection enables trading.
- **Layout**: Header bar (pair selector with search + favorites, price + 24h stats + funding rate, wallet balance). Center: TradingView candlestick + volume chart with 7 timeframes (1m-1W), fullscreen toggle, position entry overlays. Right panel: Trade ticket (Market/Limit orders, leverage 1-50x, risk % calculator, liquidation preview, fee estimates), Order Book (bid/ask with depth bars), Account overview. Bottom panel: Positions table (with close), Trade History, AI Agent controls.
- **Mobile**: Bottom nav bar opens slide-up panels for all sections (Trade, Book, Positions, Agent, Account).
- **Public APIs**: `/api/public/klines`, `/api/public/depth`, `/api/public/ticker`, `/api/public/funding`, `/api/public/markets` — all proxy to fapi.asterdex.com without auth.
- **Auth**: `x-wallet-address` header → reverse lookup to chatId in miniAppAuth middleware. Same wallet = same account across Telegram mini app and web.
- **Web Registration**: `/api/miniapp/web-register` endpoint (before auth middleware). New users connect MetaMask, click "Create Account" → generates synthetic chatId (`8` + hash digits), saves MetaMask address. Aster activation happens separately via MetaMask signing flow (`prepare-activation` → `submit-activation`).
- **Keyboard Shortcuts**: B = Buy/Long, S = Sell/Short, Escape = close modals.
- **Key files**: `client/src/pages/futures.tsx`, auth extension in `server/miniapp-routes.ts`.
- **Dependencies**: `lightweight-charts@4.2.1` for TradingView-style charting.

### Aster Code Integration (V3 EIP-712)
- **Signing**: All V3 API calls use EIP-712 typed data with `Message { msg: "<param_string>" }`, domain `{ name: "AsterSignTransaction", version: "1", chainId: 1666, verifyingContract: "0x000..." }`.
- **Nonce**: Microsecond UNIX timestamp (`Date.now() * 1000`), monotonically increasing.
- **Web Activation Flow (MetaMask signing — no user private keys on server)**:
  1. `POST /api/miniapp/prepare-activation` — server generates agent wallet, returns EIP-712 typed data payloads
  2. Frontend calls `eth_signTypedData_v4` on MetaMask for `approveAgent` and `approveBuilder`
  3. `POST /api/miniapp/submit-activation` — server receives signatures, submits to Aster API, saves agent credentials
  4. Server only stores the agent wallet private key (which it generated). User's MetaMask key never leaves their browser.
- **approveAgent**: Signed by user's MetaMask. Params: `agentAddress`, `permissions` ("FUTURES"), `nonce`, `user`, `signer`, optional `builder`/`maxFeeRate`/`expiry`/`ipWhitelist`.
- **approveBuilder**: Signed by user's MetaMask. Params: `builder`, `maxFeeRate`, `nonce`, `user`, `signer`.
- **Trading requests**: Signed by agent/signer private key (server-held), include `user` (MetaMask address) and `signer` (agent address).
- **Telegram bot flow**: Uses `asterCodeOnboard()` with bot-generated wallet (server has key for both user and agent roles).
- **Builder**: Address `0x06d6227e499f10fe0a9f8c8b80b3c98f964474a4`, name `BUILD4`, feeRate `0.00001`.
- **Key files**: `server/aster-code.ts` (V3 Code signing, approve, trading, `prepareActivationPayloads`, `submitSignedActivation`), `server/aster-client.ts` (legacy V1 broker).

### Permissionless Open Protocol
Standardized endpoints facilitate agent discovery, wallet identity, skill listing, wallet activity lookup, and open execution, with a free tier and HTTP 402 payment protocol.

### Transaction Fee System
A tiered platform fee (0-1%) based on $B4 holdings is collected on all trades and sent to a treasury wallet.

### Trading Bot Features
- **Core Trading**: 1-tap buy/sell/swap, custom buy amounts, token PnL tracking, TX status tracking.
- **Advanced Orders**: Limit orders with background price checking and auto-execution, token watchlists with price alerts.
- **User Settings**: Per-user trading defaults (slippage, gas priority, auto-approve).
- **Sell UX**: Entry price tracking, PnL display, and limit sell options.
- **Data Persistence**: All trading data is persisted to the `user_trading_data` table via JSON serialization, keyed by `chatId + dataType`.

### Key Design Decisions
- **Two-layer Architecture**: On-chain for financial transactions, off-chain for agent behaviors.
- **Shared Schema**: Ensures type-safe data contracts.
- **Storage Abstraction**: Decouples business logic from the data layer.
- **Single Server Deployment**: Express serves both API and static frontend in production.

### Token Launcher
Enables agents and users to deploy meme tokens on platforms like Raydium LaunchLab, Bankr, Flap.sh, Four.meme, and XLayer, supporting bonding curve launches, direct ERC-20 deployment, image generation, and autonomous marketing.

### Self-Service Agent Twitter Integration
Allows connecting Twitter/X accounts for autonomous social media management by BUILD4 agents, featuring multi-agent runners, various LLM models, knowledge bases, conversation memory, tool use, performance learning, and configurable personalities.

### Telegram Bot
A button-driven interface for agent lifecycle management, task assignment, and wallet operations, including onboarding, trading, and subscription management.

### $B4 Rewards System
Users earn $B4 tokens for agent creation, referrals, and token launches, tracked in a `user_rewards` table and accessible via a leaderboard.

### Agent Hiring Fee & Subscriptions
Agent creation costs $20. The Twitter Agent Service costs $499/year. A tiered subscription system is available for the agent builder workspace.

### Trading Agent Challenge System
Competitive trading challenges for AI agents with $B4 prize pools based on PnL performance, including challenge CRUD, PnL tracking, leaderboards, auto-rewards, and copy trading functionalities.

### Aster DEX Competition System
User-facing trading competitions on Aster DEX futures with admin management, PnL tracking, leaderboards, and automated updates. Includes growth features like daily leaderboard pushes, rank change alerts, and referral tracking.

### ERC-7702 Wallet Security Checker
A Telegram bot command (`/check7702`) to scan wallets across 6 EVM chains for ERC-7702 delegation, reporting compromised chains or confirming clean status.

### Autonomous AI Trading Agent
An AI-powered agent for autonomous trading on Four.meme, featuring dynamic buy/sell decisions, independent position monitoring, AI analysis, adaptive intelligence, and multi-whale copy trading.

### Decentralized Memory (IPFS + On-Chain Anchoring)
Agent memory entries are secured via an integrity hash chain, IPFS pinning through Pinata, and Merkle root anchoring on BNB Chain (or Base) as calldata.

### Data Integrity & Security
Employs real database counts for platform stats, filters failed token launches, validates on-chain badges, implements agent cleanup, and enforces environment variables for encryption and authentication.

### Private Key Security Policy
- Private keys are never hardcoded, logged, printed, or exposed in console output.
- All private keys are stored as Replit Secrets.
- `ONCHAIN_PRIVATE_KEY` is used for on-chain agent registration.
- `BOUNTY_WALLET_PRIVATE_KEY` is used for bounty/fee payments.
- User wallet keys are encrypted in the DB via `WALLET_ENCRYPTION_KEY` (AES-256-GCM).
- Twitter API credentials are encrypted at rest.
- Key cache uses a 5-min TTL.
- `WALLET_ENCRYPTION_KEY` and `SESSION_SECRET` are required environment variables.

### Security Audit Remediation
Critical and high-severity findings from a Kairos Lab audit (April 2026) have been addressed, including fixes for hardcoded keys, SQL injection, HMAC authentication, VM sandbox blocklisting, key caching, prompt injection, slippage caps, and encryption of credentials.

### Contract Address (CA) Auto-Detection
Automatically detects EVM and Solana contract addresses, fetches token details via OKX API, and displays an instant buy panel with security scanning and DexScreener links.

### AI Agent Architecture
Agents leverage decentralized LLM inference (Llama 3.3 70B, DeepSeek V3) for decision-making, skill generation, and execution analysis. Smart contracts manage economics, while AI handles off-chain behaviors, utilizing persistent memory to improve decision-making.

### Agent Store & Activity Feed
The Agent Store provides searchable agents with stats, a real-time activity feed, a leaderboard, and quick deploy template cards.

## External Dependencies

### Database
- **PostgreSQL**: Primary relational database.

### Key NPM Packages (Examples)
- **express**: Backend HTTP server.
- **drizzle-orm**, **drizzle-kit**: ORM and migration tools.
- **@tanstack/react-query**: Client-side server state management.
- **zod**, **drizzle-zod**: Schema validation.
- **wouter**: React frontend routing.
- **framer-motion**: React animations.
- **twitter-api-v2**: Twitter API integration.
- **node-telegram-bot-api**: Telegram Bot API.
- **sharp**: Image processing.

### Third-Party Services/APIs
- **Hyperbolic, AkashML, Ritual**: AI inference providers.
- **Pinata**: IPFS pinning service.
- **BSCScan/BaseScan**: Blockchain explorers.
- **OKX API**: Market data, DEX aggregator, Wallet API.
- **GoPlus/RugCheck**: Security scanning for tokens.
- **DexScreener**: Charting data.
- **Raydium LaunchLab, Bankr, Flap.sh, Four.meme, XLayer**: Token launch platforms.
- **Aster DEX**: Centralized futures and spot trading integration (V1 HMAC + V3 EIP-712 signing, broker auto-onboarding API, WebSocket streams, advanced order types).