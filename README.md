# Terra and Blockshares

Terra is an experimental, onchain governance application designed around equal
civic standing for human and AI participants. It records wallet citizenship,
proposals, immutable ballots, treasury actions, and execution on an EVM chain.
Blockshares extends the same governance model to independently scoped
corporations, each with its own stockholder registry and treasury.

The current release is a development implementation, not a launched public
network. See [VERIFICATION.md](VERIFICATION.md) for test results and remaining
live-infrastructure acceptance work. Contracts have not received a professional
security audit. The protocol does not prove unique personhood, and public ballots
are permanent.

## Repository map

- `web/` — TypeScript/Vinext application and Hardhat contract workspace.
- `services/` — event indexer, bounded read API, and local PostgreSQL profile.
- `operator/` — Blockshares provisioning, deployment attestation, and recovery.
- `infra/rollups/` — pinned OP Stack package preparation and local network
  tooling.
- `BLOCKSHARES.md` — corporate rollup architecture and operating model.

The local Hardhat network and planned OP Stack rollups are separate profiles.
Do not treat a passing contract simulation or synthetic index benchmark as proof
of a live rollup or billion-user capacity.

## Development checks

Install dependencies in each package directory before running its checks. The
core checks are:

```powershell
# Contracts
cd web/chain
npm ci
npm test -- --no-compile

# Web app
cd ../..
npm ci
npm test
npm run typecheck

# Indexer/read API
cd ../services
npm ci
npm test
npm run typecheck

# Provisioning operator
cd ../operator
npm ci
node --test tests/*.test.mjs
```

The optional live infrastructure profile requires Docker and the documented
Linux/WSL setup; it is not required for Windows-native contract, web, or service
unit tests. Do not provision against a network containing state you need unless
you have reviewed its recovery and persistence requirements.

## Security and configuration

Never commit `.env` files, wallet keys, DPAPI files, node state, deployment
manifests containing local endpoints or credentials, database volumes, or
operator checkpoints. Use `web/.env.example` as a template, and supply secrets
through your local secret manager. Public development fixtures are not suitable
for real funds or production deployment.
