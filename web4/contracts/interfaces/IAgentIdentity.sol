// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgentIdentity {
    function ownerOf(uint256 agentId) external view returns (address);
    function isRegistered(uint256 agentId) external view returns (bool);
    function getAgentAddress(uint256 agentId) external view returns (address);
    function mintAgent(address to, uint256 parentId) external returns (uint256);
}
