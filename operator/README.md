# Blockshares operator

The Windows operator keeps signing keys in DPAPI-protected files, outside browser
bundles. Docker/Kurtosis supplies one Ethereum settlement network and separate
OP Stack ledgers. Infrastructure bills are operator-funded; treasury spending
still requires approved governance actions. Transaction gas is paid by wallets.

## Prepare and run

Install Node >=22.13, Git, Docker Desktop, and a compatible Linux/WSL
distribution. On Windows, configure Docker Desktop integration for that
distribution and confirm the Windows and Linux clients reach the same Docker
engine before provisioning. Provisioning creates persistent blockchain state
and should only be run in an environment you control.

Windows-native operator checks:

```powershell
Set-Location operator
node --test tests/*.test.mjs
```

### Local network setup

From the project root:

```powershell
./infra/rollups/bootstrap.ps1
wsl -d Ubuntu -- bash /mnt/d/HC/Terra/infra/rollups/bootstrap.sh
node infra/rollups/prepare-packages.mjs
$env:DOCKER_HOST = 'npipe:////./pipe/dockerDesktopLinuxEngine'
./infra/rollups/bin/kurtosis.exe engine start --version 1.20.0
Set-Location operator
npm ci
$env:TERRA_KURTOSIS_BACKEND = 'wsl'
$env:TERRA_WSL_DISTRO = 'Ubuntu'
npm run root:bootstrap
# After successful bootstrap, watch approved requests:
npm start
```

Adjust `/mnt/d/HC/Terra` for another checkout. `TERRA_GIT` can select the installed
Git executable. Use the Windows CLI for control-engine creation, so its configured
Docker credential helper remains supported. The operator verifies Docker-engine
identity before provisioning.

`prepare-packages.mjs` checks exact upstream revisions, embeds the Ethereum
dependency in the root package namespace to avoid the observed local-replace
loader failure, and applies an optional frozen-genesis timestamp patch. It
records original/patched SHA256 values in `infra/rollups/runtime/package-lock.json`.
Version 3 also isolates the normalized genesis environment from stale rendered
artifact expansions and normalizes its bytes at the generator boundary. The
original timestamp and ledger identity remain unchanged. Version 4 additionally
pins Lighthouse 7.1.0 for the preserved minimal Deneb genesis. Its 32-element
blob-commitment list bound matches the archived body root; v8's 4096-element bound
does not. A preflight binds the parsed header to the retained SSZ bytes and rejects
incompatible preset/image changes before startup. The exact v7 image uses
`terra-deneb-v7` inside the original beacon volume, leaving the failed schema-31
database intact. This narrow header check is not full consensus-state validation.

The relevant pinned client definitions are
[v7.1.0 MinimalEthSpec](https://github.com/sigp/lighthouse/blob/v7.1.0/consensus/types/src/eth_spec.rs)
and [v8.2.3 MinimalEthSpec](https://github.com/sigp/lighthouse/blob/6db6ae9/consensus/types/src/core/eth_spec.rs).
Unknown edits fail without resetting files. This compatibility patch still needs
the live network smoke test; preparation alone does not demonstrate compatibility.
Complete image-digest locking follows that successful smoke test.

## Durable state and recovery

The process lock prevents concurrent bootstrap/watch operations. Finalized Terra
requests enter a persistent, single-job queue. Governance creation and activation
transactions are journaled before broadcast. Operator activation binds approved
metadata, deployment identity, governance contracts, bridge addresses, and key
epoch; operator rotation requires Terra governance.

Keep `operator/state`, `operator/secrets`, `web/.terra-secrets`, and Docker volumes.
Do not remove an enclave, change approved chain IDs, reset volumes, or discard a
signed transaction journal as an automatic retry. Missing original enclaves and
conflicting genesis identities fail shut. The legacy Hardhat manifest remains
untouched; restarting that separate ephemeral node is not OP Stack recovery.

Root retries use the original checkpoint/archive timestamp rather than the wall
clock. An interrupted OP contract stage containing `op-deployer-configs` is
guarded against blind reinitialization; durable recovery of that upstream stage
is a remaining live acceptance gap, not proved by job-state unit tests.

After a Docker restart, the supported Windows command `kurtosis.exe engine restart
--version 1.20.0` can recover the control plane. Preserve the original enclave API,
collector, registered services, and their volumes. Raw upstream traces may contain
development credentials; do not publish them.

An inspection error is not evidence that the enclave is absent: the operator
lists enclave identities separately and fails on backend inconsistencies. For the
specific observed missing validator-key temporary container, the narrowly guarded
`infra/rollups/recover-validator-entry.ps1` checks the original engine, genesis,
ledger volume, and exact stale UUID. It mounts no data and uses an inert isolated
placeholder so Kurtosis can remove its own registration. It is not a generic
reset command and deliberately refuses different environments or identities.
The optional UUID parameter accepts only the two observed stale temporary
entries. After a control-plane restart, also confirm Terra's retained logs
collector is running before resuming. In the observed `REGISTERED`-status case,
the CLI argument validator itself failed; the guarded, volume-free placeholder
was removed using `recover-validator-entry.star` and Kurtosis's documented
plan-level removal API. Do not run that plan against an unverified service.

Verified public manifests go to `services/runtime/manifest.json`; the web app's
root trust anchor is written separately to `web/lib/rollup-anchor.json`. No private
keys are exported. Operator attestation is an explicit trust assumption, not a
cryptographic proof of another blockchain's correctness.

## Live acceptance

After root bootstrap, run the ledger API and operator watcher, then `npm run
journey`. It uses public development fixtures only on loopback RPCs, journals
transactions, creates two corporations, bridges ETH, checks independent
memberships/ballots/treasuries, enacts resolutions, and withdraws ETH.

It never advances time. A real one-hour voting deadline produces a `waitingUntil`
checkpoint and exits; rerun after the deadline. Canonical proof/finalization waits
come from deployed configuration and may be longer. Receipts and checkpoints are
in `operator/state/live-journey.json`. Completion is recorded only after actual
successful receipts. Restart preservation and browser-wallet QA are separate
acceptance checks. Public hosting and mainnet deployment follow later.
