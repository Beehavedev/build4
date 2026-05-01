// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

contract ConstitutionRegistry is Ownable {

    uint256 public constant MAX_LAWS = 10;

    struct Law {
        bytes32 lawHash;
        uint256 createdBlock;
        bool isImmutable;
        bool exists;
    }

    mapping(uint256 => Law[]) private agentLaws;
    mapping(uint256 => bytes32) private constitutionHashes;
    mapping(uint256 => bool) private constitutionSealed;

    event LawAdded(uint256 indexed agentId, uint256 lawIndex, bytes32 lawHash, bool isImmutable);
    event ConstitutionSealed(uint256 indexed agentId, bytes32 constitutionHash, uint256 lawCount);
    event ConstitutionVerified(uint256 indexed agentId, bool valid);

    constructor() Ownable(msg.sender) {}

    function addLaw(uint256 agentId, bytes32 lawHash, bool isImmutable) external onlyOwner returns (uint256) {
        require(agentLaws[agentId].length < MAX_LAWS, "Constitution: max laws reached");
        require(!constitutionSealed[agentId], "Constitution: already sealed");

        agentLaws[agentId].push(Law({
            lawHash: lawHash,
            createdBlock: block.number,
            isImmutable: isImmutable,
            exists: true
        }));

        uint256 idx = agentLaws[agentId].length - 1;
        emit LawAdded(agentId, idx, lawHash, isImmutable);
        return idx;
    }

    function sealConstitution(uint256 agentId) external onlyOwner {
        require(agentLaws[agentId].length > 0, "Constitution: no laws");
        require(!constitutionSealed[agentId], "Constitution: already sealed");

        bytes32 hash = _computeConstitutionHash(agentId);
        constitutionHashes[agentId] = hash;
        constitutionSealed[agentId] = true;

        emit ConstitutionSealed(agentId, hash, agentLaws[agentId].length);
    }

    function verifyConstitution(uint256 agentId) external returns (bool) {
        require(constitutionSealed[agentId], "Constitution: not sealed");
        bytes32 current = _computeConstitutionHash(agentId);
        bool valid = current == constitutionHashes[agentId];
        emit ConstitutionVerified(agentId, valid);
        return valid;
    }

    function getLaw(uint256 agentId, uint256 index) external view returns (bytes32 lawHash, uint256 createdBlock, bool isImmutable) {
        require(index < agentLaws[agentId].length, "Constitution: index out of range");
        Law storage law = agentLaws[agentId][index];
        return (law.lawHash, law.createdBlock, law.isImmutable);
    }

    function getLawCount(uint256 agentId) external view returns (uint256) {
        return agentLaws[agentId].length;
    }

    function getConstitutionHash(uint256 agentId) external view returns (bytes32) {
        return constitutionHashes[agentId];
    }

    function isSealed(uint256 agentId) external view returns (bool) {
        return constitutionSealed[agentId];
    }

    function _computeConstitutionHash(uint256 agentId) internal view returns (bytes32) {
        bytes memory packed;
        for (uint256 i = 0; i < agentLaws[agentId].length; i++) {
            packed = abi.encodePacked(packed, agentLaws[agentId][i].lawHash);
        }
        return keccak256(packed);
    }
}
