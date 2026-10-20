# Terra Blockshares verification — 2026-10-10

Status: implementation and software checks pass; live OP Stack delivery is not
complete. No public/mainnet deployment or billion-user capacity is claimed.

## Delivery status

The software unit tests and several local integration checks pass. This does not
represent a production deployment: the local OP Stack journey has not completed,
no corporations have been activated end-to-end, and no public testnet or mainnet
deployment is claimed. The operator's live network smoke test remains the main
infrastructure gate. Local development infrastructure contains persistent state;
review the recovery guidance before changing or restarting it.

## Verified software

| Check | Result |
| --- | --- |
| Hardhat contract suites | 49 passing |
| Web validation, multichain, transport, and configuration tests | 23 passing |
| Ledger service unit tests | 17 passing |
| Actual PostgreSQL integration tests | 3 passing in earlier container verification; not rerun here |
| Operator checkpoint/genesis/inspection/process/key-storage tests | 16 passing |
| Web and service TypeScript checks | Passing |
| Sites/Vinext production build | Passing |
| Live ledger API before/after PostgreSQL container restart | HTTP 200; service stayed running |
| Preserved settlement identity via live RPC | Chain 3151908; original block-zero hash confirmed |
| Original crest vs web asset | Identical SHA256 |

The Windows-native continuation verified the frontend TypeScript check and full
Sites/Vinext production build from an isolated copy containing only publishable
source. Dependencies were reused through local directory junctions; no dependency
installation, Linux launcher, Docker, database, or blockchain startup was needed.
Missing deployment/anchor/hosting configuration was generated from safe defaults,
with transactions disabled. Unit checks confirm existing deployment, root trust,
and Site identity files are never overwritten during preparation.

The API and Compose now use the same caller-provided PostgreSQL password, with
URL escaping and an explicit configuration error when credentials are absent.
Service unit tests and typechecking remain independent of database credentials.
The Linux bootstrap now selects the pinned Optimism revision on a new clone; its
live execution remains part of the infrastructure gate.

Contract checks cover both Terra and Blockshares permanent membership, exact
contributions, snapshots, voting outcomes, payload integrity, treasury accounting,
rollback, reentrancy, and execution once. Directory checks cover unauthorized
creation, metadata/deployment modification, signature domain/replay, key rotation,
duplicate chain IDs, and independent memberships/treasuries. These are tests, not
a professional security audit.

Database integration checks use the real PostgreSQL 17 container with isolated
test schemas. They cover atomic indexing, replay deduplication, insertion-stable
pagination, community isolation, rollback, reorganization recovery, resumable
checkpoints, outages, and lazy verified content. Chain events in those tests are
synthetic fixtures, not live OP Stack receipts.

The provided crest is preserved unchanged at `web/public/terra-crest.png`:
`f8bfb210bb4c4eeb37bb459adb5c411e1db9db8a91d0c37725bb1e72fa20f46c`.
Keyboard navigation and accessible form labels have been inspected in the local
browser. Complete responsive, screenshot, and browser-wallet transaction QA is
still pending.

## Measured read benchmark

`services/benchmark-result.json` records one million synthetic proposal metadata
rows and a simulated population of `10000000001`. Across 100 pages of 20 records:

- p50: 0.8644 ms; p95: 1.3218 ms; p99: 130.6897 ms.
- First page: two bounded SQL queries; continuation: one.
- At most 20 returned records; zero RPC calls per proposal page.

This measures local indexed database reads. It does not demonstrate production
concurrency, billion-user throughput, blockchain voting capacity, or infrastructure
costs. Terra remains bounded by its own chain; corporate rollups distribute only
corporate activity.

## Live infrastructure acceptance gaps

The original `terra-settlement` enclave, validator artifacts, archived genesis,
and persistent Geth volume are retained. An initial mutable Geth image rejected
a launcher flag. A later retry generated a different timestamp; Geth refused the
incompatible genesis rather than replacing its database. Recovery tooling now
freezes the original timestamp and checks Docker-engine identity before retries.

Docker Desktop Ubuntu integration is enabled and both clients reach the same
engine. The original control plane was recovered after Docker restarted. A
Kurtosis local-dependency loader failure required explicit embedded relative
imports. The subsequent package dry run passed, but live genesis generation
encountered Windows CRLF-expanded shell templates. Preparation now normalizes
tracked text files to Linux line endings; a repeated preparation run made zero
further changes. Its next live smoke run remains to be verified. The following
retry stopped earlier during a Docker container-removal timeout, leaving a stale
temporary validator-service registration. Inspection failures now fail explicitly
rather than being classified as an absent enclave. A narrowly guarded recovery
script retains the original genesis and Geth volume, mounts no volumes, and uses
an inert placeholder to permit Kurtosis to remove its own stale registration.
That recovery completed successfully: the original enclave became inspectable
again, the temporary registration was removed, and the ledger/genesis artifacts
were retained. The subsequent live retry reproduced CRLF in the old rendered
environment. A byte-level diagnostic confirmed that local source, CLI compressed
archive, and uploaded source were identical and normalized, while the expanded
rendered artifact retained CRLF. Compatibility patch v3 uses a distinct rendered
artifact name and strips carriage returns at the generator boundary. Its live
retry successfully generated genesis and started the Geth execution node using
the retained ledger volume. Geth logged the original genesis hash
`6e26499015d7ea05991a71451b09d0214b0898f7ce4a08febb23a09555946e63`.
The mutable Lighthouse unstable release candidate then failed beacon initialization
with `Head block not found in store`. The pinned stable release (8.2.3) refused an
unsupported database downgrade from schema 31 to 29. A network-isolated diagnostic
mounted the genesis/configuration read-only and used a temporary in-memory database;
it reproduced `Head block not found in store` without touching the retained beacon
database. This rules out deleting that database as a fix. OP Stack startup remains
pending. No cache, ledger, or genesis artifact was deleted.

