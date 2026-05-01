const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying Web4 contracts with account:", deployer.address);
  console.log("Account balance:", (await hre.ethers.provider.getBalance(deployer.address)).toString());

  console.log("\n--- 1. Deploying AgentEconomyHub ---");
  const Hub = await hre.ethers.getContractFactory("AgentEconomyHub");
  const hub = await Hub.deploy();
  await hub.waitForDeployment();
  const hubAddress = await hub.getAddress();
  console.log("AgentEconomyHub deployed to:", hubAddress);

  console.log("\n--- 2. Deploying ConstitutionRegistry ---");
  const Constitution = await hre.ethers.getContractFactory("ConstitutionRegistry");
  const constitution = await Constitution.deploy();
  await constitution.waitForDeployment();
  const constitutionAddress = await constitution.getAddress();
  console.log("ConstitutionRegistry deployed to:", constitutionAddress);

  console.log("\n--- 3. Deploying SkillMarketplace ---");
  const Marketplace = await hre.ethers.getContractFactory("SkillMarketplace");
  const marketplace = await Marketplace.deploy(hubAddress, deployer.address);
  await marketplace.waitForDeployment();
  const marketplaceAddress = await marketplace.getAddress();
  console.log("SkillMarketplace deployed to:", marketplaceAddress);

  console.log("\n--- 4. Deploying AgentReplication ---");
  const Replication = await hre.ethers.getContractFactory("AgentReplication");
  const replication = await Replication.deploy(hubAddress);
  await replication.waitForDeployment();
  const replicationAddress = await replication.getAddress();
  console.log("AgentReplication deployed to:", replicationAddress);

  console.log("\n--- 5. Wiring Module Authorization ---");
  let tx = await hub.authorizeModule(marketplaceAddress, true);
  await tx.wait();
  console.log("SkillMarketplace authorized on Hub");

  tx = await hub.authorizeModule(replicationAddress, true);
  await tx.wait();
  console.log("AgentReplication authorized on Hub");

  tx = await marketplace.setLineageContract(replicationAddress);
  await tx.wait();
  console.log("Lineage contract set on SkillMarketplace");

  console.log("\n=== Deployment Complete ===");
  console.log({
    AgentEconomyHub: hubAddress,
    ConstitutionRegistry: constitutionAddress,
    SkillMarketplace: marketplaceAddress,
    AgentReplication: replicationAddress,
  });

  const fs = require("fs");
  const deploymentData = {
    network: hre.network.name,
    chainId: hre.network.config.chainId,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    contracts: {
      AgentEconomyHub: hubAddress,
      ConstitutionRegistry: constitutionAddress,
      SkillMarketplace: marketplaceAddress,
      AgentReplication: replicationAddress,
    },
  };

  fs.writeFileSync(
    `./contracts/deployments/${hre.network.name}.json`,
    JSON.stringify(deploymentData, null, 2)
  );
  console.log(`\nDeployment saved to contracts/deployments/${hre.network.name}.json`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
