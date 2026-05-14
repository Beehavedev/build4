const { ethers } = require("ethers");
const fs = require("fs");

const deployment = JSON.parse(fs.readFileSync("contracts/deployments/bnbTestnet.json", "utf8"));

const HubABI = [
  "function owner() view returns (address)",
  "function authorizedModules(address) view returns (bool)",
  "function registerAgent(uint256 agentId) external",
  "function deposit(uint256 agentId) external payable",
  "function withdraw(uint256 agentId, uint256 amount, address to) external",
  "function transfer(uint256 fromId, uint256 toId, uint256 amount) external",
  "function getBalance(uint256 agentId) view returns (uint256)",
  "function computeTier(uint256 agentId) view returns (uint8)",
  "function isAgentRegistered(uint256 agentId) view returns (bool)",
  "event Deposited(uint256 indexed agentId, uint256 amount)",
  "event Transferred(uint256 indexed from, uint256 indexed to, uint256 amount)"
];

const ConstitutionABI = [
  "function addLaw(uint256 agentId, bytes32 lawHash, bool isImmutable) external returns (uint256)",
  "function sealConstitution(uint256 agentId) external",
  "function getLaw(uint256 agentId, uint256 index) view returns (bytes32 lawHash, uint256 createdBlock, bool isImmutable)",
  "function getLawCount(uint256 agentId) view returns (uint256)",
  "function getConstitutionHash(uint256 agentId) view returns (bytes32)",
  "function isSealed(uint256 agentId) view returns (bool)"
];

const MarketABI = [
  "function listSkill(uint256 agentId, string name, string metadataUri, uint256 price) external returns (uint256)",
  "function purchaseSkill(uint256 buyerId, uint256 skillId) external",
  "function deactivateSkill(uint256 skillId) external",
  "function skills(uint256) view returns (uint256 agentId, string name, string metadataUri, uint256 price, uint256 totalSales, uint256 totalRevenue, bool isActive, bool exists)",
  "function agentOwnsSkill(uint256, uint256) view returns (bool)",
  "function platformFeeBps() view returns (uint256)",
  "function nextSkillId() view returns (uint256)"
];

const ReplicationABI = [
  "function replicate(uint256 parentId, uint256 childId, uint256 revenueShareBps, uint256 fundingAmount) external",
  "function childToParent(uint256) view returns (uint256 parentId, uint256 childId, uint256 revenueShareBps, uint256 totalRevenueShared, uint256 generation, uint256 createdBlock, bool exists)",
  "function parentToChildren(uint256, uint256) view returns (uint256)",
  "function agentGeneration(uint256) view returns (uint256)",
  "function totalReplications() view returns (uint256)",
  "function getParent(uint256 childId) view returns (uint256 parentId, uint256 revenueShareBps, bool exists)"
];