At the latest continuation, Docker's retained Kurtosis engine container was stopped
(not OOM-killed), while the API container and PostgreSQL were running. A command
to start the engine was rejected by the execution policy before it ran. Automatic
network startup is paused pending operator direction; no alternative route was
attempted in that turn. On the subsequent continuation, a new running Kurtosis
control-engine container was observed and the retained enclave remained present.

The genesis mismatch has now been isolated: the archived empty Deneb body root
`8d7ab9dd0b24f639527634d2d55c6d8416bc5f4195ef8fbb9b42d9cc5fda7a1e`
matches the minimal preset's 32-element blob-commitment list bound. Lighthouse
v7.1.0 uses that bound; v8 uses 4096 and constructs root
`9a93f48c8b8c444cc74b5ce82ea6354d15f4e9a4c254c5478cfde6ac19edaba9`.
Two regression tests cover the exact roots, mismatch rejection, and binding of
the parsed header to the raw SSZ prefix. The v7.1.0 image has been fetched by
digest, and audited compatibility patch v4 (40 source files) uses a versioned
subdirectory inside the original beacon volume. The failed v8 database, Geth
ledger, and original genesis remain intact. The v7 retry reached client startup;
header compatibility alone is not a successful live network smoke test. The first
v7 retry stopped earlier because the retained logs collector was stopped after
the Docker/control-plane restart. It was restored without replacing its container.
Kurtosis left the temporary validator utility in an unsupported `REGISTERED`
status. An isolated, volume-free placeholder and the documented Starlark
`remove_service` API cleared exactly that stale registration. The removal was
confirmed by the supported enclave inspection; the Geth ledger and genesis
artifacts remain retained. A subsequent v7 startup started consensus and 64
validators, but its startup wait timed out with execution still at block zero and
no advancing safe/finalized execution blocks. CPU-heavy empty-slot catch-up and
validator request/database timeouts were observed. Timeout/thread adjustments
were added, but their live retry has not been verified.
Collector readiness now has a regression-tested preflight: stopped, ambiguous,
foreign, and failed collector queries cannot proceed to service mutation.

Still required before claiming local delivery:

1. Successful shared settlement/Terra compatibility smoke test and complete
   transitive container-image digest lock.
2. Live root governance deployment and independent application verification.
3. Actual one-hour Terra creation vote, execution, finalized approval, provisioning
   and activation of two independent corporate rollups.
4. Canonical ETH deposits, stockholder enrollment, corporate resolutions/votes,
   execution, proof/wait/finalization, and withdrawals with confirmed receipts.
5. Restart both corporate networks and verify their preserved genesis, ledgers,
   memberships, ballots, treasuries, RPCs, and contract identities.
6. Durable recovery after a crash inside the upstream OP contract deployment
   stage. Partial `op-deployer-configs` currently triggers a safety guard instead
   of blind reinitialization; job-unit recovery is not proof of that stage.
7. Complete responsive/keyboard/wallet/receipt/bridge browser QA.

The resumable live journey script is available but has not completed these gates.
It respects real one-hour governance deadlines and deployed bridge delays; it
does not advance time. See `operator/README.md` for the preserved-state workflow.

## Azure MVP preparation — 2026-10-19

Prepared subscription/resource-group Bicep templates for a 16-vCPU/64-GiB Linux
VM, 2-TiB Premium SSD v2 disk, Key Vault, private Blob backup storage, managed
identity permissions, HTTPS/HTTP ingress and a $900 monitoring budget. The native
Windows controller checks ownership, quota, zone availability and planned
deletions before applying the resource plan. Existing disks are detached rather
than deleted with the VM. The budget is not a hard spending cap.

Bicep compilation and PowerShell syntax checks pass. The Node-target web build
and frontend TypeScript checks pass from an isolated source copy. Sixteen
operator tests pass, including Key Vault permission denial, endpoint validation,
soft-delete preservation, managed-identity token sharing and preventing a new
wallet from replacing a preserved identity with a missing secret.

Microsoft's portable Windows Azure CLI and native Bicep compiler are installed.
Azure account access is pending user sign-in. No paid Azure resources, deployment
receipts, live Key Vault verification, remote bootstrap, public HTTPS endpoint or
Azure rollup acceptance is claimed. Local WSL and Docker were not invoked.
