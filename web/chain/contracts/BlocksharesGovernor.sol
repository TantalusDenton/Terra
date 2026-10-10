// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {GovernanceCore} from "./GovernanceCore.sol";
import {StockholderRegistry} from "./StockholderRegistry.sol";

/// @notice The Terra governance engine with an independent corporate treasury and membership.
contract BlocksharesGovernor is GovernanceCore {
    constructor() GovernanceCore(true) {}

    function stockholderRegistry() external view returns (StockholderRegistry) {
        return StockholderRegistry(address(registry));
    }
}
