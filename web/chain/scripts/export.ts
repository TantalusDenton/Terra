import { artifacts } from "hardhat";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

export async function exportAbis() {
  const governor = await artifacts.readArtifact("TerraGovernor");
  const registry = await artifacts.readArtifact("CitizenRegistry");
  const blocksharesGovernor = await artifacts.readArtifact("BlocksharesGovernor");
  const stockholderRegistry = await artifacts.readArtifact("StockholderRegistry");
  const blocksharesDirectory = await artifacts.readArtifact("BlocksharesDirectory");
  await writeFile(
    new URL("../../lib/abis.json", import.meta.url),
    JSON.stringify(
      {
        governor: governor.abi,
        registry: registry.abi,
        blocksharesGovernor: blocksharesGovernor.abi,
        stockholderRegistry: stockholderRegistry.abi,
        blocksharesDirectory: blocksharesDirectory.abi,
      },
      null,
      2,
    ) + "\n",
  );
  const templates: Record<string, unknown> = {};
  for (const [name, artifact, addressField] of [
    ["TerraGovernor", governor, "registry"],
    ["BlocksharesGovernor", blocksharesGovernor, "registry"],
    ["CitizenRegistry", registry, "governor"],
    ["StockholderRegistry", stockholderRegistry, "governor"],
  ] as const) {
    assert.equal(Object.keys(artifact.immutableReferences).length, 1,
      `${name} has an unexpected immutable; give it an explicit verification binding before export.`);
    for (const refs of Object.values(artifact.immutableReferences))
      for (const ref of refs) assert.equal(ref.length, 32, "Immutable address binding must occupy one EVM word.");
    templates[name] = { deployedBytecode: artifact.deployedBytecode,
      immutableReferences: artifact.immutableReferences, addressField };
  }
  await writeFile(new URL("../../lib/verification-templates.json", import.meta.url),
    JSON.stringify({ version: 1, contracts: templates }, null, 2) + "\n");
  await writeFile(new URL("../../lib/directory-verification-template.json", import.meta.url),
    JSON.stringify({ version: 1, deployedBytecode: blocksharesDirectory.deployedBytecode,
      immutableReferences: blocksharesDirectory.immutableReferences }, null, 2) + "\n");
}
await exportAbis();
