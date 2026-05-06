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
- **Polymarket (Polygon CLOB, GASLESS):** Phase 2 manual trading + Phase 3 autonomous agent + Phase 2.1 gasless migration. All three share `src/services/polymarketTrading.ts`, which uses `@polymarket/builder-relayer-client` (RelayClient + builder-abstract-signer) so every on-chain action — Safe deployment, USDC + CTF approvals, and CTF redemptions — is paid for by Polymarket's relayer. **Users pay zero gas at any point; no MATIC required, ever.** Architecture: each user gets a Gnosis Safe proxy (`safeAddress`) deployed on first `/setup`. The user's existing custodial PK (same secp256k1 keypair as BSC) acts as the Safe owner / EIP-712 signer; the Safe holds USDC.e and outcome shares. Orders use `SignatureType.POLY_GNOSIS_SAFE` (=2) with `funder=safeAddress`. Builder attribution (`POLY_BUILDER_CODE` + HMAC API creds + `POLY_BUILDER_API_KEY/SECRET/PASSPHRASE` for the relayer) is **fail-closed**: if any required cred is missing the trade is refused, so we never generate volume that doesn't count toward the Polymarket Builder Program grant. Order placement enforces a server-side slippage cap (price snapshot + max bps) and the setup flow batches 6 approvals (USDC×3 to CTF Exchange / NegRisk Exchange / NegRiskAdapter + CTF `setApprovalForAll`×3) through the relayer. Endpoints: `/api/polymarket/wallet` (returns both EOA + Safe address + balances at the Safe), `/api/polymarket/setup` (3-step: derive L2 creds → deploy Safe → batch approvals), `/api/polymarket/order` (manual market buy/sell), `/api/polymarket/positions`, and `/api/polymarket/redeem` (gasless CTF redemption for resolved markets, supports both vanilla CTF and NegRiskAdapter). Phase 3 lives in `src/agents/polymarketAgent.ts` (60s tick, MAX_EVENTS=5, MAX_MARKETS=3, dedup by held conditionIds, reads USDC at the Safe address — **agent skips if no Safe deployed**) and is wired into the runner alongside the existing 42/Aster/HL ticks. UI lives in `src/miniapp/src/pages/PredictionsPolymarket.tsx` (Buy YES/NO modal, wallet panel showing the Safe as the deposit address with a "no MATIC needed" callout, positions list with one-tap SELL on filled positions and one-tap REDEEM on resolved-win positions). Schema: `PolymarketCreds.safeAddress` + `safeDeployedAt` columns added (idempotent ALTER in `src/ensureTables.ts`); migration risk was zero since builder secrets were freshly added with no funded EOAs in production yet.
- **Market Creator Agent:** An autonomous agent researches trending events and proposes new prediction markets, leveraging DexScreener and GNews.
- **Multi-Provider Swarm Trading:** Allows per-user opt-in for swarm trading, where multiple LLM providers contribute to trading decisions, with a quorum-based verdict system.
- **42.space "Agent vs Community" Campaign (in progress, see session_plan.md):** 48h sprint, 12 rounds of BTC 8h Price Markets at 4h UTC boundaries (00/04/08/12/16/20). Dedicated campaign agent uses a dedicated BSC wallet via new `Agent.walletId` column (idempotent ALTER in `ensureTables.ts`, no `prisma/` edit). Lifted caps for the campaign agent ONLY ($50/position, 8/day, 12 open, 50% budget) gated on `FT_CAMPAIGN_MODE=true` + `FT_CAMPAIGN_AGENT_ID`; all other agents stay on the conservative broker defaults ($2/position, 3/day, 5 open). Brain in `src/services/fortyTwoCampaign.ts`: BTC TA packet from Aster BTCUSDT 5m candles + RSI/MACD/ATR/ADX/Bollinger via `src/agents/indicators.ts`, on-chain bucket grid via `readMarketOnchain`, 4-model swarm (anthropic/xai/hyperbolic/akash) in parallel, always-trade aggregator with tie-break (unanimous → majority → plurality → nearest-to-spot → crowd-consensus fallback). Scheduler in `src/agents/runner.ts` fires 4 ticks per round at boundary +5m (ENTRY, $50, always trades), +1h30m (REASSESS_1), +3h (REASSESS_2), +3h45m (FINAL); REASSESS/FINAL ticks scheduled but DOUBLE_DOWN/SPREAD logic + thesis broadcast + recap API are pending follow-up. Market scanner `getCurrentRoundBtcPriceMarket()` filters on `categories=['Price'] && topics=['Bitcoin'] && tags=['8 hour']` (lowercased) and picks by startDate proximity to the current round boundary.
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