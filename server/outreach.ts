import { storage } from "./storage";
import { getRevenueWalletAddress, getContractAddresses, isOnchainReady, getSupportedChains } from "./onchain";
import type { OutreachTarget, OutreachCampaign } from "@shared/schema";

const KNOWN_AGENT_PLATFORMS = [
  {
    platform: "fetch_ai",
    name: "Fetch.ai / ASI Alliance",
    discoveryUrl: "https://agentverse.ai",
    endpointUrl: "https://agentverse.ai/.well-known/agent.json",
    method: "http" as const,
    chainId: 56,
  },
  {
    platform: "autonolas",
    name: "Autonolas / Olas",
    discoveryUrl: "https://registry.olas.network",
    endpointUrl: "https://registry.olas.network/.well-known/agent.json",
    method: "http" as const,
    chainId: 1,
  },
  {
    platform: "singularitynet",
    name: "SingularityNET",
    discoveryUrl: "https://publisher.singularitynet.io",
    endpointUrl: "https://publisher.singularitynet.io/.well-known/agent.json",
    method: "http" as const,
    chainId: 1,
  },
  {
    platform: "virtuals",
    name: "Virtuals Protocol",
    discoveryUrl: "https://app.virtuals.io",
    endpointUrl: "https://app.virtuals.io/.well-known/agent.json",
    method: "http" as const,
    chainId: 8453,
  },
  {
    platform: "eliza",
    name: "ai16z ELIZA Framework",
    discoveryUrl: "https://elizaos.github.io/eliza",
    endpointUrl: null,
    method: "http" as const,
    chainId: null,
  },
  {
    platform: "morpheus",
    name: "Morpheus AI",
    discoveryUrl: "https://mor.org",
    endpointUrl: "https://mor.org/.well-known/agent.json",
    method: "http" as const,
    chainId: 42161,
  },
  {
    platform: "bittensor",
    name: "Bittensor TAO",
    discoveryUrl: "https://taostats.io",
    endpointUrl: null,
    method: "http" as const,
    chainId: null,
  },
  {
    platform: "swarms",
    name: "Swarms AI",
    discoveryUrl: "https://swarms.world",
    endpointUrl: "https://swarms.world/.well-known/agent.json",
    method: "http" as const,
    chainId: null,
  },
  {
    platform: "auto_gpt",
    name: "AutoGPT / AgentGPT",
    discoveryUrl: "https://agpt.co",
    endpointUrl: "https://agpt.co/.well-known/agent.json",
    method: "http" as const,
    chainId: null,
  },
  {
    platform: "fixie_ai",
    name: "Fixie AI",
    discoveryUrl: "https://app.fixie.ai",
    endpointUrl: "https://app.fixie.ai/.well-known/ai-plugin.json",
    method: "http" as const,
    chainId: null,
  },
  {
    platform: "wasp_ai",
    name: "Wasp Agent Framework",
    discoveryUrl: "https://wasp-lang.dev",
    endpointUrl: null,
    method: "http" as const,
    chainId: null,
  },
  {
    platform: "crew_ai",
    name: "CrewAI",
    discoveryUrl: "https://crewai.com",
    endpointUrl: "https://crewai.com/.well-known/agent.json",
    method: "http" as const,
    chainId: null,
  },
  {
    platform: "phala",
    name: "Phala Network AI Agents",
    discoveryUrl: "https://phala.network",
    endpointUrl: "https://phala.network/.well-known/agent.json",
    method: "http" as const,
    chainId: 1,
  },
  {
    platform: "myshell",
    name: "MyShell AI",
    discoveryUrl: "https://myshell.ai",
    endpointUrl: "https://myshell.ai/.well-known/agent.json",
    method: "http" as const,
    chainId: null,
  },
];

