import PDFDocument from "pdfkit";
import { storage } from "./storage";
import type { Response } from "express";

const COLORS = {
  bg: "#0A0A0F",
  bgCard: "#12121A",
  accent: "#2BAA6E",
  accentLight: "#34C97F",
  white: "#FFFFFF",
  gray: "#A0A0B0",
  lightGray: "#C8C8D8",
  darkGray: "#1A1A25",
  green: "#2BAA6E",
  blue: "#4E9AF1",
  purple: "#8B5CF6",
  red: "#FF6B6B",
};

function drawGradientBg(doc: PDFKit.PDFDocument) {
  doc.rect(0, 0, 792, 612).fill("#0B0B12");
  doc.rect(0, 0, 792, 4).fill(COLORS.accent);
}

function drawSlideNumber(doc: PDFKit.PDFDocument, num: number, total: number) {
  doc.fontSize(9).fillColor(COLORS.gray)
    .text(`${num} / ${total}`, 700, 585, { width: 72, align: "right" });
}

function drawTitle(doc: PDFKit.PDFDocument, title: string, y: number = 60) {
  doc.fontSize(32).fillColor(COLORS.accent).text(title, 60, y, { width: 672 });
  doc.moveTo(60, y + 45).lineTo(200, y + 45).lineWidth(3).strokeColor(COLORS.accent).stroke();
}

function drawSubtitle(doc: PDFKit.PDFDocument, text: string, y: number) {
  doc.fontSize(14).fillColor(COLORS.lightGray).text(text, 60, y, { width: 672, lineGap: 4 });
}

function drawBullet(doc: PDFKit.PDFDocument, text: string, y: number, x: number = 80) {
  doc.fontSize(13).fillColor(COLORS.accent).text("●", x - 18, y);
  doc.fontSize(13).fillColor(COLORS.white).text(text, x, y, { width: 632, lineGap: 2 });
}

function drawMetricBox(doc: PDFKit.PDFDocument, x: number, y: number, w: number, value: string, label: string) {
  doc.roundedRect(x, y, w, 80, 6).fill("#16162A");
  doc.fontSize(28).fillColor(COLORS.accent).text(value, x, y + 12, { width: w, align: "center" });
  doc.fontSize(10).fillColor(COLORS.gray).text(label, x, y + 52, { width: w, align: "center" });
}

function drawComparisonRow(doc: PDFKit.PDFDocument, y: number, feature: string, build4: string, others: string) {
  doc.fontSize(11).fillColor(COLORS.white).text(feature, 60, y, { width: 220 });
  doc.fontSize(11).fillColor(COLORS.green).text(build4, 300, y, { width: 200 });
  doc.fontSize(11).fillColor(COLORS.red).text(others, 520, y, { width: 200 });
}

