# BUILD4 Fact Sheet

| | |
|---|---|
| **Project** | BUILD4 |
| **Category** | AI trading agent / execution platform |
| **Founded** | _[year]_ |
| **Founder(s)** | _[names]_ |
| **HQ / region** | _[location]_ |
| **Website** | https://build4.io |
| **Telegram bot** | @build4_bot _(confirm handle)_ |
| **Twitter / X** | _[handle]_ |
| **Mini-app** | Inside Telegram via the bot |
| **Web dApp** | https://build4.io/app (WalletConnect) |

## Supported venues

| Venue | Chain | Type |
|---|---|---|
| Aster DEX | BSC | Perpetual futures |
| Hyperliquid | HL L1 | Perpetual futures |
| 42.space | BSC | Prediction markets |
| Polymarket | Polygon | Prediction markets (gasless) |

## Tech stack (high level)

- **Backend:** Node.js + TypeScript, Express
- **Bot framework:** grammY (Telegram)
- **Database:** PostgreSQL (Prisma ORM)
- **AI providers:** Anthropic Claude, xAI Grok, Hyperbolic, Akash (multi-LLM router)
- **Wallets:** ethers.js v6, AES-256 encrypted custody
- **Polymarket:** Gnosis Safe + Polymarket relayer (gasless)
- **Frontend:** Vite + React 18 (mini-app), Vite + React + WalletConnect (web dApp)

## Security posture

- AES-256 encryption for all custodial private keys
- Daily loss circuit breaker per agent
- Builder-attribution fail-closed on Polymarket (no orders placed if attribution config missing)
- SIWE-authenticated web sessions with origin pinning + nonce one-time-use
- Encrypted wallet seeds at rest; never logged

## Available for

- Partnership integrations (DEXs, prediction markets, oracle providers)
- Press / podcast appearances
- KOL demos / co-marketing
- Hackathon judging / grant program collaborations

## Press contact

_[Name]_
_[email]_
_[Telegram handle]_
