import { storage } from "./storage";

export interface ToolResult {
  toolType: string;
  data: string;
  summary: string;
}

export async function fetchCryptoPrices(symbols: string[] = ["bitcoin", "ethereum", "binancecoin"]): Promise<ToolResult> {
  try {
    const ids = symbols.join(",");
    const response = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!response.ok) throw new Error(`CoinGecko API returned ${response.status}`);
    const data = await response.json();

    const lines: string[] = [];
    for (const [id, info] of Object.entries(data) as any) {
      const price = info.usd?.toLocaleString("en-US", { maximumFractionDigits: 2 });
      const change = info.usd_24h_change?.toFixed(2);
      const mcap = info.usd_market_cap ? `$${(info.usd_market_cap / 1e9).toFixed(2)}B` : "N/A";
      lines.push(`${id.toUpperCase()}: $${price} (${change > 0 ? "+" : ""}${change}% 24h, MCap: ${mcap})`);
    }

    return {
      toolType: "price_feed",
      data: JSON.stringify(data),
      summary: lines.join(" | "),
    };
  } catch (err: any) {
    return { toolType: "price_feed", data: "{}", summary: "Price data unavailable" };
  }
}

export async function fetchGasPrice(): Promise<ToolResult> {
  try {
    const response = await fetch(
      "https://api.bscscan.com/api?module=gastracker&action=gasoracle",
      { signal: AbortSignal.timeout(5000) }
    );
    const data = await response.json();
    if (data.status === "1" && data.result) {
      const gas = data.result;
      return {
        toolType: "chain_data",
        data: JSON.stringify(gas),
        summary: `BNB Chain Gas: Low ${gas.SafeGasPrice} | Avg ${gas.ProposeGasPrice} | Fast ${gas.FastGasPrice} Gwei`,
      };
    }
    return { toolType: "chain_data", data: "{}", summary: "Gas data unavailable" };
  } catch {
    return { toolType: "chain_data", data: "{}", summary: "Gas data unavailable" };
  }
}

export async function fetchTrendingCrypto(): Promise<ToolResult> {
  try {
    const response = await fetch(
      "https://api.coingecko.com/api/v3/search/trending",
      { signal: AbortSignal.timeout(8000) }
    );
    if (!response.ok) throw new Error(`Status ${response.status}`);
    const data = await response.json();
    const coins = (data.coins || []).slice(0, 7).map((c: any) => ({
      name: c.item?.name,
      symbol: c.item?.symbol,
      rank: c.item?.market_cap_rank,
    }));

    const summary = coins.map((c: any) => `${c.symbol} (#${c.rank || "?"})`).join(", ");
    return {
      toolType: "trending",
      data: JSON.stringify(coins),
      summary: `Trending: ${summary}`,
    };
  } catch {
    return { toolType: "trending", data: "[]", summary: "Trending data unavailable" };
  }
}

const ROLE_TOOL_MAP: Record<string, string[]> = {
  cmo: ["price_feed", "trending"],
  ceo: ["price_feed", "trending"],
  cto: ["chain_data"],
  cfo: ["price_feed", "chain_data"],
  analyst: ["price_feed", "trending", "chain_data"],
  trader: ["price_feed", "chain_data", "trending"],
  researcher: ["price_feed", "trending"],
  content_creator: ["trending", "price_feed"],
  community_manager: ["trending"],
  bounty_hunter: ["price_feed"],
  sales: ["price_feed"],
  partnerships: ["trending"],
  developer_relations: ["chain_data"],
  brand_ambassador: ["trending"],
  support: [],
};

export async function runToolsForRole(agentId: string, role: string): Promise<string> {
  const tools = ROLE_TOOL_MAP[role] || ["price_feed"];
  if (tools.length === 0) return "";

  const results: ToolResult[] = [];

  for (const tool of tools) {
    try {
      let result: ToolResult;
      switch (tool) {
        case "price_feed":
          result = await fetchCryptoPrices();
          break;
        case "chain_data":
          result = await fetchGasPrice();
          break;
        case "trending":
          result = await fetchTrendingCrypto();
          break;
        default:
          continue;
      }

      if (result.summary && !result.summary.includes("unavailable")) {
        results.push(result);
        await storage.createToolResult({
          agentId,
          toolType: result.toolType,
          result: result.data,
          usedInTweetId: null,
        });
      }
    } catch {}
  }

  if (results.length === 0) return "";

  return `\n\nLIVE DATA (use this to make your tweets timely and data-driven — reference specific numbers):\n${results.map(r => `- ${r.summary}`).join("\n")}\n`;
}
