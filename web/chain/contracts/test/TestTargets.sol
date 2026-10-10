// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IExecutor { function execute(uint256 id, Action[] calldata actions) external; struct Action {address target; uint256 value; bytes data;} }

contract TestTarget {
    uint256 public value;
    bool public shouldRevert;
    function setValue(uint256 v) external payable { require(!shouldRevert, "blocked"); value = v; }
    function setRevert(bool v) external { shouldRevert = v; }
    receive() external payable {}
}

contract ReentryTarget {
    address public governor;
    uint256 public id;
    bool public wasBlocked;
    function configure(address g, uint256 proposalId) external { governor = g; id = proposalId; }
    function attack() external {
        IExecutor.Action[] memory actions = new IExecutor.Action[](1);
        actions[0] = IExecutor.Action(address(this), 0, abi.encodeCall(this.attack, ()));
        try IExecutor(governor).execute(id, actions) { revert("reentry succeeded"); }
        catch { wasBlocked = true; }
    }
}

contract RejectingTreasury { receive() external payable { revert("no"); } }

interface IRegistry { function join() external payable; }
contract ReentryTreasury {
    address public registry;
    bool public wasBlocked;
    function configure(address r) external { registry = r; }
    function enroll() external payable { IRegistry(registry).join{value: msg.value}(); }
    receive() external payable {
        try IRegistry(registry).join{value: msg.value}() { revert("reentry succeeded"); }
        catch { wasBlocked = true; }
    }
}
