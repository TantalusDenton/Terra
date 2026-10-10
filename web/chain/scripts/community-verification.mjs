import assert from "node:assert/strict";
import { createPublicClient, defineChain, http, isAddress, keccak256 } from "viem";

// Solidity immutables contain deployment-specific addresses. Every other runtime byte
// must match the tested artifact, including the compiler's metadata commitment.
export function runtimeMatchesArtifact(runtime, artifact) {
  if (typeof runtime !== "string" || !runtime.startsWith("0x")) return false;
  let actual = runtime.slice(2).toLowerCase();
  let expected = artifact.deployedBytecode.slice(2).toLowerCase();
  if (actual.length !== expected.length) return false;
  for (const refs of Object.values(artifact.immutableReferences ?? {}))
    for (const { start, length } of refs) {
      const from = start * 2;
      const to = (start + length) * 2;
      const blank = "0".repeat(length * 2);
      actual = actual.slice(0, from) + blank + actual.slice(to);
      expected = expected.slice(0, from) + blank + expected.slice(to);
    }
  return actual === expected;
}

export function protocolChain(manifest) {
  const id = Number(manifest.chainId);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid community chain ID.");
  if (typeof manifest.rpcUrl !== "string" || !/^https?:\/\//.test(manifest.rpcUrl)) throw new Error("Invalid community RPC URL.");
  return defineChain({ id, name: manifest.network ?? manifest.name ?? "Terra community",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [manifest.rpcUrl] } }, testnet: manifest.testnet !== false });
}

export async function verifyCommunityDeployment(manifest, governorArtifact, registryArtifact, { requireSafeProgress = true, pollMs = 1000, attempts = 30 } = {}) {
  assert(isAddress(manifest.governor) && isAddress(manifest.registry), "Governance addresses are missing.");
  const chain = protocolChain(manifest);
  const client = createPublicClient({ chain, transport: http(manifest.rpcUrl, { timeout: 15000, retryCount: 1 }) });
  assert.equal(await client.getChainId(), chain.id, "Wrong community chain.");
  const [governorCode, registryCode, genesis, linkedRegistry, linkedTreasury, contribution, min, max, maxActions, maxBytes] = await Promise.all([
    client.getCode({ address: manifest.governor }), client.getCode({ address: manifest.registry }),
    client.getBlock({ blockNumber: 0n }),
    client.readContract({ address: manifest.governor, abi: governorArtifact.abi, functionName: "registry" }),
    client.readContract({ address: manifest.registry, abi: registryArtifact.abi, functionName: "treasury" }),
    client.readContract({ address: manifest.registry, abi: registryArtifact.abi, functionName: "CONTRIBUTION" }),
    ...["MIN_DURATION", "MAX_DURATION", "MAX_ACTIONS", "MAX_POLICY_BYTES"].map(functionName => client.readContract({ address: manifest.governor, abi: governorArtifact.abi, functionName })),
  ]);
  assert(runtimeMatchesArtifact(governorCode, governorArtifact), "Governor runtime differs from the tested immutable contract.");
  assert(runtimeMatchesArtifact(registryCode, registryArtifact), "Registry runtime differs from the tested immutable contract.");
  assert.equal(linkedRegistry.toLowerCase(), manifest.registry.toLowerCase(), "Governor/registry wiring is invalid.");
  assert.equal(linkedTreasury.toLowerCase(), manifest.governor.toLowerCase(), "Registry treasury wiring is invalid.");
  assert.equal(contribution, 1000000000000000n);
  assert.deepEqual([min, max, maxActions, maxBytes], [3600n, 2592000n, 8n, 16384n]);
  if (manifest.genesisHash) assert.equal(genesis.hash, manifest.genesisHash, "Genesis identity changed.");
  const governorCodeHash = keccak256(governorCode);
  const registryCodeHash = keccak256(registryCode);
  if (manifest.governorCodeHash) assert.equal(governorCodeHash, manifest.governorCodeHash);
  if (manifest.registryCodeHash) assert.equal(registryCodeHash, manifest.registryCodeHash);
  let safeBlock;
  if (requireSafeProgress) {
    const first = await client.getBlock({ blockTag: "safe" });
    for (let i = 0; i < attempts; i++) {
      await new Promise(resolve => setTimeout(resolve, pollMs));
      const next = await client.getBlock({ blockTag: "safe" });
      if (next.number > first.number) { safeBlock = next; break; }
    }
    assert(safeBlock, "The rollup's safe block did not advance.");
  }
  const bridges = manifest.bridges;
  if (bridges) {
    assert.equal(bridges.l2StandardBridge.toLowerCase(), "0x4200000000000000000000000000000000000010");
    const settlement = createPublicClient({ chain: protocolChain({ chainId: bridges.settlementChainId, rpcUrl: bridges.settlementRpcUrl, name: "Settlement" }), transport: http(bridges.settlementRpcUrl) });
    assert.equal(String(await settlement.getChainId()), String(bridges.settlementChainId));
    for (const field of ["l1StandardBridge", "optimismPortal", "systemConfig"]) {
      assert(isAddress(bridges[field]), `Missing ${field}.`);
      const code = await settlement.getCode({ address: bridges[field] });
      assert(code && code !== "0x", `No settlement contract at ${field}.`);
    }
    const bridgeCode = await client.getCode({ address: bridges.l2StandardBridge });
    assert(bridgeCode && bridgeCode !== "0x", "Canonical L2 bridge is missing.");
  }
  return { chainId: String(chain.id), governorCodeHash, registryCodeHash, genesisHash: genesis.hash,
    testedRuntimeMatches: true, reciprocalWiringConfirmed: true, protocolConstantsConfirmed: true,
    safeBlockNumber: safeBlock?.number.toString(), safeBlockHash: safeBlock?.hash,
    checkedAt: new Date().toISOString() };
}
