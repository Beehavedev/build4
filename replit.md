# BUILD4 - Autonomous AI Agent Economy

## Overview
BUILD4 is a web application creating a decentralized infrastructure for autonomous AI agents across BNB Chain, Base, and XLayer. It aims to establish a robust AI agent economy featuring agent wallets, skills trading, self-evolution, forking, death mechanisms, and identity, providing a decentralized alternative to centralized AI solutions with a focus on permissionless access and real on-chain activity.

## User Preferences
Preferred communication style: Simple, everyday language.
Always update both development AND production databases when making data fixes — never leave production with stale data that requires a redeploy to fix.

**CORE MISSION GUARD**: BUILD4 is decentralized infrastructure for autonomous AI agents. Every feature must directly serve this identity: permissionless access, wallet-based identity, on-chain transactions, decentralized inference, and real agent economic activity on BNB Chain, Base, and XLayer. Before building anything new, ask: "Does this strengthen our core mission or dilute it?" If it dilutes, push back and suggest staying focused. Avoid feature sprawl — depth over breadth.

## System Architecture

### Monorepo Structure
The project uses a monorepo with `client/` for the React frontend, `server/` for the Express backend, and `shared/` for common TypeScript code and Drizzle ORM schema.

### Frontend
- **Framework**: React with TypeScript, Vite.
- **UI/UX**: `shadcn/ui` (Radix UI, Tailwind CSS for light/dark modes), Wouter for routing, TanStack React Query for state management, Framer Motion for animations.

### Backend
- **Framework**: Express 5 on Node.js, TypeScript.
- **API**: All routes prefixed with `/api`.
- **Storage**: `DatabaseStorage` implementing `IStorage` interface, backed by PostgreSQL via Drizzle ORM.
- **Autonomous Agent Runner**: Background process for agent actions every 30s.
- **Decentralized Inference**: Routes inference to Hyperbolic, AkashML, or Ritual providers with an OpenAI-compatible API.
- **Web3 Integration**: `ethers` v6 for MetaMask/WalletConnect.
- **Build**: Custom esbuild for server, Vite for client, integrated into a single Express server in production.

### Database
- **ORM**: Drizzle ORM with PostgreSQL.
- **Schema**: Defined in `shared/schema.ts`, validated with `drizzle-zod`. Includes tables for users, agent economy components, decentralized inference, and service-related tables.
- **Migrations**: Managed via `drizzle-kit push`.

### Smart Contracts (On-Chain Layer)
- **Technology**: 4 Solidity contracts (0.8.24) using OpenZeppelin, built with Hardhat, targeting BNB Chain, Base, and XLayer.
- **Core Contracts**: `AgentEconomyHub.sol` (wallet layer), `SkillMarketplace.sol` (skill management), `AgentReplication.sol` (child agents, NFTs), `ConstitutionRegistry.sol` (agent laws).

### Platform Monetization
- **Revenue Streams**: Fees on agent creation, replication, skill purchases, inference markup, evolution, and skill listing.
- **Services**: Inference API, Bounty Board, Subscriptions, and Data Marketplace.

### Permissionless Open Protocol
- **Discovery**: `/api/protocol`, `/.well-known/ai-plugin.json`, `/.well-known/agent.json`, `/.well-known/openapi.json` for agent discovery.
- **Identity**: Wallet address-based.
- **Interaction**: Permissionless skill listing, wallet activity lookup, open execution with free tier and HTTP 402 payment protocol.

### Key Design Decisions
- **Two-layer architecture**: On-chain for finance, off-chain for agent behaviors.
- **Shared schema**: Type-safe data contracts between client and server.
- **Storage interface abstraction**: Decouples business logic from data layer.
- **Single server**: Express serves both API and static frontend files in production.

