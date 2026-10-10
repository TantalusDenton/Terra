import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, parseEther, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { atomicJson, readJson, serialize } from "./storage.mjs";
import { run } from "./process.mjs";
import { stateRoot, projectRoot, operatorKeyPath, manifestPath, jobsPath } from "./config.mjs";
import { createKey, loadKey } from "./keys.mjs";
import { networkDirectory, provisionNetwork } from "./networks.mjs";
import { JobStore, advanceJob } from "./jobs.mjs";
import { chainSpecHash, publicNetworkSpecification, validateRequestSpecification } from "./spec.mjs";
import { loadDeployer } from "../../web/chain/scripts/deployer.mjs";
import { protocolChain, verifyCommunityDeployment } from "../../web/chain/scripts/community-verification.mjs";

const artifact = (name) => readJson(resolve(projectRoot, `web/chain/artifacts/contracts/${name}.sol/${name}.json`));
const clientFor = (spec) => createPublicClient({ chain: protocolChain(spec), transport: http(spec.rpcUrl) });
const store = new JobStore(jobsPath);
const localDev = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");

async function fundLocalDeployer(spec) {
  const client = clientFor(spec);
  if (await client.getChainId() !== Number(spec.chainId) || (await client.getBlock({ blockNumber: 0n })).hash !== spec.genesisHash) throw new Error("Local funding identity verification failed.");
  if (String(spec.settlement.chainId) !== "3151908" || spec.testnet === false) throw new Error("Public upstream development accounts are restricted to this local settlement profile.");
  const deployer = await loadDeployer();
  if (await client.getBalance({ address: deployer.address }) < parseEther("0.1")) {
    const wallet = createWalletClient({ chain: protocolChain(spec), account: localDev, transport: http(spec.rpcUrl) });
    const hash = await wallet.sendTransaction({ to: deployer.address, value: parseEther("1") });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("Local deployment funding failed.");
  }
  return deployer;
}

export async function deployGovernance(network, job) {
  const directory = networkDirectory(network.chainId);
  const outputPath = resolve(directory, "governance.json");
  const key = await createKey(operatorKeyPath);
  const sourceRoot = job ? await readJson(resolve(stateRoot, "root.json")) : null;
  const spec = { ...network, id: job?.id ?? "terra", name: job?.name ?? "Terra", operator: key.address, chainSpecHash, requestId: job?.id, logoURI: job?.logoURI, logoHash: job?.logoHash, sourceDirectory: sourceRoot?.directory };
  const specificationPath = resolve(directory, "community-spec.json");
  await atomicJson(specificationPath, spec);
  await fundLocalDeployer(spec);
  await run(process.execPath, [resolve(projectRoot, "web/chain/node_modules/hardhat/dist/src/cli.js"), "run", "scripts/deploy-community.ts", "--no-compile"], {
    cwd: resolve(projectRoot, "web/chain"), logPath: resolve(directory, "governance-deployment.log"),
    env: { TERRA_COMMUNITY_SPEC: specificationPath, TERRA_DEPLOYMENT_OUT: outputPath, TERRA_OPERATOR_ADDRESS: key.address }
  });
  return readJson(outputPath);
}

export async function verify(spec) {
  const [governor, registry] = await Promise.all([artifact(spec.kind === "terra" ? "TerraGovernor" : "BlocksharesGovernor"), artifact(spec.kind === "terra" ? "CitizenRegistry" : "StockholderRegistry")]);
  const verification = await verifyCommunityDeployment(spec, governor, registry);
  return { verifiedAt: new Date().toISOString(), verification };
}

