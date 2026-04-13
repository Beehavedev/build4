# BUILD4 × Trust Wallet — Technical Overview

## What is BUILD4?

BUILD4 is an autonomous AI trading platform on BNB Chain. Users get a BSC wallet via Telegram, deposit USDT, and trade perpetual futures on Aster DEX — powered by AI agents running Claude Sonnet for market analysis and trade execution.

**Live at:** build4.io | Telegram: @AsterAgentBot

---

## Platform Stats (as of April 2026)

| Metric | Value |
|---|---|
| Total Users | 203 |
| BSC Wallets Created | 285 |
| AI Agents (active) | 449 |
| Agent Wallets | 449 |
| Total Trades Executed | 112+ |
| Active Traders | 5 |
| Aster DEX Connected | 4 |
| Page Views | 663,000+ |
| Live Since | March 3, 2026 |

---

## Architecture

```
Telegram Bot → User Wallet (BSC) → Aster DEX (Perp Futures)
                                  ↗
            AI Agent (Claude Sonnet) — Market Analysis → Trade Execution
```

**Stack:**
- **Backend:** Node.js/Express, PostgreSQL, deployed on Render (Singapore)
- **Chain:** BNB Smart Chain (BSC)
- **DEX Integration:** Aster DEX V3 API (EIP-712 signed transactions)
- **AI Engine:** Claude Sonnet (claude-sonnet-4-20250514) — temperature 0.15
- **Wallet:** Server-side HD wallets (ethers.js), encrypted private keys
- **Frontend:** Telegram Mini App (WebApp SDK)

**Key Technical Points:**
- Each user gets a dedicated BSC wallet on signup (no seed phrase needed)
- AI agents analyze multi-timeframe technicals (1m, 5m, 15m, 1h, 4h candles), order book depth, funding rates, and 24h ticker data
- Trades execute via Aster DEX V3 with EIP-712 typed data signing (agent signer → user parent wallet)
- Risk management: max 2% per trade, max 3 concurrent positions, dynamic leverage (1-8x), auto stop-loss
- Rate limiter with 1000ms intervals, 60s response cache, weight monitoring, and IP ban detection

---

## How Trust Wallet Agent Kit Could Integrate

### 1. Native Wallet Connection
Currently BUILD4 generates server-side wallets. With Trust Wallet Agent Kit:
- Users connect their existing Trust Wallet (self-custody)
- No private key generation/storage on our servers
- Trust Wallet's familiar UX for transaction signing
- Access Trust Wallet's existing BSC user base

### 2. AI Agent Execution Layer
BUILD4's autonomous trading agents could use the Agent Kit to:
- Execute trades programmatically through Trust Wallet's infrastructure
- Manage on-chain approvals and token transfers
- Handle USDT deposits/withdrawals natively
- Multi-chain support (BSC, Base, etc.)

### 3. Distribution Channel
- BUILD4 as a featured dApp in Trust Wallet's browser
- Deep linking from Trust Wallet to BUILD4's trading terminal
- Push notifications for trade signals via Trust Wallet

### 4. Shared Infrastructure
- Trust Wallet's RPC nodes for BSC (currently using public BSC dataseed)
- Agent Kit's transaction management for reliability
- Cross-platform wallet recovery and portability

---

## What We Bring

- **Live product** with real users and real trades on BSC
- **AI-first trading** — autonomous agents making market decisions
- **Aster DEX partnership** — integrated builder/agent system
- **Telegram-native** distribution (200+ users organically in 6 weeks)
- **Production battle-tested** rate limiting, error handling, and risk management

---

## Contact

- **Platform:** build4.io
- **GitHub:** github.com/Beehavedev/build4.git
- **Telegram Bot:** @AsterAgentBot
