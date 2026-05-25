# BUILD4 - AI Trading Bot (Telegram)

## Overview
Build4 is an AI-powered Telegram bot for crypto perpetual futures trading on Aster DEX and Hyperliquid L1, plus prediction markets (42.space, Polymarket) and BSC LP-farming (Topaz). Users get a non-custodial setup: each user has their own BSC custodial wallet, their own per-user Aster + HL agent keys, and their own Polymarket Gnosis Safe. Funds live in the user's own venue accounts — there is no master pooled trading account. Build4 collects fees via the EIP-712 `builder` field on Aster orders (30 bps to `BROKER_FEE_WALLET`) and via the HL builder cap (10 bps).

Key features: AI-driven trading decisions (multi-LLM swarm), copy trading, quests, mini-app, parallel WalletConnect web dApp.

## User Preferences
- I prefer detailed explanations.
- I want iterative development.
- Ask before making major changes.
- Do not make changes to the `prisma` folder.
- Do not make changes to the `src/abHarness` folder.
- Do not make changes to the `scripts/runMarketCreator.ts` file.
- **Do NOT push `build4io-site/` or `web4/` changes to GitHub.** The website and web dApp live on Replit only — the user publishes them manually via Replit Publish. Only push to GitHub when the change touches bot files (`src/`, `prisma/`, root `package.json`, `render.yaml`) since GitHub→Render is the bot's deploy path.

## Tech Stack
- **Bot:** Node.js + TypeScript, grammY (Telegram), Express.js, Prisma ORM + PostgreSQL
- **Wallets:** ethers.js v6 (BSC/EVM), AES-256 encryption for custodial PKs
- **AI/LLM:** Anthropic Claude + xAI + Hyperbolic + Akash (multi-provider router in `src/services/inference.ts`)
- **DEX:** Aster DEX Pro API V3 (EIP-712 signing), Hyperliquid L1 SDK (`@nktkas/hyperliquid`)
- **Prediction markets:** 42.space (BSC on-chain) + Polymarket (Polygon CLOB, gasless via Polymarket relayer)
- **BSC DeFi:** Topaz ve(3,3) (master-wallet Phase 1)
- **Third-party APIs:** CoinGecko, DexScreener, GNews
- **Mini-app:** Vite + React 18
- **Web dApp:** parallel WalletConnect-gated mirror at `web4/` (separate Express + SIWE auth + same Postgres)

## System Architecture (high-level)
- **Per-user self-custody:** each user has their own BSC custodial wallet (`Wallet` table), their own per-user Aster agent (`User.asterAgentEncryptedPK`), their own per-user HL agent, their own Polymarket Safe. The bot signs on the user's behalf using the decrypted custodial PK.
- **Agent runner** (`src/agents/runner.ts`): cron-based orchestrator firing per-venue ticks (Aster, HL, 42.space, Polymarket, Topaz). Single-flight guards + boot catch-up + watchdog cron on critical paths.
- **Multi-Provider Swarm Trading:** per-user opt-in for swarm decisions with quorum-based verdicts.
- **Security:** AES-256 PK encryption + daily-loss circuit breakers + admin endpoints gated via `ADMIN_TOKEN` or `ADMIN_TELEGRAM_IDS`.

## Fee model (per venue)
- **Aster:** 30 bps self-collected via builder field → `BROKER_FEE_WALLET`. See `.local/notes/aster-fee-model.md`.
- **Hyperliquid:** 10 bps via builder field (HL protocol cap).
- **42.space / FourMeme / Pancake / Topaz:** 30 bps on-chain transfer to `BROKER_FEE_WALLET` (`src/services/brokerFees.ts`).
- **Polymarket:** Polymarket Builder Program attribution (fail-closed on missing creds).

## Per-venue architecture notes (`.local/notes/`)
Deeper architectural detail, change history, and operational runbooks live in dedicated notes so this file stays scannable:
- `.local/notes/aster-fee-model.md` — Aster fee migration, lazy re-approval, treasury trace
- `.local/notes/polymarket.md` — gasless Safe model, RPC fallback layer, builder attribution
- `.local/notes/fortytwo-campaign.md` — Agent-vs-Community 48h campaign, missed-round protection, sizing fix
- `.local/notes/topaz.md` — ve(3,3) Phase 1 master-wallet farming, brain↔executor split, fail-closed invariants
- `.local/notes/web-dapp.md` — `web4/` WalletConnect dApp, SIWE hardening, `/web-api/*` trading surface
