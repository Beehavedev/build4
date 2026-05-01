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
- **Polymarket (Polygon CLOB, GASLESS):** Phase 2 manual trading + Phase 3 autonomous agent + Phase 2.1 gasless migration. All three share `src/services/polymarketTrading.ts`, which uses `@polymarket/builder-relayer-client` (RelayClient + builder-abstract-signer) so every on-chain action — Safe deployment, USDC + CTF approvals, and CTF redemptions — is paid for by Polymarket's relayer. **Users pay zero gas at any point; no MATIC required, ever.** Architecture: each user gets a Gnosis Safe proxy (`safeAddress`) deployed on first `/setup`. The user's existing custodial PK (same secp256k1 keypair as BSC) acts as the Safe owner / EIP-712 signer; the Safe holds USDC.e and outcome shares. Orders use `SignatureType.POLY_GNOSIS_SAFE` (=2) with `funder=safeAddress`. Builder attribution (`POLY_BUILDER_CODE` + HMAC API creds + `POLY_BUILDER_API_KEY/SECRET/PASSPHRASE` for the relayer) is **fail-closed**: if any required cred is missing the trade is refused, so we never generate volume that doesn't count toward the Polymarket Builder Program grant. Order placement enforces a server-side slippage cap (price snapshot + max bps) and the setup flow batches 6 approvals (USDC×3 to CTF Exchange / NegRisk Exchange / NegRiskAdapter + CTF `setApprovalForAll`×3) through the relayer. Endpoints: `/api/polymarket/wallet` (returns both EOA + Safe address + balances at the Safe), `/api/polymarket/setup` (3-step: derive L2 creds → deploy Safe → batch approvals), `/api/polymarket/order` (manual market buy/sell), `/api/polymarket/positions`, and `/api/polymarket/redeem` (gasless CTF redemption for resolved markets, supports both vanilla CTF and NegRiskAdapter). Phase 3 lives in `src/agents/polymarketAgent.ts` (60s tick, MAX_EVENTS=5, MAX_MARKETS=3, dedup by held conditionIds, reads USDC at the Safe address — **agent skips if no Safe deployed**) and is wired into the runner alongside the existing 42/Aster/HL ticks. UI lives in `src/miniapp/src/pages/PredictionsPolymarket.tsx` (Buy YES/NO modal, wallet panel showing the Safe as the deposit address with a "no MATIC needed" callout, positions list with one-tap SELL on filled positions and one-tap REDEEM on resolved-win positions). Schema: `PolymarketCreds.safeAddress` + `safeDeployedAt` columns added (idempotent ALTER in `src/ensureTables.ts`); migration risk was zero since builder secrets were freshly added with no funded EOAs in production yet. **Polygon RPC layer (2026-04-30):** `getProvider()` returns an ethers `FallbackProvider` (quorum=1, stallTimeout=2.5s, staticNetwork=137) over `POLYGON_RPC_URLS`: `POLYGON_RPC` env var first, then `polygon-bor-rpc.publicnode.com`, `polygon.drpc.org`, `1rpc.io/matic`. The viem walletClient uses an analogous `viem.fallback()` transport. Excluded after egress testing: `polygon-rpc.com` (returns 401 from cloud IPs), `rpc.ankr.com/polygon` (auth required), `polygon.llamarpc.com` (NXDOMAIN). Both the bot `/wallet` command and the mini-app PolygonCard surface `eoa.error` explicitly (banner with Polygonscan link) instead of silently displaying 0.00 when all endpoints fail. The mini-app `setupWallet()` reads `j.details ?? j.error` from the server's setup-failure response so the user sees the actual cause (e.g. relayer error) instead of the opaque code `setup_failed`.
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

