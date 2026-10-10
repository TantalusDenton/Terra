# Terra verification and launch gates

## Completed

- Hardhat contract suite: 17 passing cases covering permanent membership, exact contribution and duplicates, forwarding rollback, equal permissions, electorate snapshots, immutable ballots, duration/byte/action limits, pass/fail outcomes, deadline eligibility, payload hashes, action rollback/retry, insufficient treasury, reentrancy, and execution once only.
- Frontend validation/state suite: 8 passing cases covering literal unfiltered policy text, duration limits, UTF-8 counting, raw actions, malformed agent drafts, deadline states, and expected errors.
- TypeScript and application ESLint checks pass. Vinext production build passes. The Sites build wrapper encountered a Windows npm-shim path error; the identical project build entrypoint succeeded directly without modifying the bundled tooling.
- Local chain deployment: governor `0x5fbdb2315678afecb367f032d93f642f64180aa3`; registry `0xa16E02E87b7454126E5E10d957A927A7F5B5d2be`. These are local test addresses, not Base Sepolia deployment addresses.
- Local live-node join → propose → vote → execute journey completed, including a second treasury-spending policy and execution by a noncitizen. Exact local receipts are in ignored `chain/local-verification.json`.
- Local deployment verification confirms the receipt, exact creation payload against the tested build, code hashes, reciprocal registry/treasury wiring, and protocol constants. Server route checks return expected 200/404 statuses; `/protocol` exports the active manifest and ABIs correctly.
- Dedicated testnet deployer generated and Windows-DPAPI protected. Public address: `0x2eB8F1F761A22C4E18dD8cAfDC0108F2e9a0598e`.

## Remaining launch checks

- Browser visual/keyboard/wallet-flow checks: automated in-app browser access was blocked by its security policy. Do not bypass that restriction. Manual review or restored permitted access is needed; WebMCP supported-context validation is also unavailable until then.
- Fund the dedicated deployer with free **Base Sepolia** test ETH only.
- Deploy and confirm real testnet code, registry/treasury wiring, receipt, and addresses. Perform source verification separately if supported; report its actual status.
- Publish the complete application publicly through Sites with the verified Base Sepolia manifest, then confirm live service availability.

No mainnet, refundable stake, human/AI classification, hidden ballot storage, or mock public deployment is included. This pilot has not had an independent security audit.
