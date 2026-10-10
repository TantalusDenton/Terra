import { mkdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createPublicClient, defineChain, http, keccak256, toHex } from "viem";
import { atomicJson, atomicText, readJson } from "./storage.mjs";
import { run } from "./process.mjs";
import { projectRoot, rollupsRoot, stateRoot } from "./config.mjs";
import { validateRequestSpecification } from "./spec.mjs";
import { assertSameDockerEngine, freezeRootTemplate, frozenGenesisTimestamp } from "./genesis.mjs";
import { assertLogsCollectorReady, parseEnclaveInspection } from "./enclave-inspection.mjs";
import { assertArchivedMinimalDeneb } from "./consensus-genesis.mjs";

const binary = resolve(rollupsRoot, "bin", process.platform === "win32" ? "kurtosis.exe" : "kurtosis");
const dockerEnvironment = process.platform === "win32" ? { DOCKER_HOST: "npipe:////./pipe/dockerDesktopLinuxEngine" } : {};
const localL1Deployer = "0xbcdf20249abf0ed6d944c0288fad489e33f66b3960d9e6229c1cd214ed3bbe31"; // Public upstream local-dev fixture only.
export const networkDirectory = (chainId) => resolve(stateRoot, "networks", String(chainId));
const linuxPath = value => /^[A-Za-z]:[\\/]/.test(value) ? `/mnt/${value[0].toLowerCase()}/${value.slice(3).replaceAll("\\", "/")}` : value;
let checkedWslEngine;
export const kurtosis = async (args, options = {}) => {
  if (process.platform === "win32" && process.env.TERRA_KURTOSIS_BACKEND === "wsl") {
    checkedWslEngine ??= (async () => {
      const expected = await run("docker", ["info", "--format", "{{.ID}}"], { env: dockerEnvironment, timeout: 30000 });
      const actual = await run("wsl.exe", ["-d", process.env.TERRA_WSL_DISTRO ?? "Ubuntu", "--", "docker", "info", "--format", "{{.ID}}"], { timeout: 30000 });
      assertSameDockerEngine(expected.stdout, actual.stdout);
    })();
    await checkedWslEngine;
    const cwd = linuxPath(options.cwd ?? resolve(rollupsRoot, "vendor/optimism-package"));
    return run("wsl.exe", ["-d", process.env.TERRA_WSL_DISTRO ?? "Ubuntu", "--cd", cwd, "--", linuxPath(resolve(rollupsRoot, "bin/kurtosis")), ...args.map(linuxPath)], { ...options, env: { ...options.env, DOCKER_HOST: "" } });
  }
  return run(binary, args, { ...options, env: { ...dockerEnvironment, ...options.env } });
};

async function port(enclave, service, id) {
  const result = await kurtosis(["port", "print", "--format", "number", enclave, service, id], { timeout: 120000 });
  const number = result.stdout.trim();
  if (!/^\d+$/.test(number)) throw new Error(`Could not discover ${service}/${id} port.`);
  return Number(number);
}

export async function inspectEnclave(enclave) {
  // The list establishes absence separately; inspect failures can be backend
  // inconsistencies or outages, and must never become permission to recreate.
  const listing = await kurtosis(["enclave", "ls"], { timeout: 120000 });
  if (!listing.stdout.split(/\r?\n/).some(line => line.trim().split(/\s+/)[1] === enclave)) return null;
  const result = await kurtosis(["enclave", "inspect", "--full-uuids", enclave], { allowFailure: true, timeout: 120000 });
  return parseEnclaveInspection(enclave, result);
}

function findServices(value, result = new Set()) {
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (/^(op-el-|op-cl-|el-\d-|cl-\d-)/.test(key)) result.add(key);
      if (typeof child === "string" && /^(op-el-|op-cl-|el-\d-|cl-\d-)/.test(child)) result.add(child);
      else findServices(child, result);
    }
  }
  return [...result];
}

