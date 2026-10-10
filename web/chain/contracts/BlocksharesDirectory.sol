// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Immutable Terra-governed corporate creation requests and operator-attested deployments.
/// @dev Foreign-chain correctness is attested by the operator, not proved by this contract.
///      There is no owner, upgrade path, treasury, or cancellation/edit function.
contract BlocksharesDirectory is EIP712 {
    address public immutable terraGovernor;
    address public operator;
    uint256 public operatorEpoch;
    uint256 public requestCount;
    uint256 public constant MAX_NAME_BYTES = 128;
    uint256 public constant MAX_LOGO_URI_BYTES = 1024;
    address public constant OP_L2_STANDARD_BRIDGE = 0x4200000000000000000000000000000000000010;
    bytes32 public constant ACTIVATION_TYPEHASH = keccak256("Activation(uint256 requestId,bytes32 metadataHash,uint256 chainId,bytes32 deploymentHash,uint256 operatorEpoch)");

    enum Status { Approved, Active }

    struct RequestMetadata {
        string name;
        string logoURI;
        bytes32 logoHash;
        uint256 chainId;
        uint32 governanceVersion;
        bytes32 chainSpecHash;
    }

    struct Deployment {
        uint256 chainId;
        uint256 settlementChainId;
        bytes32 genesisHash;
        bytes32 configurationHash;
        address governor;
        address registry;
        address l1StandardBridge;
        address l2StandardBridge;
        address optimismPortal;
        address systemConfig;
        bytes32 governorCodeHash;
        bytes32 registryCodeHash;
        bytes32 manifestHash;
    }

    struct Request {
        RequestMetadata metadata;
        bytes32 metadataHash;
        uint64 approvedAt;
        uint64 activatedAt;
        Status status;
    }

    mapping(uint256 => Request) private _requests;
    mapping(uint256 => Deployment) private _deployments;
    mapping(uint256 => uint256) public chainRequestId;

    event CreationRequested(uint256 indexed requestId, uint256 indexed chainId, bytes32 indexed metadataHash, RequestMetadata metadata);
    event BlockshareActivated(uint256 indexed requestId, uint256 indexed chainId, bytes32 indexed deploymentHash, Deployment deployment, uint256 operatorEpoch);
    event OperatorRotated(address indexed previousOperator, address indexed newOperator, uint256 operatorEpoch);
    error OnlyTerraGovernor();
    error InvalidGovernor();
    error InvalidOperator();
    error InvalidMetadata();
    error ChainIdUnavailable();
    error UnknownRequest();
    error AlreadyActive();
    error NotActive();
    error InvalidDeployment();
    error InvalidAttestation();

    constructor(address terraGovernor_, address operator_) EIP712("Terra BlocksharesDirectory", "1") {
        if (terraGovernor_ == address(0) || terraGovernor_.code.length == 0) revert InvalidGovernor();
        if (operator_ == address(0)) revert InvalidOperator();
        terraGovernor = terraGovernor_;
        operator = operator_;
    }

    modifier onlyTerraGovernor() {
        if (msg.sender != terraGovernor) revert OnlyTerraGovernor();
        _;
    }

    /// @notice Called only as an action of an approved, executed Terra proposal.
    function requestCreation(RequestMetadata calldata metadata) external onlyTerraGovernor returns (uint256 id) {
        if (bytes(metadata.name).length == 0 || bytes(metadata.name).length > MAX_NAME_BYTES
            || bytes(metadata.logoURI).length == 0 || bytes(metadata.logoURI).length > MAX_LOGO_URI_BYTES
            || metadata.logoHash == bytes32(0) || metadata.governanceVersion == 0
            || metadata.chainSpecHash == bytes32(0)) revert InvalidMetadata();
        if (metadata.chainId == 0 || metadata.chainId == block.chainid || chainRequestId[metadata.chainId] != 0)
            revert ChainIdUnavailable();
        id = ++requestCount;
        bytes32 metadataHash = keccak256(abi.encode(metadata));
        _requests[id] = Request(metadata, metadataHash, uint64(block.timestamp), 0, Status.Approved);
        chainRequestId[metadata.chainId] = id;
        emit CreationRequested(id, metadata.chainId, metadataHash, metadata);
    }

    function getRequest(uint256 id) external view returns (Request memory) {
        _requireRequest(id);
        return _requests[id];
    }

    function getDeployment(uint256 id) external view returns (Deployment memory) {
        _requireRequest(id);
        if (_requests[id].status != Status.Active) revert NotActive();
        return _deployments[id];
    }

    function hashMetadata(RequestMetadata calldata metadata) external pure returns (bytes32) {
        return keccak256(abi.encode(metadata));
    }

    function hashDeployment(Deployment calldata deployment) public pure returns (bytes32) {
        return keccak256(abi.encode(deployment));
    }

    /// @notice Digest to sign with the configured EOA operator. Epoch invalidates prior signatures on rotation.
    function activationDigest(uint256 id, Deployment calldata deployment) public view returns (bytes32) {
        _requireRequest(id);
        return _hashTypedDataV4(keccak256(abi.encode(ACTIVATION_TYPEHASH, id,
            _requests[id].metadataHash, deployment.chainId, hashDeployment(deployment), operatorEpoch)));
    }

    /// @notice Anyone may relay the one-use operator attestation after independently verifying the child chain.
    function activate(uint256 id, Deployment calldata deployment, bytes calldata signature) external {
        _requireRequest(id);
        Request storage request = _requests[id];
        if (request.status == Status.Active) revert AlreadyActive();
        if (deployment.chainId != request.metadata.chainId || deployment.settlementChainId == 0
            || deployment.chainId == deployment.settlementChainId
            || deployment.genesisHash == bytes32(0) || deployment.configurationHash == bytes32(0)
            || deployment.governor == address(0) || deployment.registry == address(0)
            || deployment.governor == deployment.registry
            || deployment.l1StandardBridge == address(0) || deployment.l2StandardBridge != OP_L2_STANDARD_BRIDGE
            || deployment.optimismPortal == address(0) || deployment.systemConfig == address(0)
            || deployment.governorCodeHash == bytes32(0) || deployment.registryCodeHash == bytes32(0)
            || deployment.manifestHash == bytes32(0)) revert InvalidDeployment();
        (address signer, ECDSA.RecoverError recoverError,) = ECDSA.tryRecover(activationDigest(id, deployment), signature);
        if (recoverError != ECDSA.RecoverError.NoError || signer != operator) revert InvalidAttestation();
        request.status = Status.Active;
        request.activatedAt = uint64(block.timestamp);
        _deployments[id] = deployment;
        emit BlockshareActivated(id, deployment.chainId, hashDeployment(deployment), deployment, operatorEpoch);
    }

    /// @notice Operator authority changes only by executing a successful Terra policy.
    function rotateOperator(address nextOperator) external onlyTerraGovernor {
        if (nextOperator == address(0) || nextOperator == operator) revert InvalidOperator();
        address previous = operator;
        operator = nextOperator;
        ++operatorEpoch;
        emit OperatorRotated(previous, nextOperator, operatorEpoch);
    }

    function _requireRequest(uint256 id) private view {
        if (id == 0 || id > requestCount) revert UnknownRequest();
    }
}
