# Blockshares contract and operator interfaces

TerraGovernor and BlocksharesGovernor share GovernanceCore. The latter creates an
independent StockholderRegistry and treasury. All existing Terra selectors and
events remain compatible. Corporate registries retain `citizens`, `citizenCount`,
and `isCitizen` for protocol compatibility, and additionally expose
`stockholders`, `stockholderCount`, and `isStockholder`. Corporate enrollment
emits `StockholdingGranted`; no human/AI classification exists.

Enrollment is permanent and costs exactly 0.001 ETH. Governance durations remain
3600–2592000 seconds, at most eight actions and 16384 bytes of total policy text.
Read/vote/enrollment work does not enumerate membership. The tests simulate large
counts above 2^53; this is an integer test, not a population-throughput claim.

## Directory protocol

`BlocksharesDirectory(terraGovernor, operator)` has no upgrade mechanism. Only the
immutable Terra governor can call `requestCreation(metadata)` or
`rotateOperator(address)`, through approved action execution. It retains the full
immutable metadata and emits it in `CreationRequested`. Names and logos cannot
be edited or removed. Child chain IDs are reserved before infrastructure starts.

Metadata tuple, in ABI order:

| Field | Type |
| --- | --- |
| name | string (1–128 UTF-8 bytes) |
| logoURI | string (1–1024 UTF-8 bytes) |
| logoHash | bytes32 |
| chainId | uint256 |
| governanceVersion | uint32 |
| chainSpecHash | bytes32 |

Both hashes must be nonzero, and governanceVersion must be positive. Directory
states are `Approved=0` and `Active=1`. Provisioning/failure/retry state is handled
by the persistent operator service, never by pretending approval created a chain.

Deployment tuple, in ABI order:

```
uint256 chainId
uint256 settlementChainId
bytes32 genesisHash
bytes32 configurationHash
address governor
address registry
address l1StandardBridge
address l2StandardBridge
address optimismPortal
address systemConfig
bytes32 governorCodeHash
bytes32 registryCodeHash
bytes32 manifestHash
```

The child and settlement IDs must differ. The L2 standard bridge must be
`0x4200000000000000000000000000000000000010`. All address/hash fields are nonzero,
and the governor and registry must be different. Foreign-chain correctness is
explicitly operator-attested, not proved by the directory.

Metadata and deployment hashes use `keccak256(abi.encode(singleStruct))`. Use
`hashMetadata` and `hashDeployment`, or ABI-encode the single tuple parameter.
Any wallet may relay `activate(requestId, deployment, signature)` once only.

EIP-712 domain:

```
name: Terra BlocksharesDirectory
version: 1
chainId: the Terra chain ID
verifyingContract: the directory address
```

Exact primary type and ordered fields:

```
Activation(uint256 requestId,bytes32 metadataHash,uint256 chainId,bytes32 deploymentHash,uint256 operatorEpoch)
```

`activationDigest` exposes the digest. Governance-authorized operator rotation
increments the epoch and invalidates every unconsumed old signature. Activation
has no external calls; invalid/replayed signatures cannot consume a request.

## Deployment and verification

The existing `deploy:local` and `deploy:base` profiles remain. `deploy:directory`
attaches to an existing manifest without replacing its governor or registry.
`TERRA_DEPLOYMENT_MANIFEST` selects a non-default manifest; the signer is the
existing Windows-protected deployer. `TERRA_OPERATOR_ADDRESS` selects the initial
operator, otherwise `operator:create`/`operator:status` manage a separate DPAPI key.

For an already provisioned OP Stack chain, run `deploy:community` with
`TERRA_COMMUNITY_SPEC` and `TERRA_DEPLOYMENT_OUT`. Required network JSON fields:
`kind` (`terra` or `blockshares`), `chainId`, `network`, `rpcUrl`, and `genesisHash`.
Include `configurationHash`, `settlement` (chainId, rpcUrl, l1StandardBridge,
optimismPortal, systemConfig), optional l2StandardBridge/disputeGameFactory,
requestId, sourceDirectory, name, logoURI/logoHash, and chainSpecHash for the
multichain manifest. Terra also takes `operator` or `TERRA_OPERATOR_ADDRESS`.

The script journals signed creation transactions before broadcasting, persists
them atomically, and resumes by transaction hash. Existing output is verified
and reused. It never overwrites the preserved `lib/deployment.json` or Hardhat
manifest. A reverted creation remains a diagnosis condition, not a blind retry.

`community-verification.mjs` verifies exact tested runtimes while masking Solidity
immutable-address locations only, reciprocal wiring, protocol constants, chain
and genesis identity, safe-block progress, settlement contract existence, and the
canonical L2 bridge. Operator activation is permitted only after these checks.

## Identical AI/human programmatic protocol

`protocol(account, {manifest, communityId?, readApiUrl?})` in `scripts/agent.mjs`
selects any community. All requests use the selected chain and governor. Methods:
`membership` (`citizenship`/`stockholding` aliases), `join`, `propose`, `vote`,
`proposal`, `execute`, and Terra-only `creationAction(metadata)`.

The CLI accepts `TERRA_AGENT_MANIFEST` and optional `TERRA_READ_API_URL`. Only
`TERRA_AGENT_PRIVATE_KEY` in the caller's local process supplies agent signatures;
no keys enter browser code or output. Every transaction verifies deployment
identity/code/wiring first, then simulates and awaits its receipt.

Execution fetches one original proposal from
`GET /v1/communities/{communityId}/proposals/{proposalId}` and verifies its text
and actions against the current onchain commitments. Without a read API, it uses
a known creation block or a logarithmically bounded timestamp search and one
narrow log query. It never scans the governor's entire event history.
