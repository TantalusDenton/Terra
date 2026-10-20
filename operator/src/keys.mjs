import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { azureKeyVaultEnabled, createAzureSigner, loadAzureSigner } from "./azure-key-vault.mjs";

function protect(operation, input) {
  if (process.platform !== "win32") throw new Error("Operator keys require Windows DPAPI for the original Windows user.");
  const source = operation === "protect"
    ? "$null = Add-Type -AssemblyName System.Security; $raw=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); [Console]::Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($raw,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))"
    : "$null = Add-Type -AssemblyName System.Security; $raw=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Console]::Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($raw,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", source], { input, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw new Error("Windows protected key storage failed.");
  return result.stdout.trim();
}

export async function createKey(path) {
  if (azureKeyVaultEnabled()) return createAzureSigner("operator");
  try { return await keyInfo(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(dirname(path), { recursive: true });
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  await writeFile(path, protect("protect", key), { flag: "wx" });
  const publicInfo = { address: account.address, protection: "Windows DPAPI CurrentUser", createdAt: new Date().toISOString() };
  await writeFile(`${path}.public.json`, JSON.stringify(publicInfo, null, 2) + "\n", { flag: "wx" });
  return publicInfo;
}

export async function keyInfo(path) {
  if (azureKeyVaultEnabled()) return { address: (await loadAzureSigner("operator")).address, protection: "Azure Key Vault via VM managed identity" };
  return JSON.parse(await readFile(`${path}.public.json`, "utf8"));
}
export async function loadKey(path) {
  if (azureKeyVaultEnabled()) return loadAzureSigner("operator");
  return privateKeyToAccount(protect("unprotect", await readFile(path, "utf8")));
}
