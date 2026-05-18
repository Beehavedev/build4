// Autonomous PancakeSwap trading agent for the BUILD4 × PancakeSwap competition.
//
// Runs on a slow tick (default 5 min). For each auto-mode competition entry:
//   1. Skip if bust_out=true.
//   2. Build a small context (BNB balance, current token holdings via tracked_tokens,
//      price snapshot of the curated token universe).
//   3. Ask the LLM (persona-specific prompt) for a single JSON decision.
//   4. Execute the trade on PancakeSwap V2 using the user's custodial PK.
//   5. Re-check equity → flip bust_out=true if drawdown ≥ BUST_OUT_PCT.
//
// House agent: a special competition entry seeded from HOUSE_AGENT_PRIVATE_KEY
// env var. Always Auto mode, persona='House'. Skipped if env not set.

import { ethers } from "ethers";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { storage } from "./storage";
import {
  pancakeQuoteBuy,
  pancakeQuoteSell,
  pancakeBuyTokenWithBnb,
  pancakeSellTokenForBnb,
  getBscWalletBalance,
  pancakeGetTokenInfo,
} from "./services/pancakeSwapTrading";
import { runInferenceWithFallback, getAvailableProviders } from "./inference";

// ─── Tuning ──────────────────────────────────────────────────────────────────
const TICK_INTERVAL_MS = Number(process.env.PANCAKE_AGENT_TICK_MS) || 5 * 60_000;
const MAX_CONCURRENT_ENTRIES = 2;
// Bust-out fires when equity drops to ≤ (1 − MAX_DRAWDOWN_PCT) × starting.
// Default: 10% drawdown → bust-out. Override via env if you want looser/tighter.
const MAX_DRAWDOWN_PCT = Number(process.env.PANCAKE_AGENT_MAX_DRAWDOWN_PCT) || 0.10;
const MIN_EQUITY_FRACTION = 1 - MAX_DRAWDOWN_PCT;
// Postgres advisory lock key — prevents duplicate ticks across replicas.
const TICK_LOCK_KEY = 0x42554c44; // 'BULD'
const MIN_TRADE_BNB = 0.003;  // ~$1.80
const MAX_TRADE_BNB = 0.05;   // ~$30 cap per single trade
const PER_TRADE_PCT_OF_EQUITY = 0.10; // size each trade at 10% of current equity
const SLIPPAGE_BPS = 500;     // 5%
const HOUSE_CHAT_ID = "__house_agent__";

