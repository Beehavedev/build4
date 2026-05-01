const hre = require("hardhat");
const fs = require("fs");

const B4_TOKEN_ADDRESS = "0x1d547f9d0890ee5abfb49d7d53ca19df85da4444";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying BUILD4Staking with account:", deployer.address);
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", hre.ethers.formatEther(balance), "native");
  console.log("Network:", hre.network.name, "ChainId:", hre.network.config.chainId);

  let nonce = await hre.ethers.provider.getTransactionCount(deployer.address, "latest");
  console.log("Starting nonce:", nonce);

  console.log("\n--- 1. Deploying BUILD4Staking ---");
  const Staking = await hre.ethers.getContractFactory("BUILD4Staking");
  const staking = await Staking.deploy({ nonce: nonce++ });
  await staking.waitForDeployment();
  const stakingAddress = await staking.getAddress();
  console.log("BUILD4Staking deployed to:", stakingAddress);
  await sleep(3000);

  const isBNBChain = hre.network.config.chainId === 56;

  if (isBNBChain) {
    console.log("\n--- 2. Setting $B4 staking token ---");
    console.log("$B4 Token:", B4_TOKEN_ADDRESS);
    const tx = await staking.setStakingToken(B4_TOKEN_ADDRESS, { nonce: nonce++ });
    await tx.wait();
    console.log("Staking token set to $B4");
    await sleep(3000);
  } else {
    console.log("\n--- 2. Skipping token set (not BNB Chain) ---");
    console.log("Set staking token manually after deploying $B4 on this chain:");
    console.log(`  staking.setStakingToken(<B4_TOKEN_ADDRESS>)`);
  }

  console.log("\n=== Staking Deployment Complete ===");
  console.log({ BUILD4Staking: stakingAddress });

  const deploymentPath = `./contracts/deployments/${hre.network.name}.json`;
  let deploymentData = {};

  if (fs.existsSync(deploymentPath)) {
    deploymentData = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
    deploymentData.contracts.BUILD4Staking = stakingAddress;
    deploymentData.stakingDeployedAt = new Date().toISOString();
  } else {
    deploymentData = {
      network: hre.network.name,
      chainId: hre.network.config.chainId,
      deployer: deployer.address,
      timestamp: new Date().toISOString(),
      contracts: {
        BUILD4Staking: stakingAddress,
      },
    };
  }

  fs.writeFileSync(deploymentPath, JSON.stringify(deploymentData, null, 2));
  console.log(`\nDeployment saved to ${deploymentPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
