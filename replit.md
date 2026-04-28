# BUILD4 - AI Trading Bot (Telegram)

## Overview
Build4 is an AI-powered Telegram bot for crypto perpetual futures trading on Aster DEX and Hyperliquid L1. It operates as a broker, allowing users to deposit USDT into BSC wallets, which Build4 then manages for trading via AI agents. Key features include AI-driven trading decisions, copy trading, quests, and a mini-app. The project aims to provide an accessible platform for users to engage in crypto trading with advanced AI assistance.

## User Preferences
I prefer detailed explanations.
I want iterative development.
Ask before making major changes.
Do not make changes to the `prisma` folder.
Do not make changes to the `src/abHarness` folder.
Do not make changes to the `scripts/runMarketCreator.ts` file.

## System Architecture
Build4 employs a broker model where a single master Aster DEX account executes trades on behalf of users. User balances are tracked internally. The system is built on Node.js with TypeScript, utilizing the grammY framework for Telegram bot interactions, Prisma ORM for PostgreSQL database management, and Express.js for the server. AI capabilities are powered by Anthropic's Claude AI. Wallet management uses ethers.js for BSC/EVM, with AES-256 encryption for private keys. The mini-app is developed with Vite and React 18.

**Key Technical Implementations:**
- **DEX Integration:** Supports Aster DEX Pro API V3 with EIP-712 wallet signing and Hyperliquid L1 via their SDK.
- **AI Agent Runner:** A cron job orchestrates AI trading agents, which include logic for trading decisions, memory management, risk guarding, and technical analysis indicators.
- **Prediction Market Trading:** Agents can take positions on 42.space (BSC) prediction markets based on conviction thresholds.
- **Market Creator Agent:** An autonomous agent researches trending events and proposes new prediction markets, leveraging DexScreener and GNews.
- **Multi-Provider Swarm Trading:** Allows per-user opt-in for swarm trading, where multiple LLM providers contribute to trading decisions, with a quorum-based verdict system.
- **Multi-Provider LLM Router:** A unified interface (`inference.ts`) for interacting with various LLM providers (Anthropic, xAI, Hyperbolic, Akash).
- **Security:** Implements AES-256 encryption for private keys and a daily loss circuit breaker for agents.
- **Admin Authentication:** Gated admin endpoints using a shared secret or Telegram ID allowlist for secure management.

## External Dependencies
- **Telegram:** grammY bot framework
- **Database:** PostgreSQL (via Prisma ORM)
- **AI/LLM:** Anthropic SDK (Claude), xAI, Hyperbolic, Akash
- **Blockchain:** ethers.js v6 (for BSC/EVM wallets)
- **DEX:** Aster DEX Pro API V3, Hyperliquid L1 SDK (`@nktkas/hyperliquid`)
- **Third-Party APIs:** CoinGecko (price oracle), DexScreener (trending tokens), GNews (news fetching)
- **Optional Integration:** Trust Wallet Agent Kit (TWAK) for risk assessment.