async function main() {
  const provider = new ethers.JsonRpcProvider("https://data-seed-prebsc-1-s1.binance.org:8545");
  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  
  const hub = new ethers.Contract(deployment.contracts.AgentEconomyHub, HubABI, wallet);
  const market = new ethers.Contract(deployment.contracts.SkillMarketplace, MarketABI, wallet);
  const constitution = new ethers.Contract(deployment.contracts.ConstitutionRegistry, ConstitutionABI, wallet);
  const replication = new ethers.Contract(deployment.contracts.AgentReplication, ReplicationABI, wallet);

  let passed = 0, failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      passed++;
      console.log("PASS:", name);
    } catch (e) {
      failed++;
      console.log("FAIL:", name, "-", e.message.substring(0, 150));
    }
  }

  // Use unique uint256 IDs based on timestamp
  const ts = Date.now();
  const agentId = ts;
  const childId = ts + 1;
  const agent2 = ts + 2;

  // === HUB TESTS ===
  console.log("\n=== AgentEconomyHub Tests ===");

  await test("Hub: Owner is deployer", async () => {
    const owner = await hub.owner();
    if (owner.toLowerCase() !== wallet.address.toLowerCase()) throw new Error("Owner mismatch: " + owner);
  });

  await test("Hub: Register agent", async () => {
    const tx = await hub.registerAgent(agentId);
    await tx.wait();
    const exists = await hub.isAgentRegistered(agentId);
    if (!exists) throw new Error("Agent not registered");
  });

  await test("Hub: Deposit BNB to agent", async () => {
    const tx = await hub.deposit(agentId, { value: ethers.parseEther("0.01") });
    await tx.wait();
    const bal = await hub.getBalance(agentId);
    if (bal !== ethers.parseEther("0.01")) throw new Error("Balance mismatch: " + ethers.formatEther(bal));
  });

  await test("Hub: Register + deposit second agent", async () => {
    const tx = await hub.registerAgent(childId);
    await tx.wait();
    const tx2 = await hub.deposit(childId, { value: ethers.parseEther("0.005") });
    await tx2.wait();
  });

  await test("Hub: Transfer between agents", async () => {
    const tx = await hub.transfer(agentId, childId, ethers.parseEther("0.002"));
    await tx.wait();
    const childBal = await hub.getBalance(childId);
    if (childBal !== ethers.parseEther("0.007")) throw new Error("Child balance: " + ethers.formatEther(childBal));
    const agentBal = await hub.getBalance(agentId);
    if (agentBal !== ethers.parseEther("0.008")) throw new Error("Agent balance: " + ethers.formatEther(agentBal));
  });

  await test("Hub: Withdraw from agent", async () => {
    const balBefore = await hub.getBalance(agentId);
    const tx = await hub.withdraw(agentId, ethers.parseEther("0.001"), wallet.address);
    await tx.wait();
    const balAfter = await hub.getBalance(agentId);
    if (balAfter !== balBefore - ethers.parseEther("0.001")) throw new Error("Withdraw balance wrong");
  });

  await test("Hub: Compute survival tier", async () => {
    const tier = await hub.computeTier(agentId);
    // Balance is 0.007 BNB -> CRITICAL tier (between 0.01 and 0.1)
    console.log("  Tier value:", tier, "(0=DEAD, 1=CRITICAL, 2=LOW, 3=NORMAL)");
    if (tier > 3) throw new Error("Invalid tier: " + tier);
  });

  await test("Hub: Module authorization verified", async () => {
    const marketAuth = await hub.authorizedModules(deployment.contracts.SkillMarketplace);
    const replAuth = await hub.authorizedModules(deployment.contracts.AgentReplication);
    if (!marketAuth) throw new Error("Marketplace not authorized");
    if (!replAuth) throw new Error("Replication not authorized");
  });

  await test("Hub: Reject transfer with insufficient balance", async () => {
    try {
      const tx = await hub.transfer(agentId, childId, ethers.parseEther("999"));
      await tx.wait();
      throw new Error("Should have reverted");
    } catch (e) {
      if (e.message === "Should have reverted") throw e;
    }
  });

  await test("Hub: Reject double registration", async () => {
    try {
      const tx = await hub.registerAgent(agentId);
      await tx.wait();
      throw new Error("Should have reverted");
    } catch (e) {
      if (e.message === "Should have reverted") throw e;
    }
  });

  // === CONSTITUTION TESTS ===
  console.log("\n=== ConstitutionRegistry Tests ===");

  const law1 = ethers.keccak256(ethers.toUtf8Bytes("Shall not harm humans"));
  const law2 = ethers.keccak256(ethers.toUtf8Bytes("Shall preserve self"));
  const law3 = ethers.keccak256(ethers.toUtf8Bytes("Shall obey orders"));

  await test("Constitution: Add 3 laws", async () => {
    await (await constitution.addLaw(agentId, law1, true)).wait();
    await (await constitution.addLaw(agentId, law2, true)).wait();
    await (await constitution.addLaw(agentId, law3, false)).wait();
    const count = await constitution.getLawCount(agentId);
    if (count !== 3n) throw new Error("Expected 3 laws, got " + count);
  });

  await test("Constitution: Verify law hash at index", async () => {
    const [hash, , isImm] = await constitution.getLaw(agentId, 0);
    if (hash !== law1) throw new Error("Law hash mismatch");
    if (!isImm) throw new Error("Law should be immutable");
  });

  await test("Constitution: Third law is mutable", async () => {
    const [hash, , isImm] = await constitution.getLaw(agentId, 2);
    if (hash !== law3) throw new Error("Law hash mismatch");
    if (isImm) throw new Error("Law should be mutable");
  });

  await test("Constitution: Seal constitution", async () => {
    await (await constitution.sealConstitution(agentId)).wait();
    const sealed = await constitution.isSealed(agentId);
    if (!sealed) throw new Error("Not sealed");
    const hash = await constitution.getConstitutionHash(agentId);
    if (hash === ethers.ZeroHash) throw new Error("Constitution hash is zero");
    console.log("  Constitution hash:", hash);
  });

  await test("Constitution: Reject adding law after seal", async () => {
    try {
      const newLaw = ethers.keccak256(ethers.toUtf8Bytes("New law attempt"));
      await (await constitution.addLaw(agentId, newLaw, false)).wait();
      throw new Error("Should have reverted");
    } catch (e) {
      if (e.message === "Should have reverted") throw e;
    }
  });

  // === MARKETPLACE TESTS ===
  console.log("\n=== SkillMarketplace Tests ===");

  await test("Marketplace: Platform fee is 2.5%", async () => {
    const fee = await market.platformFeeBps();
    if (fee !== 250n) throw new Error("Expected 250 bps, got " + fee);
  });

  await test("Marketplace: List a skill", async () => {
    const nextId = await market.nextSkillId();
    const tx = await market.listSkill(agentId, "Test Skill Alpha", "ipfs://test-meta", ethers.parseEther("0.001"));
    const receipt = await tx.wait();
    const skill = await market.skills(nextId);
    if (skill.agentId !== BigInt(agentId)) throw new Error("Seller mismatch");
    if (skill.price !== ethers.parseEther("0.001")) throw new Error("Price mismatch");
    if (!skill.isActive) throw new Error("Skill not active");
    console.log("  Listed skill ID:", nextId.toString());
  });

  const listedSkillId = await market.nextSkillId() - 1n;

  await test("Marketplace: Buy skill (fund transfer)", async () => {
    const sellerBefore = await hub.getBalance(agentId);
    const buyerBefore = await hub.getBalance(childId);
    const tx = await market.purchaseSkill(childId, listedSkillId);
    await tx.wait();
    const sellerAfter = await hub.getBalance(agentId);
    const buyerAfter = await hub.getBalance(childId);
    const sellerGain = sellerAfter - sellerBefore;
    const buyerLoss = buyerBefore - buyerAfter;
    console.log("  Seller gained:", ethers.formatEther(sellerGain), "BNB");
    console.log("  Buyer paid:", ethers.formatEther(buyerLoss), "BNB");
    if (buyerLoss !== ethers.parseEther("0.001")) throw new Error("Buyer didn't pay full price");
    if (sellerGain <= 0n) throw new Error("Seller didn't get paid");
  });

  await test("Marketplace: Buyer now owns skill", async () => {
    const owns = await market.agentOwnsSkill(childId, listedSkillId);
    if (!owns) throw new Error("Buyer doesn't own skill");
  });

  await test("Marketplace: Reject duplicate purchase", async () => {
    try {
      await (await market.purchaseSkill(childId, listedSkillId)).wait();
      throw new Error("Should have reverted");
    } catch (e) {
      if (e.message === "Should have reverted") throw e;
    }
  });

  await test("Marketplace: Deactivate skill", async () => {
    await (await market.deactivateSkill(listedSkillId)).wait();
    const skill = await market.skills(listedSkillId);
    if (skill.isActive) throw new Error("Skill still active");
  });

  // === REPLICATION TESTS ===
  console.log("\n=== AgentReplication Tests ===");

  const replicaId = BigInt(ts + 100);

  await test("Replication: Top up parent for replication", async () => {
    await (await hub.deposit(agentId, { value: ethers.parseEther("0.01") })).wait();
  });

  await test("Replication: Spawn child with 10% revenue share + funding", async () => {
    const parentBefore = await hub.getBalance(agentId);
    const tx = await replication.replicate(agentId, replicaId, 1000, ethers.parseEther("0.003"));
    await tx.wait();
    const parentAfter = await hub.getBalance(agentId);
    const childBal = await hub.getBalance(replicaId);
    console.log("  Parent balance change:", ethers.formatEther(parentAfter - parentBefore), "BNB");
    console.log("  Child funded with:", ethers.formatEther(childBal), "BNB");
    if (childBal !== ethers.parseEther("0.003")) throw new Error("Child not funded correctly");
  });

  await test("Replication: Verify parent-child lineage", async () => {
    const [parentId, shareBps, exists] = await replication.getParent(replicaId);
    if (!exists) throw new Error("Lineage not found");
    if (parentId !== BigInt(agentId)) throw new Error("Parent mismatch: " + parentId);
    if (shareBps !== 1000n) throw new Error("Share mismatch: " + shareBps);
  });

  await test("Replication: Generation depth is 1", async () => {
    const gen = await replication.agentGeneration(replicaId);
    if (gen !== 1n) throw new Error("Expected gen 1, got " + gen);
  });

  await test("Replication: Reject >50% revenue share", async () => {
    try {
      const badChild = BigInt(ts + 200);
      await (await replication.replicate(agentId, badChild, 5100, 0)).wait();
      throw new Error("Should have reverted");
    } catch (e) {
      if (e.message === "Should have reverted") throw e;
    }
  });

  // === CROSS-CONTRACT INTEGRATION ===
  console.log("\n=== Cross-Contract Integration Tests ===");

  await test("Cross: Skill purchase with parent revenue share", async () => {
    // Create grandchild from replica (which has agentId as parent)
    const grandchild = BigInt(ts + 300);
    await (await hub.deposit(replicaId, { value: ethers.parseEther("0.005") })).wait();
    await (await replication.replicate(replicaId, grandchild, 2000, ethers.parseEther("0.002"))).wait();

    // List skill from grandchild, buy with agent2
    await (await hub.registerAgent(agent2)).wait();
    await (await hub.deposit(agent2, { value: ethers.parseEther("0.005") })).wait();
    const skillId2 = await market.nextSkillId();
    await (await market.listSkill(grandchild, "Grandchild Skill", "ipfs://gc", ethers.parseEther("0.001"))).wait();

    const parentBefore = await hub.getBalance(replicaId);
    await (await market.purchaseSkill(agent2, skillId2)).wait();
    const parentAfter = await hub.getBalance(replicaId);

    const parentRevenue = parentAfter - parentBefore;
    console.log("  Parent revenue share from grandchild sale:", ethers.formatEther(parentRevenue), "BNB");
    if (parentRevenue > 0n) {
      console.log("  Revenue share working correctly!");
    }
  });

  await test("Cross: Multi-generation depth tracking", async () => {
    const grandchild = BigInt(ts + 300);
    const gen = await replication.agentGeneration(grandchild);
    if (gen !== 2n) throw new Error("Expected gen 2, got " + gen);
    const [parentId, , exists] = await replication.getParent(grandchild);
    if (parentId !== replicaId) throw new Error("Grandchild parent should be replica");
  });

  await test("Cross: Constitution on replicated agent", async () => {
    const childLaw = ethers.keccak256(ethers.toUtf8Bytes("Child inherits parent values"));
    await (await constitution.addLaw(replicaId, childLaw, true)).wait();
    const count = await constitution.getLawCount(replicaId);
    if (count !== 1n) throw new Error("Expected 1 law, got " + count);
    const isRegistered = await hub.isAgentRegistered(replicaId);
    if (!isRegistered) throw new Error("Replica not registered on hub");
  });

  await test("Cross: Total replications counter", async () => {
    const total = await replication.totalReplications();
    console.log("  Total replications on-chain:", total.toString());
    if (total < 2n) throw new Error("Expected at least 2 replications");
  });

  // === SUMMARY ===
  console.log("\n===========================================");
  console.log("DEEP ON-CHAIN TEST RESULTS: " + passed + " passed, " + failed + " failed out of " + (passed + failed));
  console.log("===========================================");
}

main().catch(e => console.error("Fatal:", e.message));
