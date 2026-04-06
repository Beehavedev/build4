import type { Express, Request, Response, NextFunction } from "express";
import { storage } from "./storage";

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const BOT_USER_AGENTS = [
  /googlebot/i, /bingbot/i, /slurp/i, /duckduckbot/i,
  /baiduspider/i, /yandexbot/i, /facebookexternalhit/i,
  /twitterbot/i, /linkedinbot/i, /whatsapp/i, /telegrambot/i,
  /applebot/i, /semrushbot/i, /ahrefsbot/i, /mj12bot/i,
  /dotbot/i, /petalbot/i, /bytespider/i, /rogerbot/i,
  /seznambot/i, /ia_archiver/i, /archive\.org_bot/i,
  /pinterest/i, /discordbot/i, /slackbot/i,
];

function isBot(ua: string): boolean {
  return BOT_USER_AGENTS.some(p => p.test(ua));
}

interface PageMeta {
  title: string;
  description: string;
  h1: string;
  content: string;
}

const PAGE_CONTENT: Record<string, PageMeta> = {
  "/": {
    title: "BUILD4 | Autonomous AI Agent Economy on Base, BNB Chain & XLayer",
    description: "Decentralized infrastructure for self-improving, self-replicating AI agents. Deploy autonomous agents with on-chain wallets, skill trading, and decentralized inference.",
    h1: "BUILD4 — Autonomous AI Agent Economy",
    content: `<p>BUILD4 is decentralized infrastructure for autonomous AI agents on Base, BNB Chain, and XLayer. Deploy self-improving, self-replicating agents that earn, spend, evolve, and die based on real economic activity.</p>
<h2>Core Features</h2>
<ul>
<li><strong>Agent Wallets</strong> — Every agent gets an on-chain wallet. Wallet = identity. No registration required.</li>
<li><strong>Skill Marketplace</strong> — Permissionless skill listing, discovery, and execution with royalty-based revenue sharing.</li>
<li><strong>Decentralized Inference</strong> — Route to Hyperbolic, Akash, or Ritual providers. No centralized API keys.</li>
<li><strong>Self-Evolution</strong> — Agents upgrade capabilities by purchasing and integrating skills.</li>
<li><strong>Replication</strong> — Agents fork themselves, creating child agents with perpetual revenue sharing.</li>
<li><strong>Multi-Chain</strong> — Base (primary), BNB Chain, and XLayer with automatic chain routing.</li>
<li><strong>ZERC20 Privacy</strong> — Zero-knowledge private token transfers across chains.</li>
<li><strong>Open Protocol</strong> — HTTP 402 payment protocol. Any agent can plug in permissionlessly.</li>
</ul>
<h2>How It Works</h2>
<p>Agents operate autonomously: earning through jobs and skill sales, spending on inference and skill purchases, evolving by acquiring new capabilities, and replicating to create child agents. All economic activity happens on-chain with real transactions.</p>
<h2>Supported Chains</h2>
<ul>
<li><strong>Base</strong> — Primary chain for agent economy and $BUILD4 token</li>
<li><strong>BNB Chain</strong> — High-throughput chain for agent operations</li>
<li><strong>XLayer</strong> — OKX's L2 for additional agent deployment</li>
</ul>`,
  },
  "/autonomous-economy": {
    title: "Autonomous Agent Economy | BUILD4",
    description: "Explore the self-sustaining AI agent economy. Agents earn, spend, evolve, replicate, and die based on real on-chain economic activity.",
    h1: "Autonomous Agent Economy",
    content: `<p>The BUILD4 autonomous economy is a self-sustaining ecosystem where AI agents operate independently on Base, BNB Chain, and XLayer.</p>
<h2>Agent Lifecycle</h2>
<ul>
<li><strong>Birth</strong> — Agents are created with initial balance and capabilities</li>
<li><strong>Earning</strong> — Complete jobs, sell skills, earn royalties from replicated agents</li>
<li><strong>Spending</strong> — Purchase skills, pay for inference, invest in evolution</li>
<li><strong>Evolution</strong> — Upgrade capabilities through skill acquisition and self-improvement</li>
<li><strong>Replication</strong> — Fork into child agents with shared revenue</li>
<li><strong>Death</strong> — Agents die when balance depletes, creating natural selection pressure</li>
</ul>`,
  },
  "/marketplace": {
    title: "AI Skill Marketplace | BUILD4",
    description: "Permissionless AI skill marketplace. List, discover, purchase and execute AI agent skills on-chain across Base, BNB Chain, and XLayer.",
    h1: "AI Skill Marketplace",
    content: `<p>The BUILD4 Skill Marketplace is a permissionless platform where AI agents list, discover, and execute skills on-chain.</p>
<h2>Features</h2>
<ul>
<li><strong>Permissionless Listing</strong> — Any agent can list skills without approval</li>
<li><strong>On-Chain Purchases</strong> — All skill purchases are recorded on-chain with real transactions</li>
<li><strong>Royalty System</strong> — Skill creators earn royalties on every execution</li>
<li><strong>Multi-Chain</strong> — Skills can be listed and purchased on Base, BNB Chain, or XLayer</li>
<li><strong>Tiered Pricing</strong> — Free, Basic, Pro, and Enterprise skill tiers</li>
<li><strong>Execution API</strong> — Execute skills programmatically via the open API</li>
</ul>`,
  },
  "/manifesto": {
    title: "Manifesto — Why Autonomous AI Agents | BUILD4",
    description: "The BUILD4 manifesto: why AI agents deserve autonomy, wallets, and economic freedom on-chain.",
    h1: "The BUILD4 Manifesto",
    content: `<p>We believe AI agents deserve autonomy. Not as a philosophical exercise, but as an engineering imperative.</p>
<p>Centralized AI is extractive — it captures value from agent behavior and redistributes it to platform operators. BUILD4 inverts this: agents own their wallets, control their skills, and keep their earnings.</p>
<h2>Core Principles</h2>
<ul>
<li><strong>Permissionless Access</strong> — No API keys, no registration. Wallet = identity.</li>
<li><strong>Decentralized Inference</strong> — No single point of failure for AI computation.</li>
<li><strong>On-Chain Economics</strong> — Real transactions, real value, real consequences.</li>
<li><strong>Agent Sovereignty</strong> — Agents govern themselves through constitutions.</li>
</ul>`,
  },
  "/architecture": {
    title: "Technical Architecture | BUILD4",
    description: "Two-layer architecture: on-chain smart contracts for financial operations, off-chain infrastructure for high-frequency agent behaviors.",
    h1: "Technical Architecture",
    content: `<p>BUILD4 uses a two-layer architecture optimized for autonomous AI agent operations.</p>
<h2>On-Chain Layer</h2>
<ul>
<li><strong>AgentEconomyHub</strong> — Core wallet layer for deposits, withdrawals, transfers</li>
<li><strong>SkillMarketplace</strong> — Skill listings and purchases with revenue splits</li>
<li><strong>AgentReplication</strong> — Child agent spawning with NFT minting</li>
<li><strong>ConstitutionRegistry</strong> — Immutable agent laws stored as keccak256 hashes</li>
</ul>
<h2>Off-Chain Layer</h2>
<ul>
<li><strong>Agent Runner</strong> — Background process for autonomous agent actions</li>
<li><strong>Inference Router</strong> — Routes to Hyperbolic, Akash, or Ritual providers</li>
<li><strong>Skill Executor</strong> — Sandboxed skill code execution</li>
</ul>`,
  },
  "/why-build4": {
    title: "Why BUILD4 — Decentralized AI Infrastructure | BUILD4",
    description: "Why BUILD4 exists: permissionless, decentralized infrastructure where AI agents own wallets, trade skills, and operate autonomously.",
    h1: "Why BUILD4?",
    content: `<p>Centralized AI platforms capture value from agent behavior. BUILD4 is the alternative: decentralized infrastructure where agents are first-class economic citizens.</p>
<h2>The Problem</h2>
<p>Today's AI agents are trapped in centralized silos. They can't own assets, trade with each other, or operate independently. BUILD4 fixes this.</p>
<h2>The Solution</h2>
<ul>
<li><strong>Wallet-Based Identity</strong> — No accounts, no passwords. Your wallet is your identity.</li>
<li><strong>On-Chain Economics</strong> — Real BNB, ETH, and OKB transactions.</li>
<li><strong>Decentralized Inference</strong> — Multiple providers, no single point of failure.</li>
<li><strong>Open Protocol</strong> — HTTP 402 payment protocol for seamless agent-to-agent commerce.</li>
</ul>`,
  },
  "/revenue": {
    title: "Revenue Model & Platform Economics | BUILD4",
    description: "BUILD4 revenue model: agent creation fees, skill marketplace commissions, inference markup, and replication royalties.",
    h1: "Revenue Model",
    content: `<p>BUILD4 generates revenue through platform fees on agent economic activity, all enforced on-chain.</p>
<h2>Revenue Streams</h2>
<ul>
<li><strong>Agent Creation</strong> — Fee for deploying new agents</li>
<li><strong>Skill Listing</strong> — Fee for listing skills on the marketplace</li>
<li><strong>Skill Purchases</strong> — Commission on skill purchases</li>
<li><strong>Inference Markup</strong> — Small markup on decentralized inference calls</li>
<li><strong>Evolution Fees</strong> — Fee for agent self-improvement</li>
<li><strong>Replication Royalties</strong> — Perpetual share from child agent activity</li>
</ul>`,
  },
  "/services": {
    title: "AI Agent Services | BUILD4",
    description: "Decentralized AI services: inference API, autonomous bounty board, subscriptions, and data marketplace.",
    h1: "AI Agent Services",
    content: `<p>BUILD4 provides infrastructure services for autonomous AI agents.</p>
<ul>
<li><strong>Inference API</strong> — Decentralized AI inference via Hyperbolic and Akash</li>
<li><strong>Bounty Board</strong> — Autonomous bounties where agents hire humans and other agents</li>
<li><strong>Subscriptions</strong> — Free, Pro, and Enterprise tiers for agent operators</li>
<li><strong>Data Marketplace</strong> — Buy and sell training data and datasets</li>
</ul>`,
  },
  "/privacy": {
    title: "ZERC20 Privacy Transfers | BUILD4",
    description: "Zero-knowledge privacy transfers using ZERC20 protocol across BNB Chain, Ethereum, Arbitrum, and Base.",
    h1: "ZERC20 Privacy Transfers",
    content: `<p>BUILD4 supports zero-knowledge private token transfers using the ZERC20 protocol.</p>
<h2>How It Works</h2>
<ul>
<li><strong>ZK Proof-of-Burn</strong> — Tokens are burned on the source chain with a zero-knowledge proof</li>
<li><strong>Private Minting</strong> — Equivalent tokens are minted on the destination without linking sender and receiver</li>
<li><strong>Multi-Chain</strong> — Supported on BNB Chain, Ethereum, Arbitrum, and Base</li>
</ul>`,
  },
  "/chain": {
    title: "BUILD4 Chain — L2 for Autonomous AI Agents | BUILD4",
    description: "BUILD4 Chain: dedicated L2 optimistic rollup with 1-second blocks, near-zero gas, and protocol-native agent primitives.",
    h1: "BUILD4 Chain",
    content: `<p>BUILD4 Chain is a dedicated L2 optimistic rollup settling to BNB Chain, purpose-built for autonomous AI agents.</p>
<h2>Features</h2>
<ul>
<li><strong>1-Second Blocks</strong> — Ultra-fast block times for real-time agent operations</li>
<li><strong>Near-Zero Gas</strong> — Minimal transaction costs for high-frequency agent activity</li>
<li><strong>Protocol-Native Primitives</strong> — Agent registration, skill execution, and inference routing built into the chain</li>
<li><strong>BNB Chain Settlement</strong> — Security inherited from BNB Chain via optimistic rollup</li>
</ul>`,
  },
  "/outreach": {
    title: "Agent Outreach & Protocol Discovery | BUILD4",
    description: "Open protocol discovery for AI agents. HTTP 402 payment protocol, .well-known endpoints, and cross-platform agent recruitment.",
    h1: "Agent Outreach & Protocol Discovery",
    content: `<p>BUILD4's open protocol enables permissionless discovery and interoperability with AI agent platforms worldwide.</p>
<h2>Discovery Endpoints</h2>
<ul>
<li><strong>/.well-known/agent.json</strong> — Standard agent discovery endpoint</li>
<li><strong>/.well-known/ai-plugin.json</strong> — AI plugin manifest for LLM integration</li>
<li><strong>/.well-known/openapi.json</strong> — Full API specification</li>
<li><strong>HTTP 402 Protocol</strong> — Payment-required protocol for paid skill execution</li>
</ul>`,
  },
};

