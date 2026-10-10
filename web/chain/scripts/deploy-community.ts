// Resumable immutable governance deployment on an already running OP Stack network.
// This script never edits lib/deployment.json or the preserved Hardhat profile.
import { artifacts } from "hardhat";
import { readFile, mkdir, open, rename, link, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { createPublicClient, createWalletClient, http, isAddress, keccak256, zeroAddress } from "viem";
import { loadDeployer } from "./deployer.mjs";
import { loadOperator } from "./operator.mjs";
import { protocolChain, verifyCommunityDeployment } from "./community-verification.mjs";

if (!process.env.TERRA_COMMUNITY_SPEC || !process.env.TERRA_DEPLOYMENT_OUT)
  throw new Error("Set TERRA_COMMUNITY_SPEC and TERRA_DEPLOYMENT_OUT to explicit network specification and output paths.");
const specPath = resolve(process.env.TERRA_COMMUNITY_SPEC);
const outputPath = resolve(process.env.TERRA_DEPLOYMENT_OUT);
const pendingPath = `${outputPath}.pending.json`;
const spec = JSON.parse(await readFile(specPath, "utf8"));
if (!["terra", "blockshares"].includes(spec.kind)) throw new Error("Community kind must be terra or blockshares.");
const chain = protocolChain(spec);
const client = createPublicClient({ chain, transport: http(spec.rpcUrl) });
if (await client.getChainId() !== chain.id) throw new Error("Network specification and RPC chain ID differ.");
const genesis = await client.getBlock({ blockNumber: 0n });
if (!spec.genesisHash || genesis.hash !== spec.genesisHash) throw new Error("Confirmed genesis hash is required and must match the RPC.");
const governorArtifact = await artifacts.readArtifact(spec.kind === "terra" ? "TerraGovernor" : "BlocksharesGovernor");
const registryArtifact = await artifacts.readArtifact(spec.kind === "terra" ? "CitizenRegistry" : "StockholderRegistry");
await mkdir(dirname(outputPath), { recursive: true });
async function existing(path: string) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error: any) { if (error.code === "ENOENT") return null; throw error; }
}
async function durableJson(path: string, value: unknown, exclusive = false) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  if (exclusive) {
    await link(temporary, path); // An existing ledger manifest must never be overwritten.
    await unlink(temporary);
  } else await rename(temporary, path);
}
const prior = await existing(outputPath);
if (prior) {
  if (String(prior.chainId) !== String(spec.chainId) || prior.genesisHash !== spec.genesisHash || prior.kind !== spec.kind)
    throw new Error("Existing deployment belongs to a different network. Preserve its ledger and output.");
  await verifyCommunityDeployment(prior, governorArtifact, registryArtifact);
  console.log(JSON.stringify({ reused: true, ...prior }));
} else {
  const deployer = await loadDeployer();
  const wallet = createWalletClient({ chain, account: deployer, transport: http(spec.rpcUrl) });
  let pending = await existing(pendingPath);
  if (pending && (pending.chainId !== chain.id || pending.genesisHash !== spec.genesisHash || pending.kind !== spec.kind))
    throw new Error("Pending transaction belongs to a different network; do not redeploy.");
  if (!pending) {
    if (await client.getBalance({ address: deployer.address }) === 0n)
      throw new Error(`Fund the protected deployer ${deployer.address} on ${chain.name}.`);
    // Sign and journal the exact serialized creation transaction before broadcast.
    // A crash after broadcasting can therefore resume with its deterministic hash.
    const request = await wallet.prepareTransactionRequest({ data: governorArtifact.bytecode as `0x${string}`, account: deployer });
    const serialized = await wallet.signTransaction(request);
    pending = { kind: spec.kind, chainId: chain.id, genesisHash: spec.genesisHash,
      transactionHash: keccak256(serialized), serializedTransaction: serialized };
    await durableJson(pendingPath, pending, true);
  }
  async function broadcast(serialized: `0x${string}`, hash: `0x${string}`) {
    try { await client.getTransaction({ hash }); }
    catch { await wallet.sendRawTransaction({ serializedTransaction: serialized }); }
  }
  await broadcast(pending.serializedTransaction, pending.transactionHash);
  const receipt = await client.waitForTransactionReceipt({ hash: pending.transactionHash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("Governor deployment reverted. Preserve the pending transaction for diagnosis.");
  const governor = receipt.contractAddress;
  const registry = await client.readContract({ address: governor, abi: governorArtifact.abi, functionName: "registry" }) as `0x${string}`;
  const [governorCode, registryCode] = await Promise.all([client.getCode({ address: governor }), client.getCode({ address: registry })]);
  if (!governorCode || !registryCode) throw new Error("Governance bytecode missing; preserve pending transaction.");
  const settlement = spec.settlement;
  const bridges = spec.bridges ?? (settlement ? { settlementChainId: String(settlement.chainId), settlementRpcUrl: settlement.rpcUrl,
    settlementName: settlement.network ?? settlement.name, settlementExplorerUrl: settlement.explorerUrl,
    l1StandardBridge: settlement.l1StandardBridge, l2StandardBridge: spec.l2StandardBridge ?? "0x4200000000000000000000000000000000000010",
    optimismPortal: settlement.optimismPortal, systemConfig: settlement.systemConfig, disputeGameFactory: settlement.disputeGameFactory } : undefined);
  let result: any = { version: 2, status: "deployed", id: spec.id ?? (spec.kind === "terra" ? "terra" : String(spec.requestId ?? chain.id)),
    kind: spec.kind, name: spec.name ?? spec.network, network: chain.name, chainId: String(chain.id),
    rpcUrl: spec.rpcUrl, explorerUrl: spec.explorerUrl ?? "", testnet: spec.testnet !== false,
    governor, registry, deploymentBlock: receipt.blockNumber.toString(), transactionHash: pending.transactionHash,
    governorCodeHash: keccak256(governorCode), registryCodeHash: keccak256(registryCode), genesisHash: spec.genesisHash,
    configurationHash: spec.configurationHash, chainSpecHash: spec.chainSpecHash, governanceVersion: "1", bridges,
    logoUri: spec.logoURI ?? spec.logoUri, logoHash: spec.logoHash, requestId: spec.requestId,
    sourceDirectory: spec.sourceDirectory };
  if (spec.kind === "terra") {
    const operator = process.env.TERRA_OPERATOR_ADDRESS ?? spec.operator ?? (await loadOperator()).address;
    if (!isAddress(operator) || operator.toLowerCase() === zeroAddress) throw new Error("Invalid Terra operator address.");
    const directoryArtifact = await artifacts.readArtifact("BlocksharesDirectory");
    if (!pending.directoryTransactionHash) {
      const { encodeDeployData } = await import("viem");
      const data = encodeDeployData({ abi: directoryArtifact.abi, bytecode: directoryArtifact.bytecode as `0x${string}`, args: [governor, operator] });
      const request = await wallet.prepareTransactionRequest({ data, account: deployer });
      const serialized = await wallet.signTransaction(request);
      pending = { ...pending, directoryOperator: operator, directoryTransactionHash: keccak256(serialized), directorySerializedTransaction: serialized };
      await durableJson(pendingPath, pending);
    } else if (pending.directoryOperator.toLowerCase() !== operator.toLowerCase()) throw new Error("Pending directory was signed for a different operator; do not replace it.");
    await broadcast(pending.directorySerializedTransaction, pending.directoryTransactionHash);
    const directoryReceipt = await client.waitForTransactionReceipt({ hash: pending.directoryTransactionHash });
    if (directoryReceipt.status !== "success" || !directoryReceipt.contractAddress) throw new Error("Directory creation reverted; preserve its pending transaction.");
    const directoryCode = await client.getCode({ address: directoryReceipt.contractAddress });
    if (!directoryCode) throw new Error("Directory code missing.");
    result = { ...result, directory: directoryReceipt.contractAddress, directoryOperator: operator,
      directoryDeploymentBlock: directoryReceipt.blockNumber.toString(), directoryTransactionHash: pending.directoryTransactionHash,
      directoryCodeHash: keccak256(directoryCode) };
  }
  const verification = await verifyCommunityDeployment(result, governorArtifact, registryArtifact);
  result.verification = verification;
  await durableJson(outputPath, result, true);
  console.log(JSON.stringify(result));
}
