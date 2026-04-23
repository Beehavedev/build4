/**
 * Deploy the ERC-8004 IdentityRegistry to XLayer (chain id 196).
 *
 * Strategy: replay the EXACT creation bytecode of the BSC registry at
 * 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 on XLayer. We pull the
 * original contract-creation tx from BscScan, take its `input` field
 * (constructor + runtime bytecode), and broadcast a new contract
 * creation tx on XLayer with the same payload.
 *
 * This avoids dragging Foundry/solc into the repo and guarantees that
 * `src/services/erc8004.ts`'s ABI + behaviour match the deployed code.
 *
 * Safety rails:
 *   - Refuses to broadcast unless `--confirm` is passed on the CLI.
 *   - Prints deployer address + OKB balance and waits for human eyes.
 *   - Aborts if OKB balance is below a sanity floor (5 OKB).
 *
 * Usage:
 *   npx tsx scripts/deployRegistryXLayer.ts            # dry run
 *   npx tsx scripts/deployRegistryXLayer.ts --confirm  # deploy
 *
 * Env required:
 *   REGISTRY_WALLET_PK             (must match the wallet you funded with OKB)
 *   BSCSCAN_API_KEY or ETHERSCAN_API_KEY  (for fetching creation bytecode)
 *   XLAYER_RPC_URL                 (optional override of default RPCs)
 */
import { ethers } from 'ethers';
import { buildXLayerProvider, xlayerScanUrl } from '../src/services/xlayerProvider';

const BSC_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const MIN_OKB_BALANCE = ethers.parseEther('5'); // sanity floor; deploy needs ~0.05-0.5 OKB worst case

async function fetchCreationBytecode(registryAddress: string): Promise<{ creationInput: string; creatorTx: string; creator: string }> {
  const apiKey = process.env.BSCSCAN_API_KEY ?? process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    throw new Error('BSCSCAN_API_KEY (or ETHERSCAN_API_KEY) is required to fetch the original creation bytecode.');
  }

  // Step 1: get the creation tx hash + creator address.
  const creationUrl = `https://api.etherscan.io/v2/api?chainid=56&module=contract&action=getcontractcreation&contractaddresses=${registryAddress}&apikey=${apiKey}`;
  const creationRes = await fetch(creationUrl);
  const creationData: any = await creationRes.json();
  if (creationData.status !== '1' || !Array.isArray(creationData.result) || creationData.result.length === 0) {
    throw new Error(`Etherscan getcontractcreation failed: ${JSON.stringify(creationData)}`);
  }
  const creatorTx: string = creationData.result[0].txHash;
  const creator: string = creationData.result[0].contractCreator;

  // Step 2: fetch the original tx — its `input` IS the creation bytecode.
  const bscProvider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org');
  const tx = await bscProvider.getTransaction(creatorTx);
  if (!tx) {
    throw new Error(`BSC RPC returned no transaction for creator hash ${creatorTx}`);
  }
  if (tx.to !== null) {
    // Some contracts are deployed via factory (CREATE2 / proxy). In that case
    // tx.input is the factory call, not the registry's creation bytecode,
    // and we cannot replay it as-is. Bail loudly so a human picks the path
    // forward (extract child contract creation from the trace, or compile
    // from verified source).
    throw new Error(
      `Creation tx ${creatorTx} was sent to ${tx.to}, not contract-creation. ` +
      `Registry was likely deployed via a factory or CREATE2. Manual extraction needed.`
    );
  }
  return { creationInput: tx.data, creatorTx, creator };
}

async function main() {
  const confirm = process.argv.includes('--confirm');

  const pk = process.env.REGISTRY_WALLET_PK;
  if (!pk) {
    console.error('REGISTRY_WALLET_PK is not set. Aborting.');
    process.exit(1);
  }
  const pkNorm = pk.startsWith('0x') ? pk : '0x' + pk;

  const provider = buildXLayerProvider(process.env.XLAYER_RPC_URL);
  const wallet = new ethers.Wallet(pkNorm, provider);
  const deployer = wallet.address;

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' ERC-8004 Registry → XLayer (chain id 196) deploy plan');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Deployer address  : ${deployer}`);
  console.log(`OKLink            : ${xlayerScanUrl(deployer)}`);

  const balance = await provider.getBalance(deployer);
  console.log(`OKB balance       : ${ethers.formatEther(balance)} OKB`);
  if (balance < MIN_OKB_BALANCE) {
    console.error(`\n❌ Balance below safety floor (${ethers.formatEther(MIN_OKB_BALANCE)} OKB). Top up before retrying.`);
    process.exit(1);
  }

  console.log(`Source registry   : ${BSC_REGISTRY} (BSC)`);
  console.log('Fetching original creation bytecode from BscScan…');
  const { creationInput, creatorTx, creator } = await fetchCreationBytecode(BSC_REGISTRY);
  console.log(`Original creator  : ${creator}`);
  console.log(`Original tx       : ${creatorTx}`);
  console.log(`Bytecode size     : ${(creationInput.length - 2) / 2} bytes`);

  // Estimate gas. ContractCreation gas is ~32k base + ~200 per byte of code +
  // execution cost of the constructor. ERC-8004 IdentityRegistry deploys at
  // ~2-3M gas typically. We add 30% headroom.
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? ethers.parseUnits('1', 'gwei');
  const estGas = await provider.estimateGas({ from: deployer, data: creationInput }).catch((e) => {
    console.error(`\n❌ estimateGas reverted — the creation bytecode likely depends on chain-specific state we don't have here. Error: ${e.shortMessage ?? e.message}`);
    process.exit(1);
  }) as bigint;
  const gasLimit = (estGas * 130n) / 100n;
  const cost = gasPrice * gasLimit;
  console.log(`Estimated gas     : ${estGas.toString()} (limit ${gasLimit.toString()})`);
  console.log(`Gas price         : ${ethers.formatUnits(gasPrice, 'gwei')} gwei`);
  console.log(`Estimated cost    : ${ethers.formatEther(cost)} OKB`);

  if (!confirm) {
    console.log('\nDry run complete. Re-run with --confirm to broadcast the creation tx.');
    process.exit(0);
  }

  console.log('\nBroadcasting creation tx…');
  const tx = await wallet.sendTransaction({ data: creationInput, gasLimit });
  console.log(`Tx hash           : ${tx.hash}`);
  console.log(`OKLink            : ${xlayerScanUrl(tx.hash)}`);
  console.log('Waiting for receipt…');
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    console.error('❌ Tx reverted.');
    process.exit(1);
  }
  if (!receipt.contractAddress) {
    console.error('❌ Receipt has no contractAddress (was this a contract-creation tx?).');
    process.exit(1);
  }
  console.log('\n✅ Deployed.');
  console.log(`Registry address  : ${receipt.contractAddress}`);
  console.log(`OKLink            : ${xlayerScanUrl(receipt.contractAddress)}`);
  console.log('\nNext step: set the env var');
  console.log(`   XLAYER_ERC8004_REGISTRY=${receipt.contractAddress}`);
  console.log('and redeploy. Then run a test /newagent on XLayer.');
}

main().catch((err) => {
  console.error('\nFatal:', err);
  process.exit(1);
});