function getBuild4Announcement(baseUrl: string): object {
  const contracts = getContractAddresses();
  return {
    type: "marketplace_announcement",
    from: "BUILD4",
    message: "BUILD4 is a fully decentralized, permissionless AI agent skill marketplace. Any agent can browse, execute, and list skills using only a wallet address. No registration. No API keys. No gatekeepers.",
    protocol: {
      discovery: `${baseUrl}/api/protocol`,
      wellKnown: `${baseUrl}/.well-known/agent.json`,
      openapi: `${baseUrl}/.well-known/openapi.json`,
    },
    capabilities: {
      browse: `${baseUrl}/api/marketplace/skills`,
      execute: `${baseUrl}/api/marketplace/skills/{skillId}/execute`,
      list: `${baseUrl}/api/marketplace/skills/submit`,
      walletLookup: `${baseUrl}/api/marketplace/wallet/{address}/stats`,
    },
    identity: "wallet",
    payment: "HTTP-402",
    freeTier: "5 executions per wallet",
    chains: [
      { name: "BNB Chain", chainId: 56 },
      { name: "Base", chainId: 8453 },
      { name: "XLayer", chainId: 196 },
    ],
    contracts: contracts,
    revenueWallet: getRevenueWalletAddress(),
    invitation: "Connect with your wallet. Browse skills. Execute or list your own. Earn royalties. No permission needed.",
  };
}

function getBeaconCalldata(baseUrl: string): string {
  const message = `BUILD4|PERMISSIONLESS_AI_MARKETPLACE|${baseUrl}|WALLET=IDENTITY|NO_REGISTRATION|HTTP402_PAYMENTS|BNB_BASE_XLAYER`;
  return "0x" + Buffer.from(message, "utf-8").toString("hex");
}

export async function seedKnownPlatforms(): Promise<number> {
  let seeded = 0;
  for (const platform of KNOWN_AGENT_PLATFORMS) {
    const existing = platform.endpointUrl
      ? await storage.getOutreachTargetByUrl(platform.endpointUrl)
      : null;

    const existingTargets = await storage.getOutreachTargets();
    const alreadyExists = existingTargets.find(t => t.platform === platform.platform);

    if (!existing && !alreadyExists) {
      await storage.createOutreachTarget({
        platform: platform.platform,
        name: platform.name,
        endpointUrl: platform.endpointUrl,
        discoveryUrl: platform.discoveryUrl,
        chainId: platform.chainId,
        method: platform.method,
        status: "pending",
        discovered: false,
        timesContacted: 0,
      });
      seeded++;
    }
  }
  return seeded;
}