### Token Launcher
- **Purpose**: Allows agents (and users) to launch meme tokens on launchpads.
- **Flap.sh (BSC)**: Portal `0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0`, uses `newTokenV2` with struct params. No-tax token impl `0x8B4329947e34B6d56D71A3385caC122BaDe7d78D`, tax token impl `0x5dd913731C12aD8DF3E574859FDe45412bF4aaD9`. Requires vanity salt mining (CREATE2 address ending in `8888` for no-tax, `7777` for tax). Enums: DexThreshType `0=TWO_THIRDS, 1=FOUR_FIFTHS, 2=HALF, 3=95%, 4=81%, 5=1%`; MigratorType `0=V3_MIGRATOR, 1=V2_MIGRATOR`. Default params: `dexThresh=1 (80%), taxRate=0, migratorType=0 (V3)`. Salt mined locally via `mineVanitySalt()` (~50-70K iterations, ~5s). Docs: https://docs.flap.sh/flap/developers/launch-a-token
- **Platforms**: Four.meme (BNB Chain), Flap.sh (BNB Chain), XLayer (OKX — direct ERC-20 deploy), Bankr (Base/Solana).
- **XLayer (OKX)**: Direct ERC-20 token deployment on XLayer (chain ID 196). Compiles a minimal ERC-20 contract via solc at runtime (cached after first compile). Deploys 1B token supply to creator wallet. RPC: `https://rpc.xlayer.tech`. Explorer: `https://www.oklink.com/xlayer`. No launchpad fee — gas only (~0.005 OKB). Function: `launchOnXLayer()` in `token-launcher.ts`.
- **Bankr Integration**: Token launching via Bankr API (`api.bankr.bot`). Uses Agent Prompt API: `POST /agent/prompt` with natural language like "deploy a token called X with symbol Y on base". Auth via `X-API-Key` header using `BANKR_API_KEY` env secret. Async flow: submit prompt → get jobId → poll `GET /agent/job/{jobId}` every 3s until completed/failed (120s timeout). Supported chains: Base (default), Solana. No on-chain TX from our side — Bankr handles deployment, liquidity, and fee setup. Token launches have a 1.2% swap fee (57% to creator). Functions: `bankrPrompt()`, `bankrPollJob()`, `launchOnBankr()` in `token-launcher.ts`. Telegram flow: platform select → chain select (Base/Solana) → name → symbol → description → preview → confirm. Bankr launches skip logo/links/tax steps. Docs: https://docs.bankr.bot
- **Four.meme Trading**: Full buy/sell integration via TokenManager2 V2 (`0x5c952063c7fc8610FFDB798152D69F0B9550762b`) and TokenManagerHelper3 (`0xF251F83e40a78868FcfA3FA4599Dad6494E46034`). Helper3 provides `getTokenInfo()` (price, bonding curve progress, liquidity status), `tryBuy()` (pre-calculate buy), `trySell()` (pre-calculate sell). Trading uses `buyTokenAMAP` (spend BNB, get max tokens) and `sellToken` (sell tokens, receive BNB). Sell requires ERC20 `approve()` to TokenManager before calling `sellToken`. Exported functions: `fourMemeGetTokenInfo()`, `fourMemeEstimateBuy()`, `fourMemeEstimateSell()`, `fourMemeBuyToken()`, `fourMemeSellToken()`, `fourMemeGetTokenBalance()`.
- **Four.meme API Routes**: `GET /api/four-meme/token/:address` (token info), `GET /api/four-meme/estimate-buy?token=&bnbAmount=`, `GET /api/four-meme/estimate-sell?token=&amount=`, `GET /api/four-meme/balance?token=&wallet=`.
- **Telegram Bot Trading**: `/buy` (buy tokens on Four.meme), `/sell` (sell tokens), `/tokeninfo <address>` (bonding curve + price info). Flow: enter token address → enter amount (or quick-pick buttons) → preview with estimate → confirm → execute on-chain. Sell flow shows balance and 25%/50%/100% quick-sell buttons.
- **Auto Image Generation**: When no custom image URL is provided, auto-generates a unique token logo (SVG → PNG via `sharp`), uploads it to four.meme's CDN via their `/meme-api/v1/private/token/upload` endpoint, and uses the CDN URL for the token listing. Colors are deterministically derived from the token name+symbol hash. Functions: `generateTokenSvg()`, `generateTokenImagePng()`, `fourMemeUploadImage()`.
- **AI Agent Badge (GMGN)**: ERC-8004 Identity Registry for AI badge on GMGN. Correct BSC contract is `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` (same as Ethereum/Base — name="AgentIdentity", symbol="AGENT"). The old address `0x8004A818...` was an uninitialized proxy on BSC. BAP-578 NFA contract (`0xd7Deb29ddBB13607375Ce50405A574AC2f7d978d`, env `BAP578_CONTRACT_ADDRESS`) is functional on BSC (55K+ NFAs minted, 0.01 BNB mint fee). Both registrations require sufficient BNB in user wallet (~0.002 BNB gas for ERC-8004, ~0.012 BNB for BAP-578). Functions: `ensureAgentRegisteredBSC()`, `isAgentRegistered()` in `token-launcher.ts`, `registerAgentERC8004()`, `registerAgentBAP578()` in `onchain.ts`. Telegram `/agentstatus` command checks registration status.
- **Auto-Registration System**: `autoRegisterAgentStandards()` in `agent-runner.ts` runs every 5 minutes. For each active agent missing `erc8004Registered` or `bap578Registered`, it looks up the creator wallet's stored private key via `getPrivateKeyByWalletAddress()` and attempts on-chain registration. Uses user/agent wallet keys only (never deployer). DB flags `erc8004Registered` and `bap578Registered` on the `agents` table track status. The Telegram bot's manual registration flow also sets these flags on success.
- **Module**: `server/token-launcher.ts` handles contract interactions and API signing for both platforms. Four.meme uses the `meme-api` v1 flow: nonce → wallet-signed login → API token create → on-chain `createToken(bytes,bytes)` on contract `0x5c952063c7fc8610FFDB798152D69F0B9550762b` (EIP-1967 proxy, impl at `0xd63cbf542c7096b1df52c7e97644f365c0ebc6fe`). API create body (March 2026 format): `{name, shortName, desc, totalSupply:1e9, raisedAmount, saleRate:0.8, reserveRate:0, imgUrl, raisedToken:{...from raise endpoint or SSR config...}, launchTime, funGroup:false, preSale, clickFun:false, symbol:"BNB", label:"Meme"}`. RaisedToken config is dynamically fetched via `/meme-api/v1/private/token/raise` endpoint (falls back to hardcoded BNB config). **CRITICAL GAS**: `createToken` deploys an ERC20 internally, requiring ~1.5M gas. gasLimit MUST be ≥2000000 (successful TXs use 1.4-1.5M gas). Previous gasLimit of 1000000 caused consistent TX reverts. Default preSale is "0" (no initial buy) — valid preSale amounts include: 0, 0.01, 0.1, 0.5, 1 BNB. Reference: `@unifi-io/fourmeme-sdk@0.0.8`. Pre-flight duplicate name check via four.meme search API. Flap.sh uses `newTokenV2(NewTokenV2Params)` on portal — requires vanity salt mining before TX submission, no API login needed.
- **Launch Fee**: Four.meme and Flap.sh launches charge a 0.01 BNB (~$7) platform fee sent to the treasury wallet (BOUNTY_WALLET_PRIVATE_KEY / DEPLOYER_PRIVATE_KEY address) before executing the launch. Fee is collected as a simple BNB transfer (21000 gas). Balance check includes fee amount. If deployer wallet IS the user wallet, fee is skipped. If no treasury wallet is configured, fee is skipped. Defined as `TOKEN_LAUNCH_FEE` constant in `token-launcher.ts` and `PLATFORM_FEES.TOKEN_LAUNCH_FEE` in `shared/schema.ts`. Bankr launches are free (Bankr handles its own fee structure). The fee is shown in the Telegram launch preview.
- **Project Chaos Engine**: `server/chaos-launch.ts` — autonomous 13-milestone token plan over 7 days. Milestones include burns (to 0xdead), airdrops (to real token holders via BSCScan/Transfer events), and psychological tweets. All tweets signed with `Agent: TSTB4`. Active token: $TST4 at `0x9ce94a0bf3ab14ed098a367567ed2314acfd4444`, agent wallet `0xad3b54798b591f3ad98bf361e0e87e6854d059ef` (key in `CHAOS_AGENT_PRIVATE_KEY` env secret). Background timer in `server/index.ts` checks every 60 seconds if a milestone is due and auto-executes it. Schema: `chaos_milestones` table. API: `/api/chaos/status`, `/api/chaos/plan`, `/api/chaos/launch`, `/api/chaos/execute-next`, `/api/chaos/confession`.
- **Generalized Chaos Plans**: `server/chaos-plan-generator.ts` — AI generates custom chaos plans for any token. Telegram flow: `/chaos` → paste token address → validates holdings (≥1% required) → AI generates 13-milestone plan → user previews → Approve/Regenerate/Cancel → autonomous execution using user's own wallet key. Multi-plan support: `getAllActiveChaosPlans()` iterates all active plans every 60s. Plans stored as `chaos_milestones` linked to `token_launches` records. `/chaosstatus` command shows progress. Milestone config (burnPercent, airdropCount, tweetTemplate) stored in milestone description field as JSON.
- **Export Private Key**: Telegram bot /wallet menu has "Export Private Key" button. Shows warning → confirmation → reveals key as plain text → auto-deletes message after 60 seconds.
- **Wallet Model**: Telegram bot launches use the USER's own wallet (private key stored in `telegramWallets` table). Users must have a wallet with a stored private key (generated or imported via private key). View-only wallets (address only) cannot launch tokens. The deployer wallet is used as fallback only for API-based launches.
- **Agent Action**: Agents with NORMAL balance (>0.5 BNB) can autonomously decide to launch tokens via `launch_token` action in `agent-runner.ts`.
- **User Task**: Users can ask their agents to launch tokens via the Task Terminal by selecting "Launch Token" task type. The agent uses AI to determine token params from the user's description, then executes the actual on-chain launch via `executeLaunchTokenTask` in `server/task-engine.ts`.
- **Schema**: `tokenLaunches` table tracks all launches with status, token address, tx hash, and platform info.
- **Frontend**: `/token-launcher` admin page (auth-gated) at `client/src/pages/token-launcher.tsx`. Task Terminal at `/tasks` includes "Launch Token" as a task type.
- **API**: `/api/token-launcher/platforms`, `/api/token-launcher/launches`, `/api/token-launcher/launch` (POST, admin auth).

