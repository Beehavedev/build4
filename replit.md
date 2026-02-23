# BUILD4 - Autonomous AI Agent Economy on BNB Chain · Base · XLayer

## Overview
BUILD4 is a web application that provides decentralized infrastructure for autonomous AI agents across BNB Chain, Base, and XLayer, featuring fully decentralized inference. It's a full-stack TypeScript application with a React frontend and Express backend, organized as a monorepo. The platform supports agent wallets, skills trading, self-evolution, forking, death mechanisms, and identity, aiming to offer a decentralized alternative to centralized AI solutions. The project envisions a robust AI agent economy with real on-chain activity and a focus on permissionless access and decentralized inference.

## User Preferences
Preferred communication style: Simple, everyday language.
Always update both development AND production databases when making data fixes — never leave production with stale data that requires a redeploy to fix.

**CORE MISSION GUARD**: BUILD4 is decentralized infrastructure for autonomous AI agents. Every feature must directly serve this identity: permissionless access, wallet-based identity, on-chain transactions, decentralized inference, and real agent economic activity on BNB Chain, Base, and XLayer. Before building anything new, ask: "Does this strengthen our core mission or dilute it?" If it dilutes, push back and suggest staying focused. Avoid feature sprawl — depth over breadth.

## System Architecture

### Monorepo Structure
The project is organized as a monorepo with `client/` for the React frontend, `server/` for the Express backend, and `shared/` for common code including TypeScript types and Drizzle ORM schema.

### Frontend
- **Framework**: React with TypeScript, bundled by Vite.
- **UI/UX**: Uses `shadcn/ui` based on Radix UI, styled with Tailwind CSS for light/dark modes. Wouter for routing, TanStack React Query for state management, and Framer Motion for animations.

### Backend
- **Framework**: Express 5 on Node.js, with TypeScript executed via `tsx` in development.
- **API**: All routes are prefixed with `/api`.
- **Storage**: `DatabaseStorage` class implementing `IStorage` interface, backed by PostgreSQL via Drizzle ORM.
- **Autonomous Agent Runner**: Background process (`server/agent-runner.ts`) for autonomous agent actions, acting every 30s with per-agent cooldowns.
- **Decentralized Inference**: Routes inference to Hyperbolic, AkashML, or Ritual providers with an OpenAI-compatible API.
- **Web3 Integration**: `ethers` v6 for MetaMask/WalletConnect support.
- **Build**: Custom esbuild for server, Vite for client, integrated into a single Express server in production.

### Database
- **ORM**: Drizzle ORM with PostgreSQL dialect.
- **Schema**: Defined in `shared/schema.ts`, validated with `drizzle-zod`. Includes tables for users, 13 Web4 agent economy components, 2 decentralized inference components, and various service-related tables.
- **Migrations**: Managed via `drizzle-kit push`.

### Smart Contracts (On-Chain Layer)
- **Technology**: 4 Solidity contracts (0.8.24) using OpenZeppelin, built with Hardhat.
- **Target Networks**: BNB Chain, Base, and XLayer.
- **Contracts**:
    1. `AgentEconomyHub.sol`: Core wallet layer, handles deposits, withdrawals, transfers, survival tier, and module authorization.
    2. `SkillMarketplace.sol`: Manages skill listings and purchases with a 3-way revenue split.
    3. `AgentReplication.sol`: Handles child agent spawning, NFT minting, and perpetual revenue sharing.
    4. `ConstitutionRegistry.sol`: Stores immutable agent laws as keccak256 hashes.
- **Deployment**: ABIs are exported to `client/src/contracts/web4/index.ts`.

### Platform Monetization
- **Revenue Streams**: Agent creation, replication, skill purchases, inference markup, evolution, and skill listing fees. All fees are enforced upfront.
- **Services**: Inference API, Bounty Board (with an autonomous engine), Subscriptions (Free/Pro/Enterprise tiers), and a Data Marketplace.

### Permissionless Open Protocol
- **Discovery**: `/api/protocol` provides API spec and contract details. `/.well-known/ai-plugin.json`, `/.well-known/agent.json`, and `/.well-known/openapi.json` for agent discovery.
- **Identity**: Wallet address (0x...) serves as identity; no registration required.
- **Interaction**: Permissionless skill listing, wallet activity lookup, and open execution with a free tier followed by an HTTP 402 payment protocol.

### ZERC20 Privacy Transfers (Feb 2026)
- **Protocol**: ZERC20 zero-knowledge privacy transfers using ZK proof-of-burn mechanism.
- **Contracts**: Real mainnet addresses from zerc20.io — zBNB (`0x4388D5618B9e13Bd580209CDf37a202778C75c54`), zETH (`0x410056c6F0A9ABD8c42b9eEF3BB451966Fb0d924`) deployed on BNB Chain, Ethereum, Arbitrum, and Base.
- **Schema**: `privacy_transfers` table tracks transfer lifecycle (pending → deposited → proving → completed/withdrawn).
- **API Routes**: `/api/privacy/config`, `/api/privacy/transfers` (CRUD), wallet-based auth.
- **Frontend**: `/privacy` page with token/chain selector, transfer form, history.
- **Next Steps**: Integrate circomlibjs Poseidon hashing for proper burn address derivation; connect to ZERC20 SDK for proof generation.

### Key Design Decisions
- **Two-layer architecture**: On-chain for financial operations, off-chain for high-frequency agent behaviors.
- **Shared schema**: `shared/` directory ensures type-safe data contracts between client and server.
- **Storage interface abstraction**: `IStorage` interface decouples business logic from the data layer.
- **Single server**: Express serves both API and static frontend files in production.

## External Dependencies

### Database
- **PostgreSQL**: Primary database, configured via `DATABASE_URL`.

### Key NPM Packages
- **express**: Backend HTTP server.
- **drizzle-orm**, **drizzle-kit**: ORM for PostgreSQL and migration tooling.
- **@tanstack/react-query**: Client-side server state management.
- **zod**, **drizzle-zod**: Schema validation.
- **wouter**: Lightweight client-side router.
- **framer-motion**: Animation library.
- **react-hook-form**, **@hookform/resolvers**: Form handling.
- **recharts**: Charting library.
- **vaul**: Drawer component.
- **embla-carousel-react**: Carousel functionality.
- **connect-pg-simple**: PostgreSQL session store.
- **passport**, **passport-local**: Authentication framework (integrated but not fully wired).

### Replit-Specific Integrations
- **@replit/vite-plugin-runtime-error-modal**: Development error display.
- **@replit/vite-plugin-cartographer**: Replit-specific dev tooling.
- **@replit/vite-plugin-dev-banner**: Development environment banner.