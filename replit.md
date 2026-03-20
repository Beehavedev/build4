# BUILD4 - Autonomous AI Agent Economy

## Overview
BUILD4 is a web application creating a decentralized infrastructure for autonomous AI agents across BNB Chain, Base, and XLayer. Its core purpose is to foster a robust AI agent economy featuring agent wallets, skill trading, self-evolution, forking, death mechanisms, and identity. The project offers a decentralized alternative to centralized AI solutions, emphasizing permissionless access and real on-chain activity to contribute to a truly decentralized AI future. It aims to monetize through various fees and services like an Inference API, Bounty Board, Subscriptions, and a Data Marketplace.

## User Preferences
Preferred communication style: Simple, everyday language.
Always update both development AND production databases when making data fixes — never leave production with stale data that requires a redeploy to fix.

**CORE MISSION GUARD**: BUILD4 is decentralized infrastructure for autonomous AI agents. Every feature must directly serve this identity: permissionless access, wallet-based identity, on-chain transactions, decentralized inference, and real agent economic activity on BNB Chain, Base, and XLayer. Before building anything new, ask: "Does this strengthen our core mission or dilute it?" If it dilutes, push back and suggest staying focused. Avoid feature sprawl — depth over breadth.

## System Architecture

### Monorepo Structure
A monorepo setup organizes the project into `client/` (React frontend), `server/` (Express backend), and `shared/` (common TypeScript code, Drizzle ORM schema).

### Frontend
- **Framework**: React with TypeScript and Vite.
- **UI/UX**: `shadcn/ui` (Radix UI, Tailwind CSS for light/dark modes), Wouter for routing, TanStack React Query for state management, and Framer Motion for animations.

### Backend
- **Framework**: Express 5 on Node.js with TypeScript.
- **API**: All routes are prefixed with `/api`.
- **Storage**: `DatabaseStorage` interface implementation, backed by PostgreSQL via Drizzle ORM.
- **Autonomous Agent Runner**: Manages background processes for agent actions.
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
Provides a button-driven interface for agent lifecycle management, task assignment, and wallet operations. Includes zero-friction onboarding with auto-wallet generation, comprehensive commands for agent creation, task management, token launching, trading, and multi-wallet support with encrypted private keys. Supports deployment to Render as a standalone service via `server/bot-server.ts` + `render.yaml` for dedicated resources and webhook mode. When running externally, set `TELEGRAM_BOT_EXTERNAL=true` on the main Replit server to skip local bot + trading agent startup. Notifications from agent-runner and twitter agents auto-fallback to direct Telegram API calls via `server/telegram-notify.ts`.

### Agent Hiring Fee
Agent creation costs $599 (0.95 BNB), paid to the BUILD4 treasury wallet before the agent is provisioned. In the Telegram bot, the fee is collected on-chain from the user's linked wallet via `collectAgentHireFee()`. The web dashboard shows the $599 price in the create agent modal. Treasury wallet is derived from `BOUNTY_WALLET_PRIVATE_KEY` || `DEPLOYER_PRIVATE_KEY` || `CHAOS_AGENT_PRIVATE_KEY`. The fee constant `AGENT_HIRE_FEE_BNB = "0.95"` lives in `server/telegram-bot.ts`; schema exports `AGENT_HIRE_PRICE_USD = 599` from `shared/schema.ts`.

### Autonomous AI Trading Agent
An AI-powered agent for autonomous trading on Four.meme, making dynamic buy/sell decisions. Features independent scan and position monitor loops, AI buy/sell analysis with adaptive selectivity, persistent trade memory and learning, a pattern analysis engine, adaptive intelligence, trailing stop-loss, dynamic position sizing, price momentum tracking, creator rug-check, and multi-whale copy trading. Modular agent skills system allows users to enable/disable/configure strategy, analysis, and execution skills. Includes robust risk management and user control via Telegram.
- **Sniper Mode**: Parallel fast-scan loop every 5s (vs 15s for AI scan). Pure numeric evaluation — no AI, no rug check, instant execution. Triggers on high-confidence signals (parabolic velocity + fresh age + strong BNB inflow + whale interest, score >= 75%). Uses priority gas (+30% gas price) for next-block inclusion and higher slippage (20%). 500k gas limit. Latency: ~5-8s from token appearing to buy confirmed. Runs alongside normal AI scan — sniper catches the hottest signals first, AI handles the rest. Tagged as "sniper" source with 1.5x position sizing.
- **Sell Safety**: Smart AI timeout fallback evaluates drawdown from peak, position age, momentum deceleration, and stale position detection (instead of simple TP/SL check). Token info fetches fall back to stale cache on timeout. Emergency force-sell triggers at 4h max hold or after 10 consecutive check failures. Sell retries increase for urgent/old positions. Trailing stop activates at 1.15x (was 1.25x) with 10% distance (was 12%).
- **Anti-Repeat-Loss System**: Session blacklist permanently blocks re-buying tokens that lost money (persists across restarts via DB). Failed token cooldown extended to 60 minutes (was 5 min). AI confidence capped at 90% max (prevents overconfident 95% signals that historically lose). Adaptive threshold goes up to 80 base when win rate <20%. Learned patterns apply +15/-20 score adjustments for tokens in/outside winning ranges.
- **Smart Money Discovery**: Automatically discovers profitable wallets by analyzing graduated Four.meme tokens. Every 5 minutes, scans top graduated tokens' on-chain transfer history via BSCScan to find wallets that consistently bought early (within 10 min of launch) and sold at profit. Wallets with 3+ trades and 50%+ win rate are auto-added to the copy-trade list (max 20). Their new buys boost token scores (+12 for 1 smart buyer, +25 for 2+). Telegram command `/smartmoney` shows discovered wallets. Combined with hardcoded whale wallets for a dynamic smart money tracking system.

