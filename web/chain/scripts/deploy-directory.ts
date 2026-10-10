// Attach the directory to an existing Terra ledger. Never redeploy its governor or registry.
import { artifacts } from "hardhat";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http, isAddress, keccak256 } from "viem";
import { loadDeployer } from "./deployer.mjs";
import { loadOperator } from "./operator.mjs";
import { exportAbis } from "./export.ts";

const manifestUrl = process.env.TERRA_DEPLOYMENT_MANIFEST
  ? pathToFileURL(resolve(process.env.TERRA_DEPLOYMENT_MANIFEST))
  : new URL("../../lib/deployment.json", import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
if (manifest.status !== "deployed" || !isAddress(manifest.governor))
  throw new Error("An existing, confirmed Terra deployment is required.");
const chain = defineChain({ id: manifest.chainId, name: manifest.network,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [manifest.rpcUrl] } } });
const client = createPublicClient({ chain, transport: http(process.env.TERRA_RPC_URL ?? manifest.rpcUrl) });
if (await client.getChainId() !== chain.id) throw new Error("Wrong deployment chain.");
const code = await client.getCode({ address: manifest.governor });
if (!code || code === "0x" || (manifest.governorCodeHash && keccak256(code) !== manifest.governorCodeHash))
  throw new Error("Existing governor code does not match the manifest.");
if (manifest.directory) {
  const existing = await client.getCode({ address: manifest.directory });
  if (!existing || existing === "0x") throw new Error("Recorded directory is unavailable. Preserve the existing manifest.");
  console.log(JSON.stringify({ reused: true, directory: manifest.directory }));
} else {
  const deployer = await loadDeployer();
  const operator = process.env.TERRA_OPERATOR_ADDRESS ?? (await loadOperator()).address;
  if (!isAddress(operator)) throw new Error("Invalid operator address.");
  const wallet = createWalletClient({ chain, account: deployer, transport: http(process.env.TERRA_RPC_URL ?? manifest.rpcUrl) });
  const artifact = await artifacts.readArtifact("BlocksharesDirectory");
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [manifest.governor, operator] });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("Directory deployment failed.");
  const directoryCode = await client.getCode({ address: receipt.contractAddress });
  if (!directoryCode || directoryCode === "0x") throw new Error("Directory code could not be confirmed; retain the transaction receipt.");
  const result = { ...manifest, directory: receipt.contractAddress, directoryOperator: operator,
    directoryDeploymentBlock: receipt.blockNumber.toString(), directoryTransactionHash: hash,
    directoryCodeHash: keccak256(directoryCode) };
  await exportAbis();
  await writeFile(manifestUrl, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
}