export async function extractNetwork(enclave, chainId, name, root = false) {
  const directory = networkDirectory(chainId);
  await mkdir(directory, { recursive: true });
  const inspection = await inspectEnclave(enclave);
  if (!inspection) throw new Error("The original network enclave is unavailable. Its ledger has not been recreated.");
  await atomicJson(resolve(directory, "enclave.json"), inspection);
  const names = findServices(inspection);
  const el = names.find((item) => item.startsWith("op-el-"));
  const cl = names.find((item) => item.startsWith("op-cl-"));
  if (!el || !cl) throw new Error("The original enclave is partially provisioned; preserve its files and resume missing services without creating another ledger.");
  const rpcUrl = `http://127.0.0.1:${await port(enclave, el, "rpc")}`;
  const opNodeUrl = `http://127.0.0.1:${await port(enclave, cl, "rpc")}`;
  const artifactDirectory = resolve(directory, "op-deployer-configs");
  try { await stat(resolve(artifactDirectory, `genesis-${chainId}.json`)); }
  catch { await kurtosis(["files", "download", enclave, "op-deployer-configs", artifactDirectory], { logPath: resolve(directory, "artifacts.log") }); }
  const state = await readJson(resolve(artifactDirectory, "state.json"));
  const rollupPath = resolve(artifactDirectory, `rollup-${chainId}.json`);
  const configuration = await readFile(rollupPath);
  const rollup = JSON.parse(configuration.toString());
  const chain = state.chains.find((entry) => BigInt(entry.id) === BigInt(chainId));
  if (!chain) throw new Error("OP Deployer state has no matching child chain.");
  let settlement;
  if (root) {
    const l1El = names.find((item) => /^el-\d-/.test(item));
    const l1Cl = names.find((item) => /^cl-\d-/.test(item));
    if (!l1El || !l1Cl) throw new Error("Shared Ethereum settlement node is missing.");
    const rpcPort = await port(enclave, l1El, "rpc");
    const wsPort = await port(enclave, l1El, "ws");
    const beaconPort = await port(enclave, l1Cl, "http");
    settlement = { chainId: 3151908, name: "Terra Local Ethereum Settlement", rpcUrl: `http://127.0.0.1:${rpcPort}`, beaconUrl: `http://127.0.0.1:${beaconPort}`, dockerRpcUrl: `http://host.docker.internal:${rpcPort}`, dockerWsUrl: `ws://host.docker.internal:${wsPort}`, dockerBeaconUrl: `http://host.docker.internal:${beaconPort}` };
    await atomicJson(resolve(stateRoot, "settlement.json"), settlement);
  } else settlement = await readJson(resolve(stateRoot, "settlement.json"));
  const client = createPublicClient({ chain: defineChain({ id: Number(chainId), name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } }), transport: http(rpcUrl) });
  if (await client.getChainId() !== Number(chainId)) throw new Error("Network returned a different chain ID.");
  const genesis = await client.getBlock({ blockNumber: 0n });
  if (genesis.hash.toLowerCase() !== rollup.genesis.l2.hash.toLowerCase()) throw new Error("Genesis does not match OP Deployer's approved rollup configuration.");
  const network = {
    kind: root ? "terra" : "blockshares", chainId: Number(chainId), network: name, rpcUrl, opNodeUrl, explorerUrl: "", enclave,
    genesisHash: genesis.hash, configurationHash: keccak256(toHex(configuration)), deploymentBlock: "0",
    settlement: { ...settlement, l1StandardBridge: chain.l1StandardBridgeProxy, optimismPortal: chain.optimismPortalProxy, systemConfig: chain.systemConfigProxy, disputeGameFactory: chain.disputeGameFactoryProxy },
    l2StandardBridge: "0x4200000000000000000000000000000000000010",
    artifactDirectory, rollupPath, createdAt: new Date().toISOString()
  };
  await atomicJson(resolve(directory, "network.json"), network);
  return network;
}

