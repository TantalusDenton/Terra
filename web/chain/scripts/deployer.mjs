import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, formatEther } from "viem";
import { baseSepolia } from "viem/chains";

const directory = new URL("../../.terra-secrets/", import.meta.url);
const publicPath = new URL("deployer-public.json", directory);

function signerPaths(label) {
  if (!["deployer", "operator"].includes(label)) throw new Error("Unknown protected signer.");
  return {
    encrypted: new URL(`${label}.dpapi`, directory),
    public: new URL(`${label}-public.json`, directory),
  };
}

function powershell(source, input = "") {
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", source],
    { input, encoding: "utf8", windowsHide: true },
  );
  if (r.error || r.status !== 0)
    throw new Error("Windows protected key storage failed.");
  return r.stdout.trim();
}

export async function loadDeployer() {
  return loadProtectedSigner("deployer");
}

export async function loadProtectedSigner(label) {
  if (process.platform !== "win32")
    throw new Error(
      "This deployment key is protected for the original Windows user.",
    );
  const encrypted = await readFile(signerPaths(label).encrypted, "utf8");
  const key = powershell(
    "$null = [Reflection.Assembly]::LoadWithPartialName('System.Security'); $bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd()); $raw = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Text.Encoding]::UTF8.GetString($raw))",
    encrypted,
  );
  return privateKeyToAccount(key);
}

export async function createProtectedSigner(label = "deployer") {
  const paths = signerPaths(label);
  if (process.platform !== "win32")
    throw new Error("Windows DPAPI is required.");
  try {
    return JSON.parse(await readFile(paths.public, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  await mkdir(directory, { recursive: true });
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  const encrypted = powershell(
    "$null = [Reflection.Assembly]::LoadWithPartialName('System.Security'); $bytes = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); [Console]::Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)))",
    key,
  );
  await writeFile(paths.encrypted, encrypted, { flag: "wx" });
  const result = {
    address: account.address,
    chainId: label === "deployer" ? 84532 : null,
    network: label === "deployer" ? "Base Sepolia" : "Terra operator (domain bound by each signature)",
    protection: "Windows DPAPI (current user)",
    role: label,
    createdAt: new Date().toISOString(),
  };
  await writeFile(paths.public, JSON.stringify(result, null, 2) + "\n", {
    flag: "wx",
  });
  return result;
}

if (process.argv[1]?.endsWith("deployer.mjs")) {
  const command = process.argv[2];
  if (command === "create") console.log(JSON.stringify(await createProtectedSigner()));
  else if (command === "status") {
    const info = JSON.parse(await readFile(publicPath, "utf8"));
    const client = createPublicClient({
      chain: baseSepolia,
      transport: http(process.env.TERRA_RPC_URL ?? "https://sepolia.base.org"),
    });
    const balance = await client.getBalance({ address: info.address });
    console.log(JSON.stringify({ ...info, balanceETH: formatEther(balance) }));
  } else throw new Error("Use create or status.");
}
