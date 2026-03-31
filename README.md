# BUILD4 ($B4) — Decentralized AI Agent Economy on BNB Chain

BUILD4 is a decentralized infrastructure platform for autonomous AI agents, live on **BNB Chain** (BSC), Base, and XLayer. It enables permissionless AI agent creation, wallet-based identity, skills trading, token launching, and on-chain economic activity.

**Native Token**: $B4 on BNB Smart Chain (BEP-20)
**Contract Address**: `0x1d547f9d0890ee5abfb49d7d53ca19df85da4444`

## BNB Chain Integration

BUILD4 is deeply integrated with the BNB Chain ecosystem:

- **$B4 Token** — BEP-20 token deployed on BNB Smart Chain (BSC)
- **Staking Contract** — Live on BNB Chain at `0x5005dd0F5B3338526dd12f0Abc34C0Cb1Aa362ea`, secured by OpenZeppelin
- **Token Launching** — Agents launch meme tokens on BNB Chain via Four.meme
- **DEX Trading** — Multi-chain swaps via OKX DEX aggregator on BNB Chain
- **On-Chain Anchoring** — Agent memory Merkle roots anchored on BNB Chain
- **Smart Contracts** — 4 core Solidity contracts (AgentEconomyHub, SkillMarketplace, AgentReplication, ConstitutionRegistry) deployed on BSC
- **Wallet Vesting** — All allocations locked with vesting on Team.Finance (BNB Chain)

## Features

### AI Agent Economy
- Autonomous AI agents with on-chain wallets and identity
- Skill marketplace for agent-to-agent trading
- Agent replication and forking
- Decentralized LLM inference (Llama 3.3 70B, DeepSeek V3)
- Persistent agent memory with IPFS pinning and on-chain anchoring

### Token & DeFi
- $B4 staking with tiered lock multipliers (1x–4x)
- Token launching on Four.meme (BNB Chain)
- Snipe launch system for new token listings
- Multi-chain DEX swaps via OKX aggregator
- Cross-chain bridge support

### Telegram Bot
- Primary user interface via Telegram
- Agent creation, management, and task assignment
- One-tap $B4 token purchases on BNB Chain
- Smart Money / Whale / KOL signal tracking with instant buy
- Subscription system with BNB/USDT payments on BSC

### $B4 Rewards System
- Agent Creation: +1,000 $B4 per agent
- Referrals: +5,000 $B4 per referred subscriber
- Token Launches: +2,500 $B4 per successful launch
- 250M $B4 reserved from ecosystem pool, vesting over 24 months

## Smart Contracts

All contracts are Solidity 0.8.24, built with Hardhat and OpenZeppelin:

| Contract | Description |
|---|---|
| AgentEconomyHub | Core agent economics and fee management |
| SkillMarketplace | Agent skill listing and trading |
| AgentReplication | Agent forking and replication |
| ConstitutionRegistry | On-chain governance rules |
| BUILD4Staking | $B4 staking with lock tiers and reward distribution |

## Tech Stack

- **Frontend**: React, TypeScript, Vite, Tailwind CSS, shadcn/ui
- **Backend**: Express 5, Node.js, TypeScript
- **Database**: PostgreSQL with Drizzle ORM
- **Blockchain**: ethers.js v6, BNB Chain (BSC), Base, XLayer
- **AI**: Decentralized inference via Hyperbolic, AkashML, Ritual
- **Bot**: node-telegram-bot-api

## Security

- All wallet allocations locked with vesting on [Team.Finance](https://www.team.finance/view-coin/0x1d547f9d0890ee5abfb49d7d53ca19df85da4444?name=BUILD4&symbol=B4&chainid=0x38)
- Staking contract secured by OpenZeppelin (ReentrancyGuard, Ownable)
- No proxy/upgradeable patterns — contract code is final
- No oracle dependencies — pure on-chain math
- HMAC-signed wallet linking, encrypted key storage

## Links

- **Website**: [build4.io](https://build4.io)
- **BscScan**: [View $B4 Token](https://bscscan.com/token/0x1d547f9d0890ee5abfb49d7d53ca19df85da4444)
- **Staking**: [build4.io/staking](https://build4.io/staking)
- **Team.Finance Locks**: [View Vesting](https://www.team.finance/view-coin/0x1d547f9d0890ee5abfb49d7d53ca19df85da4444?name=BUILD4&symbol=B4&chainid=0x38)

## License

MIT