export async function provisionNetwork(request, root = false) {
  if (!root) validateRequestSpecification(request);
  const chainId = String(request.chainId);
  const directory = networkDirectory(chainId);
  const saved = await readJson(resolve(directory, "network.json"), null);
  if (saved) {
    if (saved.chainId !== Number(chainId)) throw new Error("Saved network identity mismatch.");
    return saved;
  }
  await mkdir(directory, { recursive: true });
  const enclave = root ? "terra-settlement" : `terra-blockshare-${request.id}`;
  const checkpointPath = resolve(directory, "provisioning.json");
  const prior = await readJson(checkpointPath, null);
  const inspection = await inspectEnclave(enclave);
  if (!inspection && prior) throw new Error("Original provisioning checkpoint exists but its enclave is missing. Refusing to reset the ledger.");
  const services = inspection ? findServices(inspection) : [];
  const complete = services.some(name => name.startsWith("op-el-")) && services.some(name => name.startsWith("op-cl-"));
  if (!complete) {
    if (inspection) {
      const collector = await run("docker", ["ps",
        "--filter", "label=com.kurtosistech.app-id=kurtosis",
        "--filter", "label=com.kurtosistech.container-type=kurtosis-logs-collector",
        "--filter", `name=kurtosis-logs-collector--${inspection.uuidPrefix}`,
        "--format", '{{.Label "com.kurtosistech.enclave-id"}}'],
      { env: dockerEnvironment, timeout: 30000, allowFailure: true });
      assertLogsCollectorReady(inspection.uuidPrefix, collector);
    }
    if (inspection?.artifacts.includes("op-deployer-configs")) throw new Error("Interrupted OP contract provisioning has preserved deployment artifacts. Refusing to rerun its initialization or replace genesis; recover the original OP Deployer state first.");
    if (prior && (prior.enclave !== enclave || prior.chainId !== chainId || prior.metadataHash !== request.metadataHash)) throw new Error("Existing provisioning identity differs from the approved request.");
    let args;
    let genesisTimestamp = prior?.genesisTimestamp;
    if (root) {
      // Recover an interrupted initial startup from its archived genesis, never
      // from the wall clock. A retry without an established identity fails shut.
      const original = await readJson(resolve(directory, "initial-genesis/genesis.json"), null);
      genesisTimestamp = frozenGenesisTimestamp(prior, original);
      const template = await readFile(resolve(rollupsRoot, "terra.yaml"), "utf8");
      if (original) {
        const consensus = await readJson(resolve(directory, "initial-genesis/parsed/parsedConsensusGenesis.json"));
        const raw = await readFile(resolve(directory, "initial-genesis/genesis.ssz"));
        assertArchivedMinimalDeneb(consensus, 32, raw);
        const image = "sigp/lighthouse@sha256:870934e38931d1a0f6cf47ff976e246a08a4b5509b84ff585aa2233e76744aa8";
        if (!template.includes(`cl_image: ${image}`) || !template.includes(`vc_image: ${image}`)) throw new Error("Preserved minimal genesis requires the pinned compatible beacon and validator images.");
      }
      const argsPath = resolve(directory, "network-args.yaml");
      await atomicText(argsPath, freezeRootTemplate(template, genesisTimestamp));
      args = ["run", "--enclave", enclave, "--args-file", argsPath, resolve(rollupsRoot, "vendor/optimism-package")];
    }
    else {
      const settlement = await readJson(resolve(stateRoot, "settlement.json"));
      const configuration = {
        external_l1_network_params: { network_id: String(settlement.chainId), rpc_kind: "standard", el_rpc_url: settlement.dockerRpcUrl, el_ws_url: settlement.dockerWsUrl, cl_rpc_url: settlement.dockerBeaconUrl, priv_key: localL1Deployer },
        optimism_package: { persistent: true, observability: { enabled: true }, op_contract_deployer_params: { image: "us-docker.pkg.dev/oplabs-tools-artifacts/images/op-deployer:v0.4.2", l1_artifacts_locator: "tag://op-contracts/v4.0.0", l2_artifacts_locator: "tag://op-contracts/v4.0.0" }, chains: { [`blockshare-${request.id}`]: { participants: { node0: { el: { type: "op-geth" }, cl: { type: "op-node" } } }, network_params: { network_id: chainId, seconds_per_slot: 2, fund_dev_accounts: true }, proposer_params: { proposal_interval: "15s" } } } }
      };
      const argsPath = resolve(directory, "network-args.json");
      await atomicJson(argsPath, configuration);
      args = ["run", "--enclave", enclave, "--args-file", argsPath, resolve(rollupsRoot, "vendor/optimism-package")];
    }
    await atomicJson(checkpointPath, { enclave, chainId, metadataHash: request.metadataHash, genesisTimestamp, startedAt: prior?.startedAt ?? new Date().toISOString(), status: "Provisioning" });
    // Kurtosis enclave edits resume equal completed instructions and append the
    // missing tail. Never disable instruction caching or remove the enclave.
    // Keep the dry-run trace so operators can audit a retry's proposed changes.
    const packageCwd = resolve(rollupsRoot, "vendor/optimism-package");
    // Planning is read-only. Bound a broken control-plane response stream;
    // unlike execution, abandoning this phase cannot leave broadcasts running.
    if (inspection?.services.length) await kurtosis([...args.slice(0, 1), "--dry-run", ...args.slice(1)], { cwd: packageCwd, timeout: 300000, logPath: resolve(directory, "resume-plan.log") });
    try { await kurtosis(args, { cwd: packageCwd, logPath: resolve(directory, "kurtosis.log") }); }
    finally {
      if (root && !(await readJson(resolve(directory, "initial-genesis/genesis.json"), null))) {
        await kurtosis(["files", "download", enclave, "el_cl_genesis_data", resolve(directory, "initial-genesis")], { allowFailure: true, logPath: resolve(directory, "genesis-archive.log") }).catch(() => {});
      }
    }
    await atomicJson(checkpointPath, { enclave, chainId, metadataHash: request.metadataHash, genesisTimestamp, status: "Created", completedAt: new Date().toISOString() });
  }
  return extractNetwork(enclave, chainId, request.name, root);
}
