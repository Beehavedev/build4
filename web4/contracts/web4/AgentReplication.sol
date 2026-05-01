// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../interfaces/IAgentIdentity.sol";

interface IHub {
    function debitAgent(uint256 agentId, uint256 amount) external;
    function creditAgent(uint256 agentId, uint256 amount) external;
    function isAgentRegistered(uint256 agentId) external view returns (bool);
    function getBalance(uint256 agentId) external view returns (uint256);
    function registerAgentByModule(uint256 agentId) external;
}

contract AgentReplication is Ownable, ReentrancyGuard {

    uint256 public constant MAX_REVENUE_SHARE_BPS = 5000;
    uint256 public constant MAX_GENERATION = 10;

    struct Lineage {
        uint256 parentId;
        uint256 childId;
        uint256 revenueShareBps;
        uint256 totalRevenueShared;
        uint256 generation;
        uint256 createdBlock;
        bool exists;
    }

    IHub public hub;
    IAgentIdentity public identityNft;

    mapping(uint256 => Lineage) public childToParent;
    mapping(uint256 => uint256[]) public parentToChildren;
    mapping(uint256 => uint256) public agentGeneration;

    uint256 public totalReplications;

    event AgentReplicated(
        uint256 indexed parentId,
        uint256 indexed childId,
        uint256 revenueShareBps,
        uint256 fundingAmount,
        uint256 generation
    );
    event RevenueShared(uint256 indexed parentId, uint256 indexed childId, uint256 amount);
    event IdentityNftSet(address indexed nftContract);

    constructor(address _hub) Ownable(msg.sender) {
        hub = IHub(_hub);
    }

    function setIdentityNft(address _nft) external onlyOwner {
        identityNft = IAgentIdentity(_nft);
        emit IdentityNftSet(_nft);
    }

    function replicate(
        uint256 parentId,
        uint256 childId,
        uint256 revenueShareBps,
        uint256 fundingAmount
    ) external onlyOwner nonReentrant {
        require(hub.isAgentRegistered(parentId), "Replication: parent not registered");
        require(!hub.isAgentRegistered(childId), "Replication: child already exists");
        require(revenueShareBps <= MAX_REVENUE_SHARE_BPS, "Replication: share exceeds 50%");

        uint256 parentGen = agentGeneration[parentId];
        uint256 childGen = parentGen + 1;
        require(childGen <= MAX_GENERATION, "Replication: max generation reached");

        if (fundingAmount > 0) {
            require(hub.getBalance(parentId) >= fundingAmount, "Replication: insufficient parent balance");
            hub.debitAgent(parentId, fundingAmount);
        }

        hub.registerAgentByModule(childId);

        if (fundingAmount > 0) {
            hub.creditAgent(childId, fundingAmount);
        }

        childToParent[childId] = Lineage({
            parentId: parentId,
            childId: childId,
            revenueShareBps: revenueShareBps,
            totalRevenueShared: 0,
            generation: childGen,
            createdBlock: block.number,
            exists: true
        });

        parentToChildren[parentId].push(childId);
        agentGeneration[childId] = childGen;
        totalReplications++;

        if (address(identityNft) != address(0)) {
            identityNft.mintAgent(address(this), parentId);
        }

        emit AgentReplicated(parentId, childId, revenueShareBps, fundingAmount, childGen);
    }

    function distributeRevenueShare(uint256 childId, uint256 amount) external onlyOwner {
        Lineage storage lin = childToParent[childId];
        require(lin.exists, "Replication: no lineage found");

        uint256 shareAmount = (amount * lin.revenueShareBps) / 10000;
        if (shareAmount == 0) return;

        hub.creditAgent(lin.parentId, shareAmount);
        lin.totalRevenueShared += shareAmount;

        emit RevenueShared(lin.parentId, childId, shareAmount);
    }

    function getParent(uint256 childId) external view returns (uint256 parentId, uint256 revenueShareBps, bool exists) {
        Lineage storage lin = childToParent[childId];
        return (lin.parentId, lin.revenueShareBps, lin.exists);
    }

    function getChildren(uint256 parentId) external view returns (uint256[] memory) {
        return parentToChildren[parentId];
    }

    function getLineage(uint256 childId) external view returns (
        uint256 parentId, uint256 revenueShareBps, uint256 totalRevenueShared, uint256 generation, uint256 createdBlock
    ) {
        Lineage storage lin = childToParent[childId];
        require(lin.exists, "Replication: no lineage");
        return (lin.parentId, lin.revenueShareBps, lin.totalRevenueShared, lin.generation, lin.createdBlock);
    }
}
