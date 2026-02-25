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
  const contracts = deployment.contracts;
  const deployer = deployment.deployer;

  console.log(`\nVerifying contracts on ${network} (chain ${deployment.chainId})`);
  console.log(`Deployer: ${deployer}\n`);

  const hubAddress = contracts.AgentEconomyHub;

  const verifications = [
    {
      name: "AgentEconomyHub",
      address: contracts.AgentEconomyHub,
      constructorArguments: [],
    },
    {
      name: "ConstitutionRegistry",
      address: contracts.ConstitutionRegistry,
      constructorArguments: [],
    },
    {
      name: "SkillMarketplace",
      address: contracts.SkillMarketplace,
      constructorArguments: [hubAddress, deployer],
    },
    {
      name: "AgentReplication",
      address: contracts.AgentReplication,
      constructorArguments: [hubAddress],
    },
  ];

  const results = [];

  for (const v of verifications) {
    console.log(`--- Verifying ${v.name} at ${v.address} ---`);
    if (v.constructorArguments.length > 0) {
      console.log(`  Constructor args: ${JSON.stringify(v.constructorArguments)}`);
    }

    try {
      await hre.run("verify:verify", {
        address: v.address,
        constructorArguments: v.constructorArguments,
        contract: `contracts/web4/${v.name}.sol:${v.name}`,
      });
      console.log(`  ✓ ${v.name} verified successfully!\n`);
      results.push({ name: v.name, status: "verified" });
    } catch (err) {
      if (err.message.includes("Already Verified") || err.message.includes("already verified")) {
        console.log(`  ✓ ${v.name} already verified.\n`);
        results.push({ name: v.name, status: "already_verified" });
      } else {
        console.error(`  ✗ ${v.name} verification failed: ${err.message}\n`);
        results.push({ name: v.name, status: "failed", error: err.message });
      }
    }
  }

  console.log("\n=== Verification Summary ===");
  for (const r of results) {
    const icon = r.status === "failed" ? "✗" : "✓";
    console.log(`${icon} ${r.name}: ${r.status}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
