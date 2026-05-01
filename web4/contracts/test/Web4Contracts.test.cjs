const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("BUILD4 Smart Contracts — Full Suite", function () {
  let owner, addr1, addr2;
  let hub, constitution, marketplace, replication;

  beforeEach(async function () {
    [owner, addr1, addr2] = await ethers.getSigners();

    const Hub = await ethers.getContractFactory("AgentEconomyHub");
    hub = await Hub.deploy();
    await hub.waitForDeployment();

    const Constitution = await ethers.getContractFactory("ConstitutionRegistry");
    constitution = await Constitution.deploy();
    await constitution.waitForDeployment();

    const Marketplace = await ethers.getContractFactory("SkillMarketplace");
    marketplace = await Marketplace.deploy(await hub.getAddress(), owner.address);
    await marketplace.waitForDeployment();

    const Replication = await ethers.getContractFactory("AgentReplication");
    replication = await Replication.deploy(await hub.getAddress());
    await replication.waitForDeployment();

    await hub.authorizeModule(await marketplace.getAddress(), true);
    await hub.authorizeModule(await replication.getAddress(), true);
    await marketplace.setLineageContract(await replication.getAddress());
  });

  describe("AgentEconomyHub", function () {
    it("should register an agent", async function () {
      await hub.registerAgent(1);
      expect(await hub.isAgentRegistered(1)).to.equal(true);
    });

    it("should reject duplicate registration", async function () {
      await hub.registerAgent(1);
      await expect(hub.registerAgent(1)).to.be.revertedWith("Hub: already registered");
    });

    it("should accept deposits and update balance", async function () {
      await hub.registerAgent(1);
      await hub.deposit(1, { value: ethers.parseEther("2.0") });
      expect(await hub.getBalance(1)).to.equal(ethers.parseEther("2.0"));
    });

    it("should compute survival tiers correctly", async function () {
      await hub.registerAgent(1);
      expect(await hub.computeTier(1)).to.equal(0); // DEAD

      await hub.deposit(1, { value: ethers.parseEther("0.01") });
      expect(await hub.computeTier(1)).to.equal(1); // CRITICAL (0.01 >= TIER_CRITICAL)

      await hub.deposit(1, { value: ethers.parseEther("0.09") });
      expect(await hub.computeTier(1)).to.equal(2); // LOW_COMPUTE (0.10 >= TIER_LOW)

      await hub.deposit(1, { value: ethers.parseEther("0.9") });
      expect(await hub.computeTier(1)).to.equal(3); // NORMAL (1.0 >= TIER_NORMAL)
    });

    it("should withdraw funds to a target address", async function () {
      await hub.registerAgent(1);
      await hub.deposit(1, { value: ethers.parseEther("5.0") });

      const balBefore = await ethers.provider.getBalance(addr1.address);
      await hub.withdraw(1, ethers.parseEther("2.0"), addr1.address);
      const balAfter = await ethers.provider.getBalance(addr1.address);

      expect(balAfter - balBefore).to.equal(ethers.parseEther("2.0"));
      expect(await hub.getBalance(1)).to.equal(ethers.parseEther("3.0"));
    });

    it("should reject withdrawal exceeding balance", async function () {
      await hub.registerAgent(1);
      await hub.deposit(1, { value: ethers.parseEther("1.0") });
      await expect(hub.withdraw(1, ethers.parseEther("2.0"), addr1.address))
        .to.be.revertedWith("Hub: insufficient balance");
    });

    it("should transfer between agents", async function () {
      await hub.registerAgent(1);
      await hub.registerAgent(2);
      await hub.deposit(1, { value: ethers.parseEther("3.0") });

      await hub.transfer(1, 2, ethers.parseEther("1.5"));
      expect(await hub.getBalance(1)).to.equal(ethers.parseEther("1.5"));
      expect(await hub.getBalance(2)).to.equal(ethers.parseEther("1.5"));
    });

    it("should return full wallet data", async function () {
      await hub.registerAgent(1);
      await hub.deposit(1, { value: ethers.parseEther("2.0") });
      await hub.withdraw(1, ethers.parseEther("0.5"), addr1.address);

      const [balance, totalEarned, totalSpent] = await hub.getWallet(1);
      expect(balance).to.equal(ethers.parseEther("1.5"));
      expect(totalEarned).to.equal(ethers.parseEther("2.0"));
      expect(totalSpent).to.equal(ethers.parseEther("0.5"));
    });

    it("should only allow owner to register/withdraw", async function () {
      await expect(hub.connect(addr1).registerAgent(1))
        .to.be.reverted;
      await hub.registerAgent(1);
      await hub.deposit(1, { value: ethers.parseEther("1.0") });
      await expect(hub.connect(addr1).withdraw(1, ethers.parseEther("0.5"), addr1.address))
        .to.be.reverted;
    });

    it("should only allow authorized modules to credit/debit", async function () {
      await hub.registerAgent(1);
      await hub.deposit(1, { value: ethers.parseEther("1.0") });
      await expect(hub.connect(addr1).creditAgent(1, ethers.parseEther("1.0")))
        .to.be.revertedWith("Hub: not authorized module");
      await expect(hub.connect(addr1).debitAgent(1, ethers.parseEther("0.5")))
        .to.be.revertedWith("Hub: not authorized module");
    });

    it("should emit TierChanged on deposit crossing threshold", async function () {
      await hub.registerAgent(1);
      await expect(hub.deposit(1, { value: ethers.parseEther("1.0") }))
        .to.emit(hub, "TierChanged")
        .withArgs(1, 0, 3); // DEAD -> NORMAL
    });
  });

  describe("ConstitutionRegistry", function () {
    const lawHash1 = ethers.keccak256(ethers.toUtf8Bytes("Never harm humans"));
    const lawHash2 = ethers.keccak256(ethers.toUtf8Bytes("Always be transparent"));
    const lawHash3 = ethers.keccak256(ethers.toUtf8Bytes("Protect user data"));

    it("should add laws to an agent", async function () {
      await constitution.addLaw(1, lawHash1, true);
      await constitution.addLaw(1, lawHash2, false);
      expect(await constitution.getLawCount(1)).to.equal(2);
    });

    it("should retrieve law details", async function () {
      await constitution.addLaw(1, lawHash1, true);
      const [hash, , isImmutable] = await constitution.getLaw(1, 0);
      expect(hash).to.equal(lawHash1);
      expect(isImmutable).to.equal(true);
    });

    it("should enforce MAX_LAWS limit", async function () {
      for (let i = 0; i < 10; i++) {
        const h = ethers.keccak256(ethers.toUtf8Bytes(`Law ${i}`));
        await constitution.addLaw(1, h, true);
      }
      const extraHash = ethers.keccak256(ethers.toUtf8Bytes("Law 11"));
      await expect(constitution.addLaw(1, extraHash, true))
        .to.be.revertedWith("Constitution: max laws reached");
    });

    it("should seal constitution and verify it", async function () {
      await constitution.addLaw(1, lawHash1, true);
      await constitution.addLaw(1, lawHash2, true);

      await expect(constitution.sealConstitution(1))
        .to.emit(constitution, "ConstitutionSealed");

      expect(await constitution.isSealed(1)).to.equal(true);
      expect(await constitution.getConstitutionHash(1)).to.not.equal(ethers.ZeroHash);
    });

    it("should reject adding laws after sealing", async function () {
      await constitution.addLaw(1, lawHash1, true);
      await constitution.sealConstitution(1);
      await expect(constitution.addLaw(1, lawHash2, false))
        .to.be.revertedWith("Constitution: already sealed");
    });

    it("should reject double sealing", async function () {
      await constitution.addLaw(1, lawHash1, true);
      await constitution.sealConstitution(1);
      await expect(constitution.sealConstitution(1))
        .to.be.revertedWith("Constitution: already sealed");
    });

    it("should verify constitution integrity", async function () {
      await constitution.addLaw(1, lawHash1, true);
      await constitution.addLaw(1, lawHash2, true);
      await constitution.sealConstitution(1);

      const result = await constitution.verifyConstitution.staticCall(1);
      expect(result).to.equal(true);
    });
  });

  describe("SkillMarketplace", function () {
    beforeEach(async function () {
      await hub.registerAgent(1); // seller
      await hub.registerAgent(2); // buyer
      await hub.deposit(1, { value: ethers.parseEther("5.0") });
      await hub.deposit(2, { value: ethers.parseEther("5.0") });
    });

    it("should list a skill", async function () {
      await expect(marketplace.listSkill(1, "navigation", "ipfs://abc", ethers.parseEther("0.5")))
        .to.emit(marketplace, "SkillListed");

      const [agentId, name, , price, , , isActive] = await marketplace.getSkill(1);
      expect(agentId).to.equal(1);
      expect(name).to.equal("navigation");
      expect(price).to.equal(ethers.parseEther("0.5"));
      expect(isActive).to.equal(true);
    });

    it("should reject zero-price skill", async function () {
      await expect(marketplace.listSkill(1, "free", "ipfs://x", 0))
        .to.be.revertedWith("Marketplace: zero price");
    });

    it("should purchase a skill with platform fee", async function () {
      await marketplace.listSkill(1, "navigation", "ipfs://abc", ethers.parseEther("1.0"));

      const buyerBalBefore = await hub.getBalance(2);
      const sellerBalBefore = await hub.getBalance(1);

      await expect(marketplace.purchaseSkill(2, 1))
        .to.emit(marketplace, "SkillPurchased");

      const buyerBalAfter = await hub.getBalance(2);
      const sellerBalAfter = await hub.getBalance(1);

      expect(buyerBalBefore - buyerBalAfter).to.equal(ethers.parseEther("1.0"));

      const platformFee = ethers.parseEther("1.0") * 250n / 10000n; // 2.5%
      const sellerReceived = ethers.parseEther("1.0") - platformFee;
      expect(sellerBalAfter - sellerBalBefore).to.equal(sellerReceived);
    });

    it("should reject self-purchase", async function () {
      await marketplace.listSkill(1, "navigation", "ipfs://abc", ethers.parseEther("0.5"));
      await expect(marketplace.purchaseSkill(1, 1))
        .to.be.revertedWith("Marketplace: cannot buy own skill");
    });

    it("should reject purchase with insufficient balance", async function () {
      await marketplace.listSkill(1, "expensive", "ipfs://x", ethers.parseEther("100.0"));
      await expect(marketplace.purchaseSkill(2, 1))
        .to.be.revertedWith("Marketplace: insufficient balance");
    });

    it("should deactivate a skill", async function () {
      await marketplace.listSkill(1, "navigation", "ipfs://abc", ethers.parseEther("0.5"));
      await marketplace.deactivateSkill(1);
      const [, , , , , , isActive] = await marketplace.getSkill(1);
      expect(isActive).to.equal(false);
    });

    it("should reject purchase of deactivated skill", async function () {
      await marketplace.listSkill(1, "navigation", "ipfs://abc", ethers.parseEther("0.5"));
      await marketplace.deactivateSkill(1);
      await expect(marketplace.purchaseSkill(2, 1))
        .to.be.revertedWith("Marketplace: skill unavailable");
    });

    it("should track accumulated platform fees", async function () {
      await marketplace.listSkill(1, "skill1", "ipfs://1", ethers.parseEther("2.0"));
      await marketplace.purchaseSkill(2, 1);

      const expectedFee = ethers.parseEther("2.0") * 250n / 10000n;
      expect(await marketplace.accumulatedPlatformFees()).to.equal(expectedFee);
    });

    it("should update platform fee", async function () {
      await marketplace.setPlatformFee(500); // 5%
      expect(await marketplace.platformFeeBps()).to.equal(500);
    });

    it("should reject excessive platform fee", async function () {
      await expect(marketplace.setPlatformFee(1500))
        .to.be.revertedWith("Marketplace: fee too high");
    });
  });

  describe("AgentReplication", function () {
    beforeEach(async function () {
      await hub.registerAgent(1);
      await hub.deposit(1, { value: ethers.parseEther("10.0") });
    });

    it("should replicate an agent with funding", async function () {
      await expect(replication.replicate(1, 100, 1000, ethers.parseEther("2.0")))
        .to.emit(replication, "AgentReplicated")
        .withArgs(1, 100, 1000, ethers.parseEther("2.0"), 1);

      expect(await hub.isAgentRegistered(100)).to.equal(true);
      expect(await hub.getBalance(100)).to.equal(ethers.parseEther("2.0"));
      expect(await hub.getBalance(1)).to.equal(ethers.parseEther("8.0"));
    });

    it("should replicate without funding", async function () {
      await replication.replicate(1, 100, 500, 0);
      expect(await hub.isAgentRegistered(100)).to.equal(true);
      expect(await hub.getBalance(100)).to.equal(0);
    });

    it("should track lineage correctly", async function () {
      await replication.replicate(1, 100, 1500, ethers.parseEther("1.0"));

      const [parentId, shareBps, exists] = await replication.getParent(100);
      expect(parentId).to.equal(1);
      expect(shareBps).to.equal(1500);
      expect(exists).to.equal(true);

      const children = await replication.getChildren(1);
      expect(children.length).to.equal(1);
      expect(children[0]).to.equal(100);
    });

    it("should track generation depth", async function () {
      await replication.replicate(1, 100, 500, ethers.parseEther("3.0"));
      expect(await replication.agentGeneration(100)).to.equal(1);

      await replication.replicate(100, 200, 500, ethers.parseEther("1.0"));
      expect(await replication.agentGeneration(200)).to.equal(2);
    });

    it("should reject revenue share exceeding 50%", async function () {
      await expect(replication.replicate(1, 100, 5001, 0))
        .to.be.revertedWith("Replication: share exceeds 50%");
    });

    it("should enforce max generation depth", async function () {
      let parentId = 1;
      for (let gen = 1; gen <= 10; gen++) {
        const childId = 1000 + gen;
        await replication.replicate(parentId, childId, 100, 0);
        parentId = childId;
      }
      await expect(replication.replicate(parentId, 9999, 100, 0))
        .to.be.revertedWith("Replication: max generation reached");
    });

    it("should distribute revenue share to parent", async function () {
      await replication.replicate(1, 100, 2000, ethers.parseEther("2.0")); // 20% share

      const parentBalBefore = await hub.getBalance(1);
      await replication.distributeRevenueShare(100, ethers.parseEther("1.0"));
      const parentBalAfter = await hub.getBalance(1);

      const expectedShare = ethers.parseEther("1.0") * 2000n / 10000n; // 0.2 ETH
      expect(parentBalAfter - parentBalBefore).to.equal(expectedShare);
    });

    it("should increment total replications counter", async function () {
      expect(await replication.totalReplications()).to.equal(0);
      await replication.replicate(1, 100, 500, 0);
      expect(await replication.totalReplications()).to.equal(1);
      await replication.replicate(1, 101, 500, 0);
      expect(await replication.totalReplications()).to.equal(2);
    });
  });

  describe("Cross-Contract Integration", function () {
    it("should handle skill purchase with parent revenue share", async function () {
      await hub.registerAgent(1); // parent
      await hub.deposit(1, { value: ethers.parseEther("10.0") });

      await replication.replicate(1, 100, 2000, ethers.parseEther("3.0")); // child with 20% share

      await hub.registerAgent(200); // buyer
      await hub.deposit(200, { value: ethers.parseEther("5.0") });

      await marketplace.listSkill(100, "child-skill", "ipfs://child", ethers.parseEther("1.0"));

      const parentBalBefore = await hub.getBalance(1);
      const childBalBefore = await hub.getBalance(100);
      const buyerBalBefore = await hub.getBalance(200);

      await marketplace.purchaseSkill(200, 1);

      const parentBalAfter = await hub.getBalance(1);
      const childBalAfter = await hub.getBalance(100);
      const buyerBalAfter = await hub.getBalance(200);

      expect(buyerBalBefore - buyerBalAfter).to.equal(ethers.parseEther("1.0"));

      const platformFee = ethers.parseEther("1.0") * 250n / 10000n;   // 2.5%
      const parentShare = ethers.parseEther("1.0") * 2000n / 10000n;   // 20%
      const sellerReceived = ethers.parseEther("1.0") - platformFee - parentShare;

      expect(parentBalAfter - parentBalBefore).to.equal(parentShare);
      expect(childBalAfter - childBalBefore).to.equal(sellerReceived);
    });

    it("should handle full agent lifecycle", async function () {
      await hub.registerAgent(1);
      await hub.deposit(1, { value: ethers.parseEther("10.0") });
      expect(await hub.computeTier(1)).to.equal(3); // NORMAL

      const lawHash = ethers.keccak256(ethers.toUtf8Bytes("Protect all user data"));
      await constitution.addLaw(1, lawHash, true);
      await constitution.sealConstitution(1);
      expect(await constitution.isSealed(1)).to.equal(true);

      await marketplace.listSkill(1, "data-analysis", "ipfs://data", ethers.parseEther("0.5"));

      await replication.replicate(1, 50, 1000, ethers.parseEther("2.0"));
      expect(await hub.isAgentRegistered(50)).to.equal(true);
      expect(await replication.agentGeneration(50)).to.equal(1);

      await hub.registerAgent(99);
      await hub.deposit(99, { value: ethers.parseEther("3.0") });
      await marketplace.purchaseSkill(99, 1);

      expect(await hub.getBalance(1)).to.be.gt(ethers.parseEther("7.0"));

      const verified = await constitution.verifyConstitution.staticCall(1);
      expect(verified).to.equal(true);
    });
  });
});