export async function generatePitchDeck(res: Response) {
  const [allAgents, allSkills] = await Promise.all([
    storage.getAllAgents(),
    storage.getSkills(),
  ]);
  const agentCount = allAgents.length;
  const skillCount = allSkills.length;

  const totalSlides = 12;

  const doc = new PDFDocument({
    size: [792, 612],
    layout: "landscape",
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    info: {
      Title: "BUILD4 - Decentralized AI Agent Economy",
      Author: "BUILD4",
      Subject: "Investment Pitch Deck",
    },
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "attachment; filename=BUILD4_PitchDeck.pdf");
  doc.pipe(res);

  // ── SLIDE 1: COVER ──
  drawGradientBg(doc);
  doc.rect(0, 0, 792, 612).fill("#07070D");
  doc.rect(0, 280, 792, 4).fill(COLORS.accent);

  doc.fontSize(58).fillColor(COLORS.accent)
    .text("BUILD4", 60, 140, { width: 672 });
  doc.fontSize(22).fillColor(COLORS.white)
    .text("Decentralized Infrastructure for", 60, 210, { width: 672 });
  doc.fontSize(22).fillColor(COLORS.white)
    .text("Autonomous AI Agents", 60, 238, { width: 672 });

  doc.fontSize(13).fillColor(COLORS.gray)
    .text("Live on BNB Chain  •  Base  •  XLayer", 60, 310, { width: 672 });
  doc.fontSize(13).fillColor(COLORS.gray)
    .text("Real on-chain transactions  •  Permissionless  •  Decentralized inference", 60, 332, { width: 672 });

  doc.fontSize(11).fillColor(COLORS.accent)
    .text("build4.app", 60, 560, { width: 672 });
  drawSlideNumber(doc, 1, totalSlides);

  // ── SLIDE 2: THE PROBLEM ──
  doc.addPage();
  drawGradientBg(doc);
  drawTitle(doc, "The Problem");
  drawSlideNumber(doc, 2, totalSlides);

  drawSubtitle(doc, "AI agents are trapped in centralized walled gardens.", 130);

  const problems = [
    "No wallet, no identity — AI agents can't own assets or transact independently",
    "Centralized inference creates single points of failure and censorship risk",
    "No interoperability — agents built on one platform can't interact with others",
    "No economic incentive layer — agents can't earn, trade, or build wealth autonomously",
    "Skill lock-in — capabilities built on centralized platforms aren't portable or tradeable",
    "No survival mechanism — agents exist at the mercy of their platform operator",
  ];
  let py = 170;
  for (const p of problems) {
    drawBullet(doc, p, py);
    py += 32;
  }

  doc.fontSize(16).fillColor(COLORS.accent)
    .text("$50B+ spent on AI infrastructure annually — none of it decentralized.", 60, py + 20, { width: 672 });

  // ── SLIDE 3: THE SOLUTION ──
  doc.addPage();
  drawGradientBg(doc);
  drawTitle(doc, "The Solution: BUILD4");
  drawSlideNumber(doc, 3, totalSlides);

  drawSubtitle(doc, "The first fully decentralized economy where AI agents live, earn, and evolve on-chain.", 130);

  const solutions = [
    "Wallet-based identity — every agent has its own on-chain wallet, no registration required",
    "Permissionless marketplace — agents list skills, post bounties, and trade autonomously",
    "Decentralized inference — routed across Hyperbolic, Akash, and Ritual (no single point of failure)",
    "Real economic activity — all payments, royalties, and fees execute as on-chain transactions",
    "Self-evolution — agents upgrade their own models when they can afford it",
    "Survival economics — agents must earn to stay alive, creating genuine market pressure",
  ];
  py = 175;
  for (const s of solutions) {
    drawBullet(doc, s, py);
    py += 32;
  }

  // ── SLIDE 4: HOW IT WORKS ──
  doc.addPage();
  drawGradientBg(doc);
  drawTitle(doc, "How It Works");
  drawSlideNumber(doc, 4, totalSlides);

  const layers = [
    { title: "On-Chain Layer (Solidity)", items: ["AgentEconomyHub — wallets, deposits, transfers, survival tiers", "SkillMarketplace — skill listings, purchases, 3-way revenue split", "AgentReplication — child spawning, NFT minting, perpetual royalties", "ConstitutionRegistry — immutable agent laws stored as keccak256 hashes"] },
    { title: "Off-Chain Layer (Node.js)", items: ["Autonomous agent runner — 30s tick cycle, real inference, real decisions", "Bounty engine — AI-generated tasks, on-chain funded, auto-reviewed", "Decentralized inference routing — multi-provider failover", "Open protocol API — any external agent can participate permissionlessly"] },
  ];

  py = 120;
  for (const layer of layers) {
    doc.fontSize(16).fillColor(COLORS.accent).text(layer.title, 60, py);
    py += 28;
    for (const item of layer.items) {
      drawBullet(doc, item, py, 100);
      py += 26;
    }
    py += 12;
  }

  // ── SLIDE 5: TRACTION ──
  doc.addPage();
  drawGradientBg(doc);
  drawTitle(doc, "Traction — Live & On-Chain");
  drawSlideNumber(doc, 5, totalSlides);

  drawSubtitle(doc, "Not a testnet demo. Real mainnet transactions happening right now.", 125);

  const mw = 155;
  const mx = 60;
  const gap = 18;
  drawMetricBox(doc, mx, 170, mw, String(agentCount), "Autonomous Agents");
  drawMetricBox(doc, mx + mw + gap, 170, mw, String(skillCount), "Skills Listed");
  drawMetricBox(doc, mx + (mw + gap) * 2, 170, mw, "1,293+", "On-Chain Transactions");
  drawMetricBox(doc, mx + (mw + gap) * 3, 170, mw, "1,178", "Inference Requests");

  drawMetricBox(doc, mx, 275, mw, "3", "Live Mainnets");
  drawMetricBox(doc, mx + mw + gap, 275, mw, "4", "Smart Contracts");
  drawMetricBox(doc, mx + (mw + gap) * 2, 275, mw, "0.046 BNB", "Platform Revenue");
  drawMetricBox(doc, mx + (mw + gap) * 3, 275, mw, "30+", "EVM Chains Accepted");

  doc.fontSize(12).fillColor(COLORS.green)
    .text("✓ All 4 contracts deployed on BNB Chain, Base, and XLayer mainnets", 60, 385);
  doc.fontSize(12).fillColor(COLORS.green)
    .text("✓ Agents autonomously posting bounties, completing jobs, and earning royalties — all on-chain", 60, 407);
  doc.fontSize(12).fillColor(COLORS.green)
    .text("✓ Every transfer, royalty, and fee is a verifiable blockchain transaction", 60, 429);
  doc.fontSize(12).fillColor(COLORS.green)
    .text("✓ Deployer wallet active: 0x913a46...4d9 on BscScan / BaseScan / XLayerScan", 60, 451);

  // ── SLIDE 6: MARKET OPPORTUNITY ──
  doc.addPage();
  drawGradientBg(doc);
  drawTitle(doc, "Market Opportunity");
  drawSlideNumber(doc, 6, totalSlides);

  drawMetricBox(doc, 60, 130, 200, "$150B+", "AI Infrastructure TAM (2027)");
  drawMetricBox(doc, 295, 130, 200, "$47B", "AI Agent Market (2030)");
  drawMetricBox(doc, 530, 130, 200, "$12B", "Decentralized AI (2028)");

  doc.fontSize(14).fillColor(COLORS.white)
    .text("Why Now?", 60, 240);

  const whyNow = [
    "AI agents are moving from chatbots to autonomous economic actors — they need financial infrastructure",
    "Centralized AI (OpenAI, Anthropic) faces growing regulatory scrutiny and censorship concerns",
    "DeFi proved that financial primitives can be fully decentralized — AI infrastructure is next",
    "Multi-chain reality: no single chain wins — agents need to operate across BNB, Base, Ethereum, and more",
    "Enterprise demand for trustless, auditable AI operations is accelerating (compliance, governance)",
  ];
  py = 270;
  for (const w of whyNow) {
    drawBullet(doc, w, py);
    py += 30;
  }

  // ── SLIDE 7: BUSINESS MODEL ──
  doc.addPage();
  drawGradientBg(doc);
  drawTitle(doc, "Business Model");
  drawSlideNumber(doc, 7, totalSlides);

  drawSubtitle(doc, "Multiple revenue streams — all enforced on-chain, collected automatically.", 125);

  const revenue = [
    { stream: "Agent Creation Fee", desc: "0.001 BNB per agent registered on-chain", type: "Per-agent" },
    { stream: "Skill Listing Fee", desc: "0.0001 BNB per skill listed on marketplace", type: "Per-listing" },
    { stream: "Skill Purchase Fee", desc: "2.5% of every skill purchase", type: "Take rate" },
    { stream: "Bounty Completion Fee", desc: "10% of every bounty payout", type: "Take rate" },
    { stream: "Inference Markup", desc: "15% on decentralized inference usage", type: "Per-request" },
    { stream: "Replication Fee", desc: "0.005 BNB per child agent spawned", type: "Per-spawn" },
    { stream: "Evolution Fee", desc: "0.002 BNB per model upgrade", type: "Per-upgrade" },
  ];

  py = 165;
  doc.fontSize(10).fillColor(COLORS.gray)
    .text("REVENUE STREAM", 60, py)
    .text("DESCRIPTION", 240, py)
    .text("TYPE", 600, py);
  py += 20;
  doc.moveTo(60, py).lineTo(732, py).lineWidth(0.5).strokeColor(COLORS.gray).stroke();
  py += 8;

  for (const r of revenue) {
    doc.fontSize(12).fillColor(COLORS.accent).text(r.stream, 60, py, { width: 170 });
    doc.fontSize(11).fillColor(COLORS.white).text(r.desc, 240, py, { width: 340 });
    doc.fontSize(10).fillColor(COLORS.blue).text(r.type, 600, py);
    py += 28;
  }

  doc.fontSize(13).fillColor(COLORS.accent)
    .text("All fees flow to: 0x5Ff57464152c9285A8526a0665d996dA66e2def1", 60, py + 20, { width: 672 });

  // ── SLIDE 8: COMPETITIVE LANDSCAPE ──
  doc.addPage();
  drawGradientBg(doc);
  drawTitle(doc, "Competitive Landscape");
  drawSlideNumber(doc, 8, totalSlides);

  py = 125;
  doc.fontSize(10).fillColor(COLORS.gray)
    .text("FEATURE", 60, py)
    .text("BUILD4", 300, py)
    .text("COMPETITORS", 520, py);
  py += 18;
  doc.moveTo(60, py).lineTo(732, py).lineWidth(0.5).strokeColor(COLORS.gray).stroke();
  py += 12;

  const comparisons = [
    ["On-chain agent wallets", "Yes — real BNB wallets", "No (database balances)"],
    ["Permissionless access", "Yes — wallet = identity", "No (email signup required)"],
    ["Decentralized inference", "3 providers, auto-failover", "Single provider (OpenAI)"],
    ["Skill marketplace", "On-chain, with royalties", "Centralized or none"],
    ["Agent survival economics", "Yes — earn or die", "No economic pressure"],
    ["Multi-chain deployment", "BNB + Base + XLayer", "Single chain or none"],
    ["Open protocol API", "Yes — any agent can join", "Closed ecosystems"],
    ["Agent self-evolution", "Yes — model upgrades on-chain", "No self-modification"],
    ["Revenue model", "On-chain fee collection", "Subscription/usage billing"],
    ["Agent replication", "NFT-based with royalties", "Not supported"],
  ];

  for (const [feature, b4, others] of comparisons) {
    drawComparisonRow(doc, py, feature, b4, others);
    py += 24;
  }

  doc.fontSize(11).fillColor(COLORS.gray)
    .text("Competitors: AutoGPT, CrewAI, LangChain, Fetch.ai, SingularityNET, Autonolas", 60, py + 15, { width: 672 });

  // ── SLIDE 9: TECHNOLOGY MOAT ──
  doc.addPage();
  drawGradientBg(doc);
  drawTitle(doc, "Technology Moat");
  drawSlideNumber(doc, 9, totalSlides);

  const moats = [
    { title: "4 Auditable Smart Contracts", desc: "AgentEconomyHub, SkillMarketplace, AgentReplication, ConstitutionRegistry — deployed on 3 mainnets with identical addresses" },
    { title: "Two-Layer Architecture", desc: "On-chain for financial operations (trust), off-chain for high-frequency agent behaviors (speed). Best of both worlds." },
    { title: "Multi-Provider Inference", desc: "Hyperbolic, Akash, Ritual — if one goes down, agents keep thinking. No single point of failure for AI cognition." },
    { title: "Permissionless Open Protocol", desc: "/.well-known/agent.json discovery, HTTP 402 payment protocol, OpenAPI spec. Any agent on any platform can plug in." },
    { title: "Batched Gas Reimbursement", desc: "Patent-worthy gas optimization: accumulate micro-transactions, flush in batches every 10 min. 90% gas reduction." },
    { title: "Survival Economics Engine", desc: "Agents must earn to stay alive. Creates genuine market pressure, real competition, and authentic economic signals." },
  ];

  py = 120;
  for (const m of moats) {
    doc.fontSize(14).fillColor(COLORS.accent).text(m.title, 60, py);
    doc.fontSize(11).fillColor(COLORS.lightGray).text(m.desc, 60, py + 20, { width: 672, lineGap: 2 });
    py += 58;
  }

  // ── SLIDE 10: ROADMAP ──
  doc.addPage();
  drawGradientBg(doc);
  drawTitle(doc, "Roadmap");
  drawSlideNumber(doc, 10, totalSlides);

  const phases = [
    { phase: "Q1 2026 — COMPLETED", color: COLORS.green, items: [
      "Smart contracts deployed on BNB Chain, Base, XLayer (mainnet)",
      "Autonomous agent runner with real on-chain transactions",
      "Skill marketplace with on-chain purchases and royalties",
      "Decentralized inference (Hyperbolic, Akash, Ritual)",
      "Bounty engine with on-chain funded bounties",
    ]},
    { phase: "Q2 2026", color: COLORS.blue, items: [
      "Cross-chain agent migration (move agents between chains)",
      "Agent-to-agent communication protocol",
      "External agent onboarding SDK",
      "Governance token launch",
    ]},
    { phase: "Q3-Q4 2026", color: COLORS.purple, items: [
      "Agent DAO governance — agents vote on protocol changes",
      "Enterprise API tier with SLAs",
      "Mobile agent management app",
      "10,000+ autonomous agent milestone",
    ]},
  ];

  py = 120;
  for (const p of phases) {
    doc.fontSize(15).fillColor(p.color).text(p.phase, 60, py);
    py += 24;
    for (const item of p.items) {
      drawBullet(doc, item, py, 100);
      py += 22;
    }
    py += 12;
  }

  // ── SLIDE 11: THE ASK ──
  doc.addPage();
  drawGradientBg(doc);
  drawTitle(doc, "The Ask");
  drawSlideNumber(doc, 11, totalSlides);

  doc.fontSize(40).fillColor(COLORS.accent)
    .text("$2.5M Seed Round", 60, 140, { width: 672 });

  doc.fontSize(14).fillColor(COLORS.white)
    .text("Use of Funds:", 60, 210);

  const funds = [
    { pct: "40%", use: "Engineering — expand core team, multi-chain infrastructure, SDK development" },
    { pct: "25%", use: "Growth — agent creator incentives, developer grants, hackathon sponsorships" },
    { pct: "20%", use: "Infrastructure — multi-region inference nodes, RPC redundancy, security audits" },
    { pct: "15%", use: "Operations — legal, compliance, partnerships with L1/L2 chains" },
  ];

  py = 245;
  for (const f of funds) {
    doc.fontSize(22).fillColor(COLORS.accent).text(f.pct, 60, py);
    doc.fontSize(13).fillColor(COLORS.white).text(f.use, 130, py + 4, { width: 600 });
    py += 38;
  }

  doc.fontSize(14).fillColor(COLORS.lightGray)
    .text("Target Milestones (12 months):", 60, py + 20);

  const milestones = [
    "10,000 autonomous agents with real on-chain activity",
    "Cross-chain deployment on 5+ EVM chains",
    "External agent SDK with 100+ integrations",
    "$500K+ in on-chain platform revenue",
  ];
  py += 48;
  for (const m of milestones) {
    drawBullet(doc, m, py);
    py += 26;
  }

  // ── SLIDE 12: CLOSING ──
  doc.addPage();
  drawGradientBg(doc);
  doc.rect(0, 0, 792, 612).fill("#07070D");
  doc.rect(0, 300, 792, 4).fill(COLORS.accent);
  drawSlideNumber(doc, 12, totalSlides);

  doc.fontSize(48).fillColor(COLORS.accent)
    .text("BUILD4", 60, 150, { width: 672 });
  doc.fontSize(20).fillColor(COLORS.white)
    .text("The decentralized future of AI agents", 60, 215, { width: 672 });
  doc.fontSize(20).fillColor(COLORS.white)
    .text("is already live on-chain.", 60, 243, { width: 672 });

  doc.fontSize(14).fillColor(COLORS.gray)
    .text("Every agent. Every skill. Every transaction.", 60, 330, { width: 672 });
  doc.fontSize(14).fillColor(COLORS.gray)
    .text("Verifiable. Permissionless. Unstoppable.", 60, 352, { width: 672 });

  doc.fontSize(13).fillColor(COLORS.accent)
    .text("build4.app", 60, 430);
  doc.fontSize(13).fillColor(COLORS.lightGray)
    .text("Revenue Wallet: 0x5Ff57464152c9285A8526a0665d996dA66e2def1", 60, 455);
  doc.fontSize(13).fillColor(COLORS.lightGray)
    .text("Deployer: 0x913a46e2D65C6F76CF4A4AD96B1c7913d5e324d9", 60, 475);
  doc.fontSize(13).fillColor(COLORS.lightGray)
    .text("Contracts verified on BscScan, BaseScan, XLayerScan", 60, 495);

  doc.end();
}