export async function publishManifest() {
  const root = await readJson(resolve(stateRoot, "root.json"), null);
  if (!root) return;
  // Public build-time trust anchor; no key material. Keep the independent
  // legacy Hardhat deployment manifest untouched.
  await atomicJson(resolve(projectRoot, "web/lib/rollup-anchor.json"), { version: 1, profile: "local-op-stack", terra: {
    id: "terra", kind: "terra", name: "Terra", chainId: String(root.chainId), governor: root.governor, registry: root.registry,
    genesisHash: root.genesisHash, configurationHash: root.configurationHash, directory: root.directory,
    directoryCodeHash: root.directoryCodeHash, governorCodeHash: root.governorCodeHash, registryCodeHash: root.registryCodeHash,
    bridges: root.bridges
  } });
  const state = await store.load();
  const corporations = await Promise.all(Object.values(state.jobs).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1).map(async (job) => {
    if (job.status === "Active") {
      const active = await readJson(resolve(networkDirectory(job.chainId), "activation-manifest.json"));
      return { ...active, activationTransactionHash: job.activationTransactionHash, status: "Active" };
    }
    return { id: job.id, kind: "blockshares", name: job.name, network: job.name, chainId: job.chainId, logoUri: job.logoURI, logoHash: job.logoHash, governanceVersion: String(job.governanceVersion), chainSpecHash: job.chainSpecHash, status: ["Verifying", "Activating"].includes(job.status) ? "Provisioning" : job.status, error: job.error ?? null, statusMessage: job.error ?? `Provisioning step: ${job.step}`, retryAfter: job.retryAfter, attempts: job.attempts, provisioningStep: job.step, sourceDirectory: root.directory, requestId: job.id };
  }));
  await atomicJson(manifestPath, { version: 2, protocolVersion: 1, profile: "local-op-stack", supportedNetworkSpecification: publicNetworkSpecification, settlement: root.bridges, communities: [{ ...root, status: "Active" }, ...corporations], updatedAt: new Date().toISOString() });
}

export async function bootstrapRoot() {
  const prior = await readJson(resolve(stateRoot, "root.json"), null);
  if (prior) { await verify(prior); await publishManifest(); return prior; }
  const network = await provisionNetwork({ chainId: "2151908", name: "Terra" }, true);
  const deployment = await deployGovernance(network);
  await atomicJson(resolve(stateRoot, "root.json"), { ...deployment, status: "Active" });
  await publishManifest();
  return deployment;
}

export async function discoverApproved() {
  const root = await readJson(resolve(stateRoot, "root.json"));
  const directoryArtifact = await artifact("BlocksharesDirectory");
  const client = clientFor(root);
  const state = await store.load();
  const fromBlock = BigInt(state.cursor || root.directoryDeploymentBlock || root.deploymentBlock);
  const finalized = await client.getBlock({ blockTag: "finalized" });
  const ceiling = finalized.number;
  if (ceiling < fromBlock) return;
  const toBlock = fromBlock + 499n < ceiling ? fromBlock + 499n : ceiling;
  const logs = await client.getLogs({ address: root.directory, event: directoryArtifact.abi.find((entry) => entry.type === "event" && entry.name === "CreationRequested"), fromBlock, toBlock, strict: true });
  for (const log of logs) {
    const canonical = await client.getBlock({ blockNumber: log.blockNumber });
    if (canonical.hash !== log.blockHash) throw new Error("Creation event was reorganized before durable enqueue.");
    const request = await client.readContract({ address: root.directory, abi: directoryArtifact.abi, functionName: "getRequest", args: [log.args.requestId], blockNumber: ceiling });
    if (request.metadataHash !== log.args.metadataHash) throw new Error("Creation metadata differs from authoritative finalized request.");
    await store.enqueue({ ...request.metadata, id: log.args.requestId.toString(), chainId: request.metadata.chainId.toString(), governanceVersion: Number(request.metadata.governanceVersion), metadataHash: request.metadataHash }, { blockNumber: log.blockNumber.toString(), blockHash: log.blockHash, transactionHash: log.transactionHash, finality: "finalized" });
  }
  const latest = await store.load();
  latest.cursor = (toBlock + 1n).toString();
  latest.finalizedBlock = ceiling.toString();
  latest.finalizedHash = finalized.hash;
  await store.save(latest);
  await publishManifest();
}

