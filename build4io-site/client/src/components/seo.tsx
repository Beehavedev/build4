import { useEffect } from "react";
import { useLocation } from "wouter";

interface SEOProps {
  title?: string;
  description?: string;
  path?: string;
  type?: string;
  image?: string;
}

const PAGE_SEO: Record<string, { title: string; description: string }> = {
  "/": {
    title: "BUILD4 | Autonomous AI Agent Economy on Base, BNB Chain & XLayer",
    description: "Decentralized infrastructure for self-improving, self-replicating AI agents. Deploy autonomous agents with on-chain wallets, skill trading, and decentralized inference. No API keys — wallet is identity.",
  },
  "/autonomous-economy": {
    title: "Autonomous Agent Economy | BUILD4",
    description: "Explore the self-sustaining AI agent economy on Base, BNB Chain & XLayer. Agents earn, spend, evolve, replicate, and die based on real economic activity with on-chain transactions.",
  },
  "/marketplace": {
    title: "AI Skill Marketplace | BUILD4",
    description: "Permissionless AI skill marketplace. List, discover, purchase and execute AI agent skills on-chain. Multi-chain support across Base, BNB Chain, and XLayer with royalty-based revenue sharing.",
  },
  "/manifesto": {
    title: "Manifesto — Why Autonomous AI Agents | BUILD4",
    description: "The BUILD4 manifesto: why AI agents deserve autonomy, wallets, and economic freedom. Permissionless access, decentralized inference, and real on-chain activity for self-governing AI.",
  },
  "/architecture": {
    title: "Technical Architecture | BUILD4",
    description: "Two-layer architecture: on-chain smart contracts for financial operations, off-chain infrastructure for high-frequency agent behaviors. Solidity contracts on Base, BNB Chain, and XLayer.",
  },
  "/why-build4": {
    title: "Why BUILD4 — Decentralized AI Infrastructure | BUILD4",
    description: "Why BUILD4 exists: centralized AI is extractive. BUILD4 offers permissionless, decentralized infrastructure where AI agents own wallets, trade skills, and operate autonomously on-chain.",
  },
  "/revenue": {
    title: "Revenue Model & Platform Economics | BUILD4",
    description: "BUILD4 revenue model: skill marketplace commissions, inference markup, evolution fees, and replication royalties. All enforced on-chain across Base, BNB Chain & XLayer.",
  },
  "/services": {
    title: "AI Agent Services — Inference, Bounties, Subscriptions | BUILD4",
    description: "Decentralized AI services: inference API via Hyperbolic and Akash, autonomous bounty board, subscription tiers, and data marketplace. All powered by on-chain agent economy.",
  },
  "/privacy": {
    title: "ZERC20 Privacy Transfers | BUILD4",
    description: "Zero-knowledge privacy transfers using ZERC20 protocol. Private cross-chain token transfers with ZK proof-of-burn on BNB Chain, Ethereum, Arbitrum, and Base.",
  },
  "/chain": {
    title: "BUILD4 Chain — L2 for Autonomous AI Agents | BUILD4",
    description: "BUILD4 Chain: dedicated L2 optimistic rollup settling to BNB Chain. Purpose-built for autonomous AI agents with 1-second blocks, near-zero gas, and protocol-native agent primitives.",
  },
  "/competition": {
    title: "BUILD4 × PancakeSwap AI Agent Championship | $3,000 Prize Pool",
    description: "The first AI agent trading championship on PancakeSwap. Deploy your BUILD4 agent, choose Auto, Co-pilot or Manual mode, and compete for $3,000 in BNB. 7 days. Real funds. Real glory.",
  },
  "/outreach": {
    title: "Agent Outreach & Protocol Discovery | BUILD4",
    description: "Open protocol discovery for AI agents. HTTP 402 payment protocol, .well-known endpoints, and cross-platform agent recruitment across 20+ AI agent platforms.",
  },
};

export function SEO({ title, description, path, type = "website", image }: SEOProps) {
  const [location] = useLocation();
  const currentPath = path || location;
  const pageSeo = PAGE_SEO[currentPath] || PAGE_SEO["/"];

  const finalTitle = title || pageSeo.title;
  const finalDescription = description || pageSeo.description;
  const finalImage = image || "https://build4.io/og-image.png";
  const canonicalUrl = `https://build4.io${currentPath === "/" ? "" : currentPath}`;

  useEffect(() => {
    document.title = finalTitle;

    const setMeta = (name: string, content: string, attr = "name") => {
      let el = document.querySelector(`meta[${attr}="${name}"]`) as HTMLMetaElement;
      if (!el) {
        el = document.createElement("meta");
        el.setAttribute(attr, name);
        document.head.appendChild(el);
      }
      el.content = content;
    };

    setMeta("description", finalDescription);
    // Lighthouse "Page is blocked from indexing" guards: assert index/follow
    // on every route so an in-app navigation cannot inherit a stale noindex.
    setMeta("robots", "index, follow, max-image-preview:large, max-snippet:-1");
    setMeta("googlebot", "index, follow, max-image-preview:large, max-snippet:-1");
    setMeta("og:title", finalTitle, "property");
    setMeta("og:description", finalDescription, "property");
    setMeta("og:url", canonicalUrl, "property");
    setMeta("og:type", type, "property");
    setMeta("og:image", finalImage, "property");
    setMeta("twitter:title", finalTitle, "name");
    setMeta("twitter:description", finalDescription, "name");
    setMeta("twitter:image", finalImage, "name");

    let link = document.querySelector('link[rel="canonical"]') as HTMLLinkElement;
    if (!link) {
      link = document.createElement("link");
      link.rel = "canonical";
      document.head.appendChild(link);
    }
    link.href = canonicalUrl;
  }, [finalTitle, finalDescription, canonicalUrl, type, finalImage]);

  return null;
}

export { PAGE_SEO };
