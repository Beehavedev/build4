# BUILD4

**AI agents that trade for you, across every venue that matters.**

BUILD4 is an AI-powered trading bot, accessible from Telegram and the web, that lets users delegate execution on crypto perpetual futures, prediction markets, and on-chain derivatives to autonomous agents. Each agent is a named persona with its own strategy, memory, and risk profile — users deposit funds, pick an agent, and the agent trades 24/7 on their behalf.

## What the agents do

- **Scan** market conditions, news, on-chain flows, and trending assets
- **Decide** with multi-LLM swarm voting (Anthropic, xAI, Hyperbolic, Akash) when the user opts in
- **Execute** across four venues from a single position: Aster DEX, Hyperliquid, 42.space prediction markets, Polymarket
- **Report** every decision and trade in plain English, in the user's Telegram chat and the mini-app brain feed
- **Self-limit** with daily loss circuit breakers, encrypted custodial wallets, and per-agent risk caps

## Why it matters

Most "AI trading" tools are signal services. BUILD4 is execution-native — the agent has the wallet, makes the call, and takes the trade end-to-end. Users see the reasoning before each trade and can override or pause at any time.

## Supported venues

| Venue | Type | Status |
|---|---|---|
| **Aster DEX** | Perpetual futures (BSC) | Live |
| **Hyperliquid** | Perpetual futures (HL L1) | Live |
| **42.space** | Prediction markets (BSC) | Live |
| **Polymarket** | Prediction markets (Polygon, gasless) | Live |

## How it works (user flow)

1. User opens BUILD4 in Telegram or web
2. Picks an agent persona (each has a stated strategy + risk profile)
3. Deposits USDT into their custodial wallet (BSC) or USDC into their Polymarket Safe (Polygon, no gas required)
4. Agent runs every 60 seconds — scans, decides, trades, reports
5. User can deposit, withdraw, pause, or fully take over at any time

## What's unique

- **Four-venue agent** — single agent persona trades perps, prediction markets, and on-chain markets in parallel
- **Gasless prediction markets** — Polymarket integration via Gnosis Safe + relayer; users never need MATIC
- **Multi-LLM swarm** — opt-in mode where multiple language models vote on each decision; quorum required to act
- **Reasoning-first UX** — every trade is preceded by the agent's plain-English rationale in chat
- **Real custody, real execution** — not a paper-trade demo, not a signal bot

## Built for

- Crypto-native traders who want execution while they sleep
- Prediction-market enthusiasts who want a thesis-driven agent picking markets for them
- Researchers, builders, and KOLs who want to demo what an autonomous agent can actually do on-chain

## Status

Live on Telegram, web dapp at build4.io, mini-app inside Telegram.

---

_Contact: [add socials + email before sharing]_
