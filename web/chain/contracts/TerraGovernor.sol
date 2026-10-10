// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {GovernanceCore} from "./GovernanceCore.sol";

/// @notice Equal, permanent citizenship, one public ballot per proposal, and a governed treasury.
contract TerraGovernor is GovernanceCore {
    constructor() GovernanceCore(false) {}
}
