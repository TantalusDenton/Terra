import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { artifacts } from "hardhat";
import { createPublicClient, http, keccak256 } from "viem";
import { baseSepolia, hardhat } from "viem/chains";

const manifest = JSON.parse(
  await readFile(new URL("../../lib/deployment.json", import.meta.url), "utf8"),
);
assert.equal(
  manifest.status,
  "deployed",
  "No confirmed deployment manifest exists.",
);
assert.ok(
  [84532, 31337].includes(manifest.chainId),
  "Only Base Sepolia or the local test chain is allowed.",
);
const client = createPublicClient({
  chain: manifest.chainId === 31337 ? hardhat : baseSepolia,
  transport: http(process.env.TERRA_RPC_URL ?? manifest.rpcUrl),
});
assert.equal(await client.getChainId(), manifest.chainId);
const governor = await artifacts.readArtifact("TerraGovernor");
const registry = await artifacts.readArtifact("CitizenRegistry");
const [receipt, transaction, governorCode, registryCode] = await Promise.all([
  client.getTransactionReceipt({ hash: manifest.transactionHash }),
  client.getTransaction({ hash: manifest.transactionHash }),
  client.getCode({ address: manifest.governor }),
  client.getCode({ address: manifest.registry }),
]);
assert.equal(receipt.status, "success");
assert.equal(
  receipt.contractAddress?.toLowerCase(),
  manifest.governor.toLowerCase(),
);
assert.equal(receipt.blockNumber.toString(), manifest.deploymentBlock);
assert.equal(
  transaction.to,
  null,
  "Governor must be a direct contract creation, not a factory proxy.",
);
assert.equal(
  transaction.input.toLowerCase(),
  governor.bytecode.toLowerCase(),
  "Creation payload differs from the locally compiled/tested contract.",
);
assert.ok(governorCode && governorCode !== "0x");
assert.ok(registryCode && registryCode !== "0x");
const governorCodeHash = keccak256(governorCode);
const registryCodeHash = keccak256(registryCode);
if (manifest.governorCodeHash)
  assert.equal(governorCodeHash, manifest.governorCodeHash);
if (manifest.registryCodeHash)
  assert.equal(registryCodeHash, manifest.registryCodeHash);
const linkedRegistry = await client.readContract({
  address: manifest.governor,
  abi: governor.abi,
  functionName: "registry",
});
const linkedTreasury = await client.readContract({
  address: manifest.registry,
  abi: registry.abi,
  functionName: "treasury",
});
assert.equal(linkedRegistry.toLowerCase(), manifest.registry.toLowerCase());
assert.equal(linkedTreasury.toLowerCase(), manifest.governor.toLowerCase());
assert.equal(
  await client.readContract({
    address: manifest.registry,
    abi: registry.abi,
    functionName: "CONTRIBUTION",
  }),
  1000000000000000n,
);
for (const [name, expected] of [
  ["MIN_DURATION", 3600n],
  ["MAX_DURATION", 2592000n],
  ["MAX_ACTIONS", 8n],
  ["MAX_POLICY_BYTES", 16384n],
] as const)
  assert.equal(
    await client.readContract({
      address: manifest.governor,
      abi: governor.abi,
      functionName: name,
    }),
    expected,
  );
const report = {
  chainId: manifest.chainId,
  network: manifest.network,
  governor: manifest.governor,
  registry: manifest.registry,
  transactionHash: manifest.transactionHash,
  deploymentBlock: manifest.deploymentBlock,
  governorCodeHash,
  registryCodeHash,
  creationPayloadMatchesTestedBuild: true,
  reciprocalWiringConfirmed: true,
  receiptConfirmed: true,
  explorerSourceVerification: "not performed by this check",
  checkedAt: new Date().toISOString(),
};
await writeFile(
  new URL(
    manifest.chainId === 31337
      ? "../verification.local.json"
      : "../verification.base-sepolia.json",
    import.meta.url,
  ),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
