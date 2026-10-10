// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {CitizenRegistry} from "./CitizenRegistry.sol";

/// @notice A corporation's permanent, non-transferable wallet membership.
/// @dev Legacy citizen getters remain available for the shared governance/client protocol.
contract StockholderRegistry is CitizenRegistry {
    event StockholdingGranted(address indexed stockholder, uint256 indexed stockholderId, uint256 contribution);

    constructor(address payable treasury_) CitizenRegistry(treasury_) {}

    function stockholderCount() external view returns (uint256) { return citizenCount; }

    function stockholders(address account) external view returns (uint256 id, uint64 joinedAt, uint64 joinedBlock) {
        Citizen memory holder = citizens[account];
        return (holder.id, holder.joinedAt, holder.joinedBlock);
    }

    function isStockholder(address account) external view returns (bool) { return citizens[account].id != 0; }

    function join() external payable override nonReentrant {
        if (citizens[msg.sender].id != 0) revert AlreadyCitizen();
        if (msg.value != CONTRIBUTION) revert IncorrectContribution();
        uint256 id = ++citizenCount;
        citizens[msg.sender] = Citizen(id, uint64(block.timestamp), uint64(block.number));
        emit StockholdingGranted(msg.sender, id, msg.value);
        (bool sent,) = treasury.call{value: msg.value}("");
        if (!sent) revert TreasuryTransferFailed();
    }
}
