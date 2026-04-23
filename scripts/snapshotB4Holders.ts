/**
 * Snapshot all current holders of $B4 on BSC at a specific block.
 *
 * Strategy:
 *   1. Walk every Transfer event of the $B4 token from contract creation
 *      to the snapshot block, building the set of all addresses that
 *      have ever held the token. (Etherscan v2 logs API, paginated by
 *      block range to stay under the 1000-results-per-call limit.)
 *   2. For each candidate address, call balanceOf(addr) at the exact
 *      snapshot block — only addresses with > 0 balance go into the
 *      final list.
 *   3. Write snapshots/b4-holders-<block>.json with
 *      { token, block, totalSupply, holderCount, holders: [{address, balance}] }
 *
 * Concurrency: balanceOf calls are batched (50 in flight) to keep BSC
 * RPCs happy and the run under ~2 minutes for typical token sizes.
 *
 * Usage:
 *   npx tsx scripts/snapshotB4Holders.ts                  # snapshot at latest block
 *   npx tsx scripts/snapshotB4Holders.ts --block 12345678 # snapshot at specific block
 *   npx tsx scripts/snapshotB4Holders.ts --token 0x...    # different token
 *
 * Env required:
 *   BSCSCAN_API_KEY (or ETHERSCAN_API_KEY)  — for the logs API
 *   BSC_RPC_URL                              — optional override
 */
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_TOKEN = '0x1d547f9d0890ee5abfb49d7d53ca19df85da4444'; // $B4 on BSC
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const BALANCEOF_BATCH = 50;
const LOGS_BLOCK_STEP = 50_000; // BSC RPCs cap eth_getLogs ranges; Etherscan caps result count

// Resolve CLI args
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function symbol() view returns (string)',
];

interface EtherscanLog {
  topics: string[];
  blockNumber: string;
}

async function fetchLogsRange(opts: {
  apiKey: string;
  token: string;
  fromBlock: number;
  toBlock: number;
}): Promise<EtherscanLog[]> {
  const url = `https://api.etherscan.io/v2/api?chainid=56&module=logs&action=getLogs` +
    `&address=${opts.token}&topic0=${TRANSFER_TOPIC}` +
    `&fromBlock=${opts.fromBlock}&toBlock=${opts.toBlock}` +
    `&apikey=${opts.apiKey}`;
  const res = await fetch(url);
  const data: any = await res.json();
  if (data.status === '1' && Array.isArray(data.result)) return data.result;
  // Etherscan returns status='0' + message='No records found' for empty ranges.
  // That's not an error, just an empty page.
  if (data.status === '0' && /no records/i.test(data.message ?? '')) return [];
  throw new Error(`Etherscan getLogs failed (${opts.fromBlock}-${opts.toBlock}): ${JSON.stringify(data)}`);
}

async function findContractCreationBlock(token: string, apiKey: string): Promise<number> {
  const url = `https://api.etherscan.io/v2/api?chainid=56&module=contract&action=getcontractcreation&contractaddresses=${token}&apikey=${apiKey}`;
  const res = await fetch(url);
  const data: any = await res.json();
  if (data.status !== '1' || !Array.isArray(data.result) || data.result.length === 0) {
    throw new Error(`Could not locate creation tx for ${token}: ${JSON.stringify(data)}`);
  }
  const creationTx = data.result[0].txHash;
  const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org');
  const tx = await provider.getTransaction(creationTx);
  if (!tx || tx.blockNumber == null) {
    throw new Error(`Creation tx ${creationTx} has no blockNumber`);
  }
  return tx.blockNumber;
}

