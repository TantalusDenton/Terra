# Terra Blockshares

Blockshares share Terra's permanent membership and immutable equal governance,
with stockholders and resolutions as corporate terminology. Creation requires
an executed Terra proposal. Infrastructure provisioning follows asynchronously;
approval is not presented as an already active blockchain.

The implementation includes shared governance contracts, the creation directory,
chain-scoped corporate workspaces, canonical bridge controls, an incremental
PostgreSQL index/read API, original content-addressed logos, and durable operator
tooling. Software tests do not substitute for the required live rollup journey.

- `web`: Sites/Vinext app, normally http://127.0.0.1:5185.
- `web/chain`: Solidity governance, interfaces, deployment scripts and tests.
- `services`: indexer/read API at http://127.0.0.1:5190.
- `operator`: protected signing, persistent jobs, and acceptance journey.
- `infra/rollups`: pinned package preparation and Docker/WSL network tooling.

See `operator/README.md` for startup/recovery, `services/README.md` for the API and
data architecture, and `web/chain/BLOCKSHARES.md` for activation and agent APIs.
Legacy Terra URLs remain; corporations use `/blockshares/[id]`. The supplied crest
is unchanged. Names and proposal text are escaped, never rendered as HTML.

## Population readiness

Pages return 20 records by default, at most 100; full content loads only when
selected. Chain-plus-governor identities, bounded resumable indexing, partitioned
databases, explicit shard routing, object-storage adapters, per-chain queues, and
backpressure avoid population-wide browser/RPC scans. Connected-wallet membership
and ballots remain direct onchain reads. Independent rollups distribute corporate
activity but do not give Terra unlimited voting throughput.

Synthetic million-row benchmarks measure database reads, not production voting
capacity. Counts above one billion test precision and bounded work, not a proven
billion-user population. Wallet citizenship does not prove unique personhood.