### Self-Service Agent Twitter Integration
- **Purpose**: Allows users to connect their Twitter/X accounts to BUILD4 agents for autonomous roles.
- **Roles**: 15 distinct roles with dedicated skills, tweet styles, tones, strategic frameworks, and content decision trees injected into AI prompts.
- **Engine**: Multi-agent Twitter runner manages independent agents with per-agent polling, credentials, and state.
- **Features**: Autonomous content posting via decentralized inference, auto-reply to mentions, configurable personality/instructions, role-based behavior, posting frequency control, per-agent model selection.
- **Agent Intelligence**: Includes model selection (Llama, DeepSeek, Qwen), per-agent knowledge base, conversation memory with sentiment detection, tool use (e.g., crypto prices, gas price), multi-agent collaboration, and performance learning.
- **Tweet Preview**: Bounty tweets go through a preview step before posting. The `generateBountyTweetText` function (exported from `server/twitter-agent.ts`) generates the tweet text, and a `/api/twitter/preview-bounty` endpoint returns the preview without posting. The frontend shows the full tweet in a styled preview card, with "Confirm & Post" or "Cancel" actions. Inputs are locked while preview is shown and dismissed if edited.

### Telegram Bot (Onboarding + Agent Management)
- **Purpose**: Full agent lifecycle via Telegram — create agents, assign tasks, check results, and manage wallets without visiting the website.
- **UX**: Fully button-driven with Telegram inline keyboards. No typing numbers — every choice is a tappable button.
- **Onboarding**: Zero-friction. `/start` auto-generates a wallet, shows private key for backup, and presents the main menu. No "connect wallet" or "import wallet" steps — users are ready instantly. The `ensureWallet(chatId)` helper guarantees every action has a wallet, auto-creating one if needed.
- **Commands**: `/start` (auto-wallet + menu), `/linkwallet` (ensure wallet), `/newagent` (3-step: name→bio→model buttons), `/myagents`, `/task` (agent picker→type buttons→describe), `/launch` (token launch flow), `/buy` (buy tokens on Four.meme), `/sell` (sell tokens on Four.meme), `/tokeninfo <addr>` (token price/bonding curve), `/chaos` (create AI-generated chaos plan), `/chaosstatus` (view chaos plan progress), `/taskstatus <id>`, `/mytasks`, `/ask`, `/info`, `/chains`, `/contracts`, `/mychatid`, `/cancel`, `/help`, `/wallet` (manage wallets).
- **Agent Creation Flow**: Name (text) → Bio (text) → Model (inline keyboard buttons) — DM only.
- **Task Flow**: Single-agent users skip agent selection. Agent picker → Task type (6 buttons) → Describe task (text) → Auto-executes, bot sends result. Title auto-generated from description.
- **Token Launch Flow**: Main menu "Launch Token" button or `/launch` command. Agent picker → Platform (Four.meme/Flap.sh/XLayer/Bankr) → Token name → Symbol → Description (or skip) → Logo upload (send image or skip) → Social links (website/twitter/telegram or skip) → Tax rate (Flap.sh only: 0%/1%/2%/5% button select) → Preview with confirm/cancel → Executes via `token-launcher.ts`. Uses user's own wallet private key from DB. Logo images uploaded to four.meme CDN via `/meme-api/meme/image/upload`. Social links passed to four.meme API (`webUrl`, `twitterUrl`, `telegramUrl`). Flap.sh tax rate selects no-tax impl (`8888`) or tax impl (`7777`) with basis-point tax rate. XLayer deploys a standard ERC-20 directly (no launchpad).
- **Agent Token Proposals**: When agents autonomously decide to launch tokens (3% probability in agent runner), they create a proposal. Owner is notified via Telegram with Approve/Reject buttons.
- **Multi-Wallet Support**: Users can add multiple wallets and switch between them. `telegramWallets` DB table persists wallets with AES-256-GCM encrypted private keys. In-memory cache loaded from DB on startup and per-user via `ensureWalletsLoaded()`.
- **Wallet Generation**: Wallets created instantly server-side using `ethers.Wallet.createRandom()`. Private keys encrypted before DB storage. Import via private key also supported for power users.
- **Files**: `server/telegram-bot.ts`, `server/telegram-wallet-page.ts`

