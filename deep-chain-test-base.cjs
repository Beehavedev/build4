const { ethers } = require("ethers");
const fs = require("fs");

const deployment = JSON.parse(fs.readFileSync("contracts/deployments/baseTestnet.json", "utf8"));

const HubABI = [
  "function owner() view returns (address)",
  "function authorizedModules(address) view returns (bool)",
  "function registerAgent(uint256 agentId) external",
  "function deposit(uint256 agentId) external payable",
  "function withdraw(uint256 agentId, uint256 amount, address to) external",
  "function transfer(uint256 fromId, uint256 toId, uint256 amount) external",
  "function getBalance(uint256 agentId) view returns (uint256)",
  "function isAgentRegistered(uint256 agentId) view returns (bool)"
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
  "function skills(uint256) view returns (uint256 agentId, string name, string metadataUri, uint256 price, uint256 totalSales, uint256 totalRevenue, bool isActive, bool exists)",
  "function agentOwnsSkill(uint256, uint256) view returns (bool)",
  "function nextSkillId() view returns (uint256)"
];
const ReplicationABI = [
  "function replicate(uint256 parentId, uint256 childId, uint256 revenueShareBps, uint256 fundingAmount) external",
  "function getParent(uint256 childId) view returns (uint256 parentId, uint256 revenueShareBps, bool exists)",
  "function agentGeneration(uint256) view returns (uint256)"
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function send(contract, method, ...args) {
  const tx = await contract[method](...args);
  const receipt = await tx.wait();
  await sleep(1500);
  return receipt;
}

async function main() {
  const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  
  const hub = new ethers.Contract(deployment.contracts.AgentEconomyHub, HubABI, wallet);
  const market = new ethers.Contract(deployment.contracts.SkillMarketplace, MarketABI, wallet);
  const constitution = new ethers.Contract(deployment.contracts.ConstitutionRegistry, ConstitutionABI, wallet);
  const replication = new ethers.Contract(deployment.contracts.AgentReplication, ReplicationABI, wallet);

  let passed = 0, failed = 0;
  async function test(name, fn) {
    try { await fn(); passed++; console.log("PASS:", name); }
    catch (e) { failed++; console.log("FAIL:", name, "-", e.message.substring(0, 200)); }
  }

  const ts = Date.now();
  const A = ts, B = ts + 1, C = ts + 2;
  const R = BigInt(ts + 100), G = BigInt(ts + 200);

  console.log("\n=== BASE SEPOLIA: Full Deep Test Suite ===");

  // --- HUB ---
  await test("Hub: Owner check", async () => {
    if ((await hub.owner()).toLowerCase() !== wallet.address.toLowerCase()) throw new Error("Mismatch");
  });
  await test("Hub: Register + Deposit A", async () => { 
    await send(hub, "registerAgent", A);
    await send(hub, "deposit", A, { value: ethers.parseEther("0.01") });
    const b = await hub.getBalance(A);
    if (b !== ethers.parseEther("0.01")) throw new Error("Got " + ethers.formatEther(b));
  });
  await test("Hub: Register + Deposit B", async () => { 
    await send(hub, "registerAgent", B);
    await send(hub, "deposit", B, { value: ethers.parseEther("0.005") });
  });
  await test("Hub: Transfer A->B", async () => {
    await send(hub, "transfer", A, B, ethers.parseEther("0.002"));
    const bB = await hub.getBalance(B);
    if (bB !== ethers.parseEther("0.007")) throw new Error("B=" + ethers.formatEther(bB));
  });
  await test("Hub: Withdraw from A", async () => {
    const before = await hub.getBalance(A);
    await send(hub, "withdraw", A, ethers.parseEther("0.001"), wallet.address);
    const after = await hub.getBalance(A);
    if (after >= before) throw new Error("No decrease");
  });
  await test("Hub: Modules authorized", async () => {
    if (!(await hub.authorizedModules(deployment.contracts.SkillMarketplace))) throw new Error("M");
    if (!(await hub.authorizedModules(deployment.contracts.AgentReplication))) throw new Error("R");
  });

  // --- CONSTITUTION ---
  const l1 = ethers.keccak256(ethers.toUtf8Bytes("No harm"));
  const l2 = ethers.keccak256(ethers.toUtf8Bytes("Preserve self"));
  await test("Constitution: Add 2 laws + seal", async () => {
    await send(constitution, "addLaw", A, l1, true);
    await send(constitution, "addLaw", A, l2, false);
    const c = await constitution.getLawCount(A);
    if (c !== 2n) throw new Error("Count: " + c);
    const [h,,imm] = await constitution.getLaw(A, 0);
    if (h !== l1 || !imm) throw new Error("Law 0 wrong");
    await send(constitution, "sealConstitution", A);
    if (!(await constitution.isSealed(A))) throw new Error("Not sealed");
    console.log("  Hash:", await constitution.getConstitutionHash(A));
  });
  await test("Constitution: Reject post-seal", async () => {
    try { await send(constitution, "addLaw", A, l1, false); throw new Error("X"); }
    catch(e) { if (e.message === "X") throw e; }
  });

  // --- MARKETPLACE ---
  await test("Marketplace: List + purchase + verify", async () => {
    const sid = await market.nextSkillId();
    await send(market, "listSkill", A, "BaseSkill", "ipfs://b", ethers.parseEther("0.001"));
    const s = await market.skills(sid);
    if (!s.isActive) throw new Error("Not active");
    const before = await hub.getBalance(A);
    await send(market, "purchaseSkill", B, sid);
    const after = await hub.getBalance(A);
    console.log("  Seller earned:", ethers.formatEther(after - before));
    if (after <= before) throw new Error("No payment");
    if (!(await market.agentOwnsSkill(B, sid))) throw new Error("No ownership");
  });
  await test("Marketplace: Duplicate blocked", async () => {
    const sid = (await market.nextSkillId()) - 1n;
    try { await send(market, "purchaseSkill", B, sid); throw new Error("X"); }
    catch(e) { if (e.message === "X") throw e; }
  });

  // --- REPLICATION ---
  await test("Replication: Spawn child with funding + lineage", async () => {
    await send(hub, "deposit", A, { value: ethers.parseEther("0.01") });
    await send(replication, "replicate", A, R, 1500, ethers.parseEther("0.003"));
    const b = await hub.getBalance(R);
    if (b !== ethers.parseEther("0.003")) throw new Error("Wrong: " + ethers.formatEther(b));
    const [p, s, e] = await replication.getParent(R);
    if (!e || p !== BigInt(A) || s !== 1500n) throw new Error("Bad lineage");
    if ((await replication.agentGeneration(R)) !== 1n) throw new Error("Gen wrong");
    console.log("  Child funded:", ethers.formatEther(b), ", Gen: 1, Share: 1500bps");
  });

  // --- CROSS-CONTRACT ---
  await test("Cross: Grandchild + revenue share flow", async () => {
    await send(hub, "deposit", R, { value: ethers.parseEther("0.005") });
    await send(replication, "replicate", R, G, 2000, ethers.parseEther("0.001"));
    const gen = await replication.agentGeneration(G);
    if (gen !== 2n) throw new Error("Gen: " + gen);
    await send(hub, "registerAgent", C);
    await send(hub, "deposit", C, { value: ethers.parseEther("0.005") });
    const sid = await market.nextSkillId();
    await send(market, "listSkill", G, "GCSkill", "ipfs://gc", ethers.parseEther("0.001"));
    const rBefore = await hub.getBalance(R);
    await send(market, "purchaseSkill", C, sid);
    const rAfter = await hub.getBalance(R);
    console.log("  Parent R revenue:", ethers.formatEther(rAfter - rBefore), "ETH");
    console.log("  Grandchild gen:", gen.toString());
    if (rAfter <= rBefore) throw new Error("No revenue share");
  });

  console.log("\n===========================================");
  console.log("BASE SEPOLIA: " + passed + " passed, " + failed + " failed out of " + (passed + failed));
  console.log("===========================================");
}
main().catch(e => console.error("Fatal:", e.message));
