const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);
  
  const b4 = new hre.ethers.Contract(
    "0x1d547f9d0890ee5abfb49d7d53ca19df85da4444",
    ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"],
    deployer
  );
  
  const balance = await b4.balanceOf(deployer.address);
  const decimals = await b4.decimals();
  const symbol = await b4.symbol();
  console.log(`${symbol} Balance: ${hre.ethers.formatUnits(balance, decimals)} (${balance.toString()} raw)`);
  
  const bnbBalance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`BNB Balance: ${hre.ethers.formatEther(bnbBalance)}`);
}

main().catch(console.error);