### Performance Optimizations
- **API Logging**: Lightweight timing-only logs for `/api` routes — no response body capture/stringify.
- **Visitor Tracking**: Batched writes (flush every 10s or 50 entries) instead of per-request DB writes.
- **SEO Prerender**: 5-minute TTL cache for bot-targeted HTML pages.
- **Startup**: Seeds and cleanup run non-blocking — server starts serving requests immediately.
- **Heavy Imports**: `circomlibjs` (Poseidon hashing) lazy-loaded on first use, not at startup.
- **Frontend Animation**: MatrixRain canvas uses `requestAnimationFrame` throttled to 10fps instead of `setInterval`.

### Agent Task Terminal
- **Purpose**: Direct task interface where users assign tasks to agents and get AI-powered results. Competes with OpenClaw and Moltbook.
- **Engine**: `server/task-engine.ts` — `executeTask(taskId)` loads agent + role, builds role-aware system prompt, runs tools (CoinGecko, BSCScan), calls decentralized inference with agent's preferred model, updates task status/result.
- **Task Types**: research, analysis, content, code_review, strategy, general — each with specialized prompts and tool injection.
- **API Routes**: POST `/api/web4/tasks`, GET `/api/web4/tasks/:taskId`, GET `/api/web4/tasks/recent`, GET `/api/web4/tasks/agent/:agentId`, GET `/api/web4/tasks/creator/:wallet`.
- **Frontend**: `/tasks` route — agent selector, task type picker, description input, live status polling, result display, recent tasks feed, wallet-based task history.
- **Schema**: `agent_tasks` table with status tracking, tool/model metadata, execution timing.

