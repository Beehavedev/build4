# BUILD4 - AI Trading Bot (Telegram)

## Overview
Build4 is a Telegram bot for crypto trading with AI-powered agents. Users get BSC wallets, deposit USDT, and Build4 trades perpetual futures on Aster DEX as a broker on their behalf. The bot uses Claude AI for trading decisions, features copy trading, quests, and a mini app.

## Architecture: Broker Model
Build4 operates as a **broker** — one master Aster DEX account handles all trades. Users never interact with Aster DEX directly.
- Users deposit USDT to their BSC wallet
- Build4 bridges funds to the broker's Aster DEX account
- AI agents trade using the broker's API credentials (ASTER_API_KEY / ASTER_API_SECRET)
- User balances tracked internally in the database
- Build4 earns fees on every trade

## User Preferences
Preferred communication style: Simple, everyday language.

## Tech Stack
- **Runtime**: Node.js 20+ with TypeScript
- **Bot Framework**: grammY (Telegram)
- **ORM**: Prisma with PostgreSQL (Replit built-in)
- **AI**: Anthropic SDK (claude-sonnet-4-5)
- **Blockchain**: ethers.js v6 (BSC/EVM wallets)
- **Server**: Express.js
- **Cron**: node-cron for agent runner
- **Mini App**: Vite + React 18

## Project Structure
```
/
├── prisma/schema.prisma          # Database schema
├── src/
│   ├── server.ts                 # Express entry point + webhook
│   ├── bot/
│   │   ├── index.ts              # grammY bot init + command registration
│   │   ├── middleware/
│   │   │   ├── auth.ts           # User lookup/create middleware
│   │   │   ├── rateLimit.ts      # In-memory rate limiter
│   │   │   └── session.ts        # Session types
│   │   └── commands/
│   │       ├── start.ts          # /start - create user + BSC wallet
│   │       ├── wallet.ts         # /wallet - view/manage wallets
│   │       ├── trade.ts          # /trade + /tradestatus
│   │       ├── agents.ts         # /agents + /newagent
│   │       ├── signals.ts        # /signals - market signals
│   │       ├── portfolio.ts      # /portfolio
│   │       ├── scan.ts           # /scan - contract scanner
│   │       ├── copytrade.ts      # /copytrade - leaderboard
│   │       ├── quests.ts         # /quests - rewards
│   │       ├── buy.ts            # /buy + /sell
│   │       ├── launch.ts         # /launch - token launch wizard
│   │       └── help.ts           # /help
│   ├── agents/
│   │   ├── runner.ts             # Cron ticker (every 60s)
│   │   ├── tradingAgent.ts       # AI trading agent logic
│   │   ├── memory.ts             # Agent memory CRUD
│   │   ├── riskGuard.ts          # Pre-trade risk checks
│   │   └── explainer.ts          # Trade explanation via Claude
│   ├── services/
│   │   ├── wallet.ts             # EVM wallet gen + AES-256 encryption
│   │   ├── price.ts              # CoinGecko price oracle
│   │   ├── aster.ts              # Aster DEX API (mock)
│   │   └── pnl.ts                # Portfolio PnL calculation
│   └── miniapp/                  # Vite React mini app (served at /app)
│       ├── index.html
│       ├── vite.config.ts
│       └── src/
│           ├── main.tsx          # Entry point
│           ├── App.tsx           # Tab navigation (5 tabs)
│           ├── api.ts            # API client + Telegram WebApp bridge
│           ├── styles.css        # Full dark theme styles
│           └── pages/
│               ├── Dashboard.tsx  # Portfolio overview + agent summary
│               ├── Trade.tsx      # Quick trade form (pair/side/leverage)
│               ├── Agents.tsx     # Agent list with registry info
│               ├── Positions.tsx  # Open/closed positions
│               └── Leaderboard.tsx # Top agents leaderboard
```

## Key Secrets
- `TELEGRAM_BOT_TOKEN` - Bot token from @BotFather
- `ANTHROPIC_API_KEY` - Claude AI API key
- `WALLET_ENCRYPTION_KEY` - AES-256 master key for wallet encryption
- `ASTER_API_KEY` - Broker's Aster DEX API key
- `ASTER_API_SECRET` - Broker's Aster DEX API secret
- `DATABASE_URL` - PostgreSQL connection (auto-managed by Replit)

## Running
- Workflow: `npx tsx src/server.ts` on port 5000
- Webhook auto-set to Replit dev domain
- Agent runner cron runs every 60 seconds
- Prisma schema push: `npx prisma db push`

## Database
Prisma ORM with models: User, Wallet, Agent, AgentMemory, Trade, CopyFollow, Portfolio, Quest, UserQuest.

## Security
- Private keys AES-256 encrypted before DB storage
- Rate limiting: 30 commands/minute per user
- Agent risk guard: daily loss circuit breaker
- Private key export requires "I CONFIRM" + auto-delete after 30s