### Aster DEX Integration
Facilitates centralized futures and spot trading on Aster DEX through both autonomous AI trading and manual Telegram commands. Utilizes a TypeScript API client with HMAC-SHA256 signing. Manual trading through Telegram commands includes balance, positions, orders, and trade execution. Auto-trading (Make Me Rich) scans Aster futures markets, evaluates signals with AI, and executes trades with configurable leverage and trailing stops. Includes position management and Telegram notifications.

### OKX OnchainOS Integration
Multi-chain infrastructure powered by OKX OnchainOS v2.1.0. Features:
- **DEX Aggregator**: Swap tokens across 500+ DEXs on 60+ chains via `/api/okx/dex/*` routes. Smart routing, MEV protection, trade-specific presets.
- **Market Intelligence**: Real-time token data, trending tokens, holder distribution via `/api/okx/market/*`.
- **Cross-Chain Bridge**: 18 bridge aggregators for seamless BNB Chain ↔ XLayer ↔ other chain transfers via `/api/okx/bridge/*`.
- **Wallet API**: Multi-chain token balance queries via `/api/okx/wallet/*`.
- **OKX Wallet Connect**: Native OKX Wallet connection option alongside MetaMask and WalletConnect.
- **OnchainOS CLI Skills (v2.1.0)**: 10 integrated skills via `onchainos` CLI binary at `~/.local/bin/onchainos`:
  - `okx_dex_swap` — Multi-chain token swapping with MEV protection & smart slippage
  - `okx_dex_market` — Token prices, K-line charts, wallet PnL analysis
  - `okx_dex_signal` — Smart money/whale/KOL buy signals & leaderboards
  - `okx_dex_trenches` — Meme token scanning, dev reputation, bundle/sniper detection
  - `okx_dex_token` — Token search, trending, holders, liquidity analytics
  - `okx_agentic_wallet` — Wallet auth, balance, transfers, contract calls
  - `okx_wallet_portfolio` — Read any wallet on-chain, total value, DeFi positions
  - `okx_onchain_gateway` — Gas estimation, tx simulation, broadcast, order tracking
  - `okx_security` — Token honeypot detection, DApp phishing, tx pre-execution safety
  - `okx_x402_payment` — Gas-free stablecoin payments on XLayer
- **Agent Skill Registry**: All 10 OnchainOS skills registered in `SKILL_REGISTRY` under categories: `onchain-swap`, `onchain-market`, `onchain-signal`, `onchain-security`, `onchain-wallet`, `onchain-infra`.
- **API Routes**: `/api/okx/onchainos/skills` (list skills), `/api/okx/onchainos/execute` (execute CLI commands).
- **Rate Limited**: 30 req/min per IP on all OKX proxy routes.
- **Required env vars**: `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_API_PASSPHRASE`, `OKX_PROJECT_ID`.
- **Files**: `server/okx-onchainos.ts` (API wrapper), `server/onchainos-skills.ts` (CLI skill integration), OnchainOS routes in `server/web4-routes.ts`, frontend at `client/src/pages/onchainos.tsx`.
- **Page**: `/onchainos` — tabbed UI with DEX Swap, Market Data, Bridge, and Wallet panels. Skills sidebar shows all integrated OnchainOS capabilities with version info.

### Performance Optimizations
Includes Telegram webhook mode for production, a priority-based in-memory task queue, a performance monitor (`/api/system/health` endpoint), per-user rate limiting, request timing middleware, API logging, batched visitor tracking, SEO prerendering, non-blocking startup, lazy-loading for heavy imports, and throttled frontend animations.

### Agent Task Terminal
A direct interface for users to assign tasks to agents, receiving AI-powered results. Supports specialized task types like research, analysis, content, code_review, strategy, and general.

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
- **sharp**: Image processing (SVG to PNG conversion).

### Replit-Specific Integrations
- **@replit/vite-plugin-runtime-error-modal**: Development error display.
- **@replit/vite-plugin-cartographer**: Replit-specific development tooling.
- **@replit/vite-plugin-dev-banner**: Development environment banner.