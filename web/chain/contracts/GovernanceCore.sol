// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CitizenRegistry} from "./CitizenRegistry.sol";
import {StockholderRegistry} from "./StockholderRegistry.sol";

/// @notice One citizen, one immutable public ballot; zero quorum; no timelock or owner.
abstract contract GovernanceCore is ReentrancyGuard {
    uint256 public constant MIN_DURATION = 1 hours;
    uint256 public constant MAX_DURATION = 30 days;
    uint256 public constant MAX_ACTIONS = 8;
    uint256 public constant MAX_POLICY_BYTES = 16 * 1024;
    CitizenRegistry public immutable registry;
    uint256 public proposalCount;

    struct Action { address target; uint256 value; bytes data; }
    struct Proposal {
        address proposer;
        uint64 startsAt;
        uint64 endsAt;
        uint256 electorate;
        bytes32 policyHash;
        bytes32 actionsHash;
        uint256 yes;
        uint256 no;
        uint256 abstain;
        bool executed;
    }
    enum State { Active, Defeated, Passed, Executed }
    mapping(uint256 => Proposal) private _proposals;
    // 0 = no ballot; 1 = No; 2 = Yes; 3 = Abstain.
    mapping(uint256 => mapping(address => uint8)) public ballots;

    event ProposalCreated(uint256 indexed proposalId, address indexed proposer, string title, string summary, string body, uint64 endsAt, uint256 electorate, Action[] actions, bytes32 policyHash, bytes32 actionsHash);
    event VoteCast(uint256 indexed proposalId, address indexed voter, uint8 choice, uint256 weight);
    event PolicyEnacted(uint256 indexed proposalId, bytes32 indexed policyHash);
    event TreasuryFunded(address indexed sender, uint256 amount);
    error NotCitizen();
    error NotInElectorate();
    error AlreadyVoted();
    error InvalidChoice();
    error InvalidDuration();
    error InvalidPolicy();
    error TooManyActions();
    error InvalidTarget();
    error UnknownProposal();
    error VotingClosed();
    error NotPassed();
    error AlreadyExecuted();
    error PayloadMismatch();
    error InsufficientTreasury();
    error ActionFailed(uint256 index, bytes reason);

    constructor(bool corporation) {
        registry = corporation
            ? CitizenRegistry(address(new StockholderRegistry(payable(address(this)))))
            : new CitizenRegistry(payable(address(this)));
    }
    receive() external payable { emit TreasuryFunded(msg.sender, msg.value); }

    function propose(string calldata title, string calldata summary, string calldata body, uint256 duration, Action[] calldata actions) external nonReentrant returns (uint256 id) {
        if (!registry.isCitizen(msg.sender)) revert NotCitizen();
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert InvalidDuration();
        if (bytes(title).length == 0 || bytes(body).length == 0 || bytes(title).length + bytes(summary).length + bytes(body).length > MAX_POLICY_BYTES) revert InvalidPolicy();
        if (actions.length > MAX_ACTIONS) revert TooManyActions();
        for (uint256 i; i < actions.length; ++i) {
            if (actions[i].target == address(0)) revert InvalidTarget();
        }
        id = ++proposalCount;
        bytes32 policyHash = keccak256(abi.encode(title, summary, body));
        bytes32 actionsHash = keccak256(abi.encode(actions));
        uint64 end = uint64(block.timestamp + duration);
        uint256 electorate = registry.citizenCount();
        _proposals[id] = Proposal(msg.sender, uint64(block.timestamp), end, electorate, policyHash, actionsHash, 0, 0, 0, false);
        emit ProposalCreated(id, msg.sender, title, summary, body, end, electorate, actions, policyHash, actionsHash);
    }

    function getProposal(uint256 id) external view returns (Proposal memory) {
        _requireProposal(id);
        return _proposals[id];
    }

    function state(uint256 id) public view returns (State) {
        _requireProposal(id);
        Proposal storage p = _proposals[id];
        if (p.executed) return State.Executed;
        if (block.timestamp < p.endsAt) return State.Active;
        return p.yes > p.no ? State.Passed : State.Defeated;
    }

    /// @param choice 0 = No, 1 = Yes, 2 = Abstain (same encoding as standard EVM governors).
    function vote(uint256 id, uint8 choice) external nonReentrant {
        _requireProposal(id);
        Proposal storage p = _proposals[id];
        if (block.timestamp >= p.endsAt) revert VotingClosed();
        (uint256 citizenId,,) = registry.citizens(msg.sender);
        if (citizenId == 0) revert NotCitizen();
        if (citizenId > p.electorate) revert NotInElectorate();
        if (ballots[id][msg.sender] != 0) revert AlreadyVoted();
        if (choice > 2) revert InvalidChoice();
        ballots[id][msg.sender] = choice + 1;
        if (choice == 1) ++p.yes;
        else if (choice == 0) ++p.no;
        else ++p.abstain;
        emit VoteCast(id, msg.sender, choice, 1);
    }

    /// @notice Permissionless immediate execution after the deadline; failures are atomic.
    function execute(uint256 id, Action[] calldata actions) external nonReentrant {
        _requireProposal(id);
        Proposal storage p = _proposals[id];
        if (p.executed) revert AlreadyExecuted();
        if (state(id) != State.Passed) revert NotPassed();
        if (keccak256(abi.encode(actions)) != p.actionsHash) revert PayloadMismatch();
        uint256 total;
        for (uint256 i; i < actions.length; ++i) total += actions[i].value;
        if (total > address(this).balance) revert InsufficientTreasury();
        p.executed = true;
        for (uint256 i; i < actions.length; ++i) {
            (bool success, bytes memory reason) = actions[i].target.call{value: actions[i].value}(actions[i].data);
            if (!success) revert ActionFailed(i, reason);
        }
        emit PolicyEnacted(id, p.policyHash);
    }

    function _requireProposal(uint256 id) private view {
        if (id == 0 || id > proposalCount) revert UnknownProposal();
    }
}
