# Terra ledger services

The browser reads bounded proposal pages from this service. Blockchain contracts remain authoritative for membership, ballots, execution, and balances. An incremental indexer consumes only governance events; it never enumerates a member registry. Each committed source names its canonical block, timestamp, finality and lag. Members and proposal counts are read at that block, changed proposal tallies are checked against `getProposal` at the same block, and treasury balances come from `eth_getBalance` at that block.

## Run locally

From the `services` directory, set a local `TERRA_POSTGRES_PASSWORD`, then run `npm install`, `npm run postgres:up`, wait for the `terra-blockshares-postgres` container to be healthy, and run `npm run dev`. PostgreSQL 17.6 is digest-pinned and uses a persistent named volume. The service binds `127.0.0.1:5190`, and the database binds `127.0.0.1:55432`. Production should inject `DATABASE_URL` and use independently managed databases and credentials.

Export `TERRA_POSTGRES_PASSWORD` into the shell used for both Compose and the API.
The API URL-encodes that password; `DATABASE_URL`, when supplied, takes precedence.
Database commands report a configuration error if neither setting is supplied.
An existing PostgreSQL volume retains its original password, so the supplied
value must match that database; changing an environment variable does not rotate
its credentials. Unit tests and TypeScript checks do not need database credentials
or a running PostgreSQL service.

`TERRA_MANIFEST` selects the operator's public manifest. Otherwise the service first reads `services/runtime/manifest.json` and falls back to the existing Hardhat deployment. A version 2 manifest supplies `communities` with decimal-string chain IDs and governance addresses. An active OP Stack community uses `finalized` by default; only the legacy Hardhat profile defaults to `latest`. Unsupported finality tags produce a visible indexing error instead of silently reducing finality. The operator writes approved and provisioning communities into the same public manifest. Runtime object files, cursor secrets, and database contents are retained across service restarts.

## HTTP API

- `GET /health` checks PostgreSQL connectivity.
- `GET /v1/protocol` returns the public version 2 multichain manifest.
- `GET /v1/network-spec` returns the hash-verified `operator/network-spec.json` template. Missing or unverifiable specifications return 503.
- `GET /v1/communities?limit=20&cursor=...` returns `{items,nextCursor}`. Terra appears first, then corporation request IDs descending. Subsequent pages retain their original ID ceiling.
- `GET /v1/communities/:id` returns `{community,source,counts,treasuryBalanceWei,indexerError}`. Pending communities have null source/counts/balance.
- `GET /v1/communities/:id/deployment` returns `{community,trustAssumption}` without RPC/index reads. Approved and failed provisioning metadata therefore remain visible during blockchain outages.
- `GET /v1/communities/:id/proposals?limit=20&cursor=...&state=Active` returns `{items,nextCursor,source,indexerError}`. States are `Active`, `Passed`, `Defeated`, or `Executed`; `Results` includes all proposals whose deadlines have passed. No body or action calldata is fetched for cards. The server rejects limits above 100. Cursors bind to the community, state filter, ID ceiling, and pagination position.
- `GET /v1/communities/:id/proposals/:proposalId` returns `{proposal,source,indexerError}` with the body and exact original action values. These bytes are recovered from a hash-verified object. A client must compare policy/action hashes and current state with the contracts before signing.
- `POST /v1/logos` accepts raw PNG, JPEG, or WebP bytes, maximum 2 MiB and 4096 pixels per dimension. File signatures and successful decoding determine format, rather than trusting Content-Type. Animated images are rejected. Original bytes are retained under their keccak256 hash.
- `GET /v1/objects/:hash` serves verified immutable bytes with a restrictive content-security policy and correct MIME type.

Source fields are `blockNumber`, `blockHash`, `timestamp`, `finality`, `indexingLag`, `headBlockNumber`, `updatedAt`. IDs, counts, times, chain IDs and amounts are strings, never lossy JavaScript numbers. `actionCount` and `logIndex` are small integers. `source.timestamp` is a Unix timestamp in seconds. Ballot decisions are determined at that source time, not the reader's wall clock.

Logo uploads require `x-terra-wallet`, `x-terra-signature`, and `x-terra-message`. The message header is **base64url UTF-8** because headers cannot contain newlines. Sign the exact decoded text:

```text
Terra logo upload
Chain: <Terra decimal chain ID>
Registry: <lowercase Terra registry address>
Wallet: <lowercase signer address>
Hash: <keccak256 original logo bytes>
IssuedAt: <Unix seconds>
```

The signature expires after five minutes and cannot target another wallet, chain, registry or object. Both EOAs and deployed EIP-1271 wallets are supported. Current Terra citizenship is checked directly from the blockchain. Re-uploading identical content is idempotent; no public ingestion or status-mutation endpoint exists. CORS permits the local application origins unless explicitly configured through `TERRA_CORS_ORIGINS`.

## Scaling and recovery

Polling uses a single-flight admission scan: slow reads cannot accumulate
interval invocations. Resource settings fail at startup unless valid integers
within these bounds: concurrency 1–16, queue capacity from concurrency through
1024, block range 1–5000, events per batch 1–10000, and batches per tick 1–16.
Synchronous worker failures release their queue slot so other chains can proceed.

PostgreSQL hashes proposals and canonical events into 16 community partitions, with `(chainId,governor)` identity keys and ordered proposal indexes. `StaticShardRouter` allows an explicit community-to-database placement map through `TERRA_SHARDS` and `TERRA_SHARD_ASSIGNMENTS`; adding a shard never silently relocates existing communities. A filesystem adapter implements the object-storage interface and keeps policy payloads and archived event batches outside hot read tables.

The scheduler admits at most 128 chains, runs two workers concurrently, and allows one in-flight task per chain. Admission order rotates, so repeated catch-up cannot starve later communities. Each tick processes at most four ranges of 500 blocks, adaptively reduces ranges when a provider fails or logs exceed 5000, and checks changed proposal states with RPC concurrency four. Limits are configurable. A single block exceeding the log bound produces an actionable error instead of consuming unbounded memory. No browser page triggers history scans. First proposal pages use two bounded SQL queries; continuation pages use one, with zero blockchain RPC calls. Summary balances use short cached, pinned RPC reads.

Events, derived changes and checkpoints commit atomically under a per-community database advisory lock. Duplicate events do not affect tallies. Before resuming, the indexer verifies checkpoint hashes. A reorganization rewinds orphaned proposal/event rows to a common stored anchor; if no retained anchor matches, it clears only that community's derived data and rebuilds in bounded batches. RPC outages preserve committed records. Objects remain available after rewind, but orphaned objects cannot be reached through canonical proposal rows. Source errors are visible and never presented as fresh truth.

## Verification

`npm run typecheck` and `npm test` verify numerical precision, authenticated cursors, page limits, identity isolation, immutable-object integrity, original logo validation, and bounded queues. `npm run test:postgres` uses the actual PostgreSQL container in a unique disposable test schema and tests atomic indexing, duplicate replay, insertion-stable pagination, community isolation, rollback, canonical reorganization recovery, persistent restart, RPC outage preservation, and lazy HTTP reads. Its synthetic chain fixture exercises error/reorg behavior; it does **not** substitute for live OP Stack network verification.

`npm run benchmark` creates one million synthetic proposal metadata rows in its own temporary schema, stores a simulated population above ten billion, times 100 cursor pages, checks bounded records and queries, and writes `benchmark-result.json`. Its result measures this machine's PostgreSQL read behavior, not citizen concurrency or blockchain voting throughput. The benchmark schema is removed afterward; production rows and the persistent database volume are untouched.
