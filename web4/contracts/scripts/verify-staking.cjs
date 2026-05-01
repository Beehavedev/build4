const hre = require("hardhat");
const fs = require("fs");

async function main() {
  const network = hre.network.name;
  const deploymentPath = `./contracts/deployments/${network}.json`;

  if (!fs.existsSync(deploymentPath)) {
    console.error(`No deployment found for ${network}`);
    process.exit(1);
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const stakingAddress = deployment.contracts.BUILD4Staking;

  if (!stakingAddress) {
    console.error("BUILD4Staking not found in deployment record");
    process.exit(1);
  }

  console.log(`\nVerifying BUILD4Staking on ${network} (chain ${deployment.chainId})`);
  console.log(`Address: ${stakingAddress}\n`);

  try {
    await hre.run("verify:verify", {
      address: stakingAddress,
      constructorArguments: [],
      contract: "contracts/web4/BUILD4Staking.sol:BUILD4Staking",
    });
    console.log("BUILD4Staking verified successfully!");
  } catch (err) {
    if (err.message.includes("Already Verified") || err.message.includes("already verified")) {
      console.log("BUILD4Staking already verified.");
    } else {
      console.error(`Verification failed: ${err.message}`);
      process.exit(1);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