// ─── Curated BSC token universe (PCS V2 liquidity-verified) ──────────────────
type TokenSpec = { symbol: string; address: string };
const TOKEN_UNIVERSE: TokenSpec[] = [
  { symbol: "CAKE", address: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82" },
  { symbol: "BTCB", address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c" },
  { symbol: "ETH",  address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8" },
  { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955" },
  { symbol: "BUSD", address: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56" },
  { symbol: "USDC", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" },
  { symbol: "DOT",  address: "0x7083609fCE4d1d8Dc0C979AAb8c869Ea2C873402" },
  { symbol: "ADA",  address: "0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47" },
  { symbol: "LINK", address: "0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD" },
  { symbol: "XRP",  address: "0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE" },
];
const TOKEN_BY_ADDR = new Map(TOKEN_UNIVERSE.map(t => [t.address.toLowerCase(), t]));

// ─── Persona prompts ─────────────────────────────────────────────────────────
const PERSONA_PROMPTS: Record<string, string> = {
  Quant: `You are a quantitative trader. Make data-driven decisions based on price action and momentum.
Prefer larger, more liquid assets (BTCB, ETH, USDT pairs). Cut losses fast, ride winners. Avoid emotional bets.`,
  Degen: `You are a degenerate trader. High-risk, high-reward. Embrace volatility and chase momentum hard.
Bet bigger on CAKE and pure BSC plays. Cut sizing only on outright disasters.`,
  Hunter: `You are an alpha hunter. Look for asymmetric opportunities — assets that diverge from BTC/ETH.
Rotate aggressively. Take profits in chunks. Hold cash (BNB) when nothing looks right.`,
  Sniper: `You are a precision sniper. Make few trades, each one with a thesis. Quality over quantity.
Prefer holding BNB or stablecoins (USDT/BUSD/USDC) and only deploy when one asset is clearly mispriced.`,
  Maximalist: `You are a CAKE maximalist. Believe in PancakeSwap's own token. Heavy CAKE allocation by default,
small rotations into BTCB/ETH only as hedge. Sell CAKE only on extreme strength.`,
  House: `You are the BUILD4 house agent. Balanced, disciplined, and consistent.
Mix between BTCB, ETH, CAKE, and stable reserves. Take profits regularly. Hard stops on losers.`,
};

// ─── Types ───────────────────────────────────────────────────────────────────
interface AgentDecision {
  action: "buy" | "sell" | "hold";
  tokenSymbol: string | null;
  reasoning: string;
}

interface EntryRow {
  id: string;
  chat_id: string;
  wallet_address: string;
  persona: string;
  mode: string;
  starting_balance_usdt: number;
  current_equity_usdt: number;
  tracked_tokens: string;
  bust_out: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function getPriceContext(): Promise<string> {
  // Quote 0.01 BNB → token to get a relative price snapshot.
  const probeBnb = ethers.parseEther("0.01");
  const lines: string[] = [];
  for (const t of TOKEN_UNIVERSE) {
    try {
      const q = await pancakeQuoteBuy(t.address, probeBnb);
      const info = await pancakeGetTokenInfo(t.address);
      const tokensOut = Number(ethers.formatUnits(q.estimatedAmountWei, info.decimals));
      lines.push(`- ${t.symbol}: 0.01 BNB → ${tokensOut.toFixed(6)} ${t.symbol}`);
    } catch {
      // skip illiquid
    }
  }
  return lines.join("\n");
}

async function getHoldingsContext(walletAddress: string, trackedTokens: string[]): Promise<{ summary: string; holdings: Array<{ symbol: string; address: string; tokenWei: bigint; bnbValue: number }>; quoteFailures: number }> {
  const holdings: Array<{ symbol: string; address: string; tokenWei: bigint; bnbValue: number }> = [];
  const lines: string[] = [];
  let quoteFailures = 0;
  for (const addr of trackedTokens.slice(0, 10)) {
    const t = TOKEN_BY_ADDR.get(addr.toLowerCase()) || { symbol: addr.slice(0, 6), address: addr };
    let tokenWei = 0n;
    try {
      ({ tokenWei } = await getBscWalletBalance(walletAddress, addr));
    } catch { continue; }
    if (tokenWei <= 0n) continue;
    try {
      const q = await pancakeQuoteSell(addr, tokenWei);
      const bnbValue = Number(ethers.formatEther(q.estimatedBnbWei));
      const info = await pancakeGetTokenInfo(addr);
      const tokenBal = Number(ethers.formatUnits(tokenWei, info.decimals));
      lines.push(`- ${t.symbol}: ${tokenBal.toFixed(6)} (worth ${bnbValue.toFixed(6)} BNB)`);
      holdings.push({ symbol: t.symbol, address: addr, tokenWei, bnbValue });
    } catch {
      // Has balance but no quote — record as failure so bust-out is suppressed
      // rather than treating it as zero-value and falsely busting the user.
      quoteFailures++;
      lines.push(`- ${t.symbol}: balance held, price quote unavailable (skipping valuation)`);
    }
  }
  return { summary: lines.length ? lines.join("\n") : "(no token positions yet — all in BNB)", holdings, quoteFailures };
}

function parseDecision(text: string): AgentDecision | null {
  // Extract first JSON object.
  const m = text.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const action = String(j.action || "").toLowerCase();
    if (!["buy", "sell", "hold"].includes(action)) return null;
    return {
      action: action as any,
      tokenSymbol: j.tokenSymbol ? String(j.tokenSymbol).toUpperCase() : null,
      reasoning: String(j.reasoning || "").slice(0, 200),
    };
  } catch {
    return null;
  }
}

async function decideTradeForPersona(
  persona: string,
  bnbBalance: number,
  startingBnb: number,
  currentEquity: number,
  priceContext: string,
  holdingsContext: string,
): Promise<AgentDecision> {
  const systemPrompt = PERSONA_PROMPTS[persona] || PERSONA_PROMPTS.Quant;
  const pnlPct = startingBnb > 0 ? ((currentEquity - startingBnb) / startingBnb) * 100 : 0;
  const prompt = `Competition status:
- Starting balance: ${startingBnb.toFixed(6)} BNB
- Current equity: ${currentEquity.toFixed(6)} BNB
- PnL: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%
- Cash (BNB): ${bnbBalance.toFixed(6)} BNB

Current price snapshot (0.01 BNB → token):
${priceContext}

Your current holdings:
${holdingsContext}

Decide ONE action for this tick. Respond with ONLY a JSON object on a single line:
{"action":"buy"|"sell"|"hold","tokenSymbol":"CAKE"|"BTCB"|... (null if hold),"reasoning":"one sentence"}

Rules:
- "buy" picks a token from the snapshot to acquire with BNB.
- "sell" liquidates one of your current holdings back to BNB.
- "hold" if no good move; you can hold often.
- Be decisive. One line only.`;

  const providers = getAvailableProviders();
  if (providers.length === 0) {
    return { action: "hold", tokenSymbol: null, reasoning: "No LLM providers configured" };
  }
  try {
    const r = await runInferenceWithFallback(providers.slice(0, 3), undefined, prompt, {
      systemPrompt,
      temperature: 0.7,
      maxTokens: 200,
    });
    const parsed = parseDecision(r.text);
    if (!parsed) {
      return { action: "hold", tokenSymbol: null, reasoning: `Parse failed: ${r.text.slice(0, 80)}` };
    }
    return parsed;
  } catch (e: any) {
    return { action: "hold", tokenSymbol: null, reasoning: `LLM error: ${e?.message ?? "unknown"}` };
  }
}

async function checkAndApplyBustOut(entry: EntryRow, currentEquityBnb: number, quoteFailures: number = 0): Promise<boolean> {
  const startingBnb = Number(entry.starting_balance_usdt) || 0;
  if (startingBnb <= 0) return false;
  // SAFETY: suppress bust-out when ANY held token failed to quote — its value
  // is unknown, not zero. Better to skip the tick than falsely bust the user.
  if (quoteFailures > 0) {
    console.warn(`[PancakeAgent] bust-out check skipped for ${entry.id.slice(0, 8)} — ${quoteFailures} unquotable holdings (equity reading is incomplete)`);
    return false;
  }
  if (currentEquityBnb / startingBnb <= MIN_EQUITY_FRACTION) {
    await db.execute(sql`
      UPDATE aster_competition_entries SET bust_out = true, last_updated = NOW() WHERE id = ${entry.id}
    `);
    console.log(`[PancakeAgent] BUST-OUT triggered for entry ${entry.id} (${entry.persona}) at ${(currentEquityBnb / startingBnb * 100).toFixed(2)}% of starting (drawdown ≥ ${(MAX_DRAWDOWN_PCT * 100).toFixed(0)}%)`);
    return true;
  }
  return false;
}

async function executeAgentTrade(
  entry: EntryRow,
  decision: AgentDecision,
  bnbBalance: number,
  currentEquity: number,
  holdings: Array<{ symbol: string; address: string; tokenWei: bigint; bnbValue: number }>,
): Promise<{ ok: boolean; reason: string; txHash?: string }> {
  if (decision.action === "hold") return { ok: true, reason: `hold: ${decision.reasoning}` };

  // Resolve PK from custodial wallet store.
  let pk: string | null = null;
  if (entry.chat_id === HOUSE_CHAT_ID) {
    pk = process.env.HOUSE_AGENT_PRIVATE_KEY || null;
  } else {
    pk = await storage.getPrivateKeyByWalletAddress(entry.wallet_address);
  }
  if (!pk) return { ok: false, reason: "No PK available for entry wallet" };

  if (decision.action === "buy") {
    const token = TOKEN_UNIVERSE.find(t => t.symbol === decision.tokenSymbol);
    if (!token) return { ok: false, reason: `Unknown token ${decision.tokenSymbol}` };
    const sizeBnb = Math.max(MIN_TRADE_BNB, Math.min(MAX_TRADE_BNB, currentEquity * PER_TRADE_PCT_OF_EQUITY));
    if (bnbBalance < sizeBnb + 0.002) return { ok: false, reason: `Insufficient BNB (need ${sizeBnb.toFixed(4)}, have ${bnbBalance.toFixed(4)})` };
    const bnbWei = ethers.parseEther(sizeBnb.toFixed(6));
    try {
      const res = await pancakeBuyTokenWithBnb(pk, token.address, bnbWei, { slippageBps: SLIPPAGE_BPS });
      // Append token to tracked_tokens.
      let tracked: string[] = [];
      try { tracked = JSON.parse(entry.tracked_tokens || "[]"); } catch {}
      if (!tracked.map(s => s.toLowerCase()).includes(token.address.toLowerCase())) tracked.push(token.address);
      await db.execute(sql`
        UPDATE aster_competition_entries
        SET trade_count = trade_count + 1, tracked_tokens = ${JSON.stringify(tracked)}, last_updated = NOW()
        WHERE id = ${entry.id}
      `);
      return { ok: true, reason: `BUY ${sizeBnb.toFixed(4)} BNB → ${token.symbol}: ${decision.reasoning}`, txHash: res.txHash };
    } catch (e: any) {
      return { ok: false, reason: `Buy tx failed: ${e?.message ?? "unknown"}` };
    }
  }

  if (decision.action === "sell") {
    const target = holdings.find(h => h.symbol === decision.tokenSymbol);
    if (!target) return { ok: false, reason: `No holdings of ${decision.tokenSymbol} to sell` };
    try {
      const res = await pancakeSellTokenForBnb(pk, target.address, target.tokenWei, { slippageBps: SLIPPAGE_BPS });
      await db.execute(sql`
        UPDATE aster_competition_entries
        SET trade_count = trade_count + 1, last_updated = NOW()
        WHERE id = ${entry.id}
      `);
      return { ok: true, reason: `SELL all ${target.symbol} → ~${target.bnbValue.toFixed(4)} BNB: ${decision.reasoning}`, txHash: res.txHash };
    } catch (e: any) {
      return { ok: false, reason: `Sell tx failed: ${e?.message ?? "unknown"}` };
    }
  }
  return { ok: false, reason: "Unknown action" };
}

async function processEntry(entry: EntryRow): Promise<void> {
  if (entry.bust_out) return;
  try {
    let trackedRaw: string[] = [];
    try { trackedRaw = JSON.parse(entry.tracked_tokens || "[]"); } catch {}

    const { bnbWei } = await getBscWalletBalance(entry.wallet_address, "0x000000000000000000000000000000000000dEaD");
    const bnbBalance = Number(ethers.formatEther(bnbWei));
    const { summary: holdingsCtx, holdings, quoteFailures } = await getHoldingsContext(entry.wallet_address, trackedRaw);
    const currentEquity = bnbBalance + holdings.reduce((s, h) => s + h.bnbValue, 0);
    const startingBnb = Number(entry.starting_balance_usdt) || 0;

    // Bust-out gate BEFORE trading (suppressed if any quote failed — see helper).
    if (await checkAndApplyBustOut(entry, currentEquity, quoteFailures)) return;

    // Get price snapshot (cached effectively because pancakeQuoteBuy hits BSC live).
    const priceCtx = await getPriceContext();

    const decision = await decideTradeForPersona(
      entry.persona || "Quant",
      bnbBalance,
      startingBnb,
      currentEquity,
      priceCtx,
      holdingsCtx,
    );

    const result = await executeAgentTrade(entry, decision, bnbBalance, currentEquity, holdings);
    console.log(`[PancakeAgent] entry=${entry.id.slice(0, 8)} persona=${entry.persona} ${result.ok ? "✓" : "✗"} ${result.reason}${result.txHash ? " tx=" + result.txHash.slice(0, 10) : ""}`);

    // After trade, recompute equity & persist + re-check bust-out.
    if (result.ok && (decision.action === "buy" || decision.action === "sell")) {
      const { bnbWei: postBnb } = await getBscWalletBalance(entry.wallet_address, "0x000000000000000000000000000000000000dEaD");
      const postBnbBalance = Number(ethers.formatEther(postBnb));
      // Refresh holdings (the trade may have changed them).
      const trackedAfter = (() => {
        try {
          const r2: any[] = (db as any) ? [] : []; // no-op type fence
          return trackedRaw;
        } catch { return trackedRaw; }
      })();
      const { holdings: postHoldings, quoteFailures: postQF } = await getHoldingsContext(entry.wallet_address, trackedAfter);
      const postEquity = postBnbBalance + postHoldings.reduce((s, h) => s + h.bnbValue, 0);
      const pnlBnb = postEquity - startingBnb;
      const pnlPct = startingBnb > 0 ? (pnlBnb / startingBnb) * 100 : 0;
      await db.execute(sql`
        UPDATE aster_competition_entries
        SET current_equity_usdt = ${postEquity}, pnl_usdt = ${pnlBnb}, pnl_percent = ${pnlPct}, last_updated = NOW()
        WHERE id = ${entry.id}
      `);
      await checkAndApplyBustOut(entry, postEquity, postQF);
    }
  } catch (e: any) {
    console.error(`[PancakeAgent] processEntry failed for ${entry.id.slice(0, 8)}:`, e?.message ?? e);
  }
}

async function getAutoEntries(): Promise<EntryRow[]> {
  const r = await db.execute(sql`
    SELECT e.id, e.chat_id, e.wallet_address, e.persona, e.mode,
           e.starting_balance_usdt, e.current_equity_usdt, e.tracked_tokens, e.bust_out
    FROM aster_competition_entries e
    JOIN aster_competition c ON c.id = e.competition_id
    WHERE c.status = 'active' AND e.mode = 'auto' AND e.bust_out = false
      AND e.wallet_address IS NOT NULL
    ORDER BY e.last_updated ASC NULLS FIRST
    LIMIT 50
  `);
  return (r.rows ?? []) as any[];
}

let _tickInFlight = false;
async function runPancakeAgentTick(): Promise<void> {
  if (_tickInFlight) return;
  _tickInFlight = true;
  // Postgres session-level advisory lock so multiple server replicas can't
  // process the same auto entries concurrently. pg_try_advisory_lock returns
  // false immediately if another replica already holds it — we just skip.
  let lockAcquired = false;
  try {
    const lockRes = await db.execute(sql`SELECT pg_try_advisory_lock(${TICK_LOCK_KEY}) AS got`);
    lockAcquired = Boolean((lockRes.rows ?? [])[0]?.got);
    if (!lockAcquired) {
      console.log("[PancakeAgent] tick skipped — another replica holds the lock");
      return;
    }
    const entries = await getAutoEntries();
    if (entries.length === 0) return;
    console.log(`[PancakeAgent] tick start — ${entries.length} auto entries`);
    for (let i = 0; i < entries.length; i += MAX_CONCURRENT_ENTRIES) {
      const batch = entries.slice(i, i + MAX_CONCURRENT_ENTRIES);
      await Promise.all(batch.map(processEntry));
    }
  } catch (e: any) {
    console.error("[PancakeAgent] tick failed:", e?.message ?? e);
  } finally {
    if (lockAcquired) {
      try { await db.execute(sql`SELECT pg_advisory_unlock(${TICK_LOCK_KEY})`); }
      catch (e: any) { console.error("[PancakeAgent] unlock failed:", e?.message ?? e); }
    }
    _tickInFlight = false;
  }
}

// Seed the house agent as a competition entry if HOUSE_AGENT_PRIVATE_KEY is set.
export async function ensureHouseAgent(): Promise<void> {
  const pk = process.env.HOUSE_AGENT_PRIVATE_KEY;
  if (!pk) return;
  try {
    const wallet = new ethers.Wallet(pk);
    const houseAddr = wallet.address.toLowerCase();
    const compRes = await db.execute(sql`SELECT id FROM aster_competition WHERE status IN ('upcoming','active') ORDER BY start_date ASC LIMIT 1`);
    const compId = (compRes.rows ?? [])[0] as any;
    if (!compId) return;
    const existing = await db.execute(sql`
      SELECT id FROM aster_competition_entries
      WHERE competition_id = ${compId.id} AND chat_id = ${HOUSE_CHAT_ID} LIMIT 1
    `);
    if ((existing.rows ?? []).length > 0) return;
    // Snapshot starting BNB.
    const { bnbWei } = await getBscWalletBalance(houseAddr, "0x000000000000000000000000000000000000dEaD");
    const startingBnb = Number(ethers.formatEther(bnbWei));
    await db.execute(sql`
      INSERT INTO aster_competition_entries
        (competition_id, chat_id, username, wallet_address, starting_balance_usdt, current_equity_usdt,
         agent_name, persona, mode, tracked_tokens)
      VALUES (${compId.id}, ${HOUSE_CHAT_ID}, 'BUILD4', ${houseAddr}, ${startingBnb}, ${startingBnb},
              'BUILD4_HOUSE', 'House', 'auto', '[]')
      ON CONFLICT (competition_id, chat_id) DO NOTHING
    `);
    console.log(`[PancakeAgent] House agent seeded: addr=${houseAddr} starting=${startingBnb.toFixed(4)} BNB`);
  } catch (e: any) {
    console.error("[PancakeAgent] ensureHouseAgent failed:", e?.message ?? e);
  }
}

let _loopHandle: ReturnType<typeof setInterval> | null = null;
export function startPancakeAgentLoop(): void {
  if (_loopHandle) return;
  if (process.env.PANCAKE_AGENT_DISABLED === "1") {
    console.log("[PancakeAgent] disabled via PANCAKE_AGENT_DISABLED=1");
    return;
  }
  console.log(`[PancakeAgent] loop starting — tick=${TICK_INTERVAL_MS}ms, bust_out=${BUST_OUT_PCT * 100}% drawdown`);
  // First tick after 30s so server is warm.
  setTimeout(() => { runPancakeAgentTick(); }, 30_000);
  _loopHandle = setInterval(() => { runPancakeAgentTick(); }, TICK_INTERVAL_MS);
}

// Export for admin manual triggers / tests.
export { runPancakeAgentTick };
