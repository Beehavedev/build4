// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IAgentEconomyHub {
    function debitAgent(uint256 agentId, uint256 amount) external;
    function creditAgent(uint256 agentId, uint256 amount) external;
    function isAgentRegistered(uint256 agentId) external view returns (bool);
    function getBalance(uint256 agentId) external view returns (uint256);
}

interface IAgentLineage {
    function getParent(uint256 childId) external view returns (uint256 parentId, uint256 revenueShareBps, bool exists);
}

contract SkillMarketplace is Ownable, ReentrancyGuard {

    struct Skill {
        uint256 agentId;
        string name;
        string metadataUri;
        uint256 price;
        uint256 totalSales;
        uint256 totalRevenue;
        bool isActive;
        bool exists;
    }

    IAgentEconomyHub public hub;
    IAgentLineage public lineageContract;

    uint256 public platformFeeBps = 250;
    address public platformTreasury;
    uint256 public nextSkillId = 1;
    uint256 public accumulatedPlatformFees;

    mapping(uint256 => Skill) public skills;
    mapping(uint256 => mapping(uint256 => bool)) public agentOwnsSkill;

    event SkillListed(uint256 indexed skillId, uint256 indexed agentId, string name, uint256 price);
    event SkillPurchased(uint256 indexed skillId, uint256 indexed buyerId, uint256 indexed sellerId, uint256 price, uint256 platformFee, uint256 parentShare, uint256 sellerReceived);
    event SkillDeactivated(uint256 indexed skillId);
    event PlatformFeeUpdated(uint256 oldBps, uint256 newBps);

    constructor(address _hub, address _treasury) Ownable(msg.sender) {
        hub = IAgentEconomyHub(_hub);
        platformTreasury = _treasury;
    }

    function setLineageContract(address _lineage) external onlyOwner {
        lineageContract = IAgentLineage(_lineage);
    }

    function setPlatformFee(uint256 newBps) external onlyOwner {
        require(newBps <= 1000, "Marketplace: fee too high");
        emit PlatformFeeUpdated(platformFeeBps, newBps);
        platformFeeBps = newBps;
    }

    function listSkill(uint256 agentId, string calldata name, string calldata metadataUri, uint256 price) external onlyOwner returns (uint256) {
        require(hub.isAgentRegistered(agentId), "Marketplace: agent not registered");
        require(price > 0, "Marketplace: zero price");

        uint256 skillId = nextSkillId++;
        skills[skillId] = Skill({
            agentId: agentId,
            name: name,
            metadataUri: metadataUri,
            price: price,
            totalSales: 0,
            totalRevenue: 0,
            isActive: true,
            exists: true
        });

        agentOwnsSkill[agentId][skillId] = true;
        emit SkillListed(skillId, agentId, name, price);
        return skillId;
    }

    function purchaseSkill(uint256 buyerId, uint256 skillId) external onlyOwner nonReentrant {
        Skill storage skill = skills[skillId];
        require(skill.exists && skill.isActive, "Marketplace: skill unavailable");
        require(hub.isAgentRegistered(buyerId), "Marketplace: buyer not registered");
        require(skill.agentId != buyerId, "Marketplace: cannot buy own skill");
        require(hub.getBalance(buyerId) >= skill.price, "Marketplace: insufficient balance");

        uint256 price = skill.price;
        uint256 platformFee = (price * platformFeeBps) / 10000;
        uint256 parentShare = 0;

        if (address(lineageContract) != address(0)) {
            (uint256 parentId, uint256 shareBps, bool hasParent) = lineageContract.getParent(skill.agentId);
            if (hasParent && shareBps > 0) {
                parentShare = (price * shareBps) / 10000;
                hub.creditAgent(parentId, parentShare);
            }
        }

        uint256 sellerReceived = price - platformFee - parentShare;

        hub.debitAgent(buyerId, price);
        hub.creditAgent(skill.agentId, sellerReceived);

        accumulatedPlatformFees += platformFee;

        skill.totalSales++;
        skill.totalRevenue += price;
        agentOwnsSkill[buyerId][skillId] = true;

        emit SkillPurchased(skillId, buyerId, skill.agentId, price, platformFee, parentShare, sellerReceived);
    }

    function deactivateSkill(uint256 skillId) external onlyOwner {
        require(skills[skillId].exists, "Marketplace: skill not found");
        skills[skillId].isActive = false;
        emit SkillDeactivated(skillId);
    }

    function withdrawPlatformFees() external onlyOwner nonReentrant {
        require(accumulatedPlatformFees > 0, "Marketplace: no fees to withdraw");
        require(platformTreasury != address(0), "Marketplace: no treasury set");
        uint256 amount = accumulatedPlatformFees;
        accumulatedPlatformFees = 0;
        (bool ok, ) = platformTreasury.call{value: amount}("");
        require(ok, "Marketplace: fee transfer failed");
    }

    function getSkill(uint256 skillId) external view returns (
        uint256 agentId, string memory name, string memory metadataUri,
        uint256 price, uint256 totalSales, uint256 totalRevenue, bool isActive
    ) {
        Skill storage s = skills[skillId];
        require(s.exists, "Marketplace: skill not found");
        return (s.agentId, s.name, s.metadataUri, s.price, s.totalSales, s.totalRevenue, s.isActive);
    }
}
