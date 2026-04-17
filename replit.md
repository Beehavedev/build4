# BUILD4 - AI Trading Bot (Telegram)

## Overview
Build4 is a Telegram bot for crypto trading with AI-powered agents. Users get BSC wallets, deposit USDT, and Build4 trades perpetual futures on Aster DEX as a broker on their behalf. The bot uses Claude AI for trading decisions, features copy trading, quests, and a mini app.

## Architecture: Broker Model
Build4 operates as a **broker** — one master Aster DEX account handles all trades. Users never interact with Aster DEX directly.
- Users deposit USDT to their BSC wallet
- Build4 bridges funds to the broker's Aster DEX account
- AI agents trade using the broker's API credentials
- User balances tracked internally in the database
- Build4 earns fees on every trade

## Production Deployment (Render)
The **primary production app** runs on Render from `Beehavedev/build4` repo.
- Uses grammY bot framework, Prisma ORM, React mini app
- Has working Aster DEX connection (Pro API V3 with EIP-712 wallet signing)
- 18k+ Telegram users
- Changes pushed to `Beehavedev/build4` GitHub → auto-deployed on Render

## Tech Stack
- **Runtime**: Node.js 20+ with TypeScript
- **Bot Framework**: grammY (Telegram)
- **ORM**: Prisma with PostgreSQL
- **AI**: Anthropic SDK (Claude)
- **Blockchain**: ethers.js v6 (BSC/EVM wallets)
- **DEX**: Aster DEX Pro API V3 (EIP-712 signed, fapi3.asterdex.com)
- **Server**: Express.js
- **Cron**: node-cron for agent runner
- **Mini App**: Vite + React 18

## Project Structure
```
/
├── prisma/schema.prisma          # Database schema
├── src/
│   ├── server.ts                 # Express entry point + webhook
│   ├── db.ts                     # Prisma client singleton
│   ├── bot/
│   │   ├── index.ts              # grammY bot init + command registration
│   │   ├── middleware/
│   │   │   └── auth.ts           # User lookup/create middleware
│   │   └── commands/
│   │       ├── start.ts          # /start - create user + BSC wallet
│   │       ├── wallet.ts         # /wallet - view/manage wallets
│   │       ├── fund.ts           # /fund + /deposit - QR + address for USDT (BEP-20) deposits
│   │       ├── trade.ts          # /trade + /tradestatus
│   │       ├── aster.ts          # /aster - Aster DEX balance/positions
│   │       ├── agents.ts         # /agents + /newagent
│   │       ├── signals.ts        # /signals - market signals
│   │       ├── portfolio.ts      # /portfolio
│   │       ├── scan.ts           # /scan - contract scanner
│   │       ├── copytrade.ts      # /copytrade - leaderboard
│   │       ├── quests.ts         # /quests - rewards
│   │       └── price.ts          # /price - token prices
│   ├── agents/
│   │   ├── runner.ts             # Cron ticker (every 60s)
│   │   ├── tradingAgent.ts       # AI trading agent logic
│   │   ├── memory.ts             # Agent memory CRUD
│   │   ├── riskGuard.ts          # Pre-trade risk checks
│   │   └── indicators.ts         # Technical analysis indicators
│   ├── services/
│   │   ├── aster.ts              # Aster DEX API — EIP-712 signed (fapi3.asterdex.com)
│   │   ├── wallet.ts             # EVM wallet gen + AES-256 encryption
│   │   ├── price.ts              # CoinGecko price oracle
│   │   ├── scanner.ts            # Token contract scanner
│   │   └── signals.ts            # Market signal generation
│   └── miniapp/                  # Vite React mini app (served at /app)
│       ├── index.html
│       ├── vite.config.ts
│       └── src/
│           ├── main.tsx
│           ├── App.tsx
│           ├── index.css
│           └── pages/
│               ├── Dashboard.tsx
│               ├── Portfolio.tsx
│               ├── CopyTrade.tsx
│               └── AgentStudio.tsx
```

## Aster DEX Integration (EIP-712 V3)
- Public endpoints: `https://fapi.asterdex.com` (no auth)
- Signed endpoints: `https://fapi3.asterdex.com` (EIP-712)
- All signed calls need: user address, signer address, nonce, EIP-712 signature
- Domain: `{name:"AsterSignTransaction", version:"1", chainId:1666, verifyingContract:ZeroAddress}`
- No HMAC API keys needed, no X-MBX-APIKEY header

## Key Secrets
- `TELEGRAM_BOT_TOKEN` - Bot token from @BotFather
- `ANTHROPIC_API_KEY` - Claude AI API key
- `WALLET_ENCRYPTION_KEY` - AES-256 master key for wallet encryption
- `ASTER_BUILDER_ADDRESS` - Builder wallet (holds 100 ASTER)
- `ASTER_AGENT_ADDRESS` - Agent wallet address (signs orders)
- `ASTER_AGENT_PRIVATE_KEY` - Agent wallet private key
- `ASTER_BUILDER_FEE_RATE` - Fee rate per trade
- `DATABASE_URL` - PostgreSQL connection

## Running
- Workflow: `npx tsx src/server.ts` on port 5000
- Agent runner cron runs every 60 seconds
- Prisma schema push: `npx prisma db push`

## Database
Prisma ORM with models: User, Wallet, Agent, AgentMemory, Trade, CopyFollow, Portfolio, Quest, UserQuest, AgentLog.

## Security
- Private keys AES-256 encrypted before DB storage
- Agent risk guard: daily loss circuit breaker
