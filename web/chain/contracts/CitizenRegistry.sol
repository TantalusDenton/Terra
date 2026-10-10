// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Permanent address-based citizenship. No administrator or classification exists.
contract CitizenRegistry is ReentrancyGuard {
    uint256 public constant CONTRIBUTION = 0.001 ether;
    address payable public immutable treasury;
    uint256 public citizenCount;

    struct Citizen {
        uint256 id;
        uint64 joinedAt;
        uint64 joinedBlock;
    }

    mapping(address => Citizen) public citizens;
    event CitizenshipGranted(address indexed citizen, uint256 indexed citizenId, uint256 contribution);
    error AlreadyCitizen();
    error IncorrectContribution();
    error TreasuryTransferFailed();
    error InvalidTreasury();

    constructor(address payable treasury_) {
        if (treasury_ == address(0)) revert InvalidTreasury();
        treasury = treasury_;
    }

    function isCitizen(address account) external view returns (bool) {
        return citizens[account].id != 0;
    }

    function join() external payable virtual nonReentrant {
        if (citizens[msg.sender].id != 0) revert AlreadyCitizen();
        if (msg.value != CONTRIBUTION) revert IncorrectContribution();
        uint256 id = ++citizenCount;
        citizens[msg.sender] = Citizen(id, uint64(block.timestamp), uint64(block.number));
        emit CitizenshipGranted(msg.sender, id, msg.value);
        (bool sent,) = treasury.call{value: msg.value}("");
        if (!sent) revert TreasuryTransferFailed();
    }
}
