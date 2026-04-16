# ⚡ APEX — AI Crypto Trading Bot

World-class Telegram trading bot powered by Claude Sonnet AI. Your agent trades perpetual futures 24/7, learns from every trade, and improves over time.

---

## Features

- 🤖 **AI Trading Agent** — Claude Sonnet analyzes markets every 60 seconds using multi-timeframe technical analysis
- 🧠 **Agent Memory** — Learns from wins and losses, adapts strategy over time
- 🛡️ **Risk Guards** — Circuit breakers, daily loss limits, drawdown mode
- 📊 **Trade Explainability** — Every decision explained in plain English
- 🐋 **Whale Signals** — Smart money tracking and alerts
- 🔍 **Contract Scanner** — AI-powered honeypot and risk detection
- 📋 **Copy Trading** — Follow top traders with on-chain verified PnL
- 🚀 **Token Launch** — Launch tokens on Four.meme and Raydium
- 🎯 **Quests & Rewards** — Earn $B4 tokens for every action
- 📱 **Mini App** — Full dashboard with PnL charts

---

## Quick Start on Replit

### 1. Create a new Replit project
- Go to replit.com → New Repl → Import from ZIP
- Upload the `apex-bot.zip` file

### 2. Add PostgreSQL
- In your Repl, go to the Tools panel
- Click **PostgreSQL** → Add
- The `DATABASE_URL` secret is auto-added

### 3. Set Secrets
Go to **Tools → Secrets** and add:

| Secret | Value |
|--------|-------|
| `TELEGRAM_BOT_TOKEN` | From @BotFather on Telegram |
| `ANTHROPIC_API_KEY` | From console.anthropic.com |
| `MASTER_ENCRYPTION_KEY` | Any random 32+ character string |
| `TELEGRAM_WEBHOOK_URL` | `https://YOUR-REPL-NAME.repl.co/api/webhook` |

> Leave `REDIS_URL` empty — the bot works without it using in-memory storage.

### 4. Run Setup
Open the Replit Shell and run:
```bash
chmod +x setup.sh && ./setup.sh
```

### 5. Start the Bot
```bash
npm run dev
```

Your bot is now live. Open Telegram and message your bot.

---

## Project Structure

```
apex-bot/
├── prisma/
│   ├── schema.prisma       # Database models
│   └── seed.ts             # Quest seeding
├── src/
│   ├── bot/
│   │   ├── index.ts        # Bot initialization
│   │   ├── middleware/
│   │   │   └── auth.ts     # User auto-creation
│   │   └── commands/       # All /commands
│   ├── agents/
│   │   ├── tradingAgent.ts # Core AI trading logic
│   │   ├── indicators.ts   # Technical analysis
│   │   ├── memory.ts       # Agent learning system
│   │   ├── riskGuard.ts    # Pre-trade safety checks
│   │   └── runner.ts       # 60s cron ticker
│   ├── services/
│   │   ├── wallet.ts       # EVM wallet management
│   │   ├── price.ts        # Price oracle
│   │   ├── scanner.ts      # Contract safety scanner
│   │   └── signals.ts      # Whale signal aggregator
│   ├── miniapp/            # React Telegram Mini App
│   │   └── src/pages/      # Dashboard, Agents, Copy, Portfolio
│   ├── db.ts               # Prisma client
│   └── server.ts           # Express entry point
├── .env.example
├── setup.sh
└── README.md
```

---

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Onboard, auto-generate BSC wallet |
| `/wallet` | View wallets and balances |
| `/newagent` | Create AI trading agent |
| `/myagents` | Manage your agents |
| `/trade` | Start/pause active agent |
| `/tradestatus` | Open positions and PnL |
| `/signals` | Whale and smart money signals |
| `/scan` | Contract safety scanner |
| `/buy` | Buy tokens |
| `/sell` | Sell tokens |
| `/copytrade` | Copy top traders |
| `/portfolio` | Portfolio overview |
| `/quests` | Earn $B4 rewards |
| `/help` | Full command list |

---

## AI Trading Agent

The agent runs every 60 seconds and follows this decision framework:

1. **Regime Identification** — ADX-based trend detection
2. **Multi-Timeframe Alignment** — 4h/1h/15m must agree
3. **Entry Quality Scoring** — 0-10 score, minimum 5 to trade
4. **Risk Management** — Proper SL/TP placement, 2:1 minimum R/R
5. **Memory Integration** — Learns from past wins and losses

Every trade includes:
- Plain-English reasoning
- Confidence score (0-100%)
- Key risks identified
- Setup quality score
- Memory update for learning

---

## Adding Real Exchange APIs

The bot works in **mock mode** by default — all trades are simulated with realistic data.

To enable live trading, add these secrets:

**Aster DEX:**
```
ASTER_API_KEY=your_key
ASTER_API_SECRET=your_secret
ASTER_BASE_URL=https://api.aster.com
```

**Hyperliquid:**
```
HYPERLIQUID_PRIVATE_KEY=your_private_key
```

Then update `src/agents/tradingAgent.ts` in the `getMultiTimeframeOHLCV` and execution functions to use real API calls.

---

## Security

- Private keys are AES-256 encrypted before storage
- Raw keys never appear in logs
- Rate limiting: 30 commands/minute per user
- Daily loss circuit breakers on every agent
- Risk guard checks before every trade

---

## Architecture

```
Telegram ──→ Grammy Bot ──→ Commands
                              │
                         Auth Middleware
                              │
                         PostgreSQL (Prisma)
                              │
                    Agent Runner (60s cron)
                              │
                     Claude Sonnet API
                              │
                    Indicators + Risk Guard
                              │
                    Trade Execution + Memory
                              │
                    Telegram Notification
```

---

## License

MIT — Build freely.