## BUILD4 Web dApp (`web4/`) — Parallel WalletConnect mirror
A separate web dApp lives in `web4/` that mirrors the Telegram bot's trading flows behind a WalletConnect connect-button, sharing the same Postgres DB. It is intentionally isolated from the bot:
- **The bot at root is sacred.** Do NOT touch `src/`, `prisma/`, `package.json`, `render.yaml`, or the `.replit` deployment block. The bot runs on Render via `render.yaml` and on `build4.io` (frozen at commit `fdd973b` until user explicitly republishes). It earns real money — never break it.
- **Origin:** `web4/` was restored from the marketing-site commit `fdd973b` (234 files: `client/`, `server/`, `contracts/`, `shared/`, `script/`, `vite.config.ts`). All 93 deps were already in root `package.json` — no installs needed. `web4/attached_assets` is a symlink → `../attached_assets`.
- **Build:** `cd web4 && npx vite build --config vite.config.ts` outputs to `web4/dist/public/` (~6.6 MB, includes WalletConnect bundle).
- **Server:** `web4/server/dapp-server.ts` is a slim Express on port 8080 (default, override with `DAPP_PORT`). Endpoints: `/api/health`, `/api/web4/walletconnect-config` (returns `WALLETCONNECT_PROJECT_ID`), `/api/web4/nonce?address=…`, `/api/web4/siwe`, `/api/web4/me`, `/api/web4/logout`. Session = JWT (HS256 via `jose`) in HTTP-only cookie `build4_dapp_session`. Session secret is in-memory random unless `DAPP_SESSION_SECRET` is set (must be set in production).
- **SIWE hardening (`/api/web4/siwe`):** Custom strict EIP-4361 parser (since `siwe` package isn't installed) — extracts and validates: `domain`, address line, `URI`, `Version` (must be "1"), `Chain ID`, `Nonce`, `Issued At`, `Expiration Time`. Enforces:
  - **Origin/domain pinning:** request `Origin` header host AND parsed `domain` AND parsed `URI` host all must match `DAPP_ALLOWED_HOSTS` (comma-separated env var; falls back to request `Host` header for dev). Cross-origin POSTs → 403.
  - **Nonce one-time-use:** deleted on the first SIWE attempt whether success or failure, so the same nonce can never be replayed.
  - **Timing window:** `issuedAt` must be within `[now - 10 min, now + 1 min]`; `expirationTime` (if present) must be in the future and ≤ 1 hour after `issuedAt`. Frontend currently sets a 5-min expiry.
  - Address is normalized lowercase; `verifyMessage(message, signature)` recovered address must match.
  - All input length-bounded (message ≤ 4 KB, signature ≤ 200 chars). Rejected attempts log a warning, never leak which check failed at session level.
  - Smoke-tested with 10 cases (happy, replay, tampered domain/URI/nonce, bad/good Origin, expired issuedAt, /me with+without cookie) — all expected pass/fail outcomes verified.
- **Frontend route:** `/app` (registered in `web4/client/src/App.tsx`, page at `web4/client/src/pages/app.tsx`) — 4-step onboarding: Connect → SIWE → Session keys (placeholder) → Dashboard (placeholder).
- **Workflow:** `Web dApp preview` runs `DAPP_PORT=8080 npx tsx web4/server/dapp-server.ts` (console output, port 8080). Build is run separately via bash because Vite takes ~12s and would exceed `waitForPort` timeout. After editing `web4/client/**`, rebuild with `cd web4 && npx vite build --config vite.config.ts`. After editing `web4/server/dapp-server.ts`, restart the workflow.
- **Express 5 gotcha:** Don't use `app.get("*", …)` — the new path-to-regexp rejects bare `*`. Use `app.use((req, res, next) => …)` instead.
- **Next milestone:** Build `/web-api/*` trading endpoints in `web4/server/` that take WalletConnect-signed payloads and provision an HL agent wallet, Aster API key, and Polymarket Safe per web user. Reference (READ ONLY, never modify): `src/services/polymarketTrading.ts`, `src/services/agentCreation.ts`, `src/services/asterReapprove.ts`. Web user → Postgres mapping (reuse `User.walletAddress` vs new `WebUser` table) is still TBD.