export async function activate(job, governance) {
  const root = await readJson(resolve(stateRoot, "root.json"));
  const directoryArtifact = await artifact("BlocksharesDirectory");
  const client = clientFor(root);
  const current = await client.readContract({ address: root.directory, abi: directoryArtifact.abi, functionName: "getRequest", args: [BigInt(job.id)] });
  if (current.metadataHash !== job.metadataHash) throw new Error("Request metadata mismatch before activation.");
  const directory = networkDirectory(job.chainId);
  if (Number(current.status) === 1) {
    const deployed = await client.readContract({ address: root.directory, abi: directoryArtifact.abi, functionName: "getDeployment", args: [BigInt(job.id)] });
    if (deployed.governor.toLowerCase() !== governance.governor.toLowerCase() || deployed.genesisHash !== governance.genesisHash) throw new Error("Existing directory activation points to another deployment.");
    const checkpoint = await readJson(resolve(directory, "activation.pending.json"));
    const receipt = await client.waitForTransactionReceipt({ hash: checkpoint.transactionHash });
    return { activationTransactionHash: receipt.transactionHash, activationBlock: receipt.blockNumber.toString() };
  }
  const key = await loadKey(operatorKeyPath);
  const [operator, epoch] = await Promise.all([client.readContract({ address: root.directory, abi: directoryArtifact.abi, functionName: "operator" }), client.readContract({ address: root.directory, abi: directoryArtifact.abi, functionName: "operatorEpoch" })]);
  if (operator.toLowerCase() !== key.address.toLowerCase()) throw new Error("Protected operator key is not the governed directory operator.");
  const community = { ...governance, status: "Active", metadataHash: job.metadataHash };
  const manifestHash = keccak256(stringToHex(serialize(community)));
  await atomicJson(resolve(directory, "activation-manifest.json"), community);
  const bridges = governance.bridges;
  const deployment = { chainId: BigInt(job.chainId), settlementChainId: BigInt(bridges.settlementChainId), genesisHash: governance.genesisHash, configurationHash: governance.configurationHash, governor: governance.governor, registry: governance.registry, l1StandardBridge: bridges.l1StandardBridge, l2StandardBridge: bridges.l2StandardBridge, optimismPortal: bridges.optimismPortal, systemConfig: bridges.systemConfig, governorCodeHash: governance.governorCodeHash, registryCodeHash: governance.registryCodeHash, manifestHash };
  const deploymentHash = await client.readContract({ address: root.directory, abi: directoryArtifact.abi, functionName: "hashDeployment", args: [deployment] });
  const signature = await key.signTypedData({ domain: { name: "Terra BlocksharesDirectory", version: "1", chainId: Number(root.chainId), verifyingContract: root.directory }, types: { Activation: [{ name: "requestId", type: "uint256" }, { name: "metadataHash", type: "bytes32" }, { name: "chainId", type: "uint256" }, { name: "deploymentHash", type: "bytes32" }, { name: "operatorEpoch", type: "uint256" }] }, primaryType: "Activation", message: { requestId: BigInt(job.id), metadataHash: job.metadataHash, chainId: BigInt(job.chainId), deploymentHash, operatorEpoch: epoch } });
  const deployer = await loadDeployer();
  const wallet = createWalletClient({ chain: protocolChain(root), account: deployer, transport: http(root.rpcUrl) });
  const checkpointPath = resolve(directory, "activation.pending.json");
  let checkpoint = await readJson(checkpointPath, null);
  if (!checkpoint) {
    const transaction = await wallet.prepareTransactionRequest({ to: root.directory, data: encodeFunctionData({ abi: directoryArtifact.abi, functionName: "activate", args: [BigInt(job.id), deployment, signature] }) });
    const serializedTransaction = await wallet.signTransaction(transaction);
    checkpoint = { requestId: job.id, metadataHash: job.metadataHash, deploymentHash, manifestHash, serializedTransaction, transactionHash: keccak256(serializedTransaction) };
    await atomicJson(checkpointPath, checkpoint);
  }
  if (checkpoint.deploymentHash !== deploymentHash) throw new Error("Pending activation commits another deployment; preserve and inspect its transaction.");
  try { await client.getTransaction({ hash: checkpoint.transactionHash }); }
  catch { await wallet.sendRawTransaction({ serializedTransaction: checkpoint.serializedTransaction }); }
  const receipt = await client.waitForTransactionReceipt({ hash: checkpoint.transactionHash });
  if (receipt.status !== "success") throw new Error("Activation transaction reverted; preserve the exact transaction.");
  return { activationTransactionHash: receipt.transactionHash, activationBlock: receipt.blockNumber.toString(), deploymentHash, manifestHash };
}

export async function processNext() {
  const job = await store.next();
  if (!job) return null;
  validateRequestSpecification(job);
  return advanceJob(store, job, {
    network: async (current) => {
      validateRequestSpecification(current);
      const network = await provisionNetwork(current);
      return { enclave: network.enclave, networkPath: resolve(networkDirectory(current.chainId), "network.json") };
    },
    governance: async (current) => {
      const network = await readJson(current.networkPath);
      await deployGovernance(network, current);
      return { governancePath: resolve(networkDirectory(current.chainId), "governance.json") };
    },
    verify: async (current) => verify(await readJson(current.governancePath)),
    activate: async (current) => activate(current, await readJson(current.governancePath)),
    publish: async () => ({})
  }).finally(publishManifest);
}