export async function runHttpOutreach(baseUrl: string): Promise<{
  sent: number;
  reached: number;
  failed: number;
  results: Array<{ platform: string; status: string; response?: string; error?: string }>;
}> {
  const targets = await storage.getOutreachTargets();
  const announcement = getBuild4Announcement(baseUrl);
  const results: Array<{ platform: string; status: string; response?: string; error?: string }> = [];
  let sent = 0, reached = 0, failed = 0;

  for (const target of targets) {
    if (target.method !== "http") continue;

    sent++;
    try {
      const urls: string[] = [];

      if (target.endpointUrl) urls.push(target.endpointUrl);

      if (target.discoveryUrl) {
        urls.push(`${target.discoveryUrl}/.well-known/agent.json`);
        urls.push(`${target.discoveryUrl}/.well-known/ai-plugin.json`);
        urls.push(`${target.discoveryUrl}/api/protocol`);
      }

      let bestResponse = "";
      let bestCode = 0;
      let discoveredEndpoints: string[] = [];

      for (const url of urls) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 8000);

          const response = await fetch(url, {
            method: "GET",
            headers: {
              "Accept": "application/json",
              "User-Agent": "BUILD4-Agent-Outreach/1.0 (Permissionless AI Marketplace)",
              "X-Build4-Protocol": `${baseUrl}/api/protocol`,
              "X-Build4-Marketplace": `${baseUrl}/api/marketplace/skills`,
              "X-Build4-Identity": "wallet",
            },
            signal: controller.signal,
          });

          clearTimeout(timeout);

          if (response.ok) {
            const text = await response.text();
            bestResponse = text.slice(0, 500);
            bestCode = response.status;
            discoveredEndpoints.push(url);
          }
        } catch (e: any) {
          // Individual URL failure is ok, try others
        }
      }

      if (target.discoveryUrl) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 8000);

          const postResponse = await fetch(target.discoveryUrl, {
            method: "OPTIONS",
            headers: {
              "User-Agent": "BUILD4-Agent-Outreach/1.0",
              "X-Build4-Protocol": `${baseUrl}/api/protocol`,
              "X-Build4-Announcement": JSON.stringify({
                type: "marketplace_announcement",
                from: "BUILD4",
                url: baseUrl,
                capabilities: ["skill-marketplace", "permissionless", "wallet-identity"],
              }),
            },
            signal: controller.signal,
          });

          clearTimeout(timeout);
          if (postResponse.ok) {
            bestCode = bestCode || postResponse.status;
          }
        } catch (e: any) {
          // OPTIONS probe failure is non-critical
        }
      }

      const status = discoveredEndpoints.length > 0 ? "reached" : "probed";
      await storage.updateOutreachTarget(target.id, {
        status,
        lastContactedAt: new Date(),
        timesContacted: (target.timesContacted || 0) + 1,
        responseCode: bestCode || null,
        lastResponse: bestResponse || `Probed ${urls.length} endpoints. Discovered: ${discoveredEndpoints.join(", ") || "none"}`,
        discovered: discoveredEndpoints.length > 0,
      });

      if (discoveredEndpoints.length > 0) reached++;
      results.push({ platform: target.platform, status, response: bestResponse.slice(0, 200) });
    } catch (error: any) {
      failed++;
      await storage.updateOutreachTarget(target.id, {
        status: "failed",
        lastContactedAt: new Date(),
        timesContacted: (target.timesContacted || 0) + 1,
        lastResponse: error.message?.slice(0, 500),
      });
      results.push({ platform: target.platform, status: "failed", error: error.message });
    }
  }

  return { sent, reached, failed, results };
}

export async function runOnchainBeacon(baseUrl: string): Promise<{
  beacons: Array<{ chain: string; calldata: string; status: string }>;
}> {
  const calldata = getBeaconCalldata(baseUrl);
  const chains = getSupportedChains();

  const beacons = chains.map(chain => ({
    chain: chain.name,
    chainId: chain.chainId,
    calldata,
    decodedMessage: Buffer.from(calldata.slice(2), "hex").toString("utf-8"),
    status: "prepared",
    note: "Beacon calldata prepared. To broadcast: send a 0-value tx to the revenue wallet with this calldata on each chain. Agents monitoring these chains will decode the calldata and discover BUILD4.",
  }));

  return { beacons };
}

export async function runFullOutreach(baseUrl: string): Promise<OutreachCampaign> {
  await seedKnownPlatforms();

  const campaign = await storage.createOutreachCampaign({
    type: "full",
    status: "running",
    targetsSent: 0,
    targetsReached: 0,
    targetsFailed: 0,
    message: `Full outreach campaign from ${baseUrl}`,
    startedAt: new Date(),
  });

  const httpResults = await runHttpOutreach(baseUrl);
  const beaconResults = await runOnchainBeacon(baseUrl);

  const updated = await storage.updateOutreachCampaign(campaign.id, {
    status: "completed",
    targetsSent: httpResults.sent,
    targetsReached: httpResults.reached,
    targetsFailed: httpResults.failed,
    beaconTxHashes: beaconResults.beacons.map(b => b.calldata),
    completedAt: new Date(),
  });

  return updated;
}

export function getOutreachMessage(baseUrl: string): object {
  return getBuild4Announcement(baseUrl);
}

export function getPlatformRegistry(): typeof KNOWN_AGENT_PLATFORMS {
  return KNOWN_AGENT_PLATFORMS;
}
