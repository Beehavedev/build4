import { ethers } from 'ethers'
const BSC_RPC = 'https://bsc-dataseed.binance.org'
const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955'
const ABI = ['function balanceOf(address) view returns (uint256)']

async function check(addr: string, label: string) {
  const provider = new ethers.JsonRpcProvider(BSC_RPC)
  const [bnb, usdt] = await Promise.all([
    provider.getBalance(addr),
    new ethers.Contract(USDT_BSC, ABI, provider).balanceOf(addr)
  ])
  console.log(`${label}: ${ethers.formatUnits(usdt, 18)} USDT, ${ethers.formatEther(bnb)} BNB`)
}

await check('0x0000000000000000000000000000000000000000', 'zero address')
// Binance hot wallet — should show plenty of USDT
await check('0xF977814e90dA44bFA03b6295A0616a897441aceC', 'binance hot wallet')

// Now test strict failure: bogus RPC
try {
  const bad = new ethers.JsonRpcProvider('https://no.such.rpc.local:1/x')
  await bad.getBalance('0x0000000000000000000000000000000000000000')
  console.log('❌ expected failure but did not throw')
} catch (e: any) {
  console.log(`✅ strict mode throws on bad RPC: ${e.code ?? e.message?.slice(0, 60)}`)
}
