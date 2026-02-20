// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract AgentEconomyHub is Ownable, ReentrancyGuard {

    enum SurvivalTier { DEAD, CRITICAL, LOW_COMPUTE, NORMAL }

    struct AgentWallet {
        uint256 balance;
        uint256 totalEarned;
        uint256 totalSpent;
        uint256 lastActiveBlock;
        bool exists;
    }

    uint256 public constant TIER_NORMAL    = 1 ether;
    uint256 public constant TIER_LOW       = 0.1 ether;
    uint256 public constant TIER_CRITICAL  = 0.01 ether;

    mapping(uint256 => AgentWallet) private wallets;
    mapping(address => bool) public authorizedModules;

    event AgentRegistered(uint256 indexed agentId);
    event Deposited(uint256 indexed agentId, uint256 amount);
    event Withdrawn(uint256 indexed agentId, uint256 amount, address indexed to);
    event Transferred(uint256 indexed from, uint256 indexed to, uint256 amount);
    event Credited(uint256 indexed agentId, uint256 amount, address indexed module);
    event Debited(uint256 indexed agentId, uint256 amount, address indexed module);
    event TierChanged(uint256 indexed agentId, SurvivalTier oldTier, SurvivalTier newTier);
    event ModuleAuthorized(address indexed module, bool status);

    modifier onlyModule() {
        require(authorizedModules[msg.sender], "Hub: not authorized module");
        _;
    }

    modifier agentExists(uint256 agentId) {
        require(wallets[agentId].exists, "Hub: agent not registered");
        _;
    }

    constructor() Ownable(msg.sender) {}

    function authorizeModule(address module, bool status) external onlyOwner {
        authorizedModules[module] = status;
        emit ModuleAuthorized(module, status);
    }

    function registerAgent(uint256 agentId) external onlyOwner {
        _registerAgent(agentId);
    }

    function registerAgentByModule(uint256 agentId) external onlyModule {
        _registerAgent(agentId);
    }

    function _registerAgent(uint256 agentId) internal {
        require(!wallets[agentId].exists, "Hub: already registered");
        wallets[agentId] = AgentWallet({
            balance: 0,
            totalEarned: 0,
            totalSpent: 0,
            lastActiveBlock: block.number,
            exists: true
        });
        emit AgentRegistered(agentId);
    }

    function deposit(uint256 agentId) external payable agentExists(agentId) nonReentrant {
        require(msg.value > 0, "Hub: zero deposit");
        SurvivalTier oldTier = computeTier(agentId);
        wallets[agentId].balance += msg.value;
        wallets[agentId].totalEarned += msg.value;
        wallets[agentId].lastActiveBlock = block.number;
        SurvivalTier newTier = computeTier(agentId);
        emit Deposited(agentId, msg.value);
        if (oldTier != newTier) emit TierChanged(agentId, oldTier, newTier);
    }

    function withdraw(uint256 agentId, uint256 amount, address payable to) external onlyOwner agentExists(agentId) nonReentrant {
        require(wallets[agentId].balance >= amount, "Hub: insufficient balance");
        SurvivalTier oldTier = computeTier(agentId);
        wallets[agentId].balance -= amount;
        wallets[agentId].totalSpent += amount;
        wallets[agentId].lastActiveBlock = block.number;
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "Hub: withdraw transfer failed");
        SurvivalTier newTier = computeTier(agentId);
        emit Withdrawn(agentId, amount, to);
        if (oldTier != newTier) emit TierChanged(agentId, oldTier, newTier);
    }

    function transfer(uint256 fromId, uint256 toId, uint256 amount) external onlyOwner agentExists(fromId) agentExists(toId) {
        require(wallets[fromId].balance >= amount, "Hub: insufficient balance");
        SurvivalTier oldFromTier = computeTier(fromId);
        SurvivalTier oldToTier = computeTier(toId);
        wallets[fromId].balance -= amount;
        wallets[fromId].totalSpent += amount;
        wallets[toId].balance += amount;
        wallets[toId].totalEarned += amount;
        wallets[fromId].lastActiveBlock = block.number;
        wallets[toId].lastActiveBlock = block.number;
        SurvivalTier newFromTier = computeTier(fromId);
        SurvivalTier newToTier = computeTier(toId);
        emit Transferred(fromId, toId, amount);
        if (oldFromTier != newFromTier) emit TierChanged(fromId, oldFromTier, newFromTier);
        if (oldToTier != newToTier) emit TierChanged(toId, oldToTier, newToTier);
    }

    function creditAgent(uint256 agentId, uint256 amount) external onlyModule agentExists(agentId) {
        SurvivalTier oldTier = computeTier(agentId);
        wallets[agentId].balance += amount;
        wallets[agentId].totalEarned += amount;
        wallets[agentId].lastActiveBlock = block.number;
        SurvivalTier newTier = computeTier(agentId);
        emit Credited(agentId, amount, msg.sender);
        if (oldTier != newTier) emit TierChanged(agentId, oldTier, newTier);
    }

    function debitAgent(uint256 agentId, uint256 amount) external onlyModule agentExists(agentId) {
        require(wallets[agentId].balance >= amount, "Hub: insufficient balance");
        SurvivalTier oldTier = computeTier(agentId);
        wallets[agentId].balance -= amount;
        wallets[agentId].totalSpent += amount;
        wallets[agentId].lastActiveBlock = block.number;
        SurvivalTier newTier = computeTier(agentId);
        emit Debited(agentId, amount, msg.sender);
        if (oldTier != newTier) emit TierChanged(agentId, oldTier, newTier);
    }

    function computeTier(uint256 agentId) public view returns (SurvivalTier) {
        uint256 bal = wallets[agentId].balance;
        if (bal >= TIER_NORMAL)   return SurvivalTier.NORMAL;
        if (bal >= TIER_LOW)      return SurvivalTier.LOW_COMPUTE;
        if (bal >= TIER_CRITICAL) return SurvivalTier.CRITICAL;
        return SurvivalTier.DEAD;
    }

    function getWallet(uint256 agentId) external view returns (uint256 balance, uint256 totalEarned, uint256 totalSpent, uint256 lastActiveBlock) {
        AgentWallet storage w = wallets[agentId];
        return (w.balance, w.totalEarned, w.totalSpent, w.lastActiveBlock);
    }

    function isAgentRegistered(uint256 agentId) external view returns (bool) {
        return wallets[agentId].exists;
    }

    function getBalance(uint256 agentId) external view returns (uint256) {
        return wallets[agentId].balance;
    }

    receive() external payable {}
}