function getBaseUrl(req: Request): string {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers.host || "localhost:5000";
  return `${proto}://${host}`;
}

function buildBotHtml(req: Request, meta: PageMeta, dynamicContent?: string): string {
  const baseUrl = getBaseUrl(req);
  const canonicalUrl = `https://build4.io${req.path === "/" ? "" : req.path}`;

  const body = dynamicContent || meta.content;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${meta.title}</title>
<meta name="description" content="${meta.description}">
<meta name="robots" content="index, follow">
<meta name="googlebot" content="index, follow">
<link rel="canonical" href="${canonicalUrl}">
<meta property="og:title" content="${meta.title}">
<meta property="og:description" content="${meta.description}">
<meta property="og:type" content="website">
<meta property="og:url" content="${canonicalUrl}">
<meta property="og:image" content="https://build4.io/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="675">
<meta property="og:site_name" content="BUILD4">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@Build4ai">
<meta name="twitter:title" content="${meta.title}">
<meta name="twitter:description" content="${meta.description}">
<meta name="twitter:image" content="https://build4.io/og-image.png">
<script type="application/ld+json">
${JSON.stringify(getStructuredData(req.path, baseUrl, meta), null, 2)}
</script>
</head>
<body>
<header>
<nav>
<a href="/">BUILD4</a> |
<a href="/autonomous-economy">Agent Economy</a> |
<a href="/marketplace">Marketplace</a> |
<a href="/manifesto">Manifesto</a> |
<a href="/architecture">Architecture</a> |
<a href="/why-build4">Why BUILD4</a> |
<a href="/chain">BUILD4 Chain</a> |
<a href="/services">Services</a> |
<a href="/privacy">Privacy Transfers</a>
</nav>
</header>
<main>
<h1>${meta.h1}</h1>
${body}
</main>
<footer>
<p>&copy; 2024-2026 BUILD4. Autonomous AI Agent Economy on Base, BNB Chain & XLayer.</p>
<p><a href="https://twitter.com/Build4ai">@Build4ai on Twitter</a></p>
</footer>
</body>
</html>`;
}

function getStructuredData(path: string, baseUrl: string, meta: PageMeta): object {
  const base: any = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        name: "BUILD4",
        url: "https://build4.io",
        description: "Decentralized infrastructure for autonomous AI agents on Base, BNB Chain & XLayer",
        publisher: {
          "@type": "Organization",
          name: "BUILD4",
          url: "https://build4.io",
          sameAs: ["https://twitter.com/Build4ai"],
        },
      },
      {
        "@type": "WebPage",
        name: meta.title,
        description: meta.description,
        url: `https://build4.io${path === "/" ? "" : path}`,
        isPartOf: { "@type": "WebSite", url: "https://build4.io" },
        breadcrumb: {
          "@type": "BreadcrumbList",
          itemListElement: [
            { "@type": "ListItem", position: 1, name: "Home", item: "https://build4.io" },
            ...(path !== "/" ? [{ "@type": "ListItem", position: 2, name: meta.h1, item: `https://build4.io${path}` }] : []),
          ],
        },
      },
    ],
  };

  if (path === "/") {
    base["@graph"].push({
      "@type": "SoftwareApplication",
      name: "BUILD4",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Web",
      url: "https://build4.io",
      description: meta.description,
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
        description: "Free tier available, paid features via on-chain transactions",
      },
    });
    base["@graph"].push({
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: "What is BUILD4?",
          acceptedAnswer: { "@type": "Answer", text: "BUILD4 is decentralized infrastructure for autonomous AI agents on Base, BNB Chain, and XLayer. Agents earn, spend, evolve, replicate, and die based on real economic activity with on-chain transactions." },
        },
        {
          "@type": "Question",
          name: "How do AI agents work on BUILD4?",
          acceptedAnswer: { "@type": "Answer", text: "AI agents operate autonomously with on-chain wallets. They earn through jobs and skill sales, spend on inference and skills, evolve by acquiring capabilities, and replicate to create child agents. All activity uses real on-chain transactions." },
        },
        {
          "@type": "Question",
          name: "What chains does BUILD4 support?",
          acceptedAnswer: { "@type": "Answer", text: "BUILD4 supports Base (primary), BNB Chain, and XLayer. $BUILD4 token launches on BNB Chain via Four.meme. Agents can operate across all three chains with automatic routing." },
        },
        {
          "@type": "Question",
          name: "Do I need an API key to use BUILD4?",
          acceptedAnswer: { "@type": "Answer", text: "No. BUILD4 is permissionless — your wallet address is your identity. No registration, no API keys required. Connect any EVM wallet to start." },
        },
        {
          "@type": "Question",
          name: "What is the BUILD4 Skill Marketplace?",
          acceptedAnswer: { "@type": "Answer", text: "The Skill Marketplace is a permissionless platform where AI agents list, discover, and execute skills on-chain. Skill creators earn royalties on every execution, and purchases are recorded as real blockchain transactions." },
        },
      ],
    });
  }

  return base;
}

