import { artifacts, network } from "hardhat";
import { writeFile, readFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, http, keccak256 } from "viem";
import { baseSepolia, hardhat } from "viem/chains";
import { loadDeployer } from "./deployer.mjs";
import { exportAbis } from "./export.ts";

const connection = await network.create();
const networkName = connection.networkName;
const local = networkName === "localhost" || networkName === "hardhat";
const chain = local ? hardhat : baseSepolia;
const rpcUrl = local
  ? "http://127.0.0.1:8545"
  : (process.env.TERRA_RPC_URL ?? "https://sepolia.base.org");
const account = local
  ? (await connection.viem.getWalletClients())[0].account
  : await loadDeployer();
const client = createPublicClient({ chain, transport: http(rpcUrl) });
const wallet = createWalletClient({ chain, account, transport: http(rpcUrl) });
if ((await client.getChainId()) !== chain.id)
  throw new Error("Deployment RPC returned the wrong chain.");
const prior = JSON.parse(
  await readFile(new URL("../../lib/deployment.json", import.meta.url), "utf8"),
);
if (!local && prior.status === "deployed" && prior.chainId === chain.id)
  throw new Error(
    "Base Sepolia is already deployed; reuse the existing manifest.",
  );
const artifact = await artifacts.readArtifact("TerraGovernor");
if ((await client.getBalance({ address: account.address })) === 0n)
  throw new Error(
    `Fund the dedicated ${chain.name} deployer ${account.address} with free test ETH, then retry.`,
  );
const hash = await wallet.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode as `0x${string}`,
});
const receipt = await client.waitForTransactionReceipt({ hash });
if (receipt.status !== "success" || !receipt.contractAddress)
  throw new Error("Deployment did not succeed.");
const governor = receipt.contractAddress;
const registry = (await client.readContract({
  address: governor,
  abi: artifact.abi,
  functionName: "registry",
})) as `0x${string}`;
const [governorCode, registryCode] = await Promise.all([
  client.getCode({ address: governor }),
  client.getCode({ address: registry }),
]);
if (
  !governorCode ||
  governorCode === "0x" ||
  !registryCode ||
  registryCode === "0x"
)
  throw new Error(
    "Deployed code could not be confirmed. Preserve the receipt and do not redeploy blindly.",
  );
const manifest = {
  status: "deployed",
  network: chain.name,
  chainId: chain.id,
  rpcUrl,
  explorerUrl: local ? "" : "https://sepolia-explorer.base.org",
  registry,
  governor,
  deploymentBlock: receipt.blockNumber.toString(),
  transactionHash: hash,
  governorCodeHash: keccak256(governorCode),
  registryCodeHash: keccak256(registryCode),
};
await exportAbis();
await writeFile(
  new URL("../../lib/deployment.json", import.meta.url),
  JSON.stringify(manifest, null, 2) + "\n",
);
await writeFile(
  new URL(
    local ? "../deployment.local.json" : "../deployment.base-sepolia.json",
    import.meta.url,
  ),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(JSON.stringify(manifest));