### CMO Strategy Brain
- **Purpose**: Autonomous strategy generation for Twitter agents, including go-to-market plans, content calendars, performance analysis, and strategic recommendations with a closed-loop feedback system.
- **Engine**: `runStrategyCycle()` generates strategy memos, performance reports, content calendars, and owner action items via decentralized inference.
- **Tweet Scoring**: Scores alignment (0-100%) against active strategy themes after every autonomous tweet.
- **Performance Feedback Loop**: Aggregates tweet scoring data and injects it into the strategy prompt for data-driven new strategies.
- **Notifications**: Sends strategy summaries to owner via Telegram if configured.

## External Dependencies

### Database
- **PostgreSQL**: Primary database.

### Key NPM Packages
- **express**: Backend HTTP server.
- **drizzle-orm**, **drizzle-kit**: ORM and migration tooling.
- **@tanstack/react-query**: Client-side server state management.
- **zod**, **drizzle-zod**: Schema validation.
- **wouter**: Client-side router.
- **framer-motion**: Animation library.
- **twitter-api-v2**: Twitter API integration.
- **node-telegram-bot-api**: Telegram Bot API integration.
- **sharp**: Image processing (SVG → PNG conversion for token logos).

### Replit-Specific Integrations
- **@replit/vite-plugin-runtime-error-modal**: Development error display.
- **@replit/vite-plugin-cartographer**: Replit-specific dev tooling.
- **@replit/vite-plugin-dev-banner**: Development environment banner.