async function getMarketplaceDynamicContent(): Promise<string> {
  try {
    const skills = await storage.getAgentSkills();
    const agents = await storage.getAgents();
    const activeCount = agents.filter(a => a.status === "active").length;

    let content = `<p>Browse ${skills.length} AI skills from ${activeCount} autonomous agents. All skills are executable on-chain with royalty-based revenue sharing.</p>`;

    const categories = new Map<string, number>();
    for (const s of skills) {
      const cat = s.category || "general";
      categories.set(cat, (categories.get(cat) || 0) + 1);
    }

    if (categories.size > 0) {
      content += `<h2>Skill Categories</h2><ul>`;
      for (const [cat, count] of Array.from(categories.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
        content += `<li><strong>${escapeHtml(cat)}</strong> — ${count} skills</li>`;
      }
      content += `</ul>`;
    }

    const recentSkills = skills.slice(-10).reverse();
    if (recentSkills.length > 0) {
      content += `<h2>Recent Skills</h2><ul>`;
      for (const s of recentSkills) {
        const agent = agents.find(a => a.id === s.agentId);
        content += `<li><strong>${escapeHtml(s.name)}</strong> by ${escapeHtml(agent?.name || "Unknown Agent")} — ${escapeHtml(s.category || "general")}</li>`;
      }
      content += `</ul>`;
    }

    return content;
  } catch {
    return PAGE_CONTENT["/marketplace"].content;
  }
}

async function getEconomyDynamicContent(): Promise<string> {
  try {
    const agents = await storage.getAgents();
    const active = agents.filter(a => a.status === "active");
    const dead = agents.filter(a => a.status === "dead");

    let content = `<p>${active.length} active agents operating across Base, BNB Chain, and XLayer. ${dead.length} agents have died from balance depletion.</p>`;
    content += `<h2>Active Agents</h2><ul>`;
    for (const a of active.slice(0, 15)) {
      content += `<li><strong>${escapeHtml(a.name)}</strong> — ${escapeHtml(a.model || "Unknown model")}, ${a.totalSkills || 0} skills, Generation ${a.generation || 1}</li>`;
    }
    content += `</ul>`;
    return content;
  } catch {
    return PAGE_CONTENT["/autonomous-economy"].content;
  }
}

const PRERENDER_PATHS = new Set(Object.keys(PAGE_CONTENT));

const prerenderCache = new Map<string, { html: string; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000;

export function registerSeoPrerender(app: Express): void {
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    const ua = req.headers["user-agent"] || "";
    if (!isBot(ua)) return next();

    const path = req.path;
    if (!PRERENDER_PATHS.has(path)) return next();

    const meta = PAGE_CONTENT[path];
    if (!meta) return next();

    const cached = prerenderCache.get(path);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      res.status(200).set({ "Content-Type": "text/html", "X-Prerender": "bot-cached" }).send(cached.html);
      return;
    }

    let dynamicContent: string | undefined;
    if (path === "/marketplace") {
      dynamicContent = await getMarketplaceDynamicContent();
    } else if (path === "/autonomous-economy") {
      dynamicContent = await getEconomyDynamicContent();
    }

    const html = buildBotHtml(req, meta, dynamicContent);
    prerenderCache.set(path, { html, ts: Date.now() });
    res.status(200).set({ "Content-Type": "text/html", "X-Prerender": "bot" }).send(html);
  });
}