async function main() {
  const apiKey = process.env.BSCSCAN_API_KEY ?? process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    console.error('BSCSCAN_API_KEY (or ETHERSCAN_API_KEY) required.');
    process.exit(1);
  }

  const token = (arg('token') ?? DEFAULT_TOKEN).toLowerCase();
  const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org');

  const snapshotBlock = arg('block')
    ? parseInt(arg('block')!, 10)
    : await provider.getBlockNumber();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' $B4 Holder Snapshot');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Token            : ${token}`);
  console.log(`Snapshot block   : ${snapshotBlock}`);

  // ── Sanity-check token ──────────────────────────────────────────────────
  const erc20 = new ethers.Contract(token, ERC20_ABI, provider);
  let symbol = 'TOKEN';
  let decimals = 18;
  try {
    [symbol, decimals] = await Promise.all([erc20.symbol(), erc20.decimals()]);
  } catch (e: any) {
    console.error(`Could not read symbol/decimals from ${token}: ${e.shortMessage ?? e.message}`);
    process.exit(1);
  }
  console.log(`Symbol           : ${symbol}`);
  console.log(`Decimals         : ${decimals}`);

  const totalSupplyRaw = await erc20.totalSupply({ blockTag: snapshotBlock }) as bigint;
  console.log(`Total supply     : ${ethers.formatUnits(totalSupplyRaw, decimals)} ${symbol}`);

  // ── Find contract creation block ────────────────────────────────────────
  console.log('Locating contract creation block…');
  const creationBlock = await findContractCreationBlock(token, apiKey);
  console.log(`Creation block   : ${creationBlock}`);

  // ── Walk transfer logs ──────────────────────────────────────────────────
  console.log('Walking Transfer events…');
  const candidates = new Set<string>();
  let cursor = creationBlock;
  let pageCount = 0;
  while (cursor <= snapshotBlock) {
    const to = Math.min(cursor + LOGS_BLOCK_STEP - 1, snapshotBlock);
    const logs = await fetchLogsRange({ apiKey, token, fromBlock: cursor, toBlock: to });
    pageCount += 1;
    for (const log of logs) {
      // topics[1] = from (indexed), topics[2] = to (indexed)
      const fromAddr = '0x' + (log.topics[1] ?? '').slice(26).toLowerCase();
      const toAddr = '0x' + (log.topics[2] ?? '').slice(26).toLowerCase();
      if (fromAddr !== ZERO_ADDR && fromAddr.length === 42) candidates.add(fromAddr);
      if (toAddr !== ZERO_ADDR && toAddr.length === 42) candidates.add(toAddr);
    }
    if (pageCount % 10 === 0) {
      console.log(`  block ${cursor}-${to}: ${candidates.size} candidates so far`);
    }
    cursor = to + 1;
    // Etherscan free tier rate limit is 5 calls/sec — pace ourselves.
    await new Promise((r) => setTimeout(r, 220));
  }
  console.log(`Total candidates : ${candidates.size}`);

  // ── Read live balances at snapshot block ────────────────────────────────
  console.log(`Reading balanceOf at block ${snapshotBlock}…`);
  const addrs = [...candidates];
  const holders: { address: string; balance: string; balanceFormatted: number }[] = [];
  let scanned = 0;
  for (let i = 0; i < addrs.length; i += BALANCEOF_BATCH) {
    const batch = addrs.slice(i, i + BALANCEOF_BATCH);
    const balances = await Promise.all(
      batch.map((a) =>
        erc20.balanceOf(a, { blockTag: snapshotBlock }).catch(() => 0n) as Promise<bigint>,
      ),
    );
    batch.forEach((a, j) => {
      const bal = balances[j];
      if (bal > 0n) {
        holders.push({
          address: a,
          balance: bal.toString(),
          balanceFormatted: parseFloat(ethers.formatUnits(bal, decimals)),
        });
      }
    });
    scanned += batch.length;
    if (scanned % 500 === 0 || scanned === addrs.length) {
      console.log(`  ${scanned}/${addrs.length} scanned, ${holders.length} holders so far`);
    }
  }

  // Sort largest to smallest for readability.
  holders.sort((a, b) => b.balanceFormatted - a.balanceFormatted);

  // ── Sanity check: sum of holder balances ≈ total supply ─────────────────
  const sumRaw = holders.reduce((acc, h) => acc + BigInt(h.balance), 0n);
  const sumFmt = parseFloat(ethers.formatUnits(sumRaw, decimals));
  const supplyFmt = parseFloat(ethers.formatUnits(totalSupplyRaw, decimals));
  const drift = supplyFmt > 0 ? Math.abs(sumFmt - supplyFmt) / supplyFmt : 0;
  console.log(`Sum of holders   : ${sumFmt} ${symbol}`);
  console.log(`Total supply     : ${supplyFmt} ${symbol}`);
  console.log(`Drift            : ${(drift * 100).toFixed(4)}%`);
  if (drift > 0.01) {
    console.warn('⚠️  Drift > 1%. Likely missed some Transfer events — re-run with smaller LOGS_BLOCK_STEP or check API key rate limits.');
  }

  // ── Persist ─────────────────────────────────────────────────────────────
  const outDir = path.resolve('snapshots');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `b4-holders-${snapshotBlock}.json`);
  const payload = {
    token,
    symbol,
    decimals,
    block: snapshotBlock,
    takenAt: new Date().toISOString(),
    totalSupply: totalSupplyRaw.toString(),
    totalSupplyFormatted: supplyFmt,
    holderCount: holders.length,
    holders,
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`\n✅ Wrote ${outPath}`);
  console.log(`   ${holders.length} holders, ${sumFmt} ${symbol} accounted for.`);
}

main().catch((err) => {
  console.error('\nFatal:', err);
  process.exit(1);
});
